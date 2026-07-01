// Proxy (Next.js 16 — replacement for deprecated middleware) —
// auth + security checks for API routes.
//
// В production: требует либо localhost-запрос, либо X-Lia-Internal header.
// В development: rate-limit включён (защита от случайных циклов), auth отключён.
//
// Также добавляет rate limiting на критичные endpoints.
//
// В Next.js 16 файл middleware.ts переименован в proxy.ts, а функция
// `middleware` — в `proxy`. Старое название работало, но вызывало deprecated
// warning в логах и могло быть удалено в будущих версиях.
//
// Security fix (Phase 1): `ip === 'unknown'` больше не трактуется как localhost.
// Раньше это позволяло обойти auth, отправив запрос без x-forwarded-for / x-real-ip.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIp } from '@/lib/rate-limit';

export function proxy(req: NextRequest) {
  const ip = getClientIp(req);
  const path = req.nextUrl.pathname;
  const isDev = process.env.NODE_ENV !== 'production';

  // ── Auth check ──
  // Localhost (127.0.0.1, ::1) — пропускаем без токена (local-first app).
  // `unknown` IP — НЕ localhost: если reverse proxy не передаёт X-Forwarded-For,
  // считаем запрос внешним и требуем токен (если он задан в env).
  // В dev auth полностью отключён для удобства.
  const isLocalhost = ip === '127.0.0.1' || ip === '::1';

  if (!isDev && !isLocalhost) {
    const internalToken = process.env.LIA_INTERNAL_TOKEN;
    // Если токен не задан — все non-localhost запросы запрещены (fail-closed).
    if (!internalToken) {
      return NextResponse.json(
        { error: 'server is not configured for remote access (LIA_INTERNAL_TOKEN not set)' },
        { status: 503 },
      );
    }
    const header = req.headers.get('x-lia-internal');
    if (header !== internalToken) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
  }

  // ── Rate limiting ──
  // Активен и в dev, и в prod — защита от случайных циклов, fork-bombs в коде агента,
  // зацикленных клиентов. В dev пороги выше (×3), чтобы не мешать разработке.
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

    if (isDev) {
      max *= 3;       // в dev пороги в 3 раза выше
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
