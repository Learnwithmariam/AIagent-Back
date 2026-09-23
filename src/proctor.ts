import type { Store } from './store';
import type { Config } from './config';
import type { TokenPayload } from './auth';
import type { ActiveExamSession, ProctorEvent, ProctorEventType } from './types';

/**
 * Live exam proctoring over WebSockets, using the Durable Object hibernation API:
 * the DO can sleep between messages without dropping sockets. Each socket carries its
 * user in an attachment; sessions are persisted in the Store so they survive restarts.
 */

const STUDENT_EVENT_TYPES: ProctorEventType[] = [
  'tab_hidden',
  'tab_visible',
  'window_blur',
  'window_focus',
  'copy_attempt',
  'paste_attempt',
  'context_menu',
  'fullscreen_exit',
  'timer_expired',
];

const STALE_AFTER_MS = 30_000;
const CHECK_EVERY_MS = 10_000;
const HEARTBEAT_PERSIST_MS = 20_000;

export interface SocketAttachment {
  user: TokenPayload;
  subscribed?: boolean;
}

export const studentTag = (email: string) => `student:${email.toLowerCase()}`;

export class ProctorHub {
  private lastPersisted = new Map<string, number>();

  constructor(
    private ctx: DurableObjectState,
    private store: Store,
    private config: Config
  ) {}

  // ---------- connection lifecycle ----------

