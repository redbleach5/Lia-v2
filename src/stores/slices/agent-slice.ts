// ============================================================================
// Agent slice — список задач + активная задача (real-time SSE данные).
// ============================================================================

import type { StateCreator } from 'zustand';
import type { AgentTask, AgentTaskStatus, AgentStepLive, AgentPlanLive } from './types';
import type { EpisodesSlice } from './episodes-slice';
import type { MessagesSlice } from './messages-slice';
import type { HealthSlice } from './health-slice';

export type AgentSlice = {
  agentTasks: AgentTask[];

  // Live agent task — for real-time UI updates via SSE
  activeTaskId: string | null;
  activeTaskStatus: AgentTaskStatus | null;
  activeTaskPlan: AgentPlanLive | null;
  activeTaskSteps: AgentStepLive[];
  activeTaskQuestion: string | null; // when waiting_input
  activeTaskResult: string | null;
  activeTaskError: string | null;
  activeTaskArtifacts: Array<{ filename: string; url: string; step: number }>;

  // Actions — agent tasks list
  setAgentTasks: (t: AgentTask[]) => void;
  addAgentTask: (t: AgentTask) => void;
  updateAgentTaskInList: (id: string, patch: Partial<AgentTask>) => void;

  // Actions — active task (SSE-driven)
  setActiveTask: (id: string | null) => void;
  setActiveTaskStatus: (status: AgentTaskStatus | null) => void;
  setActiveTaskPlan: (plan: AgentPlanLive | null) => void;
  addActiveTaskStep: (step: AgentStepLive) => void;
  appendActiveTaskObservation: (step: number, observation: string) => void;
  setActiveTaskQuestion: (q: string | null) => void;
  setActiveTaskResult: (r: string | null) => void;
  setActiveTaskError: (e: string | null) => void;
  addActiveTaskArtifact: (a: { filename: string; url: string; step: number }) => void;
  resetActiveTask: () => void;
};

// Начальное состояние active task — вынесено в константу, чтобы
// setActiveTask и resetActiveTask использовали единый source of truth.
// Используем явные типы (не `as const`) чтобы массивы были mutable.
const INITIAL_ACTIVE_TASK: Pick<AgentSlice,
  | 'activeTaskId' | 'activeTaskStatus' | 'activeTaskPlan'
  | 'activeTaskSteps' | 'activeTaskQuestion' | 'activeTaskResult'
  | 'activeTaskError' | 'activeTaskArtifacts'
> = {
  activeTaskId: null,
  activeTaskStatus: null,
  activeTaskPlan: null,
  activeTaskSteps: [],
  activeTaskQuestion: null,
  activeTaskResult: null,
  activeTaskError: null,
  activeTaskArtifacts: [],
};

export const createAgentSlice: StateCreator<
  EpisodesSlice & MessagesSlice & AgentSlice & HealthSlice,
  [],
  [],
  AgentSlice
> = (set) => ({
  agentTasks: [],
  ...INITIAL_ACTIVE_TASK,

  setAgentTasks: (t) => set({ agentTasks: t }),
  addAgentTask: (t) => set((s) => ({ agentTasks: [t, ...s.agentTasks] })),
  updateAgentTaskInList: (id, patch) => set((s) => ({
    agentTasks: s.agentTasks.map(t => t.id === id ? { ...t, ...patch } : t),
  })),

  setActiveTask: (id) => set({ ...INITIAL_ACTIVE_TASK, activeTaskId: id }),
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
  resetActiveTask: () => set({ ...INITIAL_ACTIVE_TASK }),
});
