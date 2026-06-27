// Rate limiting — простой in-memory token bucket.
//
// Не требует Redis/внешних зависимостей. Подходит для local-first приложения.
// Для multi-instance deployment нужно заменить на Redis-backed (@upstash/ratelimit).
//
// Usage:
//   import { rateLimit } from '@/lib/rate-limit';
//   const ok = rateLimit(`chat:${ip}`, 20, 60_000); // 20 req/min
//   if (!ok) return NextResponse.json({ error: 'rate limit' }, { status: 429 });

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

// Cleanup expired buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) {
      buckets.delete(key);
    }
  }
}, 5 * 60 * 1000).unref?.();

/**
 * Token bucket rate limiter.
 *
 * @param key — уникальный ключ (например `chat:${ip}` или `train:${ip}`)
 * @param max — максимум запросов за окно
 * @param windowMs — размер окна в миллисекундах
 * @returns true если запрос разрешён, false если лимит превышен
 */
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    // New window
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (bucket.count >= max) {
    return false;
  }

  bucket.count++;
  return true;
}

/**
 * Get client IP from request — handles proxies.
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp;
  return 'unknown';
}
