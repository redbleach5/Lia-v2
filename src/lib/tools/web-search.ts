// web_search — DuckDuckGo HTML scraping (no API key required).

import { db } from '@/lib/db';

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

/**
 * Поиск через DuckDuckGo HTML endpoint. Возвращает топ-10 результатов.
 * Без API ключа, без rate limits (в разумных пределах).
 */
export async function webSearch(query: string): Promise<{
  query: string;
  results: SearchResult[];
  count: number;
}> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return { query, results: [], count: 0 };
    }

    const html = await res.text();
    const results = parseDuckDuckGoHtml(html);

    // Log search for analytics
    try {
      await db.setting.upsert({
        where: { key: 'last_web_search' },
        create: { key: 'last_web_search', value: JSON.stringify({ query, count: results.length, ts: Date.now() }) },
        update: { value: JSON.stringify({ query, count: results.length, ts: Date.now() }) },
      });
    } catch { /* non-fatal */ }

    return { query, results, count: results.length };
  } catch (e) {
    console.warn('[web_search] failed:', e);
    return { query, results: [], count: 0 };
  }
}

/**
 * Парсит HTML-ответ DuckDuckGo. DDG использует .result blocks с .result__a (title+link)
 * и .result__snippet.
 */
function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // Match each result block. DuckDuckGo HTML structure:
  // <div class="result">
  //   <a class="result__a" href="//duckduckgo.com/l/?uddg=ENCODED_URL">Title</a>
  //   <a class="result__snippet">Snippet text</a>
  // </div>

  const resultRegex = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  const linkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
  const snippetRegex = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/;

  let match: RegExpExecArray | null;
  const seenUrls = new Set<string>();

  // Simpler approach: find all result__a links
  const linkOnlyRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  while ((match = linkOnlyRegex.exec(html)) && results.length < 10) {
    let href = match[1];
    const titleHtml = match[2];

    // DDG wraps URLs: href="//duckduckgo.com/l/?uddg=ENCODED_URL&rut=..."
    const uddgMatch = href.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      try {
        href = decodeURIComponent(uddgMatch[1]);
      } catch {
        continue;
      }
    } else if (href.startsWith('//')) {
      href = 'https:' + href;
    }

    // Skip DDG-internal links
    if (href.includes('duckduckgo.com') && !uddgMatch) continue;
    if (seenUrls.has(href)) continue;
    seenUrls.add(href);

    const title = stripHtml(titleHtml).trim();
    if (!title) continue;

    // Find snippet — look for the next result__snippet after this link
    const afterLink = html.slice(match.index! + match[0].length);
    const snippetMatch = afterLink.match(snippetRegex);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : '';

    results.push({ title, url: href, snippet });
  }

  return results;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}
