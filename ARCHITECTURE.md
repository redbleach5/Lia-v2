# Архитектура Лия v2

## Слои

```
┌──────────────────────────────────────────────────────────────────┐
│                         Browser (Client)                          │
│  React 19 + Zustand (slices) + Tailwind 4 + shadcn/ui (Radix)   │
│  ├── page.tsx (Server Component) → ClientBootstrap               │
│  ├── ChatPanel (IntersectionObserver auto-scroll)                │
│  ├── AvatarColumn (VRM/Live2D, AgentPanel, RLPanel)              │
│  └── EpisodesSidebar (AlertDialog, cursor pagination)            │
├──────────────────────────────────────────────────────────────────┤
│                      Next.js API Routes                           │
│  Thin handlers: zod validation → service → response              │
│  ├── /api/chat → lib/chat/pipeline.ts                            │
│  ├── /api/agent/* → lib/agent/runner.ts                          │
│  ├── /api/episodes/* → lib/memory/episodes.ts                    │
│  ├── /api/settings → lib/ollama.ts + DB                          │
│  └── /api/rl/* → lib/rl/inference.ts → Python sidecar            │
├──────────────────────────────────────────────────────────────────┤
│                        Service Layer                              │
│  ├── lib/chat/        ChatPipeline, deliberate, self-check       │
│  ├── lib/agent/       runner (ReAct), task, tools, events        │
│  ├── lib/memory/      episodes, facts, vector, emotional         │
│  ├── lib/rl/          inference (ONNX), recorder                  │
│  └── lib/tools/       web-search, save-artifact, code-run        │
├──────────────────────────────────────────────────────────────────┤
│                       Infrastructure                              │
│  ├── lib/db.ts        Prisma (singleton)                         │
│  ├── lib/db-vec.ts    better-sqlite3 + sqlite-vec (encapsulated) │
│  ├── lib/infra/       ssrf.ts, api-validation.ts (zod)           │
│  ├── lib/logger.ts    Pino (JSON prod, pretty dev)               │
│  └── lib/paths.ts     cross-platform path resolution             │
├──────────────────────────────────────────────────────────────────┤
│                      External Services                            │
│  ├── Ollama (LLM + embeddings)    http://127.0.0.1:11434         │
│  └── Python sidecar (RL training) http://127.0.0.1:8765          │
│      └── FastAPI + PyTorch + ONNX (X-Sidecar-Key auth)           │
└──────────────────────────────────────────────────────────────────┘
```

## Chat message flow

```
User types message → ChatInput → useChat.sendMessage()

  ┌─ Agent mode ──────────────────────────────────────────────┐
  │ POST /api/agent { goal, autoStart }                        │
  │ → createAgentTask → runAgentTask (background)              │
  │ → SSE /api/agent/[id]/stream (real-time updates)           │
  │ → useAgent hook subscribes, updates store                  │
  └────────────────────────────────────────────────────────────┘

  ┌─ Chat mode (fast/standard/deep/auto) ─────────────────────┐
  │ POST /api/chat { text, episodeId, mode }                   │
  │ → parseBody (zod) → runChatPipeline                        │
  │                                                            │
  │ Pipeline steps:                                            │
  │ 1.  preflight (Ollama health)                              │
  │ 2.  capability (getCognitiveParams, cached 1h)             │
  │ 3.  complexity (classifyTaskComplexity, regex)             │
  │ 4.  plan (planExecution: mode × tier × complexity)         │
  │ 5.  perceive (emotion decay + regex triggers)              │
  │ 6.  disagreement (assessDisagreement)                      │
  │ 7.  RL: complete previous + predict action (ONNX)          │
  │ 8.  save user message                                      │
  │ 9.  build context (parallel: facts, vector, emotional)     │
  │ 10. build system prompt + messages                         │
  │ 11. smart notification (background)                        │
  │ 12. deliberate (if planned, LLM call with timeout)         │
  │ 13. streamText (main LLM, tools, onFinish callback)        │
  │ 14. response with metadata headers (-B64 for non-ASCII)    │
  │                                                            │
  │ onFinish (background, non-blocking):                       │
  │ ├── saveMessage (companion)                                │
  │ ├── remember (vector memory, dialogue)                     │
  │ ├── recordEmotionalAnchor (if intensity > 0.15)            │
  │ ├── recordExperience (RL state + action)                   │
  │ ├── extractAndSaveFacts (LLM call, background)             │
  │ └── runSelfCheck (LLM call, adjusts RL reward)             │
  │                                                            │
  │ Client reads stream:                                       │
  │ ├── X-Emotion-B64 header → setEmotion in store             │
  │ ├── text chunks → updateLastMessage (accumulated)          │
  │ └── done → finalizeLastMessage                             │
  └────────────────────────────────────────────────────────────┘
```

