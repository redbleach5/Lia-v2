import 'server-only';

// Loop detector — detects when agent is stuck in a loop.
//
// Three signals:
//   1. Pattern: same tool + same input N times in a row
//   2. Empty results: N consecutive empty/error observations
//   3. Semantic: embeddings of last 3 thoughts too similar (>0.85 cosine)
//
// On any signal → return true, runner should pause and ask user.
//
// ВАЖНО: ошибки LLM (timeout, connection refused, malformed response) НЕ считаются
// "пустым результатом". Это инфраструктурная проблема, не цикл. Если LLM
// таймаутит 2 раза подряд — это не значит что агент "застрял в цикле",
// это значит что LLM слишком медленный или недоступен. В этом случае
// детектор не срабатывает, и агент может попробовать другой шаг.

import { embed } from '@/lib/ollama';

export type Step = {
  thought: string;
  action: string;
  input: unknown;
  observation: string;
};

const PATTERN_LIMIT = 2;       // same tool+input max 2 times
const EMPTY_LIMIT = 3;         // 3 empty observations in a row → exit (increased from 2)
const SEMANTIC_THRESHOLD = 0.85;
const SEMANTIC_WINDOW = 3;     // check last 3 thoughts

export type LoopSignal =
  | { kind: 'pattern'; tool: string; input: unknown; count: number }
  | { kind: 'empty'; count: number }
  | { kind: 'semantic'; similarity: number }
  | null;

// Признаки LLM-ошибок в observation — НЕ считаются "пустым результатом".
// Это инфраструктурные ошибки, не цикл.
const LLM_ERROR_MARKERS = [
  'streamtext timeout',
  'plan generation timeout',
  'synthesize timeout',
  'no output generated',
  'ai_apicallerror',
  'ai_retryerror',
  'ai_nooutputgeneratederror',
  'econnrefused',
  'fetch failed',
  'connect econnrefused',
];

function isLlmError(observation: string): boolean {
  const lower = observation.toLowerCase();
  return LLM_ERROR_MARKERS.some(m => lower.includes(m));
}

export function detectPatternLoop(steps: Step[]): LoopSignal {
  if (steps.length < PATTERN_LIMIT + 1) return null;

  const last = steps[steps.length - 1];
  const actionKey = `${last.action}:${JSON.stringify(last.input)}`;

  let count = 1;
  for (let i = steps.length - 2; i >= 0; i--) {
    const s = steps[i];
    if (`${s.action}:${JSON.stringify(s.input)}` === actionKey) {
      count++;
      if (count > PATTERN_LIMIT) {
        return { kind: 'pattern', tool: last.action, input: last.input, count };
      }
    } else {
      break;
    }
  }
  return null;
}

export function detectEmptyLoop(steps: Step[]): LoopSignal {
  if (steps.length < EMPTY_LIMIT) return null;

  const lastN = steps.slice(-EMPTY_LIMIT);
  let emptyCount = 0;
  for (const s of lastN) {
    const obs = s.observation?.trim() ?? '';

    // Если это LLM-ошибка (timeout, connection) — НЕ считаем пустым результатом.
    // Это инфраструктурная проблема, не цикл.
    if (isLlmError(obs)) {
      // Прерываем подсчёт — LLM-ошибки не должны суммироваться с пустыми результатами.
      return null;
    }

    if (obs.length === 0 || obs.length < 20) {
      emptyCount++;
    }
  }
  if (emptyCount >= EMPTY_LIMIT) {
    return { kind: 'empty', count: emptyCount };
  }
  return null;
}

/**
 * Semantic similarity check — uses embeddings.
 * Skipped if embed fails (non-fatal).
 */
export async function detectSemanticLoop(steps: Step[]): Promise<LoopSignal> {
  if (steps.length < SEMANTIC_WINDOW) return null;

  const recent = steps.slice(-SEMANTIC_WINDOW).map(s => s.thought);
  if (recent.some(t => !t || t.trim().length === 0)) return null;

  try {
    const embeddings = await Promise.all(recent.map(t => embed(t).catch(() => null)));
    if (embeddings.some(e => e === null)) return null;

    // Compare each pair, return max similarity
    let maxSim = 0;
    for (let i = 0; i < embeddings.length; i++) {
      for (let j = i + 1; j < embeddings.length; j++) {
        const sim = cosine(embeddings[i]!, embeddings[j]!);
        if (sim > maxSim) maxSim = sim;
      }
    }
    if (maxSim >= SEMANTIC_THRESHOLD) {
      return { kind: 'semantic', similarity: maxSim };
    }
  } catch {
    return null;
  }
  return null;
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Combined check — runs all three detectors.
 * Returns the first signal found, or null.
 */
export async function detectLoop(steps: Step[]): Promise<LoopSignal> {
  return detectPatternLoop(steps)
    ?? detectEmptyLoop(steps)
    ?? await detectSemanticLoop(steps);
}
