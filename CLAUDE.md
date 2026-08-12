# expenses-recorder

Receipt capture and expense archive for a Malaysian individual. Snap a receipt,
have it read automatically, confirm the extracted fields, keep the original
image for as long as you might need to produce it.

**Status:** the API capture-to-record path works, and a same-origin Vite web app
now provides account creation, verification hand-off, sign-in, session restore,
and sign-out. Auth
(registration, login, refresh with rotation, logout, email verification,
password reset), category CRUD, receipt upload with on-disk storage, Gemini
extraction of the tax-invoice fields, **expense CRUD**, and **filtering the
expense list** are all merged. Extraction is verified against real photographs,
not only tests. An OpenAPI document is served at `/docs` in development.

An expense may have zero or one receipt, and a receipt backs at most one *live*
expense — enforced by a partial unique index, so deleting an expense frees its
receipt to be confirmed again. The tax-invoice fields are **copied** at confirm
rather than read back through `receipt_extractions`, so an expense is a
standalone record and editing it never disturbs what the model actually read.

**Next is the browser expense workflow.** The API, CSV export and ZIP export are
already complete; the next specs should expose receipt capture, confirmation,
expense browsing and export through the web app. Project memory holds the
decisions already settled for the backend contracts.

**The `GEMINI_API_KEY` in `.env` stopped working on 2026-08-10** (HTTP 401 —
rotated or expired, not leaked; `.env` has never been committed). Until a new key
is issued every upload records a `failed` attempt and still returns 201 with the
receipt stored, which is the guarantee below working as designed rather than a
bug.

## How work happens here

This repo runs on **Finn-loop** — three skills in `.claude/skills/`:

| | |
| --- | --- |
| `/finn-spec` | Interview until unambiguous, then file a Linear issue |
| `/loop /finn-build` | Claim an `agent-ready` issue, build it, open a PR |
| `/finn-review` | Review the PR, post a verdict, apply a label |

The cycle: **spec → the user applies `agent-ready` → build → review → the user merges.**

Two rules that are not negotiable:

- **Never apply the `agent-ready` label.** It is the user's approval gate between
  "idea" and "an agent writes code". Filing an issue is where speccing stops.
- **Never merge.** `loop-approved` is evidence for a human, not permission.

Linear team `EXP` (workspace `tay-sui-zhe`). Issues carry their own decisions and
rationale — read the issue before touching code it describes.

## Standards this project has settled on

These were learned the hard way, mostly from review findings. They matter more
than the code style.

**A test that cannot fail is worthless.** After writing a regression test, revert
the fix and confirm the test actually fails. This has caught two tests that
looked like guards and were not — including one where reverting the obvious way
did not reintroduce the bug at all.

**Prefer structural assertions over wall-clock ones.** Timing tests flake under
CI load and then get ignored. Count the scrypt calls; use a transport that never
resolves. The stopwatch check belongs in the manual steps where a human judges it.

**Disclose what was not verified.** If something could not be exercised — no API
key, no device — say so plainly in the PR and the Linear comment. Never let a
green check imply more than it covers.

**Measure before claiming.** Two "findings" in this repo evaporated under
measurement, and one set of timing numbers was pure rate-limiter noise that
looked like a serious regression. Check the status codes.

**Amend the issue when the contract changes.** If implementation shows an
acceptance criterion is wrong, stop, agree the change, and edit the issue
*before* opening the PR. Silent divergence is the thing to avoid, not change.

## Security properties that are load-bearing

Several endpoints look over-engineered until you know what they defend. Do not
simplify these without understanding them:

- **Login failure responses are byte-identical** and every path performs exactly
  one scrypt verification, including for addresses that do not exist. Timing
  alone would otherwise reveal which addresses are registered.
- **Registration answers identically** whether the address was free or taken, and
  re-registration writes *nothing* — the stored password hash must never move, or
  anyone could seize an account by re-registering it.
