import 'server-only';

// ============================================================================
// API validation — zod schemas + helper для всех POST endpoints.
// ============================================================================
//
// До Phase 3: каждый route делал ad-hoc `typeof body?.foo === 'string'` проверки.
// После: единый `parseBody(req, schema)` с типизированным результатом.
//
// Преимущества:
//   - Типобезопасность: результат `parseBody` имеет тип выводимый из schema
//   - Единый формат ошибок: { error: string, details?: z.ZodError['issues'] }
//   - Нет дублирования логики валидации в каждом route
//   - Zod уже в deps (используется в tool definitions)

import { NextRequest, NextResponse } from 'next/server';
import { z, type ZodType } from 'zod';

/**
 * Распарсить body запроса через zod schema.
 * Возвращает { success: true, data } или { success: false, response }.
 *
 * Использование:
 *   const result = await parseBody(req, chatRequestSchema);
 *   if (!result.success) return result.response;
 *   const { text, episodeId, mode } = result.data;
 */
export async function parseBody<T>(
  req: NextRequest,
  schema: ZodType<T>,
): Promise<
  | { success: true; data: T }
  | { success: false; response: NextResponse }
> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return {
      success: false,
      response: NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }),
    };
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    return {
      success: false,
      response: NextResponse.json(
        {
          error: 'validation failed',
          details: result.error.issues.map(i => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        { status: 400 },
      ),
    };
  }

  return { success: true, data: result.data };
}

// ============================================================================
// Schemas — по одной на каждый POST endpoint с body.
// ============================================================================

// POST /api/chat
export const chatRequestSchema = z.object({
  text: z.string().min(1, 'empty message').max(100_000, 'message too long'),
  episodeId: z.string().min(1, 'episodeId required'),
  mode: z.enum(['auto', 'fast', 'standard', 'deep', 'agent']).default('auto'),
});

// POST /api/agent (create task)
export const createAgentTaskSchema = z.object({
  episodeId: z.string().min(1),
  goal: z.string().min(1).max(10_000),
  autoStart: z.boolean().default(true),
  fsScope: z.string().nullable().optional(),
  toolsWhitelist: z.array(z.string()).nullable().optional(),
  maxSteps: z.number().int().min(1).max(100).nullable().optional(),
  maxDurationSec: z.number().int().min(60).max(86400).nullable().optional(),
});

// POST /api/agent/[id]/input
export const agentInputSchema = z.object({
  answer: z.string().min(1, 'answer required'),
});

// POST /api/episodes (create)
export const createEpisodeSchema = z.object({
  title: z.string().max(200).optional(),
});

// PATCH /api/episodes/[id]
export const updateEpisodeSchema = z.object({
  title: z.string().max(200).optional(),
});

// POST /api/settings
// AvatarConfig — complex nested, валидируется через parseAvatarConfig в route.
// Здесь валидируем только top-level поля (все optional — partial update).
export const updateSettingsSchema = z.object({
  baseUrl: z.string().url().optional(),
  model: z.string().optional(),
  embedModel: z.string().optional(),
  avatarMode: z.enum(['live2d', '3d']).optional(),
  activeVrm: z.string().nullable().optional(),
  avatarConfig: z.record(z.string(), z.unknown()).optional(),
  // Groq settings (Phase: Groq support)
  provider: z.enum(['ollama', 'groq']).optional(),
  groqApiKey: z.string().optional(),
  groqModel: z.string().optional(),
});

// POST /api/rl/train
export const rlTrainSchema = z.object({
  nEpochs: z.number().int().min(1).max(100).default(10),
});

// POST /api/rl/activate
export const rlActivateSchema = z.object({
  version: z.number().int().min(1),
});
