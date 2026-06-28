'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useChatStore, type AgentTask } from '@/stores/chat-store';
import { toast } from 'sonner';

export function useAgent() {
  const setAgentTasks = useChatStore(s => s.setAgentTasks);
  const addAgentTask = useChatStore(s => s.addAgentTask);
  const updateAgentTaskInList = useChatStore(s => s.updateAgentTaskInList);
  const currentEpisodeId = useChatStore(s => s.currentEpisodeId);
  const activeTaskId = useChatStore(s => s.activeTaskId);

  // SSE subscription refs
  const eventSourceRef = useRef<EventSource | null>(null);
  // Счётчик reconnect-попыток. Если SSE падает слишком часто —
  // fallback на polling через /api/agent/[id] каждые 3 сек.
  const reconnectCountRef = useRef(0);
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      const res = await fetch(`/api/agent/${id}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      });

      if (!res.ok) {
        // Распарсиваем ответ чтобы показать пользователю понятную ошибку.
        // Раньше здесь просто тихо глотали ошибку — пользователь не знал,
        // что его ответ не прошёл.
        const err = await res.json().catch(() => ({ error: 'request failed' }));

        if (res.status === 409) {
          // waiting state lost — сервер был перезагружен
          toast.error('Сессия ожидания потеряна. Задача помечена как failed — перезапусти её.');
          // Обновляем store чтобы UI показал failed-статус
          useChatStore.getState().setActiveTaskStatus('failed');
          useChatStore.getState().setActiveTaskError(err.message || 'waiting state lost');
          useChatStore.getState().setActiveTaskQuestion(null);
          updateAgentTaskInList(id, {
            status: 'failed',
            error: err.message || 'waiting state lost',
          });
        } else if (res.status === 400 && err.currentStatus) {
          // задача уже не waiting_input (например уже done или failed)
          toast.error(`Задача уже в статусе "${err.currentStatus}". Ответ не нужен.`);
          useChatStore.getState().setActiveTaskQuestion(null);
        } else {
          toast.error(`Не удалось отправить ответ: ${err.error || res.status}`);
          console.error('[useAgent] input failed:', err);
        }
        return;
      }

      // Успех — убираем вопрос из UI.
      useChatStore.getState().setActiveTaskQuestion(null);
      toast.success('Ответ отправлен, задача продолжается.');
    } catch (e) {
      console.error('[useAgent] input failed:', e);
      toast.error(`Сетевая ошибка: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [updateAgentTaskInList]);

  const selectTask = useCallback((id: string) => {
    useChatStore.getState().setActiveTask(id);
    refresh();
  }, [refresh]);

  // ── SSE subscription for the active task ──
  // Если SSE падает 5+ раз за короткое время — переключаемся на polling,
  // чтобы прогресс задачи всё равно обновлялся.
  useEffect(() => {
    // Cleanup любой предыдущей подписки (SSE или polling).
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    reconnectCountRef.current = 0;

    if (!activeTaskId) return;

    const startPolling = () => {
      console.warn('[agent] SSE failed multiple times, falling back to polling');
      if (pollingIntervalRef.current) clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/agent/${activeTaskId}`);
          if (!res.ok) return;
          const data = await res.json();
          const task = data.task;
          if (!task) return;
          useChatStore.getState().setActiveTaskStatus(task.status);
          if (task.status === 'done') {
            useChatStore.getState().setActiveTaskResult(task.resultSummary);
            updateAgentTaskInList(activeTaskId, {
              status: 'done',
              resultSummary: task.resultSummary,
            });
            if (pollingIntervalRef.current) {
              clearInterval(pollingIntervalRef.current);
              pollingIntervalRef.current = null;
            }
          } else if (task.status === 'failed') {
            useChatStore.getState().setActiveTaskError(task.error ?? 'unknown error');
            updateAgentTaskInList(activeTaskId, {
              status: 'failed',
              error: task.error,
            });
            if (pollingIntervalRef.current) {
              clearInterval(pollingIntervalRef.current);
              pollingIntervalRef.current = null;
            }
          } else if (task.status === 'cancelled') {
            useChatStore.getState().setActiveTaskStatus('cancelled');
            updateAgentTaskInList(activeTaskId, { status: 'cancelled' });
            if (pollingIntervalRef.current) {
              clearInterval(pollingIntervalRef.current);
              pollingIntervalRef.current = null;
            }
          }
        } catch (e) {
          console.warn('[agent] polling error:', e);
        }
      }, 2000);
    };

    const es = new EventSource(`/api/agent/${activeTaskId}/stream`);
    eventSourceRef.current = es;

    const store = useChatStore.getState();

    es.addEventListener('task_init', (e) => {
      try {
        const task = JSON.parse((e as MessageEvent).data);
        store.setActiveTaskStatus(task.status);
        // Если задача уже в финальном состоянии — синхронизируем UI.
        if (task.status === 'failed' && task.error) {
          useChatStore.getState().setActiveTaskError(task.error);
        }
        if (task.status === 'done' && task.resultSummary) {
          useChatStore.getState().setActiveTaskResult(task.resultSummary);
        }
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
      // EventSource пытается reconnect автоматически, но если падает
      // 5+ раз — переходим на polling как более надёжный fallback.
      reconnectCountRef.current += 1;
      if (reconnectCountRef.current >= 5 && !pollingIntervalRef.current) {
        // Закрываем SSE и стартуем polling.
        es.close();
        eventSourceRef.current = null;
        startPolling();
      }
      // Иначе — EventSource сам переподключится со своим backoff.
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, [activeTaskId, updateAgentTaskInList]);

  // Refresh list on mount and when episode changes (debounced)
  useEffect(() => {
    const t = setTimeout(() => { refresh(); }, 100);
    return () => clearTimeout(t);
  }, [refresh, currentEpisodeId]);

  return { refresh, create, cancel, provideInput, selectTask };
}
