import { APP_NAME, type Config } from './config';

/**
 * Email via Resend's HTTP API (https://resend.com). Workers can't open SMTP connections the way
 * nodemailer did, and an HTTP API is also faster for the daily digest (batch sends).
 */

export interface EmailAuditLog {
  id: string;
  sentAt: string;
  recipientEmail: string;
  subject: string;
  status: 'sent' | 'failed' | 'not_configured';
  error?: string;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export const escapeHtml = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const RESEND_URL = 'https://api.resend.com';

export class Mailer {
  // Kept in memory: an operational log, not a record. Resets when the Durable Object restarts.
  private auditLogs: EmailAuditLog[] = [];

  constructor(private config: Config) {}

  get isConfigured() {
    return Boolean(this.config.mail.resendApiKey);
  }

  private log(entry: Omit<EmailAuditLog, 'id' | 'sentAt'>) {
    this.auditLogs.unshift({ id: `mail-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, sentAt: new Date().toISOString(), ...entry });
    if (this.auditLogs.length > 500) this.auditLogs.length = 500;
  }

  private async post(path: string, body: unknown) {
    const res = await fetch(`${RESEND_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.mail.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  async send(to: string, subject: string, html: string, text: string): Promise<boolean> {
    return (await this.sendMany([{ to, subject, html, text }])).length === 1;
  }

  /** Sends in batches of 100 (Resend's batch limit). Returns the addresses that were accepted. */
  async sendMany(emails: OutgoingEmail[]): Promise<string[]> {
    if (!this.isConfigured) {
      for (const e of emails) this.log({ recipientEmail: e.to, subject: e.subject, status: 'not_configured' });
      return [];
    }
    const delivered: string[] = [];
    for (let i = 0; i < emails.length; i += 100) {
      const batch = emails.slice(i, i + 100);
      try {
        await this.post(
          batch.length === 1 ? '/emails' : '/emails/batch',
          batch.length === 1
            ? { from: this.config.mail.from, ...batch[0], to: [batch[0].to] }
            : batch.map((e) => ({ from: this.config.mail.from, ...e, to: [e.to] }))
        );
        for (const e of batch) {
          delivered.push(e.to);
          this.log({ recipientEmail: e.to, subject: e.subject, status: 'sent' });
        }
      } catch (err: any) {
        console.error('Email error:', err?.message);
        for (const e of batch) this.log({ recipientEmail: e.to, subject: e.subject, status: 'failed', error: err?.message });
      }
    }
    return delivered;
  }

  /** The temporary password is included in the email body only — never logged or stored. */
  async sendWelcome({ to, name, temporaryPassword }: { to: string; name: string; temporaryPassword: string }) {
    const url = this.config.publicAppUrl;
    const subject = `${APP_NAME} — თქვენი ანგარიში შეიქმნა`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:0;border:1px solid #f1d5e6;border-radius:16px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#E20074,#9b0052);padding:22px 24px;color:#fff">
    <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.85">BTU</div>
    <div style="font-size:20px;font-weight:bold">${APP_NAME}</div>
  </div>
  <div style="padding:24px;color:#1a0f16">
  <p>გამარჯობა <b>${escapeHtml(name)}</b>,</p>
  <p>კურსის „ინოვაციური მეწარმეობა და სტარტაპები“ პლატფორმაზე თქვენთვის შეიქმნა ანგარიში.</p>
  <p>ელ-ფოსტა: <b>${escapeHtml(to)}</b><br>დროებითი პაროლი: <b style="font-family:monospace;font-size:16px">${escapeHtml(temporaryPassword)}</b></p>
  <p><a href="${escapeHtml(url)}" style="display:inline-block;background:#E20074;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:bold">შესვლა</a></p>
  <p style="color:#b45309">პირველი შესვლისას სისტემა მოგთხოვთ პაროლის შეცვლას.</p>
  </div>
</div>`;
    const text = `გამარჯობა ${name},\n${APP_NAME}-ზე შეიქმნა ანგარიში.\nელ-ფოსტა: ${to}\nდროებითი პაროლი: ${temporaryPassword}\nშესვლა: ${url}\nპირველი შესვლისას შეცვალეთ პაროლი.`;
    return this.send(to, subject, html, text);
  }

  getAuditLogs(): EmailAuditLog[] {
    return this.auditLogs.slice(0, 100);
  }
}
