// POST /api/agent/[id]/input — provide user input to a paused (waiting_input) task.

import { NextRequest, NextResponse } from 'next/server';
import { getAgentTask, updateAgentTask } from '@/lib/agent/task';
import { resolveWaiting, isWaiting } from '@/lib/agent/events';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const log = logger.context({ taskId: id.slice(0, 8) });

  try {
    const body = await req.json().catch(() => ({}));
    const answer: string | undefined = body?.answer;

    if (!answer || typeof answer !== 'string' || answer.trim().length === 0) {
      log.warn('agent', 'Input rejected — empty answer', { answerLength: answer?.length ?? 0 });
      return NextResponse.json({ error: 'answer required' }, { status: 400 });
    }

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
    // ВАЖНО: в dev-режиме Next.js hot-reload может сбросить in-memory state
    // (модуль events.ts переоценивается, Map waitingTasks очищается).
    // Если задача в БД всё ещё waiting_input, но in-memory state потерян —
    // мы не можем "разрешить" promise (он уже не существует).
    // В этом случае помечаем задачу как failed с понятной ошибкой —
    // пользователь должен перезапустить задачу.
    if (!isWaiting(id)) {
      log.error('agent', 'Input rejected — in-memory waiting state lost (likely server hot-reload)', {
        dbStatus: task.status,
        answerPreview: answer.slice(0, 80),
      });
      // Помечаем задачу как failed — больше ничего не можем сделать.
      // Раньше здесь возвращался 400 без объяснений, и пользователь не понимал что произошло.
      await updateAgentTask(id, {
        status: 'failed',
        completedAt: new Date(),
        error: `Сессия ожидания была потеряна (возможно из-за hot-reload в dev-режиме). Пользователь ответил: "${answer.slice(0, 100)}". Перезапустите задачу.`,
      });
      return NextResponse.json({
        error: 'waiting state lost',
        message: 'Сервер был перезагружен во время ожидания ответа. Задача помечена как failed. Перезапустите задачу.',
        userAnswer: answer.slice(0, 200),
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
