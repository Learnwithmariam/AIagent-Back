import { DurableObject } from 'cloudflare:workers';
import type { Hono } from 'hono';
import { buildConfig, type Env } from './config';
import { Store } from './store';
import { ProctorHub } from './proctor';
import { Mailer } from './mailer';
import { DigestService } from './digest';
import { createApp } from './app';

/** Cron schedule in wrangler.toml — kept here too so the admin panel can display it. */
export const DIGEST_CRON = '0 4 * * *'; // 04:00 UTC = 08:00 Asia/Tbilisi (UTC+4, no DST)

/**
 * The whole course lives in one Durable Object: storage (SQLite), live proctoring sockets,
 * rate limits and the digest job. A single instance gives strong consistency for the exam
 * clock and one place where admin dashboards receive every proctoring event.
 */
export class CourseHub extends DurableObject<Env> {
  private store!: Store;
  private proctor!: ProctorHub;
  private digest!: DigestService;
  private app!: Hono<any>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const config = buildConfig(env);
    this.store = new Store(ctx.storage.sql, config);
    this.proctor = new ProctorHub(ctx, this.store, config);
    const mailer = new Mailer(config);
    this.digest = new DigestService(this.store, mailer, config);
    this.app = createApp({ store: this.store, proctor: this.proctor, mailer, digest: this.digest, config, cronSchedule: DIGEST_CRON });
    ctx.blockConcurrencyWhile(() => this.store.init());
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request);
  }

  /** Called by the Worker's scheduled() handler (RPC). */
  async runScheduledDigest(): Promise<void> {
    await this.digest.runScheduled();
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    this.proctor.onMessage(ws, message);
  }

  async webSocketClose(ws: WebSocket, code: number) {
    this.proctor.onClose(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closing');
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket) {
    this.proctor.onClose(ws);
  }

  async alarm() {
    this.proctor.onAlarm();
  }
}
