# G.K. BTU Students — API (Cloudflare Workers)

Backend for the BTU course **Innovative Entrepreneurship & Startups**:

- **AI teaching assistant** — a chatbot that answers only questions about Entrepreneurship and Innovations, briefly and in a friendly tone, grounded in the syllabus (RAG). Off-topic questions are politely declined in Georgian. **Google Gemini** answers first; if it fails, **OpenRouter** answers instead. Students never pick or see a model.
- **Proctored exams, graded by hand** — the server owns the timer and attempts; tab switches, copy/paste, etc. reach the lecturer live over WebSockets. **AI never grades anything**: every submission waits for the lecturer, and students see no score until the lecturer publishes it.
- **Morning digest** — every day at 08:00 Tbilisi time. News comes from free public **RSS feeds**; Gemini (or a free OpenRouter model as fallback) writes the Georgian summaries. Only news that is new since the last digest and never used before is included. If nothing new or relevant happened, no digest is created or sent.
- **Quizzes are scored out of 10** — a test's questions can total at most 10 points (half points allowed).

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
                          ├──▶ RSS feeds (free news)                 src/news.ts
                          ├──▶ Gemini → OpenRouter fallback (chat, digest) src/ai.ts
                          └──▶ Resend (email)                        src/mailer.ts
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
npx wrangler secret put GEMINI_API_KEY      # https://aistudio.google.com/apikey (primary AI)
npx wrangler secret put OPENROUTER_API_KEY  # https://openrouter.ai/keys (fallback AI)
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
| `GEMINI_API_KEY` | secret | Primary AI for the chat and digest |
| `GEMINI_MODELS` | var | Gemini models tried in order (default `gemini-3.6-flash,gemini-3.5-flash`; `gemini-1.5-flash` is retired by Google) |
| `OPENROUTER_API_KEY` | secret | Fallback AI when Gemini fails |
| `OPENROUTER_MODELS` | var | Comma-separated fallback models, tried in order. See https://openrouter.ai/models?max_price=0 |
| `OPENROUTER_DIGEST_MODEL` | var | Optional. The digest only ever uses `:free` models, whatever is configured |
| `DIGEST_FEEDS` | var | Comma-separated RSS/Atom feeds for the digest. Empty = TechCrunch Startups, Crunchbase News, Sifted, EU-Startups, VentureBeat |
| `RESEND_API_KEY`, `MAIL_FROM` | secret / var | Email. Without it, temporary passwords are shown once to the lecturer |
| `FRONTEND_URL` | var | Allowed CORS origins, comma-separated |
| `EXAM_MAX_PAUSES` | var | Pause credits per attempt; `0` disables pausing |

Free OpenRouter models have rate limits (roughly 20 requests/min and a daily request cap). The fallback list covers most bursts. Nothing in this project needs a paid plan.

### How the digest stays free and factual

1. `news.ts` reads the RSS feeds and keeps only items published since the previous digest (at most 36 hours back) that no earlier digest has used. They are de-duplicated and mixed across sources. Broken feeds are skipped. There is no wider fallback window, so a quiet day means no digest.
2. The AI receives the numbered list and returns which items are really relevant (it may return none), plus summaries, takeaways and a quiz question that doesn't repeat recent ones.
3. Titles, sources and links are taken from the feed, never from the model, so the digest can't cite invented news.

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

- `GET /api/ai/status`: `{ configured }`. Which provider answers is not exposed.
- `POST /api/agent/chat`: routing is server-side only; a client-sent `model` is ignored.
- `PATCH /api/students/:email` (lecturer): edit a student's name, email, department or digest subscription. An email change also moves their login and records.
- `POST /api/cron/trigger` returns `digest: null` when there is nothing new.
- `POST /api/ai/grade` has been **removed**. Grading goes only through `PATCH /api/submissions/:id/grade` (lecturer), which caps points at each question's maximum.
- `WS /ws/proctor?token=<jwt>`: live proctoring.

## Security notes

- Passwords are hashed with PBKDF2-SHA256 (100k iterations, the Workers maximum). Temporary passwords appear only in the email.
- Students never receive `correctAnswer` or `rubric`.
- Proctoring summaries are computed from server-side events. The browser isn't trusted.
- No automatic or AI grading. Until the lecturer grades a submission, the API returns it to the student without points, pass/fail or feedback.
- The chat routes only to server-configured models; the client can't choose one.
