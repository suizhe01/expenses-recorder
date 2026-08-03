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
| `POSTGRES_USER` | no | `expenses` | Database user created by the Postgres container |
| `POSTGRES_PASSWORD` | no | `expenses` | Password for that user. Local development only |
| `POSTGRES_DB` | no | `expenses` | Database created by the Postgres container |
| `POSTGRES_PORT` | no | `5433` | Host port for the compose database. Not 5432, so it does not collide with a Postgres already installed on the machine |

`DATABASE_URL` is the only required variable, and `.env.example` already
supplies a working value.

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