- **`/auth/resend-verification` always returns the same 202.** Any other shape
  makes it an account-enumeration oracle.
- **The login 403 sits strictly after the password check.** Before it, it would
  answer 403 for any registered address regardless of password.
- **Email dispatch never blocks a response.** This is a security control, not a
  performance one: awaiting a real provider call puts a network round-trip on one
  branch only, which is measurable.
- **Refresh-token reuse detection keys on `replaced_by`, not on any revoked
  token.** A client retrying after logout is not theft.
- **The verification backfill is scoped to a recorded cutoff.** An unscoped
  re-run marks every pending signup verified — this was a real, reproduced bug.
- **A Gemini failure never fails an upload.** Every outcome — timeout, rate
  limit, refusal, unparseable output — becomes a recorded `failed` attempt and
  still returns 201 with the receipt stored. A third party's bad day must not
  cost someone their receipt.
- **Token counts and `cost_micros` appear in no API response.** They live in
  `receipt_extractions` for the developer and are read with `psql`. Both the
  store's type and its SELECT omit them, so exposing them takes two deliberate
  edits.
- **5xx bodies are generic.** A global error handler replaces every 5xx body
  with `{"error":"Internal Server Error"}` and logs the real one; 4xx passes
  through untouched so the rate limiter keeps its `Retry-After`. This exists
  because an ENOENT once returned the absolute storage path, the owner's id and
  a content hash to the client.
- **A receipt attached to a live expense cannot be deleted** — 409, and
  ownership is settled *before* the attachment check, so another account's
  receipt still answers 404 rather than confirming it exists.
- **Query parsing on the two emailed-link routes is deliberately tolerant.**
  `GET /expenses` is `.strict()` and refuses an unknown parameter, because a
  misspelled filter that returns everything looks exactly like a successful
  narrow export. `/auth/verify` and `/auth/reset-password` are **not** strict:
  their URLs arrive by email, and a mail client appending `utm_source` would turn
  a valid link into "link no longer valid". Making them strict for consistency is
  a real temptation; two tests fail if you do.

## Stack and conventions

Fastify 5, TypeScript ESM, `pg`, zod, node-pg-migrate, vitest. Node 22+.
No native modules — scrypt comes from `node:crypto` deliberately, so the alpine
image needs no build toolchain.

- Routes follow `registerXRoute(app, deps)`; `buildApp({config, database})` is
  testable via `app.inject()`. External services are injected the same way —
  `emailTransport` and `extractor` — so **no test ever makes a network call**
- **A Fastify response schema is an allowlist.** Anything it does not name is
  stripped from the response. Adding a field to a payload means adding it to
  the schema too, or it silently vanishes — this has already cost one debugging
  session. It is also what guarantees cost and tokens cannot leak
- **A client route may never start with an API prefix.** `API_PREFIXES` in
  `apps/api/src/web.ts` is `/auth`, `/categories`, `/receipts`, `/expenses`,
  `/health`, `/docs`, and a prefix owns both itself and everything beneath it.
  In production the SPA fallback deliberately refuses `index.html` for those
  paths so an unknown API path stays a JSON 404; in development `vite.config.ts`
  proxies the same list to Fastify. So a colliding client route works perfectly
  when clicked and answers **JSON on a direct load, a reload or a shared link** —
  silent until someone opens the URL. This shipped twice (`/receipts/:id/confirm`
  and `/expenses`). Every client route is declared in
  `apps/web/src/client-routes.ts`, and `client-routes.test.ts` reads the prefix
  list out of the API source and fails on any collision
- **Never declare `body`, `querystring`, or `params` schemas.** Any of them
  switches on Fastify request validation, which answers 400 before the handler
  runs and would undo login's uniform 401, resend-verification's fixed 202,
  logout's idempotent 204, and the HTML error pages. A test greps for all three.
  Query parameters are therefore documented in the route's `description` prose;
  structured OpenAPI `parameters` would need a Swagger plugin `transform`, which
  is still unbuilt
