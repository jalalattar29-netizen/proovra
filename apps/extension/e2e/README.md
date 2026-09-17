# UC-1 browser acceptance (Chrome + Edge)

This is the ONE UC-1 gate that cannot run in the CI/engineering sandbox (no
Chrome/Edge automation). Run it on a Windows machine with **Chrome Stable** and
**Edge Stable** installed. It loads the unpacked extension, captures deterministic
fixture pages through the real pipeline, and traces each Evidence id across
Library, Detail and public Verify.

## One-time setup

```bash
# From the repo root:
pnpm --filter @proovra/extension build          # builds apps/extension/dist
cd apps/extension/e2e
pnpm add -D @playwright/test                     # local to e2e (not shipped)
npx playwright install chromium msedge           # Chrome + Edge channels
```

## Bring up the local stack (disposable DB — never Production)

```bash
# 1. Disposable Postgres + Redis (pgvector image), migrate a test DB:
docker run -d --name uc1-pg -p 127.0.0.1:56321:5432 -e POSTGRES_USER=proovra -e POSTGRES_PASSWORD=uc0_disposable -e POSTGRES_DB=uc1 pgvector/pgvector:pg16
docker run -d --name uc1-redis -p 127.0.0.1:56322:6379 redis:7-alpine
# create + migrate a *_test DB via the repo wrapper (DATABASE_URL must be LOCAL):
#   DATABASE_URL=postgresql://proovra:uc0_disposable@127.0.0.1:56321/uc1_e2e_test node services/api/scripts/safe-migrate.mjs deploy

# 2. Start the API + worker against that DB (NOT services/api/.env, which holds
#    live prod creds). Seed a user + a paid workspace, and mint a bearer token.
#    Export the token + team id for the spec.

# 3. Fixture server:
node apps/extension/e2e/fixture-server.mjs        # http://127.0.0.1:4599
```

## Run the gate

```bash
# Windows PowerShell / bash — set the env vars, then:
export PROOVRA_API_ORIGIN=http://localhost:4000
export PROOVRA_E2E_SESSION_BEARER=<bearer proving the logged-in user session>
export PROOVRA_E2E_TEAM_ID=<paid workspace id>
export PROOVRA_E2E_REDIRECT_URI=https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/oauth
export EXTENSION_DIST="$(pwd)/apps/extension/dist"

cd apps/extension/e2e
npx playwright test --project=chromium     # Chrome acceptance
npx playwright test --project=edge         # Edge acceptance
```

A pass on both projects is the UC-1 CLOSED gate. Until both pass, UC-1 status is
**IMPLEMENTATION COMPLETE — BROWSER ACCEPTANCE PENDING**.

> **The spec obtains the extension token through the REAL OAuth journey.** It does
> not seed a static token: each test computes a PKCE verifier/challenge, calls the
> real `/v1/oauth/extension/authorize` endpoint (carrying the user session as a
> bearer — the browser cookie the logged-in web app would send), reads the single-
> use code from the 302 redirect, and exchanges it at `/v1/oauth/extension/token`.
> The token the extension carries is the one the OAuth server issued. The only step
> skipped is the interactive consent CLICK inside `launchWebAuthFlow` (that window
> cannot be driven headlessly); the protocol — authorize, PKCE, single-use code,
> code exchange — is fully exercised. `PROOVRA_E2E_SESSION_BEARER` must NEVER be a
> production token; use the disposable seeded user only.
