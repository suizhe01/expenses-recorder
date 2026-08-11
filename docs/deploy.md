# Deploying expenses-recorder

Runs the API on an always-free Oracle Cloud ARM instance, reachable over HTTPS
through a Tailscale Funnel. No domain, no certificate to renew, no inbound port
open to the internet.

Everything here assumes the production files: `apps/api/Dockerfile.prod` and
`docker-compose.prod.yml`. The unsuffixed `Dockerfile` and `docker-compose.yml`
are for local development — they bind-mount source and run a file watcher, and
must not be used on a public host.

**Why a tunnel at all,** when the VPS has a public IP: it terminates TLS for
free with no domain, keeps every inbound port closed, and gives a hostname that
survives reboots. `PUBLIC_BASE_URL` is baked into emailed verification links,
so a hostname that changes silently breaks every link already sent.

---

## 1. Prerequisites

- An Oracle Cloud account. The Always Free Ampere (ARM) shape is the target;
  a card is required for identity verification but the shape does not expire.
- A Tailscale account (personal plan is enough — Funnel is included).
- A Resend API key, if you want verification emails delivered rather than
  logged. Optional; without it links are written to the API log.
- A Google AI Studio key, if you want receipts read automatically. Optional;
  without it uploads still succeed and record a `skipped` attempt.

> **`MAIL_FROM` limitation.** The default `onboarding@resend.dev` is Resend's
> shared test sender: it **only delivers to the address on your Resend
> account**. That is fine while you are the only user. Reaching anyone else
> requires a domain you own, verified in Resend.

---

## 2. Provision the instance

1. Create a **VM.Standard.A1.Flex** instance (Ampere ARM). 2 OCPU / 12 GB is
   comfortable and stays inside the free allocation.
2. Image: **Ubuntu 22.04** or newer.
3. Add your SSH public key.
4. **Leave the security list alone.** Tailscale makes outbound connections
   only, so nothing beyond SSH needs to be reachable. Do not open 80 or 443.

SSH in, then:

```bash
sudo apt-get update && sudo apt-get upgrade -y
```

---

## 3. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker          # or log out and back in
docker compose version # confirm the plugin is present
```

---

## 4. Get the code

```bash
git clone https://github.com/suizhe01/expenses-recorder.git
cd expenses-recorder
```

---

## 5. Write the environment file

```bash
cp .env.example .env
```

Generate real secrets — **do not keep the development placeholders**:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT_SECRET
openssl rand -base64 32                                                          # POSTGRES_PASSWORD
```

If Node is not installed on the host, use the image you are about to build:

```bash
docker run --rm node:22-alpine node -e \
  "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Edit `.env` and set:

| Variable | Value |
| --- | --- |
| `JWT_SECRET` | the generated value. Changing it later invalidates every issued access token |
| `POSTGRES_PASSWORD` | the generated value. `docker-compose.prod.yml` refuses to start without it |
| `PUBLIC_BASE_URL` | leave as-is for now — set in step 9, once the Funnel hostname exists |
| `TRUST_PROXY` | `true`. See the warning below |
| `RESEND_API_KEY` | your key, or leave unset |
| `GEMINI_API_KEY` | your key, or leave unset |

Then lock it down:

```bash
chmod 600 .env
```

> **`TRUST_PROXY=true` trusts exactly one hop.** The API counts one proxy —
> `tailscaled` on the same host — and takes the address that proxy appended,
> ignoring anything the client put to the left of it. Trusting the header
> outright would be worse than useless: a caller could forge a different value
> per request and get a fresh rate-limit bucket every time, which removes the
> brute-force limit on `/auth/login` entirely.
>
> **If you ever put another proxy in front** — nginx, Caddy, a second tunnel —
> the count is wrong and the address is again attacker-controlled. That number
> lives in `app.ts` next to `trustProxy`.
>
> The loopback binding matters for a different reason: it stops anyone reaching
> the API directly and bypassing the tunnel. If you change the mapping to
> `3000:3000`, set `TRUST_PROXY=false`.
>
> Left at `false` behind the Funnel, the opposite problem appears: every
> request looks like it came from the proxy, so the 10-requests-a-minute auth
> limit becomes one bucket shared by everyone rather than per-client.

---

## 6. Build the image

Built here on the box, so it is natively arm64. No registry, nothing to log in
to. On 2 OCPU expect a few minutes the first time.

```bash
docker compose -f docker-compose.prod.yml build
```

---

## 7. Run migrations — explicitly, before any traffic

Migrations never run on container start. A failing migration would become a
crash-loop, and two containers starting together would race each other.

```bash
docker compose -f docker-compose.prod.yml run --rm api npm run migrate
```

This starts Postgres (and waits for its healthcheck), runs the migrations in a
one-off container from the production image, and removes it. The migration CLI
is present because `node-pg-migrate` is a runtime dependency, not a dev one.

`Can't determine timestamp` warnings are cosmetic — the migrations are
sequentially named on purpose. Ignore them.

Verify:

```bash
docker compose -f docker-compose.prod.yml run --rm api npm run migrate
# a second run must report nothing to do
```

---

## 8. Start the stack

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
curl localhost:3000/health
# {"status":"ok","database":"connected","version":"0.1.0"}
```

From any other machine, `curl http://<vps-public-ip>:3000/health` must **fail**.
If it succeeds, the port mapping is wrong — fix it before going further.

---

## 9. Put it on a Tailscale Funnel

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Follow the printed URL to authenticate the machine.

