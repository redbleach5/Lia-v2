import 'server-only';

// Ollama client via @ai-sdk/openai-compatible.
//
// AI SDK gives us:
//   - streamText with tool calling (one LLM call does decideTool + speak + execute)
//   - automatic retry on rate limits
//   - prefix caching (Ollama's KV-cache)
//   - structured outputs via Zod schemas
//
// We expose a single `model` object that AI SDK functions accept.

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { db } from './db';
import { logger } from './logger';

// ============================================================================
// Settings persistence — load Ollama URL/model from DB on first call.
// ============================================================================

const DEFAULT_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const DEFAULT_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

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
        }
      }
      settingsLoaded = true;
      if (changed) {
        logger.debug('ollama', 'Settings loaded from DB', {
          baseUrl: currentBaseUrl,
          model: currentModel,
          embedModel: currentEmbedModel || 'auto',
        });
      }
    } catch (e) {
      logger.warn('ollama', 'Failed to load settings — using env defaults', {
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
  };
}

export async function setOllamaSettings(params: {
  baseUrl?: string;
  model?: string;
  embedModel?: string;
}) {
  // Помечаем что настройки загружены — иначе параллельный loadSettings()
  // может перезаписать только что сохранённые значения дефолтами из env.
  settingsLoaded = true;

  if (params.baseUrl !== undefined) {
    currentBaseUrl = params.baseUrl.replace(/\/$/, '');
    await db.setting.upsert({
      where: { key: 'ollama_base_url' },
      create: { key: 'ollama_base_url', value: currentBaseUrl },
      update: { value: currentBaseUrl },
    });
    // Инвалидируем кэш провайдера — новый URL требует пересоздания.
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
    // Empty string means "auto" — clear the stored value so embed() will auto-detect
    currentEmbedModel = params.embedModel;
    if (params.embedModel === '') {
      await db.setting.delete({ where: { key: 'ollama_embed_model' } }).catch(() => null);
    } else {
      await db.setting.upsert({
        where: { key: 'ollama_embed_model' },
        create: { key: 'ollama_embed_model', value: currentEmbedModel },
        update: { value: currentEmbedModel },
      });
    }
  }
  // ВСЕГДА инвалидируем health cache при смене настроек, чтобы UI и pre-flight
  // проверки видели актуальное состояние, а не 30-секундный кэш.
  healthCache = null;
}

// ============================================================================
// AI SDK provider — OpenAI-compatible, points at Ollama
// ============================================================================
//
// Ollama exposes /v1/chat/completions (OpenAI compat) and /v1/embeddings.

let provider: ReturnType<typeof createOpenAICompatible> | null = null;
let providerBaseUrl = '';

async function getProvider() {
  await loadSettings();
  if (provider && providerBaseUrl === currentBaseUrl) return provider;
  provider = createOpenAICompatible({
    name: 'ollama',
    baseURL: `${currentBaseUrl}/v1`,
    apiKey: 'ollama', // Ollama doesn't need a key, but AI SDK requires the field
  });
  providerBaseUrl = currentBaseUrl;
  return provider;
}

/**
 * Returns the model object for use with AI SDK's streamText/generateText.
 *
 * If the configured model is not available in Ollama, falls back to the
 * first available model and warns the user.
 */
export async function getChatModel() {
  const p = await getProvider();

  // Check if the configured model exists in Ollama
  const health = await checkOllamaHealth();
  if (health.ok && health.models.length > 0) {
    const exactMatch = health.models.find(m => m === currentModel);
    if (exactMatch) {
      logger.debug('ollama', `Using configured model: ${currentModel}`);
      return p.chatModel(currentModel);
    }

    // Try partial match (qwen2.5:7b matches qwen2.5:7b-instruct-q5_K_M etc.)
    const partialMatch = health.models.find(m =>
      m.startsWith(currentModel.split(':')[0]) ||
      m.startsWith(currentModel) ||
      currentModel.startsWith(m.split(':')[0])
    );

    if (partialMatch) {
      logger.warn('ollama', `Model not found, using partial match`, {
        requested: currentModel,
        using: partialMatch,
      });
      return p.chatModel(partialMatch);
    }

    // Fall back to first available
    const fallback = health.models[0];
    logger.warn('ollama', `Model not found, using first available`, {
      requested: currentModel,
      using: fallback,
      allModels: health.models.slice(0, 5),
    });
    return p.chatModel(fallback);
  }

  // Health check failed — try the configured model anyway (will likely 404)
  logger.warn('ollama', `Health check failed — using configured model anyway (will likely 404)`, { model: currentModel });
  return p.chatModel(currentModel);
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
    logger.error('ollama', 'Embed fetch failed', { model: modelToUse }, e);
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
