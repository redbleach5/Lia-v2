'use client';

// ============================================================================
// Chat store — композиция slices.
// ============================================================================
//
// Структура:
//   - episodesSlice — список эпизодов, текущий выбранный
//   - messagesSlice — сообщения, эмоции, chat state (isStreaming, mode)
//   - agentSlice    — список задач + активная задача (real-time SSE)
//   - healthSlice   — Ollama health
//
// Middleware:
//   - devtools: Redux DevTools интеграция (видеть все state changes в браузере)
//   - persist: mode сохраняется в localStorage (пользователь не теряет
//     выбранный режим чата при перезагрузке)
//
// Все типы (ChatMessage, Episode, AgentTask, и т.д.) вынесены в slices/types.ts
// чтобы избежать циклических зависимостей между slices.

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

import type { EpisodesSlice } from './slices/episodes-slice';
import { createEpisodesSlice } from './slices/episodes-slice';
import type { MessagesSlice } from './slices/messages-slice';
import { createMessagesSlice } from './slices/messages-slice';
import type { AgentSlice } from './slices/agent-slice';
import { createAgentSlice } from './slices/agent-slice';
import type { HealthSlice } from './slices/health-slice';
import { createHealthSlice } from './slices/health-slice';

// Re-export типов для обратной совместимости — компоненты импортируют
// ChatMessage, Episode, AgentTask и т.д. из '@/stores/chat-store'.
export type {
  ChatMessage,
  Episode,
  AgentTask,
  AgentTaskStatus,
  AgentStepLive,
  AgentPlanLive,
  ChatMode,
} from './slices/types';

export type ChatStore = EpisodesSlice & MessagesSlice & AgentSlice & HealthSlice;

export const useChatStore = create<ChatStore>()(
  devtools(
    persist(
      (set, get, store) => ({
        ...createEpisodesSlice(set as never, get as never, store as never),
        ...createMessagesSlice(set as never, get as never, store as never),
        ...createAgentSlice(set as never, get as never, store as never),
        ...createHealthSlice(set as never, get as never, store as never),
      }),
      {
        // Persist только `mode` — остальное state не имеет смысла сохранять
        // (episodes/messages/agent tasks приходят с сервера, emotion меняется).
        name: 'lia-chat-store',
        partialize: (state) => ({ mode: state.mode }) as Pick<ChatStore, 'mode'>,
      },
    ),
    {
      name: 'lia-chat-store', // Redux DevTools instance name
    },
  ),
);
