import 'server-only';

// LLM provider — Ollama (local) или Groq (cloud, для тестирования).
//
// AI SDK gives us:
//   - streamText with tool calling (one LLM call does decideTool + speak + execute)
//   - automatic retry on rate limits
//   - prefix caching (Ollama's KV-cache)
//   - structured outputs via Zod schemas
//
// Groq: https://api.groq.com/openai/v1 — OpenAI-compatible, fast inference.
// Embeddings ВСЕГДА через Ollama (у Groq нет embedding-моделей).

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { db } from './db';
import { logger } from './logger';

// ============================================================================
// Settings persistence — load from DB on first call.
// ============================================================================

const DEFAULT_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const DEFAULT_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

// LLM provider: 'ollama' (default) или 'groq'
let currentProvider: 'ollama' | 'groq' = 'ollama';

// Groq settings
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
let currentGroqApiKey = process.env.GROQ_API_KEY || '';
let currentGroqModel = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// Groq available models (hardcoded — Groq has a fixed catalog)
// supportsTools: только llama-3.x и mixtral поддерживают function calling.
export const GROQ_MODELS = [
  { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', desc: 'Самый умный, поддерживает tools' },
  { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B', desc: 'Быстрый, поддерживает tools' },
  { id: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B', desc: 'MoE, 32K context, поддерживает tools' },
  { id: 'gemma2-9b-it', label: 'Gemma 2 9B', desc: 'Google, без tools (только текст)' },
  { id: 'llama-3.2-3b-preview', label: 'Llama 3.2 3B', desc: 'Быстрый, без tools' },
  { id: 'llama-3.2-1b-preview', label: 'Llama 3.2 1B', desc: 'Молниеносный, без tools' },
];

let currentBaseUrl = DEFAULT_BASE_URL;
let currentModel = DEFAULT_MODEL;
let currentEmbedModel = DEFAULT_EMBED_MODEL;
let settingsLoaded = false;
let settingsLoadPromise: Promise<void> | null = null;

async function loadSettings(): Promise<void> {
  if (settingsLoaded) return;
  if (settingsLoadPromise) return settingsLoadPromise;

  settingsLoadPromise = (async () => {
    try {
      const rows = await db.setting.findMany();
      let changed = false;
      for (const row of rows) {
        if (row.key === 'ollama_base_url' && currentBaseUrl !== row.value) {
          currentBaseUrl = row.value;
          changed = true;
        } else if (row.key === 'ollama_model' && currentModel !== row.value) {
          currentModel = row.value;
          changed = true;
        } else if (row.key === 'ollama_embed_model' && currentEmbedModel !== row.value) {
          currentEmbedModel = row.value;
          changed = true;
        } else if (row.key === 'llm_provider') {
          currentProvider = row.value === 'groq' ? 'groq' : 'ollama';
          changed = true;
        } else if (row.key === 'groq_api_key' && currentGroqApiKey !== row.value) {
          currentGroqApiKey = row.value;
          changed = true;
        } else if (row.key === 'groq_model' && currentGroqModel !== row.value) {
          currentGroqModel = row.value;
          changed = true;
        }
      }
      settingsLoaded = true;
      if (changed) {
        logger.debug('llm', 'Settings loaded from DB', {
          provider: currentProvider,
          baseUrl: currentBaseUrl,
          model: currentModel,
          embedModel: currentEmbedModel || 'auto',
          groqModel: currentGroqModel,
          groqKeySet: !!currentGroqApiKey,
        });
      }
    } catch (e) {
      logger.warn('llm', 'Failed to load settings — using env defaults', {
        baseUrl: currentBaseUrl,
        model: currentModel,
      }, e);
      settingsLoaded = true; // don't retry forever
    } finally {
      settingsLoadPromise = null;
    }
  })();

  return settingsLoadPromise;
}

/**
 * Принудительно перечитать настройки из БД.
 * Полезно когда внешний процесс (или другой запрос) изменил настройки,
 * а текущий in-memory кэш устарел.
 */
export async function reloadSettings(): Promise<void> {
  settingsLoaded = false;
  healthCache = null;
  await loadSettings();
}

export async function getOllamaSettings() {
  await loadSettings();
  return {
    baseUrl: currentBaseUrl,
    model: currentModel,
    embedModel: currentEmbedModel || 'auto',
    provider: currentProvider,
    groqApiKey: currentGroqApiKey ? '***set***' : '',
    groqModel: currentGroqModel,
  };
}

export async function setOllamaSettings(params: {
  baseUrl?: string;
  model?: string;
  embedModel?: string;
  provider?: 'ollama' | 'groq';
  groqApiKey?: string;
  groqModel?: string;
}) {
  settingsLoaded = true;

  if (params.baseUrl !== undefined) {
    currentBaseUrl = params.baseUrl.replace(/\/$/, '');
    await db.setting.upsert({
      where: { key: 'ollama_base_url' },
      create: { key: 'ollama_base_url', value: currentBaseUrl },
      update: { value: currentBaseUrl },
    });
    provider = null;
    providerBaseUrl = '';
  }
  if (params.model !== undefined) {
    currentModel = params.model;
    await db.setting.upsert({
      where: { key: 'ollama_model' },
      create: { key: 'ollama_model', value: currentModel },
      update: { value: currentModel },
    });
  }
  if (params.embedModel !== undefined) {
    currentEmbedModel = params.embedModel;
    if (params.embedModel === '') {
      await db.setting.deleteMany({ where: { key: 'ollama_embed_model' } });
    } else {
      await db.setting.upsert({
        where: { key: 'ollama_embed_model' },
        create: { key: 'ollama_embed_model', value: currentEmbedModel },
        update: { value: currentEmbedModel },
      });
    }
  }
  if (params.provider !== undefined) {
    currentProvider = params.provider;
    await db.setting.upsert({
      where: { key: 'llm_provider' },
      create: { key: 'llm_provider', value: currentProvider },
      update: { value: currentProvider },
    });
    // Инвалидируем провайдер при переключении
    provider = null;
    providerBaseUrl = '';
    groqProvider = null;
  }
  if (params.groqApiKey !== undefined) {
    currentGroqApiKey = params.groqApiKey;
    if (params.groqApiKey === '') {
      await db.setting.deleteMany({ where: { key: 'groq_api_key' } });
    } else {
      await db.setting.upsert({
        where: { key: 'groq_api_key' },
        create: { key: 'groq_api_key', value: currentGroqApiKey },
        update: { value: currentGroqApiKey },
      });
    }
    groqProvider = null;  // пересоздать с новым ключом
  }
  if (params.groqModel !== undefined) {
    currentGroqModel = params.groqModel;
    await db.setting.upsert({
      where: { key: 'groq_model' },
      create: { key: 'groq_model', value: currentGroqModel },
      update: { value: currentGroqModel },
    });
  }
  healthCache = null;
}

// ============================================================================
// AI SDK providers — Ollama (local) и Groq (cloud)
// ============================================================================

let provider: ReturnType<typeof createOpenAICompatible> | null = null;
let providerBaseUrl = '';

let groqProvider: ReturnType<typeof createOpenAICompatible> | null = null;

async function getOllamaProvider() {
  await loadSettings();
  if (provider && providerBaseUrl === currentBaseUrl) return provider;
  provider = createOpenAICompatible({
    name: 'ollama',
    baseURL: `${currentBaseUrl}/v1`,
    apiKey: 'ollama',
  });
  providerBaseUrl = currentBaseUrl;
  return provider;
}

async function getGroqProvider() {
  await loadSettings();
  if (groqProvider) return groqProvider;
  if (!currentGroqApiKey) {
    throw new Error('Groq API key не задан. Открой Настройки → Модель → Groq и введи ключ.');
  }
  groqProvider = createOpenAICompatible({
    name: 'groq',
    baseURL: GROQ_BASE_URL,
    apiKey: currentGroqApiKey,
  });
  return groqProvider;
}

/**
 * Returns the model object for use with AI SDK's streamText/generateText.
 *
 * Если provider='groq' — возвращает Groq модель (быстрый cloud inference).
 * Если provider='ollama' — возвращает Ollama модель (local, с health check + fallback).
 */
export async function getChatModel() {
  await loadSettings();

  // ── Groq provider ──
  if (currentProvider === 'groq') {
    const p = await getGroqProvider();
    logger.debug('llm', `Using Groq model: ${currentGroqModel}`);
    return p.chatModel(currentGroqModel);
  }

  // ── Ollama provider (default) ──
  const p = await getOllamaProvider();
  const health = await checkOllamaHealth();
  if (health.ok && health.models.length > 0) {
    const exactMatch = health.models.find(m => m === currentModel);
    if (exactMatch) {
      logger.debug('llm', `Using configured model: ${currentModel}`);
      return p.chatModel(currentModel);
    }
    const partialMatch = health.models.find(m =>
      m.startsWith(currentModel.split(':')[0]) ||
      m.startsWith(currentModel) ||
      currentModel.startsWith(m.split(':')[0])
    );
    if (partialMatch) {
      logger.warn('llm', `Model not found, using partial match`, {
        requested: currentModel,
        using: partialMatch,
      });
      return p.chatModel(partialMatch);
    }
    const fallback = health.models[0];
    logger.warn('llm', `Model not found, using first available`, {
      requested: currentModel,
      using: fallback,
      allModels: health.models.slice(0, 5),
    });
    return p.chatModel(fallback);
  }

  logger.warn('llm', `Health check failed — using configured model anyway (will likely 404)`, { model: currentModel });
  return p.chatModel(currentModel);
}

/**
 * Возвращает имя текущей модели (для логирования и NO_TOOL_MODELS check).
 */
export async function getModelName(): Promise<string> {
  await loadSettings();
  return currentProvider === 'groq' ? currentGroqModel : currentModel;
}

/**
 * Возвращает текущего провайдера ('ollama' | 'groq').
 * Используется в agent runner pre-flight check.
 */
export async function getProvider(): Promise<'ollama' | 'groq'> {
  await loadSettings();
  return currentProvider;
}

/**
 * Возвращает Groq API key (или пустую строку если не задан).
 * Используется в agent runner pre-flight check.
 */
export async function getGroqApiKey(): Promise<string> {
  await loadSettings();
  return currentGroqApiKey;
}

// ============================================================================
// Embeddings — direct HTTP to Ollama
// ============================================================================
//
// Embed model is auto-detected from available models — user doesn't need to
// choose. We look for known embed model prefixes (nomic-embed, mxbai-embed,
// bge-m3, snowflake-arctic-embed). If none found, we try the configured one
// (default 'nomic-embed-text') and surface a clear error if it's missing.

const EMBED_MODEL_PREFIXES = [
  'nomic-embed-text',
  'mxbai-embed-large',
  'bge-m3',
  'snowflake-arctic-embed',
];

function pickEmbedModelFromList(available: string[]): string | null {
  for (const prefix of EMBED_MODEL_PREFIXES) {
    const match = available.find(m => m.startsWith(prefix));
    if (match) return match;
  }
  return null;
}

export async function embed(text: string): Promise<Float32Array> {
  await loadSettings();
  const embedStart = Date.now();

  // Auto-detect embed model if the current one isn't in the available list
  // OR if it's empty (user selected "auto" in UI)
  let modelToUse = currentEmbedModel;
  const health = await checkOllamaHealth();
  if (health.ok && health.models.length > 0) {
    const exactMatch = health.models.find(m => m === currentEmbedModel);
    if (!exactMatch) {
      const detected = pickEmbedModelFromList(health.models);
      if (detected) {
        modelToUse = detected;
        // Persist the auto-detected choice so we don't re-detect every call
        if (detected !== currentEmbedModel) {
          logger.info('ollama', `Auto-detected embed model: ${detected}`);
          currentEmbedModel = detected;
          // Save to DB so we don't re-detect every call
          try {
            await db.setting.upsert({
              where: { key: 'ollama_embed_model' },
              create: { key: 'ollama_embed_model', value: detected },
              update: { value: detected },
            });
          } catch { /* non-fatal */ }
        }
      } else if (!currentEmbedModel) {
        // No embed model configured AND none detected — throw clear error
        logger.error('ollama', 'No embed model available — throwing clear error', {
          availableModels: health.models.slice(0, 5),
        });
        throw new Error(
          'Не настроена модель для памяти. Скачай nomic-embed-text: ollama pull nomic-embed-text, ' +
          'или выбери модель в Настройках → Модель → Модель для памяти.'
        );
      }
    }
  }

  if (!modelToUse) {
    throw new Error(
      'Модель для памяти не выбрана. Открой Настройки → Модель и выбери embed-модель (или режим Авто).'
    );
  }

  try {
    const res = await fetch(`${currentBaseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelToUse, input: text }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      logger.error('ollama', `Embed HTTP error`, {
        status: res.status,
        model: modelToUse,
        textLength: text.length,
        responsePreview: t.slice(0, 200),
      });
      throw new Error(`Ollama embed HTTP ${res.status}: ${t}`);
    }
    const data = await res.json();
    const vec = data?.embeddings?.[0] ?? data?.embedding;
    if (!Array.isArray(vec)) {
      logger.error('ollama', 'Embed returned no vector', { model: modelToUse, responseKeys: Object.keys(data ?? {}) });
      throw new Error('Ollama embed returned no vector');
    }
    logger.debug('ollama', `Embed done (${Date.now() - embedStart}ms)`, {
      model: modelToUse,
      dims: vec.length,
      textLength: text.length,
    });
    return new Float32Array(vec);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Ollama embed HTTP')) throw e;
    // ECONNREFUSED — Ollama не запущен. Это ожидаемая ситуация при первом
    // запуске или когда пользователь использует только Groq. Логируем как
    // warn без полного stack trace, чтобы не засорять логи.
    const isConnRefused = e instanceof Error && (e.message.includes('ECONNREFUSED') || e.message.includes('fetch failed'));
    if (isConnRefused) {
      logger.warn('ollama', 'Embed skipped — Ollama not reachable', {
        model: modelToUse,
        baseUrl: currentBaseUrl,
      });
    } else {
      logger.error('ollama', 'Embed fetch failed', { model: modelToUse }, e);
    }
    throw e;
  }
}

// ============================================================================
// Health check
// ============================================================================
let healthCache: { ok: boolean; models: string[]; error?: string; ts: number } | null = null;
const HEALTH_TTL = 30_000;

export async function checkOllamaHealth(): Promise<{ ok: boolean; models: string[]; error?: string }> {
  if (healthCache && Date.now() - healthCache.ts < HEALTH_TTL) {
    return healthCache;
  }
  await loadSettings();
  try {
    const res = await fetch(`${currentBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const result = { ok: false, models: [] as string[], error: `HTTP ${res.status}` };
      healthCache = { ...result, ts: Date.now() };
      return result;
    }
    const data = await res.json();
    const models = (data.models ?? []).map((m: { name: string }) => m.name);
    const result = { ok: true as const, models, error: undefined };
    healthCache = { ...result, ts: Date.now() };
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const result = { ok: false, models: [] as string[], error: msg };
    healthCache = { ...result, ts: Date.now() };
    return result;
  }
}
