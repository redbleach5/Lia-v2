// ============================================================================
// Messages slice — сообщения текущего эпизода + эмоции + chat state.
// ============================================================================

import type { StateCreator } from 'zustand';
import type { EmotionVector } from '@/lib/personality';
import type { ChatMessage, ChatMode } from './types';
import { INITIAL_EMOTION } from './types';
import type { EpisodesSlice } from './episodes-slice';
import type { AgentSlice } from './agent-slice';
import type { HealthSlice } from './health-slice';

export type MessagesSlice = {
  messages: ChatMessage[];
  emotion: EmotionVector;
  isStreaming: boolean;
  mode: ChatMode;

  setMessages: (msgs: ChatMessage[]) => void;
  addMessage: (msg: ChatMessage) => void;
  updateLastMessage: (content: string) => void;
  finalizeLastMessage: () => void;
  setEmotion: (e: EmotionVector) => void;
  setStreaming: (s: boolean) => void;
  setMode: (m: ChatMode) => void;
};

export const createMessagesSlice: StateCreator<
  EpisodesSlice & MessagesSlice & AgentSlice & HealthSlice,
  [],
  [],
  MessagesSlice
> = (set) => ({
  messages: [],
  emotion: INITIAL_EMOTION,
  isStreaming: false,
  mode: 'auto',

  setMessages: (msgs) => set({ messages: msgs }),
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  updateLastMessage: (content) => set((s) => {
    if (s.messages.length === 0) return s;
    const last = s.messages[s.messages.length - 1];
    if (last.role !== 'companion' || !last.streaming) return s;
    const updated = { ...last, content };
    return { messages: [...s.messages.slice(0, -1), updated] };
  }),
  finalizeLastMessage: () => set((s) => {
    if (s.messages.length === 0) return s;
    const last = s.messages[s.messages.length - 1];
    if (last.role !== 'companion' || !last.streaming) return s;
    const updated = { ...last, streaming: false };
    return { messages: [...s.messages.slice(0, -1), updated] };
  }),

  setEmotion: (e) => set({ emotion: e }),
  setStreaming: (s) => set({ isStreaming: s }),
  setMode: (m) => set({ mode: m }),
});
