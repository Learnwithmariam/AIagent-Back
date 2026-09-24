/**
 * Free news source for the daily digest: public RSS / Atom feeds.
 * No API key, no paid search. Feeds are configurable with DIGEST_FEEDS (comma-separated URLs).
 */

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  description: string;
  publishedAt: string; // ISO
}

export const DEFAULT_FEEDS = [
  'https://techcrunch.com/category/startups/feed/',
  'https://news.crunchbase.com/feed/',
  'https://sifted.eu/feed',
  'https://www.eu-startups.com/feed/',
  'https://venturebeat.com/feed/',
];

const decodeEntities = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

/** Text content: decode, strip any HTML inside, collapse whitespace. */
const clean = (s: string | undefined) =>
  decodeEntities(decodeEntities(s || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m?.[1];
}

function atomLink(block: string): string | undefined {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const pick = links.find((a) => /rel=["']alternate["']/i.test(a)) || links.find((a) => !/rel=/i.test(a)) || links[0];
  return pick ? /href=["']([^"']+)["']/i.exec(pick)?.[1] : undefined;
}

/** Parses RSS 2.0 and Atom without a DOM (Workers have no DOMParser). */
export function parseFeed(xml: string, fallbackSource: string): NewsItem[] {
  const channelTitle = clean(tag(xml.split(/<item\b|<entry\b/i)[0], 'title')) || fallbackSource;
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  const items: NewsItem[] = [];
  for (const b of blocks) {
    const title = clean(tag(b, 'title'));
    const url = (clean(tag(b, 'link')) || atomLink(b) || clean(tag(b, 'guid')) || '').trim();
    if (!title || !/^https?:\/\//.test(url)) continue;
    const date = clean(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const t = Date.parse(date);
    items.push({
      title,
      url,
      source: channelTitle,
      description: clean(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 800),
      publishedAt: Number.isFinite(t) ? new Date(t).toISOString() : new Date(0).toISOString(),
    });
  }
  return items;
}

async function fetchFeed(url: string): Promise<NewsItem[]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'GK-BTU-Students-Digest/1.0 (+RSS reader)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return parseFeed(await res.text(), new URL(url).hostname.replace(/^www\./, ''));
}

/** Key used to recognise the same story across runs (tracking params and trailing slashes ignored). */
export const newsKey = (url: string) => url.split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase();
export const titleKey = (title: string) => title.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * NEW items only: published after `since` and never used in an earlier digest (`seenUrls` /
 * `seenTitles`). Newest first, de-duplicated. There is deliberately no widening of the window
 * on quiet days — no news means no digest. Failing feeds are skipped, not fatal.
 */
export async function collectNews(
  feeds: string[],
  { since, seenUrls = new Set<string>(), seenTitles = new Set<string>(), max = 15 }: { since: Date; seenUrls?: Set<string>; seenTitles?: Set<string>; max?: number }
): Promise<{ items: NewsItem[]; failedFeeds: string[] }> {
  const results = await Promise.allSettled(feeds.map(fetchFeed));
  const failedFeeds = feeds.filter((_, i) => results[i].status === 'rejected');
  const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

  const seen = new Set<string>();
  const recent = all
    .filter((it) => {
      const t = Date.parse(it.publishedAt);
      return t > since.getTime() && t <= Date.now() + 3600_000; // also drop items dated in the future
    })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .filter((it) => {
      const u = newsKey(it.url);
      const t = titleKey(it.title);
      if (seenUrls.has(u) || seenTitles.has(t) || seen.has(u) || seen.has(t)) return false;
      seen.add(u);
      seen.add(t);
      return true;
    });

  // Round-robin across sources so one busy feed doesn't crowd out the rest
  const bySource = new Map<string, NewsItem[]>();
  for (const it of recent) bySource.set(it.source, [...(bySource.get(it.source) || []), it]);
  const picked: NewsItem[] = [];
  while (picked.length < max && [...bySource.values()].some((l) => l.length)) {
    for (const list of bySource.values()) {
      const next = list.shift();
      if (next && picked.length < max) picked.push(next);
    }
  }
  return { items: picked, failedFeeds };
}