## Agent task flow

```
POST /api/agent { goal, autoStart: true }
  │
  ├─ createAgentTask → DB insert (status: pending)
  ├─ runAgentTask(taskId) — background
  │
  └─ runAgentTask:
     ├── Pre-flight: Ollama check
     ├── PLAN (or RESUME from checkpoint)
     │   ├── If checkpointJson exists:
     │   │   ├── Parse { plan, steps, savedAt }
     │   │   ├── Skip PLAN — restore plan + steps
     │   │   └── Emit replay events for UI
     │   └── Else:
     │       ├── generatePlan (LLM, AbortSignal.timeout)
     │       └── Save planJson
     │
     ├── EXECUTE LOOP (for i = steps.length; i < maxSteps; i++)
     │   ├── Check cancellation (isCancelled)
     │   ├── Check budget (ask user to extend if exceeded)
     │   ├── Loop detection (pattern, empty, semantic)
     │   ├── buildStepMessages (plan + previous steps + tools)
     │   ├── executeStep:
     │   │   ├── Attempt 1: streamText with tools
     │   │   └── Attempt 2: without tools (fallback)
     │   ├── Save checkpoint: { plan, steps, savedAt }
     │   ├── Emit step_end event (SSE)
     │   └── Check "ГОТОВО" signal → break
     │
     ├── SYNTHESIZE (LLM, AbortSignal.timeout)
     │   └── Final summary from all steps
     │
     ├── Update task: done, resultSummary, checkpointJson: null
     └── Emit task_done

  Cancel: POST /api/agent/[id]/cancel
    → signalCancellation + cancelWaiting + abortTask (AbortController)
    → streamText gets abort, exits cleanly

  Resume after restart:
    → sweepStaleTasks: executing+checkpoint → pending
    → POST /api/agent/[id]/start → runAgentTask
    → checkpointJson exists → skip PLAN, continue from steps.length
```

## RL feedback loop

