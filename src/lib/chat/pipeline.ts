import 'server-only';

// ============================================================================
// ChatPipeline — оркестрация chat message processing.
// ============================================================================
//
// Заменяет god-route chat/route.ts (634 строки) на структурированный pipeline.
// Route handler остаётся тонким: валидация → pipeline.run() → return response.
//
// Шаги:
//   1.  preflight (Ollama health)
//   2.  capability (getCognitiveParams)
//   3.  complexity (classifyTaskComplexity)
//   4.  plan (planExecution)
//   5.  perceive (emotion decay + perceive)
//   6.  disagreement (assessDisagreement)
//   7.  RL complete + predict
//   8.  save user message
//   9.  build context (Promise.all: facts, vector, agent tasks, emotional recall)
//   10. build system prompt + messages
//   11. smart notification (background)
//   12. deliberate (if planned)
//   13. streamText (main, with onFinish callback for persist)
//   14. response with metadata headers

import { streamText, isStepCount, type ModelMessage } from 'ai';
import { NextResponse } from 'next/server';
import { getChatModel, checkOllamaHealth, getOllamaSettings, getModelName } from '@/lib/ollama';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { tools } from '@/lib/tools';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
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
import { recordExperience, completeExperience, findLastIncompleteExperience } from '@/lib/rl/recorder';
import { predictAction } from '@/lib/rl/inference';
import { getActionInstruction, fallbackActionId, ACTION_LABELS_RU } from '@/lib/rl/actions';
import { getCognitiveParams } from '@/lib/capability-profile';
import { classifyTaskComplexity } from '@/lib/task-complexity';
import { planExecution, type CognitiveMode, shouldDeliberate, shouldSelfCheck } from '@/lib/cognitive-depth';
import { checkHardwareLimit, queueNotification, type SmartNotification } from '@/lib/smart-notifications';
import { safeParseEmotion } from './safe-parse-emotion';
import { runDeliberate } from './deliberate';
import { runSelfCheck } from './self-check';
import { isRepeatedMessage } from './is-repeated-message';

export type ChatPipelineInput = {
  text: string;
  episodeId: string;
  mode: CognitiveMode;
};

export type ChatPipelineResult = {
  response: Response;
};

// Модели, у которых отключён tool calling (известные проблемы с поддержкой).
const NO_TOOL_MODELS = ['gemma3:4b', 'gemma3:1b', 'phi3', 'tinyllama'];

