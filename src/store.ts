import {
  MAX_TEST_POINTS,
  type Student,
  type KnowledgeDoc,
  type Test,
  type TestSubmission,
  type ProctorEvent,
  type DailyDigest,
  type UserAccount,
  type ExamAttempt,
  type ActiveExamSession,
} from './types';
import type { Config } from './config';
import { hashPassword, randomHex } from './auth';
import { SEED_KNOWLEDGE, SEED_TESTS } from './seed';

/**
 * Durable Object storage (SQLite) for the whole course.
 *
 * Each record is one row: (collection, id, json). Everything is also kept in memory, so reads
 * stay synchronous like the old JSON-file database, and every write goes straight to SQLite
 * (atomic, no file to corrupt). One course (~100–300 students) fits comfortably.
 */

interface Collections {
  users: UserAccount;
  students: Student;
  knowledgeDocs: KnowledgeDoc;
  tests: Test;
  submissions: TestSubmission;
  proctorEvents: ProctorEvent;
  digests: DailyDigest;
  attempts: ExamAttempt;
  sessions: ActiveExamSession;
}
type Name = keyof Collections;

/** Collections shown newest-first (the old code used unshift for these). */
const NEWEST_FIRST: Name[] = ['knowledgeDocs', 'tests', 'submissions', 'proctorEvents', 'digests'];
const ALL: Name[] = ['users', 'students', 'knowledgeDocs', 'tests', 'submissions', 'proctorEvents', 'digests', 'attempts', 'sessions'];
const MAX_PROCTOR_EVENTS = 20000;

export const newId = (prefix: string) => `${prefix}-${Date.now()}-${randomHex(3)}`;

const keyOf = (name: Name, item: any): string => (name === 'sessions' ? item.studentEmail : item.id);

export class Store {
  private data = {} as { [K in Name]: Collections[K][] };
  private seq = 0;

  constructor(
    private sql: SqlStorage,
    private config: Config
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS records (
      coll TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (coll, id))`);
    sql.exec(`CREATE INDEX IF NOT EXISTS records_seq ON records (coll, seq)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.load();
  }

  /** Must be awaited once (inside blockConcurrencyWhile) before serving requests. */
  async init() {
    const seeded = this.sql.exec(`SELECT value FROM meta WHERE key = 'seeded'`).toArray().length > 0;
    if (!seeded) {
      for (const d of [...SEED_KNOWLEDGE].reverse()) this.insert('knowledgeDocs', d);
      for (const t of [...SEED_TESTS].reverse()) this.insert('tests', t);
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded', '1')`);
    }
    this.migrateToTenPointScale();
    await this.ensureAdmin();
  }

