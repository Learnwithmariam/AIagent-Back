import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { APP_NAME, type Config } from './config';
import type { Store } from './store';
import type { ProctorHub } from './proctor';
import type { Mailer } from './mailer';
import type { DigestService } from './digest';
import { aiStatus, chatWithTeachingAgent } from './ai';
import { extractTextFromFile } from './extract';
import { signToken, verifyToken, publicUser, generateOtp, hashOtp, otpMatches, roleFor, type TokenPayload } from './auth';
import { MAX_TEST_POINTS, type UserAccount, type Question, type QuestionGrading, type Test, type TestSubmission, type ProctorSummary } from './types';

export interface Deps {
  store: Store;
  proctor: ProctorHub;
  mailer: Mailer;
  digest: DigestService;
  config: Config;
  cronSchedule: string;
}

type AppEnv = { Variables: { user: TokenPayload } };

class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export function createApp({ store, proctor, mailer, digest, config, cronSchedule }: Deps) {
  const app = new Hono<AppEnv>();

  app.use(secureHeaders());
  app.use(
    '/api/*',
    cors({
      // allow configured frontends; requests without an Origin (curl, server-to-server) pass through
      origin: (origin) => (config.frontendOrigins.includes(origin) ? origin : null),
      allowHeaders: ['Authorization', 'Content-Type'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 86400,
    })
  );

  const body = async (c: Context): Promise<any> => {
    try {
      return await c.req.json();
    } catch {
      return {};
    }
  };

  // -------------------------------------------------------------------------
  // Tiny in-memory rate limiter. One Durable Object serves the whole course, so this map is global.
  // Keyed per user when logged in, so a whole university behind one NAT IP doesn't share a bucket.
  // -------------------------------------------------------------------------
  function rateLimit(windowMs: number, max: number, keyFn: (c: Context<AppEnv>) => string | Promise<string>): MiddlewareHandler<AppEnv> {
    const hits = new Map<string, { count: number; reset: number }>();
    return async (c, next) => {
      const now = Date.now();
      if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      const key = await keyFn(c);
      const entry = hits.get(key);
      if (!entry || entry.reset < now) {
        hits.set(key, { count: 1, reset: now + windowMs });
        return next();
      }
      entry.count += 1;
      if (entry.count > max) {
        c.header('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
        return c.json({ error: 'Too many requests, please wait a moment.' }, 429);
      }
      return next();
    };
  }
  const clientIp = (c: Context) => c.req.header('CF-Connecting-IP') || 'anon';
  // Hono caches the parsed body, so reading it here doesn't consume it for the handler
  const emailKey = async (c: Context<AppEnv>) => `${clientIp(c)}|${String((await body(c))?.email || '').trim().toLowerCase()}`;
  // Sign-in codes: at most 5 code emails and 10 verification tries per IP + email per 15 minutes
  const otpRequestLimiter = rateLimit(15 * 60_000, 5, emailKey);
  const otpVerifyLimiter = rateLimit(15 * 60_000, 10, emailKey);
  const chatLimiter = rateLimit(60 * 60_000, 60, (c) => c.get('user')?.sub || clientIp(c));

  // -------------------------------------------------------------------------
  // Auth middleware
  // -------------------------------------------------------------------------
  const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
    const header = c.req.header('Authorization') || '';
    const payload = await verifyToken(header.startsWith('Bearer ') ? header.slice(7) : '', config);
    if (!payload) return c.json({ error: 'Authentication required' }, 401);
    // Sessions last 90 days, so check the account still exists (a deleted student is signed out at once)
    const account = store.getUserById(payload.sub);
    if (!account || account.email.toLowerCase() !== payload.email.toLowerCase()) return c.json({ error: 'Authentication required' }, 401);
    c.set('user', payload);
    return next();
  };
  const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) =>
    requireAuth(c, async () => {
      if (c.get('user').role !== 'admin') throw new HttpError(403, 'Admin access required');
      await next();
    });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Remove answer keys and rubrics before a test goes to a student. */
  function sanitizeQuestion(q: Question): Question {
    const { correctAnswer, rubric, gradingCriteria, ...safe } = q;
    return safe;
  }
  function sanitizeTestForStudent(test: Test, includeQuestions: boolean): Test {
    return {
      ...test,
      questions: includeQuestions
        ? test.questions.map(sanitizeQuestion)
        : // listing view: keep count/points, hide content until the exam actually starts
          test.questions.map((q) => ({ id: q.id, type: q.type, points: q.points, prompt: '' })),
    };
  }

  /** Points may be fractional (e.g. 2.5 of 10); keep one decimal to avoid float noise. */
  const roundPts = (n: number) => Math.round(n * 10) / 10;

  function isWithinWindow(test: Test) {
    const now = Date.now();
    return now >= new Date(test.startTime).getTime() && now <= new Date(test.endTime).getTime();
  }