export async function runChatPipeline(input: ChatPipelineInput): Promise<ChatPipelineResult | NextResponse> {
  const { text, episodeId, mode: userMode } = input;
  const log = logger.context({ episodeId: episodeId.slice(0, 8), mode: userMode });
  log.info('chat', 'Chat request received', {
    textLength: text.length,
    textPreview: text.slice(0, 80),
  });

  // ── 1. Pre-flight: LLM availability ──
  const settings = await getOllamaSettings();

  if (settings.provider === 'groq') {
    // Groq mode — не нужен Ollama для чата, но нужен для embeddings.
    // Проверяем только что API key задан.
    if (!settings.groqApiKey || settings.groqApiKey === '') {
      return NextResponse.json({
        error: 'Groq API key не задан. Открой Настройки → Модель и введи ключ.',
      }, { status: 503 });
    }
    log.info('llm', 'Pre-flight: using Groq', { model: settings.groqModel });
  } else {
    // Ollama mode — full health check
    const preflightHealth = await checkOllamaHealth();
    if (!preflightHealth.ok) {
      log.warn('ollama', 'Pre-flight failed — Ollama unavailable', { error: preflightHealth.error });
      return NextResponse.json({
        error: 'Ollama недоступен. Запусти `ollama serve` или проверь URL в настройках.',
        details: preflightHealth.error ?? 'unknown error',
        ollamaUrl: settings.baseUrl,
      }, { status: 503 });
    }
    if (preflightHealth.models.length === 0) {
      log.warn('ollama', 'Pre-flight failed — no models');
      return NextResponse.json({
        error: 'В Ollama нет моделей. Скачай хотя бы одну: `ollama pull qwen2.5:7b`.',
      }, { status: 503 });
    }
  }

  // ── 2. Capability profile ──
  const { profile } = await getCognitiveParams();
  const tier = profile?.tier ?? 'standard';

  // ── 3. Task complexity ──
  const complexity = classifyTaskComplexity(text);

  // ── 4. Execution plan ──
  const plan = planExecution({ mode: userMode, tier, complexity, profile });
  log.info('chat', 'Execution plan', {
    tier, complexity, planMode: plan.mode, calls: plan.calls,
    deliberate: plan.deliberate, selfCheck: plan.selfCheck,
    toolsEnabled: plan.toolsEnabled, maxTokens: plan.maxTokens,
  });

  // ── 5. Perceive emotion ──
  const recentMessages = await getMessages(episodeId, 10);
  const lastCompanion = [...recentMessages].reverse().find(m => m.role === 'companion' && m.emotionJson);
  let currentEmotion: EmotionVector = lastCompanion?.emotionJson
    ? safeParseEmotion(lastCompanion.emotionJson) ?? createInitialEmotion()
    : createInitialEmotion();
  const dtMin = Math.min(60, Math.max(0, (Date.now() - (await db.episode.findUnique({ where: { id: episodeId } }))!.updatedAt.getTime()) / 60000));
  currentEmotion = decayEmotion(currentEmotion, dtMin);
  const { emotion: perceivedEmotion, triggers } = perceive(text, currentEmotion);
  log.debug('chat', 'Emotion perceived', {
    dominant: dominantEmotion(perceivedEmotion),
    triggers: triggers.length > 0 ? triggers.join(',') : 'none',
  });

  // ── 6. Disagreement ──
  const disagreement = assessDisagreement(text);
  if (disagreement.level !== 'execute') {
    log.info('chat', 'Disagreement detected', { level: disagreement.level, reason: disagreement.reason });
  }

  // ── 7. RL: complete previous + predict current ──
  const rlResult = await processRL({
    episodeId, text, perceivedEmotion, recentMessages, messageTimestamp: Date.now(), log,
  });

  // ── 8. Save user message ──
  const userMsg = await saveMessage(episodeId, {
    role: 'user',
    content: text,
    emotionJson: JSON.stringify(perceivedEmotion),
  });
  autoTitleEpisode(episodeId, text).catch(() => null);

  // ── 9. Build context (parallel) ──
  const [globalFacts, episodeFacts, vectorHits, agentTasks, emotionalRecall] = await Promise.all([
    getAllGlobalFacts(),
    getEpisodeFacts(episodeId),
    recall({ episodeId, query: text, limit: 3, minSimilarity: 0.35 }),
    listAgentTasks(episodeId),
    recallEmotionalAnchors({ episodeId, queryText: text, currentEmotion: perceivedEmotion, limit: 3 })
      .catch(() => ({ anchors: [], warning: null })),
  ]);

  // ── 10. Build system prompt + messages ──
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
    rlActionInstruction: getActionInstruction(rlResult.rlActionId, rlResult.rlConfidence) || undefined,
  });

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

  // ── 11. Smart notification (background, non-blocking) ──
  let _notification: SmartNotification | null = null;
  if (plan.shouldCheckNotification) {
    checkHardwareLimit({ profile, complexity, message: text })
      .then(notif => { if (notif) queueNotification(notif); })
      .catch(() => null);
  }

  // ── 12. Deliberate (if planned) ──
  let deliberateContext = '';
  if (shouldDeliberate(plan)) {
    try {
      deliberateContext = await runDeliberate(text, perceivedEmotion, tier);
    } catch (e) {
      log.warn('chat', 'Deliberate step failed', {}, e);
    }
  }

  // ── 13. Main streamText ──
  const model = await getChatModel();
  const startTime = Date.now();
  const toolCallLog: Array<{ name: string; input: unknown; output: unknown }> = [];
  const modelName = await getModelName();
  const toolsSupported = !NO_TOOL_MODELS.some(m => modelName.includes(m));

  // Capture для onFinish callback
  const rlState = rlResult.rlState;
  const rlModelLoaded = rlResult.rlModelLoaded;
  const rlActionId = rlResult.rlActionId;
  const rlModelVersion = rlResult.rlModelVersion;

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
    onError: (error) => {
      log.error('chat', 'streamText onError', {}, error);
    },
    onFinish: async ({ text: fullText, usage }) => {
      await persistResponse({
        fullText, usage, startTime, episodeId, text, perceivedEmotion, triggers,
        toolCallLog, recentMessages, rlState, rlModelLoaded, rlActionId, rlModelVersion,
        plan, log,
      });
    },
    onStepFinish: ({ toolCalls: tcs, toolResults: trs }) => {
      if (tcs) {
        for (let i = 0; i < tcs.length; i++) {
          const tc = tcs[i] as { toolName: string; input: unknown };
          const tr = trs?.[i] as { output: unknown } | undefined;
          toolCallLog.push({ name: tc.toolName, input: tc.input, output: tr?.output });
        }
      }
    },
  });

  // ── 14. Response with metadata ──
  // Заголовки с non-ASCII (русский текст, JSON с кириллицей) кодируем в base64
  // и помечаем суффиксом -B64 в имени. Остальные — plain ASCII.
  // Клиент декодирует только -B64 заголовки, остальные читает как есть.
  // Раньше все заголовки кодировались в base64 — atob("standard") давал мусор.
  const encodeB64 = (s: string): string => {
    try { return Buffer.from(s, 'utf-8').toString('base64'); } catch { return ''; }
  };

  const response = result.toTextStreamResponse({
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      // ASCII-only metadata (без base64)
      'X-Episode-Id': episodeId,
      'X-Message-Id': userMsg.id,
      'X-Tier': tier,
      'X-Complexity': complexity,
      'X-Mode': plan.mode,
      'X-Calls': String(plan.calls),
      'X-Deliberate': String(plan.deliberate),
      'X-SelfCheck': String(plan.selfCheck),
      'X-ModelSize': String(profile?.modelSize ?? 0),
      'X-RL-Confidence': rlResult.rlConfidence.toFixed(2),
      // Non-ASCII metadata (base64-encoded, суффикс -B64)
      'X-Triggers-B64': encodeB64(triggers.join(',').slice(0, 200)),
      'X-Emotion-B64': encodeB64(JSON.stringify(perceivedEmotion)),
      'X-Disagreement-B64': encodeB64(disagreement.level),
      'X-RL-Action-B64': encodeB64(rlResult.rlActionLabel || 'none'),
    },
  });

  return { response };
}

