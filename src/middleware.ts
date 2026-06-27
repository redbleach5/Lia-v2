// Middleware — auth + security checks for API routes.
//
// В production: требует либо localhost-запрос, либо X-Lia-Internal header.
// В development: пропускает всё (для удобства локальной разработки).
//
// Также добавляет rate limiting на критичные endpoints.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIp } from '@/lib/rate-limit';

export function middleware(req: NextRequest) {
  // В development — пропускаем всё
  if (process.env.NODE_ENV !== 'production') {
    return NextResponse.next();
  }

  const ip = getClientIp(req);
  const path = req.nextUrl.pathname;

  // ── Auth check для non-localhost ──
  // Localhost запросы пропускаем без токена (local-first app).
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === 'unknown';

  if (!isLocalhost) {
    const internalToken = process.env.LIA_INTERNAL_TOKEN;
    if (internalToken) {
      const header = req.headers.get('x-lia-internal');
      if (header !== internalToken) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 });
      }
    }
  }

  // ── Rate limiting ──
  // Только для POST-запросов к дорогим endpoints
  if (req.method === 'POST') {
    let max = 60;     // default: 60 req/min
    let window = 60_000;

    if (path.startsWith('/api/chat')) {
      max = 20;       // 20 chat messages/min
    } else if (path.startsWith('/api/agent')) {
      max = 5;        // 5 agent tasks/min
    } else if (path.startsWith('/api/rl/train')) {
      max = 1;        // 1 training per 10 min
      window = 600_000;
    } else if (path.startsWith('/api/settings/upload-vrm')) {
      max = 3;        // 3 VRM uploads/min
    }

    const ok = rateLimit(`${path}:${ip}`, max, window);
    if (!ok) {
      return NextResponse.json(
        { error: 'rate limit exceeded, try again later' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(window / 1000)) } },
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  // Apply to all API routes
  matcher: '/api/:path*',
};
