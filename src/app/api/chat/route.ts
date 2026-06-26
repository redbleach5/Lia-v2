// POST /api/chat — streaming chat with tools.
//
// Архитектура:
//   1. Сохранить user message
//   2. Построить system prompt (static prefix + dynamic suffix)
//   3. streamText с tools — один LLM-вызов делает всё:
//      решает нужен ли инструмент, вызывает его, продолжает генерацию
//   4. По завершении — сохранить companion message + tool calls
//   5. В фоне: remember (vector memory), autoTitle
//
// ВАЖНО: один streamText заменяет 3-5 LLM-вызовов из LIA v1
// (perceive/decideTool/deliberate/speak/consolidate).

import { streamText, convertToModelMessages, type ModelMessage } from 'ai';
import { NextRequest, NextResponse } from 'next/server';
import { getChatModel } from '@/lib/ollama';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { tools } from '@/lib/tools';
import { db } from '@/lib/db';
import { saveMessage, autoTitleEpisode, getMessages } from '@/lib/memory/episodes';
import { getAllGlobalFacts, formatGlobalFactsForPrompt, getEpisodeFacts, formatEpisodeFactsForPrompt } from '@/lib/memory/facts';
import { recall, remember, formatVectorHitsForPrompt } from '@/lib/memory/vector';
import { listAgentTasks, formatOpenTasksForPrompt } from '@/lib/agent/task';
import { perceive, createInitialEmotion, decayEmotion } from '@/lib/emotion';
import type { EmotionVector } from '@/lib/personality';

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
  const mode: 'fast' | 'standard' | 'agent' = (body?.mode as 'fast' | 'standard' | 'agent') ?? 'standard';

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return NextResponse.json({ error: 'empty message' }, { status: 400 });
  }
  if (text.length > 100_000) {
    return NextResponse.json({ error: 'message too long' }, { status: 413 });
  }
  if (!episodeId) {
    return NextResponse.json({ error: 'episodeId required' }, { status: 400 });
  }

  // Verify episode exists
  const episode = await db.episode.findUnique({ where: { id: episodeId } });
  if (!episode) {
    return NextResponse.json({ error: 'episode not found' }, { status: 404 });
  }

  // ── 1. Perceive emotion (rule-based, no LLM) ──
  const recentMessages = await getMessages(episodeId, 10);
  const lastCompanion = [...recentMessages].reverse().find(m => m.role === 'companion' && m.emotionJson);
  let currentEmotion: EmotionVector = lastCompanion?.emotionJson
    ? safeParseEmotion(lastCompanion.emotionJson) ?? createInitialEmotion()
    : createInitialEmotion();

  const dtMin = Math.min(60, Math.max(0, (Date.now() - episode.updatedAt.getTime()) / 60000));
  currentEmotion = decayEmotion(currentEmotion, dtMin);

  const { emotion: perceivedEmotion, triggers } = perceive(text, currentEmotion);

  // ── 2. Save user message ──
  const userMsg = await saveMessage(episodeId, {
    role: 'user',
    content: text,
    emotionJson: JSON.stringify(perceivedEmotion),
  });

  // Auto-title if needed (fire-and-forget)
  autoTitleEpisode(episodeId, text).catch(() => null);

  // ── 3. Build system prompt ──
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
    mode,
  });

  // ── 4. Build messages array ──
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

  // ── 5. streamText with tools ──
  const maxSteps = mode === 'agent' ? 5 : 1;

  const model = await getChatModel();
  const startTime = Date.now();
  const toolCallLog: Array<{ name: string; input: unknown; output: unknown }> = [];

  const result = streamText({
    model,
    system: systemPrompt,
    messages: convertToModelMessages(coreMessages),
    tools: mode === 'fast' ? undefined : tools,
    maxSteps,
    temperature: 0.7,
    maxTokens: mode === 'agent' ? 2048 : 1024,
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

      // Save dialogue to vector memory (fire-and-forget)
      remember({
        episodeId,
        sourceType: 'dialogue',
        text: `User: ${text}\nLia: ${fullText.slice(0, 500)}`,
      }).catch(() => null);
    },
    onStepFinish: ({ toolCalls, toolResults }) => {
      if (toolCalls) {
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          const tr = toolResults?.[i];
          toolCallLog.push({
            name: tc.toolName,
            input: tc.args,
            output: tr?.result,
          });
        }
      }
    },
  });

  // Plain-text streaming response. Tool calls saved at end via onFinish.
  const stream = result.toTextStreamResult();

  return new Response(stream.textStream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Episode-Id': episodeId,
      'X-Message-Id': userMsg.id,
      'X-Triggers': triggers.join(','),
      'X-Emotion': JSON.stringify(perceivedEmotion),
    },
  });
}

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
