// ============================================================================
// Types — shared across all store slices.
// ============================================================================

import type { EmotionVector } from '@/lib/personality';

export type ChatMessage = {
  id: string;
  role: 'user' | 'companion';
  content: string;
  emotion?: EmotionVector;
  toolCalls?: Array<{ name: string; input: unknown; output: unknown }>;
  createdAt: number;
  streaming?: boolean;
};

export type Episode = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

// Строгий union для статусов задачи — раньше был string.
export type AgentTaskStatus =
  | 'pending'
  | 'planning'
  | 'executing'
  | 'waiting_input'
  | 'waiting_confirmation'
  | 'synthesizing'
  | 'done'
  | 'failed'
  | 'cancelled';

export type AgentTask = {
  id: string;
  episodeId: string;
  goal: string;
  status: AgentTaskStatus;
  currentStep: number;
  maxSteps: number;
  error: string | null;
  resultSummary: string | null;
  createdAt: string;
};

// Real-time step data for the active task (from SSE)
export type AgentStepLive = {
  step: number;
  thought: string;
  action: string;
  observation: string;
  durationMs?: number;
  tools?: Array<{ name: string; input: unknown; success: boolean; output: unknown }>;
  ts: number;
};

export type AgentPlanLive = {
  goal: string;
  steps: string[];
  complexity: string;
};

export type ChatMode = 'auto' | 'fast' | 'standard' | 'deep' | 'agent';

// Базовая эмоция Лии (baseline) — используется для initial state.
export const INITIAL_EMOTION: EmotionVector = {
  joy: 0.55,
  curiosity: 0.75,
  calm: 0.7,
  irritation: 0.1,
  sadness: 0.15,
};
