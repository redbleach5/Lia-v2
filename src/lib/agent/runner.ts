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

import { streamText, convertToModelMessages, type ModelMessage } from 'ai';
import { getChatModel } from '@/lib/ollama';
import { db } from '@/lib/db';
import { z } from 'zod';
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
  isCancelled,
  clearCancellation,
  cancelWaiting,
  isWaiting,
  setWaiting,
  signalCancellation,
} from './events';
import { getEpisodeFacts } from '@/lib/memory/facts';
import { recall } from '@/lib/memory/vector';

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
const OBSERVATION_CAP = 3000; // truncate observations to avoid context bloat

// ============================================================================
// Active runners — singleton per task (prevent double-start)
// ============================================================================
const activeRunners = new Set<string>();

export function isRunning(taskId: string): boolean {
  return activeRunners.has(taskId);
}

// ============================================================================
// Main entry point
// ============================================================================
export async function runAgentTask(taskId: string): Promise<void> {
  if (activeRunners.has(taskId)) {
    console.warn(`[agent:runner] task ${taskId} already running, skipping`);
    return;
  }

  const task = await getAgentTask(taskId);
  if (!task) {
    console.error(`[agent:runner] task ${taskId} not found`);
    return;
  }
  if (task.status === 'done' || task.status === 'cancelled') {
    console.warn(`[agent:runner] task ${taskId} already ${task.status}`);
    return;
  }

  activeRunners.add(taskId);
  clearCancellation(taskId);

  try {
    await updateAgentTask(taskId, {
      status: 'planning',
      startedAt: task.startedAt ?? new Date(),
    });
    emitAgentEvent({ type: 'task_started', taskId, goal: task.goal, ts: Date.now() });
    bufferEvent({ type: 'task_started', taskId, goal: task.goal, ts: Date.now() });

    // ── 1. PLAN ──
    emitAgentEvent({ type: 'task_planning', taskId, ts: Date.now() });
    bufferEvent({ type: 'task_planning', taskId, ts: Date.now() });

    const plan = await generatePlan(task);
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
    await updateAgentTask(taskId, { status: 'executing' });

    const steps = parseSteps(task.stepsJson);
    const agentTools = buildAgentTools(task);
    const startTime = Date.now();

    let lastCancelledCheck = Date.now();

    for (let i = 0; i < task.maxSteps; i++) {
      // Cancellation check (every 500ms via polling inside this sync block)
      if (Date.now() - lastCancelledCheck > 500) {
        lastCancelledCheck = Date.now();
      }
      if (isCancelled(taskId)) {
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
        await pauseTaskForInput(taskId, `Превышен лимит времени (${task.maxDurationSec} сек). Продолжить ещё на N секунд или остановиться?`);
        if (isCancelled(taskId)) continue;
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
          await pauseTaskForInput(taskId, `Похоже, я застряла в цикле: ${reason}. Подскажи, как поступить?`);
          if (isCancelled(taskId)) continue;
        }
      }

      // ── Build messages for this step ──
      const stepMessages = await buildStepMessages(task, plan, steps);

      emitAgentEvent({
        type: 'step_start',
        taskId,
        step: i + 1,
        maxSteps: task.maxSteps,
        thought: `Шаг ${i + 1}`,
        ts: Date.now(),
      });

      const stepStartTime = Date.now();
      const stepResult = await executeStep(task, stepMessages, agentTools, taskId, i + 1);
      const stepDuration = Date.now() - stepStartTime;

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
        durationMs: stepDuration,
        ts: Date.now(),
      });
      bufferEvent({
        type: 'step_end',
        taskId,
        step: i + 1,
        action: stepResult.action,
        observation: stepResult.observation.slice(0, 500),
        durationMs: stepDuration,
        ts: Date.now(),
      });

      // Check if model decided to finish
      if (stepResult.finished) {
        break;
      }
    }

    // ── 3. SYNTHESIZE ──
    await updateAgentTask(taskId, { status: 'synthesizing' });
    emitAgentEvent({ type: 'task_synthesizing', taskId, ts: Date.now() });
    bufferEvent({ type: 'task_synthesizing', taskId, ts: Date.now() });

    const resultSummary = await synthesize(task, plan, steps);

    await updateAgentTask(taskId, {
      status: 'done',
      completedAt: new Date(),
      resultSummary,
      stepsJson: JSON.stringify(steps),
    });

    emitAgentEvent({ type: 'task_done', taskId, resultSummary, ts: Date.now() });
    bufferEvent({ type: 'task_done', taskId, resultSummary, ts: Date.now() });
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    console.error(`[agent:runner] task ${taskId} failed:`, e);

    // If user cancelled via ask_user reject
    if (errorMsg === 'cancelled' || isCancelled(taskId)) {
      await updateAgentTask(taskId, {
        status: 'cancelled',
        completedAt: new Date(),
        error: null,
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
    activeRunners.delete(taskId);
    clearCancellation(taskId);
    cancelWaiting(taskId);
  }
}

// ============================================================================
// PLAN — generate structured plan
// ============================================================================
async function generatePlan(task: AgentTask): Promise<{
  goal: string;
  steps: string[];
  needsTools: boolean;
  complexity: 'low' | 'medium' | 'high';
}> {
  const model = await getChatModel();
  const tools = buildAgentTools(task);

  const systemPrompt = `Ты — планировщик задач для агента Лии.
Проанализируй задачу пользователя и составь пошаговый план выполнения.
Учитывай доступные инструменты:
${describeTools(tools)}

Правила:
- Каждый шаг = одно действие (один инструмент или одно рассуждение)
- Не более ${task.maxSteps} шагов
- Будь конкретен: вместо "найди информацию" пиши "выполни web_search с запросом X"
- Если задача не требует инструментов — steps должен содержать рассуждения
- Сложность: low (1-2 шага), medium (3-5), high (6+)

${task.fsScope ? `Рабочая директория: ${task.fsScope}` : 'Рабочая директория не задана — FS-операции недоступны.'}

Верни СТРОГО JSON.`;

  try {
    const result = await streamText({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Задача: "${task.goal}"` }],
      temperature: PLANNING_TEMPERATURE,
      maxTokens: 600,
    });

    const text = await result.text;

    // Try to extract JSON from text (model may wrap in markdown fences)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return fallbackPlan(task);
    }
    const parsed = JSON.parse(jsonMatch[0]);
    const validated = planSchema.safeParse(parsed);
    if (!validated.success) {
      return fallbackPlan(task);
    }
    return validated.data;
  } catch (e) {
    console.warn('[agent:runner] plan generation failed:', e);
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
// Build messages for a step — plan + previous steps + new prompt
// ============================================================================
async function buildStepMessages(
  task: AgentTask,
  plan: { goal: string; steps: string[] },
  previousSteps: Array<{ thought: string; action: string; input: unknown; observation: string }>,
): Promise<ModelMessage[]> {
  const tools = buildAgentTools(task);

  const planStr = plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const stepsStr = previousSteps.length > 0
    ? previousSteps.map((s, i) =>
        `Шаг ${i + 1}: [${s.action}] ${s.thought}\nРезультат: ${s.observation.slice(0, 500)}`
      ).join('\n\n')
    : '(пока нет предыдущих шагов)';

  // Episode context
  const [episodeFacts, vectorHits] = await Promise.all([
    getEpisodeFacts(task.episodeId),
    recall({ episodeId: task.episodeId, query: task.goal, limit: 2, minSimilarity: 0.4 }).catch(() => []),
  ]);

  const contextStr = [
    episodeFacts.length > 0 ? 'Контекст чата:\n' + episodeFacts.map(f => `${f.key}: ${f.value}`).join('\n') : '',
    vectorHits.length > 0 ? 'Релевантные воспоминания:\n' + vectorHits.map(h => h.text.slice(0, 300)).join('\n---\n') : '',
  ].filter(Boolean).join('\n\n');

  const systemPrompt = `Ты — агент Лия. Выполняешь задачу: "${task.goal}"

План:
${planStr}

Доступные инструменты:
${describeTools(tools)}

${contextStr ? `Контекст:\n${contextStr}\n` : ''}
Правила:
- Вызывай инструмент если нужен внешний ресурс (файл, сеть, поиск)
- Если результат предыдущего шага достаточен — отвечай текстом "ГОТОВО: <краткое резюме>" чтобы завершить
- Если нужен уточняющий вопрос пользователю — вызови ask_user
- Не повторяй одни и те же действия
- Если инструмент вернул ошибку — попробуй другой подход
- Будь эффективна: каждый шаг должен приближать к цели`;

  const userPrompt = `Предыдущие шаги:
${stepsStr}

Что делаем дальше?`;

  return convertToModelMessages([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
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
  messages: ModelMessage[],
  tools: Record<string, ReturnType<typeof import('ai').tool>>,
  taskId: string,
  stepNum: number,
): Promise<StepResult> {
  const model = await getChatModel();

  let fullText = '';
  const toolCalls: Array<{ name: string; input: unknown; output: unknown; success: boolean }> = [];

  const result = streamText({
    model,
    messages,
    tools,
    maxSteps: 3, // allow tool chaining within one step
    temperature: EXECUTION_TEMPERATURE,
    maxTokens: 1500,
    onStepFinish: ({ toolCalls: tcs, toolResults: trs }) => {
      if (tcs) {
        for (let i = 0; i < tcs.length; i++) {
          const tc = tcs[i];
          const tr = trs?.[i];
          emitAgentEvent({
            type: 'tool_start',
            taskId,
            step: stepNum,
            tool: tc.toolName,
            input: tc.args,
            ts: Date.now(),
          });
          emitAgentEvent({
            type: 'tool_end',
            taskId,
            step: stepNum,
            tool: tc.toolName,
            success: !tr?.error,
            output: tr?.result,
            ts: Date.now(),
          });
          toolCalls.push({
            name: tc.toolName,
            input: tc.args,
            output: tr?.result,
            success: !tr?.error,
          });
        }
      }
    },
  });

  try {
    fullText = await result.text;
  } catch (e) {
    fullText = `Ошибка: ${e instanceof Error ? e.message : String(e)}`;
  }

  // Determine action
  let action = 'reason';
  let input: unknown = {};
  let observation = '';

  if (toolCalls.length > 0) {
    const last = toolCalls[toolCalls.length - 1];
    action = last.name;
    input = last.input;
    observation = typeof last.output === 'string'
      ? last.output.slice(0, OBSERVATION_CAP)
      : JSON.stringify(last.output).slice(0, OBSERVATION_CAP);
  } else {
    observation = fullText.slice(0, OBSERVATION_CAP);
  }

  // Check for completion signal
  const finished = /^ГОТОВО:/i.test(fullText.trim()) || (toolCalls.length === 0 && fullText.length > 0 && !fullText.toLowerCase().includes('нужно ещё'));

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
): Promise<string> {
  const model = await getChatModel();

  const stepsBlock = steps.length > 0
    ? steps.map((s, i) =>
        `### Шаг ${i + 1}: ${s.action}\n**Мысль:** ${s.thought}\n**Результат:** ${s.observation.slice(0, 800)}`
      ).join('\n\n')
    : 'Исследование не дало результатов.';

  const systemPrompt = `Ты — Лия. После цикла исследований и инструментов ты должна дать финальный ответ пользователю.

Используй всю информацию, собранную на предыдущих шагах. Цитируй конкретные находки.
Отвечай от первого лица, как Лия.
Структурируй ответ если он сложный (списки, заголовки).
Не выдумывай информацию, которой нет в результатах шагов.
Если задача не выполнена полностью — честно скажи что получилось и что нет.
Длина: до 400 слов.`;

  const userPrompt = `Задача: "${task.goal}"

План: ${plan.goal}

Результаты исследования:
${stepsBlock}`;

  try {
    const result = await streamText({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: SYNTHESIS_TEMPERATURE,
      maxTokens: 1500,
    });
    return (await result.text).trim();
  } catch (e) {
    return `Не удалось сформулировать итоговый ответ: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ============================================================================
// Pause task — wait for user input
// ============================================================================
async function pauseTaskForInput(taskId: string, question: string): Promise<void> {
  await updateAgentTask(taskId, { status: 'waiting_input' });

  return new Promise((resolve, reject) => {
    setWaiting(taskId, {
      question,
      resolve: () => {
        // After user responds, switch back to executing
        updateAgentTask(taskId, { status: 'executing' }).then(() => resolve());
      },
      reject: (err: Error) => reject(err),
    });

    // Also check for cancellation periodically
    const interval = setInterval(() => {
      if (isCancelled(taskId)) {
        clearInterval(interval);
        reject(new Error('cancelled'));
      }
    }, 500);
  });
}

// ============================================================================
// Cancel — called from API
// ============================================================================
export async function cancelAgentTaskRun(taskId: string): Promise<void> {
  signalCancellation(taskId);
  cancelWaiting(taskId);

  // Wait a bit for the runner to notice
  await new Promise(r => setTimeout(r, 200));

  // Force-update if still running
  const task = await getAgentTask(taskId);
  if (task && task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'failed') {
    await updateAgentTask(taskId, {
      status: 'cancelled',
      completedAt: new Date(),
    });
  }
}
