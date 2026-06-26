'use client';

import { create } from 'zustand';
import type { EmotionVector } from '@/lib/personality';

// ============================================================================
// Types
// ============================================================================
export type ChatMessage = {
  id: string;
  role: 'user' | 'companion';
  content: string;
  emotion?: EmotionVector;
  toolCalls?: Array<{ name: string; input: unknown; output: unknown }>;
  createdAt: number;
  streaming?: boolean;
};

export type Episode = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type AgentTask = {
  id: string;
  episodeId: string;
  goal: string;
  status: string;
  currentStep: number;
  maxSteps: number;
  error: string | null;
  resultSummary: string | null;
  createdAt: string;
};

// Real-time step data for the active task (from SSE)
export type AgentStepLive = {
  step: number;
  thought: string;
  action: string;
  observation: string;
  durationMs?: number;
  tools?: Array<{ name: string; input: unknown; success: boolean; output: unknown }>;
  ts: number;
};

export type AgentPlanLive = {
  goal: string;
  steps: string[];
  complexity: string;
};

export type ChatMode = 'fast' | 'standard' | 'agent';

// ============================================================================
// Store
// ============================================================================
type ChatStore = {
  // Episodes
  episodes: Episode[];
  currentEpisodeId: string | null;

  // Messages for current episode
  messages: ChatMessage[];

  // Emotion — updated from response headers + perceived from local rules
  emotion: EmotionVector;

  // Chat state
  isStreaming: boolean;
  mode: ChatMode;

  // Agent tasks
  agentTasks: AgentTask[];

  // Live agent task — for real-time UI updates via SSE
  activeTaskId: string | null;
  activeTaskStatus: string | null;
  activeTaskPlan: AgentPlanLive | null;
  activeTaskSteps: AgentStepLive[];
  activeTaskQuestion: string | null; // when waiting_input
  activeTaskResult: string | null;
  activeTaskError: string | null;
  activeTaskArtifacts: Array<{ filename: string; url: string; step: number }>;

  // Ollama health
  ollamaOk: boolean | null;
  ollamaError: string | null;

  // Actions — episodes
  setEpisodes: (eps: Episode[]) => void;
  addEpisode: (ep: Episode) => void;
  removeEpisode: (id: string) => void;
  setCurrentEpisode: (id: string | null) => void;

  // Actions — messages
  setMessages: (msgs: ChatMessage[]) => void;
  addMessage: (msg: ChatMessage) => void;
  updateLastMessage: (content: string) => void;
  finalizeLastMessage: () => void;

  // Actions — emotion / chat
  setEmotion: (e: EmotionVector) => void;
  setStreaming: (s: boolean) => void;
  setMode: (m: ChatMode) => void;

  // Actions — agent tasks
  setAgentTasks: (t: AgentTask[]) => void;
  addAgentTask: (t: AgentTask) => void;
  updateAgentTaskInList: (id: string, patch: Partial<AgentTask>) => void;

  // Actions — active task (SSE-driven)
  setActiveTask: (id: string | null) => void;
  setActiveTaskStatus: (status: string | null) => void;
  setActiveTaskPlan: (plan: AgentPlanLive | null) => void;
  addActiveTaskStep: (step: AgentStepLive) => void;
  appendActiveTaskObservation: (step: number, observation: string) => void;
  setActiveTaskQuestion: (q: string | null) => void;
  setActiveTaskResult: (r: string | null) => void;
  setActiveTaskError: (e: string | null) => void;
  addActiveTaskArtifact: (a: { filename: string; url: string; step: number }) => void;
  resetActiveTask: () => void;

  // Health
  setOllamaHealth: (ok: boolean, error?: string | null) => void;
};

const initialEmotion: EmotionVector = {
  joy: 0.55,
  curiosity: 0.75,
  calm: 0.7,
  irritation: 0.1,
  sadness: 0.15,
};

export const useChatStore = create<ChatStore>((set) => ({
  episodes: [],
  currentEpisodeId: null,
  messages: [],
  emotion: initialEmotion,
  isStreaming: false,
  mode: 'standard',
  agentTasks: [],
  activeTaskId: null,
  activeTaskStatus: null,
  activeTaskPlan: null,
  activeTaskSteps: [],
  activeTaskQuestion: null,
  activeTaskResult: null,
  activeTaskError: null,
  activeTaskArtifacts: [],
  ollamaOk: null,
  ollamaError: null,

  setEpisodes: (eps) => set({ episodes: eps }),
  addEpisode: (ep) => set((s) => ({ episodes: [ep, ...s.episodes] })),
  removeEpisode: (id) => set((s) => ({
    episodes: s.episodes.filter(e => e.id !== id),
    currentEpisodeId: s.currentEpisodeId === id ? null : s.currentEpisodeId,
  })),
  setCurrentEpisode: (id) => set({ currentEpisodeId: id, messages: [] }),

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

  setAgentTasks: (t) => set({ agentTasks: t }),
  addAgentTask: (t) => set((s) => ({ agentTasks: [t, ...s.agentTasks] })),
  updateAgentTaskInList: (id, patch) => set((s) => ({
    agentTasks: s.agentTasks.map(t => t.id === id ? { ...t, ...patch } : t),
  })),

  setActiveTask: (id) => set((s) => ({
    activeTaskId: id,
    activeTaskStatus: null,
    activeTaskPlan: null,
    activeTaskSteps: [],
    activeTaskQuestion: null,
    activeTaskResult: null,
    activeTaskError: null,
    activeTaskArtifacts: [],
  })),
  setActiveTaskStatus: (status) => set({ activeTaskStatus: status }),
  setActiveTaskPlan: (plan) => set({ activeTaskPlan: plan }),
  addActiveTaskStep: (step) => set((s) => ({
    activeTaskSteps: [...s.activeTaskSteps, step],
  })),
  appendActiveTaskObservation: (stepNum, observation) => set((s) => ({
    activeTaskSteps: s.activeTaskSteps.map(st =>
      st.step === stepNum
        ? { ...st, observation: st.observation + observation }
        : st
    ),
  })),
  setActiveTaskQuestion: (q) => set({ activeTaskQuestion: q }),
  setActiveTaskResult: (r) => set({ activeTaskResult: r }),
  setActiveTaskError: (e) => set({ activeTaskError: e }),
  addActiveTaskArtifact: (a) => set((s) => ({
    activeTaskArtifacts: [...s.activeTaskArtifacts, a],
  })),
  resetActiveTask: () => set({
    activeTaskId: null,
    activeTaskStatus: null,
    activeTaskPlan: null,
    activeTaskSteps: [],
    activeTaskQuestion: null,
    activeTaskResult: null,
    activeTaskError: null,
    activeTaskArtifacts: [],
  }),

  setOllamaHealth: (ok, error = null) => set({ ollamaOk: ok, ollamaError: error }),
}));
