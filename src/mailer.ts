import { APP_NAME, type Config } from './config';

/**
 * Email over HTTP APIs (Workers can't open SMTP connections). Two providers, in order:
 *   1. Brevo  (300 free emails/day) — tried first for every message
 *   2. Resend (100 free emails/day) — automatic fallback when Brevo fails for any reason
 * Both send from the same address (MAIL_FROM), whose domain is verified with both providers.
 */

export interface EmailAuditLog {
  id: string;
  sentAt: string;
  recipientEmail: string;
  subject: string;
  status: 'sent' | 'failed' | 'not_configured';
  provider?: 'brevo' | 'resend';
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
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
/** After Brevo reports a rate limit or exhausted quota, skip it for this long and go straight to Resend. */
const BREVO_PAUSE_MS = 60 * 60_000;

class ProviderError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

/** "Name <addr@x>" → { name, email } */
function parseAddress(from: string): { name?: string; email: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1].replace(/^"|"$/g, '') || undefined, email: m[2].trim() } : { email: from.trim() };
}

export class Mailer {
  // Kept in memory: an operational log, not a record. Resets when the Durable Object restarts.
  private auditLogs: EmailAuditLog[] = [];
  private resolvedFrom: string | null = null;
  private brevoPausedUntil = 0;

  constructor(private config: Config) {}

  /**
   * Sender address. MAIL_FROM wins when set. Otherwise the sender is noreply@ on the first domain
   * verified in the Resend account, falling back to Resend's test sender.
   */
  private async fromAddress(): Promise<string> {
    if (this.config.mail.from) return this.config.mail.from;
    if (this.resolvedFrom) return this.resolvedFrom;
    try {
      const res = await fetch(`${RESEND_URL}/domains`, { headers: { Authorization: `Bearer ${this.config.mail.resendApiKey}` } });
      if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 150)}`);
      const data: any = await res.json();
      const domain = (Array.isArray(data?.data) ? data.data : []).find((d: any) => d?.status === 'verified')?.name;
      if (!domain) throw new Error('no verified domain in the Resend account');
      this.resolvedFrom = `${APP_NAME} <noreply@${domain}>`;
      console.log(`Email sender: ${this.resolvedFrom}`);
      return this.resolvedFrom;
    } catch (err: any) {
      console.warn(`Could not look up a verified Resend domain (${err?.message}); set MAIL_FROM. Using the test sender.`);
      return `${APP_NAME} <onboarding@resend.dev>`;
    }
  }

  private get hasBrevo() {
    return Boolean(this.config.mail.brevoApiKey);
  }

  private get hasResend() {
    return Boolean(this.config.mail.resendApiKey);
  }

  get isConfigured() {
    return this.hasBrevo || this.hasResend;
  }

  private log(entry: Omit<EmailAuditLog, 'id' | 'sentAt'>) {
    this.auditLogs.unshift({ id: `mail-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, sentAt: new Date().toISOString(), ...entry });
    if (this.auditLogs.length > 500) this.auditLogs.length = 500;
  }

  // ---------- Brevo (primary) ----------

  private async brevoSend(from: string, e: OutgoingEmail) {
    const res = await fetch(BREVO_URL, {
      method: 'POST',
      headers: { 'api-key': this.config.mail.brevoApiKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: parseAddress(from),
        to: [{ email: e.to }],
        subject: e.subject,
        htmlContent: e.html,
        textContent: e.text,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new ProviderError(`Brevo ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
  }

  /** Tries Brevo for each email; returns the ones Brevo did not deliver. */
  private async sendViaBrevo(from: string, emails: OutgoingEmail[], delivered: string[]): Promise<OutgoingEmail[]> {
    const leftover: OutgoingEmail[] = [];
    for (let i = 0; i < emails.length; i += 10) {
      const chunk = emails.slice(i, i + 10);
      if (Date.now() < this.brevoPausedUntil) {
        leftover.push(...emails.slice(i));
        break;
      }
      await Promise.all(
        chunk.map(async (e) => {
          try {
            await this.brevoSend(from, e);
            delivered.push(e.to);
            this.log({ recipientEmail: e.to, subject: e.subject, status: 'sent', provider: 'brevo' });
          } catch (err: any) {
            const status = err instanceof ProviderError ? err.status : 0;
            // 429 = rate limited, 402 = out of credits (daily limit): stop using Brevo for a while
            if (status === 429 || status === 402) {
              this.brevoPausedUntil = Date.now() + BREVO_PAUSE_MS;
              console.warn(`Brevo limit reached (${status}); using Resend for the next hour.`);
            } else {
              console.warn(`Brevo failed for one email, falling back to Resend: ${err?.message}`);
            }
            leftover.push(e);
          }
        })
      );
    }
    return leftover;
  }

  // ---------- Resend (fallback) ----------

  private async resendPost(path: string, body: unknown) {
    const res = await fetch(`${RESEND_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.mail.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new ProviderError(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
  }

  /** Sends in batches of 100 (Resend's batch limit). */
  private async sendViaResend(from: string, emails: OutgoingEmail[], delivered: string[]) {
    for (let i = 0; i < emails.length; i += 100) {
      const batch = emails.slice(i, i + 100);
      try {
        await this.resendPost(
          batch.length === 1 ? '/emails' : '/emails/batch',
          batch.length === 1 ? { from, ...batch[0], to: [batch[0].to] } : batch.map((e) => ({ from, ...e, to: [e.to] }))
        );
        for (const e of batch) {
          delivered.push(e.to);
          this.log({ recipientEmail: e.to, subject: e.subject, status: 'sent', provider: 'resend' });
        }
      } catch (err: any) {
        console.error('Email error (Resend fallback):', err?.message);
        for (const e of batch) this.log({ recipientEmail: e.to, subject: e.subject, status: 'failed', provider: 'resend', error: err?.message });
      }
    }
  }

  async send(to: string, subject: string, html: string, text: string): Promise<boolean> {
    return (await this.sendMany([{ to, subject, html, text }])).length === 1;
  }

  /** Brevo first, then Resend for anything Brevo didn't deliver. Returns the delivered addresses. */
  async sendMany(emails: OutgoingEmail[]): Promise<string[]> {
    if (!this.isConfigured) {
      for (const e of emails) this.log({ recipientEmail: e.to, subject: e.subject, status: 'not_configured' });
      return [];
    }
    const from = await this.fromAddress();
    const delivered: string[] = [];
    const remaining = this.hasBrevo ? await this.sendViaBrevo(from, emails, delivered) : emails;
    if (remaining.length) {
      if (this.hasResend) await this.sendViaResend(from, remaining, delivered);
      else for (const e of remaining) this.log({ recipientEmail: e.to, subject: e.subject, status: 'failed', provider: 'brevo', error: 'Brevo failed and Resend is not configured' });
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
