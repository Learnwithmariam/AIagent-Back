import { config } from './config';
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import { db } from './db';
import { chatWithTeachingAgent, gradeQuestionWithAI } from './gemini';
import { cronDigestService } from './cron';
import { proctorWss } from './websocket';
import { mailerService } from './mailer';
import { extractTextFromFile } from './extract';
import {
  requireAuth,
  requireAdmin,
  signToken,
  verifyPassword,
  publicUser,
  generateTempPassword,
} from './auth';
import type { Question, QuestionGrading, Test, TestSubmission, ProctorSummary } from './types';

const app = express();
app.set('trust proxy', 1); // behind Render / Railway / Nginx
app.use(helmet());
app.use(
  cors({
    origin: (origin, cb) => {
      // allow same-origin / curl (no Origin header) and configured frontends
      if (!origin || config.frontendOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
  })
);
app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------------------
// Tiny in-memory rate limiter (keyed per user when logged in, so a whole
// university behind one NAT IP doesn't share one bucket)
// ---------------------------------------------------------------------------
function rateLimit(windowMs: number, max: number, keyFn: (req: Request) => string) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyFn(req);
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.reset - now) / 1000));
      return res.status(429).json({ error: 'Too many requests, please wait a moment.' });
    }
    next();
  };
}
const loginLimiter = rateLimit(15 * 60_000, 10, (req) => `${req.ip}|${String(req.body?.email || '').toLowerCase()}`);
const chatLimiter = rateLimit(60 * 60_000, 60, (req) => req.user?.sub || req.ip || 'anon');

const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const events = db.getProctorEvents(testId, email);
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

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = email ? db.getUserByEmail(email) : undefined;
  // Same message for "no such user" and "wrong password" — don't reveal which emails exist
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'არასწორი ელ-ფოსტა ან პაროლი / Invalid email or password' });
  }
  db.touchLogin(user);
  res.json({
    success: true,
    token: signToken(user),
    user: publicUser(user),
    student: user.role === 'student' ? db.getStudentByEmail(user.email) || null : null,
    requiresPasswordChange: Boolean(user.isTemporaryPassword),
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.getUserById(req.user!.sub);
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  res.json({
    user: publicUser(user),
    student: user.role === 'student' ? db.getStudentByEmail(user.email) || null : null,
  });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const user = db.getUserById(req.user!.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'ახალი პაროლი მინიმუმ 8 სიმბოლო უნდა იყოს / New password must be at least 8 characters' });
  }
  // Current password is required unless the user is on a first-login temporary password
  if (!user.isTemporaryPassword || currentPassword) {
    if (!verifyPassword(String(currentPassword || ''), user.passwordHash)) {
      return res.status(401).json({ error: 'მიმდინარე პაროლი არასწორია / Current password is incorrect' });
    }
  }
  const updated = db.setPassword(user.email, String(newPassword), false)!;
  res.json({ success: true, user: publicUser(updated), token: signToken(updated) });
});

app.get('/api/auth/users', requireAdmin, (_req, res) => {
  res.json(db.getUsers().map(publicUser));
});

app.get('/api/auth/email-logs', requireAdmin, (_req, res) => {
  res.json(mailerService.getAuditLogs());
});

// ---------------------------------------------------------------------------
// Students (admin)
// ---------------------------------------------------------------------------
app.get('/api/students', requireAdmin, (_req, res) => res.json(db.getStudents()));

async function createStudent(name: string, email: string, department?: string) {
  const tempPassword = generateTempPassword();
  const { student, created } = db.addStudent(
    { name, email, department: department || 'ინოვაციური მეწარმეობა და სტარტაპები' },
    tempPassword
  );
  let emailed = false;
  if (created) emailed = await mailerService.sendWelcome({ to: student.email, name: student.name, temporaryPassword: tempPassword });
  // If email isn't configured/failed, return the password ONCE so the lecturer can hand it over.
  return { student, created, emailed, temporaryPassword: created && !emailed ? tempPassword : undefined };
}

app.post(
  '/api/students',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const { name, email, department } = req.body || {};
    if (!name || !email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Valid name and email are required' });
    }
    const result = await createStudent(String(name), String(email), department);
    // keep backwards compatibility: frontend expects the student object at top level
    res.json({ ...result.student, _meta: { created: result.created, emailed: result.emailed, temporaryPassword: result.temporaryPassword } });
  })
);

/** Bulk import: [{ name, email }] — e.g. pasted from the BTU class list */
app.post(
  '/api/students/bulk',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const list = Array.isArray(req.body?.students) ? req.body.students : [];
    const results: { email: string; created: boolean; emailed: boolean; temporaryPassword?: string }[] = [];
    for (const s of list.slice(0, 500)) {
      if (!s?.name || !s?.email) continue;
      const r = await createStudent(String(s.name), String(s.email), s.department);
      results.push({ email: r.student.email, created: r.created, emailed: r.emailed, temporaryPassword: r.temporaryPassword });
    }
    res.json({ count: results.length, results });
  })
);

