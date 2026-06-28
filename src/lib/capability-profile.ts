// Capability Profile — detect available compute + model size, classify into tier.
//
// Tier system (4 levels):
//   micro    — ≤4B parameters, or CPU-only, or <8GB VRAM
//              Strategy: 1 LLM call + heavy tool use (web_search compensates
//              for model weakness). Self-check OFF.
//
//   standard — 5-13B parameters, 8-24GB VRAM
//              Strategy: 1-2 LLM calls, tools optional, self-check on complex tasks.
//
//   plus     — 14-32B parameters, 24-80GB VRAM (single GPU 4090/5090 territory)
//              Strategy: 2-4 LLM calls with deliberate + self-check on complex tasks.
//              Agent: maxSteps up to 50, maxDuration up to 1 hour.
//
//   max      — 33B+ parameters, multi-GPU or 80GB+ VRAM
//              Strategy: full deliberate loop, no hard limits.
//              Agent: maxSteps up to 500, maxDuration up to 24 hours.
//
// Profile is cached in DB (Setting table) with 1-hour TTL.
// Refreshed when: user changes model, or explicitly via /api/capability/refresh.

import { db } from '@/lib/db';
import { checkOllamaHealth } from '@/lib/ollama';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { logger } from '@/lib/logger';

// ============================================================================
// Types
// ============================================================================
export type Tier = 'micro' | 'standard' | 'plus' | 'max';

export type CapabilityProfile = {
  tier: Tier;
  modelSize: number;           // in billions (7 = 7B)
  modelName: string;
  quantization: string | null; // 'q4_K_M', 'f16', etc.
  vramGb: number;              // total VRAM available (0 if CPU-only)
  gpuCount: number;            // 0 if CPU-only
  gpuName: string | null;
  isCpuOnly: boolean;
  detectedAt: number;          // timestamp
  source: 'live' | 'cached';   // was this freshly detected or from cache?
};

export type CognitiveParams = {
  // How many LLM calls for a standard message
  calls: 1 | 2 | 3 | 4;
  // Whether to use deliberate step (analyze before respond)
  deliberate: boolean;
  // Whether to run self-check (re-read answer, fix errors)
  selfCheck: boolean;
  // Max tokens per response
  maxTokens: number;
  // Whether tools are available
  toolsEnabled: boolean;
  // Whether web_search is auto-triggered for factual questions
  autoWebSearch: boolean;
  // Agent limits
  agentMaxSteps: number;
  agentMaxDurationSec: number;
  // Whether smart notifications about hardware limits are shown
  smartNotifications: boolean;
};

// ============================================================================
// Cache
// ============================================================================
const CACHE_KEY = 'capability_profile';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getCachedProfile(): Promise<CapabilityProfile | null> {
  try {
    const row = await db.setting.findUnique({ where: { key: CACHE_KEY } });
    if (!row) return null;
    const parsed = JSON.parse(row.value) as CapabilityProfile;
    if (Date.now() - parsed.detectedAt > CACHE_TTL_MS) return null;
    return { ...parsed, source: 'cached' };
  } catch {
    return null;
  }
}

async function setCachedProfile(profile: CapabilityProfile): Promise<void> {
  try {
    await db.setting.upsert({
      where: { key: CACHE_KEY },
      create: { key: CACHE_KEY, value: JSON.stringify(profile) },
      update: { value: JSON.stringify(profile) },
    });
  } catch (e) {
    logger.warn('system', 'Failed to cache capability profile', {}, e);
  }
}

// ============================================================================
// Detection
// ============================================================================

/**
 * Detect GPU info via nvidia-smi (Linux/Windows) or system_profiler (macOS).
 * Returns null if no GPU detected (true CPU-only).
 *
 * macOS: Apple Silicon (M1/M2/M3) uses Metal via unified memory.
 * We detect this via `system_profiler SPDisplaysDataType` and report
 * VRAM as half of total system RAM (conservative estimate for ML workload).
 */
