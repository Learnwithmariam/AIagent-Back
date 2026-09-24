import { DEFAULT_FEEDS } from './news';

/**
 * Runtime configuration, built from the Worker's bindings.
 * Plain values live in wrangler.toml [vars]; secrets are set with `wrangler secret put <NAME>`.
 */
export interface Env {
  HUB: DurableObjectNamespace<import('./hub').CourseHub>;

  // secrets
  JWT_SECRET?: string;
  ADMIN_PASSWORD?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  RESEND_API_KEY?: string;

  // vars
  ENVIRONMENT?: string;
  FRONTEND_URL?: string;
  PUBLIC_APP_URL?: string;
  JWT_EXPIRES_IN?: string;
  ADMIN_EMAIL?: string;
  ADMIN_NAME?: string;
  GEMINI_MODELS?: string;
  OPENROUTER_MODELS?: string;
  OPENROUTER_DIGEST_MODEL?: string;
  DIGEST_FEEDS?: string;
  MAIL_FROM?: string;
  DIGEST_ENABLED?: string;
  DIGEST_EMAIL?: string;
  DIGEST_TIMEZONE?: string;
  EXAM_MAX_PAUSES?: string;
  EXAM_SUBMIT_GRACE_SECONDS?: string;
}

export const APP_NAME = 'G.K. BTU Students';

/**
 * Free OpenRouter models tried in order when OPENROUTER_MODELS isn't set.
 * The free catalogue changes often — check https://openrouter.ai/models?max_price=0
 * and override the list in wrangler.toml instead of editing code.
 */
export const DEFAULT_FREE_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'google/gemma-3-27b-it:free',
  'mistralai/mistral-small-3.2-24b-instruct:free',
  'qwen/qwen3-235b-a22b:free',
];

/**
 * Gemini models tried in order before falling back to OpenRouter. gemini-1.5-flash has been
 * retired by Google (404), so the default is its current Flash successor. Override with GEMINI_MODELS.
 */
export const DEFAULT_GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-flash-lite-latest'];

const list = (v: string | undefined) =>
  (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** "12h" / "30m" / "7d" / "3600" → seconds */
function parseDuration(v: string | undefined, fallback: number): number {
  const m = /^(\d+)\s*([smhd]?)$/.exec((v || '').trim());
  if (!m) return fallback;
  const mult = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as '' | 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * mult;
}

export function buildConfig(env: Env) {
  const isProd = env.ENVIRONMENT === 'production';
  if (isProd && !env.JWT_SECRET) {
    throw new Error('Missing required secret JWT_SECRET (wrangler secret put JWT_SECRET)');
  }
  const models = list(env.OPENROUTER_MODELS);
  const chatModels = models.length ? models : DEFAULT_FREE_MODELS;

  return {
    isProd,
    frontendOrigins: list(env.FRONTEND_URL || 'http://localhost:5173'),
    publicAppUrl: env.PUBLIC_APP_URL || 'http://localhost:5173',

    jwtSecret: env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
    jwtExpiresInSeconds: parseDuration(env.JWT_EXPIRES_IN, 12 * 3600),

    /** Bootstrap admin — created on first start only if no admin exists. */
    adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
    adminName: env.ADMIN_NAME || 'Prof. Giorgi Khatiashvili',
    adminPassword: env.ADMIN_PASSWORD || '',

    /** Primary AI provider for the chat (and digest). Falls back to OpenRouter silently. */
    gemini: {
      apiKey: env.GEMINI_API_KEY || '',
      models: list(env.GEMINI_MODELS).length ? list(env.GEMINI_MODELS) : DEFAULT_GEMINI_MODELS,
    },

    openrouter: {
      apiKey: env.OPENROUTER_API_KEY || '',
      /** Fallback models when Gemini fails, tried in this order. */
      chatModels,
      /** The digest only ever uses free (":free") models, so it never costs anything. */
      digestModels: [...new Set([env.OPENROUTER_DIGEST_MODEL, ...chatModels].filter((m): m is string => Boolean(m?.endsWith(':free'))))],
    },

    mail: {
      resendApiKey: env.RESEND_API_KEY || '',
      from: env.MAIL_FROM || `${APP_NAME} <noreply@example.com>`,
    },

    digest: {
      enabled: env.DIGEST_ENABLED !== 'false',
      /** Whether the daily 08:00 run emails subscribers. Generating from the dashboard never emails. */
      emailEnabled: env.DIGEST_EMAIL !== 'false',
      /** Free public RSS/Atom feeds the digest reads news from */
      feeds: list(env.DIGEST_FEEDS).length ? list(env.DIGEST_FEEDS) : DEFAULT_FEEDS,
      timezone: env.DIGEST_TIMEZONE || 'Asia/Tbilisi',
    },

    exam: {
      /** Max pauses per attempt. 0 disables pausing entirely (recommended for high-stakes exams). */
      maxPauses: Number(env.EXAM_MAX_PAUSES ?? 3),
      /** Seconds of network grace after the deadline before a submission is flagged late. */
      submitGraceSeconds: Number(env.EXAM_SUBMIT_GRACE_SECONDS ?? 60),
    },
  };
}

export type Config = ReturnType<typeof buildConfig>;
