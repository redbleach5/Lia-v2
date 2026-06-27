// GET /api/agent/[id]/stream — SSE for real-time task updates.
//
// Subscribes to the EventEmitter for this task's events and streams them as
// SSE. Client reconnects automatically (EventSource default).
//
// On connect, replays buffered events so the client catches up.

import { NextRequest } from 'next/server';
import { subscribeToTask, getBufferedEvents, type AgentEvent } from '@/lib/agent/events';
import { getAgentTask } from '@/lib/agent/task';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const task = await getAgentTask(id);
  if (!task) {
    return new Response('task not found', { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send initial state
      controller.enqueue(encoder.encode(`event: task_init\ndata: ${JSON.stringify(task)}\n\n`));

      // Replay buffered events
      const buffered = getBufferedEvents(id);
      for (const evt of buffered) {
        controller.enqueue(encoder.encode(formatSSE(evt)));
      }

      // Subscribe to future events
      const unsubscribe = subscribeToTask(id, (event: AgentEvent) => {
        try {
          controller.enqueue(encoder.encode(formatSSE(event)));
        } catch {
          // controller closed — client disconnected
          unsubscribe();
        }
      });

      // Heartbeat every 15s to keep connection alive
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`:heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);

      // Cleanup on close
      const cleanup = () => {
        unsubscribe();
        clearInterval(heartbeat);
      };

      // Next.js doesn't expose cancel on ReadableStream start callback directly,
      // but the controller's close will trigger the stream's cancel.
      // We store cleanup on the controller for the cancel handler.
      (controller as unknown as { _cleanup?: () => void })._cleanup = cleanup;
    },
    cancel() {
      // Called when client disconnects
      // (controller is not passed here, so we use a closure)
    },
  });

  // Wrap to handle cancel properly
  const wrappedStream = new ReadableStream({
    start(controller) {
      const reader = stream.getReader();
      const pump = (): Promise<void> =>
        reader.read().then(({ done, value }) => {
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
          return pump();
        });
      pump().catch(() => controller.close());
    },
  });

  return new Response(wrappedStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function formatSSE(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