Funnel needs two things enabled once per tailnet, in the admin console
(https://login.tailscale.com/admin):

- **HTTPS certificates** — DNS → enable MagicDNS and HTTPS.
- **The Funnel node attribute** — the first `tailscale funnel` run prints the
  exact ACL snippet to add if it is missing. Follow what it prints.

Then expose the API:

```bash
sudo tailscale funnel --bg 3000
tailscale funnel status
```

Public HTTPS on 443 is proxied to `localhost:3000`. Find your hostname:

```bash
tailscale status --json | grep -i dnsname
# e.g. expenses-api.tailXXXX.ts.net
```

Confirm from a device **outside** your tailnet — a phone on mobile data, not
WiFi, and not logged into Tailscale:

```
https://<host>.ts.net/health
```

---

## 10. Point the app at its real hostname

Emailed links are built from `PUBLIC_BASE_URL`. Until this is right, every
verification and reset link points at `localhost` and opens on nothing.

Edit `.env`:

```
PUBLIC_BASE_URL=https://<host>.ts.net
```

Then recreate the container. **`restart` is not enough** — it reuses the old
environment and the new value silently never arrives:

```bash
docker compose -f docker-compose.prod.yml up -d
```

Confirm end to end: register an account, open the emailed link on a phone, and
check that logging in now returns a session rather than 403.

---

## 11. Backups

Both volumes, always. Since receipt images moved into the `receipts-data`
volume, a database dump alone restores expense records pointing at images that
no longer exist — and producing the original document is the entire point of a
seven-year archive.

```bash
./scripts/backup.sh                # writes ./backups/expenses-<timestamp>.tar.gz
./scripts/backup.sh /mnt/backups   # or somewhere else
```

Nothing schedules this. Add a cron entry if you want it regular:

```cron
0 3 * * * cd /home/ubuntu/expenses-recorder && ./scripts/backup.sh >> backup.log 2>&1
```

The archive stays on the same disk as the data it protects, which does not
survive losing the instance. Copying it off the box is out of scope here and
worth doing.

### Restoring — and drilling it

An untested backup is not a backup. Run this at least once, on a machine you do
not mind wiping.

```bash
# 1. Stop everything and discard the current data.
docker compose -f docker-compose.prod.yml down -v

# 2. Unpack the archive.
mkdir -p /tmp/restore && tar -xzf backups/expenses-<timestamp>.tar.gz -C /tmp/restore

# 3. Bring up Postgres alone and load the dump. The dump carries the schema, so
#    migrations are not needed first.
docker compose -f docker-compose.prod.yml up -d postgres
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U expenses -d expenses < /tmp/restore/database.sql

# 4. Create the api container so its volumes exist, then restore the images
#    into them.
docker compose -f docker-compose.prod.yml create api
docker run --rm \
  --volumes-from "$(docker compose -f docker-compose.prod.yml ps -aq api)" \
  -v /tmp/restore:/in alpine:3 \
  tar -xzf /in/receipts.tar.gz -C /data/receipts

# 5. Start.
docker compose -f docker-compose.prod.yml up -d
```

The drill is only passed when **both** halves check out:

1. `GET /expenses` returns the expenses that existed when the backup was taken.
2. `GET /receipts/:id/file` on one of them **returns the image**. A 503 here
   means the row was restored and the file was not, which is the exact failure
   a database-only backup produces.

---

## 12. Upgrading

```bash
cd expenses-recorder
git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm api npm run migrate
docker compose -f docker-compose.prod.yml up -d
```

Take a backup first if the release contains migrations. Migrations are not
reversible in practice even where a `down` exists.

## 13. Rolling back

```bash
git checkout <previous-tag-or-sha>
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

Code rolls back cleanly; **schema does not**. If the bad release migrated the
database, restore the pre-upgrade backup instead — that is what it is for.

---

## 14. Known limits

- **`/docs` is not served.** Swagger UI is development-only; on a public
  hostname it would hand anyone who found it a complete map of the auth
  surface. Generate the document locally with `npm run openapi` instead.
- **Emails only reach your own address** while `MAIL_FROM` is Resend's shared
  test sender. See the note in section 1.
- **Long exports may be cut by the tunnel.** `GET /expenses/export.zip` streams
  for as long as the receipts take to write. Whether Funnel holds that
  connection long enough for a large archive is not yet measured — narrow the
  date range if an export truncates, and record the size at which it breaks.

  <!-- Measured limit: not yet established. Fill this in from a real export. -->

- **Whether Funnel sends `X-Forwarded-For` at all is unverified.** `TRUST_PROXY`
  assumes it does, and takes the address one hop in. If it turns out Funnel
  does not set the header, `request.ip` falls back to the socket address —
  every client shares one rate-limit bucket, silently. Check it on the first
  deploy: hit the API from a phone and look at `remoteAddress` in the log.

  ```bash
  docker compose -f docker-compose.prod.yml logs api | grep remoteAddress | tail -1
  ```

  A real public address means the header arrived. `127.0.0.1` means it did not,
  and the per-client limit is not working — record that here and open an issue.

---

## Troubleshooting

**`curl localhost:3000/health` connects but reports `database: disconnected`** —
Postgres is up but unreachable. Check `POSTGRES_PASSWORD` is set identically for
both services; `DATABASE_URL` is composed from it.

**The API exits immediately on start** — configuration failed validation. The
process names the offending variable on stderr before exiting:
`docker compose -f docker-compose.prod.yml logs api`.

**A new environment variable had no effect** — `restart` reuses the old
environment. Use `up -d`, which recreates the container.

**Verification links point at localhost** — `PUBLIC_BASE_URL` was not updated,
or was updated without recreating the container. See step 10.

**Funnel says it is not enabled for this tailnet** — the node attribute is
missing from the tailnet ACL. `tailscale funnel 3000` prints the exact snippet.
