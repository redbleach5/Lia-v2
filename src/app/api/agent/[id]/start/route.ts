// POST /api/agent/[id]/start — start the agent runner for a task.
//
// Marks task as 'pending' → 'planning' and triggers runAgentTask in background.
// The HTTP response returns immediately with the updated task; client subscribes
// to /api/agent/[id]/stream for real-time updates.

import { NextRequest, NextResponse } from 'next/server';
import { getAgentTask, updateAgentTask } from '@/lib/agent/task';
import { runAgentTask, isRunning } from '@/lib/agent/runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Don't auto-start on import — runner is triggered explicitly by POST.

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const task = await getAgentTask(id);
    if (!task) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    if (isRunning(id)) {
      return NextResponse.json({ error: 'task is already running' }, { status: 409 });
    }

    if (task.status === 'done' || task.status === 'cancelled') {
      return NextResponse.json({ error: `task already ${task.status}` }, { status: 400 });
    }

    // Reset to pending if was waiting_input (resume case)
    if (task.status === 'waiting_input' || task.status === 'failed') {
      await updateAgentTask(id, { status: 'pending', error: undefined });
    }

    // Trigger runner in background — don't await
    runAgentTask(id).catch((e) => {
      console.error(`[api/agent/${id}/start] runner crashed:`, e);
    });

    // Give it a moment to flip status, then return current state
    await new Promise((r) => setTimeout(r, 100));
    const updated = await getAgentTask(id);

    return NextResponse.json({ task: updated });
  } catch (e) {
    console.error('[api/agent/[id]/start] failed:', e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
