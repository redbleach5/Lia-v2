// GET  /api/agent — list agent tasks (optional ?episodeId=...)
// POST /api/agent — create a new agent task and auto-start the runner

import { NextRequest, NextResponse } from 'next/server';
import { listAgentTasks, createAgentTask, type AgentTaskStatus } from '@/lib/agent/task';
import { runAgentTask } from '@/lib/agent/runner';
import { getCognitiveParams } from '@/lib/capability-profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const episodeId = req.nextUrl.searchParams.get('episodeId') ?? undefined;
    const status = req.nextUrl.searchParams.get('status') as AgentTaskStatus | null;

    let tasks = await listAgentTasks(episodeId);
    if (status) {
      tasks = tasks.filter(t => t.status === status);
    }
    return NextResponse.json({ tasks });
  } catch (e) {
    console.error('[api/agent] GET failed:', e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    const episodeId: string | undefined = body?.episodeId;
    const goal: string | undefined = body?.goal;
    const toolsWhitelist: string[] | undefined = body?.toolsWhitelist;
    const fsScope: string | undefined = body?.fsScope;
    const maxSteps: number | undefined = body?.maxSteps;
    const maxDurationSec: number | undefined = body?.maxDurationSec;
    const autoStart: boolean = body?.autoStart !== false; // default true

    if (!episodeId) {
      return NextResponse.json({ error: 'episodeId required' }, { status: 400 });
    }
    if (!goal || typeof goal !== 'string' || goal.trim().length === 0) {
      return NextResponse.json({ error: 'goal required' }, { status: 400 });
    }

    // Get capability profile to set adaptive agent limits
    const { params: tierParams } = await getCognitiveParams();

    const task = await createAgentTask({
      episodeId,
      goal: goal.trim(),
      toolsWhitelist: Array.isArray(toolsWhitelist) ? toolsWhitelist : null,
      fsScope: typeof fsScope === 'string' ? fsScope : null,
      // Use tier-adaptive limits if not explicitly provided
      maxSteps: typeof maxSteps === 'number'
        ? Math.min(tierParams.agentMaxSteps, Math.max(1, maxSteps))
        : tierParams.agentMaxSteps,
      maxDurationSec: typeof maxDurationSec === 'number'
        ? Math.min(tierParams.agentMaxDurationSec, Math.max(60, maxDurationSec))
        : tierParams.agentMaxDurationSec,
    });

    // Auto-start the runner unless caller opted out
    if (autoStart) {
      runAgentTask(task.id).catch((e) => {
        console.error(`[api/agent] runner crashed for task ${task.id}:`, e);
      });
    }

    return NextResponse.json({ task }, { status: 201 });
  } catch (e) {
    console.error('[api/agent] POST failed:', e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
