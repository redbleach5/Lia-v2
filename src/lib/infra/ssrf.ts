import 'server-only';

// ============================================================================
// SSRF protection — проверка URL/IP перед fetch.
// ============================================================================
//
// Используется:
//   - lib/agent/tools.ts — http_request tool (agent mode)
//   - lib/tools/web-search.ts — fetchPage (web_search + fetch_page tools)
//
// Защита от:
//   - Прямых запросов к private IP (127.x, 10.x, 192.168.x, 172.16-31.x, link-local)
//   - IPv6 loopback/ULA/link-local
//   - IPv4-mapped IPv6 (::ffff:1.2.3.4) — рекурсивная проверка inner IP
//   - localhost hostname
//   - CGNAT (100.64.0.0/10) и 0.0.0.0/8
//   - AWS metadata endpoint (169.254.169.254) — покрывается link-local
//
// Ограничения:
//   - TOCTOU race: DNS resolved at check time, fetch re-resolves at connect time.
//     Для local-first приложения на localhost — приемлемый риск.
//     Для production нужна пиннгация IP в fetch через lookup callback.
//   - DNS rebinding с TTL=0: теоретически возможен, но требует контроля DNS-сервера жертвы.

import { lookup } from 'dns/promises';
import { isIP } from 'net';

const BLOCKED_IP_PATTERNS = [
  /^127\./,                           // loopback
  /^10\./,                            // private class A
  /^192\.168\./,                      // private class C
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,  // private class B
  /^169\.254\./,                      // link-local (включая AWS metadata 169.254.169.254)
  /^0\./,                             // 0.0.0.0/8
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
  /^::1$/,                            // IPv6 loopback
  /^fc00::/,                          // IPv6 ULA
  /^fe80::/,                          // IPv6 link-local
  /^::ffff:/,                         // IPv4-mapped IPv6 (check inner)
];

export function isPrivateIp(ip: string): boolean {
  // Handle IPv4-mapped IPv6 (::ffff:1.2.3.4)
  const mappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedMatch) {
    return isPrivateIp(mappedMatch[1]);
  }
  return BLOCKED_IP_PATTERNS.some(re => re.test(ip));
}

/**
 * Resolve hostname and check ALL resolved IPs against blocklist.
 * Throws if any IP is private/blocked.
 */
export async function assertSafeHost(hostname: string): Promise<void> {
  // If hostname is already an IP, check directly
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`blocked IP: ${hostname}`);
    }
    return;
  }

  // localhost check
  if (hostname.toLowerCase() === 'localhost') {
    throw new Error('blocked: localhost');
  }

  // DNS resolve
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`DNS resolution failed for ${hostname}`);
  }

  if (addresses.length === 0) {
    throw new Error(`no DNS records for ${hostname}`);
  }

  // Check ALL resolved IPs
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(`blocked IP ${address} for ${hostname}`);
    }
  }
}

/**
 * Проверить URL на SSRF-безопасность.
 * Бросает Error, если hostname резолвится в private/blocked IP
 * или если используется не-http(s) протокол.
 *
 * Используйте перед fetch() для любых URL, пришедших от LLM или пользователя.
 */
export async function assertSafeUrl(url: string): Promise<URL> {
  const u = new URL(url);
  // Разрешаем только http/https — никакого file://, ftp://, gopher:// и т.п.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`blocked protocol: ${u.protocol}`);
  }
  await assertSafeHost(u.hostname);
  return u;
}
