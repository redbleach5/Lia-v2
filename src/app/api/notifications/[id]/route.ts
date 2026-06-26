// DELETE /api/notifications/[id] — dismiss a notification

import { NextRequest, NextResponse } from 'next/server';
import { clearNotification } from '@/lib/smart-notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  clearNotification(id);
  return NextResponse.json({ ok: true });
}
