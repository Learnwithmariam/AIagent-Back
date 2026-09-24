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

/**
 * Recent items from all feeds, newest first, de-duplicated. Takes the last 48 hours;
 * widens to a week if the feeds were quiet. Failing feeds are skipped, not fatal.
 */
export async function collectNews(feeds: string[], max = 15): Promise<{ items: NewsItem[]; failedFeeds: string[] }> {
  const results = await Promise.allSettled(feeds.map(fetchFeed));
  const failedFeeds = feeds.filter((_, i) => results[i].status === 'rejected');
  const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

  const seen = new Set<string>();
  const unique = all
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .filter((it) => {
      const key = it.url.split('?')[0] || it.title.toLowerCase();
      if (seen.has(key) || seen.has(it.title.toLowerCase())) return false;
      seen.add(key);
      seen.add(it.title.toLowerCase());
      return true;
    });

  const within = (hours: number) => unique.filter((it) => Date.now() - Date.parse(it.publishedAt) < hours * 3600_000);
  let recent = within(48);
  if (recent.length < 4) recent = within(24 * 7);

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
