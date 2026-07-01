import 'server-only';

// RL inference client — loads ONNX model via onnxruntime-node.
//
// Production path:
//   1. Python sidecar trains policy → exports .onnx → saves to python-sidecar/models/
//   2. Next.js loads the .onnx file via onnxruntime-node (no HTTP roundtrip per action)
//   3. predictAction(state) → action + confidence
//
// Fallback: if no ONNX model is available (sidecar not run yet),
// returns action 0 (WAIT) — Lia behaves as if RL is disabled.

import * as ort from 'onnxruntime-node';
import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { PATHS } from '@/lib/paths';
import { RL_ACTIONS, STATE_DIM, type RLActionId } from './types';
import { logger } from '@/lib/logger';

// ============================================================================
// Sidecar config
// ============================================================================
const SIDECAR_URL = process.env.RL_SIDECAR_URL || 'http://127.0.0.1:8765';
const SIDECAR_API_KEY = process.env.LIA_SIDECAR_API_KEY;

// Path to Python sidecar models dir — typically <project>/python-sidecar/models/
const SIDECAR_MODELS_DIR = path.join(PATHS.root, 'python-sidecar', 'models');

// ============================================================================
// Inference session — cached, loaded lazily
// ============================================================================
let session: ort.InferenceSession | null = null;
let loadedVersion: number | null = null;

/**
 * Resolve the ONNX model path for the given version.
 * If version is null, returns the latest available.
 */
function resolveOnnxPath(version: number | null): { path: string; version: number } | null {
  // Try the active version from DB
  if (version === null) {
    // Look for any .onnx file in models dir, pick the highest version
    if (!existsSync(SIDECAR_MODELS_DIR)) return null;
    const files = readdirSync(SIDECAR_MODELS_DIR);
    const versions = files
      .filter(f => /^policy_v\d+\.onnx$/.test(f))
      .map(f => parseInt(f.match(/policy_v(\d+)\.onnx/)![1], 10))
      .sort((a, b) => b - a);
    if (versions.length === 0) return null;
    version = versions[0];
  }

  const onnxPath = path.join(SIDECAR_MODELS_DIR, `policy_v${version}.onnx`);
  if (!existsSync(onnxPath)) return null;
  return { path: onnxPath, version };
}

/**
 * Load the ONNX model (or use cached session).
 * Returns false if no model is available.
 */
async function ensureSession(version: number | null = null): Promise<boolean> {
  if (session && loadedVersion === version) return true;

  const resolved = resolveOnnxPath(version);
  if (!resolved) {
    // Это ожидаемая ситуация: ONNX модель не обучена, пока Python sidecar
    // ни разу не запускали. Fallback heuristic будет использован — это нормально.
    // Логируем как debug без stack trace, чтобы не засорять логи на каждый чат.
    // (Раньше был warn с полным stack — 40 строк шума на каждое сообщение.)
    logger.debug('rl', 'No ONNX model — using fallback heuristic', {
      modelsDir: SIDECAR_MODELS_DIR,
      hint: 'Чтобы включить обучаемый стиль: cd python-sidecar && python main.py, затем Настройки → Обучение → Запустить',
    });
    return false;
  }

  try {
    // onnxruntime-node needs the model as a Buffer.
    // Phase 1 fix: ждём, пока файл стабилизируется (размер не меняется 500мс),
    // чтобы не прочитать partially-written .onnx после atomic rename из Python.
    await waitForStableFile(resolved.path, 500);
    const modelBuffer = readFileSync(resolved.path);
    session = await ort.InferenceSession.create(modelBuffer);
    loadedVersion = resolved.version;
    logger.info('rl', `Loaded policy v${resolved.version}`);
    return true;
  } catch (e) {
    logger.error('rl', 'Failed to load ONNX model', {}, e);
    session = null;
    loadedVersion = null;
    return false;
  }
}

/**
 * Подождать, пока файл стабилизируется (размер не меняется в течение `stableMs`).
 * Решает race condition: Python sidecar пишет .onnx через .tmp + rename,
 * но если Next.js вызовет reloadModel() сразу после train, может попасть
 * на момент сразу после rename, когда файл ещё дозаписывается.
 *
 * Таймаут 5s — если файл не стабилизируется, читаем как есть (best effort).
 */
async function waitForStableFile(filePath: string, stableMs: number): Promise<void> {
  const deadline = Date.now() + 5000;
  let lastSize = -1;
  let lastSizeTime = Date.now();
  while (Date.now() < deadline) {
    try {
      const stat = await import('fs/promises').then(m => m.stat(filePath));
      if (stat.size === lastSize) {
        if (Date.now() - lastSizeTime >= stableMs) return; // стабильно
      } else {
        lastSize = stat.size;
        lastSizeTime = Date.now();
      }
    } catch {
      // Файл ещё не существует — подождём
    }
    await new Promise(r => setTimeout(r, 100));
  }
  // Таймаут — читаем как есть
  logger.warn('rl', 'ONNX file did not stabilize in 5s, loading anyway', { path: filePath });
}

