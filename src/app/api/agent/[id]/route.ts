// GET /api/agent/[id] — task details with parsed steps + artifacts

import { NextRequest, NextResponse } from 'next/server';
import { getAgentTask, parseSteps, parseArtifacts } from '@/lib/agent/task';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const task = await getAgentTask(id);
    if (!task) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    return NextResponse.json({
      task,
      steps: parseSteps(task.stepsJson),
      artifacts: parseArtifacts(task.artifactsJson),
      plan: task.planJson ? JSON.parse(task.planJson) : null,
    });
  } catch (e) {
    logger.error('agent', '] GET failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
