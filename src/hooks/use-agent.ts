'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useChatStore, type AgentTask } from '@/stores/chat-store';

export function useAgent() {
  const setAgentTasks = useChatStore(s => s.setAgentTasks);
  const addAgentTask = useChatStore(s => s.addAgentTask);
  const updateAgentTaskInList = useChatStore(s => s.updateAgentTaskInList);
  const currentEpisodeId = useChatStore(s => s.currentEpisodeId);
  const activeTaskId = useChatStore(s => s.activeTaskId);

  // SSE subscription refs
  const eventSourceRef = useRef<EventSource | null>(null);

  const refresh = useCallback(async () => {
    try {
      const state = useChatStore.getState();
      const epId = state.currentEpisodeId;
      const url = epId ? `/api/agent?episodeId=${epId}` : '/api/agent';
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      setAgentTasks((data.tasks ?? []) as AgentTask[]);
    } catch (e) {
      console.error('[useAgent] refresh failed:', e);
    }
  }, [setAgentTasks]);

  const create = useCallback(async (params: {
    goal: string;
    toolsWhitelist?: string[];
    fsScope?: string;
    maxSteps?: number;
    maxDurationSec?: number;
  }): Promise<AgentTask | null> => {
    const state = useChatStore.getState();
    if (!state.currentEpisodeId) return null;
    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...params,
          episodeId: state.currentEpisodeId,
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const task = data.task as AgentTask;
      addAgentTask(task);

      // Auto-subscribe to SSE for the new task
      useChatStore.getState().setActiveTask(task.id);

      return task;
    } catch (e) {
      console.error('[useAgent] create failed:', e);
      return null;
    }
  }, [addAgentTask]);

  const cancel = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/agent/${id}/cancel`, { method: 'POST' });
      if (!res.ok) return;
      const data = await res.json();
      if (data.task) {
        updateAgentTaskInList(id, { status: data.task.status });
      }
    } catch (e) {
      console.error('[useAgent] cancel failed:', e);
    }
  }, [updateAgentTaskInList]);

  const provideInput = useCallback(async (id: string, answer: string) => {
    try {
      await fetch(`/api/agent/${id}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      });
      useChatStore.getState().setActiveTaskQuestion(null);
    } catch (e) {
      console.error('[useAgent] input failed:', e);
    }
  }, []);

  const selectTask = useCallback((id: string) => {
    useChatStore.getState().setActiveTask(id);
    refresh();
  }, [refresh]);

  // ── SSE subscription for the active task ──
  useEffect(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (!activeTaskId) return;

    const es = new EventSource(`/api/agent/${activeTaskId}/stream`);
    eventSourceRef.current = es;

    const store = useChatStore.getState();

    es.addEventListener('task_init', (e) => {
      try {
        const task = JSON.parse((e as MessageEvent).data);
        store.setActiveTaskStatus(task.status);
      } catch { /* */ }
    });

    es.addEventListener('task_planning', () => {
      useChatStore.getState().setActiveTaskStatus('planning');
    });

    es.addEventListener('task_plan_ready', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        useChatStore.getState().setActiveTaskPlan(data.plan);
        useChatStore.getState().setActiveTaskStatus('executing');
      } catch { /* */ }
    });

    es.addEventListener('step_start', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        useChatStore.getState().addActiveTaskStep({
          step: data.step,
          thought: data.thought,
          action: '',
          observation: '',
          ts: data.ts,
        });
      } catch { /* */ }
    });

    es.addEventListener('step_end', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        // Update the step with action + observation + thought
        useChatStore.getState().appendActiveTaskObservation(data.step, data.observation);
        // Note: action and thought are available in data.action / data.thought
        // for future UI enhancement (show action label + thought text)
      } catch { /* */ }
    });

    es.addEventListener('tool_start', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        // Could be visualized as a separate tool bubble within the step
        console.log('[agent sse] tool_start', data);
      } catch { /* */ }
    });

    es.addEventListener('tool_end', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        console.log('[agent sse] tool_end', data);
      } catch { /* */ }
    });

    es.addEventListener('task_waiting_input', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        useChatStore.getState().setActiveTaskStatus('waiting_input');
        useChatStore.getState().setActiveTaskQuestion(data.question);
      } catch { /* */ }
    });

    es.addEventListener('task_synthesizing', () => {
      useChatStore.getState().setActiveTaskStatus('synthesizing');
    });

    es.addEventListener('task_done', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        useChatStore.getState().setActiveTaskStatus('done');
        useChatStore.getState().setActiveTaskResult(data.resultSummary);
        updateAgentTaskInList(activeTaskId, {
          status: 'done',
          resultSummary: data.resultSummary,
        });
      } catch { /* */ }
    });

    es.addEventListener('task_failed', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        useChatStore.getState().setActiveTaskStatus('failed');
        useChatStore.getState().setActiveTaskError(data.error);
        updateAgentTaskInList(activeTaskId, {
          status: 'failed',
          error: data.error,
        });
      } catch { /* */ }
    });

    es.addEventListener('task_cancelled', () => {
      useChatStore.getState().setActiveTaskStatus('cancelled');
      updateAgentTaskInList(activeTaskId, { status: 'cancelled' });
    });

    es.addEventListener('artifact_saved', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        useChatStore.getState().addActiveTaskArtifact({
          filename: data.filename,
          url: data.url,
          step: data.step,
        });
      } catch { /* */ }
    });

    es.onerror = () => {
      // EventSource will auto-reconnect
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [activeTaskId, updateAgentTaskInList]);

  // Refresh list on mount and when episode changes (debounced)
  useEffect(() => {
    const t = setTimeout(() => { refresh(); }, 100);
    return () => clearTimeout(t);
  }, [refresh, currentEpisodeId]);

  return { refresh, create, cancel, provideInput, selectTask };
}
