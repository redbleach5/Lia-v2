// POST /api/agent/[id]/input — provide user input to a paused (waiting_input) task.

import { NextRequest, NextResponse } from 'next/server';
import { getAgentTask, updateAgentTask } from '@/lib/agent/task';
import { resolveWaiting, isWaiting } from '@/lib/agent/events';
import { logger } from '@/lib/logger';
import { parseBody, agentInputSchema } from '@/lib/infra/api-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const log = logger.context({ taskId: id.slice(0, 8) });

  try {
    const parsed = await parseBody(req, agentInputSchema);
    if (!parsed.success) return parsed.response;
    const { answer } = parsed.data;

    const task = await getAgentTask(id);
    if (!task) {
      log.warn('agent', 'Input rejected — task not found');
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    if (task.status !== 'waiting_input') {
      log.warn('agent', `Input rejected — task is ${task.status}, not waiting_input`);
      return NextResponse.json({
        error: `task is ${task.status}, not waiting_input`,
        currentStatus: task.status,
      }, { status: 400 });
    }

    // Проверяем in-memory waiting state.
    //
    // ВАЖНО: при HMR/restart in-memory Map waitingTasks теряется.
    // Раньше мы помечали задачу как failed — это портило данные пользователя.
    // Теперь: возвращаем 409 с понятным сообщением, НЕ трогая задачу в БД.
    // Пользователь может перезапустить задачу (POST /api/agent/[id]/start
    // уже умеет reset failed → pending).
    //
    // Полный resume (с восстановлением состояния ожидания) — Phase 4.1
    // через checkpointJson.
    if (!isWaiting(id)) {
      log.error('agent', 'Input rejected — in-memory waiting state lost (likely server hot-reload)', {
        dbStatus: task.status,
        answerPreview: answer.slice(0, 80),
      });
      // НЕ помечаем задачу как failed — оставляем как есть, чтобы пользователь
      // мог перезапустить её через /start без потери прогресса.
      return NextResponse.json({
        error: 'waiting state lost',
        message: 'Сервер был перезагружен во время ожидания ответа. Перезапустите задачу — она продолжит с последнего шага.',
        userAnswer: answer.slice(0, 200),
        restartUrl: `/api/agent/${id}/start`,
      }, { status: 409 });
    }

    const ok = resolveWaiting(id, answer);
    if (!ok) {
      log.error('agent', 'Input: resolveWaiting returned false (race condition)');
      return NextResponse.json({ error: 'failed to resolve' }, { status: 500 });
    }

    log.info('agent', `Input accepted: "${answer.slice(0, 80)}"`);

    // Status will be flipped back to 'executing' by the runner's pauseTaskForInput
    // — but we also flip it here for UI immediacy.
    await updateAgentTask(id, { status: 'executing' });

    return NextResponse.json({ ok: true });
  } catch (e) {
    log.error('agent', '/input failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
