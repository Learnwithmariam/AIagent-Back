import type { Store } from './store';
import { APP_NAME, type Config } from './config';
import { writeDigestFromNews, type DigestContent } from './ai';
import { collectNews } from './news';
import { escapeHtml, type Mailer } from './mailer';
import type { DailyDigest } from './types';

const DEFAULT_FOCUS = 'სტარტაპები, ინოვაციები და მეწარმეობა';

function renderEmail(d: DigestContent, config: Config): string {
  const articles = d.keyArticles
    .map(
      (a) => `<div style="border-left:3px solid #E20074;padding:10px 14px;margin:0 0 14px;background:#fdf4f9;border-radius:0 10px 10px 0">
  <div style="font-weight:bold;font-size:15px;margin-bottom:4px">${escapeHtml(a.title)}</div>
  <div style="font-size:12px;color:#7a5a6c;margin-bottom:6px">${escapeHtml(a.source)}</div>
  <div style="font-size:14px;line-height:1.5">${escapeHtml(a.summary)}</div>
  <div style="font-size:13px;color:#b0005a;margin-top:6px">🎓 ${escapeHtml(a.pedagogicalTakeaway)}</div>
  ${a.url ? `<a href="${escapeHtml(a.url)}" style="font-size:12px;color:#E20074">წაიკითხე სრულად →</a>` : ''}
</div>`
    )
    .join('');

  const options = (d.challengeQuestion?.options || [])
    .map((o, i) => `<div>${String.fromCharCode(65 + i)}. ${escapeHtml(o)}</div>`)
    .join('');

  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;padding:24px;color:#1a0f16">
  <div style="font-size:11px;font-weight:bold;color:#E20074;text-transform:uppercase;letter-spacing:.1em">${APP_NAME} • დილის დაიჯესტი</div>
  <h1 style="font-size:22px;margin:8px 0">${escapeHtml(d.headline)}</h1>
  <p style="color:#5b4a54">${escapeHtml(d.summary)}</p>
  ${articles}
  <div style="background:#fbe6f1;border-radius:12px;padding:14px;margin-top:20px">
    <div style="font-weight:bold">🧠 დღის კითხვა</div>
    <p>${escapeHtml(d.challengeQuestion?.question)}</p>
    ${options}
    <details style="margin-top:8px"><summary>პასუხი</summary><p>${escapeHtml(d.challengeQuestion?.explanation)}</p></details>
  </div>
  <p style="font-size:11px;color:#9a8a93;margin-top:24px">ამ წერილს იღებთ, რადგან ხართ კურსის „ინოვაციური მეწარმეობა და სტარტაპები“ სტუდენტი. გამოწერის გასაუქმებლად: ${escapeHtml(config.publicAppUrl)} → დაიჯესტი.</p>
</div>`;
}

export class DigestService {
  private isRunning = false;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private store: Store,
    private mailer: Mailer,
    private config: Config
  ) {}

  private todayInTz(): string {
    // YYYY-MM-DD in Asia/Tbilisi
    return new Date().toLocaleDateString('en-CA', { timeZone: this.config.digest.timezone });
  }

  /** Called by the Worker's Cron Trigger. One digest per calendar day, even if the cron fires twice. */
  async runScheduled() {
    if (!this.config.digest.enabled) return;
    if (this.store.getDigests().some((d) => d.date === this.todayInTz())) return;
    await this.run().catch((e) => console.error('Scheduled digest failed:', e.message));
  }

  async run(subjectFocus = DEFAULT_FOCUS, language: 'en' | 'ka' = 'ka'): Promise<DailyDigest> {
    if (this.isRunning) throw new Error('Digest generation is already in progress.');
    this.isRunning = true;
    try {
      // 1. real news from free RSS feeds  2. a free model writes the summaries
      const { items, failedFeeds } = await collectNews(this.config.digest.feeds);
      if (failedFeeds.length) console.warn('Digest feeds unavailable:', failedFeeds.join(', '));
      if (items.length < 2) throw new Error('Not enough recent news in the RSS feeds — digest skipped.');
      const content = await writeDigestFromNews(this.config, { items, subjectFocus, language });
      const emailHtml = renderEmail(content, this.config);
      const subscribed = this.store.getStudents().filter((s) => s.digestSubscribed);

      const subject = `☀️ ${content.headline}`;
      const text = `${content.headline}\n\n${content.summary}\n\n${content.keyArticles
        .map((a) => `• ${a.title} (${a.source})\n  ${a.summary}\n  ${a.url || ''}`)
        .join('\n\n')}`;

      const delivered = await this.mailer.sendMany(subscribed.map((s) => ({ to: s.email, subject, html: emailHtml, text })));

      const record = this.store.addDigest({
        date: this.todayInTz(),
        subjectFocus,
        headline: content.headline,
        summary: content.summary,
        keyArticles: content.keyArticles,
        challengeQuestion: content.challengeQuestion,
        generatedAt: new Date().toISOString(),
        sentToCount: delivered.length,
        recipients: delivered,
        emailHtml,
      });

      this.lastRunAt = new Date().toISOString();
      this.lastError = null;
      return record;
    } catch (err: any) {
      this.lastError = err?.message || String(err);
      throw err;
    } finally {
      this.isRunning = false;
    }
  }

  getStatus(cronSchedule: string) {
    return {
      isRunning: this.isRunning,
      lastRunAt: this.lastRunAt || this.store.getDigests()[0]?.generatedAt || null,
      lastError: this.lastError,
      enabled: this.config.digest.enabled,
      schedule: cronSchedule,
      newsSource: 'rss',
      feeds: this.config.digest.feeds,
      aiModels: this.config.openrouter.digestModels,
      timezone: this.config.digest.timezone,
      nextScheduledAt: `${cronSchedule} (UTC)`,
      smtpConfigured: this.mailer.isConfigured,
      emailConfigured: this.mailer.isConfigured,
      recentEmailLogs: this.mailer.getAuditLogs().slice(0, 30),
      subscribedCount: this.store.getStudents().filter((s) => s.digestSubscribed).length,
    };
  }
}