  /**
   * One-off: quizzes used to be scored out of up to 100 points; now the maximum is 10.
   * Rescales every test above 10 points (and its submissions' scores) proportionally, so
   * percentages and pass/fail stay the same.
   */
  private migrateToTenPointScale() {
    if (this.sql.exec(`SELECT value FROM meta WHERE key = 'points_max_10'`).toArray().length) return;
    const r1 = (n: number) => Math.round(n * 10) / 10;

    for (const test of this.data.tests) {
      const oldPoints = test.questions.map((q) => Number(q.points) || 0);
      const oldTotal = oldPoints.reduce((a, b) => a + b, 0);
      if (oldTotal <= MAX_TEST_POINTS) continue;

      // Scale to 10 in half-point steps, handing leftover halves to the largest remainders
      const exact = oldPoints.map((p) => (p / oldTotal) * MAX_TEST_POINTS);
      const newPoints = exact.map((x) => Math.max(0.5, Math.floor(x * 2) / 2));
      let left = MAX_TEST_POINTS - newPoints.reduce((a, b) => a + b, 0);
      const byRemainder = exact.map((x, i) => ({ i, r: x - newPoints[i] })).sort((a, b) => b.r - a.r);
      for (let k = 0; left >= 0.5 && byRemainder.length; k = (k + 1) % byRemainder.length) {
        newPoints[byRemainder[k].i] += 0.5;
        left -= 0.5;
      }
      // Many tiny questions can overshoot because of the 0.5 minimum: trim from the largest
      while (left < 0 && newPoints.some((p) => p > 0.5)) {
        const i = newPoints.indexOf(Math.max(...newPoints));
        newPoints[i] -= 0.5;
        left += 0.5;
      }
      const factor = new Map(test.questions.map((q, i) => [q.id, oldPoints[i] > 0 ? newPoints[i] / oldPoints[i] : 0]));
      test.questions.forEach((q, i) => (q.points = newPoints[i]));
      test.totalPoints = r1(newPoints.reduce((a, b) => a + b, 0));
      this.save('tests', test);

      for (const sub of this.data.submissions.filter((x) => x.testId === test.id)) {
        const grading = sub.grading || sub.questionGradings || {};
        for (const g of Object.values(grading)) {
          const f = factor.get(g.questionId) ?? MAX_TEST_POINTS / oldTotal;
          g.earnedPoints = r1(g.earnedPoints * f);
          g.maxPoints = r1(g.maxPoints * f);
        }
        sub.grading = grading;
        sub.questionGradings = grading;
        sub.totalScore = r1(Object.values(grading).reduce((n, g) => n + g.earnedPoints, 0));
        sub.maxScore = test.totalPoints;
        this.save('submissions', sub);
      }
    }

    // Submissions whose test was deleted: scale the totals only
    for (const sub of this.data.submissions) {
      if (sub.maxScore <= MAX_TEST_POINTS || this.getTestById(sub.testId)) continue;
      const f = MAX_TEST_POINTS / sub.maxScore;
      for (const g of Object.values(sub.grading || sub.questionGradings || {})) {
        g.earnedPoints = r1(g.earnedPoints * f);
        g.maxPoints = r1(g.maxPoints * f);
      }
      sub.totalScore = r1(sub.totalScore * f);
      sub.maxScore = MAX_TEST_POINTS;
      this.save('submissions', sub);
    }
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('points_max_10', '1')`);
  }

  private load() {
    for (const name of ALL) {
      const order = NEWEST_FIRST.includes(name) ? 'DESC' : 'ASC';
      const rows = this.sql.exec<{ data: string; seq: number }>(`SELECT data, seq FROM records WHERE coll = ? ORDER BY seq ${order}`, name).toArray();
      (this.data as any)[name] = rows.map((r) => JSON.parse(r.data));
      for (const r of rows) this.seq = Math.max(this.seq, r.seq);
    }
  }

  // ---------- low-level persistence ----------

  /** Add a new record: in memory (front or back, matching display order) and in SQLite. */
  private insert<K extends Name>(name: K, item: Collections[K]) {
    const arr = this.data[name] as Collections[K][];
    if (NEWEST_FIRST.includes(name)) arr.unshift(item);
    else arr.push(item);
    this.sql.exec(`INSERT OR REPLACE INTO records (coll, id, seq, data) VALUES (?, ?, ?, ?)`, name, keyOf(name, item), ++this.seq, JSON.stringify(item));
  }

  /** Persist an in-memory record that was mutated in place. */
  save<K extends Name>(name: K, item: Collections[K]) {
    this.sql.exec(`UPDATE records SET data = ? WHERE coll = ? AND id = ?`, JSON.stringify(item), name, keyOf(name, item));
  }

  private remove<K extends Name>(name: K, predicate: (item: Collections[K]) => boolean): number {
    const arr = this.data[name] as Collections[K][];
    const gone = arr.filter(predicate);
    if (!gone.length) return 0;
    (this.data as any)[name] = arr.filter((x) => !predicate(x));
    for (const item of gone) this.sql.exec(`DELETE FROM records WHERE coll = ? AND id = ?`, name, keyOf(name, item));
    return gone.length;
  }

  /** Creates the lecturer account from ADMIN_EMAIL / ADMIN_PASSWORD on first boot. */
  private async ensureAdmin() {
    if (this.data.users.some((u) => u.role === 'admin')) return;
    if (!this.config.adminEmail || !this.config.adminPassword) {
      console.warn('No admin account exists. Set ADMIN_EMAIL (var) and ADMIN_PASSWORD (secret) to create one.');
      return;
    }
    this.insert('users', {
      id: newId('user-admin'),
      email: this.config.adminEmail,
      name: this.config.adminName,
      role: 'admin',
      passwordHash: await hashPassword(this.config.adminPassword),
      isTemporaryPassword: false,
      createdAt: new Date().toISOString(),
    });
    console.log(`Admin account created for ${this.config.adminEmail}`);
  }

  /**
   * One-off migration: replace everything with a db.json exported from the old Node server.
   * Legacy scrypt password hashes keep working (see auth.ts).
   */
  async importLegacy(dump: Partial<Record<Name, any[]>>) {
    // hash any plaintext prototype passwords before touching storage
    for (const u of Array.isArray(dump.users) ? dump.users : []) {
      if (u?.temporaryPassword && !u.passwordHash) {
        u.passwordHash = await hashPassword(String(u.temporaryPassword));
        u.isTemporaryPassword = true; // force a change after migration
      }
      if (u) delete u.temporaryPassword;
    }
    this.sql.exec(`DELETE FROM records`);
    this.seq = 0;
    for (const name of ALL) {
      (this.data as any)[name] = [];
      const items = Array.isArray(dump[name]) ? dump[name]! : [];
      // dumps are in display order; insert oldest first so seq matches
      const ordered = NEWEST_FIRST.includes(name) ? [...items].reverse() : items;
      for (const item of ordered) {
        if (keyOf(name, item)) this.insert(name, item);
      }
    }
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded', '1')`);
    // imported data may still be on the old 100-point scale
    this.sql.exec(`DELETE FROM meta WHERE key = 'points_max_10'`);
    this.migrateToTenPointScale();
    return Object.fromEntries(ALL.map((n) => [n, this.data[n].length]));
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
    this.save('users', user);
  }

  async setPassword(email: string, newPassword: string, temporary: boolean): Promise<UserAccount | null> {
    const user = this.getUserByEmail(email);
    if (!user) return null;
    user.passwordHash = await hashPassword(newPassword);
    user.isTemporaryPassword = temporary;
    this.save('users', user);
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

  /** Creates the Student profile + login account with the given temporary password. */
  async addStudent(
    input: { name: string; email: string; department: string },
    tempPassword: string
  ): Promise<{ student: Student; created: boolean }> {
    const email = input.email.trim().toLowerCase();
    const existing = this.getStudentByEmail(email);
    if (existing) return { student: existing, created: false };

    const passwordHash = await hashPassword(tempPassword);
    // re-check after the await: another request may have created it meanwhile
    const raced = this.getStudentByEmail(email);
    if (raced) return { student: raced, created: false };

    const student: Student = {
      id: newId('std'),
      name: input.name.trim(),
      email,
      department: input.department,
      avatar: '',
      enrolledAt: new Date().toISOString(),
      digestSubscribed: true,
    };
    this.insert('students', student);

    if (!this.getUserByEmail(email)) {
      this.insert('users', {
        id: `user-${student.id}`,
        email,
        name: student.name,
        role: 'student',
        passwordHash,
        isTemporaryPassword: true,
        createdAt: new Date().toISOString(),
        department: student.department,
      });
    }
    return { student, created: true };
  }

  /** Edit a student's profile (and matching login). An email change also moves their records. */
  updateStudent(
    email: string,
    updates: { name?: string; email?: string; department?: string; digestSubscribed?: boolean }
  ): Student | 'not_found' | 'email_taken' {
    const student = this.getStudentByEmail(email);
    if (!student) return 'not_found';
    const oldEmail = student.email.toLowerCase();
    const newEmail = updates.email?.trim().toLowerCase() || oldEmail;
    if (newEmail !== oldEmail && (this.getStudentByEmail(newEmail) || this.getUserByEmail(newEmail))) return 'email_taken';

    if (updates.name !== undefined) student.name = updates.name;
    if (updates.department !== undefined) student.department = updates.department;
    if (updates.digestSubscribed !== undefined) student.digestSubscribed = updates.digestSubscribed;
    student.email = newEmail;
    this.save('students', student);

    const user = this.data.users.find((u) => u.role === 'student' && u.email.toLowerCase() === oldEmail);
    if (user) {
      user.email = newEmail;
      user.name = student.name;
      user.department = student.department;
      this.save('users', user);
    }

    if (newEmail !== oldEmail) {
      for (const s of this.data.submissions.filter((x) => x.studentEmail.toLowerCase() === oldEmail)) {
        s.studentEmail = newEmail;
        s.studentName = student.name;
        this.save('submissions', s);
      }
      for (const a of this.data.attempts.filter((x) => x.studentEmail.toLowerCase() === oldEmail)) {
        a.studentEmail = newEmail;
        this.save('attempts', a);
      }
      for (const e of this.data.proctorEvents.filter((x) => x.studentEmail.toLowerCase() === oldEmail)) {
        e.studentEmail = newEmail;
        this.save('proctorEvents', e);
      }
      // live sessions are keyed by email; the student simply rejoins under the new one
      this.remove('sessions', (x) => x.studentEmail === oldEmail);
    } else if (updates.name !== undefined) {
      for (const s of this.data.submissions.filter((x) => x.studentEmail.toLowerCase() === oldEmail)) {
        s.studentName = student.name;
        this.save('submissions', s);
      }
    }
    return student;
  }

  deleteStudent(email: string): boolean {
    const e = email.toLowerCase();
    const removed = this.remove('students', (s) => s.email.toLowerCase() === e);
    this.remove('users', (u) => u.role === 'student' && u.email.toLowerCase() === e);
    return removed > 0;
  }

  updateStudentSubscription(email: string, digestSubscribed: boolean): Student | null {
    const s = this.getStudentByEmail(email);
    if (!s) return null;
    s.digestSubscribed = digestSubscribed;
    this.save('students', s);
    return s;
  }

  // ---------- Knowledge base ----------
  getKnowledgeDocs(): KnowledgeDoc[] {
    return this.data.knowledgeDocs;
  }

  addKnowledgeDoc(doc: Omit<KnowledgeDoc, 'id' | 'createdAt'>): KnowledgeDoc {
    const newDoc: KnowledgeDoc = { ...doc, id: newId('kb'), createdAt: new Date().toISOString() };
    this.insert('knowledgeDocs', newDoc);
    return newDoc;
  }

  deleteKnowledgeDoc(id: string): boolean {
    return this.remove('knowledgeDocs', (d) => d.id === id) > 0;
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
    this.insert('tests', newTest);
    return newTest;
  }

  updateTest(id: string, updates: Partial<Test>): Test | null {
    const test = this.getTestById(id);
    if (!test) return null;
    const { id: _ignore, createdAt: _c, ...safe } = updates;
    Object.assign(test, safe);
    if (Array.isArray(test.questions)) {
      test.totalPoints = Math.round(test.questions.reduce((acc, q) => acc + (Number(q.points) || 0), 0) * 10) / 10;
    }
    this.save('tests', test);
    return test;
  }

  deleteTest(id: string): boolean {
    return this.remove('tests', (t) => t.id === id) > 0;
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
    this.insert('attempts', attempt);
    return attempt;
  }

  saveAttempt(attempt: ExamAttempt) {
    this.save('attempts', attempt);
  }

  /** Admin can reset an attempt (e.g. technical problem) so the student may retake. */
  resetAttempt(testId: string, studentEmail: string): boolean {
    const e = studentEmail.toLowerCase();
    const removed = this.remove('attempts', (a) => a.testId === testId && a.studentEmail === e);
    this.remove('submissions', (s) => s.testId === testId && s.studentEmail.toLowerCase() === e);
    return removed > 0;
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
    this.insert('submissions', newSub);
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
    this.save('submissions', sub);
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
    this.insert('proctorEvents', newEvt);
    if (this.data.proctorEvents.length > MAX_PROCTOR_EVENTS + 500) {
      this.data.proctorEvents.length = MAX_PROCTOR_EVENTS;
      this.sql.exec(
        `DELETE FROM records WHERE coll = 'proctorEvents' AND seq NOT IN
          (SELECT seq FROM records WHERE coll = 'proctorEvents' ORDER BY seq DESC LIMIT ?)`,
        MAX_PROCTOR_EVENTS
      );
    }
    return newEvt;
  }

  // ---------- Live exam sessions (survive Durable Object restarts) ----------
  getSessions(): ActiveExamSession[] {
    return this.data.sessions;
  }

  getSession(email: string): ActiveExamSession | undefined {
    const e = email.toLowerCase();
    return this.data.sessions.find((s) => s.studentEmail === e);
  }

  putSession(session: ActiveExamSession) {
    if (this.getSession(session.studentEmail)) this.save('sessions', session);
    else this.insert('sessions', session);
  }

  /** Drop sessions nobody has touched for a day, so the live monitor doesn't grow forever. */
  pruneSessions(maxAgeMs = 24 * 3600_000) {
    const cutoff = Date.now() - maxAgeMs;
    this.remove('sessions', (s) => new Date(s.lastHeartbeat).getTime() < cutoff);
  }

  // ---------- Digests ----------
  getDigests(): DailyDigest[] {
    return this.data.digests;
  }

  addDigest(digest: Omit<DailyDigest, 'id'>): DailyDigest {
    const newDigest: DailyDigest = { ...digest, id: newId('digest') };
    this.insert('digests', newDigest);
    return newDigest;
  }
}
