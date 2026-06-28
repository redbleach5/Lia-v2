// Agent runner — основной ReAct-loop.
//
// Flow:
//   1. PLAN — LLM анализирует задачу, генерирует план (JSON)
//   2. LOOP — до maxSteps:
//      a. streamText с tools + plan + previous steps в контексте
//      b. on tool call → execute, emit tool_start/tool_end
//      c. on text → это thought + промежуточный ответ
//      d. detect loop → pause, ask user
//      e. on maxSteps → synthesize
//   3. SYNTHESIZE — финальный ответ из всех шагов
//
// Checkpoint после каждого шага. Resume после рестарта — пока не реализовано
// (требует persistent queue), но данные в БД есть.

import { streamText, isStepCount, type ModelMessage, type ToolSet } from 'ai';
import { getChatModel, checkOllamaHealth } from '@/lib/ollama';
import { db } from '@/lib/db';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import {
  getAgentTask,
  updateAgentTask,
  parseSteps,
  type AgentTask,
} from './task';
import { buildAgentTools, describeTools } from './tools';
import { detectLoop } from './loop-detector';
import {
  emitAgentEvent,
  bufferEvent,
  clearBuffer,
  isCancelled,
  clearCancellation,
  cancelWaiting,
  isWaiting,
  setWaiting,
  signalCancellation,
} from './events';
import { getEpisodeFacts } from '@/lib/memory/facts';
import { recall } from '@/lib/memory/vector';
import { getMessages } from '@/lib/memory/episodes';

// ============================================================================
// Schemas — для structured output plan
// ============================================================================
const planSchema = z.object({
  goal: z.string().min(1).default('Выполнить задачу'),
  steps: z.array(z.string()).default([]),
  needsTools: z.boolean().default(true),
  complexity: z.enum(['low', 'medium', 'high']).default('medium').catch('medium'),
});

// ============================================================================
// Constants
// ============================================================================
const PLANNING_TEMPERATURE = 0.3;
const EXECUTION_TEMPERATURE = 0.5;
const SYNTHESIS_TEMPERATURE = 0.6;
const OBSERVATION_CAP = 5000; // increased from 3000 — agent needs full context for complex tasks
const ASK_USER_TIMEOUT_MS = 5 * 60 * 1000; // 5 min timeout for user response
const EXECUTION_MAX_TOKENS = 4000; // increased from 1500 — allows longer code blocks
const SYNTHESIS_MAX_TOKENS = 3000; // increased from 1500 — allows detailed final answers
const PLANNING_MAX_TOKENS = 800; // increased from 600 — allows more detailed plans

// ============================================================================
// Active runners — singleton per task (prevent double-start)
// ============================================================================
const activeRunners = new Set<string>();

export function isRunning(taskId: string): boolean {
  return activeRunners.has(taskId);
}

// ============================================================================
// Sweep stale tasks — вызывается при старте сервера.
// ============================================================================
const TRANSIENT_STATUSES = ['planning', 'executing', 'waiting_input', 'synthesizing'] as const;

export async function sweepStaleTasks(): Promise<number> {
  try {
    const staleTasks = await db.agentTask.findMany({
      where: { status: { in: [...TRANSIENT_STATUSES] } },
      select: { id: true, status: true },
    });

    if (staleTasks.length === 0) return 0;

    await db.agentTask.updateMany({
      where: { id: { in: staleTasks.map(t => t.id) } },
      data: {
        status: 'failed',
        error: 'Сервер был перезапущен во время выполнения задачи. Перезапустите задачу для продолжения.',
        completedAt: new Date(),
      },
    });

    logger.warn('agent', `Swept ${staleTasks.length} stale task(s) marked as failed`, {
      taskIds: staleTasks.map(t => t.id.slice(0, 8)),
      statuses: staleTasks.map(t => t.status),
    });
    return staleTasks.length;
  } catch (e) {
    logger.warn('agent', 'sweepStaleTasks failed (non-fatal)', {}, e);
    return 0;
  }
}

// ============================================================================
// Main entry point
// ============================================================================
// Жёсткий верхний таймаут на всю задачу — даже если maxDurationSec больше,
// мы принудительно снимаем задачу через MAX_TASK_WALL_TIME_MS. Это страховка
// от scenarios когда promise висит навсегда (например, onCancel не сработал).
const MAX_TASK_WALL_TIME_MS = 30 * 60 * 1000; // 30 минут абсолютный максимум