app.post('/api/students/:email/reset-password', requireAdmin, asyncRoute(async (req, res) => {
  const user = db.getUserByEmail(req.params.email);
  if (!user || user.role !== 'student') return res.status(404).json({ error: 'Student not found' });
  const temp = generateTempPassword();
  db.setPassword(user.email, temp, true);
  const emailed = await mailerService.sendWelcome({ to: user.email, name: user.name, temporaryPassword: temp });
  res.json({ success: true, emailed, temporaryPassword: emailed ? undefined : temp });
}));

app.delete('/api/students/:email', requireAdmin, (req, res) => {
  if (!db.deleteStudent(req.params.email)) return res.status(404).json({ error: 'Student not found' });
  res.json({ success: true });
});

// A student may change only their own subscription; admin may change anyone's
app.patch('/api/students/:email/subscription', requireAuth, (req, res) => {
  const target = req.params.email.toLowerCase();
  if (req.user!.role !== 'admin' && req.user!.email.toLowerCase() !== target) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const updated = db.updateStudentSubscription(target, Boolean(req.body?.digestSubscribed));
  if (!updated) return res.status(404).json({ error: 'Student not found' });
  res.json(updated);
});

// ---------------------------------------------------------------------------
// Knowledge base (admin only — students never see raw materials)
// ---------------------------------------------------------------------------
app.get('/api/knowledge', requireAdmin, (_req, res) => res.json(db.getKnowledgeDocs()));

app.post('/api/knowledge', requireAdmin, (req, res) => {
  const { title, subject, tags, content, summary } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: 'Title and content are required' });
  const doc = db.addKnowledgeDoc({
    title: String(title),
    subject: String(subject || 'სტარტაპები და ინოვაციური მეწარმეობა'),
    tags: Array.isArray(tags) ? tags.map(String) : [tags].filter(Boolean).map(String),
    content: String(content),
    summary: String(summary || String(content).slice(0, 160) + '…'),
    lastUpdatedBy: req.user!.name,
  });
  res.json(doc);
});

app.delete('/api/knowledge/:id', requireAdmin, (req, res) => {
  if (!db.deleteKnowledgeDoc(req.params.id)) return res.status(404).json({ error: 'Document not found' });
  res.json({ success: true });
});

/** Upload PDF / DOCX / TXT / MD → returns extracted text for the lecturer to review & save. */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.post(
  '/api/knowledge/extract',
  requireAdmin,
  upload.single('file'),
  asyncRoute(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: "file")' });
    const text = await extractTextFromFile(req.file.buffer, req.file.originalname, req.file.mimetype);
    if (!text.trim()) {
      return res.status(422).json({ error: 'No text found. If this is a scanned PDF, run OCR first or paste the text.' });
    }
    res.json({ filename: req.file.originalname, characters: text.length, text });
  })
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
app.get('/api/tests', requireAuth, (req, res) => {
  const tests = db.getTests();
  if (req.user!.role === 'admin') return res.json(tests);
  const email = req.user!.email;
  res.json(
    tests
      .filter((t) => t.status !== 'draft')
      .map((t) => {
        const submitted = Boolean(db.getAttempt(t.id, email)?.submittedAt);
        return sanitizeTestForStudent(t, submitted); // questions visible only after own submission (for review)
      })
  );
});

app.get('/api/tests/:id', requireAdmin, (req, res) => {
  const test = db.getTestById(req.params.id);
  if (!test) return res.status(404).json({ error: 'Test not found' });
  res.json(test);
});

function validateQuestions(questions: unknown): string | null {
  if (!Array.isArray(questions) || questions.length === 0) return 'At least one question is required';
  const total = questions.reduce((acc: number, q: any) => acc + (Number(q?.points) || 0), 0);
  if (total > 100) return `Total points cannot exceed 100 (currently ${total}).`;
  return null;
}

app.post('/api/tests', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'Title is required' });
  const err = validateQuestions(b.questions);
  if (err) return res.status(400).json({ error: err });
  const questions: Question[] = b.questions;
  const test = db.createTest({
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
    createdBy: req.user!.name,
  });
  res.json(test);
});