  function deadlineMs(test: Test, attempt: { startedAt: string; pausedMs: number; pausedAt: string | null }) {
    const pausedNow = attempt.pausedAt ? Date.now() - new Date(attempt.pausedAt).getTime() : 0;
    return new Date(attempt.startedAt).getTime() + test.durationMinutes * 60_000 + attempt.pausedMs + pausedNow;
  }

  /** Proctoring summary is computed from server-side events — never trusted from the browser. */
  function buildProctorSummary(testId: string, email: string, pausesUsed: number): ProctorSummary {
    const events = store.getProctorEvents(testId, email);
    const count = (t: string) => events.filter((e) => e.eventType === t && e.severity !== 'low').length;
    const tabHiddenCount = count('tab_hidden');
    const windowBlurCount = count('window_blur');
    const copyPasteAttempts = count('copy_attempt') + count('paste_attempt');
    const other = count('fullscreen_exit') + count('context_menu');
    const infractionsCount = tabHiddenCount + windowBlurCount + copyPasteAttempts + other;
    const awayTimeSeconds = events
      .filter((e) => (e.eventType === 'tab_visible' || e.eventType === 'window_focus') && e.durationSeconds)
      .reduce((n, e) => n + (e.durationSeconds || 0), 0);
    return {
      infractionsCount,
      awayTimeSeconds,
      tabHiddenCount,
      windowBlurCount,
      copyPasteAttempts,
      flagsRaised: events
        .filter((e) => e.severity === 'high')
        .slice(0, 50)
        .map((e) => `${new Date(e.timestamp).toLocaleTimeString('en-GB', { timeZone: 'Asia/Tbilisi' })} — ${e.details}`),
      integrityStatus: infractionsCount === 0 ? 'clean' : infractionsCount <= 2 ? 'minor_warnings' : 'flagged_suspicious',
      pausesUsed,
      pauseCreditsRemaining: Math.max(0, config.exam.maxPauses - pausesUsed),
    };
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------
  app.get('/api/health', (c) => c.json({ status: 'ok', app: APP_NAME, runtime: 'cloudflare-workers', timestamp: new Date().toISOString() }));

  // -------------------------------------------------------------------------
  // Live proctoring WebSocket
  // -------------------------------------------------------------------------
  app.get('/ws/proctor', async (c) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') return c.text('Expected a WebSocket upgrade', 426);
    const origin = c.req.header('Origin');
    if (config.isProd && origin && !config.frontendOrigins.includes(origin)) return c.text('Origin not allowed', 403);
    // Auth: token is passed as ?token=... (browsers can't set headers on WebSocket)
    const user = await verifyToken(c.req.query('token') || '', config);
    if (!user || !store.getUserById(user.sub)) return c.text('Unauthorized', 401);
    return proctor.accept(user);
  });

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------
  /** Successful sign-in: same response for every method. */
  async function sessionResponse(c: Context<AppEnv>, user: UserAccount) {
    store.touchLogin(user);
    return c.json({
      success: true,
      token: await signToken(user, config),
      user: { ...publicUser(user), role: roleFor(user.email, config), isTemporaryPassword: false },
      student: roleFor(user.email, config) === 'student' ? store.getStudentByEmail(user.email) || null : null,
      requiresPasswordChange: false,
    });
  }

  // -------------------------------------------------------------------------
  // Passwordless sign-in: email → 6-digit code (10 min, single use, 5 tries) → session
  // -------------------------------------------------------------------------
  const OTP_TTL_MS = 10 * 60_000;
  const OTP_RESEND_COOLDOWN_MS = 60_000;
  const OTP_MAX_ATTEMPTS = 5;

  /** Creates (or replaces) the user's code and emails it. Returns the code only to internal callers. */
  async function issueOtp(user: UserAccount) {
    const code = generateOtp();
    store.putOtp(user.email, await hashOtp(user.email, code, config.jwtSecret), OTP_TTL_MS);
    const emailed = await mailer.sendOtp({ to: user.email, name: user.name, code, minutes: OTP_TTL_MS / 60_000 });
    return { code, emailed };
  }

  app.post('/api/auth/otp/request', otpRequestLimiter, async (c) => {
    const email = String((await body(c))?.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return c.json({ error: 'შეიყვანეთ სწორი ელ-ფოსტა / Enter a valid email' }, 400);
    const generic = { success: true, expiresInSeconds: OTP_TTL_MS / 1000, resendAfterSeconds: OTP_RESEND_COOLDOWN_MS / 1000 };
    // No self-registration: only accounts the admin created can sign in
    const user = store.getUserByEmail(email);
    if (!user) return c.json({ error: 'თქვენი ელფოსტა არ მოიძებნა ბაზაში. მიმართეთ ადმინისტრატორს.', code: 'email_not_found' }, 404);

    const pending = store.getOtp(email);
    if (pending && Date.now() - pending.createdAt < OTP_RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - pending.createdAt)) / 1000);
      c.header('Retry-After', String(wait));
      return c.json({ error: `ახალი კოდის მოთხოვნა შეგიძლიათ ${wait} წამში / You can request a new code in ${wait}s`, retryAfterSeconds: wait }, 429);
    }

