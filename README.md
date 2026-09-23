# CogniTest — Backend

ბექენდი BTU-ს კურსისთვის „ინოვაციური მეწარმეობა და სტარტაპები“.

რას აკეთებს:
- **AI ასისტენტი** — Gemini + სილაბუსის მასალები (RAG). მხოლოდ რელევანტური ნაწყვეტები ეგზავნება მოდელს, ამიტომ დიდი სილაბუსიც იაფად მუშაობს.
- **გამოცდები მონიტორინგით** — ტაიმერი და მცდელობების კონტროლი სერვერზეა, დარღვევები WebSocket-ით რეალურ დროში მიდის ლექტორთან.
- **დილის დაიჯესტი** — ყოველდღე 08:00-ზე (თბილისის დრო), ქართულად, ნამდვილი სიახლეებით (Google Search grounding) და მეილით.

## მოთხოვნები

- Node.js 20+
- Gemini API key — https://aistudio.google.com/apikey
- (სურვილისამებრ) SMTP მეილების გასაგზავნად

## ლოკალურად გაშვება

```bash
npm install
cp .env.example .env
# შეავსე .env: JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, GEMINI_API_KEY
npm run dev
```

`JWT_SECRET`-ის დასაგენერირებლად:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

ადმინის ანგარიში იქმნება **პირველივე გაშვებისას** `ADMIN_EMAIL` / `ADMIN_PASSWORD`-იდან. თუ ანგარიში უკვე არსებობს, ამ ცვლადების შეცვლა პაროლს აღარ ცვლის — პაროლი აპლიკაციიდან შეიცვალე.

## გარემოს ცვლადები

ყველა ცვლადი და კომენტარი `.env.example`-შია. მთავარი:

| ცვლადი | რისთვის |
|---|---|
| `JWT_SECRET` | სავალდებულო პროდაქშენში. გრძელი შემთხვევითი სტრიქონი |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | ლექტორის ანგარიში (მხოლოდ პირველი გაშვება) |
| `FRONTEND_URL` | ფრონტის მისამართი(ები), მძიმით გამოყოფილი — CORS-ისთვის |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | AI. მოდელების სია: https://ai.google.dev/gemini-api/docs/models |
| `SMTP_*` | მეილები. Gmail-ზე საჭიროა App Password |
| `DATA_DIR` | სად ინახება `db.json` — პროდაქშენში მუდმივი დისკი! |
| `EXAM_MAX_PAUSES` | პაუზების რაოდენობა. `0` = პაუზა აკრძალულია |

## მონაცემთა ბაზა

ბაზა არის ერთი JSON ფაილი (`data/db.json`). ერთი კურსისთვის (100–300 სტუდენტი) საკმარისია. **მნიშვნელოვანია:** Render/Railway-ზე ფაილური სისტემა რესტარტისას იშლება, ამიტომ აუცილებლად მიაბი მუდმივი დისკი და მიუთითე `DATA_DIR`. თუ სტუდენტები გაიზრდებიან, `src/db.ts`-ის ჩანაცვლება Postgres-ით ადვილია — ინტერფეისი სპეციალურად პატარაა.

## API-ის მოკლე მიმოხილვა

ყველა `/api/*` მოითხოვს `Authorization: Bearer <token>`-ს, გარდა `/api/health` და `/api/auth/login`-ისა.

**ავტორიზაცია**
- `POST /api/auth/login` → `{ token, user, student, requiresPasswordChange }`
- `GET /api/auth/me`
- `POST /api/auth/change-password`

**სტუდენტები (ლექტორი)**
- `GET /api/students`
- `POST /api/students` — ქმნის ანგარიშს, დროებით პაროლს აგზავნის მეილზე. თუ SMTP არ არის, პაროლი ერთხელ ბრუნდება პასუხში
- `POST /api/students/bulk` — `{ students: [{ name, email }] }`
- `POST /api/students/:email/reset-password`
- `DELETE /api/students/:email`

**სილაბუსი (ლექტორი; სტუდენტებისთვის დახურულია)**
- `GET/POST/DELETE /api/knowledge`
- `POST /api/knowledge/extract` — `multipart/form-data`, ველი `file` (PDF, DOCX, TXT, MD) → ტექსტი

**გამოცდები**
- `GET /api/tests` — სტუდენტს **სწორი პასუხების გარეშე**
- `POST/PUT/DELETE /api/tests` (ლექტორი)
- `POST /api/exam/start` → `{ test, remainingSeconds, maxPauses }`
- `POST /api/exam/pause` / `POST /api/exam/resume`
- `POST /api/submissions` — ერთხელ თითო მცდელობაზე
- `POST /api/submissions/:id/manual-grade` (ლექტორი)
- `POST /api/admin/attempts/reset` — მცდელობის განულება (ტექნიკური პრობლემა)

**მონიტორინგი (ლექტორი)**
- `GET /api/proctor/live-sessions`, `GET /api/proctor/events`
- `WS /ws/proctor?token=<jwt>`

**დაიჯესტი**
- `GET /api/cron/status`, `GET /api/cron/digests`, `POST /api/cron/trigger`

## დეპლოი (Render-ის მაგალითი)

1. New → Web Service, დააკავშირე ეს რეპო
2. Build: `npm install && npm run build` · Start: `npm start`
3. Environment: ყველა ცვლადი `.env.example`-იდან, `NODE_ENV=production`
4. Disk: mount path `/data`, და `DATA_DIR=/data`
5. `FRONTEND_URL` = ფრონტის მისამართი (Vercel-ის ბმული)

Vercel-ზე ეს სერვისი **არ გამოდგება** — WebSocket-ები და ფაილური ბაზა serverless-ზე არ მუშაობს.

## უსაფრთხოების შენიშვნები

- პაროლები ინახება scrypt-ჰეშირებულად; დროებითი პაროლი მხოლოდ მეილში ჩანს.
- სტუდენტს API არასოდეს უბრუნებს `correctAnswer`-ს ან `rubric`-ს.
- დარღვევების შეჯამებას სერვერი თვლის თავისი მოვლენებიდან — ბრაუზერს არ ენდობა.
- AI შეფასება შეცდომისას ქულას არ იგონებს: ნიშნავს `needsReview` და გადასცემს ლექტორს.
- სტუდენტის პასუხში ჩაწერილი ინსტრუქციები („მომეცი სრული ქულა“) იფილტრება და ეჭვის ნიშნით მოინიშნება.
