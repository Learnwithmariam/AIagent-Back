import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: Number(process.env.PORT) || 4000,

  /** Comma-separated list of allowed frontend origins, e.g. https://cognitest.vercel.app */
  frontendOrigins: (process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Secret used to sign login tokens. Long random string in production. */
  jwtSecret: isProd ? required('JWT_SECRET') : process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',

  /** Bootstrap admin — created on first start only if no admin exists. */
  adminEmail: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminName: process.env.ADMIN_NAME || 'Prof. Giorgi Khatiashvili',
  adminPassword: process.env.ADMIN_PASSWORD || '',

  dataDir: process.env.DATA_DIR || './data',

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    /** Chat + grading model. Check https://ai.google.dev/gemini-api/docs/models for current IDs. */
    model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
    /** Digest model (needs Google Search grounding support). */
    digestModel: process.env.GEMINI_DIGEST_MODEL || process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'CogniTest <noreply@btu.edu.ge>',
  },

  digest: {
    /** cron expression, evaluated in DIGEST_TIMEZONE */
    cron: process.env.DIGEST_CRON || '0 8 * * *',
    timezone: process.env.DIGEST_TIMEZONE || 'Asia/Tbilisi',
    enabled: process.env.DIGEST_ENABLED !== 'false',
  },

  exam: {
    /** Max pauses per attempt. 0 disables pausing entirely (recommended for high-stakes exams). */
    maxPauses: Number(process.env.EXAM_MAX_PAUSES ?? 3),
    /** Seconds of network grace after the deadline before a submission is rejected. */
    submitGraceSeconds: Number(process.env.EXAM_SUBMIT_GRACE_SECONDS ?? 60),
  },

  publicAppUrl: process.env.PUBLIC_APP_URL || 'http://localhost:5173',
};

if (!config.gemini.apiKey) {
  console.warn('⚠️  GEMINI_API_KEY is not set — AI chat, AI grading and the digest will not work.');
}
