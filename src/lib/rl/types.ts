import 'server-only';

// RL types — shared between Python sidecar and Next.js.
//
// Must match python-sidecar/rl/model.py:DEFAULT_ACTIONS

export const RL_ACTIONS = [
  'WAIT',              // 0
  'WARM_RESPONSE',     // 1
  'BUSINESS_RESPONSE', // 2
  'ASK_QUESTION',      // 3
  'OFFER_HELP',        // 4
  'SHARE_THOUGHT',     // 5
  'CRACK_JOKE',        // 6
  'BE_CONCISE',        // 7
  'BE_DETAILED',       // 8
] as const;

export type RLAction = typeof RL_ACTIONS[number];
export type RLActionId = number;

export const NUM_ACTIONS = RL_ACTIONS.length;
export const STATE_DIM = 13; // 5 emotion + 4 drives + 4 context

// ============================================================================
// State vector builder
// ============================================================================
export type RLStateInputs = {
  emotion: { joy: number; curiosity: number; calm: number; irritation: number; sadness: number };
  drives: { curiosity: number; social: number; safety: number; rest: number };
  context: {
    secondsSinceLastUser: number;
    episodeMessageCount: number;
    timeOfDay: number; // 0..1, hours fraction
    dominantEmotionIdx: number; // 0..4
  };
};

export function buildRLState(inputs: RLStateInputs): number[] {
  const { emotion, drives, context } = inputs;
  return [
    emotion.joy,
    emotion.curiosity,
    emotion.calm,
    emotion.irritation,
    emotion.sadness,
    drives.curiosity,
    drives.social,
    drives.safety,
    drives.rest,
    // Normalize: 1 hour = 0.01, capped at 24h
    Math.min(24 * 3600, context.secondsSinceLastUser) / (24 * 3600),
    // Normalize: 100 messages = 1.0
    Math.min(100, context.episodeMessageCount) / 100,
    // Time of day: 0..1
    context.timeOfDay,
    // Dominant emotion: 0..4 normalized to 0..1
    context.dominantEmotionIdx / 4,
  ];
}

// ============================================================================
// Reward signals — recorded when user responds
// ============================================================================
export type RLRewardSignals = {
  userResponded: boolean;
  responseLatencySec: number;
  messageLength: number;
  wasRepeated: boolean;
  irritationDelta: number;
  userMessage: string;
};

// ============================================================================
// Model versions (from Python sidecar)
// ============================================================================
export type RLModelInfo = {
  version: number;
  pt_path: string;
  onnx_path: string;
  size_pt_kb: number;
  size_onnx_kb: number;
  created_at: number;
};

export type RLStats = {
  transitions_count: number;
  model_versions: RLModelInfo[];
  active_version: number | null;
  db_path: string;
};

export type TrainResult = {
  version: number;
  avg_reward: number;
  avg_loss: number;
  avg_value_loss: number;
  avg_policy_loss: number;
  avg_entropy: number;
  samples_count: number;
  duration_sec: number;
  onnx_path: string;
  pt_path: string;
};
