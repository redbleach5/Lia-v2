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

// ============================================================================
// Sidecar config
// ============================================================================
const SIDECAR_URL = process.env.RL_SIDECAR_URL || 'http://127.0.0.1:8765';

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
    console.warn('[rl:inference] No ONNX model found in', SIDECAR_MODELS_DIR);
    return false;
  }

  try {
    // onnxruntime-node needs the model as a Buffer
    const modelBuffer = readFileSync(resolved.path);
    session = await ort.InferenceSession.create(modelBuffer);
    loadedVersion = resolved.version;
    console.log(`[rl:inference] loaded policy v${resolved.version}`);
    return true;
  } catch (e) {
    console.error('[rl:inference] Failed to load ONNX model:', e);
    return false;
  }
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
    console.warn(`[rl:inference] state dim mismatch: expected ${STATE_DIM}, got ${state.length}`);
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
    console.error('[rl:inference] prediction failed:', e);
    return { action: 0, actionName: RL_ACTIONS[0], confidence: 0, value: 0, version: loadedVersion };
  }
}

/**
 * Get the currently active model version.
 */
export function getActiveVersion(): number | null {
  return loadedVersion;
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
async function sidecarFetch(path: string, options?: RequestInit): Promise<Response> {
  const url = `${SIDECAR_URL}${path}`;
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(120_000), // training can take a while
  });
}

export async function getSidecarStats(): Promise<{
  ok: boolean;
  stats?: import('./types').RLStats;
  error?: string;
}> {
  try {
    const res = await sidecarFetch('/stats');
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
    const res = await sidecarFetch('/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        n_epochs: params.nEpochs ?? 10,
        parent_version: params.parentVersion ?? null,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
      return { ok: false, error: err.detail ?? `HTTP ${res.status}` };
    }
    const result = await res.json();
    // Reload model after training
    await reloadModel();
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