    const { emailed } = await issueOtp(user);
    if (!emailed) {
      // The code exists but couldn't be delivered (e.g. Resend not set up for this address).
      // The administrator can issue a sign-in code from the dashboard instead.
      return c.json(
        { error: 'კოდის გაგზავნა ვერ მოხერხდა. შესვლის კოდისთვის მიმართეთ ადმინისტრატორს. / The code could not be emailed. Ask the administrator for a sign-in code.' },
        502
      );
    }
    return c.json(generic);
  });

  app.post('/api/auth/otp/verify', otpVerifyLimiter, async (c) => {
    const b = await body(c);
    const email = String(b?.email || '').trim().toLowerCase();
    const code = String(b?.code || '').replace(/\D/g, '');
    const invalid = () => c.json({ error: 'კოდი არასწორია ან ვადა გაუვიდა / The code is wrong or has expired' }, 400);
    if (!email || code.length !== 6) return invalid();

    const pending = store.getOtp(email);
    const user = store.getUserByEmail(email);
    if (!pending || !user) return invalid();
    if (Date.now() > pending.expiresAt) {
      store.deleteOtp(email);
      return invalid();
    }
    if (!otpMatches(pending.codeHash, await hashOtp(email, code, config.jwtSecret))) {
      if (store.bumpOtpAttempts(email) >= OTP_MAX_ATTEMPTS) {
        store.deleteOtp(email);
        return c.json({ error: 'ძალიან ბევრი მცდელობა. მოითხოვეთ ახალი კოდი. / Too many attempts. Request a new code.' }, 429);
      }
      return invalid();
    }

    store.deleteOtp(email); // single use
    if (user.role === 'student' && user.isTemporaryPassword) {
      user.isTemporaryPassword = false; // accounts from the password era
      store.save('users', user);
    }
    return sessionResponse(c, user);
  });

  app.get('/api/auth/me', requireAuth, (c) => {
    const user = store.getUserById(c.get('user').sub);
    if (!user) return c.json({ error: 'Account no longer exists' }, 401);
    const role = roleFor(user.email, config);
    return c.json({
      user: { ...publicUser(user), role, isTemporaryPassword: false },
      student: role === 'student' ? store.getStudentByEmail(user.email) || null : null,
    });
  });

  app.get('/api/auth/users', requireAdmin, (c) => c.json(store.getUsers().map(publicUser)));
  app.get('/api/auth/email-logs', requireAdmin, (c) => c.json(mailer.getAuditLogs()));

  // -------------------------------------------------------------------------
  // Students (admin)
  // -------------------------------------------------------------------------
  /** Students plus their sign-in status: `lastLoginAt` null = invited but never signed in ("Pending"). */
  app.get('/api/students', requireAdmin, (c) =>
    c.json(
      store.getStudents().map((s) => {
        const u = store.getUserByEmail(s.email);
        return { ...s, firstLoginAt: u?.firstLoginAt || u?.lastLoginAt || null, lastLoginAt: u?.lastLoginAt || null, hasLoggedIn: Boolean(u?.lastLoginAt) };
      })
    )
  );

  const DEFAULT_DEPARTMENT = 'მეწარმეობა და ინოვაციები';
  const EMAIL_RE = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+$/;

  /** "giorgi.beridze_2@btu.edu.ge" → "Giorgi Beridze" (the lecturer can edit it later). */
  const nameFromEmail = (email: string) =>
    email
      .split('@')[0]
      .replace(/[0-9]+/g, ' ')
      .split(/[._\-+\s]+/)
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
      .join(' ') || email.split('@')[0];

  /**
   * Creates the accounts (synchronously, in one go) and then sends all invitations in Resend
   * batches. There are no passwords: invited students sign in with an emailed code.
   */
  async function inviteStudents(entries: { name?: string; email: string; department?: string }[]) {
    const results: { email: string; name: string; status: 'created' | 'exists'; invited: boolean }[] = [];
    const toInvite: { to: string; name: string }[] = [];
    for (const e of entries) {
      if (e.email === config.adminEmail) {
        results.push({ email: e.email, name: config.adminName, status: 'exists', invited: false });
        continue; // the administrator is never a student
      }
      const name = (e.name || '').trim() || nameFromEmail(e.email);
      const { student, created } = store.addStudent({ name, email: e.email, department: e.department || DEFAULT_DEPARTMENT });
      results.push({ email: student.email, name: student.name, status: created ? 'created' : 'exists', invited: false });
      if (created) toInvite.push({ to: student.email, name: student.name });
    }
    const delivered = new Set(toInvite.length ? await mailer.sendInvites(toInvite) : []);
    for (const r of results) r.invited = delivered.has(r.email);
    return results;
  }

  app.post('/api/students', requireAdmin, async (c) => {
    const { name, email, department, digestSubscribed } = await body(c);
    if (!name || !email || !EMAIL_RE.test(String(email).trim())) {
      return c.json({ error: 'Valid name and email are required' }, 400);
    }
    if (String(email).trim().toLowerCase() === config.adminEmail) return c.json({ error: 'This is the administrator’s email' }, 400);
    const [r] = await inviteStudents([{ name: String(name), email: String(email).trim().toLowerCase(), department }]);
    const student = store.getStudentByEmail(r.email)!;
    if (r.status === 'created' && digestSubscribed === false) store.updateStudentSubscription(student.email, false);
    // keep backwards compatibility: frontend expects the student object at top level
    return c.json({ ...student, _meta: { created: r.status === 'created', emailed: r.invited } });
  });

  /**
   * Bulk invite: paste emails separated by commas, semicolons, spaces or new lines
   * (`{ emails: "a@x.ge, b@x.ge" }` or `{ emails: [...] }`), or the older `{ students: [{ name, email }] }`.
   */
  app.post('/api/students/invite', requireAdmin, async (c) => {
    const b = await body(c);
    const raw: string[] = Array.isArray(b?.emails) ? b.emails.map(String) : String(b?.emails || '').split(/[\s,;]+/);
    const seen = new Set<string>();
    const valid: string[] = [];
    const invalid: string[] = [];
    for (const item of raw) {
      // accept "Name <email>" as pasted from mail clients
      const email = (/<([^>]+)>/.exec(item)?.[1] || item).trim().replace(/^mailto:/i, '').toLowerCase();
      if (!email || !email.includes('@')) continue; // names pasted along with "Name <email>"
      if (!EMAIL_RE.test(email)) invalid.push(item.trim());
      else if (!seen.has(email)) {
        seen.add(email);
        valid.push(email);
      }
    }
    if (valid.length > 500) return c.json({ error: 'At most 500 emails per invite' }, 400);
    const results = await inviteStudents(valid.map((email) => ({ email, department: b?.department })));
    return c.json({
      created: results.filter((r) => r.status === 'created').length,
      existing: results.filter((r) => r.status === 'exists').length,
      invited: results.filter((r) => r.invited).length,
      invalid,
      results,
    });
  });

  app.post('/api/students/bulk', requireAdmin, async (c) => {
    const b = await body(c);
    const list = (Array.isArray(b?.students) ? b.students : []).filter((s: any) => s?.email && EMAIL_RE.test(String(s.email).trim()));
    const results = await inviteStudents(
      list.slice(0, 500).map((s: any) => ({ name: s.name ? String(s.name) : undefined, email: String(s.email).trim().toLowerCase(), department: s.department }))
    );
    return c.json({ count: results.length, results });
  });

  /**
   * Lecturer fallback when a student's code email can't be delivered: issues a fresh sign-in code,
   * tries to email it, and shows it to the lecturer to pass on if the email didn't go out.
   */
  app.post('/api/students/:email/login-code', requireAdmin, async (c) => {
    const user = store.getUserByEmail(c.req.param('email'));
    if (!user || user.role !== 'student') return c.json({ error: 'Student not found' }, 404);
    const { code, emailed } = await issueOtp(user);
    return c.json({ success: true, emailed, expiresInSeconds: OTP_TTL_MS / 1000, code: emailed ? undefined : code });
  });

  /** Lecturer edits a student's details. Changing the email also moves their login and records. */
  app.patch('/api/students/:email', requireAdmin, async (c) => {
    const b = await body(c);
    const updates: { name?: string; email?: string; department?: string; digestSubscribed?: boolean } = {};
    if (b.name !== undefined) {
      if (!String(b.name).trim()) return c.json({ error: 'Name cannot be empty' }, 400);
      updates.name = String(b.name).trim().slice(0, 200);
    }
    if (b.email !== undefined) {
      if (!/^\S+@\S+\.\S+$/.test(String(b.email).trim())) return c.json({ error: 'Valid email is required' }, 400);
      updates.email = String(b.email).trim().toLowerCase();
    }
    if (b.department !== undefined) updates.department = String(b.department).trim().slice(0, 200);
    if (b.digestSubscribed !== undefined) updates.digestSubscribed = Boolean(b.digestSubscribed);
    const result = store.updateStudent(c.req.param('email'), updates);
    if (result === 'not_found') return c.json({ error: 'Student not found' }, 404);
    if (result === 'email_taken') return c.json({ error: 'ეს ელ-ფოსტა უკვე გამოიყენება / This email is already in use' }, 409);
    return c.json(result);
  });

  app.delete('/api/students/:email', requireAdmin, (c) => {
    if (!store.deleteStudent(c.req.param('email'))) return c.json({ error: 'Student not found' }, 404);
    return c.json({ success: true });
  });

  // A student may change only their own subscription; admin may change anyone's
  app.patch('/api/students/:email/subscription', requireAuth, async (c) => {
    const target = c.req.param('email').toLowerCase();
    const user = c.get('user');
    if (user.role !== 'admin' && user.email.toLowerCase() !== target) return c.json({ error: 'Forbidden' }, 403);
    const updated = store.updateStudentSubscription(target, Boolean((await body(c))?.digestSubscribed));
    if (!updated) return c.json({ error: 'Student not found' }, 404);
    return c.json(updated);
  });

  // -------------------------------------------------------------------------
  // Knowledge base (admin only — students never see raw materials)
  // -------------------------------------------------------------------------
  app.get('/api/knowledge', requireAdmin, (c) => c.json(store.getKnowledgeDocs()));

  app.post('/api/knowledge', requireAdmin, async (c) => {
    const { title, subject, tags, content, summary } = await body(c);
    if (!title || !content) return c.json({ error: 'Title and content are required' }, 400);
    const doc = store.addKnowledgeDoc({
      title: String(title),
      subject: String(subject || 'სტარტაპები და ინოვაციური მეწარმეობა'),
      tags: Array.isArray(tags) ? tags.map(String) : [tags].filter(Boolean).map(String),
      content: String(content),
      summary: String(summary || String(content).slice(0, 160) + '…'),
      lastUpdatedBy: c.get('user').name,
    });
    return c.json(doc);
  });

  app.delete('/api/knowledge/:id', requireAdmin, (c) => {
    if (!store.deleteKnowledgeDoc(c.req.param('id'))) return c.json({ error: 'Document not found' }, 404);
    return c.json({ success: true });
  });

  /**
   * Bulk upload of course materials: several files (PDF, DOCX, TXT, MD) and/or pasted text in one
   * multipart request (fields `files`, `text`, `textTitle`, `subject`). Each one is extracted and
   * saved straight into the knowledge base the AI answers from. Very large texts are split into
   * numbered parts, because one stored record must stay well under the Durable Object's 2 MB limit.
   */
  app.post('/api/knowledge/bulk', requireAdmin, async (c) => {
    const form = await c.req.parseBody({ all: true });
    const files = ([] as unknown[]).concat(form['files'] ?? []).filter((f): f is File => f instanceof File);
    const pasted = String(form['text'] ?? '').trim();
    if (!files.length && !pasted) return c.json({ error: 'Add at least one file or some text' }, 400);
    if (files.length > 20) return c.json({ error: 'At most 20 files per upload' }, 400);
    const subject = String(form['subject'] ?? '').trim() || 'მეწარმეობა და ინოვაციები';
    const by = c.get('user').name;
    const PART = 400_000; // characters; Georgian is 3 bytes per character in UTF-8

    const save = (title: string, text: string, source: string) => {
      const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      const parts = Math.ceil(clean.length / PART);
      const ids: string[] = [];
      for (let i = 0; i < parts; i++) {
        const content = clean.slice(i * PART, (i + 1) * PART);
        const doc = store.addKnowledgeDoc({
          title: parts > 1 ? `${title} (${i + 1}/${parts})` : title,
          subject,
          tags: [source],
          content,
          summary: content.replace(/\s+/g, ' ').slice(0, 200) + (content.length > 200 ? '…' : ''),
          lastUpdatedBy: by,
        });
        ids.push(doc.id);
      }
      return ids;
    };

    const results: { name: string; ok: boolean; characters?: number; parts?: number; error?: string }[] = [];
    for (const file of files) {
      try {
        if (file.size > 25 * 1024 * 1024) throw new Error('File is larger than 25 MB');
        const text = await extractTextFromFile(new Uint8Array(await file.arrayBuffer()), file.name, file.type);
        if (!text.trim()) throw new Error('No text found (scanned PDF? run OCR first)');
        const ids = save(file.name.replace(/\.[^.]+$/, ''), text, 'file');
        results.push({ name: file.name, ok: true, characters: text.length, parts: ids.length });
      } catch (err: any) {
        results.push({ name: file.name, ok: false, error: String(err?.message || err).slice(0, 200) });
      }
    }
    if (pasted) {
      const title = String(form['textTitle'] ?? '').trim() || `ტექსტი ${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tbilisi' })}`;
      const ids = save(title, pasted, 'text');
      results.push({ name: title, ok: true, characters: pasted.length, parts: ids.length });
    }
    return c.json({ saved: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
  });

  /** Upload PDF / DOCX / TXT / MD → returns extracted text for the lecturer to review & save. */
  app.post('/api/knowledge/extract', requireAdmin, async (c) => {
    const form = await c.req.parseBody();
    const file = form['file'];
    if (!(file instanceof File)) return c.json({ error: 'No file uploaded (field name: "file")' }, 400);
    if (file.size > 25 * 1024 * 1024) return c.json({ error: 'File is larger than 25 MB' }, 413);
    const text = await extractTextFromFile(new Uint8Array(await file.arrayBuffer()), file.name, file.type);
    if (!text.trim()) {
      return c.json({ error: 'No text found. If this is a scanned PDF, run OCR first or paste the text.' }, 422);
    }
    return c.json({ filename: file.name, characters: text.length, text });
  });

  // -------------------------------------------------------------------------
  // Tests
  // -------------------------------------------------------------------------
  app.get('/api/tests', requireAuth, (c) => {
    const user = c.get('user');
    const tests = store.getTests();
    if (user.role === 'admin') return c.json(tests);
    return c.json(
      tests
        .filter((t) => t.status !== 'draft')
        .map((t) => {
          const submitted = Boolean(store.getAttempt(t.id, user.email)?.submittedAt);
          return sanitizeTestForStudent(t, submitted); // questions visible only after own submission (for review)
        })
    );
  });

  app.get('/api/tests/:id', requireAdmin, (c) => {
    const test = store.getTestById(c.req.param('id'));
    if (!test) return c.json({ error: 'Test not found' }, 404);
    return c.json(test);
  });

  function validateQuestions(questions: unknown): string | null {
    if (!Array.isArray(questions) || questions.length === 0) return 'At least one question is required';
    if (questions.some((q: any) => !(Number(q?.points) > 0))) return 'Every question needs a positive number of points';
    const total = roundPts(questions.reduce((acc: number, q: any) => acc + Number(q.points), 0));
    if (total > MAX_TEST_POINTS) return `Total points cannot exceed ${MAX_TEST_POINTS} (currently ${total}).`;
    return null;
  }

  app.post('/api/tests', requireAdmin, async (c) => {
    const b = await body(c);
    if (!b.title) return c.json({ error: 'Title is required' }, 400);
    const err = validateQuestions(b.questions);
    if (err) return c.json({ error: err }, 400);
    const questions: Question[] = b.questions;
    const test = store.createTest({
      title: String(b.title),
      description: String(b.description || ''),
      subject: String(b.subject || 'სტარტაპები და ინოვაციური მეწარმეობა'),
      instructions: String(b.instructions || ''),
      durationMinutes: Number(b.durationMinutes) || 30,
      passingScore: Number(b.passingScore) || 51,
      totalPoints: roundPts(questions.reduce((acc, q) => acc + (Number(q.points) || 0), 0)),
      startTime: b.startTime || new Date().toISOString(),
      endTime: b.endTime || new Date(Date.now() + 7 * 86_400_000).toISOString(),
      status: ['draft', 'upcoming', 'active', 'closed'].includes(b.status) ? b.status : 'active',
      questions,
      createdBy: c.get('user').name,
    });
    return c.json(test);
  });

  app.put('/api/tests/:id', requireAdmin, async (c) => {
    const b = await body(c);
    if (b?.questions) {
      const err = validateQuestions(b.questions);
      if (err) return c.json({ error: err }, 400);
    }
    const updated = store.updateTest(c.req.param('id'), b || {});
    if (!updated) return c.json({ error: 'Test not found' }, 404);
    return c.json(updated);
  });

  app.delete('/api/tests/:id', requireAdmin, (c) => {
    if (!store.deleteTest(c.req.param('id'))) return c.json({ error: 'Test not found' }, 404);
    return c.json({ success: true });
  });

  // -------------------------------------------------------------------------
  // Exam flow: start → (pause/resume) → submit. Server owns the clock.
  // -------------------------------------------------------------------------
  app.post('/api/exam/start', requireAuth, async (c) => {
    const user = c.get('user');
    if (user.role !== 'student') return c.json({ error: 'Only students can take exams' }, 403);
    const test = store.getTestById(String((await body(c))?.testId || ''));
    if (!test || test.status === 'draft') return c.json({ error: 'Test not found' }, 404);
    if (test.status === 'closed' || !isWithinWindow(test)) {
      return c.json({ error: 'გამოცდა ამ დროს არ არის ხელმისაწვდომი / Exam is not open right now' }, 403);
    }
    const existing = store.getAttempt(test.id, user.email);
    if (existing?.submittedAt) return c.json({ error: 'You have already submitted this exam' }, 409);

    const attempt = existing || store.startAttempt(test.id, user.email);
    const remainingSeconds = Math.max(0, Math.floor((deadlineMs(test, attempt) - Date.now()) / 1000));
    if (remainingSeconds <= 0) return c.json({ error: 'Time for this attempt has expired' }, 403);

    return c.json({
      test: sanitizeTestForStudent(test, true),
      attempt: { startedAt: attempt.startedAt, pausesUsed: attempt.pausesUsed, paused: Boolean(attempt.pausedAt) },
      remainingSeconds,
      maxPauses: config.exam.maxPauses,
      resumed: Boolean(existing),
    });
  });

  app.post('/api/exam/pause', requireAuth, async (c) => {
    const b = await body(c);
    const result = proctor.pauseSession(c.get('user').email, String(b?.testId || ''), b?.reason);
    return c.json(result, result.success ? 200 : 400);
  });

  app.post('/api/exam/resume', requireAuth, async (c) => {
    const user = c.get('user');
    const testId = String((await body(c))?.testId || '');
    const test = store.getTestById(testId);
    const result = proctor.resumeSession(user.email, testId);
    if (!result.success || !test) return c.json(result, 400);
    const attempt = store.getAttempt(test.id, user.email)!;
    return c.json({ ...result, remainingSeconds: Math.max(0, Math.floor((deadlineMs(test, attempt) - Date.now()) / 1000)) });
  });

  app.get('/api/exam/session/:studentEmail', requireAdmin, (c) => {
    const session = store.getSession(c.req.param('studentEmail'));
    if (!session) return c.json({ error: 'Session not found' }, 404);
    return c.json(session);
  });

  /** Admin: let a student retake (technical problem, etc.) */
  app.post('/api/admin/attempts/reset', requireAdmin, async (c) => {
    const { testId, studentEmail } = await body(c);
    if (!testId || !studentEmail) return c.json({ error: 'testId and studentEmail are required' }, 400);
    store.resetAttempt(String(testId), String(studentEmail));
    return c.json({ success: true });
  });

  /** Admin: one-off import of data/db.json from the old Node.js server. Replaces everything. */
  app.post('/api/admin/import', requireAdmin, async (c) => {
    const dump = await body(c);
    if (!Array.isArray(dump?.users) || !dump.users.some((u: any) => u?.role === 'admin')) {
      return c.json({ error: 'Expected the old db.json with at least one admin user' }, 400);
    }
    return c.json({ success: true, imported: await store.importLegacy(dump) });
  });

  // -------------------------------------------------------------------------
  // Submissions
  // -------------------------------------------------------------------------
  app.get('/api/submissions', requireAuth, (c) => {
    const { testId, studentEmail } = c.req.query();
    const user = c.get('user');
    if (user.role === 'admin') return c.json(store.getSubmissions(testId, studentEmail));
    return c.json(store.getSubmissions(testId, user.email).map(forStudent));
  });

  app.get('/api/submissions/:id', requireAuth, (c) => {
    const user = c.get('user');
    const sub = store.getSubmissionById(c.req.param('id'));
    if (!sub) return c.json({ error: 'Submission not found' }, 404);
    if (user.role !== 'admin' && sub.studentEmail.toLowerCase() !== user.email.toLowerCase()) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return c.json(user.role === 'admin' ? sub : forStudent(sub));
  });

  /**
   * Grading is 100% manual. Until the lecturer publishes a grade, a student sees their answers
   * and the integrity summary, but no points, pass/fail or feedback.
   */
  function forStudent(sub: TestSubmission): TestSubmission {
    if (sub.status === 'graded') return sub;
    return { ...sub, grading: {}, questionGradings: {}, totalScore: 0, percentage: 0, passed: false };
  }

  app.post('/api/submissions', requireAuth, async (c) => {
    const user = c.get('user');
    if (user.role !== 'student') return c.json({ error: 'Only students can submit' }, 403);
    const b = await body(c);
    const email = user.email.toLowerCase();
    const test = store.getTestById(String(b?.testId || ''));
    if (!test) return c.json({ error: 'Test not found' }, 404);

    const attempt = store.getAttempt(test.id, email);
    if (!attempt) return c.json({ error: 'Exam was not started' }, 400);
    if (attempt.submittedAt) return c.json({ error: 'Already submitted' }, 409);

    // Accept answers until deadline + grace. Late submissions are accepted but flagged.
    const late = Date.now() > deadlineMs(test, attempt) + config.exam.submitGraceSeconds * 1000;

    // Mark submitted first (synchronously) so a double-click can't create two submissions
    if (attempt.pausedAt) {
      attempt.pausedMs += Date.now() - new Date(attempt.pausedAt).getTime();
      attempt.pausedAt = null;
    }
    attempt.submittedAt = new Date().toISOString();
    store.saveAttempt(attempt);

    const answers: Record<string, string | number> = b?.answers && typeof b.answers === 'object' ? b.answers : {};

    const proctorSummary = buildProctorSummary(test.id, email, attempt.pausesUsed);
    if (late) proctorSummary.flagsRaised.unshift('Submitted after the deadline');

    const student = store.getStudentByEmail(email);

    // No automatic scoring of any kind: every submission waits for the lecturer.
    const submission: Omit<TestSubmission, 'id'> = {
      testId: test.id,
      testTitle: test.title,
      studentEmail: email,
      studentName: student?.name || user.name,
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
      answers,
      grading: {},
      questionGradings: {},
      totalScore: 0,
      maxScore: test.totalPoints,
      percentage: 0,
      passed: false,
      status: 'pending_review',
      proctorSummary,
    };
    return c.json(forStudent(store.addSubmission(submission)));
  });

  /** The lecturer's grade. Points are clamped per question; unscored questions count as 0. */
  const applyManualGrade = async (c: Context<AppEnv>) => {
    const sub = store.getSubmissionById(c.req.param('id')!);
    if (!sub) return c.json({ error: 'Submission not found' }, 404);
    const test = store.getTestById(sub.testId);
    if (!test) return c.json({ error: 'Test not found' }, 404);
    const b = await body(c);
    const input: Record<string, Partial<QuestionGrading>> = b?.grading || b?.questionGradings || {};
    const grading: Record<string, QuestionGrading> = {};
    for (const q of test.questions) {
      const g = input[q.id] || {};
      const points = roundPts(Math.min(q.points, Math.max(0, Number(g.earnedPoints) || 0)));
      grading[q.id] = {
        questionId: q.id,
        earnedPoints: points,
        maxPoints: q.points,
        isCorrect: points >= q.points,
        feedback: String(g.feedback || '').slice(0, 4000),
        autoGradedBy: 'proctor_manual',
      };
    }
    const totalScore = roundPts(Object.values(grading).reduce((n, g) => n + g.earnedPoints, 0));
    return c.json(store.updateSubmissionGrading(sub.id, grading, totalScore, test.passingScore));
  };
  app.post('/api/submissions/:id/manual-grade', requireAdmin, applyManualGrade);
  app.patch('/api/submissions/:id/grade', requireAdmin, applyManualGrade);

  // -------------------------------------------------------------------------
  // Proctoring (admin)
  // -------------------------------------------------------------------------
  app.get('/api/proctor/live-sessions', requireAdmin, (c) => c.json(store.getSessions()));
  app.get('/api/proctor/events', requireAdmin, (c) => {
    const { testId, studentEmail } = c.req.query();
    return c.json(store.getProctorEvents(testId, studentEmail).slice(0, 1000));
  });

  // -------------------------------------------------------------------------
  // AI teaching agent (Gemini, silent fallback to OpenRouter)
  // -------------------------------------------------------------------------
  app.get('/api/ai/status', requireAuth, (c) => c.json(aiStatus(config)));
  app.get('/api/ai/models', requireAuth, (c) => c.json(aiStatus(config))); // old frontends

  const chatHandler = async (c: Context<AppEnv>) => {
    const b = await body(c);
    const { message, language } = b || {};
    const history = b?.history || b?.conversationHistory || [];
    if (!message || typeof message !== 'string') return c.json({ error: 'Message is required' }, 400);
    // Routing is server-side only: any `model` sent by the client is ignored
    try {
      const result = await chatWithTeachingAgent(config, {
        message,
        history: Array.isArray(history)
          ? history
              .filter((h: any) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
              .map((h: any) => ({ role: h.role, content: h.content }))
          : [],
        knowledgeDocs: store.getKnowledgeDocs(),
        language: language === 'en' ? 'en' : 'ka',
        studentName: c.get('user').name,
      });
      return c.json(result);
    } catch (err: any) {
      console.error('Chat error:', err);
      return c.json({ error: 'AI service is temporarily unavailable. Please try again.' }, 502);
    }
  };
  app.post('/api/ai/chat', requireAuth, chatLimiter, chatHandler);
  app.post('/api/agent/chat', requireAuth, chatLimiter, chatHandler); // alias used by the frontend

  // -------------------------------------------------------------------------
  // Daily digest
  // -------------------------------------------------------------------------
  app.get('/api/cron/status', requireAdmin, (c) => c.json(digest.getStatus(cronSchedule)));

  app.get('/api/cron/digests', requireAuth, (c) => {
    const digests = store.getDigests().slice(0, 60);
    if (c.get('user').role === 'admin') return c.json(digests);
    return c.json(digests.map(({ recipients, emailHtml, ...d }) => ({ ...d, recipients: [], emailHtml: '' })));
  });

  app.post('/api/cron/trigger', requireAdmin, async (c) => {
    try {
      const { subjectFocus, language } = await body(c);
      const result = await digest.run(subjectFocus || undefined, language === 'en' ? 'en' : 'ka');
      if (!result) {
        return c.json({
          success: true,
          digest: null,
          message: 'ახალი ინფორმაცია არ არის — დაიჯესტი არ შეიქმნა / Nothing new since the last digest — nothing was created or sent.',
        });
      }
      return c.json({ success: true, digest: result });
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed generating digest' }, 500);
    }
  });

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------
  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  app.onError((err: any, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as any);
    console.error(err);
    const status = typeof err?.status === 'number' ? err.status : 500;
    return c.json({ error: config.isProd && status >= 500 ? 'Internal server error' : err?.message || 'Internal server error' }, status);
  });

  return app;
}
