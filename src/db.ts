import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  Student,
  KnowledgeDoc,
  Test,
  TestSubmission,
  ProctorEvent,
  DailyDigest,
  UserAccount,
  ExamAttempt,
} from './types';
import { config } from './config';
import { hashPassword } from './auth';
import { SEED_KNOWLEDGE, SEED_TESTS } from './seed';

/**
 * Simple JSON-file database.
 * Good enough for one course (~100–300 students). For more, or for hosts with an
 * ephemeral filesystem (Render free tier, Railway without a volume), move to Postgres/Supabase.
 * The public API of this class is intentionally small so it can be swapped later.
 */

interface DatabaseSchema {
  users: UserAccount[];
  students: Student[];
  knowledgeDocs: KnowledgeDoc[];
  tests: Test[];
  submissions: TestSubmission[];
  proctorEvents: ProctorEvent[];
  digests: DailyDigest[];
  attempts: ExamAttempt[];
}

const DATA_DIR = path.resolve(process.cwd(), config.dataDir);
const DB_FILE = path.join(DATA_DIR, 'db.json');

const newId = (prefix: string) => `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

class Database {
  private data: DatabaseSchema;

  constructor() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    this.data = this.load();
    this.migrate();
    this.ensureAdmin();
    this.persist();
  }

  private load(): DatabaseSchema {
    const empty: DatabaseSchema = {
      users: [],
      students: [],
      knowledgeDocs: [...SEED_KNOWLEDGE],
      tests: [...SEED_TESTS],
      submissions: [],
      proctorEvents: [],
      digests: [],
      attempts: [],
    };
    if (!fs.existsSync(DB_FILE)) return empty;
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
      return { ...empty, ...parsed };
    } catch (err) {
      // Never silently overwrite a corrupted DB — keep a copy for manual recovery.
      const backup = `${DB_FILE}.corrupt-${Date.now()}`;
      fs.copyFileSync(DB_FILE, backup);
      console.error(`DB file unreadable, backed up to ${backup}. Starting fresh.`, err);
      return empty;
    }
  }

  /** Upgrade data written by the old prototype (plaintext passwords etc.). */
  private migrate() {
    for (const u of this.data.users) {
      if (u.temporaryPassword && !u.passwordHash) {
        u.passwordHash = hashPassword(u.temporaryPassword);
        u.isTemporaryPassword = true; // force a change after migration
      }
      delete u.temporaryPassword;
    }
    if (!Array.isArray(this.data.attempts)) this.data.attempts = [];
  }

  /** Creates the lecturer account from ADMIN_EMAIL / ADMIN_PASSWORD on first boot. */
  private ensureAdmin() {
    if (this.data.users.some((u) => u.role === 'admin')) return;
    if (!config.adminEmail || !config.adminPassword) {
      console.warn(
        '⚠️  No admin account exists. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env and restart to create one.'
      );
      return;
    }
    this.data.users.push({
      id: newId('user-admin'),
      email: config.adminEmail,
      name: config.adminName,
      role: 'admin',
      passwordHash: hashPassword(config.adminPassword),
      isTemporaryPassword: false,
      createdAt: new Date().toISOString(),
    });
    console.log(`✅ Admin account created for ${config.adminEmail}`);
  }

  private persist() {
    // write-then-rename so a crash mid-write can't corrupt the file
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmp, DB_FILE);
  }

  // ---------- Users ----------
  getUsers(): UserAccount[] {
    return this.data.users;
  }

  getUserByEmail(email: string): UserAccount | undefined {
    const e = email.trim().toLowerCase();
    return this.data.users.find((u) => u.email.toLowerCase() === e);
  }

  getUserById(id: string): UserAccount | undefined {
    return this.data.users.find((u) => u.id === id);
  }

  touchLogin(user: UserAccount) {
    user.lastLoginAt = new Date().toISOString();
    this.persist();
  }

  setPassword(email: string, newPassword: string, temporary: boolean): UserAccount | null {
    const user = this.getUserByEmail(email);
    if (!user) return null;
    user.passwordHash = hashPassword(newPassword);
    user.isTemporaryPassword = temporary;
    this.persist();
    return user;
  }

  // ---------- Students ----------
  getStudents(): Student[] {
    return this.data.students;
  }

  getStudentByEmail(email: string): Student | undefined {
    const e = email.trim().toLowerCase();
    return this.data.students.find((s) => s.email.toLowerCase() === e);
  }

  /**
   * Creates the Student profile + login account.
   * Returns the plain temporary password ONCE so the caller can email / show it.
   */
  addStudent(
    input: { name: string; email: string; department: string },
    tempPassword: string
  ): { student: Student; created: boolean } {
    const email = input.email.trim().toLowerCase();
    const existing = this.getStudentByEmail(email);
    if (existing) return { student: existing, created: false };

    const student: Student = {
      id: newId('std'),
      name: input.name.trim(),
      email,
      department: input.department,
      avatar: '',
      enrolledAt: new Date().toISOString(),
      digestSubscribed: true,
    };
    this.data.students.push(student);

    if (!this.getUserByEmail(email)) {
      this.data.users.push({
        id: `user-${student.id}`,
        email,
        name: student.name,
        role: 'student',
        passwordHash: hashPassword(tempPassword),
        isTemporaryPassword: true,
        createdAt: new Date().toISOString(),
        department: student.department,
      });
    }
    this.persist();
    return { student, created: true };
  }

  deleteStudent(email: string): boolean {
    const e = email.toLowerCase();
    const before = this.data.students.length;
    this.data.students = this.data.students.filter((s) => s.email.toLowerCase() !== e);
    this.data.users = this.data.users.filter((u) => !(u.role === 'student' && u.email.toLowerCase() === e));
    this.persist();
    return this.data.students.length < before;
  }

  updateStudentSubscription(email: string, digestSubscribed: boolean): Student | null {
    const s = this.getStudentByEmail(email);
    if (!s) return null;
    s.digestSubscribed = digestSubscribed;
    this.persist();
    return s;
  }

  // ---------- Knowledge base ----------
  getKnowledgeDocs(): KnowledgeDoc[] {
    return this.data.knowledgeDocs;
  }

  addKnowledgeDoc(doc: Omit<KnowledgeDoc, 'id' | 'createdAt'>): KnowledgeDoc {
    const newDoc: KnowledgeDoc = { ...doc, id: newId('kb'), createdAt: new Date().toISOString() };
    this.data.knowledgeDocs.unshift(newDoc);
    this.persist();
    return newDoc;
  }

  deleteKnowledgeDoc(id: string): boolean {
    const idx = this.data.knowledgeDocs.findIndex((d) => d.id === id);
    if (idx === -1) return false;
    this.data.knowledgeDocs.splice(idx, 1);
    this.persist();
    return true;
  }

  // ---------- Tests ----------
  getTests(): Test[] {
    return this.data.tests;
  }

  getTestById(id: string): Test | undefined {
    return this.data.tests.find((t) => t.id === id);
  }

  createTest(test: Omit<Test, 'id' | 'createdAt'>): Test {
    const newTest: Test = { ...test, id: newId('test'), createdAt: new Date().toISOString() };
    this.data.tests.unshift(newTest);
    this.persist();
    return newTest;
  }

  updateTest(id: string, updates: Partial<Test>): Test | null {
    const test = this.getTestById(id);
    if (!test) return null;
    const { id: _ignore, createdAt: _c, ...safe } = updates;
    Object.assign(test, safe);
    if (Array.isArray(test.questions)) {
      test.totalPoints = test.questions.reduce((acc, q) => acc + (Number(q.points) || 0), 0);
    }
    this.persist();
    return test;
  }

  deleteTest(id: string): boolean {
    const idx = this.data.tests.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    this.data.tests.splice(idx, 1);
    this.persist();
    return true;
  }

  // ---------- Exam attempts (server-owned clock) ----------
  getAttempt(testId: string, studentEmail: string): ExamAttempt | undefined {
    const e = studentEmail.toLowerCase();
    return this.data.attempts.find((a) => a.testId === testId && a.studentEmail.toLowerCase() === e);
  }

  startAttempt(testId: string, studentEmail: string): ExamAttempt {
    const existing = this.getAttempt(testId, studentEmail);
    if (existing) return existing;
    const attempt: ExamAttempt = {
      id: newId('att'),
      testId,
      studentEmail: studentEmail.toLowerCase(),
      startedAt: new Date().toISOString(),
      pausedMs: 0,
      pausedAt: null,
      pausesUsed: 0,
      submittedAt: null,
    };
    this.data.attempts.push(attempt);
    this.persist();
    return attempt;
  }

  saveAttempt(_attempt: ExamAttempt) {
    this.persist();
  }

  /** Admin can reset an attempt (e.g. technical problem) so the student may retake. */
  resetAttempt(testId: string, studentEmail: string): boolean {
    const e = studentEmail.toLowerCase();
    const before = this.data.attempts.length;
    this.data.attempts = this.data.attempts.filter((a) => !(a.testId === testId && a.studentEmail === e));
    this.data.submissions = this.data.submissions.filter(
      (s) => !(s.testId === testId && s.studentEmail.toLowerCase() === e)
    );
    this.persist();
    return this.data.attempts.length < before;
  }

  // ---------- Submissions ----------
  getSubmissions(testId?: string, studentEmail?: string): TestSubmission[] {
    return this.data.submissions.filter((s) => {
      if (testId && s.testId !== testId) return false;
      if (studentEmail && s.studentEmail.toLowerCase() !== studentEmail.toLowerCase()) return false;
      return true;
    });
  }

  getSubmissionById(id: string): TestSubmission | undefined {
    return this.data.submissions.find((s) => s.id === id);
  }

  addSubmission(submission: Omit<TestSubmission, 'id'>): TestSubmission {
    const newSub: TestSubmission = { ...submission, id: newId('sub') };
    this.data.submissions.unshift(newSub);
    this.persist();
    return newSub;
  }

  updateSubmissionGrading(
    id: string,
    grading: TestSubmission['grading'],
    totalScore: number,
    passingScore: number
  ): TestSubmission | null {
    const sub = this.getSubmissionById(id);
    if (!sub) return null;
    sub.grading = grading;
    sub.questionGradings = grading;
    sub.totalScore = totalScore;
    sub.percentage = sub.maxScore > 0 ? Math.round((totalScore / sub.maxScore) * 100) : 0;
    sub.passed = sub.percentage >= passingScore;
    sub.status = 'graded';
    sub.gradedBy = 'lecturer';
    this.persist();
    return sub;
  }

  // ---------- Proctor events ----------
  getProctorEvents(testId?: string, studentEmail?: string): ProctorEvent[] {
    return this.data.proctorEvents.filter((e) => {
      if (testId && e.testId !== testId) return false;
      if (studentEmail && e.studentEmail.toLowerCase() !== studentEmail.toLowerCase()) return false;
      return true;
    });
  }

  addProctorEvent(event: Omit<ProctorEvent, 'id' | 'timestamp'>): ProctorEvent {
    const newEvt: ProctorEvent = { ...event, id: newId('evt'), timestamp: new Date().toISOString() };
    this.data.proctorEvents.unshift(newEvt);
    if (this.data.proctorEvents.length > 20000) this.data.proctorEvents.length = 20000;
    this.persist();
    return newEvt;
  }

  // ---------- Digests ----------
  getDigests(): DailyDigest[] {
    return this.data.digests;
  }

  addDigest(digest: Omit<DailyDigest, 'id'>): DailyDigest {
    const newDigest: DailyDigest = { ...digest, id: newId('digest') };
    this.data.digests.unshift(newDigest);
    this.persist();
    return newDigest;
  }
}

export const db = new Database();