// ============================================================================
// Public API
// ============================================================================
export type RLPrediction = {
  action: RLActionId;
  actionName: string;
  confidence: number;
  value: number;
  version: number | null;
};

/**
 * Run inference — predict the best action for the given state.
 *
 * Returns action 0 (WAIT) with confidence 0 if no model is loaded.
 */
export async function predictAction(state: number[], version: number | null = null): Promise<RLPrediction> {
  if (state.length !== STATE_DIM) {
    logger.warn('rl', `State dim mismatch`, { expected: STATE_DIM, got: state.length });
    return { action: 0, actionName: RL_ACTIONS[0], confidence: 0, value: 0, version: null };
  }

  const hasModel = await ensureSession(version);
  if (!hasModel || !session) {
    return { action: 0, actionName: RL_ACTIONS[0], confidence: 0, value: 0, version: null };
  }

  try {
    const inputName = session.inputNames[0]; // 'state'
    const input = new ort.Tensor('float32', Float32Array.from(state), [1, STATE_DIM]);
    const outputs = await session.run({ [inputName]: input });

    // Get action_logits and state_value
    const logitsOutput = outputs[session.outputNames[0]]; // action_logits
    const valueOutput = outputs[session.outputNames[1]]; // state_value

    const logits = Array.from(logitsOutput.data as Float32Array);

    // Softmax to get probabilities
    const maxLogit = Math.max(...logits);
    const expLogits = logits.map(l => Math.exp(l - maxLogit));
    const sumExp = expLogits.reduce((a, b) => a + b, 0);
    const probs = expLogits.map(e => e / sumExp);

    // Argmax
    let maxIdx = 0;
    let maxProb = probs[0];
    for (let i = 1; i < probs.length; i++) {
      if (probs[i] > maxProb) {
        maxProb = probs[i];
        maxIdx = i;
      }
    }

    return {
      action: maxIdx,
      actionName: RL_ACTIONS[maxIdx] ?? `ACTION_${maxIdx}`,
      confidence: maxProb,
      value: valueOutput ? (valueOutput.data as Float32Array)[0] : 0,
      version: loadedVersion,
    };
  } catch (e) {
    // Phase 1 fix: при ошибке inference возвращаем version: null, а не loadedVersion.
    // Раньше это приводило к багу: rlModelLoaded в chat route был true даже при ошибке,
    // fallback heuristic не запускался.
    logger.error('rl', 'prediction failed', {}, e);
    return { action: 0, actionName: RL_ACTIONS[0], confidence: 0, value: 0, version: null };
  }
}

/**
 * Force reload the model (e.g., after training a new version).
 */
export async function reloadModel(version: number | null = null): Promise<boolean> {
  session = null;
  loadedVersion = null;
  return ensureSession(version);
}

// ============================================================================
// Sidecar HTTP client — for training/stats (not for per-action inference)
// ============================================================================
// Phase 1 fixes:
//   1. Configurable timeout: 30s для stats, 300s для train (раньше 120s для всего,
//      что приводило к timeout при обучении, хотя сам train на sidecar продолжался).
//   2. X-Sidecar-Key header для auth (см. python-sidecar/main.py auth middleware).
async function sidecarFetch(
  urlPath: string,
  options: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  const url = `${SIDECAR_URL}${urlPath}`;
  const headers = new Headers(options.headers);
  if (SIDECAR_API_KEY) {
    headers.set('X-Sidecar-Key', SIDECAR_API_KEY);
  }
  return fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function getSidecarStats(): Promise<{
  ok: boolean;
  stats?: import('./types').RLStats;
  error?: string;
}> {
  try {
    // /stats — быстрый endpoint, 30s таймаут достаточно.
    const res = await sidecarFetch('/stats', {}, 30_000);
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const stats = await res.json();
    return { ok: true, stats };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function trainSidecar(params: {
  nEpochs?: number;
  parentVersion?: number;
}): Promise<{
  ok: boolean;
  result?: import('./types').TrainResult;
  error?: string;
}> {
  try {
    // /train — долгий endpoint (PPO обучение), 300s таймаут.
    // Соответствует maxDuration = 300 в rl/train/route.ts.
    const res = await sidecarFetch('/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        n_epochs: params.nEpochs ?? 10,
        parent_version: params.parentVersion ?? null,
      }),
    }, 300_000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
      return { ok: false, error: err.detail ?? `HTTP ${res.status}` };
    }
    const result = await res.json();
    // Reload model after training — ждёт стабилизации файла (см. waitForStableFile).
    await reloadModel();
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