- **Validation errors go through one helper**, `src/validation.ts` — outside
  `src/routes/` on purpose, so the grep test above keeps scanning route files
  only. It keeps the **first** zod issue per field, not the last: zod carries on
  after a failed check, so a field accumulates several issues and the earliest is
  the most specific. Taking the last once reported a malformed date as a future
  one
- **Read a `date` column with `to_char(col, 'YYYY-MM-DD')` in SQL, never through
  a JavaScript `Date`.** `pg` parses a `date` into a Date at *local* midnight, so
  east of UTC `toISOString().slice(0, 10)` reports the day before — measured, and
  it shipped once. Both `purchased_on` columns do this, and a structural test
  enforces it. `timestamptz` is unaffected; a full `toISOString()` there is right
- Config is one zod schema with fail-fast validation naming the offending
  variable. Add new variables there, plus `.env.example`, `docker-compose.yml`,
  the CI workflow, and the README table
- Migrations are sequential (`0001_`, `0002_`…). node-pg-migrate warns
  `Can't determine timestamp` on every run — cosmetic, ignore it
- Tests run **sequentially** (`fileParallelism: false`): the integration suites
  share one database and each truncates
- Tests also run **east of UTC** — `vitest.config.ts` pins
  `env: { TZ: 'Asia/Kuala_Lumpur' }`. CI is otherwise UTC, where a date-only bug
  and a correct implementation give the same answer, which made CI structurally
  blind to the class of bug above. The container pins `TZ=UTC` so the two are
  deliberately different
- Integration tests use a real Postgres. CI migrates *before* running them
- The `auth.test.ts` session tests do real scrypt work and take
  `SELECT … FOR UPDATE` locks, so they are the first to fail under machine load.
  A red auth suite with 4–20s test timings is usually contention — re-run before
  investigating

```bash
cp .env.example .env && docker compose up -d --build
cd apps/api
npm run migrate          # then: lint, typecheck, test, build
npm run openapi          # writes openapi.json, no server or secrets needed
npm run prune:sessions   # maintenance, nothing schedules it
```

Two container traps, both hit more than once:

- Adding a **dependency** needs `docker compose up -d --build`; `node_modules`
  is baked into the image and a restart gives `ERR_MODULE_NOT_FOUND`.
- Adding an **environment variable** needs `docker compose up -d`; `restart`
  reuses the old environment, so the variable silently never arrives.
- `tsx watch` does not always pick up **newly added files**, so a hand-verified
  404 may be a stale process rather than a bug. Check the boot timestamp.

Compose publishes Postgres on **5433**, not 5432, to avoid colliding with a
local install.

## Repository

Public — `suizhe01/expenses-recorder`. It is public because GitHub Free does not
offer rulesets on private repos, and `finn-review` refuses to award
`loop-approved` without a required status check. `ci` is required on `main` with
no bypass, so everything goes through a PR.

## What to check before speccing the next issue

Project memory holds the agreed build order and the open review findings that
are waiting for an issue touching the relevant code. Read it rather than
re-deriving what comes next.

**Email delivery works and has been confirmed end to end** (2026-08-07). A real
`RESEND_API_KEY` sits in `.env`, which is gitignored. Both messages have been
received and both links redeemed: a verification link flipped `email_verified`,
and a reset link set a new password, revoked every session, and confirmed the
address on an account that had never verified.

Two limits still apply, and both bite later rather than now:

- `MAIL_FROM` defaults to `onboarding@resend.dev`, Resend's shared test sender.
  It needs no domain and no DNS, but it **only delivers to the address on the
  Resend account**. Reaching anyone else means verifying a domain you own.
- `PUBLIC_BASE_URL` is `http://localhost:3000`, so every emailed link only
  opens on the development machine. Set it to the deployed same-origin URL
  before relying on verification or reset links away from that machine.
