import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { APP_NAME, type Config } from './config';
import type { Store } from './store';
import type { ProctorHub } from './proctor';
import type { Mailer } from './mailer';
import type { DigestService } from './digest';
import { availableModels, chatWithTeachingAgent, gradeQuestionWithAI } from './ai';
import { extractTextFromFile } from './extract';
import { signToken, verifyToken, verifyPassword, isLegacyHash, publicUser, generateTempPassword, type TokenPayload } from './auth';
import type { Question, QuestionGrading, Test, TestSubmission, ProctorSummary } from './types';

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
  const loginLimiter = rateLimit(15 * 60_000, 10, async (c) => `${clientIp(c)}|${String((await body(c))?.email || '').toLowerCase()}`);
  const chatLimiter = rateLimit(60 * 60_000, 60, (c) => c.get('user')?.sub || clientIp(c));

  // -------------------------------------------------------------------------
  // Auth middleware
  // -------------------------------------------------------------------------
  const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
    const header = c.req.header('Authorization') || '';
    const payload = await verifyToken(header.startsWith('Bearer ') ? header.slice(7) : '', config);
    if (!payload) return c.json({ error: 'Authentication required' }, 401);
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
    if (!user) return c.text('Unauthorized', 401);
    return proctor.accept(user);
  });

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------
  app.post(
    '/api/auth/login',
    loginLimiter,
    async (c) => {
      const b = await body(c);
      const email = String(b.email || '').trim().toLowerCase();
      const password = String(b.password || '');
      const user = email ? store.getUserByEmail(email) : undefined;
      // Same message for "no such user" and "wrong password" — don't reveal which emails exist
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return c.json({ error: 'არასწორი ელ-ფოსტა ან პაროლი / Invalid email or password' }, 401);
      }
      // Upgrade hashes imported from the old Node server to the Workers-native format
      if (isLegacyHash(user.passwordHash)) await store.setPassword(user.email, password, user.isTemporaryPassword);
      store.touchLogin(user);
      return c.json({
        success: true,
        token: await signToken(user, config),
        user: publicUser(user),
        student: user.role === 'student' ? store.getStudentByEmail(user.email) || null : null,
        requiresPasswordChange: Boolean(user.isTemporaryPassword),
      });
    }
  );

  app.get('/api/auth/me', requireAuth, (c) => {
    const user = store.getUserById(c.get('user').sub);
    if (!user) return c.json({ error: 'Account no longer exists' }, 401);
    return c.json({
      user: publicUser(user),
      student: user.role === 'student' ? store.getStudentByEmail(user.email) || null : null,
    });
  });

  app.post('/api/auth/change-password', requireAuth, async (c) => {
    const user = store.getUserById(c.get('user').sub);
    if (!user) return c.json({ error: 'User not found' }, 404);
    const { currentPassword, newPassword } = await body(c);
    if (!newPassword || String(newPassword).length < 8) {
      return c.json({ error: 'ახალი პაროლი მინიმუმ 8 სიმბოლო უნდა იყოს / New password must be at least 8 characters' }, 400);
    }
    // Current password is required unless the user is on a first-login temporary password
    if (!user.isTemporaryPassword || currentPassword) {
      if (!(await verifyPassword(String(currentPassword || ''), user.passwordHash))) {
        // 400, not 401: the frontend treats any 401 as an expired session and logs the user out
        return c.json({ error: 'მიმდინარე პაროლი არასწორია / Current password is incorrect' }, 400);
      }
    }
    const updated = (await store.setPassword(user.email, String(newPassword), false))!;
    return c.json({ success: true, user: publicUser(updated), token: await signToken(updated, config) });
  });

  app.get('/api/auth/users', requireAdmin, (c) => c.json(store.getUsers().map(publicUser)));
  app.get('/api/auth/email-logs', requireAdmin, (c) => c.json(mailer.getAuditLogs()));

  // -------------------------------------------------------------------------
  // Students (admin)
  // -------------------------------------------------------------------------
  app.get('/api/students', requireAdmin, (c) => c.json(store.getStudents()));

  async function createStudent(name: string, email: string, department?: string) {
    const tempPassword = generateTempPassword();
    const { student, created } = await store.addStudent(
      { name, email, department: department || 'ინოვაციური მეწარმეობა და სტარტაპები' },
      tempPassword
    );
    let emailed = false;
    if (created) emailed = await mailer.sendWelcome({ to: student.email, name: student.name, temporaryPassword: tempPassword });
    // If email isn't configured/failed, return the password ONCE so the lecturer can hand it over.
    return { student, created, emailed, temporaryPassword: created && !emailed ? tempPassword : undefined };
  }

  app.post('/api/students', requireAdmin, async (c) => {
    const { name, email, department } = await body(c);
    if (!name || !email || !/^\S+@\S+\.\S+$/.test(email)) {
      return c.json({ error: 'Valid name and email are required' }, 400);
    }
    const result = await createStudent(String(name), String(email), department);
    // keep backwards compatibility: frontend expects the student object at top level
    return c.json({ ...result.student, _meta: { created: result.created, emailed: result.emailed, temporaryPassword: result.temporaryPassword } });
  });

  /** Bulk import: [{ name, email }] — e.g. pasted from the BTU class list */
  app.post('/api/students/bulk', requireAdmin, async (c) => {
    const b = await body(c);
    const list = Array.isArray(b?.students) ? b.students : [];
    const results: { email: string; created: boolean; emailed: boolean; temporaryPassword?: string }[] = [];
    for (const s of list.slice(0, 500)) {
      if (!s?.name || !s?.email) continue;
      const r = await createStudent(String(s.name), String(s.email), s.department);
      results.push({ email: r.student.email, created: r.created, emailed: r.emailed, temporaryPassword: r.temporaryPassword });
    }
    return c.json({ count: results.length, results });
  });

  app.post('/api/students/:email/reset-password', requireAdmin, async (c) => {
    const user = store.getUserByEmail(c.req.param('email'));
    if (!user || user.role !== 'student') return c.json({ error: 'Student not found' }, 404);
    const temp = generateTempPassword();
    await store.setPassword(user.email, temp, true);
    const emailed = await mailer.sendWelcome({ to: user.email, name: user.name, temporaryPassword: temp });
    return c.json({ success: true, emailed, temporaryPassword: emailed ? undefined : temp });
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
    const total = questions.reduce((acc: number, q: any) => acc + (Number(q?.points) || 0), 0);
    if (total > 100) return `Total points cannot exceed 100 (currently ${total}).`;
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
      totalPoints: questions.reduce((acc, q) => acc + (Number(q.points) || 0), 0),
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
    return c.json(store.getSubmissions(testId, user.email));
  });

  app.get('/api/submissions/:id', requireAuth, (c) => {
    const user = c.get('user');
    const sub = store.getSubmissionById(c.req.param('id'));
    if (!sub) return c.json({ error: 'Submission not found' }, 404);
    if (user.role !== 'admin' && sub.studentEmail.toLowerCase() !== user.email.toLowerCase()) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return c.json(sub);
  });

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
    const language = b?.language === 'en' ? 'en' : 'ka';

    const grading: Record<string, QuestionGrading> = {};
    let totalScore = 0;
    let needsReview = false;

    await Promise.all(
      test.questions.map(async (q) => {
        const ans = answers[q.id];
        if (q.type === 'mcq') {
          const answered = ans !== undefined && ans !== null && ans !== '';
          const isCorrect = answered && Number(ans) === Number(q.correctAnswer);
          const earned = isCorrect ? q.points : 0;
          totalScore += earned;
          grading[q.id] = {
            questionId: q.id,
            earnedPoints: earned,
            maxPoints: q.points,
            isCorrect,
            // Don't reveal the correct option — other students may still be taking the exam
            feedback: isCorrect ? (language === 'ka' ? 'სწორია.' : 'Correct.') : language === 'ka' ? 'არასწორია.' : 'Incorrect.',
            autoGradedBy: 'mcq_rule',
          };
        } else {
          const g = await gradeQuestionWithAI(config, { question: q, studentAnswer: String(ans ?? ''), language });
          if (g.needsReview) needsReview = true;
          totalScore += g.earnedPoints;
          grading[q.id] = g;
        }
      })
    );

    const proctorSummary = buildProctorSummary(test.id, email, attempt.pausesUsed);
    if (late) proctorSummary.flagsRaised.unshift('Submitted after the deadline');

    const percentage = test.totalPoints > 0 ? Math.round((totalScore / test.totalPoints) * 100) : 0;
    const student = store.getStudentByEmail(email);

    const submission: Omit<TestSubmission, 'id'> = {
      testId: test.id,
      testTitle: test.title,
      studentEmail: email,
      studentName: student?.name || user.name,
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
      answers,
      grading,
      questionGradings: grading,
      totalScore,
      maxScore: test.totalPoints,
      percentage,
      passed: percentage >= test.passingScore,
      // AI grades are provisional until the lecturer confirms them if anything was flagged
      status: needsReview || late ? 'pending_review' : 'graded',
      gradedBy: 'auto',
      proctorSummary,
    };
    return c.json(store.addSubmission(submission));
  });

  const applyManualGrade = async (c: Context<AppEnv>) => {
    const sub = store.getSubmissionById(c.req.param('id')!);
    if (!sub) return c.json({ error: 'Submission not found' }, 404);
    const b = await body(c);
    const grading: Record<string, QuestionGrading> = b?.grading || b?.questionGradings || {};
    const totalScore = Object.values(grading).reduce((n, g) => n + (Number(g?.earnedPoints) || 0), 0);
    const test = store.getTestById(sub.testId);
    const cleaned = Object.fromEntries(
      Object.entries(grading).map(([k, g]) => [k, { ...g, needsReview: false, autoGradedBy: g.autoGradedBy || 'proctor_manual' }])
    ) as Record<string, QuestionGrading>;
    return c.json(store.updateSubmissionGrading(sub.id, cleaned, totalScore, test?.passingScore ?? 51));
  };
  app.post('/api/submissions/:id/manual-grade', requireAdmin, applyManualGrade);
  app.patch('/api/submissions/:id/grade', requireAdmin, applyManualGrade);

  /** Admin: re-run AI grading on a single answer from the grading modal */
  app.post('/api/ai/grade', requireAdmin, async (c) => {
    const { question, studentAnswer, language } = await body(c);
    if (!question?.id) return c.json({ error: 'question is required' }, 400);
    // Use the stored question (with rubric) if we can find it
    const stored = store
      .getTests()
      .flatMap((t) => t.questions)
      .find((q) => q.id === question.id && q.prompt === question.prompt);
    return c.json(await gradeQuestionWithAI(config, { question: stored || question, studentAnswer: String(studentAnswer ?? ''), language }));
  });

  // -------------------------------------------------------------------------
  // Proctoring (admin)
  // -------------------------------------------------------------------------
  app.get('/api/proctor/live-sessions', requireAdmin, (c) => c.json(store.getSessions()));
  app.get('/api/proctor/events', requireAdmin, (c) => {
    const { testId, studentEmail } = c.req.query();
    return c.json(store.getProctorEvents(testId, studentEmail).slice(0, 1000));
  });

  // -------------------------------------------------------------------------
  // AI teaching agent (OpenRouter)
  // -------------------------------------------------------------------------
  app.get('/api/ai/models', requireAuth, (c) => c.json(availableModels(config)));

  const chatHandler = async (c: Context<AppEnv>) => {
    const b = await body(c);
    const { message, language } = b || {};
    const history = b?.history || b?.conversationHistory || [];
    if (!message || typeof message !== 'string') return c.json({ error: 'Message is required' }, 400);
    // Only models from the server's allow-list — the client can't route to arbitrary (paid) models
    const model = config.openrouter.chatModels.includes(b?.model) ? b.model : undefined;
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
        model,
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
    return c.json(digests.map(({ recipients, ...d }) => ({ ...d, recipients: [] })));
  });

  app.post('/api/cron/trigger', requireAdmin, async (c) => {
    try {
      const { subjectFocus, language } = await body(c);
      const result = await digest.run(subjectFocus || undefined, language === 'en' ? 'en' : 'ka');
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
