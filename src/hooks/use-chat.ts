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
  const store = useChatStore();
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(async (text: string, mode: ChatMode = 'standard') => {
    const episodeId = store.currentEpisodeId;
    if (!episodeId) {
      toast.error('Нет активного чата. Создай новый.');
      return;
    }
    if (store.isStreaming) return;

    // ── AGENT MODE: create agent task instead of streaming chat ──
    if (mode === 'agent') {
      // Save user message to UI
      const userMsg: ChatMessage = {
        id: `tmp-user-${Date.now()}`,
        role: 'user',
        content: text,
        createdAt: Date.now(),
      };
      store.addMessage(userMsg);

      try {
        const res = await fetch('/api/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            episodeId,
            goal: text,
            autoStart: true,
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
    store.addMessage(userMsg);
    store.addMessage(liaMsg);
    store.setStreaming(true);

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
          store.setEmotion(emotion);
        } catch { /* ignore */ }
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
        store.updateLastMessage(accumulated);
      }

      store.updateLastMessage(accumulated);
      store.finalizeLastMessage();
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        store.finalizeLastMessage();
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[useChat] error:', e);
        toast.error(`Не удалось отправить: ${msg}`);
        store.updateLastMessage('⚠️ Соединение прервано. Попробуй ещё раз.');
        store.finalizeLastMessage();
      }
    } finally {
      store.setStreaming(false);
      abortRef.current = null;
    }
  }, [store]);

  const stop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }, []);

  return { sendMessage, stop };
}
