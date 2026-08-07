# expenses-recorder

Receipt capture and expense archive for a Malaysian individual. Snap a receipt,
have it read automatically, confirm the extracted fields, keep the original
image for as long as you might need to produce it.

**Status:** backend only. The auth block is complete — registration, login,
refresh with rotation, logout, email verification, and password reset.
No expenses, categories, receipts, or mobile app exist yet.

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

## Stack and conventions

Fastify 5, TypeScript ESM, `pg`, zod, node-pg-migrate, vitest. Node 22+.
No native modules — scrypt comes from `node:crypto` deliberately, so the alpine
image needs no build toolchain.

- Routes follow `registerXRoute(app, deps)`; `buildApp({config, database})` is
  testable via `app.inject()`
- Config is one zod schema with fail-fast validation naming the offending
  variable. Add new variables there, plus `.env.example`, `docker-compose.yml`,
  the CI workflow, and the README table
- Migrations are sequential (`0001_`, `0002_`…). node-pg-migrate warns
  `Can't determine timestamp` on every run — cosmetic, ignore it
- Tests run **sequentially** (`fileParallelism: false`): the integration suites
  share one database and each truncates
- Integration tests use a real Postgres. CI migrates *before* running them

```bash
cp .env.example .env && docker compose up -d --build
cd apps/api
npm run migrate          # then: lint, typecheck, test, build
npm run prune:sessions   # maintenance, nothing schedules it
```

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
  opens on the development machine. That is fine until the Expo app or the
  deploy runbook arrives, at which point it must change.
