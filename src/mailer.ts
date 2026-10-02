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

  /** Shared BTU-branded layout for account emails. */
  private layout(body: string): string {
    return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:0;border:1px solid #f1d5e6;border-radius:16px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#E20074,#9b0052);padding:22px 24px;color:#fff">
    <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.85">BTU</div>
    <div style="font-size:20px;font-weight:bold">${APP_NAME}</div>
  </div>
  <div style="padding:24px;color:#1a0f16">${body}</div>
</div>`;
  }

  /** The code appears only in the email body: it is never logged or stored in plain text. */
  async sendOtp({ to, name, code, minutes }: { to: string; name: string; code: string; minutes: number }) {
    // the code stays out of the subject, which ends up in the audit log and mail previews
    const subject = `${APP_NAME} — შესვლის კოდი`;
    const html = this.layout(`
  <p>გამარჯობა <b>${escapeHtml(name)}</b>,</p>
  <p>პლატფორმაზე შესასვლელად შეიყვანეთ ეს კოდი:</p>
  <div style="font-family:monospace;font-size:34px;font-weight:bold;letter-spacing:10px;text-align:center;background:#fdf4f9;border:1px dashed #E20074;border-radius:12px;padding:16px 0;margin:18px 0;color:#9b0052">${escapeHtml(code)}</div>
  <p style="color:#5b4a54">კოდი მოქმედებს <b>${minutes} წუთის</b> განმავლობაში და მხოლოდ ერთხელ.</p>
  <p style="font-size:12px;color:#9a8a93">თუ კოდი თქვენ არ მოგითხოვიათ, უბრალოდ უგულებელყავით ეს წერილი — ანგარიშზე წვდომა მის გარეშე შეუძლებელია. ეს კოდი არავის გაუზიაროთ.</p>`);
    const text = `გამარჯობა ${name},\n\n${APP_NAME}-ზე შესვლის კოდი: ${code}\nმოქმედებს ${minutes} წუთი, მხოლოდ ერთხელ.\n\nთუ კოდი არ მოგითხოვიათ, უგულებელყავით ეს წერილი.`;
    return this.send(to, subject, html, text);
  }

  /** Invitations for newly added students, sent in Resend batches. Returns the delivered addresses. */
  async sendInvites(invites: { to: string; name: string }[]): Promise<string[]> {
    const url = this.config.publicAppUrl;
    const subject = `${APP_NAME} — მოწვევა კურსზე`;
    return this.sendMany(
      invites.map(({ to, name }) => ({
        to,
        subject,
        html: this.layout(`
  <p>გამარჯობა <b>${escapeHtml(name)}</b>,</p>
  <p>ლექტორმა დაგამატათ კურსის „მეწარმეობა და ინოვაციები“ პლატფორმაზე.</p>
  <p>პაროლი არ გჭირდებათ: შესვლის გვერდზე შეიყვანეთ თქვენი ელ-ფოსტა (<b>${escapeHtml(to)}</b>) და ჩვენ გამოგიგზავნით 6-ციფრიან კოდს.</p>
  <p><a href="${escapeHtml(url)}" style="display:inline-block;background:#E20074;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:bold">შესვლა</a></p>`),
        text: `გამარჯობა ${name},\nლექტორმა დაგამატათ ${APP_NAME}-ზე.\nპაროლი არ გჭირდებათ: ${url} — შეიყვანეთ ელ-ფოსტა (${to}) და მიიღებთ 6-ციფრიან კოდს.`,
      }))
    );
  }

  getAuditLogs(): EmailAuditLog[] {
    return this.auditLogs.slice(0, 100);
  }
}
