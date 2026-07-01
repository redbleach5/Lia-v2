// GET  /api/agent — list agent tasks (optional ?episodeId=...)
// POST /api/agent — create a new agent task and auto-start the runner

import { NextRequest, NextResponse } from 'next/server';
import { listAgentTasks, createAgentTask, type AgentTaskStatus } from '@/lib/agent/task';
import { runAgentTask, sweepStaleTasks } from '@/lib/agent/runner';
import { getCognitiveParams } from '@/lib/capability-profile';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '@/lib/paths';
import { randomUUID } from 'crypto';
import { logger } from '@/lib/logger';
import { parseBody, createAgentTaskSchema } from '@/lib/infra/api-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Sweep flag — in-memory, prevents multiple sweeps per process lifetime.
// Sweep помечает stale задачи (planning/executing/...) как failed.
// Выполняется один раз при первом обращении к /api/agent после старта сервера.
let sweepDone = false;

export async function GET(req: NextRequest) {
  try {
    // Lazy sweep on first call — помечаем зависшие задачи после рестарта.
    if (!sweepDone) {
      sweepDone = true;
      await sweepStaleTasks().catch(() => null);
    }

    const episodeId = req.nextUrl.searchParams.get('episodeId') ?? undefined;
    const status = req.nextUrl.searchParams.get('status') as AgentTaskStatus | null;

    let tasks = await listAgentTasks(episodeId);
    if (status) {
      tasks = tasks.filter(t => t.status === status);
    }
    return NextResponse.json({ tasks });
  } catch (e) {
    logger.error('agent', 'GET failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, createAgentTaskSchema);
    if (!parsed.success) return parsed.response;
    const { episodeId, goal, autoStart, fsScope, toolsWhitelist, maxSteps, maxDurationSec } = parsed.data;

    // Get capability profile to set adaptive agent limits
    const { params: tierParams } = await getCognitiveParams();

    // Auto-create workspace directory if not provided.
    // Each agent task gets its own directory under download/agent-workspaces/<taskId>
    // This ensures write_file, edit_file, code_run (with file output) all work.
    let finalFsScope = typeof fsScope === 'string' && fsScope.trim() ? fsScope.trim() : null;
    if (!finalFsScope) {
      const workspaceDir = join(PATHS.artifacts, '..', 'agent-workspaces');
      const taskWorkspace = join(workspaceDir, `task-${Date.now()}-${randomUUID().slice(0, 8)}`);
      try {
        await mkdir(taskWorkspace, { recursive: true });
        finalFsScope = taskWorkspace;
      } catch (e) {
        logger.warn('agent', 'failed to create workspace', {}, e);
        // Continue without workspace — agent can still use save_artifact, web_search, etc.
      }
    }

    const task = await createAgentTask({
      episodeId,
      goal: goal.trim(),
      toolsWhitelist: toolsWhitelist ?? null,
      fsScope: finalFsScope,
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
        logger.error('agent', `Runner crashed for task`, { taskId: task.id.slice(0, 8) }, e);
      });
    }

    return NextResponse.json({ task }, { status: 201 });
  } catch (e) {
    logger.error('agent', 'POST failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
