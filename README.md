# expenses-recorder

Receipt capture and expense archive. Snap a receipt, have it read automatically,
confirm the extracted fields, and keep the original image for as long as you may
need to produce it.

The Fastify API and Vite web app ship together from one origin. The current web
flow supports account creation, email-verification hand-off, sign-in, session
restoration and sign-out. See the
[EXP issue chain](https://linear.app/tay-sui-zhe/team/EXP/all) for what lands next.

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 22 or newer | `node --version` |
| npm | 10 or newer | ships with Node 22 |
| Docker Desktop | any current | provides `docker compose` |

## First run

```bash
cp .env.example .env
docker compose up
```

That starts Postgres 16 and the API together. No edits to `.env` are needed —
the defaults work as-is. The API is then reachable at
<http://localhost:3000>.

Check it:

```bash
curl -s localhost:3000/health
# {"status":"ok","database":"connected","version":"0.1.0"}
```

If Postgres is unreachable the same endpoint returns HTTP 503 and
`{"status":"degraded","database":"disconnected"}` rather than failing outright.

## Database migrations

Run from `apps/api`. These talk to the database over the published host port,
so `docker compose up` must be running first.

```bash
cd apps/api

npm run migrate        # apply all pending migrations
npm run migrate:down   # roll back the most recent migration
```

Applying migrations twice is a no-op — the second run reports nothing left to
apply and exits 0.

Migrations live in `apps/api/migrations` and are run by
[node-pg-migrate](https://salsita.github.io/node-pg-migrate/). They are written
as JavaScript rather than raw SQL because raw `.sql` migrations have no
rollback support.

## Development without containers

With the compose database running, start the API and web development servers in
separate terminals:

```bash
cd apps/api
npm install
npm run dev            # tsx watch, restarts on change
```

### Local PaddleOCR proof of concept

EXP-52 adds an **observation-only** local OCR service. It is not part of the
receipt upload path and makes no cloud request. Start it when evaluating a
receipt image:

```bash
docker compose --profile ocr up --build paddleocr
curl -F image=@apps/api/eval/receipts/shell-budi95.jpg http://localhost:8008/ocr
```

The first start downloads PaddleOCR's English models into the named Docker
volume `paddleocr-models` (mounted at `/root/.paddlex`); later starts reuse
them. On macOS use Docker Desktop as above. On Windows, run the same commands
from an Ubuntu WSL terminal after enabling Docker Desktop's WSL integration.
This POC supports one JPEG, PNG, or WebP image only—no PDFs or multi-page input.

```bash
cd apps/web
npm run dev            # Vite at http://localhost:5173, proxying API calls
```

## Checks

From the repository root, `npm run lint`, `npm run typecheck`, and `npm test`
cover both workspaces. `npm run build --workspace apps/api` and
`npm run build --workspace apps/web` produce the deployable API and browser app.
The same checks run in CI on every pull request, with the API tests using a real
Postgres service container.

## Configuration

Every variable is validated at startup. A missing or malformed value stops the
process immediately with a message naming the offending variable — the API never
starts half-configured.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | no | `development` | One of `development`, `test`, `production` |
| `HOST` | no | `0.0.0.0` | Interface the API binds to. Must be `0.0.0.0` in a container |
| `PORT` | no | `3000` | Host port the API is published on |
| `LOG_LEVEL` | no | `info` | One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `DATABASE_URL` | **yes** | — | Postgres connection string. Must start `postgres://` or `postgresql://` |
| `JWT_SECRET` | **yes** | — | HS256 signing key for access tokens. Minimum 32 characters. Changing it invalidates every issued access token |
| `PUBLIC_BASE_URL` | **yes** | — | Absolute `http://` or `https://` origin the API is reached on. Used to build verification links |
| `TRUST_PROXY` | no | `false` | Exactly `true` or `false`. Believe `X-Forwarded-For` when setting the client address the rate limiter keys on. Only turn on behind a reverse proxy that is the sole route to the API — see [docs/deploy.md](docs/deploy.md) |
| `RESEND_API_KEY` | no | — | Resend API key. Unset (or empty) selects the console transport, which logs the link instead of sending |
| `MAIL_FROM` | no | `onboarding@resend.dev` | Sender address. Must be a valid email |
| `RECEIPTS_PATH` | no | `./data/receipts` | Directory receipt images are written to. Compose overrides it with the `receipts-data` volume |
| `MAX_UPLOAD_BYTES` | no | `10485760` | Largest single receipt upload, in bytes |
| `GEMINI_API_KEY` | no | — | Google AI Studio key. Unset (or empty) skips extraction; uploads still succeed |
| `GEMINI_MODEL` | no | `gemini-3.6-flash` | Model receipts are read with and recorded on every attempt. It must be a model this account can call; a 404 on every upload means the key cannot use the selected model |
| `POSTGRES_USER` | no | `expenses` | Database user created by the Postgres container |
| `POSTGRES_PASSWORD` | no | `expenses` | Password for that user. Local development only |
| `POSTGRES_DB` | no | `expenses` | Database created by the Postgres container |
| `POSTGRES_PORT` | no | `5433` | Host port for the compose database. Not 5432, so it does not collide with a Postgres already installed on the machine |

`DATABASE_URL` and `JWT_SECRET` are the required variables, and `.env.example`
supplies working values for both. The `JWT_SECRET` placeholder is for local
development only — generate a real one before the API is reachable from
anywhere else:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## Authentication

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/register` | Create an account, returns a fixed check-email message |
| POST | `/auth/login` | Exchange credentials for both tokens |
| POST | `/auth/refresh` | Rotate: returns a new access AND refresh token |
| POST | `/auth/logout` | Revoke the presented session only |
| POST | `/auth/resend-verification` | Request a fresh verification email |
| GET | `/auth/verify` | Open a verification link (returns an HTML page) |
| GET | `/auth/me` | The caller's account, via `Authorization: Bearer <accessToken>` |

Access tokens are HS256 JWTs valid for 15 minutes. Refresh tokens are opaque
random strings valid for 90 days, stored only as a SHA-256 hash.

Refresh **rotates**: each call returns a new refresh token and retires the old
one. Replaying a retired token is treated as theft — every session for that
user is revoked and all devices must log in again. A token revoked by an
explicit logout is not treated as theft, so a client retrying after logout
simply gets a 401.

If a refresh arrives while another rotation of the same session is already in
flight, the endpoint waits up to 3 seconds for the row lock and then returns
**503** with `Retry-After: 1` rather than 401 — the token is fine, so the client
should retry rather than send the user back to a login screen.

Auth routes are rate limited to 10 requests per minute per IP. `/health` is not.

### Email verification

**Verification is enforced.** New accounts start unverified and cannot sign in
until the address is confirmed.

```
register  →  201, no tokens, email sent
login     →  403 email_not_verified  (+ a fresh link is sent)
open link →  verified
login     →  200 with tokens
```

`POST /auth/register` returns `{"message":"Check your email to verify your
address."}` and nothing else — no tokens, no user object. It answers identically
whether the address was free or already taken, so registration cannot be used to
discover which addresses have accounts. Re-registering an existing address never
changes the stored password.

The `403` is only reachable **after** the password has been verified, so it
tells a caller nothing they did not already know. A wrong password still returns
the same generic `401` as an unknown address.

```bash
curl -X POST localhost:3000/auth/resend-verification \
  -H 'content-type: application/json' -d '{"email":"you@example.com"}'
```

The response is always `202` with the same body, whether the address is
unregistered, unverified, or already verified — otherwise this endpoint would be
an easy way to discover which addresses have accounts. An email is only actually
dispatched for a registered, unverified address, and at most one per address per
minute.

**Without `RESEND_API_KEY`, no real email is sent.** The console transport
writes the link to the API log instead, which is how local development and CI
work — no account, no key, no network:

```bash
docker compose logs api | grep verificationUrl
```

To send real email, get a free key at <https://resend.com> and set it:

```bash
RESEND_API_KEY=re_xxxxxxxxxxxx
MAIL_FROM=onboarding@resend.dev
```

`onboarding@resend.dev` is Resend's shared test sender. It needs no domain and
no DNS records, but it **only delivers to the email address on your own Resend
account**. Point `MAIL_FROM` at a domain you have verified with Resend to reach
anyone else.

The API logs which transport it selected at startup.

Open that URL in a browser to verify. Links last 24 hours, and requesting a new
one immediately invalidates any earlier link — only the newest works. Opening a
spent link shows a friendly "already verified" page rather than an error, since
mail clients routinely prefetch links.

Verification never signs you in. A page opened from an email client is a poor
place to hand out credentials, so it confirms and tells you to sign in normally.

`PUBLIC_BASE_URL` is what those links point at. It cannot be inferred from the
request — the link is opened later, elsewhere — so set it to your public origin
in production.

### Pruning old sessions

Every refresh retires one session row and creates another, so the `sessions`
table grows steadily with rows that can no longer authenticate.

```bash
cd apps/api
npm run prune:auth-artifacts
```

It deletes:

- every row whose `expires_at` has passed — these provably cannot authenticate
- every row revoked more than **30 days** ago

Live sessions and recently revoked ones are left alone. The 30-day window keeps
the evidence around: if reuse detection ever signs you out everywhere, those
rows are the only record of what happened.

**Nothing runs this automatically.** There is no timer in the API process and no
scheduled job — run it by hand, or add it to your own crontab:

```cron
0 4 * * * cd /path/to/expenses-recorder/apps/api && npm run prune:auth-artifacts
```

Passwords must be at least 12 characters, with no composition rules, and are
stored as salted scrypt digests.

## Layout

```
.
├── apps/
│   ├── api/                  Fastify + TypeScript service
│   │   ├── migrations/       node-pg-migrate migrations
│   │   └── src/
│   │       ├── app.ts        builds the Fastify instance
│   │       ├── config.ts     env schema, fail-fast validation
│   │       ├── db.ts         pg pool and reachability probe
│   │       ├── index.ts      startup and graceful shutdown
│   │       └── routes/
│   └── web/                  Vite + React browser app
│       └── src/
│           ├── routes/       auth and signed-in screens
│           └── session/      rotation, restore, and Web Storage adapter
├── docker-compose.yml        Postgres 16 + API
└── .github/workflows/ci.yml  lint, typecheck, test, migrations
```
