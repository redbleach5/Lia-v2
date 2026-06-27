// GET /api/agent/[id]/stream — SSE for real-time task updates.
//
// Subscribes to the EventEmitter for this task's events and streams them as
// SSE. Client reconnects automatically (EventSource default).
//
// On connect, replays buffered events so the client catches up.
// On disconnect, cleanup() unsubscribes + clears heartbeat — no memory leak.

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

  // cleanup объявлен в outer scope чтобы cancel() мог его вызвать.
  // Инициализируется в start() после создания unsubscribe + heartbeat.
  let cleanup: () => void = () => {};

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

      // Cleanup function — unsubscribes + clears heartbeat.
      // Вызывается из cancel() когда клиент отключается.
      cleanup = () => {
        unsubscribe();
        clearInterval(heartbeat);
      };
    },
    cancel() {
      // Called when client disconnects (ReadableStream API).
      // Теперь cleanup доступен через замыкание — вызываем его.
      cleanup();
    },
  });

  return new Response(stream, {
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
