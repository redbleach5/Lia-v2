import 'server-only';

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
import { logger } from '@/lib/logger';

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
    // Phase 5.2: reward больше не вычисляется на TS стороне.
    // completeExperience вызывается с reward=0. Self-check мог уже записать
    // penalty (negative reward) в поле reward через прямой db.rLExperience.update.
    // Финальный reward для training вычисляется Python train.py из raw signals.
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
    logger.warn('rl', 'failed to complete experience', {}, e);
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
    logger.warn('rl', 'failed to find last incomplete experience', {}, e);
    return null;
  }
}

/**
 * Count experiences in DB (for UI stats).
 */
export async function countExperiences(): Promise<number> {
  return db.rLExperience.count();
}

// Phase 5.2: computeRewardLocally удалён.
// Раньше reward вычислялся на TS стороне (дубликат python-sidecar/rl/reward.py)
// и сохранялся в RLExperience.reward. Но Python train.py ВСЕГДА пересчитывает
// reward из raw signals (см. train.py:129-130: compute_reward(Transition(...))).
// Stored reward не использовался для training — только для UI stats.
//
// Теперь: completeExperience вызывается с reward=0. Self-check может добавить
// penalty через прямой db.rLExperience.update (см. pipeline.ts persistResponse).
// Финальный reward для training вычисляется Python'ом из signals.
// UI stats показывают avg_reward из Python TrainResult (актуальный посчитанный).
//
// Это устраняет дублирование логики между TS и Python — Python единственный
// source of truth для reward. Пользователь может редактировать reward.py
// и изменения применятся при следующем training без правок TS кода.
