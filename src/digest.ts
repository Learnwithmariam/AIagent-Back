import type { Store } from './store';
import { APP_NAME, type Config } from './config';
import { writeDigestFromNews } from './ai';
import { collectNews } from './news';
import type { Mailer } from './mailer';
import type { DailyDigest } from './types';

const DEFAULT_FOCUS = 'სტარტაპები, ინოვაციები და მეწარმეობა';

/**
 * The daily digest is an in-app feature only: it is generated and stored, and students read it
 * in the app. It is never emailed — Resend is reserved for account emails (new account,
 * temporary password, password reset), which keeps us well inside Resend's free daily limit.
 */
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
      const record = this.store.addDigest({
        date: this.todayInTz(),
        subjectFocus,
        headline: content.headline,
        summary: content.summary,
        keyArticles: content.keyArticles,
        challengeQuestion: content.challengeQuestion,
        generatedAt: new Date().toISOString(),
        // in-app only — never emailed
        sentToCount: 0,
        recipients: [],
        emailHtml: '',
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
      aiModels: 'OpenRouter free pool (auto)',
      timezone: this.config.digest.timezone,
      nextScheduledAt: `${cronSchedule} (UTC)`,
      delivery: 'in-app',
      // system emails (new accounts, password resets) — the digest itself is never emailed
      emailConfigured: this.mailer.isConfigured,
      recentEmailLogs: this.mailer.getAuditLogs().slice(0, 30),
    };
  }
}
