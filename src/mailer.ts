import nodemailer, { Transporter } from 'nodemailer';
import { config } from './config';

export interface EmailAuditLog {
  id: string;
  sentAt: string;
  recipientEmail: string;
  subject: string;
  status: 'sent' | 'failed' | 'not_configured';
  error?: string;
}

export const escapeHtml = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

class MailerService {
  private transporter: Transporter | null = null;
  private auditLogs: EmailAuditLog[] = [];

  constructor() {
    const { host, port, user, pass } = config.smtp;
    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
      console.log('✅ SMTP configured.');
    } else {
      console.log('ℹ️  SMTP not configured — emails will NOT be sent (logged only).');
    }
  }

  get isConfigured() {
    return Boolean(this.transporter);
  }

  private log(entry: Omit<EmailAuditLog, 'id' | 'sentAt'>) {
    this.auditLogs.unshift({ id: `mail-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, sentAt: new Date().toISOString(), ...entry });
    if (this.auditLogs.length > 500) this.auditLogs.length = 500;
  }

  async send(to: string, subject: string, html: string, text: string): Promise<boolean> {
    if (!this.transporter) {
      this.log({ recipientEmail: to, subject, status: 'not_configured' });
      return false;
    }
    try {
      await this.transporter.sendMail({ from: config.smtp.from, to, subject, html, text });
      this.log({ recipientEmail: to, subject, status: 'sent' });
      return true;
    } catch (err: any) {
      console.error(`SMTP error → ${to}:`, err?.message);
      this.log({ recipientEmail: to, subject, status: 'failed', error: err?.message });
      return false;
    }
  }

  /** The temporary password is included in the email body only — never logged or stored. */
  async sendWelcome({ to, name, temporaryPassword }: { to: string; name: string; temporaryPassword: string }) {
    const subject = 'CogniTest — თქვენი ანგარიში შეიქმნა';
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
  <h2 style="margin-top:0">BTU • CogniTest</h2>
  <p>გამარჯობა <b>${escapeHtml(name)}</b>,</p>
  <p>კურსის „ინოვაციური მეწარმეობა და სტარტაპები“ პლატფორმაზე თქვენთვის შეიქმნა ანგარიში.</p>
  <p>ელ-ფოსტა: <b>${escapeHtml(to)}</b><br>დროებითი პაროლი: <b style="font-family:monospace;font-size:16px">${escapeHtml(temporaryPassword)}</b></p>
  <p>შესვლა: <a href="${escapeHtml(config.publicAppUrl)}">${escapeHtml(config.publicAppUrl)}</a></p>
  <p style="color:#b45309">პირველი შესვლისას სისტემა მოგთხოვთ პაროლის შეცვლას.</p>
</div>`;
    const text = `გამარჯობა ${name},\nCogniTest-ზე შეიქმნა ანგარიში.\nელ-ფოსტა: ${to}\nდროებითი პაროლი: ${temporaryPassword}\nშესვლა: ${config.publicAppUrl}\nპირველი შესვლისას შეცვალეთ პაროლი.`;
    return this.send(to, subject, html, text);
  }

  getAuditLogs(): EmailAuditLog[] {
    return this.auditLogs.slice(0, 100);
  }
}

export const mailerService = new MailerService();