```
┌──────────────────────── Next.js (TS) side ────────────────────────┐
│                                                                    │
│  POST /api/chat                                                    │
│  │                                                                 │
│  ├── processRL:                                                    │
│  │   1. findLastIncompleteExperience(episodeId)                    │
│  │   2. completeExperience(id, { nextState, reward: 0, signals })  │
│  │      signals = { userResponded, latency, length, wasRepeated,  │
│  │                 irritationDelta, userMessage }                  │
│  │      wasRepeated = isRepeatedMessage(text, prev.userMessage)   │
│  │      (Jaccard similarity ≥ 0.8)                                 │
│  │   3. predictAction(rlState) → ONNX inference                   │
│  │      Returns action + confidence + version                     │
│  │   4. getActionInstruction → prompt fragment                    │
│  │                                                                 │
│  └── onFinish: recordExperience({ state, action, episodeId })     │
│      └── Self-check may add penalty via db.rLExperience.update    │
│                                                                    │
└────────────────────────────┬───────────────────────────────────────┘
                             │ Shared SQLite file (busy_timeout=5000)
                             ▼
┌──────────────────────── Python sidecar ────────────────────────────┐
│                                                                    │
│  POST /train (X-Sidecar-Key auth)                                  │
│  │                                                                 │
│  ├── load_transitions (WHERE userResponded=1, ORDER BY createdAt) │
│  ├── compute_reward(Transition) for each — SINGLE SOURCE OF TRUTH │
│  │   reward.py is user-editable                                   │
│  ├── GAE with episode-boundary reset (bootstrap=0 at boundaries)  │
│  ├── PPO training (old_log_probs per epoch)                       │
│  ├── save_model → policy_v{N}.pt                                  │
│  └── export_to_onnx → policy_v{N}.tmp → os.replace (atomic)       │
│                                                                    │
│  Back in TS:                                                       │
│  ├── reloadModel → waitForStableFile → onnxruntime-node           │
│  └── predictAction uses new model for next chat message           │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## Memory architecture

```
┌──────────────────────── SQLite (custom.db) ────────────────────────┐
│                                                                     │
│  Prisma-managed tables:                                            │
│  ├── Episode          (id, title, createdAt, updatedAt, endedAt)   │
│  ├── Message          (id, episodeId, role, content, emotionJson)  │
│  ├── GlobalFact       (key, value, confidence) — cross-episode     │
│  ├── EpisodeFact      (episodeId, key, value) — current chat       │
│  ├── VectorMemory     (id, episodeId, sourceType, text, embedding) │
│  ├── EmotionalMemory  (id, episodeId, emotion, intensity, trigger) │
│  ├── AgentTask        (id, goal, status, planJson, stepsJson,      │
│  │                      checkpointJson, fsScope, toolsWhitelist)    │
│  ├── RLExperience     (id, stateJson, action, reward, signals,     │
│  │                      episodeId) — @@index([ep, responded, ts])  │
│  ├── RlModelVersion   (version, onnxPath, metricsJson)             │
│  └── Setting          (key, value) — ollama config, artifacts      │
│                                                                     │
│  Raw SQL tables (vec0 extension, encapsulated in db-vec.ts):       │
│  ├── vec_virtual      (vec0: embedding float[768], episode_id,     │
│  │                     source_type) — KNN search index             │
│  └── vec_rowid_map    (rowid → vector_id, episode_id)              │
│                                                                     │
│  Dual-write (transactional):                                       │
│  ├── insertVectorMemory: VectorMemory + vec_virtual + rowid_map   │
│  ├── insertEmotionalVectorIndex: vec_virtual + rowid_map           │
│  └── deleteVectorsInEpisode: all three in transaction              │
│                                                                     │
│  Source types (no cross-contamination):                            │
│  ├── 'dialogue'  — recall() filters sourceType='dialogue'          │
│  └── 'emotional' — recallEmotionalAnchors filters 'emotional'      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## State management

```
Zustand store (4 slices + devtools + persist):

  episodesSlice    episodes[], currentEpisodeId
                   setEpisodes, addEpisode, removeEpisode, setCurrentEpisode
                   
  messagesSlice    messages[], emotion, isStreaming, mode
                   setMessages, addMessage, updateLastMessage, finalizeLastMessage
                   setEmotion, setStreaming, setMode
                   
  agentSlice       agentTasks[], activeTaskId, activeTaskStatus,
                   activeTaskPlan, activeTaskSteps, activeTaskQuestion,
                   activeTaskResult, activeTaskError, activeTaskArtifacts
                   setActiveTask, addActiveTaskStep, resetActiveTask, ...
                   
  healthSlice      ollamaOk, ollamaError
                   setOllamaHealth

  Middleware:
  ├── devtools    — Redux DevTools integration
  └── persist     — mode saved to localStorage (user preference survives reload)
```

## Error handling strategy

```
Panel-level (React Error Boundary):
  PanelErrorBoundary → fallback UI with "Попробовать снова"
  ├── AgentPanel
  ├── RLPanel
  └── (VRM already has VrmErrorBoundary)

Route-level:
  Global error.tsx → fallback for entire page crash
  Loading.tsx → initial load state

Service-level:
  try/catch + logger.warn/error (non-fatal — chat continues)
  ├── Memory operations (remember, recall) — silent failure, log
  ├── RL inference — fallback to action 0 (WAIT)
  └── Self-check — log only, doesn't block response

Streaming-level:
  AbortSignal.timeout on all LLM calls (no Promise.race leaks)
  ├── Plan generation: LLM_TIMEOUT_MS (3 min)
  ├── Step execution: LLM_TIMEOUT_MS (3 min)
  ├── Synthesis: SYNTHESIS_TIMEOUT_MS (4 min)
  ├── Deliberate: 60s
  └── Self-check: 60s

Agent watchdog:
  Wall-time scales with task.maxDurationSec (min 30min, max 24h)
  → abortTask() sends AbortController signal to active streamText
```
