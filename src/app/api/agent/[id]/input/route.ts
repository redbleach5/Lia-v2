// POST /api/agent/[id]/input — provide user input to a paused (waiting_input) task.

import { NextRequest, NextResponse } from 'next/server';
import { getAgentTask, updateAgentTask } from '@/lib/agent/task';
import { resolveWaiting, isWaiting } from '@/lib/agent/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const body = await req.json().catch(() => ({}));
    const answer: string | undefined = body?.answer;

    if (!answer || typeof answer !== 'string' || answer.trim().length === 0) {
      return NextResponse.json({ error: 'answer required' }, { status: 400 });
    }

    const task = await getAgentTask(id);
    if (!task) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    if (task.status !== 'waiting_input') {
      return NextResponse.json({ error: `task is ${task.status}, not waiting_input` }, { status: 400 });
    }

    if (!isWaiting(id)) {
      // Task was cancelled or timed out
      return NextResponse.json({ error: 'task is not actively waiting' }, { status: 400 });
    }

    const ok = resolveWaiting(id, answer);
    if (!ok) {
      return NextResponse.json({ error: 'failed to resolve' }, { status: 500 });
    }

    // Status will be flipped back to 'executing' by the runner's pauseTaskForInput
    // — but we also flip it here for UI immediacy.
    await updateAgentTask(id, { status: 'executing' });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[api/agent/[id]/input] failed:', e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
