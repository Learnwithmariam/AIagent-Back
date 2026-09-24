import type { Env } from './config';
export { CourseHub } from './hub';

/**
 * Worker entry. Every API and WebSocket request goes to the single CourseHub Durable Object,
 * which owns the data and the live proctoring sockets.
 */
const hub = (env: Env) => env.HUB.get(env.HUB.idFromName('course'));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/') {
      return Response.json({ name: 'G.K. BTU Students API', health: '/api/health' });
    }
    if (pathname === '/ws/proctor') return hub(env).fetch(request);
    if (pathname.startsWith('/api/')) {
      // Buffer the body (max ~25 MB uploads) so a Durable Object that answers early — e.g. 401 —
      // doesn't leave a half-streamed request behind.
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
      return hub(env).fetch(hasBody ? new Request(request, { body: await request.arrayBuffer() }) : request);
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  },

  /** Cron Trigger (see wrangler.toml) — the daily digest. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(hub(env).runScheduledDigest());
  },
} satisfies ExportedHandler<Env>;
