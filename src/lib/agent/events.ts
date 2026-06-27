// Agent events — singleton EventEmitter для real-time обновлений UI.
//
// Runner эмитит события, SSE-эндпоинт подписывается и стримит клиенту.
// Один emitter на процесс — все активные task runners делят его.

import { EventEmitter } from 'events';

const globalKey = '__lia_agent_events__';

type AgentEventType =
  | 'task_started'
  | 'task_planning'
  | 'task_plan_ready'
  | 'step_start'
  | 'step_end'
  | 'tool_start'
  | 'tool_end'
  | 'task_waiting_input'
  | 'task_synthesizing'
  | 'task_done'
  | 'task_failed'
  | 'task_cancelled'
  | 'artifact_saved';

export type AgentEvent =
  | { type: 'task_started'; taskId: string; goal: string; ts: number }
  | { type: 'task_planning'; taskId: string; ts: number }
  | { type: 'task_plan_ready'; taskId: string; plan: { goal: string; steps: string[]; complexity: string }; ts: number }
  | { type: 'step_start'; taskId: string; step: number; maxSteps: number; thought: string; ts: number }
  | { type: 'step_end'; taskId: string; step: number; action: string; observation: string; durationMs: number; ts: number }
  | { type: 'tool_start'; taskId: string; step: number; tool: string; input: unknown; ts: number }
  | { type: 'tool_end'; taskId: string; step: number; tool: string; success: boolean; output: unknown; ts: number }
  | { type: 'task_waiting_input'; taskId: string; question: string; ts: number }
  | { type: 'task_synthesizing'; taskId: string; ts: number }
  | { type: 'task_done'; taskId: string; resultSummary: string; ts: number }
  | { type: 'task_failed'; taskId: string; error: string; ts: number }
  | { type: 'task_cancelled'; taskId: string; ts: number }
  | { type: 'artifact_saved'; taskId: string; step: number; filename: string; url: string; ts: number };

function getEmitter(): EventEmitter {
  const g = globalThis as unknown as { [key: string]: unknown };
  if (!g[globalKey]) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(100); // many SSE connections possible
    g[globalKey] = emitter;
  }
  return g[globalKey] as EventEmitter;
}

export function emitAgentEvent(event: AgentEvent) {
  const emitter = getEmitter();
  emitter.emit(`task:${event.taskId}`, event);
  emitter.emit('task:*', event); // wildcard for global listeners
}

export function subscribeToTask(taskId: string, listener: (event: AgentEvent) => void): () => void {
  const emitter = getEmitter();
  const channel = `task:${taskId}`;
  emitter.on(channel, listener);
  return () => {
    emitter.off(channel, listener);
  };
}

/**
 * Get all events that have been buffered for a task (for replay on SSE reconnect).
 * Limited to last 100 events per task to bound memory.
 */
const eventBuffer = new Map<string, AgentEvent[]>();
const BUFFER_LIMIT = 100;

export function bufferEvent(event: AgentEvent) {
  const arr = eventBuffer.get(event.taskId) ?? [];
  arr.push(event);
  if (arr.length > BUFFER_LIMIT) arr.shift();
  eventBuffer.set(event.taskId, arr);
}

export function getBufferedEvents(taskId: string): AgentEvent[] {
  return eventBuffer.get(taskId) ?? [];
}

export function clearBuffer(taskId: string) {
  eventBuffer.delete(taskId);
}

// ============================================================================
// Cancellation signals — in-process. Set when user cancels a task.
// ============================================================================
const cancelledTasks = new Set<string>();

export function signalCancellation(taskId: string) {
  cancelledTasks.add(taskId);
}

export function isCancelled(taskId: string): boolean {
  return cancelledTasks.has(taskId);
}

export function clearCancellation(taskId: string) {
  cancelledTasks.delete(taskId);
}

// ============================================================================
// Waiting-for-input signals — when a task calls ask_user, it pauses here
// ============================================================================
type WaitingInput = {
  question: string;
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
};
const waitingTasks = new Map<string, WaitingInput>();

export function setWaiting(taskId: string, w: WaitingInput) {
  waitingTasks.set(taskId, w);
}

export function resolveWaiting(taskId: string, answer: string): boolean {
  const w = waitingTasks.get(taskId);
  if (!w) return false;
  waitingTasks.delete(taskId);
  w.resolve(answer);
  return true;
}

export function cancelWaiting(taskId: string) {
  const w = waitingTasks.get(taskId);
  if (!w) return;
  waitingTasks.delete(taskId);
  w.reject(new Error('cancelled'));
}

export function isWaiting(taskId: string): boolean {
  return waitingTasks.has(taskId);
}
