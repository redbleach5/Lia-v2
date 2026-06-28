'use client';

// Chat hook — wraps the /api/chat streaming endpoint.
//
// Streaming protocol (plain text):
//   - Body is a stream of UTF-8 text chunks
//   - Response headers carry metadata: X-Message-Id, X-Triggers, X-Emotion
//   - No delimiter in body — stream ends when response closes
//
// For agent mode: instead of streaming chat, creates an AgentTask via /api/agent
// and the UI subscribes to /api/agent/[id]/stream for real-time updates.

import { useCallback, useRef } from 'react';
import { useChatStore, type ChatMessage, type ChatMode } from '@/stores/chat-store';
import { toast } from 'sonner';

export function useChat() {
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(async (text: string, mode: ChatMode = 'auto') => {
    // Используем getState() вместо подписки на весь store —
    // это предотвращает ре-рендеры при каждом стриминговом chunk'е.
    const state = useChatStore.getState();
    const episodeId = state.currentEpisodeId;
    if (!episodeId) {
      toast.error('Нет активного чата. Создай новый.');
      return;
    }
    if (state.isStreaming) return;

    // ── AGENT MODE: create agent task instead of streaming chat ──
    if (mode === 'agent') {
      // Save user message to UI
      const userMsg: ChatMessage = {
        id: `tmp-user-${Date.now()}`,
        role: 'user',
        content: text,
        createdAt: Date.now(),
      };
      useChatStore.getState().addMessage(userMsg);

      try {
        const res = await fetch('/api/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            episodeId,
            goal: text,
            autoStart: true,
            // Default workspace — creates a temp directory for agent file operations.
            // User can change this in settings later.
            fsScope: undefined,  // Will be set by UI in future, for now agent works without
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'request failed' }));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        const task = data.task;
        if (task) {
          // Set as active — triggers SSE subscription in useAgent
          useChatStore.getState().setActiveTask(task.id);
          useChatStore.getState().addAgentTask(task);
          toast.success('Агентская задача создана. Прогресс виден справа.');
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[useChat] agent create failed:', e);
        toast.error(`Не удалось создать задачу: ${msg}`);
      }
      return;
    }

    // ── FAST / STANDARD: streaming chat ──
    const userMsg: ChatMessage = {
      id: `tmp-user-${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: Date.now(),
    };
    const liaMsg: ChatMessage = {
      id: `tmp-lia-${Date.now()}`,
      role: 'companion',
      content: '',
      streaming: true,
      createdAt: Date.now() + 1,
    };
    useChatStore.getState().addMessage(userMsg);
    useChatStore.getState().addMessage(liaMsg);
    useChatStore.getState().setStreaming(true);

    abortRef.current = new AbortController();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, episodeId, mode }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'request failed' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      if (!res.body) {
        throw new Error('no response body');
      }

      // Read emotion from headers
      const emotionHeader = res.headers.get('X-Emotion');
      if (emotionHeader) {
        try {
          const emotion = JSON.parse(emotionHeader);
          useChatStore.getState().setEmotion(emotion);
        } catch { /* ignore */ }
      }

      // Read metadata headers — логируем для отладки и будущий UI.
      // Сервер шлёт: X-Tier, X-Complexity, X-Mode, X-Calls, X-Deliberate,
      // X-SelfCheck, X-ModelSize, X-Disagreement, X-RL-Action, X-RL-Confidence.
      const meta = {
        tier: res.headers.get('X-Tier'),
        complexity: res.headers.get('X-Complexity'),
        mode: res.headers.get('X-Mode'),
        calls: res.headers.get('X-Calls'),
        deliberate: res.headers.get('X-Deliberate'),
        selfCheck: res.headers.get('X-SelfCheck'),
        modelSize: res.headers.get('X-ModelSize'),
        disagreement: res.headers.get('X-Disagreement'),
        rlAction: res.headers.get('X-RL-Action'),
        rlConfidence: res.headers.get('X-RL-Confidence'),
      };
      if (meta.rlAction && meta.rlAction !== 'none') {
        console.log(`[chat] tier=${meta.tier} complexity=${meta.complexity} mode=${meta.mode} disagreement=${meta.disagreement} rlAction=${meta.rlAction}(${meta.rlConfidence}) deliberate=${meta.deliberate} selfCheck=${meta.selfCheck}`);
      }

      // Stream text chunks
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        accumulated += chunk;
        useChatStore.getState().updateLastMessage(accumulated);
      }

      useChatStore.getState().updateLastMessage(accumulated);
      useChatStore.getState().finalizeLastMessage();
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        useChatStore.getState().finalizeLastMessage();
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[useChat] error:', e);
        toast.error(`Не удалось отправить: ${msg}`);
        useChatStore.getState().updateLastMessage('⚠️ Соединение прервано. Попробуй ещё раз.');
        useChatStore.getState().finalizeLastMessage();
      }
    } finally {
      useChatStore.getState().setStreaming(false);
      abortRef.current = null;
    }
  }, []); // пустой deps — используем getState() вместо подписки на store

  const stop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }, []);

  return { sendMessage, stop };
}
