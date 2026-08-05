# expenses-recorder

Receipt capture and expense archive. Snap a receipt, have it read automatically,
confirm the extracted fields, and keep the original image for as long as you may
need to produce it.

This repository currently contains the API foundation only. See the
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

With the compose database running, the API can run directly on the host:

```bash
cd apps/api
npm install
npm run dev            # tsx watch, restarts on change
```

## Checks

```bash
cd apps/api

npm run lint           # eslint
npm run typecheck      # tsc --noEmit
npm test               # vitest
npm run build          # tsc --build -> dist/
```

All four also run in CI on every pull request, against a real Postgres service
container.

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
| POST | `/auth/register` | Create an account, returns both tokens |
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

**Nothing is gated on verification yet** — this is the mechanism only. Login and
registration are unchanged, and `email_verified` still defaults to true.

```bash
curl -X POST localhost:3000/auth/resend-verification \
  -H 'content-type: application/json' -d '{"email":"you@example.com"}'
```

The response is always `202` with the same body, whether the address is
unregistered, unverified, or already verified — otherwise this endpoint would be
an easy way to discover which addresses have accounts. An email is only actually
dispatched for a registered, unverified address, and at most one per address per
minute.

**No real email is sent yet.** The only transport writes the link to the API log:

```bash
docker compose logs api | grep verificationUrl
```

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
npm run prune:sessions
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
0 4 * * * cd /path/to/expenses-recorder/apps/api && npm run prune:sessions
```

Passwords must be at least 12 characters, with no composition rules, and are
stored as salted scrypt digests.

## Layout

```
.
├── apps/
│   └── api/                  Fastify + TypeScript service
│       ├── migrations/       node-pg-migrate migrations
│       └── src/
│           ├── app.ts        builds the Fastify instance
│           ├── config.ts     env schema, fail-fast validation
│           ├── db.ts         pg pool and reachability probe
│           ├── index.ts      startup and graceful shutdown
│           └── routes/
├── docker-compose.yml        Postgres 16 + API
└── .github/workflows/ci.yml  lint, typecheck, test, migrations
```
