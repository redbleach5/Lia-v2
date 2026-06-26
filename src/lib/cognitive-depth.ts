// Cognitive Depth — adaptive pipeline selection.
//
// Combines:
//   - Capability tier (what hardware/model is available)
//   - Task complexity (how hard is this question)
//   - User override (auto / fast / standard / deep / agent)
//
// Returns the execution plan: how many LLM calls, which tools, what limits.

import type { CapabilityProfile, CognitiveParams, Tier } from '@/lib/capability-profile';
import { getTierParams } from '@/lib/capability-profile';
import type { TaskComplexity } from '@/lib/task-complexity';

// ============================================================================
// Types
// ============================================================================
export type CognitiveMode = 'auto' | 'fast' | 'standard' | 'deep' | 'agent';

export type ExecutionPlan = {
  mode: CognitiveMode;
  tier: Tier;
  complexity: TaskComplexity;
  // Concrete parameters for this message
  calls: number;
  deliberate: boolean;
  selfCheck: boolean;
  maxTokens: number;
  toolsEnabled: boolean;
  autoWebSearch: boolean;
  // Whether smart notification should be checked
  shouldCheckNotification: boolean;
};

// ============================================================================
// Mode overrides — when user explicitly picks a mode
// ============================================================================
const MODE_OVERRIDES: Record<Exclude<CognitiveMode, 'auto'>, Partial<ExecutionPlan>> = {
  fast: {
    calls: 1,
    deliberate: false,
    selfCheck: false,
    maxTokens: 1024,
    toolsEnabled: false,
    autoWebSearch: false,
    shouldCheckNotification: false,
  },
  standard: {
    calls: 1,
    deliberate: false,
    selfCheck: false,
    maxTokens: 2048,
    toolsEnabled: true,
    autoWebSearch: true,
    shouldCheckNotification: true,
  },
  deep: {
    calls: 3,
    deliberate: true,
    selfCheck: true,
    maxTokens: 8192,
    toolsEnabled: true,
    autoWebSearch: true,
    shouldCheckNotification: false,
  },
  agent: {
    calls: 5, // placeholder — agent uses its own loop
    deliberate: true,
    selfCheck: true,
    maxTokens: 4096,
    toolsEnabled: true,
    autoWebSearch: true,
    shouldCheckNotification: false,
  },
};