function detectGpu(): { count: number; vramGb: number; name: string | null } | null {
  // ── 1. Try nvidia-smi (Linux/Windows with NVIDIA GPU) ──
  try {
    execSync('which nvidia-smi', { stdio: 'ignore' });
    // nvidia-smi exists — use it
    const countStr = execSync('nvidia-smi --query-gpu=count --format=csv,noheader,nounits', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const count = parseInt(countStr.split('\n')[0], 10) || 0;
    if (count === 0) throw new Error('no GPUs');

    const vramStr = execSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const vramMb = vramStr
      .split('\n')
      .reduce((sum, line) => sum + (parseInt(line.trim(), 10) || 0), 0);
    const vramGb = vramMb / 1024;

    const nameStr = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const name = nameStr.split('\n')[0] || null;

    return { count, vramGb, name };
  } catch {
    // nvidia-smi not available — fall through to macOS detection
  }

  // ── 2. Try macOS detection (Apple Silicon / Intel Mac with GPU) ──
  if (process.platform === 'darwin') {
    try {
      const output = execSync('system_profiler SPDisplaysDataType -json', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const data = JSON.parse(output);
      const gpus = data?.SPDisplaysDataType ?? [];
      if (gpus.length === 0) return null;

      const gpu = gpus[0];
      const name = gpu?.sppci_model ?? 'Apple GPU';
      const isAppleSilicon = /apple/i.test(name) || /m[1-4]/i.test(name);

      if (isAppleSilicon) {
        // Apple Silicon — unified memory. Get total RAM via sysctl.
        let vramGb = 8; // default fallback
        try {
          const memBytes = parseInt(
            execSync('sysctl -n hw.memsize', { encoding: 'utf-8', timeout: 5000 }).trim(),
            10,
          );
          vramGb = memBytes / (1024 * 1024 * 1024);
        } catch { /* use fallback */ }

        // Conservative: use half of total RAM as "VRAM" for ML
        // (the other half is needed for OS + app overhead)
        return {
          count: 1,
          vramGb: vramGb / 2,
          name: `${name} (${vramGb.toFixed(0)} GB unified)`,
        };
      }

      // Intel Mac with discrete GPU (AMD/NVIDIA)
      const vramStr = gpu?.sppci_vram ?? gpu?.['sppci_vram-shared'] ?? '';
      const vramMatch = vramStr.match(/(\d+)\s*GB/i);
      const vramGb = vramMatch ? parseInt(vramMatch[1], 10) : 4;
      return { count: 1, vramGb, name };
    } catch {
      // system_profiler failed — treat as CPU-only
    }
  }

  return null;
}

/**
 * Parse parameter size from Ollama model details.
 * Returns size in billions (7 = 7B, 70 = 70B).
 */
function parseParameterSize(paramSize: string | undefined): number {
  if (!paramSize) return 0;
  // Format: "7B", "13B", "70B", "1.5B", "0.5B"
  const match = paramSize.match(/([\d.]+)\s*B/i);
  if (!match) return 0;
  return parseFloat(match[1]);
}

/**
 * Fetch model details from Ollama /api/show.
 */
async function fetchModelDetails(modelName: string): Promise<{
  parameterSize: number;
  quantization: string | null;
}> {
  try {
    const baseUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { parameterSize: 0, quantization: null };
    const data = await res.json();
    const details = data?.details ?? {};
    return {
      parameterSize: parseParameterSize(details.parameter_size),
      quantization: details.quantization_level ?? null,
    };
  } catch {
    return { parameterSize: 0, quantization: null };
  }
}

/**
 * Classify tier based on model size + hardware.
 */
function classifyTier(modelSize: number, vramGb: number, gpuCount: number, isCpuOnly: boolean): Tier {
  // CPU-only or tiny VRAM → micro regardless of model
  if (isCpuOnly || vramGb < 8) {
    // But if model is large and somehow running on CPU, still treat as micro
    // (it'll be slow but functional)
    return 'micro';
  }

  // Model size is primary signal
  if (modelSize === 0) {
    // Unknown size — infer from VRAM
    if (vramGb >= 80 || gpuCount >= 2) return 'max';
    if (vramGb >= 24) return 'plus';
    return 'standard';
  }

  if (modelSize <= 4) return 'micro';
  if (modelSize <= 13) return 'standard';
  if (modelSize <= 32) return 'plus';
  return 'max';
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Get capability profile — from cache or freshly detected.
 * If forceRefresh, ignores cache.
 */
export async function getCapabilityProfile(forceRefresh = false): Promise<CapabilityProfile | null> {
  if (!forceRefresh) {
    const cached = await getCachedProfile();
    if (cached) return cached;
  }
  return detectProfile();
}

/**
 * Detect profile from scratch — queries Ollama + nvidia-smi.
 */
export async function detectProfile(): Promise<CapabilityProfile | null> {
  const health = await checkOllamaHealth();
  if (!health.ok || health.models.length === 0) {
    return null;
  }

  // Get current model from DB
  let modelName = process.env.OLLAMA_MODEL || '';
  try {
    const row = await db.setting.findUnique({ where: { key: 'ollama_model' } });
    if (row?.value) modelName = row.value;
  } catch { /* ignore */ }
  if (!modelName) modelName = health.models[0];

  // Get model details
  const { parameterSize, quantization } = await fetchModelDetails(modelName);

  // Detect GPU
  const gpu = detectGpu();
  const gpuCount = gpu?.count ?? 0;
  const vramGb = gpu?.vramGb ?? 0;
  const gpuName = gpu?.name ?? null;
  const isCpuOnly = gpu === null;

  // Classify tier
  const tier = classifyTier(parameterSize, vramGb, gpuCount, isCpuOnly);

  const profile: CapabilityProfile = {
    tier,
    modelSize: parameterSize,
    modelName,
    quantization,
    vramGb,
    gpuCount,
    gpuName,
    isCpuOnly,
    detectedAt: Date.now(),
    source: 'live',
  };

  await setCachedProfile(profile);
  return profile;
}

// ============================================================================
// Cognitive parameters per tier
// ============================================================================
const TIER_PARAMS: Record<Tier, CognitiveParams> = {
  micro: {
    calls: 1,
    deliberate: false,
    selfCheck: false,
    maxTokens: 2048,
    toolsEnabled: true,
    autoWebSearch: true,    // 4B model needs web_search to compensate
    agentMaxSteps: 10,
    agentMaxDurationSec: 600,         // 10 min
    smartNotifications: true,
  },
  standard: {
    calls: 2,
    deliberate: false,
    selfCheck: true,        // light self-check on complex tasks
    maxTokens: 4096,
    toolsEnabled: true,
    autoWebSearch: true,
    agentMaxSteps: 25,
    agentMaxDurationSec: 3600,        // 1 hour
    smartNotifications: true,
  },
  plus: {
    calls: 3,
    deliberate: true,       // analyze before respond on complex tasks
    selfCheck: true,
    maxTokens: 8192,
    toolsEnabled: true,
    autoWebSearch: false,   // 30B+ model knows enough
    agentMaxSteps: 100,
    agentMaxDurationSec: 6 * 3600,    // 6 hours
    smartNotifications: false,
  },
  max: {
    calls: 4,
    deliberate: true,
    selfCheck: true,
    maxTokens: 16384,       // no practical limit
    toolsEnabled: true,
    autoWebSearch: false,
    agentMaxSteps: 500,
    agentMaxDurationSec: 24 * 3600,   // 24 hours
    smartNotifications: false,
  },
};

/**
 * Get cognitive parameters for the current tier.
 * If no profile available, returns 'standard' defaults.
 */
export async function getCognitiveParams(): Promise<{ profile: CapabilityProfile | null; params: CognitiveParams }> {
  const profile = await getCapabilityProfile();
  const tier = profile?.tier ?? 'standard';
  return { profile, params: TIER_PARAMS[tier] };
}

/**
 * Get tier parameters directly (for testing/preview).
 */
export function getTierParams(tier: Tier): CognitiveParams {
  return TIER_PARAMS[tier];
}

// ============================================================================
// Description for UI
// ============================================================================
export const TIER_DESCRIPTIONS: Record<Tier, { label: string; description: string; color: string }> = {
  micro: {
    label: 'Микро',
    description: 'Маленькая модель (≤4B) или CPU. Lia использует поиск в интернете для сложных вопросов.',
    color: 'text-amber-500',
  },
  standard: {
    label: 'Стандарт',
    description: 'Средняя модель (5-13B) с GPU. Подходит для большинства задач.',
    color: 'text-sky-500',
  },
  plus: {
    label: 'Плюс',
    description: 'Большая модель (14-32B). Глубокий анализ, deliberate, self-check.',
    color: 'text-violet-500',
  },
  max: {
    label: 'Максимум',
    description: 'Очень большая модель (33B+) на мощном железе. Полная когнитивная глубина, без лимитов.',
    color: 'text-rose-500',
  },
};
