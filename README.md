# G.K. BTU Students — API (Cloudflare Workers)

Backend for the BTU course **Innovative Entrepreneurship & Startups**:

- **AI teaching assistant** — a chatbot that answers only questions about Entrepreneurship and Innovations, briefly and in a friendly tone, grounded in the syllabus (RAG). Off-topic questions are politely declined in Georgian. **Google Gemini** answers first; if it fails, **OpenRouter** answers instead. Students never pick or see a model. Gemini's brief "high demand" errors are retried after a short pause, and the whole chain runs inside a 45-second budget.
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
npx wrangler secret put GEMINI_API_KEY      # https://aistudio.google.com/apikey (primary AI)
npx wrangler secret put OPENROUTER_API_KEY  # https://openrouter.ai/keys (fallback AI)
npx wrangler secret put BREVO_API_KEY       # https://app.brevo.com/settings/keys/api (primary email, 300/day free)
npx wrangler secret put RESEND_API_KEY      # https://resend.com/api-keys (fallback email, 100/day free)
```

Then edit `[vars]` in `wrangler.toml`: `ADMIN_EMAIL`, `FRONTEND_URL` (your Pages URL), `PUBLIC_APP_URL` and `MAIL_FROM`. Deploy:

```bash
npm run deploy
```

There is exactly one administrator: `ADMIN_EMAIL` (default `giorgi.khatiashvili@btu.edu.ge`). The account is created automatically. Admin rights come from that email alone, checked on every request: only it can open the admin dashboard, invite students and upload materials. Any other account stored as an admin is downgraded on start. There is no public registration.

### Sign-in (passwordless)

Everyone signs in with a one-time code:

1. The user enters their email. `POST /api/auth/otp/request` creates a 6-digit code and emails it through Resend.
2. The user types the code. `POST /api/auth/otp/verify` checks it and returns a session token.

- **Codes:** each code is valid for 10 minutes and works only once. A new request replaces the previous code, and a code can be re-sent after 60 seconds.
- **Wrong guesses:** after 5 wrong tries the code is deleted. Requests and verifications are also rate-limited per IP and email.
- **Storage:** codes live in the Durable Object's SQLite table `otp_codes` (`email`, `code_hash`, `expires_at`, `attempts`, `created_at`). Only an HMAC-SHA256 of the code is stored, keyed with `JWT_SECRET`.
- **Unknown emails:** sign-in is refused with "თქვენი ელფოსტა არ მოიძებნა ბაზაში. მიმართეთ ადმინისტრატორს." (HTTP 404). Only accounts the admin created can sign in.

There are no passwords at all, for students or the admin. The admin signs in with a code too: Resend's test sender can already deliver to the Resend account owner's address.

**Resend must be able to reach students.** Resend's test sender (`onboarding@resend.dev`) only delivers to the Resend account owner. Verify a domain at resend.com/domains and set `MAIL_FROM` to an address on it. Until then, the admin can issue a code from the dashboard (🔑 next to each student) and pass it on.

### Local development

```bash
cp .dev.vars.example .dev.vars   # fill in
npm run dev                      # http://localhost:8787
```

### CI

`.github/workflows/ci.yml` only typechecks pushes and pull requests; it never deploys. Deploy with `npm run deploy` (wrangler) to the `aiagent-back` Worker.

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `JWT_SECRET` | secret | Required in production. Also keys the sign-in code hashes |
| `ADMIN_EMAIL` | var | The only administrator (default `giorgi.khatiashvili@btu.edu.ge`) |
| `GEMINI_API_KEY` | secret | Primary AI for the chat and digest |
| `GEMINI_MODELS` | var | Gemini models tried in order (default `gemini-3.6-flash,gemini-3.5-flash`; `gemini-1.5-flash` is retired by Google) |
| `OPENROUTER_API_KEY` | secret | Fallback AI when Gemini fails |
| `OPENROUTER_MODELS` | var | Comma-separated fallback models, tried in order. Ids no longer in OpenRouter's live catalogue are skipped, and `openrouter/free` is always the last resort. See https://openrouter.ai/models?max_price=0 |
| `DIGEST_EMAIL` | var | `"false"` keeps the daily 08:00 digest in-app only. Generating a digest from the dashboard never sends email |
| `OPENROUTER_DIGEST_MODEL` | var | Optional. The digest only ever uses `:free` models, whatever is configured |
| `DIGEST_FEEDS` | var | Comma-separated RSS/Atom feeds for the digest. Empty = TechCrunch Startups, Crunchbase News, Sifted, EU-Startups, VentureBeat |
| `BREVO_API_KEY`, `RESEND_API_KEY`, `MAIL_FROM` | secret / secret / var | Email for sign-in codes, invites and the digest. Every email tries Brevo first and falls back to Resend if Brevo fails. After a Brevo 429 (rate limit) or 402 (out of credits), Brevo is skipped for an hour. `MAIL_FROM` (`noreply@btustudents.online`) must be verified with both providers |
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

This **replaces** all data. Passwords in the dump are dropped, since sign-in is code-only.

## API

Every `/api/*` route needs `Authorization: Bearer <token>` except `/api/health` and `/api/auth/login`. The routes are unchanged from the Node version, plus two additions:

- `GET /api/ai/status`: `{ configured }`. Which provider answers is not exposed.
- `POST /api/agent/chat`: routing is server-side only; a client-sent `model` is ignored.
- `GET /api/students` (lecturer): each student also carries `hasLoggedIn`, `firstLoginAt` and `lastLoginAt` (set when an OTP code is verified), so the admin list can show Active vs Pending.
- Sessions last 90 days (`JWT_EXPIRES_IN = "90d"`). Every authenticated request also checks the account still exists, so deleting a student signs them out immediately.
- `PATCH /api/students/:email` (lecturer): edit a student's name, email, department or digest subscription. An email change also moves their login and records.
- `POST /api/cron/trigger` returns `digest: null` when there is nothing new.
- `POST /api/auth/otp/request` `{ email }` and `POST /api/auth/otp/verify` `{ email, code }`: passwordless sign-in.
- `POST /api/students/invite` (lecturer) `{ emails }`: a string separated by commas, semicolons, spaces or new lines, or an array. Creates all the accounts at once (names come from the email), then sends the invites in Resend batches. Returns per-email results.
- `POST /api/students/:email/login-code` (lecturer): issues a fresh code for a student and returns it to the lecturer if it couldn't be emailed.
- `POST /api/auth/login`, `POST /api/auth/change-password` and `POST /api/students/:email/reset-password` have been removed: there are no passwords.
- `POST /api/knowledge/bulk` (admin, multipart): `files` (repeatable; PDF, DOCX, TXT or MD; up to 20 files of 25 MB each), plus optional `text` and `textTitle` for pasted content. Each item is extracted and saved to the knowledge base, with per-item results. Texts over 400k characters are split into numbered parts.
- The AI answers **only** from the knowledge base. Questions it doesn't cover get a short "the course materials don't cover this, ask the lecturer" reply instead of general knowledge.
- `POST /api/ai/grade` has been **removed**. Grading goes only through `PATCH /api/submissions/:id/grade` (lecturer), which caps points at each question's maximum.
- `WS /ws/proctor?token=<jwt>`: live proctoring.

## Security notes

- Sign-in codes are stored only as HMAC-SHA256 hashes, expire after 10 minutes, work once, and allow 5 tries. The code appears only in the email body, never in the subject or logs.
- Students never receive `correctAnswer` or `rubric`.
- Proctoring summaries are computed from server-side events. The browser isn't trusted.
- No automatic or AI grading. Until the lecturer grades a submission, the API returns it to the student without points, pass/fail or feedback.
- The chat routes only to server-configured models; the client can't choose one.
