import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'http';
import { db } from './db';
import { config } from './config';
import { verifyToken, TokenPayload } from './auth';
import type { ActiveExamSession, ProctorEvent, ProctorEventType } from './types';

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

class ProctorWebSocketServer {
  private wss: WebSocketServer | null = null;
  private activeSessions = new Map<string, ActiveExamSession>();
  private studentSockets = new Map<string, WebSocket>();
  private adminSockets = new Set<WebSocket>();

  init(server: HttpServer) {
    this.wss = new WebSocketServer({ server, path: '/ws/proctor' });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      // Auth: token is passed as ?token=... (browsers can't set headers on WebSocket)
      const url = new URL(req.url || '', 'http://localhost');
      const origin = req.headers.origin;
      if (config.isProd && origin && !config.frontendOrigins.includes(origin)) {
        ws.close(4003, 'Origin not allowed');
        return;
      }
      const user = verifyToken(url.searchParams.get('token') || '');
      if (!user) {
        ws.close(4001, 'Unauthorized');
        return;
      }

      ws.on('message', (raw) => {
        try {
          this.handleMessage(ws, user, JSON.parse(raw.toString()));
        } catch (err) {
          console.error('WS message error:', err);
        }
      });

      ws.on('close', () => {
        if (user.role === 'admin') {
          this.adminSockets.delete(ws);
          return;
        }
        const email = user.email.toLowerCase();
        if (this.studentSockets.get(email) === ws) this.studentSockets.delete(email);
        const session = this.activeSessions.get(email);
        if (session && session.currentStatus !== 'submitted' && session.currentStatus !== 'paused') {
          session.currentStatus = 'away_window';
          this.recordEvent(session, 'window_blur', 'WebSocket disconnected (tab closed, network lost or device locked)', 'medium');
          this.broadcastToAdmins({ type: 'admin:session_updated', payload: session });
        }
      });
    });

    // Mark sessions without a heartbeat for 30s as away
    setInterval(() => {
      const now = Date.now();
      for (const session of this.activeSessions.values()) {
        const stale = now - new Date(session.lastHeartbeat).getTime() > 30000;
        if (stale && !['submitted', 'paused', 'away_window'].includes(session.currentStatus)) {
          session.currentStatus = 'away_window';
          this.broadcastToAdmins({ type: 'admin:session_updated', payload: session });
        }
      }
    }, 10000);
  }

  private recordEvent(
    session: ActiveExamSession,
    eventType: ProctorEventType,
    details: string,
    severity: ProctorEvent['severity'],
    durationSeconds?: number
  ) {
    const evt = db.addProctorEvent({
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

  private handleMessage(ws: WebSocket, user: TokenPayload, message: any) {
    const { type, payload = {} } = message || {};
    const email = user.email.toLowerCase();

    switch (type) {
      case 'admin:subscribe': {
        if (user.role !== 'admin') return;
        this.adminSockets.add(ws);
        ws.send(
          JSON.stringify({
            type: 'admin:init_state',
            payload: {
              activeSessions: [...this.activeSessions.values()],
              recentEvents: db.getProctorEvents().slice(0, 100),
            },
          })
        );
        return;
      }

      case 'admin:send_warning': {
        if (user.role !== 'admin') return;
        const target = String(payload.studentEmail || '').toLowerCase();
        const text = String(payload.message || '').slice(0, 500);
        const sock = this.studentSockets.get(target);
        if (sock?.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ type: 'proctor:warning_received', payload: { message: text, timestamp: new Date().toISOString() } }));
        }
        const session = this.activeSessions.get(target);
        if (session) this.recordEvent(session, 'proctor_warning', `Proctor message: "${text}"`, 'high');
        return;
      }

      case 'student:join': {
        if (user.role !== 'student') return;
        const testId = String(payload.testId || '');
        const test = db.getTestById(testId);
        const attempt = test ? db.getAttempt(testId, email) : undefined;
        if (!test || !attempt || attempt.submittedAt) return; // must start via POST /api/exam/start

        this.studentSockets.set(email, ws);
        let session = this.activeSessions.get(email);
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
            pauseCreditsRemaining: Math.max(0, config.exam.maxPauses - attempt.pausesUsed),
            totalPausesUsed: attempt.pausesUsed,
            pausedAt: attempt.pausedAt,
            pauseReason: null,
          };
          this.activeSessions.set(email, session);
        } else {
          // Re-join (page reload) — that is itself suspicious, log it
          session.lastHeartbeat = new Date().toISOString();
          if (session.currentStatus !== 'paused') session.currentStatus = 'in_tab';
          this.recordEvent(session, 'tab_visible', 'Student reconnected / reloaded the exam page', 'low');
        }
        this.broadcastToAdmins({ type: 'admin:student_joined', payload: session });
        ws.send(JSON.stringify({ type: 'student:join_ack', payload: { status: 'connected', session } }));
        return;
      }

      case 'student:heartbeat': {
        const session = this.activeSessions.get(email);
        if (session && user.role === 'student') session.lastHeartbeat = new Date().toISOString();
        return;
      }

      case 'student:event': {
        if (user.role !== 'student') return;
        const session = this.activeSessions.get(email);
        if (!session) return;
        const eventType = payload.eventType as ProctorEventType;
        if (!STUDENT_EVENT_TYPES.includes(eventType)) return;

        session.lastHeartbeat = new Date().toISOString();
        const details = String(payload.details || '').slice(0, 500);

        // During an approved pause we still LOG leaving the tab (low severity) but don't count it.
        if (session.currentStatus === 'paused') {
          if (eventType === 'tab_hidden' || eventType === 'window_blur') {
            this.recordEvent(session, eventType, `${details} (during approved pause)`, 'low');
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
        return;
      }

      case 'student:submit': {
        const session = this.activeSessions.get(email);
        if (session) {
          session.currentStatus = 'submitted';
          this.broadcastToAdmins({ type: 'admin:session_updated', payload: session });
        }
        return;
      }
    }
  }

  broadcastToAdmins(message: unknown) {
    const raw = JSON.stringify(message);
    for (const ws of this.adminSockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
    }
  }

  // ---------- Pause / resume (called from REST only, so a pause is counted once) ----------

  pauseSession(studentEmail: string, testId: string, reason?: string) {
    const email = studentEmail.toLowerCase();
    const attempt = db.getAttempt(testId, email);
    if (!attempt || attempt.submittedAt) return { success: false, error: 'Exam attempt not found' };
    if (attempt.pausedAt) return { success: false, error: 'Exam is already paused' };
    if (attempt.pausesUsed >= config.exam.maxPauses) {
      return { success: false, error: `No pause credits remaining (max ${config.exam.maxPauses}).`, pauseCreditsRemaining: 0 };
    }

    attempt.pausesUsed += 1;
    attempt.pausedAt = new Date().toISOString();
    db.saveAttempt(attempt);
    const remaining = config.exam.maxPauses - attempt.pausesUsed;

    const session = this.activeSessions.get(email);
    if (session) {
      session.currentStatus = 'paused';
      session.pausedAt = attempt.pausedAt;
      session.pauseReason = String(reason || 'Candidate requested pause').slice(0, 200);
      session.totalPausesUsed = attempt.pausesUsed;
      session.pauseCreditsRemaining = remaining;
      const evt = this.recordEvent(
        session,
        'exam_paused',
        `Paused (${remaining}/${config.exam.maxPauses} left). Reason: ${session.pauseReason}`,
        'medium'
      );
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
    const attempt = db.getAttempt(testId, email);
    if (!attempt || !attempt.pausedAt) return { success: false, error: 'Exam is not paused' };

    const pausedMs = Math.max(0, Date.now() - new Date(attempt.pausedAt).getTime());
    attempt.pausedMs += pausedMs;
    attempt.pausedAt = null;
    db.saveAttempt(attempt);
    const remaining = Math.max(0, config.exam.maxPauses - attempt.pausesUsed);

    const session = this.activeSessions.get(email);
    if (session) {
      session.currentStatus = 'in_tab';
      session.pausedAt = null;
      session.pauseReason = null;
      session.lastHeartbeat = new Date().toISOString();
      const evt = this.recordEvent(session, 'exam_resumed', `Resumed after ${Math.round(pausedMs / 1000)}s`, 'low', Math.round(pausedMs / 1000));
      this.broadcastToAdmins({
        type: 'admin:student_resumed',
        payload: { session, event: evt, pauseCreditsRemaining: remaining, pauseDurationSeconds: Math.round(pausedMs / 1000) },
      });
      this.broadcastToAdmins({ type: 'admin:session_updated', payload: session });
    }
    return { success: true, session, pauseCreditsRemaining: remaining, pausedMs: attempt.pausedMs };
  }

  getSession(studentEmail: string) {
    return this.activeSessions.get(studentEmail.toLowerCase());
  }

  getActiveSessions() {
    return [...this.activeSessions.values()];
  }
}

export const proctorWss = new ProctorWebSocketServer();
