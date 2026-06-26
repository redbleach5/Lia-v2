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

import { streamText, type ModelMessage } from 'ai';
import { NextRequest, NextResponse } from 'next/server';
import { getChatModel } from '@/lib/ollama';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { tools } from '@/lib/tools';
import { db } from '@/lib/db';
import { saveMessage, autoTitleEpisode, getMessages } from '@/lib/memory/episodes';
import { getAllGlobalFacts, formatGlobalFactsForPrompt, getEpisodeFacts, formatEpisodeFactsForPrompt } from '@/lib/memory/facts';
import { recall, remember, formatVectorHitsForPrompt } from '@/lib/memory/vector';
import { listAgentTasks, formatOpenTasksForPrompt } from '@/lib/agent/task';
import { perceive, createInitialEmotion, decayEmotion, dominantEmotion } from '@/lib/emotion';
import type { EmotionVector } from '@/lib/personality';
import { buildRLState } from '@/lib/rl/types';
import { recordExperience } from '@/lib/rl/recorder';
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

  // ── 5. Save user message ──
  const userMsg = await saveMessage(episodeId, {
    role: 'user',
    content: text,
    emotionJson: JSON.stringify(perceivedEmotion),
  });
  autoTitleEpisode(episodeId, text).catch(() => null);

  // ── 6. Build context ──
  const [globalFacts, episodeFacts, vectorHits, agentTasks] = await Promise.all([
    getAllGlobalFacts(),
    getEpisodeFacts(episodeId),
    recall({ episodeId, query: text, limit: 3, minSimilarity: 0.35 }),
    listAgentTasks(episodeId),
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

  const result = streamText({
    model,
    system: systemPrompt + (deliberateContext ? `\n\nВНУТРЕННИЙ АНАЛИЗ:\n${deliberateContext}` : ''),
    messages: coreMessages,
    tools: plan.toolsEnabled ? tools : undefined,
    maxSteps: userMode === 'agent' ? 5 : 1,
    temperature: 0.7,
    maxTokens: plan.maxTokens,
    topP: 0.9,
    onFinish: async ({ text: fullText, usage }) => {
      const durationMs = Date.now() - startTime;

      try {
        await saveMessage(episodeId, {
          role: 'companion',
          content: fullText,
          emotionJson: JSON.stringify(perceivedEmotion),
          toolCallsJson: toolCallLog.length > 0 ? JSON.stringify(toolCallLog) : null,
          tokensIn: usage?.promptTokens ?? null,
          tokensOut: usage?.completionTokens ?? null,
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

      // RL experience
      try {
        const rlAction = classifyResponseAction(fullText, userMode);
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
        await recordExperience({ state: rlState, action: rlAction, episodeId });
      } catch (e) {
        console.warn('[api/chat] RL experience record failed (non-fatal):', e);
      }
    },
    onStepFinish: ({ toolCalls: tcs, toolResults: trs }) => {
      if (tcs) {
        for (let i = 0; i < tcs.length; i++) {
          const tc = tcs[i];
          const tr = trs?.[i];
          toolCallLog.push({
            name: tc.toolName,
            input: tc.args,
            output: tr?.result,
          });
        }
      }
    },
  });

  // ── 11. Response with metadata in headers ──
  return result.toTextStreamResponse({
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Episode-Id': episodeId,
      'X-Message-Id': userMsg.id,
      'X-Triggers': triggers.join(','),
      'X-Emotion': JSON.stringify(perceivedEmotion),
      'X-Tier': tier,
      'X-Complexity': complexity,
      'X-Mode': plan.mode,
      'X-Calls': String(plan.calls),
      'X-Deliberate': String(plan.deliberate),
      'X-SelfCheck': String(plan.selfCheck),
      'X-ModelSize': String(profile?.modelSize ?? 0),
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
      maxTokens: 400,
    });
    return await result.text;
  } catch (e) {
    console.warn('[chat] deliberate failed:', e);
    return '';
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

function classifyResponseAction(response: string, mode: string): number {
  const trimmed = response.trim();
  const len = trimmed.length;
  const lower = trimmed.toLowerCase();

  if (mode === 'agent') return 2;
  if (len < 100) return 7;
  if (len > 800) return 8;
  if (lower.includes('?') || /\b(а ты|как ты|что ты|расскажи о себе)\b/i.test(lower)) return 3;
  if (/\b(рада|скучала|хорошо|милая|тепло|обнимаю)\b/i.test(lower)) return 1;
  if (/\b(могу помочь|хочешь я|давай я|помочь с)\b/i.test(lower)) return 4;
  if (/\b(я подумала|мне кажется|знаешь что|я тут подумала)\b/i.test(lower)) return 5;
  if (/\b(шучу|ха-ха|смеюсь|прикол|забавно)\b/i.test(lower)) return 6;
  return 2;
}