app.put('/api/tests/:id', requireAdmin, (req, res) => {
  if (req.body?.questions) {
    const err = validateQuestions(req.body.questions);
    if (err) return res.status(400).json({ error: err });
  }
  const updated = db.updateTest(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Test not found' });
  res.json(updated);
});

app.delete('/api/tests/:id', requireAdmin, (req, res) => {
  if (!db.deleteTest(req.params.id)) return res.status(404).json({ error: 'Test not found' });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Exam flow: start → (pause/resume) → submit. Server owns the clock.
// ---------------------------------------------------------------------------
app.post('/api/exam/start', requireAuth, (req, res) => {
  if (req.user!.role !== 'student') return res.status(403).json({ error: 'Only students can take exams' });
  const test = db.getTestById(String(req.body?.testId || ''));
  if (!test || test.status === 'draft') return res.status(404).json({ error: 'Test not found' });
  if (test.status === 'closed' || !isWithinWindow(test)) {
    return res.status(403).json({ error: 'გამოცდა ამ დროს არ არის ხელმისაწვდომი / Exam is not open right now' });
  }
  const existing = db.getAttempt(test.id, req.user!.email);
  if (existing?.submittedAt) return res.status(409).json({ error: 'You have already submitted this exam' });

  const attempt = existing || db.startAttempt(test.id, req.user!.email);
  const remainingSeconds = Math.max(0, Math.floor((deadlineMs(test, attempt) - Date.now()) / 1000));
  if (remainingSeconds <= 0) return res.status(403).json({ error: 'Time for this attempt has expired' });

  res.json({
    test: sanitizeTestForStudent(test, true),
    attempt: { startedAt: attempt.startedAt, pausesUsed: attempt.pausesUsed, paused: Boolean(attempt.pausedAt) },
    remainingSeconds,
    maxPauses: config.exam.maxPauses,
    resumed: Boolean(existing),
  });
});

app.post('/api/exam/pause', requireAuth, (req, res) => {
  const result = proctorWss.pauseSession(req.user!.email, String(req.body?.testId || ''), req.body?.reason);
  res.status(result.success ? 200 : 400).json(result);
});

app.post('/api/exam/resume', requireAuth, (req, res) => {
  const test = db.getTestById(String(req.body?.testId || ''));
  const result = proctorWss.resumeSession(req.user!.email, String(req.body?.testId || ''));
  if (!result.success || !test) return res.status(400).json(result);
  const attempt = db.getAttempt(test.id, req.user!.email)!;
  res.json({ ...result, remainingSeconds: Math.max(0, Math.floor((deadlineMs(test, attempt) - Date.now()) / 1000)) });
});

app.get('/api/exam/session/:studentEmail', requireAdmin, (req, res) => {
  const session = proctorWss.getSession(req.params.studentEmail);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

/** Admin: let a student retake (technical problem, etc.) */
app.post('/api/admin/attempts/reset', requireAdmin, (req, res) => {
  const { testId, studentEmail } = req.body || {};
  if (!testId || !studentEmail) return res.status(400).json({ error: 'testId and studentEmail are required' });
  db.resetAttempt(String(testId), String(studentEmail));
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------
app.get('/api/submissions', requireAuth, (req, res) => {
  const { testId, studentEmail } = req.query as Record<string, string | undefined>;
  if (req.user!.role === 'admin') return res.json(db.getSubmissions(testId, studentEmail));
  res.json(db.getSubmissions(testId, req.user!.email));
});

app.get('/api/submissions/:id', requireAuth, (req, res) => {
  const sub = db.getSubmissionById(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  if (req.user!.role !== 'admin' && sub.studentEmail.toLowerCase() !== req.user!.email.toLowerCase()) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(sub);
});

app.post(
  '/api/submissions',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (req.user!.role !== 'student') return res.status(403).json({ error: 'Only students can submit' });
    const email = req.user!.email.toLowerCase();
    const test = db.getTestById(String(req.body?.testId || ''));
    if (!test) return res.status(404).json({ error: 'Test not found' });

    const attempt = db.getAttempt(test.id, email);
    if (!attempt) return res.status(400).json({ error: 'Exam was not started' });
    if (attempt.submittedAt) return res.status(409).json({ error: 'Already submitted' });

    // Accept answers until deadline + grace. Late submissions are accepted but flagged.
    const late = Date.now() > deadlineMs(test, attempt) + config.exam.submitGraceSeconds * 1000;

    // Mark submitted first so a double-click can't create two submissions
    if (attempt.pausedAt) {
      attempt.pausedMs += Date.now() - new Date(attempt.pausedAt).getTime();
      attempt.pausedAt = null;
    }
    attempt.submittedAt = new Date().toISOString();
    db.saveAttempt(attempt);

    const answers: Record<string, string | number> = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
    const language = req.body?.language === 'en' ? 'en' : 'ka';

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
          const g = await gradeQuestionWithAI({ question: q, studentAnswer: String(ans ?? ''), language });
          if (g.needsReview) needsReview = true;
          totalScore += g.earnedPoints;
          grading[q.id] = g;
        }
      })
    );

    const proctorSummary = buildProctorSummary(test.id, email, attempt.pausesUsed);
    if (late) proctorSummary.flagsRaised.unshift('Submitted after the deadline');

    const percentage = test.totalPoints > 0 ? Math.round((totalScore / test.totalPoints) * 100) : 0;
    const student = db.getStudentByEmail(email);

    const submission: Omit<TestSubmission, 'id'> = {
      testId: test.id,
      testTitle: test.title,
      studentEmail: email,
      studentName: student?.name || req.user!.name,
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
    res.json(db.addSubmission(submission));
  })
);

function applyManualGrade(req: Request, res: Response) {
  const sub = db.getSubmissionById(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  const grading: Record<string, QuestionGrading> = req.body?.grading || req.body?.questionGradings || {};
  const totalScore = Object.values(grading).reduce((n, g) => n + (Number(g?.earnedPoints) || 0), 0);
  const test = db.getTestById(sub.testId);
  const cleaned = Object.fromEntries(
    Object.entries(grading).map(([k, g]) => [k, { ...g, needsReview: false, autoGradedBy: g.autoGradedBy || 'proctor_manual' }])
  ) as Record<string, QuestionGrading>;
  res.json(db.updateSubmissionGrading(sub.id, cleaned, totalScore, test?.passingScore ?? 51));
}
app.post('/api/submissions/:id/manual-grade', requireAdmin, applyManualGrade);
app.patch('/api/submissions/:id/grade', requireAdmin, applyManualGrade);

/** Admin: re-run AI grading on a single answer from the grading modal */
app.post(
  '/api/ai/grade',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const { question, studentAnswer, language } = req.body || {};
    if (!question?.id) return res.status(400).json({ error: 'question is required' });
    // Use the stored question (with rubric) if we can find it
    const stored = db
      .getTests()
      .flatMap((t) => t.questions)
      .find((q) => q.id === question.id && q.prompt === question.prompt);
    res.json(await gradeQuestionWithAI({ question: stored || question, studentAnswer: String(studentAnswer ?? ''), language }));
  })
);

// ---------------------------------------------------------------------------
// Proctoring (admin)
// ---------------------------------------------------------------------------
app.get('/api/proctor/live-sessions', requireAdmin, (_req, res) => res.json(proctorWss.getActiveSessions()));
app.get('/api/proctor/events', requireAdmin, (req, res) => {
  const { testId, studentEmail } = req.query as Record<string, string | undefined>;
  res.json(db.getProctorEvents(testId, studentEmail).slice(0, 1000));
});

// ---------------------------------------------------------------------------
// AI teaching agent
// ---------------------------------------------------------------------------
const chatHandler = asyncRoute(async (req, res) => {
  const { message, language } = req.body || {};
  const history = req.body?.history || req.body?.conversationHistory || [];
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message is required' });
  try {
    const result = await chatWithTeachingAgent({
      message,
      history: Array.isArray(history)
        ? history
            .filter((h: any) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
            .map((h: any) => ({ role: h.role, content: h.content }))
        : [],
      knowledgeDocs: db.getKnowledgeDocs(),
      language: language === 'en' ? 'en' : 'ka',
      studentName: req.user!.name,
    });
    res.json(result);
  } catch (err: any) {
    console.error('Chat error:', err);
    res.status(502).json({ error: 'AI service is temporarily unavailable. Please try again.' });
  }
});
app.post('/api/ai/chat', requireAuth, chatLimiter, chatHandler);
app.post('/api/agent/chat', requireAuth, chatLimiter, chatHandler); // alias used by the current frontend

// ---------------------------------------------------------------------------
// Daily digest
// ---------------------------------------------------------------------------
app.get('/api/cron/status', requireAdmin, (_req, res) => res.json(cronDigestService.getStatus()));

app.get('/api/cron/digests', requireAuth, (req, res) => {
  const digests = db.getDigests().slice(0, 60);
  if (req.user!.role === 'admin') return res.json(digests);
  res.json(digests.map(({ recipients, ...d }) => ({ ...d, recipients: [] })));
});

app.post(
  '/api/cron/trigger',
  requireAdmin,
  asyncRoute(async (req, res) => {
    try {
      const { subjectFocus, language } = req.body || {};
      const digest = await cronDigestService.runDailyDigestTask(subjectFocus || undefined, language === 'en' ? 'en' : 'ka');
      res.json({ success: true, digest });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed generating digest' });
    }
  })
);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  const status = err?.message?.includes('CORS') ? 403 : err?.status || 500;
  res.status(status).json({ error: config.isProd ? 'Internal server error' : err?.message || 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = http.createServer(app);
proctorWss.init(server);
cronDigestService.start();
server.listen(config.port, '0.0.0.0', () => {
  console.log(`🚀 CogniTest API on http://localhost:${config.port}`);
  console.log(`   Allowed frontend origins: ${config.frontendOrigins.join(', ')}`);
});