// ============================================================================
// RL processing — complete previous experience + predict current action.
// ============================================================================
type RLProcessResult = {
  rlActionId: number;
  rlConfidence: number;
  rlActionLabel: string;
  rlModelVersion: number | null;
  rlModelLoaded: boolean;
  rlState: number[];
  rlExperienceId: string | null;
};

async function processRL(params: {
  episodeId: string;
  text: string;
  perceivedEmotion: EmotionVector;
  recentMessages: Awaited<ReturnType<typeof getMessages>>;
  messageTimestamp: number;
  log: ReturnType<typeof logger.context>;
}): Promise<RLProcessResult> {
  const { episodeId, text, perceivedEmotion, recentMessages, messageTimestamp, log } = params;
  let rlExperienceId: string | null = null;
  let rlActionId = 0;
  let rlConfidence = 0;
  let rlActionLabel = '';
  let rlModelVersion: number | null = null;
  let rlModelLoaded = false;

  const buildContext = (msgCount: number) => ({
    secondsSinceLastUser: 0,
    episodeMessageCount: msgCount,
    timeOfDay: (new Date().getHours() * 60 + new Date().getMinutes()) / (24 * 60),
    dominantEmotionIdx: ['joy', 'curiosity', 'calm', 'irritation', 'sadness']
      .indexOf(dominantEmotion(perceivedEmotion)),
  });

  try {
    // 1. Complete previous experience
    const prevExperience = await findLastIncompleteExperience(episodeId);
    if (prevExperience) {
      const prevState = JSON.parse(prevExperience.stateJson) as number[];
      const latencySec = Math.min(3600, Math.max(0, (messageTimestamp - prevExperience.createdAt.getTime()) / 1000));
      const irritationDelta = perceivedEmotion.irritation - (prevState[3] ?? 0);

      // Phase 4.2: detect repetition — сравниваем текущее сообщение с предыдущим.
      // Используем нормализованное string comparison (lowercase, trim, remove punctuation).
      // Embedding similarity был бы точнее, но это лишний HTTP-вызов к Ollama на каждое сообщение.
      // Порог 0.8 (Jaccard similarity на словах) — достаточно для detection "ты повторил вопрос".
      const wasRepeated = isRepeatedMessage(text, prevExperience.userMessage);

      const signals = {
        userResponded: true,
        responseLatencySec: latencySec,
        messageLength: text.length,
        wasRepeated,
        irritationDelta,
        userMessage: text,
      };

      if (wasRepeated) {
        log.info('rl', 'Repeated message detected — penalty will apply', {
          currentPreview: text.slice(0, 60),
          prevPreview: prevExperience.userMessage.slice(0, 60),
        });
      }

      // Phase 5.2: reward=0 — больше не вычисляем на TS стороне.
      // Python train.py пересчитает reward из raw signals при обучении.
      // Self-check может добавить penalty позже через прямой db update.
      await completeExperience(prevExperience.id, {
        nextState: buildRLState({
          emotion: perceivedEmotion,
          drives: { curiosity: 0.5, social: 0.5, safety: 0.7, rest: 0.3 },
          context: buildContext(recentMessages.length + 1),
        }),
        reward: 0,
        signals,
      });
      log.info('rl', 'Completed previous experience', {
        experienceId: prevExperience.id.slice(0, 8),
        wasRepeated,
      });
    }

    // 2. Build state for current turn
    const rlState = buildRLState({
      emotion: perceivedEmotion,
      drives: { curiosity: 0.5, social: 0.5, safety: 0.7, rest: 0.3 },
      context: buildContext(recentMessages.length + 2),
    });

    // 3. Predict action
    const prediction = await predictAction(rlState);
    rlActionId = prediction.action;
    rlConfidence = prediction.confidence;
    rlActionLabel = ACTION_LABELS_RU[rlActionId] ?? `action_${rlActionId}`;
    rlModelVersion = prediction.version;
    rlModelLoaded = prediction.version !== null;

    if (rlModelLoaded) {
      log.info('rl', 'Predicted action', { action: rlActionLabel, actionId: rlActionId, confidence: rlConfidence.toFixed(2), version: rlModelVersion });
    } else {
      log.info('rl', 'No ONNX model — will use fallback heuristic');
    }

    return { rlActionId, rlConfidence, rlActionLabel, rlModelVersion, rlModelLoaded, rlState, rlExperienceId };
  } catch (e) {
    log.warn('rl', 'Inference failed (non-fatal)', {}, e);
    return {
      rlActionId: 0, rlConfidence: 0, rlActionLabel: '', rlModelVersion: null, rlModelLoaded: false,
      rlState: buildRLState({
        emotion: perceivedEmotion,
        drives: { curiosity: 0.5, social: 0.5, safety: 0.7, rest: 0.3 },
        context: buildContext(recentMessages.length + 2),
      }),
      rlExperienceId: null,
    };
  }
}

