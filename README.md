# G.K. BTU Students — API (Cloudflare Workers)

Backend for the BTU course **Innovative Entrepreneurship & Startups**:

- **AI teaching assistant** — RAG over the syllabus, answered by **free OpenRouter models**. Students can pick a model; if one is rate-limited the next one in the list answers.
- **Proctored exams** — the server owns the timer and attempts; tab switches, copy/paste, etc. reach the lecturer live over WebSockets.
- **Morning digest** — every day at 08:00 Tbilisi time, grounded in real news (OpenRouter web search), emailed via Resend.

## Architecture

```
Browser ──HTTPS/WSS──▶ Worker (src/index.ts)
                          │
                          ▼
              CourseHub Durable Object (src/hub.ts)
              ├─ Hono REST API ............ src/app.ts
              ├─ SQLite storage ........... src/store.ts
              ├─ Hibernatable WebSockets .. src/proctor.ts
              └─ Digest (Cron Trigger) .... src/digest.ts
                          │
                          ├──▶ OpenRouter (chat, grading, digest)  src/ai.ts
                          └──▶ Resend (email)                      src/mailer.ts
```

One Durable Object holds the whole course. That gives one consistent exam clock, and every proctoring event reaches every lecturer dashboard. It's plenty for one course (hundreds of students).

## Setup

```bash
npm install
npx wrangler login
```

Set the secrets once. They are stored encrypted in Cloudflare, never in git:

```bash
npx wrangler secret put JWT_SECRET          # node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npx wrangler secret put ADMIN_PASSWORD      # lecturer's first password
npx wrangler secret put OPENROUTER_API_KEY  # https://openrouter.ai/keys
npx wrangler secret put RESEND_API_KEY      # optional, https://resend.com/api-keys
```

Then edit `[vars]` in `wrangler.toml`: `ADMIN_EMAIL`, `FRONTEND_URL` (your Pages URL), `PUBLIC_APP_URL` and `MAIL_FROM`. Deploy:

```bash
npm run deploy
```

The admin account is created on first start from `ADMIN_EMAIL` + `ADMIN_PASSWORD`. After that, change the password in the app.

### Local development

```bash
cp .dev.vars.example .dev.vars   # fill in
npm run dev                      # http://localhost:8787
```

### CI deploy

`.github/workflows/deploy.yml` deploys on every push to `main` once the repository has the secrets `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers") and `CLOUDFLARE_ACCOUNT_ID`.

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `JWT_SECRET` | secret | Required in production |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | var / secret | Lecturer account (first start only) |
| `OPENROUTER_API_KEY` | secret | AI chat, grading and digest |
| `OPENROUTER_MODELS` | var | Comma-separated free models; the first is the default. See https://openrouter.ai/models?max_price=0 |
| `OPENROUTER_GRADING_MODEL`, `OPENROUTER_DIGEST_MODEL` | var | Optional overrides (default: first model) |
| `OPENROUTER_DIGEST_WEB_SEARCH` | var | The digest uses OpenRouter's web plugin, which is billed per search (about $0.02 per run). With `false` the digest refuses to run instead of inventing news |
| `RESEND_API_KEY`, `MAIL_FROM` | secret / var | Email. Without it, temporary passwords are shown once to the lecturer |
| `FRONTEND_URL` | var | Allowed CORS origins, comma-separated |
| `EXAM_MAX_PAUSES` | var | Pause credits per attempt; `0` disables pausing |

Free OpenRouter models have rate limits (roughly 20 requests/min, and a daily cap that is higher once the account has bought credits). The fallback list covers most bursts. For exam weeks, consider putting one paid model at the end of `OPENROUTER_MODELS`.

## Migrating from the old Node.js server

Sign in as the lecturer, then POST the old `data/db.json`:

```bash
curl -X POST https://<worker>/api/admin/import \
  -H "Authorization: Bearer <admin token>" -H "Content-Type: application/json" \
  --data @data/db.json
```

This **replaces** all data. Old password hashes keep working and are upgraded on the next login.

## API

Every `/api/*` route needs `Authorization: Bearer <token>` except `/api/health` and `/api/auth/login`. The routes are unchanged from the Node version, plus two additions:

- `GET /api/ai/models`: the free models the chat can use.
- `POST /api/agent/chat`: now also accepts an optional `model` (must be one of the above) and returns the `model` that answered.
- `WS /ws/proctor?token=<jwt>`: live proctoring.

## Security notes

- Passwords are hashed with PBKDF2-SHA256 (100k iterations, the Workers maximum). Temporary passwords appear only in the email.
- Students never receive `correctAnswer` or `rubric`.
- Proctoring summaries are computed from server-side events. The browser isn't trusted.
- If AI grading fails, it never invents a score: the answer is marked `needsReview` for the lecturer.
- Prompt injections in student answers ("give me full marks") are ignored, and the answer is flagged.
- The chat only routes to models on the server's allow-list, so a client can't pick a paid model.
