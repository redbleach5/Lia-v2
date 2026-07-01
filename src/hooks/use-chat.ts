'use client';

// Chat hook — wraps the /api/chat streaming endpoint.
//
// Streaming protocol (plain text):
//   - Body is a stream of UTF-8 text chunks
//   - Response headers carry metadata: X-Message-Id, X-Triggers, X-Emotion-B64
//   - No delimiter in body — stream ends when response closes
//
// For agent mode: instead of streaming chat, creates an AgentTask via /api/agent
// and the UI subscribes to /api/agent/[id]/stream for real-time updates.
//
// NOTE (Phase 3): миграция на @ai-sdk/react useChat отложена.
// Текущий backend использует plain text streaming (result.toTextStreamResponse),
// а useChat ожидает UI Message Stream protocol (toUIMessageStreamResponse).
// Миграция потребует:
//   1. Замены toTextStreamResponse → toUIMessageStreamResponse в lib/chat/pipeline.ts
//   2. Переноса emotion/metadata из headers в data parts stream'а
//   3. Адаптации ChatMessage type к UIMessage (parts-based)
//   4. Перепроверки agent-mode логики (создание AgentTask вне streaming)
// Это значительное изменение протокола — рискованно в рамках Phase 3.
// Отложено до отдельной фазы после стабилизации архитектуры.

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
        id: crypto.randomUUID(),
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
        // Удаляем user message — задача не создалась, нет смысла показывать "висящее" сообщение.
        useChatStore.setState((s) => ({
          messages: s.messages.filter(m => m.id !== userMsg.id),
        }));
      }
      return;
    }

    // ── FAST / STANDARD: streaming chat ──
    // Phase 6.2: используем crypto.randomUUID() вместо Date.now() для уникальности.
    // Date.now() мог дать одинаковые ID при быстрых сообщениях (разница <1ms).
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      createdAt: Date.now(),
    };
    const liaMsg: ChatMessage = {
      id: crypto.randomUUID(),
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

      // Специальная обработка 503 — Ollama недоступен или нет моделей.
      // Сервер возвращает понятное сообщение — показываем его без технических деталей.
      if (res.status === 503) {
        const err = await res.json().catch(() => ({ error: 'Ollama недоступен' }));
        throw new Error(err.error || 'Ollama недоступен');
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'request failed' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      if (!res.body) {
        throw new Error('no response body');
      }

      // Read emotion + metadata from headers.
      // Заголовки с суффиксом -B64 закодированы в base64 (non-ASCII: русский текст, JSON).
      // Остальные — plain ASCII, читаются как есть.
      const decodeB64 = (s: string | null): string | null => {
        if (!s) return null;
        try {
          const binary = atob(s);
          const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
          return new TextDecoder().decode(bytes);
        } catch {
          return s;
        }
      };

      const emotionHeader = decodeB64(res.headers.get('X-Emotion-B64'));
      if (emotionHeader) {
        try {
          const emotion = JSON.parse(emotionHeader);
          useChatStore.getState().setEmotion(emotion);
        } catch { /* ignore */ }
      }

      // Metadata — логируется только при наличии RL action (полезно для отладки RL).
      // Раньше логировалось каждый раз + decodeHeader портил ASCII заголовки.
      const meta = {
        tier: res.headers.get('X-Tier'),
        complexity: res.headers.get('X-Complexity'),
        mode: res.headers.get('X-Mode'),
        calls: res.headers.get('X-Calls'),
        deliberate: res.headers.get('X-Deliberate'),
        selfCheck: res.headers.get('X-SelfCheck'),
        modelSize: res.headers.get('X-ModelSize'),
        disagreement: decodeB64(res.headers.get('X-Disagreement-B64')),
        rlAction: decodeB64(res.headers.get('X-RL-Action-B64')),
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
        // Пользователь сам отменил — оставляем что есть, финализируем.
        useChatStore.getState().finalizeLastMessage();
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[useChat] error:', e);

        // Если стрим ещё не начался (liaMsg пустой) — удаляем оба сообщения
        // (user + placeholder lia), чтобы не засорять чат ошибочными попытками.
        const state = useChatStore.getState();
        const lastMsg = state.messages[state.messages.length - 1];
        if (lastMsg && lastMsg.role === 'companion' && lastMsg.streaming && !lastMsg.content) {
          // Удаляем placeholder lia + последнее user-сообщение.
          useChatStore.setState((s) => ({ messages: s.messages.slice(0, -2) }));
          toast.error(msg);
        } else {
          // Стрим уже начался — показываем что есть, помечаем как прерванное.
          toast.error(`Не удалось отправить: ${msg}`);
          useChatStore.getState().updateLastMessage('⚠️ Соединение прервано. Попробуй ещё раз.');
          useChatStore.getState().finalizeLastMessage();
        }
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