// ============================================================================
// persistResponse — onFinish callback: save companion msg, vector memory,
// emotional anchor, RL experience, fact extraction, self-check.
// ============================================================================
async function persistResponse(params: {
  fullText: string;
  usage: { inputTokens?: number; outputTokens?: number } | undefined;
  startTime: number;
  episodeId: string;
  text: string;
  perceivedEmotion: EmotionVector;
  triggers: string[];
  toolCallLog: Array<{ name: string; input: unknown; output: unknown }>;
  recentMessages: Awaited<ReturnType<typeof getMessages>>;
  rlState: number[];
  rlModelLoaded: boolean;
  rlActionId: number;
  rlModelVersion: number | null;
  plan: ReturnType<typeof planExecution>;
  log: ReturnType<typeof logger.context>;
}): Promise<void> {
  const {
    fullText, usage, startTime, episodeId, text, perceivedEmotion, triggers,
    toolCallLog, recentMessages, rlState, rlModelLoaded, rlActionId, rlModelVersion,
    plan, log,
  } = params;

  const durationMs = Date.now() - startTime;
  log.info('chat', `Response finished (${durationMs}ms)`, {
    responseLength: fullText.length,
    responsePreview: fullText.slice(0, 120),
    tokensIn: usage?.inputTokens,
    tokensOut: usage?.outputTokens,
    toolCallsCount: toolCallLog.length,
  });

  // Save companion message
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
    log.error('chat', 'Failed to save companion message', {}, e);
  }

  // Vector memory (background)
  remember({
    episodeId,
    sourceType: 'dialogue',
    text: `User: ${text}\nLia: ${fullText.slice(0, 500)}`,
  }).catch(() => null);

  // Emotional anchor (background)
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

  // RL experience
  try {
    const finalActionId = rlModelLoaded
      ? rlActionId
      : fallbackActionId(fullText, plan.mode as CognitiveMode);
    const rlExperienceId = await recordExperience({
      state: rlState,
      action: finalActionId,
      episodeId,
      policyVersion: rlModelLoaded ? rlModelVersion ?? undefined : undefined,
    });
    log.info('rl', 'Recorded experience', {
      experienceId: rlExperienceId.slice(0, 8),
      action: ACTION_LABELS_RU[finalActionId] ?? finalActionId,
      policyVersion: rlModelLoaded ? rlModelVersion : null,
    });

    // Self-check (background) — корректирует reward если найдены проблемы
    if (shouldSelfCheck(plan)) {
      runSelfCheck({ userMessage: text, liaResponse: fullText, episodeId })
        .then(async (checkResult) => {
          if (checkResult.severity !== 'ok') {
            try {
              const exp = await findLastIncompleteExperience(episodeId);
              if (exp && exp.id === rlExperienceId) {
                const penalty = checkResult.severity === 'major' ? -0.5 : -0.2;
                await db.rLExperience.update({
                  where: { id: rlExperienceId },
                  data: { reward: exp.reward + penalty },
                });
                log.info('chat', 'Self-check adjusted reward', { experienceId: rlExperienceId.slice(0, 8), penalty, severity: checkResult.severity });
              }
            } catch (e) {
              log.warn('chat', 'Self-check reward adjustment failed (non-fatal)', {}, e);
            }
          }
        })
        .catch(e => log.warn('chat', 'Self-check failed (non-fatal)', {}, e));
    }
  } catch (e) {
    log.warn('rl', 'Experience record failed (non-fatal)', {}, e);
  }

  // Fact extraction (background)
  extractAndSaveFacts({ userMessage: text, liaMessage: fullText, episodeId })
    .catch(e => log.warn('chat', 'Fact extraction failed (non-fatal)', {}, e));
}