export async function runAgentTask(taskId: string): Promise<void> {
  const log = logger.context({ taskId: taskId.slice(0, 8) });

  if (activeRunners.has(taskId)) {
    log.warn('agent', 'Task already running, skipping');
    return;
  }

  const task = await getAgentTask(taskId);
  if (!task) {
    log.error('agent', 'Task not found');
    return;
  }
  if (task.status === 'done' || task.status === 'cancelled') {
    log.warn('agent', `Task already ${task.status}`, { status: task.status });
    return;
  }

  log.info('agent', 'Task started', {
    goal: task.goal.slice(0, 100),
    status: task.status,
    maxSteps: task.maxSteps,
    maxDurationSec: task.maxDurationSec,
    fsScope: task.fsScope ? 'set' : 'none',
  });

  activeRunners.add(taskId);
  clearCancellation(taskId);

  // ── Страховочный watchdog — снимает задачу если она идёт дольше MAX_TASK_WALL_TIME_MS ──
  // Это решает проблему "зависших" задач, когда ни один из внутренних таймаутов
  // не сработал (race condition, неучтённый await, и т.п.).
  const watchdogTimer = setTimeout(() => {
    if (activeRunners.has(taskId)) {
      log.error('agent', `WATCHDOG: Task exceeded ${MAX_TASK_WALL_TIME_MS / 60000}min wall time, force-failing`, {
        wallTimeMs: MAX_TASK_WALL_TIME_MS,
      });
      signalCancellation(taskId);
      cancelWaiting(taskId);
      // Принудительно помечаем в БД
      updateAgentTask(taskId, {
        status: 'failed',
        completedAt: new Date(),
        error: `Задача превысила максимальное время выполнения (${MAX_TASK_WALL_TIME_MS / 60000} мин). Возможно, LLM завис или инструмент не ответил.`,
      }).catch(() => null);
    }
  }, MAX_TASK_WALL_TIME_MS);
  watchdogTimer.unref?.();

  try {
    // ── 0. Pre-flight: Ollama availability check ──
    log.debug('ollama', 'Pre-flight Ollama check');
    const preflightStart = Date.now();
    const preflight = await checkOllamaHealth();
    log.debug('ollama', `Pre-flight done (${Date.now() - preflightStart}ms)`, {
      ok: preflight.ok,
      modelsCount: preflight.models.length,
    });

    if (!preflight.ok) {
      const errMsg = `Ollama недоступен: ${preflight.error ?? 'unknown'}. Запусти \`ollama serve\` и проверь URL в настройках.`;
      log.error('ollama', 'Pre-flight failed — Ollama unavailable', {
        error: preflight.error,
      }, new Error(errMsg));
      await updateAgentTask(taskId, {
        status: 'failed',
        completedAt: new Date(),
        error: errMsg,
      });
      emitAgentEvent({ type: 'task_failed', taskId, error: errMsg, ts: Date.now() });
      bufferEvent({ type: 'task_failed', taskId, error: errMsg, ts: Date.now() });
      return;
    }
    if (preflight.models.length === 0) {
      const errMsg = 'В Ollama нет моделей. Скачай хотя бы одну: `ollama pull qwen2.5:7b`.';
      log.error('ollama', 'Pre-flight failed — no models available');
      await updateAgentTask(taskId, {
        status: 'failed',
        completedAt: new Date(),
        error: errMsg,
      });
      emitAgentEvent({ type: 'task_failed', taskId, error: errMsg, ts: Date.now() });
      bufferEvent({ type: 'task_failed', taskId, error: errMsg, ts: Date.now() });
      return;
    }

    log.info('ollama', 'Pre-flight OK', { models: preflight.models.length });

    await updateAgentTask(taskId, {
      status: 'planning',
      startedAt: task.startedAt ?? new Date(),
    });
    emitAgentEvent({ type: 'task_started', taskId, goal: task.goal, ts: Date.now() });
    bufferEvent({ type: 'task_started', taskId, goal: task.goal, ts: Date.now() });

    // ── 1. PLAN ──
    log.info('agent', 'PLAN phase started');
    emitAgentEvent({ type: 'task_planning', taskId, ts: Date.now() });
    bufferEvent({ type: 'task_planning', taskId, ts: Date.now() });

    // Build tools ONCE — used for both planning and execution.
    const agentTools = buildAgentTools(task);
    const toolDescriptions = describeTools(agentTools);
    log.debug('agent', `Tools built (${Object.keys(agentTools).length} tools)`, {
      tools: Object.keys(agentTools),
    });

    const planStart = Date.now();
    const plan = await generatePlan(task, toolDescriptions);
    log.info('agent', `Plan generated (${Date.now() - planStart}ms)`, {
      stepsCount: plan.steps.length,
      complexity: plan.complexity,
      needsTools: plan.needsTools,
      steps: plan.steps.map(s => s.slice(0, 80)),
    });

    await updateAgentTask(taskId, { planJson: JSON.stringify(plan) });

    emitAgentEvent({
      type: 'task_plan_ready',
      taskId,
      plan: { goal: plan.goal, steps: plan.steps, complexity: plan.complexity },
      ts: Date.now(),
    });
    bufferEvent({
      type: 'task_plan_ready',
      taskId,
      plan: { goal: plan.goal, steps: plan.steps, complexity: plan.complexity },
      ts: Date.now(),
    });

    // ── 2. EXECUTE LOOP ──
    log.info('agent', 'EXECUTE phase started');
    await updateAgentTask(taskId, { status: 'executing' });

    // Load existing steps (for resume case). Start iteration from where we left off.
    const steps = parseSteps(task.stepsJson);
    const startStep = steps.length;  // continue from existing steps
    // agentTools + toolDescriptions already built above — no duplication
    let startTime = Date.now();

    // Cache episode context — doesn't change between steps
    const contextLoadStart = Date.now();
    const [episodeFacts, vectorHits] = await Promise.all([
      getEpisodeFacts(task.episodeId),
      recall({ episodeId: task.episodeId, query: task.goal, limit: 2, minSimilarity: 0.4 }).catch((e) => {
        log.warn('memory', 'recall failed during agent context load', {}, e);
        return [];
      }),
    ]);
    log.debug('memory', `Context loaded (${Date.now() - contextLoadStart}ms)`, {
      factsCount: episodeFacts.length,
      vectorHits: vectorHits.length,
    });
    const contextStr = [
      episodeFacts.length > 0 ? 'Контекст чата:\n' + episodeFacts.map(f => `${f.key}: ${f.value}`).join('\n') : '',
      vectorHits.length > 0 ? 'Релевантные воспоминания:\n' + vectorHits.map(h => h.text.slice(0, 300)).join('\n---\n') : '',
    ].filter(Boolean).join('\n\n');

    for (let i = startStep; i < task.maxSteps; i++) {
      // Cancellation check — between steps
      if (isCancelled(taskId)) {
        log.warn('agent', `Cancellation detected before step ${i + 1}`);
        emitAgentEvent({ type: 'task_cancelled', taskId, ts: Date.now() });
        bufferEvent({ type: 'task_cancelled', taskId, ts: Date.now() });
        await updateAgentTask(taskId, {
          status: 'cancelled',
          completedAt: new Date(),
          stepsJson: JSON.stringify(steps),
          currentStep: i,
        });
        return;
      }

      // Budget check
      const elapsedSec = (Date.now() - startTime) / 1000;
      if (elapsedSec > task.maxDurationSec) {
        log.warn('agent', `Budget exceeded — asking user to extend`, {
          elapsedSec: Math.floor(elapsedSec),
          maxDurationSec: task.maxDurationSec,
        });
        const extensionSec = Math.max(60, Math.floor(task.maxDurationSec / 2));
        const userAnswer = await pauseTaskForInput(
          taskId,
          `Превышен лимит времени (${Math.floor(elapsedSec)} сек из ${task.maxDurationSec}). Продолжить ещё на ${extensionSec} сек или остановиться? Ответь "продолжить" или "стоп".`,
        );

        log.info('agent', `Budget extension answer`, { answer: userAnswer.slice(0, 50) });

        const answerLower = userAnswer.toLowerCase().trim();
        const stopWords = ['стоп', 'stop', 'нет', 'no', 'отмена', 'cancel', 'остановись', 'хватит'];
        if (stopWords.some(w => answerLower.includes(w))) {
          signalCancellation(taskId);
          continue;
        }

        if (isCancelled(taskId)) continue;
        startTime = Date.now() - (task.maxDurationSec - extensionSec) * 1000;
      }

      // Loop detection
      if (steps.length >= 2) {
        const loopSignal = await detectLoop(steps);
        if (loopSignal) {
          const reason = loopSignal.kind === 'pattern'
            ? `Повторяю одно и то же действие (${loopSignal.count} раза): ${loopSignal.tool}`
            : loopSignal.kind === 'empty'
              ? `${loopSignal.count} последних шагов дали пустой результат`
              : `Мысли стали слишком похожи (similarity=${loopSignal.similarity.toFixed(2)})`;
          log.warn('agent', `Loop detected — asking user`, {
            kind: loopSignal.kind,
            count: 'count' in loopSignal ? loopSignal.count : undefined,
            tool: 'tool' in loopSignal ? loopSignal.tool : undefined,
          });
          await pauseTaskForInput(taskId, `Похоже, я застряла в цикле: ${reason}. Подскажи, как поступить?`);
          if (isCancelled(taskId)) continue;
        }
      }

      // ── Build messages for this step ──
      const stepMessages = buildStepMessages(task, plan, steps, toolDescriptions, contextStr);

      log.info('agent', `Step ${i + 1}/${task.maxSteps} started`);
      emitAgentEvent({
        type: 'step_start',
        taskId,
        step: i + 1,
        maxSteps: task.maxSteps,
        thought: '',  // real thought comes in step_end after LLM generates it
        ts: Date.now(),
      });

      const stepStartTime = Date.now();
      const stepResult = await executeStep(task, stepMessages, agentTools, taskId, i + 1);
      const stepDuration = Date.now() - stepStartTime;

      log.info('agent', `Step ${i + 1} completed`, {
        action: stepResult.action,
        durationMs: stepDuration,
        observationLength: stepResult.observation.length,
        finished: stepResult.finished,
      });
      if (stepResult.action !== 'reason') {
        log.debug('agent', `Step ${i + 1} tool call`, {
          action: stepResult.action,
          inputPreview: typeof stepResult.input === 'object'
            ? JSON.stringify(stepResult.input).slice(0, 200)
            : String(stepResult.input).slice(0, 200),
          observationPreview: stepResult.observation.slice(0, 150),
        });
      }

      // Record step
      steps.push({
        thought: stepResult.thought,
        action: stepResult.action,
        input: stepResult.input,
        observation: stepResult.observation,
        ts: Date.now(),
        durationMs: stepDuration,
      });

      await updateAgentTask(taskId, {
        currentStep: i + 1,
        stepsJson: JSON.stringify(steps),
      });

      emitAgentEvent({
        type: 'step_end',
        taskId,
        step: i + 1,
        action: stepResult.action,
        observation: stepResult.observation.slice(0, 500),
        thought: stepResult.thought.slice(0, 300),
        durationMs: stepDuration,
        ts: Date.now(),
      });
      bufferEvent({
        type: 'step_end',
        taskId,
        step: i + 1,
        action: stepResult.action,
        observation: stepResult.observation.slice(0, 500),
        thought: stepResult.thought.slice(0, 300),
        durationMs: stepDuration,
        ts: Date.now(),
      });

      // Check if model decided to finish — ONLY on explicit "ГОТОВО:" signal.
      // Previously: any text without tool call ended the task prematurely.
      if (stepResult.finished) {
        log.info('agent', `Step ${i + 1} — model emitted "ГОТОВО" signal, breaking loop`);
        break;
      }
    }

    // ── 3. SYNTHESIZE ──
    log.info('agent', `SYNTHESIZE phase started (after ${steps.length} steps)`);
    await updateAgentTask(taskId, { status: 'synthesizing' });
    emitAgentEvent({ type: 'task_synthesizing', taskId, ts: Date.now() });
    bufferEvent({ type: 'task_synthesizing', taskId, ts: Date.now() });

    let dialogueHistory: Array<{ role: string; content: string }> = [];
    try {
      const recentMsgs = await getMessages(task.episodeId, 8);
      dialogueHistory = recentMsgs
        .filter(m => m.role === 'user' || m.role === 'companion')
        .slice(-6)
        .map(m => ({ role: m.role, content: m.content.slice(0, 300) }));
      log.debug('agent', `Dialogue history loaded (${dialogueHistory.length} messages)`);
    } catch (e) {
      log.warn('agent', 'Failed to load dialogue history for synthesize', {}, e);
    }

    const synthStart = Date.now();
    const resultSummary = await synthesize(task, plan, steps, dialogueHistory);
    log.info('agent', `Synthesis done (${Date.now() - synthStart}ms)`, {
      resultLength: resultSummary.length,
      resultPreview: resultSummary.slice(0, 200),
    });

    await updateAgentTask(taskId, {
      status: 'done',
      completedAt: new Date(),
      resultSummary,
      stepsJson: JSON.stringify(steps),
    });

    log.info('agent', 'Task DONE', {
      totalSteps: steps.length,
      totalMs: Date.now() - startTime,
    });

    emitAgentEvent({ type: 'task_done', taskId, resultSummary, ts: Date.now() });
    bufferEvent({ type: 'task_done', taskId, resultSummary, ts: Date.now() });
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    log.error('agent', 'Task FAILED', {
      error: errorMsg,
      phase: activeRunners.has(taskId) ? 'in-progress' : 'unknown',
    }, e);

    if (errorMsg === 'cancelled' || isCancelled(taskId)) {
      log.info('agent', 'Task was cancelled');
      await updateAgentTask(taskId, {
        status: 'cancelled',
        completedAt: new Date(),
        error: undefined,
      });
      emitAgentEvent({ type: 'task_cancelled', taskId, ts: Date.now() });
      bufferEvent({ type: 'task_cancelled', taskId, ts: Date.now() });
    } else {
      await updateAgentTask(taskId, {
        status: 'failed',
        completedAt: new Date(),
        error: errorMsg,
      });
      emitAgentEvent({ type: 'task_failed', taskId, error: errorMsg, ts: Date.now() });
      bufferEvent({ type: 'task_failed', taskId, error: errorMsg, ts: Date.now() });
    }
  } finally {
    // Чистим watchdog — задача завершилась нормально, страховка не нужна.
    clearTimeout(watchdogTimer);

    activeRunners.delete(taskId);
    clearCancellation(taskId);
    cancelWaiting(taskId);

    setTimeout(() => {
      clearBuffer(taskId);
    }, 5 * 60 * 1000).unref?.();
  }
}

