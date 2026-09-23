import cron from 'node-cron';
import { db } from './db';
import { config } from './config';
import { generateDailyDigestContent, DigestContent } from './gemini';
import { mailerService, escapeHtml } from './mailer';
import type { DailyDigest } from './types';

const DEFAULT_FOCUS = 'სტარტაპები, ინოვაციები და მეწარმეობა';

function todayInTz(): string {
  // YYYY-MM-DD in Asia/Tbilisi
  return new Date().toLocaleDateString('en-CA', { timeZone: config.digest.timezone });
}

function renderEmail(d: DigestContent): string {
  const articles = d.keyArticles
    .map(
      (a) => `<div style="border-left:3px solid #6366f1;padding:10px 14px;margin:0 0 14px;background:#f8fafc">
  <div style="font-weight:bold;font-size:15px;margin-bottom:4px">${escapeHtml(a.title)}</div>
  <div style="font-size:12px;color:#64748b;margin-bottom:6px">${escapeHtml(a.source)}</div>
  <div style="font-size:14px;line-height:1.5">${escapeHtml(a.summary)}</div>
  <div style="font-size:13px;color:#4338ca;margin-top:6px">🎓 ${escapeHtml(a.pedagogicalTakeaway)}</div>
  ${a.url ? `<a href="${escapeHtml(a.url)}" style="font-size:12px">წაიკითხე სრულად →</a>` : ''}
</div>`
    )
    .join('');

  const options = (d.challengeQuestion?.options || [])
    .map((o, i) => `<div>${String.fromCharCode(65 + i)}. ${escapeHtml(o)}</div>`)
    .join('');

  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;padding:24px;color:#0f172a">
  <div style="font-size:11px;font-weight:bold;color:#6366f1;text-transform:uppercase">CogniTest • დილის დაიჯესტი</div>
  <h1 style="font-size:22px;margin:8px 0">${escapeHtml(d.headline)}</h1>
  <p style="color:#475569">${escapeHtml(d.summary)}</p>
  ${articles}
  <div style="background:#eef2ff;border-radius:8px;padding:14px;margin-top:20px">
    <div style="font-weight:bold">🧠 დღის კითხვა</div>
    <p>${escapeHtml(d.challengeQuestion?.question)}</p>
    ${options}
    <details style="margin-top:8px"><summary>პასუხი</summary><p>${escapeHtml(d.challengeQuestion?.explanation)}</p></details>
  </div>
  <p style="font-size:11px;color:#94a3b8;margin-top:24px">ამ წერილს იღებთ, რადგან ხართ კურსის „ინოვაციური მეწარმეობა და სტარტაპები“ სტუდენტი. გამოწერის გასაუქმებლად: ${escapeHtml(config.publicAppUrl)} → დაიჯესტი.</p>
</div>`;
}

class CronDigestService {
  private isRunning = false;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;

  start() {
    if (!config.digest.enabled) {
      console.log('ℹ️  Daily digest cron disabled (DIGEST_ENABLED=false).');
      return;
    }
    cron.schedule(
      config.digest.cron,
      () => {
        // Guard against duplicate sends after restarts: one digest per calendar day.
        if (db.getDigests().some((d) => d.date === todayInTz())) return;
        this.runDailyDigestTask().catch((e) => console.error('Scheduled digest failed:', e.message));
      },
      { timezone: config.digest.timezone }
    );
    console.log(`⏰ Daily digest scheduled: "${config.digest.cron}" (${config.digest.timezone})`);
  }

  async runDailyDigestTask(subjectFocus = DEFAULT_FOCUS, language: 'en' | 'ka' = 'ka'): Promise<DailyDigest> {
    if (this.isRunning) throw new Error('Digest generation is already in progress.');
    this.isRunning = true;
    try {
      const content = await generateDailyDigestContent({ subjectFocus, language });
      const emailHtml = renderEmail(content);
      const subscribed = db.getStudents().filter((s) => s.digestSubscribed);

      const subject = `☀️ ${content.headline}`;
      const text = `${content.headline}\n\n${content.summary}\n\n${content.keyArticles
        .map((a) => `• ${a.title} (${a.source})\n  ${a.summary}\n  ${a.url || ''}`)
        .join('\n\n')}`;

      // Send one-by-one with a small delay to stay under SMTP rate limits (Gmail ≈ 20/min safe).
      const delivered: string[] = [];
      for (const s of subscribed) {
        const ok = await mailerService.send(s.email, subject, emailHtml, text);
        if (ok) delivered.push(s.email);
        await new Promise((r) => setTimeout(r, 1500));
      }

      const record = db.addDigest({
        date: todayInTz(),
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

  getStatus() {
    return {
      isRunning: this.isRunning,
      lastRunAt: this.lastRunAt || db.getDigests()[0]?.generatedAt || null,
      lastError: this.lastError,
      schedule: config.digest.cron,
      timezone: config.digest.timezone,
      nextScheduledAt: `${config.digest.cron} (${config.digest.timezone})`,
      smtpConfigured: mailerService.isConfigured,
      recentEmailLogs: mailerService.getAuditLogs().slice(0, 30),
      subscribedCount: db.getStudents().filter((s) => s.digestSubscribed).length,
    };
  }
}

export const cronDigestService = new CronDigestService();