// ============================================================================
// Auto mode — adaptive based on tier × complexity
// ============================================================================
function planAuto(tier: Tier, complexity: TaskComplexity, tierParams: CognitiveParams): ExecutionPlan {
  // Base from tier
  const base = {
    mode: 'auto' as const,
    tier,
    complexity,
    toolsEnabled: tierParams.toolsEnabled,
    autoWebSearch: tierParams.autoWebSearch,
    shouldCheckNotification: tierParams.smartNotifications,
  };

  // ── micro tier (≤4B or CPU) ──
  if (tier === 'micro') {
    switch (complexity) {
      case 'trivial':
        return { ...base, calls: 1, deliberate: false, selfCheck: false, maxTokens: 512 };
      case 'simple':
        return { ...base, calls: 1, deliberate: false, selfCheck: false, maxTokens: 1024, autoWebSearch: true };
      case 'moderate':
        // 4B model can't reason well — give it web_search to compensate
        return { ...base, calls: 1, deliberate: false, selfCheck: false, maxTokens: 2048, autoWebSearch: true };
      case 'complex':
        // Even complex tasks: 1 call but with web_search. 4B can't do multi-step.
        // Smart notification tells user this is hardware-limited.
        return { ...base, calls: 1, deliberate: false, selfCheck: false, maxTokens: 2048, autoWebSearch: true, shouldCheckNotification: true };
      case 'research':
        // Research = web_search + summarize. 4B can summarize.
        return { ...base, calls: 1, deliberate: false, selfCheck: false, maxTokens: 2048, autoWebSearch: true };
    }
  }

  // ── standard tier (5-13B) ──
  if (tier === 'standard') {
    switch (complexity) {
      case 'trivial':
        return { ...base, calls: 1, deliberate: false, selfCheck: false, maxTokens: 512 };
      case 'simple':
        return { ...base, calls: 1, deliberate: false, selfCheck: false, maxTokens: 2048 };
      case 'moderate':
        // 1 call + light self-check
        return { ...base, calls: 2, deliberate: false, selfCheck: true, maxTokens: 4096 };
      case 'complex':
        // 2 calls: deliberate + respond + self-check
        return { ...base, calls: 3, deliberate: true, selfCheck: true, maxTokens: 4096 };
      case 'research':
        return { ...base, calls: 2, deliberate: false, selfCheck: true, maxTokens: 4096, autoWebSearch: true };
    }
  }

  // ── plus tier (14-32B) ──
  if (tier === 'plus') {
    switch (complexity) {
      case 'trivial':
        return { ...base, calls: 1, deliberate: false, selfCheck: false, maxTokens: 1024 };
      case 'simple':
        return { ...base, calls: 1, deliberate: false, selfCheck: false, maxTokens: 2048 };
      case 'moderate':
        return { ...base, calls: 2, deliberate: true, selfCheck: true, maxTokens: 4096 };
      case 'complex':
        // Full pipeline: deliberate → respond → self-check → revise
        return { ...base, calls: 4, deliberate: true, selfCheck: true, maxTokens: 8192 };
      case 'research':
        return { ...base, calls: 3, deliberate: true, selfCheck: true, maxTokens: 8192, autoWebSearch: true };
    }
  }

  // ── max tier (33B+) ──
  switch (complexity) {
    case 'trivial':
      // Even on max tier, don't waste 70B on "hi"
      return { ...base, calls: 1, deliberate: false, selfCheck: false, maxTokens: 1024 };
    case 'simple':
      return { ...base, calls: 1, deliberate: false, selfCheck: false, maxTokens: 2048 };
    case 'moderate':
      return { ...base, calls: 2, deliberate: true, selfCheck: true, maxTokens: 8192 };
    case 'complex':
      // Maximum depth: deliberate → respond → self-check → revise
      return { ...base, calls: 4, deliberate: true, selfCheck: true, maxTokens: 16384 };
    case 'research':
      return { ...base, calls: 4, deliberate: true, selfCheck: true, maxTokens: 16384, autoWebSearch: true };
  }
}

// ============================================================================
// Main entry point
// ============================================================================
export function planExecution(params: {
  mode: CognitiveMode;
  tier: Tier;
  complexity: TaskComplexity;
  profile: CapabilityProfile | null;
}): ExecutionPlan {
  const { mode, tier, complexity, profile } = params;
  const tierParams = getTierParams(tier);

  // Agent mode — special case, handled by agent runner
  if (mode === 'agent') {
    return {
      mode: 'agent',
      tier,
      complexity,
      calls: 0, // agent manages its own calls
      deliberate: true,
      selfCheck: true,
      maxTokens: 4096,
      toolsEnabled: true,
      autoWebSearch: true,
      shouldCheckNotification: false,
    };
  }

  // Explicit overrides
  if (mode !== 'auto') {
    const override = MODE_OVERRIDES[mode];
    return {
      mode,
      tier,
      complexity,
      calls: override.calls ?? tierParams.calls,
      deliberate: override.deliberate ?? tierParams.deliberate,
      selfCheck: override.selfCheck ?? tierParams.selfCheck,
      maxTokens: override.maxTokens ?? tierParams.maxTokens,
      toolsEnabled: override.toolsEnabled ?? tierParams.toolsEnabled,
      autoWebSearch: override.autoWebSearch ?? tierParams.autoWebSearch,
      shouldCheckNotification: override.shouldCheckNotification ?? tierParams.smartNotifications,
    };
  }

  // Auto — adaptive
  return planAuto(tier, complexity, tierParams);
}

// ============================================================================
// Helper: should we run deliberate step?
// ============================================================================
export function shouldDeliberate(plan: ExecutionPlan): boolean {
  return plan.deliberate && plan.calls >= 2;
}

// ============================================================================
// Helper: should we run self-check?
// ============================================================================
export function shouldSelfCheck(plan: ExecutionPlan): boolean {
  return plan.selfCheck && plan.calls >= 2;
}
