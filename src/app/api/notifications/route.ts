// GET /api/notifications — get pending smart notifications (polling)
// DELETE /api/notifications/[id] — dismiss a notification

import { NextResponse } from 'next/server';
import { getPendingNotifications, clearNotification } from '@/lib/smart-notifications';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const notifications = getPendingNotifications();
    return NextResponse.json({ notifications });
  } catch (e) {
    logger.error('api', 'GET failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