  accept(user: TokenPayload): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const tags = user.role === 'admin' ? ['admin'] : [studentTag(user.email)];
    this.ctx.acceptWebSocket(server, tags);
    server.serializeAttachment({ user } satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att?.user) return ws.close(4001, 'Unauthorized');
    try {
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      this.handleMessage(ws, att, JSON.parse(text));
    } catch (err) {
      console.error('WS message error:', err);
    }
  }

  onClose(ws: WebSocket) {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att?.user || att.user.role === 'admin') return;
    const email = att.user.email.toLowerCase();
    // another tab of the same student may still be connected
    const stillOpen = this.ctx.getWebSockets(studentTag(email)).some((s) => s !== ws && s.readyState === WebSocket.READY_STATE_OPEN);
    if (stillOpen) return;
    const session = this.store.getSession(email);
    if (session && session.currentStatus !== 'submitted' && session.currentStatus !== 'paused') {
      session.currentStatus = 'away_window';
      this.recordEvent(session, 'window_blur', 'WebSocket disconnected (tab closed, network lost or device locked)', 'medium');
      this.store.putSession(session);
      this.broadcastToAdmins({ type: 'admin:session_updated', payload: session });
    }
  }

  /** DO alarm: mark sessions without a heartbeat for 30s as away. Re-arms while anyone is live. */
  onAlarm() {
    const now = Date.now();
    let live = false;
    for (const session of this.store.getSessions()) {
      if (['submitted', 'paused', 'away_window'].includes(session.currentStatus)) continue;
      if (now - new Date(session.lastHeartbeat).getTime() > STALE_AFTER_MS) {
        session.currentStatus = 'away_window';
        this.store.putSession(session);
        this.broadcastToAdmins({ type: 'admin:session_updated', payload: session });
      } else {
        live = true;
      }
    }
    this.store.pruneSessions();
    if (live) this.ctx.storage.setAlarm(now + CHECK_EVERY_MS);
  }

  private async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + CHECK_EVERY_MS);
  }

  // ---------- helpers ----------

  private send(ws: WebSocket, message: unknown) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      /* socket already closing */
    }
  }

  broadcastToAdmins(message: unknown) {
    const raw = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets('admin')) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (!att?.subscribed) continue;
      try {
        ws.send(raw);
      } catch {
        /* ignore */
      }
    }
  }

  private recordEvent(
    session: ActiveExamSession,
    eventType: ProctorEventType,
    details: string,
    severity: ProctorEvent['severity'],
    durationSeconds?: number
  ) {
    const evt = this.store.addProctorEvent({
      studentEmail: session.studentEmail,
      studentName: session.studentName,
      testId: session.testId,
      testTitle: session.testTitle,
      eventType,
      details,
      durationSeconds,
      severity,
    });
    session.lastEvent = evt;
    this.broadcastToAdmins({ type: 'admin:proctor_alert', payload: { event: evt, session } });
    return evt;
  }

  // ---------- messages ----------

  private handleMessage(ws: WebSocket, att: SocketAttachment, message: any) {
    const { user } = att;
    const { type, payload = {} } = message || {};
    const email = user.email.toLowerCase();

    switch (type) {
      case 'admin:subscribe': {
        if (user.role !== 'admin') return;
        ws.serializeAttachment({ ...att, subscribed: true } satisfies SocketAttachment);
        this.send(ws, {
          type: 'admin:init_state',
          payload: {
            activeSessions: this.store.getSessions(),
            recentEvents: this.store.getProctorEvents().slice(0, 100),
          },
        });
        return;
      }

      case 'admin:send_warning': {
        if (user.role !== 'admin') return;
        const target = String(payload.studentEmail || '').toLowerCase();
        const text = String(payload.message || '').slice(0, 500);
        for (const sock of this.ctx.getWebSockets(studentTag(target))) {
          this.send(sock, { type: 'proctor:warning_received', payload: { message: text, timestamp: new Date().toISOString() } });
        }
        const session = this.store.getSession(target);
        if (session) {
          this.recordEvent(session, 'proctor_warning', `Proctor message: "${text}"`, 'high');
          this.store.putSession(session);
        }
        return;
      }

      case 'student:join': {
        if (user.role !== 'student') return;
        const testId = String(payload.testId || '');
        const test = this.store.getTestById(testId);
        const attempt = test ? this.store.getAttempt(testId, email) : undefined;
        if (!test || !attempt || attempt.submittedAt) return; // must start via POST /api/exam/start

        let session = this.store.getSession(email);
        if (!session || session.testId !== testId) {
          session = {
            studentEmail: email,
            studentName: user.name,
            testId,
            testTitle: test.title,
            joinedAt: new Date().toISOString(),
            lastHeartbeat: new Date().toISOString(),
            currentStatus: attempt.pausedAt ? 'paused' : 'in_tab',
            infractionsCount: 0,
            totalAwaySeconds: 0,
            awayStartTime: null,
            pauseCreditsRemaining: Math.max(0, this.config.exam.maxPauses - attempt.pausesUsed),
            totalPausesUsed: attempt.pausesUsed,
            pausedAt: attempt.pausedAt,
            pauseReason: null,
          };
        } else {
          // Re-join (page reload) — that is itself suspicious, log it
          session.lastHeartbeat = new Date().toISOString();
          if (session.currentStatus !== 'paused') session.currentStatus = 'in_tab';
          this.recordEvent(session, 'tab_visible', 'Student reconnected / reloaded the exam page', 'low');
        }
        this.store.putSession(session);
        this.broadcastToAdmins({ type: 'admin:student_joined', payload: session });
        this.send(ws, { type: 'student:join_ack', payload: { status: 'connected', session } });
        void this.ensureAlarm();
        return;
      }

      case 'student:heartbeat': {
        const session = this.store.getSession(email);
        if (!session || user.role !== 'student') return;
        session.lastHeartbeat = new Date().toISOString();
        // Throttle storage writes: heartbeats arrive every few seconds from every student,
        // but persisting one every ~20s is enough to survive a Durable Object restart.
        if ((this.lastPersisted.get(email) ?? 0) < Date.now() - HEARTBEAT_PERSIST_MS) {
          this.lastPersisted.set(email, Date.now());
          this.store.putSession(session);
        }
        return;
      }

      case 'student:event': {
        if (user.role !== 'student') return;
        const session = this.store.getSession(email);
        if (!session) return;
        const eventType = payload.eventType as ProctorEventType;
        if (!STUDENT_EVENT_TYPES.includes(eventType)) return;

        session.lastHeartbeat = new Date().toISOString();
        const details = String(payload.details || '').slice(0, 500);

        // During an approved pause we still LOG leaving the tab (low severity) but don't count it.
        if (session.currentStatus === 'paused') {
          if (eventType === 'tab_hidden' || eventType === 'window_blur') {
            this.recordEvent(session, eventType, `${details} (during approved pause)`, 'low');
            this.store.putSession(session);
          }
          return;
        }

        let severity: ProctorEvent['severity'] = 'medium';
        if (eventType === 'tab_hidden' || eventType === 'window_blur') {
          session.currentStatus = eventType === 'tab_hidden' ? 'away_tab' : 'away_window';
          if (!session.awayStartTime) session.awayStartTime = Date.now();
          session.infractionsCount += 1;
          severity = 'high';
        } else if (eventType === 'tab_visible' || eventType === 'window_focus') {
          session.currentStatus = 'in_tab';
          if (session.awayStartTime) {
            session.totalAwaySeconds += Math.round((Date.now() - session.awayStartTime) / 1000);
            session.awayStartTime = null;
          }
          severity = 'low';
        } else if (['copy_attempt', 'paste_attempt', 'fullscreen_exit', 'context_menu'].includes(eventType)) {
          session.infractionsCount += 1;
        } else {
          severity = 'low';
        }
        if (session.infractionsCount >= 3 && session.currentStatus === 'in_tab') {
          session.currentStatus = 'warning_state';
        }

        const duration = Number(payload.durationSeconds);
        this.recordEvent(session, eventType, details, severity, Number.isFinite(duration) ? duration : undefined);
        this.store.putSession(session);
        void this.ensureAlarm();
        return;
      }

      case 'student:submit': {
        const session = this.store.getSession(email);
        if (session) {
          session.currentStatus = 'submitted';
          this.store.putSession(session);
          this.broadcastToAdmins({ type: 'admin:session_updated', payload: session });
        }
        return;
      }
    }
  }

  // ---------- Pause / resume (called from REST only, so a pause is counted once) ----------

  pauseSession(studentEmail: string, testId: string, reason?: string) {
    const { maxPauses } = this.config.exam;
    const email = studentEmail.toLowerCase();
    const attempt = this.store.getAttempt(testId, email);
    if (!attempt || attempt.submittedAt) return { success: false, error: 'Exam attempt not found' };
    if (attempt.pausedAt) return { success: false, error: 'Exam is already paused' };
    if (attempt.pausesUsed >= maxPauses) {
      return { success: false, error: `No pause credits remaining (max ${maxPauses}).`, pauseCreditsRemaining: 0 };
    }

    attempt.pausesUsed += 1;
    attempt.pausedAt = new Date().toISOString();
    this.store.saveAttempt(attempt);
    const remaining = maxPauses - attempt.pausesUsed;

    const session = this.store.getSession(email);
    if (session) {
      session.currentStatus = 'paused';
      session.pausedAt = attempt.pausedAt;
      session.pauseReason = String(reason || 'Candidate requested pause').slice(0, 200);
      session.totalPausesUsed = attempt.pausesUsed;
      session.pauseCreditsRemaining = remaining;
      const evt = this.recordEvent(session, 'exam_paused', `Paused (${remaining}/${maxPauses} left). Reason: ${session.pauseReason}`, 'medium');
      this.store.putSession(session);
      this.broadcastToAdmins({
        type: 'admin:student_paused',
        payload: {
          session,
          event: evt,
          studentEmail: email,
          studentName: session.studentName,
          testTitle: session.testTitle,
          pauseCreditsRemaining: remaining,
          pauseReason: session.pauseReason,
          pausedAt: session.pausedAt,
        },
      });
      this.broadcastToAdmins({ type: 'admin:session_updated', payload: session });
    }
    return { success: true, session, pauseCreditsRemaining: remaining };
  }

  resumeSession(studentEmail: string, testId: string) {
    const email = studentEmail.toLowerCase();
    const attempt = this.store.getAttempt(testId, email);
    if (!attempt || !attempt.pausedAt) return { success: false, error: 'Exam is not paused' };

    const pausedMs = Math.max(0, Date.now() - new Date(attempt.pausedAt).getTime());
    attempt.pausedMs += pausedMs;
    attempt.pausedAt = null;
    this.store.saveAttempt(attempt);
    const remaining = Math.max(0, this.config.exam.maxPauses - attempt.pausesUsed);

    const session = this.store.getSession(email);
    if (session) {
      session.currentStatus = 'in_tab';
      session.pausedAt = null;
      session.pauseReason = null;
      session.lastHeartbeat = new Date().toISOString();
      const secs = Math.round(pausedMs / 1000);
      const evt = this.recordEvent(session, 'exam_resumed', `Resumed after ${secs}s`, 'low', secs);
      this.store.putSession(session);
      this.broadcastToAdmins({
        type: 'admin:student_resumed',
        payload: { session, event: evt, pauseCreditsRemaining: remaining, pauseDurationSeconds: secs },
      });
      this.broadcastToAdmins({ type: 'admin:session_updated', payload: session });
      void this.ensureAlarm();
    }
    return { success: true, session, pauseCreditsRemaining: remaining, pausedMs: attempt.pausedMs };
  }
}
