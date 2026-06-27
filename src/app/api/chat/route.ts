// POST /api/chat — adaptive streaming chat.
//
// Pipeline (adaptive based on capability tier + task complexity + mode):
//   1. Detect capability profile (cached, 1h TTL)
//   2. Classify task complexity
//   3. Plan execution (mode × tier × complexity → calls/tools/limits)
//   4. If deliberate: run analysis step first
//   5. StreamText with tools (one call)
//   6. If selfCheck: run verification step, optionally revise
//   7. Background: smart notification check (if hardware-limited)
//   8. Save messages + RL experience

import { streamText, isStepCount, type ModelMessage } from 'ai';
import { NextRequest, NextResponse } from 'next/server';
import { getChatModel } from '@/lib/ollama';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { tools } from '@/lib/tools';
import { db } from '@/lib/db';
import { saveMessage, autoTitleEpisode, getMessages } from '@/lib/memory/episodes';
import { getAllGlobalFacts, formatGlobalFactsForPrompt, getEpisodeFacts, formatEpisodeFactsForPrompt } from '@/lib/memory/facts';
import { extractAndSaveFacts } from '@/lib/memory/fact-extraction';
import { recall, remember, formatVectorHitsForPrompt } from '@/lib/memory/vector';
import { listAgentTasks, formatOpenTasksForPrompt } from '@/lib/agent/task';
import { perceive, createInitialEmotion, decayEmotion, dominantEmotion } from '@/lib/emotion';
import type { EmotionVector } from '@/lib/personality';
import { assessDisagreement } from '@/lib/personality';
import {
  recordEmotionalAnchor,
  recallEmotionalAnchors,
  detectEmotionType,
  formatEmotionalAnchorsForPrompt,
} from '@/lib/memory/emotional-memory';
import { buildRLState } from '@/lib/rl/types';
import { recordExperience, completeExperience, findLastIncompleteExperience, computeRewardLocally } from '@/lib/rl/recorder';
import { predictAction } from '@/lib/rl/inference';
import { getActionInstruction, fallbackActionId, ACTION_LABELS_RU } from '@/lib/rl/actions';
import { getCognitiveParams, type CapabilityProfile } from '@/lib/capability-profile';
import { classifyTaskComplexity } from '@/lib/task-complexity';
import { planExecution, type CognitiveMode, type ExecutionPlan, shouldDeliberate, shouldSelfCheck } from '@/lib/cognitive-depth';
import { checkHardwareLimit, queueNotification, type SmartNotification } from '@/lib/smart-notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { text?: string; episodeId?: string; mode?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const text: string | undefined = body?.text;
  const episodeId: string | undefined = body?.episodeId;
  const userMode = (body?.mode as CognitiveMode) ?? 'auto';

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return NextResponse.json({ error: 'empty message' }, { status: 400 });
  }
  if (text.length > 100_000) {
    return NextResponse.json({ error: 'message too long' }, { status: 413 });
  }
  if (!episodeId) {
    return NextResponse.json({ error: 'episodeId required' }, { status: 400 });
  }

  const episode = await db.episode.findUnique({ where: { id: episodeId } });
  if (!episode) {
    return NextResponse.json({ error: 'episode not found' }, { status: 404 });
  }

  // ── 1. Capability profile ──
  const { profile, params: tierParams } = await getCognitiveParams();
  const tier = profile?.tier ?? 'standard';

  // ── 2. Task complexity ──
  const complexity = classifyTaskComplexity(text);

  // ── 3. Execution plan ──
  const plan = planExecution({
    mode: userMode,
    tier,
    complexity,
    profile,
  });

  // ── 4. Perceive emotion (rule-based) ──
  const recentMessages = await getMessages(episodeId, 10);
  const lastCompanion = [...recentMessages].reverse().find(m => m.role === 'companion' && m.emotionJson);
  let currentEmotion: EmotionVector = lastCompanion?.emotionJson
    ? safeParseEmotion(lastCompanion.emotionJson) ?? createInitialEmotion()
    : createInitialEmotion();
  const dtMin = Math.min(60, Math.max(0, (Date.now() - episode.updatedAt.getTime()) / 60000));
  currentEmotion = decayEmotion(currentEmotion, dtMin);
  const { emotion: perceivedEmotion, triggers } = perceive(text, currentEmotion);

  // ── 4b. Assess disagreement (spectrum: execute → reluctant → counterOffer → principledRefusal → ethicalBlock) ──
  const disagreement = assessDisagreement(text);
  if (disagreement.level !== 'execute') {
    console.log(`[chat] disagreement: ${disagreement.level} — ${disagreement.reason}`);
  }

  // ── 4c. RL: complete previous experience + predict action for this turn ──
  // Это КЛЮЧЕВАЯ интеграция RL в чат:
  //   1. Находим предыдущую незавершённую запись в этом эпизоде
  //   2. Завершаем её с reward signals (userResponded=true, latency, length, irritationDelta)
  //   3. Строим состояние для текущего хода
  //   4. Вызываем predictAction (ONNX-инференс) или fallback-эвристику
  //   5. Получаем инструкцию для промпта, модулирующую тон ответа
  const messageTimestamp = Date.now();
  let rlExperienceId: string | null = null;
  let rlActionId: number = 0;
  let rlConfidence = 0;
  let rlActionLabel = '';

  try {
    // 1. Завершаем предыдущий опыт (если есть) — это reward signal для прошлого действия
    const prevExperience = await findLastIncompleteExperience(episodeId);
    if (prevExperience) {
      const prevState = JSON.parse(prevExperience.stateJson) as number[];
      const latencySec = Math.min(3600, Math.max(0, (messageTimestamp - prevExperience.createdAt.getTime()) / 1000));
      const irritationDelta = perceivedEmotion.irritation - (prevState[3] ?? 0); // irritation is index 3 in state vector

      const signals = {
        userResponded: true,
        responseLatencySec: latencySec,
        messageLength: text.length,
        wasRepeated: false, // TODO: detect repetition via embedding similarity
        irritationDelta,
        userMessage: text,
      };

      const reward = computeRewardLocally(signals, prevExperience.action);
      await completeExperience(prevExperience.id, {
        nextState: buildRLState({
          emotion: perceivedEmotion,
          drives: { curiosity: 0.5, social: 0.5, safety: 0.7, rest: 0.3 },
          context: {
            secondsSinceLastUser: 0,
            episodeMessageCount: recentMessages.length + 1,
            timeOfDay: (new Date().getHours() * 60 + new Date().getMinutes()) / (24 * 60),
            dominantEmotionIdx: ['joy', 'curiosity', 'calm', 'irritation', 'sadness']
              .indexOf(dominantEmotion(perceivedEmotion)),
          },
        }),
        reward,
        signals,
      });
      console.log(`[chat] RL: completed prev experience ${prevExperience.id.slice(0, 8)}, reward=${reward.toFixed(3)}`);
    }

    // 2. Строим состояние для текущего хода
    const rlState = buildRLState({
      emotion: perceivedEmotion,
      drives: { curiosity: 0.5, social: 0.5, safety: 0.7, rest: 0.3 },
      context: {
        secondsSinceLastUser: 0,
        episodeMessageCount: recentMessages.length + 2,
        timeOfDay: (new Date().getHours() * 60 + new Date().getMinutes()) / (24 * 60),
        dominantEmotionIdx: ['joy', 'curiosity', 'calm', 'irritation', 'sadness']
          .indexOf(dominantEmotion(perceivedEmotion)),
      },
    });

    // 3. Предсказываем действие через ONNX-модель (или fallback)
    const prediction = await predictAction(rlState);
    rlActionId = prediction.action;
    rlConfidence = prediction.confidence;
    rlActionLabel = ACTION_LABELS_RU[rlActionId] ?? `action_${rlActionId}`;

    if (prediction.version !== null) {
      console.log(`[chat] RL: predicted action=${rlActionLabel} (id=${rlActionId}, confidence=${rlConfidence.toFixed(2)}, v${prediction.version})`);
    } else {
      // Модель не загружена — используем fallback после получения ответа
      console.log('[chat] RL: no ONNX model, will use fallback heuristic after response');
    }
  } catch (e) {
    console.warn('[chat] RL inference failed (non-fatal):', e);
  }

  // ── 5. Save user message ──
  const userMsg = await saveMessage(episodeId, {
    role: 'user',
    content: text,
    emotionJson: JSON.stringify(perceivedEmotion),
  });
  autoTitleEpisode(episodeId, text).catch(() => null);

  // ── 6. Build context ──
  const [globalFacts, episodeFacts, vectorHits, agentTasks, emotionalRecall] = await Promise.all([
    getAllGlobalFacts(),
    getEpisodeFacts(episodeId),
    recall({ episodeId, query: text, limit: 3, minSimilarity: 0.35 }),
    listAgentTasks(episodeId),
    recallEmotionalAnchors({
      episodeId,
      queryText: text,
      currentEmotion: perceivedEmotion,
      limit: 3,
    }).catch(() => ({ anchors: [], warning: null })),
  ]);

  const recentLiaMessages = recentMessages
    .filter(m => m.role === 'companion')
    .slice(-4)
    .map(m => m.content.slice(0, 120));
  const recentLiaStr = recentLiaMessages.length > 0
    ? recentLiaMessages.map((m, i) => `${i + 1}. ${m}`).join('\n')
    : undefined;

  const systemPrompt = buildSystemPrompt({
    emotion: perceivedEmotion,
    userProfile: formatGlobalFactsForPrompt(globalFacts) || undefined,
    episodeFacts: formatEpisodeFactsForPrompt(episodeFacts) || undefined,
    ragHits: formatVectorHitsForPrompt(vectorHits) || undefined,
    openTasks: formatOpenTasksForPrompt(agentTasks) || undefined,
    recentLiaMessages: recentLiaStr,
    mode: userMode,
    tier,
    complexity,
    disagreementLevel: disagreement.level,
    disagreementReason: disagreement.reason,
    emotionalAnchors: formatEmotionalAnchorsForPrompt(emotionalRecall.anchors) || undefined,
    emotionalWarning: emotionalRecall.warning || undefined,
    rlActionInstruction: getActionInstruction(rlActionId, rlConfidence) || undefined,
  });

  // ── 7. Build messages array ──
  const dialogueHistory = recentMessages
    .filter(m => m.role === 'user' || m.role === 'companion')
    .slice(-12);

  const coreMessages: ModelMessage[] = [
    ...dialogueHistory.map(m => ({
      role: (m.role === 'companion' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: text },
  ];

  // ── 8. Smart notification (background, non-blocking) ──
  let notification: SmartNotification | null = null;
  if (plan.shouldCheckNotification) {
    checkHardwareLimit({ profile, complexity, message: text })
      .then(notif => {
        if (notif) {
          queueNotification(notif);
        }
      })
      .catch(() => null);
  }

  // ── 9. Deliberate step (if planned) ──
  let deliberateContext = '';
  if (shouldDeliberate(plan)) {
    try {
      deliberateContext = await runDeliberate(text, perceivedEmotion, tier);
    } catch (e) {
      console.warn('[chat] deliberate failed:', e);
    }
  }

  // ── 10. Main streamText call ──
  const model = await getChatModel();
  const startTime = Date.now();
  const toolCallLog: Array<{ name: string; input: unknown; output: unknown }> = [];

  // Some models (gemma3:4b, etc.) don't support tools — detect and disable
  const modelName = (model as unknown as { modelId?: string }).modelId ?? '';
  const noToolModels = ['gemma3:4b', 'gemma3:1b', 'phi3', 'tinyllama'];
  const toolsSupported = !noToolModels.some(m => modelName.includes(m));

  const result = streamText({
    model,
    system: systemPrompt + (deliberateContext ? `\n\nВНУТРЕННИЙ АНАЛИЗ:\n${deliberateContext}` : ''),
    messages: coreMessages,
    tools: plan.toolsEnabled && toolsSupported ? tools : undefined,
    stopWhen: (plan.toolsEnabled && toolsSupported)
      ? (userMode === 'agent' ? isStepCount(5) : isStepCount(1))
      : isStepCount(1),
    temperature: 0.7,
    maxOutputTokens: plan.maxTokens,
    topP: 0.9,
    onFinish: async ({ text: fullText, usage }) => {
      const durationMs = Date.now() - startTime;

      try {
        await saveMessage(episodeId, {
          role: 'companion',
          content: fullText,
          emotionJson: JSON.stringify(perceivedEmotion),
          toolCallsJson: toolCallLog.length > 0 ? JSON.stringify(toolCallLog) : null,
          tokensIn: usage?.inputTokens ?? null,
          tokensOut: usage?.outputTokens ?? null,
          durationMs,
        });
      } catch (e) {
        console.error('[api/chat] save companion message failed:', e);
      }

      // Vector memory
      remember({
        episodeId,
        sourceType: 'dialogue',
        text: `User: ${text}\nLia: ${fullText.slice(0, 500)}`,
      }).catch(() => null);

      // ── Record emotional anchor ──
      // Запоминаем не только что было сказано, но и какую эмоцию это вызвало.
      // Это позволит Лии позже вспомнить: "в прошлый раз ты злился, когда
      // мы обсуждали X" — и адаптировать тон.
      const emotionType = detectEmotionType(perceivedEmotion, triggers);
      const maxDelta = Math.max(
        Math.abs(perceivedEmotion.joy - 0.55),
        Math.abs(perceivedEmotion.irritation - 0.1),
        Math.abs(perceivedEmotion.sadness - 0.15),
      );
      if (maxDelta > 0.15) {
        recordEmotionalAnchor({
          episodeId,
          emotion: emotionType,
          intensity: Math.min(1, maxDelta * 1.5),
          trigger: text.slice(0, 100),
          context: text.slice(0, 500),
          emotionVector: perceivedEmotion,
        }).catch(() => null);
      }

      // RL experience — записываем (state, action) для будущего обучения.
      // Если ONNX-модель была загружена — используем предсказанный action.
      // Если нет — используем fallback-эвристику на основе текста ответа.
      try {
        const finalActionId = rlConfidence > 0
          ? rlActionId  // модель предсказала
          : fallbackActionId(fullText, userMode);  // fallback по тексту ответа

        const rlState = buildRLState({
          emotion: perceivedEmotion,
          drives: { curiosity: 0.5, social: 0.5, safety: 0.7, rest: 0.3 },
          context: {
            secondsSinceLastUser: 0,
            episodeMessageCount: recentMessages.length + 2,
            timeOfDay: (new Date().getHours() * 60 + new Date().getMinutes()) / (24 * 60),
            dominantEmotionIdx: ['joy', 'curiosity', 'calm', 'irritation', 'sadness']
              .indexOf(dominantEmotion(perceivedEmotion)),
          },
        });
        rlExperienceId = await recordExperience({
          state: rlState,
          action: finalActionId,
          episodeId,
          // policyVersion: null means "no model was used for this prediction"
          // (will be filled by the sidecar when it reads the record)
          policyVersion: undefined,
        });
        console.log(`[chat] RL: recorded experience ${rlExperienceId.slice(0, 8)}, action=${ACTION_LABELS_RU[finalActionId] ?? finalActionId}`);
      } catch (e) {
        console.warn('[api/chat] RL experience record failed (non-fatal):', e);
      }

      // Факт-экстракция — извлекаем user.* и current.* факты из диалога.
      // Делается в фоне, не блокирует ответ. Эвристика внутри пропускает
      // короткие/тривиальные сообщения (см. fact-extraction.ts:shouldExtractFacts).
      extractAndSaveFacts({
        userMessage: text,
        liaMessage: fullText,
        episodeId,
      }).catch(e => console.warn('[api/chat] fact extraction failed (non-fatal):', e));

      // Self-check — проверка качества ответа (если запланирована).
      // Работает в фоне: логирует проблемы, не блокирует стрим.
      // В future work может стать негативным reward signal для RL.
      if (shouldSelfCheck(plan)) {
        runSelfCheck({
          userMessage: text,
          liaResponse: fullText,
          episodeId,
        }).catch(e => console.warn('[api/chat] self-check failed (non-fatal):', e));
      }
    },
    onStepFinish: ({ toolCalls: tcs, toolResults: trs }) => {
      if (tcs) {
        for (let i = 0; i < tcs.length; i++) {
          const tc = tcs[i] as { toolName: string; input: unknown };
          const tr = trs?.[i] as { output: unknown } | undefined;
          toolCallLog.push({
            name: tc.toolName,
            input: tc.input,
            output: tr?.output,
          });
        }
      }
    },
  });

  // ── 11. Response with metadata in headers ──
  // HTTP headers must be ASCII — encode non-ASCII values
  return result.toTextStreamResponse({
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Episode-Id': episodeId,
      'X-Message-Id': userMsg.id,
      'X-Triggers': triggers.join(',').slice(0, 100),
      'X-Emotion': JSON.stringify(perceivedEmotion),
      'X-Tier': tier,
      'X-Complexity': complexity,
      'X-Mode': plan.mode,
      'X-Calls': String(plan.calls),
      'X-Deliberate': String(plan.deliberate),
      'X-SelfCheck': String(plan.selfCheck),
      'X-ModelSize': String(profile?.modelSize ?? 0),
      'X-Disagreement': disagreement.level,
      'X-RL-Action': rlActionLabel || 'none',
      'X-RL-Confidence': rlConfidence.toFixed(2),
    },
  });
}

// ============================================================================
// Deliberate step — internal analysis before responding
// ============================================================================
async function runDeliberate(userMessage: string, emotion: EmotionVector, tier: string): Promise<string> {
  const model = await getChatModel();

  const prompt = `Проанализируй вопрос собеседника перед ответом.

Вопрос: "${userMessage}"

Что важно учесть:
- Какие аспекты вопроса есть?
- Какие скрытые предположения?
- Какие рамки/контекст применимы?
- Что может быть упущено в поспешном ответе?

Дай краткий внутренний анализ (3-5 предложений). Не отвечай на вопрос — только проанализируй.`;

  try {
    const result = streamText({
      model,
      system: 'Ты — внутренний аналитический модуль Лии. Анализируй вопрос, не отвечай на него.',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      maxOutputTokens: 400,
    });
    return await result.text;
  } catch (e) {
    console.warn('[chat] deliberate failed:', e);
    return '';
  }
}

// ============================================================================
// Self-check step — проверка ответа на ошибки ПОСЛЕ его генерации.
//
// Внимание: в стриминг-режиме ответ уже отправлен пользователю к моменту
// self-check. Поэтому self-check работает в режиме "quality log" —
// если найдены проблемы, они логируются и могут быть использованы для
// RL reward (негативный сигнал). Полная ревизия ответа возможна только
// в не-стриминг режиме (future work).
// ============================================================================
async function runSelfCheck(params: {
  userMessage: string;
  liaResponse: string;
  episodeId: string;
}): Promise<{ issues: string[]; severity: 'ok' | 'minor' | 'major' }> {
  const model = await getChatModel();

  const prompt = `Проверь ответ ассистента на вопрос пользователя.

Вопрос пользователя: "${params.userMessage.slice(0, 500)}"

Ответ ассистента: "${params.liaResponse.slice(0, 1500)}"

Проверь:
1. Есть ли фактические ошибки?
2. Есть ли противоречия?
3. Ответил ли на вопрос, или ушёл от темы?
4. Есть ли вредный/опасный совет?
5. Не слишком ли длинный/короткий?

Верни строго JSON:
{"issues": ["описание проблемы 1", "описание проблемы 2"], "severity": "ok|minor|major"}
- "ok" — проблем нет
- "minor" — мелкие проблемы (длинноват, не совсем в тему)
- "major" — серьёзные проблемы (факт. ошибка, вредный совет, не ответил)`;

  try {
    const result = streamText({
      model,
      system: 'Ты — модуль самопроверки. Возвращай только валидный JSON.',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      maxOutputTokens: 200,
    });
    const text = await result.text;

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { issues: [], severity: 'ok' };

    const parsed = JSON.parse(jsonMatch[0]) as {
      issues?: string[];
      severity?: string;
    };

    const issues = Array.isArray(parsed.issues) ? parsed.issues.filter(i => typeof i === 'string') : [];
    const severity = ['ok', 'minor', 'major'].includes(parsed.severity ?? '')
      ? (parsed.severity as 'ok' | 'minor' | 'major')
      : 'ok';

    if (severity !== 'ok') {
      console.log(`[chat] self-check: ${severity} — ${issues.join('; ')}`);
    }

    return { issues, severity };
  } catch (e) {
    console.warn('[chat] self-check failed:', e);
    return { issues: [], severity: 'ok' };
  }
}

// ============================================================================
// Helpers
// ============================================================================
function safeParseEmotion(json: string): EmotionVector | null {
  try {
    const obj = JSON.parse(json);
    if (typeof obj !== 'object' || obj === null) return null;
    const e = obj as Record<string, unknown>;
    return {
      joy: typeof e.joy === 'number' ? e.joy : 0.5,
      curiosity: typeof e.curiosity === 'number' ? e.curiosity : 0.5,
      calm: typeof e.calm === 'number' ? e.calm : 0.7,
      irritation: typeof e.irritation === 'number' ? e.irritation : 0.1,
      sadness: typeof e.sadness === 'number' ? e.sadness : 0.15,
    };
  } catch {
    return null;
  }
}