// ============================================================================
// PLAN — generate structured plan
// ============================================================================
async function generatePlan(task: AgentTask, toolDescriptions: string): Promise<{
  goal: string;
  steps: string[];
  needsTools: boolean;
  complexity: 'low' | 'medium' | 'high';
}> {
  const model = await getChatModel();

  const systemPrompt = `Ты — планировщик задач для агента Лии.
Проанализируй задачу пользователя и составь пошаговый план выполнения.
Учитывай доступные инструменты:
${toolDescriptions}

Правила:
- Каждый шаг = одно действие (один инструмент или одно рассуждение)
- Не более ${task.maxSteps} шагов
- Будь конкретен: вместо "найди информацию" пиши "выполни web_search с запросом X"
- Если задача не требует инструментов — steps должен содержать рассуждения
- Сложность: low (1-2 шага), medium (3-5), high (6+)
- Для задач с кодом: включи шаги для изучения API (web_search + fetch_page), написания кода, проверки (code_run), сохранения (save_artifact)
- Для задач с интеграцией API: включи шаг для чтения документации через fetch_page

${task.fsScope ? `Рабочая директория: ${task.fsScope}` : 'Рабочая директория не задана — FS-операции недоступны.'}

Верни СТРОГО JSON.`;

  try {
    logger.debug('agent', 'Plan generation: calling LLM', { maxTokens: PLANNING_MAX_TOKENS });
    const result = await streamText({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Задача: "${task.goal}"` }],
      temperature: PLANNING_TEMPERATURE,
      maxOutputTokens: PLANNING_MAX_TOKENS,
      onError: (error) => {
        logger.error('agent', 'Plan streamText onError', { taskGoal: task.goal.slice(0, 80) }, error);
      },
    });

    // Таймаут 60 сек — если LLM не отвечает, fallback на дефолтный план.
    const text = await Promise.race([
      result.text,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('plan generation timeout (60s)')), 60_000)
      ),
    ]);
    logger.debug('agent', `Plan LLM responded (${text.length} chars)`, {
      preview: text.slice(0, 200),
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('agent', 'Plan: no JSON found in response, using fallback', {
        preview: text.slice(0, 200),
      });
      return fallbackPlan(task);
    }
    const parsed = JSON.parse(jsonMatch[0]);
    const validated = planSchema.safeParse(parsed);
    if (!validated.success) {
      logger.warn('agent', 'Plan: schema validation failed, using fallback', {
        errors: validated.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
      });
      return fallbackPlan(task);
    }
    return validated.data;
  } catch (e) {
    logger.warn('agent', 'Plan generation failed — using fallback', { goal: task.goal.slice(0, 80) }, e);
    return fallbackPlan(task);
  }
}

function fallbackPlan(task: AgentTask) {
  return {
    goal: task.goal,
    steps: ['Проанализировать задачу', 'Собрать информацию', 'Сформулировать ответ'],
    needsTools: true,
    complexity: 'medium' as const,
  };
}

// ============================================================================
// Build messages for a step — plan + previous steps + new prompt.
// Implements context window management: recent steps get full detail,
// older steps get summarized to prevent context overflow.
// ============================================================================
function buildStepMessages(
  task: AgentTask,
  plan: { goal: string; steps: string[] },
  previousSteps: Array<{ thought: string; action: string; input: unknown; observation: string }>,
  toolDescriptions: string,
  contextStr: string,
): { system: string; messages: ModelMessage[] } {
  const planStr = plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');

  // Context window management: recent 5 steps get full detail (thought + observation),
  // older steps get summarized (action + truncated observation only).
  // This prevents context overflow on long tasks (15+ steps).
  const RECENT_STEPS = 5;
  const stepsStr = previousSteps.length > 0
    ? previousSteps.map((s, i) => {
        const stepNum = i + 1;
        const isRecent = i >= previousSteps.length - RECENT_STEPS;
        if (isRecent) {
          // Full detail for recent steps
          return `Шаг ${stepNum}: [${s.action}] ${s.thought}\nРезультат: ${s.observation.slice(0, 500)}`;
        }
        // Summarized for older steps
        return `Шаг ${stepNum}: [${s.action}] ${s.observation.slice(0, 200)}`;
      }).join('\n\n')
    : '(пока нет предыдущих шагов)';

  const systemPrompt = `Ты — агент Лия. Выполняешь задачу: "${task.goal}"

План:
${planStr}

Доступные инструменты:
${toolDescriptions}

${contextStr ? `Контекст:\n${contextStr}\n` : ''}
Правила:
- Вызывай инструмент если нужен внешний ресурс (файл, сеть, поиск, выполнение кода)
- Для сложных задач: сначала ИЗУЧИ нужные API через web_search + fetch_page, ПОТОМ пиши код, ПОТОМ проверь через code_run, ПОТОМ сохрани через save_artifact
- Если задача требует код — пиши ПОЛНЫЙ рабочий код, не фрагменты. Используй code_run для проверки перед сохранением.
- Если нужен многофайловый проект — сохрани каждый файл отдельным save_artifact вызовом
- Если результат предыдущего шага достаточен — отвечай текстом "ГОТОВО: <краткое резюме>" чтобы завершить
- Если нужен уточняющий вопрос пользователю — вызови ask_user
- Не повторяй одни и те же действия
- Если инструмент вернул ошибку — проанализируй причину и попробуй другой подход
- Будь эффективна: каждый шаг должен приближать к цели
- Для задач с API: изучи актуальную документацию через fetch_page, не полагайся только на свои знания`;

  const userPrompt = `Предыдущие шаги:
${stepsStr}

Что делаем дальше?`;

  return {
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }] as ModelMessage[],
  };
}

// ============================================================================
// Execute a single step — streamText with tools
// ============================================================================
type StepResult = {
  thought: string;
  action: string;
  input: unknown;
  observation: string;
  finished: boolean;
};

async function executeStep(
  task: AgentTask,
  stepData: { system: string; messages: ModelMessage[] },
  tools: ToolSet,
  taskId: string,
  stepNum: number,
): Promise<StepResult> {
  const log = logger.context({ taskId: taskId.slice(0, 8), step: stepNum });
  const model = await getChatModel();
  const { system, messages } = stepData;

  let fullText = '';
  const toolCalls: Array<{ name: string; input: unknown; output: unknown; success: boolean }> = [];

  const modelName = (model as unknown as { modelId?: string }).modelId ?? '';
  const knownBadToolModels = ['gemma3:4b', 'gemma3:1b', 'phi3', 'tinyllama'];
  const tryWithTools = !knownBadToolModels.some(m => modelName.includes(m));

  log.debug('agent', `executeStep — model=${modelName}, tryWithTools=${tryWithTools}`);

  // ── Attempt 1: with tools (native tool calling) ──
  if (tryWithTools) {
    const result = streamText({
      model,
      system,
      messages,
      tools,
      stopWhen: isStepCount(3),
      temperature: EXECUTION_TEMPERATURE,
      maxOutputTokens: EXECUTION_MAX_TOKENS,
      onError: (error) => {
        log.error('agent', `Step ${stepNum} streamText (with tools) onError`, { modelName }, error);
      },
      onStepFinish: ({ toolCalls: tcs, toolResults: trs }) => {
        if (tcs) {
          for (let i = 0; i < tcs.length; i++) {
            const tc = tcs[i] as { toolName: string; input: unknown };
            const tr = trs?.[i] as { output: unknown; error?: string } | undefined;
            log.info('tools', `Tool call: ${tc.toolName}`, {
              success: !tr?.error,
              inputPreview: JSON.stringify(tc.input).slice(0, 150),
              outputPreview: tr?.output != null
                ? (typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output)).slice(0, 150)
                : 'null',
            });
            emitAgentEvent({
              type: 'tool_start', taskId, step: stepNum, tool: tc.toolName, input: tc.input, ts: Date.now(),
            });
            emitAgentEvent({
              type: 'tool_end', taskId, step: stepNum, tool: tc.toolName, success: !tr?.error, output: tr?.output, ts: Date.now(),
            });
            toolCalls.push({ name: tc.toolName, input: tc.input, output: tr?.output, success: !tr?.error });
          }
        }
      },
    });

    try {
      // Race с таймаутом — если Ollama зависнет (например, при загрузке модели),
      // мы не блокируем агентский цикл навсегда.
      const startMs = Date.now();
      fullText = await Promise.race([
        result.text,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('streamText timeout (60s)')), 60_000)
        ),
      ]);
      log.debug('agent', `Step ${stepNum} streamText (with tools) done (${Date.now() - startMs}ms)`, {
        textLength: fullText.length,
        toolCallsCount: toolCalls.length,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn('agent', `Step ${stepNum} streamText (with tools) failed — retrying without tools`, { error: msg });
      fullText = '';
    }
  }

  // ── Attempt 2: without tools (text-only fallback) ──
  if (!fullText && toolCalls.length === 0) {
    log.info('agent', `Step ${stepNum} fallback to text-only mode`);
    const result = streamText({
      model,
      system: system + '\n\nВАЖНО: У тебя нет прямого доступа к инструментам. Вместо вызова инструмента, опиши в тексте какое действие нужно выполнить и почему.',
      messages,
      temperature: EXECUTION_TEMPERATURE,
      maxOutputTokens: EXECUTION_MAX_TOKENS,
      onError: (error) => {
        log.error('agent', `Step ${stepNum} streamText (fallback) onError`, { modelName }, error);
      },
    });

    try {
      const startMs = Date.now();
      fullText = await Promise.race([
        result.text,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('streamText timeout (60s)')), 60_000)
        ),
      ]);
      log.debug('agent', `Step ${stepNum} fallback streamText done (${Date.now() - startMs}ms)`, {
        textLength: fullText.length,
      });
    } catch (e) {
      fullText = `Ошибка: ${e instanceof Error ? e.message : String(e)}`;
      log.error('agent', `Step ${stepNum} fallback streamText failed`, {}, e);
    }
  }

  // Determine action
  let action = 'reason';
  let input: unknown = {};
  let observation = '';

  if (toolCalls.length > 0) {
    const last = toolCalls[toolCalls.length - 1];
    action = last.name;
    input = last.input;
    const out = last.output;
    if (out == null) {
      observation = '(no output)';
    } else if (typeof out === 'string') {
      observation = out.slice(0, OBSERVATION_CAP);
    } else {
      observation = JSON.stringify(out).slice(0, OBSERVATION_CAP);
    }
  } else {
    observation = fullText.slice(0, OBSERVATION_CAP);
  }

  // Check for completion — ONLY on explicit "ГОТОВО:" signal.
  // Previously: any text without tool call ended the task prematurely,
  // preventing the model from "thinking out loud" between tool calls.
  const finished = /^ГОТОВО:/i.test(fullText.trim());

  return {
    thought: fullText.slice(0, 500),
    action,
    input,
    observation,
    finished,
  };
}

// ============================================================================
// SYNTHESIZE — final answer from all gathered info
// ============================================================================
async function synthesize(
  task: AgentTask,
  plan: { goal: string; steps: string[] },
  steps: Array<{ thought: string; action: string; observation: string }>,
  dialogueHistory: Array<{ role: string; content: string }> = [],
): Promise<string> {
  const model = await getChatModel();

  const stepsBlock = steps.length > 0
    ? steps.map((s, i) =>
        `### Шаг ${i + 1}: ${s.action}\n**Мысль:** ${s.thought}\n**Результат:** ${s.observation.slice(0, 800)}`
      ).join('\n\n')
    : 'Исследование не дало результатов.';

  const dialogueBlock = dialogueHistory.length > 0
    ? dialogueHistory.map(m =>
        `${m.role === 'user' ? 'Пользователь' : 'Лия'}: ${m.content}`
      ).join('\n')
    : '(контекст диалога отсутствует)';

  const systemPrompt = `Ты — Лия. После цикла исследований и инструментов ты должна дать финальный ответ пользователю.

Используй всю информацию, собранную на предыдущих шагах. Цитируй конкретные находки.
Учитывай контекст диалога который был ДО запуска агентской задачи — пользователь может ссылаться на предыдущие сообщения.
Отвечай от первого лица, как Лия.
Структурируй ответ если он сложный (списки, заголовки).
Не выдумывай информацию, которой нет в результатах шагов.
Если задача не выполнена полностью — честно скажи что получилось и что нет.
Длина: до 400 слов.`;

  const userPrompt = `Задача: "${task.goal}"

План: ${plan.goal}

Контекст диалога (что обсуждалось раньше):
${dialogueBlock}

Результаты исследования:
${stepsBlock}`;

  try {
    logger.debug('agent', `Synthesize: calling LLM (${SYNTHESIS_MAX_TOKENS} tokens max)`, {
      stepsCount: steps.length,
      dialogueLength: dialogueHistory.length,
    });
    const result = await streamText({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: SYNTHESIS_TEMPERATURE,
      maxOutputTokens: SYNTHESIS_MAX_TOKENS,
      onError: (error) => {
        logger.error('agent', 'Synthesize streamText onError', { taskGoal: task.goal.slice(0, 80) }, error);
      },
    });

    // Таймаут 90 сек — синтез может быть длинным на сложных задачах.
    const text = await Promise.race([
      result.text,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('synthesize timeout (90s)')), 90_000)
      ),
    ]);
    logger.debug('agent', `Synthesize LLM responded (${text.length} chars)`);
    return text.trim();
  } catch (e) {
    logger.error('agent', 'Synthesize failed', { taskGoal: task.goal.slice(0, 80) }, e);
    return `Не удалось сформулировать итоговый ответ: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ============================================================================
// Pause task — wait for user input.
// Returns the user's answer string. Has a timeout to prevent hanging forever.
// Emits task_waiting_input event so UI shows the question input.
// ============================================================================
async function pauseTaskForInput(taskId: string, question: string): Promise<string> {
  logger.info('agent', `Pausing for user input`, {
    taskId: taskId.slice(0, 8),
    question: question.slice(0, 100),
  });
  await updateAgentTask(taskId, { status: 'waiting_input' });

  // Emit event so SSE client shows the question input UI.
  // Previously this was only emitted by ask_user tool, not by budget/loop pauses.
  emitAgentEvent({ type: 'task_waiting_input', taskId, question, ts: Date.now() });
  bufferEvent({ type: 'task_waiting_input', taskId, question, ts: Date.now() });

  return new Promise<string>((resolve, reject) => {
    let interval: NodeJS.Timeout | null = null;
    let timeout: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (interval) clearInterval(interval);
      if (timeout) clearTimeout(timeout);
    };

    setWaiting(taskId, {
      question,
      resolve: (answer: string) => {
        cleanup();
        logger.info('agent', `User answered pause`, {
          taskId: taskId.slice(0, 8),
          answerPreview: answer.slice(0, 80),
        });
        // DB update might fail — resolve anyway so the agent loop continues.
        // If status update fails, the runner will re-set it on next step.
        updateAgentTask(taskId, { status: 'executing' })
          .catch(() => null)
          .then(() => resolve(answer));
      },
      reject: (err: Error) => {
        cleanup();
        logger.warn('agent', `Pause rejected`, {
          taskId: taskId.slice(0, 8),
          error: err.message,
        });
        reject(err);
      },
    });

    // Check for cancellation every 500ms
    interval = setInterval(() => {
      if (isCancelled(taskId)) {
        cleanup();
        reject(new Error('cancelled'));
      }
    }, 500);

    // Timeout — prevent hanging forever if user doesn't respond
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error('timeout: user did not respond within 5 minutes'));
    }, ASK_USER_TIMEOUT_MS);

    // Allow unref so timeout doesn't keep process alive
    timeout.unref?.();
    interval.unref?.();
  });
}

// ============================================================================
// Cancel — called from API
// ============================================================================
export async function cancelAgentTaskRun(taskId: string): Promise<void> {
  logger.info('agent', `Cancel requested`, { taskId: taskId.slice(0, 8) });
  signalCancellation(taskId);
  cancelWaiting(taskId);

  // Даём бегущему циклу 200мс на реакцию (isCancelled проверяется между шагами).
  await new Promise(r => setTimeout(r, 200));

  const task = await getAgentTask(taskId);
  if (task && task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'failed') {
    logger.warn('agent', `Cancel: task was still in status '${task.status}', force-marking as cancelled`);
    await updateAgentTask(taskId, {
      status: 'cancelled',
      completedAt: new Date(),
    });
  } else {
    logger.debug('agent', `Cancel: task already in terminal status`, { status: task?.status });
  }
}
