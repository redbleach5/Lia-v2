// RL experience recorder — writes (state, action, reward, next_state) to DB.
//
// Called by the message handler after each user message:
//   1. Before responding: save current state + chosen action (reward = 0)
//   2. After user responds: update with reward + next_state + reward signals
//
// Python sidecar reads these rows for training.

import { db } from '@/lib/db';
import { randomUUID } from 'crypto';
import type { RLRewardSignals } from './types';

export type RLExperienceRecord = {
  id: string;
  stateJson: string;
  action: number;
  reward: number;
  nextStateJson: string;
  userResponded: boolean;
  responseLatencySec: number;
  messageLength: number;
  wasRepeated: boolean;
  irritationDelta: number;
  userMessage: string;
  episodeId: string | null;
  policyVersion: number | null;
  createdAt: Date;
};

/**
 * Save a new experience (state, action) — reward will be filled in later
 * when the user responds.
 *
 * Returns the record id so the caller can update it via completeExperience().
 */
export async function recordExperience(params: {
  state: number[];
  action: number;
  episodeId?: string;
  policyVersion?: number;
}): Promise<string> {
  const id = randomUUID();
  await db.rLExperience.create({
    data: {
      id,
      stateJson: JSON.stringify(params.state),
      action: params.action,
      reward: 0,
      nextStateJson: JSON.stringify(params.state), // placeholder — updated later
      episodeId: params.episodeId ?? null,
      policyVersion: params.policyVersion ?? null,
    },
  });
  return id;
}

/**
 * Complete an experience record — fill in reward + next_state + signals.
 *
 * Called after the user responds to Lia's action.
 */
export async function completeExperience(id: string, params: {
  nextState: number[];
  reward: number;
  signals: RLRewardSignals;
}): Promise<void> {
  try {
    // ВАЖНО: reward ДОБАВЛЯЕТСЯ к существующему, не перезаписывает.
    // Self-check мог уже записать penalty (negative reward) в поле reward.
    // computeRewardLocally вычисляет reward на основе поведения пользователя
    // (latency, length, sentiment). Финальный reward = behavior_reward + quality_penalty.
    const existing = await db.rLExperience.findUnique({ where: { id }, select: { reward: true } });
    const existingReward = existing?.reward ?? 0;
    const finalReward = existingReward + params.reward;

    await db.rLExperience.update({
      where: { id },
      data: {
        nextStateJson: JSON.stringify(params.nextState),
        reward: finalReward,
        userResponded: params.signals.userResponded,
        responseLatencySec: params.signals.responseLatencySec,
        messageLength: params.signals.messageLength,
        wasRepeated: params.signals.wasRepeated,
        irritationDelta: params.signals.irritationDelta,
        userMessage: params.signals.userMessage.slice(0, 1000),
      },
    });
  } catch (e) {
    // Non-fatal — RL training can skip malformed records
    console.warn('[rl:recorder] failed to complete experience:', e);
  }
}

/**
 * Find the last incomplete experience in an episode.
 *
 * Used by the chat route to complete the previous experience when the user
 * sends a new message — this is the reward signal for the previous action.
 *
 * Returns null if no incomplete experience exists (e.g., first message in episode).
 */
export async function findLastIncompleteExperience(episodeId: string): Promise<RLExperienceRecord | null> {
  try {
    const record = await db.rLExperience.findFirst({
      where: {
        episodeId,
        userResponded: false,
      },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    if (!record) return null;
    return {
      id: record.id,
      stateJson: record.stateJson,
      action: record.action,
      reward: record.reward,
      nextStateJson: record.nextStateJson,
      userResponded: record.userResponded,
      responseLatencySec: record.responseLatencySec,
      messageLength: record.messageLength,
      wasRepeated: record.wasRepeated,
      irritationDelta: record.irritationDelta,
      userMessage: record.userMessage,
      episodeId: record.episodeId,
      policyVersion: record.policyVersion,
      createdAt: record.createdAt,
    };
  } catch (e) {
    console.warn('[rl:recorder] failed to find last incomplete experience:', e);
    return null;
  }
}

/**
 * Count experiences in DB (for UI stats).
 */
export async function countExperiences(): Promise<number> {
  return db.rLExperience.count();
}

/**
 * Compute reward locally — uses the same formula as Python sidecar.
 * This is for preview only; the actual training uses the Python reward.py
 * which the user can edit.
 */
export function computeRewardLocally(signals: RLRewardSignals, actionId: number): number {
  let reward = 0;

  if (signals.userResponded) reward += 0.3;
  else reward -= 0.5;

  if (signals.userResponded) {
    if (signals.responseLatencySec < 60) reward += 0.2;
    else if (signals.responseLatencySec > 3600) reward -= 0.1;
  }

  if (signals.messageLength > 10) reward += 0.1;
  if (signals.messageLength > 100) reward += 0.1;
  if (signals.messageLength > 500) reward -= 0.1;

  if (signals.wasRepeated) reward -= 0.2;

  if (signals.irritationDelta > 0) reward -= 0.5 * signals.irritationDelta;
  else if (signals.irritationDelta < 0) reward += 0.2 * Math.abs(signals.irritationDelta);

  // Simple sentiment
  const sentiment = estimateSentiment(signals.userMessage);
  reward += 0.3 * sentiment;

  if (actionId === 0) reward -= 0.1;
  else if (actionId === 3 && signals.userResponded && signals.messageLength > 20) reward += 0.1;
  else if (actionId === 7 && signals.responseLatencySec < 30 && signals.userResponded) reward += 0.05;

  return reward;
}

// Simple sentiment — must match python-sidecar/rl/reward.py:estimate_user_sentiment
const POSITIVE_WORDS = new Set([
  'спасибо', 'благодарю', 'класс', 'супер', 'круто', 'отлично', 'хорошо',
  'обожаю', 'потрясающе', 'шикарно', 'да', 'конечно', 'согласен', 'согласна',
  'thanks', 'great', 'awesome', 'perfect', 'yes', 'agree', 'love',
]);
const NEGATIVE_WORDS = new Set([
  'нет', 'не', 'плохо', 'ужасно', 'бесит', 'раздражает', 'надоел', 'хватит',
  'отстань', 'не хочу', 'не буду', 'скучно', 'ерунда', 'чушь', 'бред',
  'no', 'bad', 'terrible', 'boring', 'stop', 'enough', 'stupid',
]);

function estimateSentiment(text: string): number {
  if (!text) return 0;
  const words = new Set(text.toLowerCase().replace(/[,.\!?]/g, ' ').split(/\s+/));
  let pos = 0, neg = 0;
  for (const w of words) {
    if (POSITIVE_WORDS.has(w)) pos++;
    if (NEGATIVE_WORDS.has(w)) neg++;
  }
  if (pos + neg === 0) return 0;
  return (pos - neg) / (pos + neg);
}
