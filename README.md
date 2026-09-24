# G.K. BTU Students — API (Cloudflare Workers)

Backend for the BTU course **Innovative Entrepreneurship & Startups**:

- **AI teaching assistant** — a chatbot for students' questions about startups, entrepreneurship and innovation, grounded in the syllabus (RAG) and answered by **free OpenRouter models**. Students can pick a model; if one is rate-limited the next one in the list answers.
- **Proctored exams, graded by hand** — the server owns the timer and attempts; tab switches, copy/paste, etc. reach the lecturer live over WebSockets. **AI never grades anything**: every submission waits for the lecturer, and students see no score until the lecturer publishes it.
- **Morning digest, 100% free** — every day at 08:00 Tbilisi time. News comes from free public **RSS feeds**; a free (`:free`) model only writes the Georgian summaries. Emailed via Resend.

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
                          ├──▶ OpenRouter free models (chat, digest)  src/ai.ts
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
| `OPENROUTER_API_KEY` | secret | AI chat and digest summaries (free models; a free OpenRouter account is enough) |
| `OPENROUTER_MODELS` | var | Comma-separated free models; the first is the default. See https://openrouter.ai/models?max_price=0 |
| `OPENROUTER_DIGEST_MODEL` | var | Optional. The digest only ever uses `:free` models, whatever is configured |
| `DIGEST_FEEDS` | var | Comma-separated RSS/Atom feeds for the digest. Empty = TechCrunch Startups, Crunchbase News, Sifted, EU-Startups, VentureBeat |
| `RESEND_API_KEY`, `MAIL_FROM` | secret / var | Email. Without it, temporary passwords are shown once to the lecturer |
| `FRONTEND_URL` | var | Allowed CORS origins, comma-separated |
| `EXAM_MAX_PAUSES` | var | Pause credits per attempt; `0` disables pausing |

Free OpenRouter models have rate limits (roughly 20 requests/min and a daily request cap). The fallback list covers most bursts. Nothing in this project needs a paid plan.

### How the digest stays free and factual

1. `news.ts` reads the RSS feeds and keeps items from the last 48 hours (a week if feeds were quiet), de-duplicated and mixed across sources. Broken feeds are skipped.
2. A free model receives the numbered list and returns which items to use, plus summaries, takeaways and a quiz question.
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

- `GET /api/ai/models`: the free models the chat can use.
- `POST /api/agent/chat`: now also accepts an optional `model` (must be one of the above) and returns the `model` that answered.
- `POST /api/ai/grade` has been **removed**. Grading goes only through `PATCH /api/submissions/:id/grade` (lecturer), which caps points at each question's maximum.
- `WS /ws/proctor?token=<jwt>`: live proctoring.

## Security notes

- Passwords are hashed with PBKDF2-SHA256 (100k iterations, the Workers maximum). Temporary passwords appear only in the email.
- Students never receive `correctAnswer` or `rubric`.
- Proctoring summaries are computed from server-side events. The browser isn't trusted.
- No automatic or AI grading. Until the lecturer grades a submission, the API returns it to the student without points, pass/fail or feedback.
- The chat only routes to models on the server's allow-list, so a client can't pick a paid model.
