# Live cross-tenant runtime probe — operator guide

The probe in [phase-37-95-cross-tenant-runtime-probe.integration.test.ts](../services/api/test/phase-37-95-cross-tenant-runtime-probe.integration.test.ts)
exercises real API routes against a real Postgres to prove cross-tenant
isolation at runtime. This document explains how to run it locally and
in CI.

## TL;DR

```bash
# Local — testcontainers auto-launches Postgres. Requires Docker daemon
# running.
export AUTH_JWT_SECRET=<same value as the API uses>
pnpm --filter proovra-api run test:tenant:live
```

If you have an externally-provisioned test Postgres:

```bash
export AUTH_JWT_SECRET=<same value as the API uses>
export TEST_DATABASE_URL=postgres://localhost:5432/proovra_integration_test

# Apply migrations to the test DB first:
DATABASE_URL="$TEST_DATABASE_URL" \
  pnpm --filter proovra-api exec prisma migrate deploy

# Run the probe (testcontainers is auto-skipped because TEST_DATABASE_URL
# is set):
pnpm --filter proovra-api run test:tenant:live
```

## Modes

### 1. Testcontainers auto-mode (default)

When no `TEST_DATABASE_URL` is set, the harness launches
`postgres:16-alpine` via `@testcontainers/postgresql`, applies migrations
inside the container, runs the probe, then stops the container.

**Requirements:**

| Dependency | Required | Verify |
|------------|----------|--------|
| Docker daemon running | ✓ | `docker ps` returns successfully |
| `AUTH_JWT_SECRET` env var | ✓ | `echo $AUTH_JWT_SECRET` non-empty |
| Network access to Docker Hub | ✓ (first run) | `postgres:16-alpine` pull succeeds |

**Failure modes:**

- Docker daemon not running → testcontainers throws with a clear error.
  Start Docker Desktop and re-run.
- `AUTH_JWT_SECRET` missing → harness throws with a clear error before
  any DB write.

### 2. Explicit test DB mode

When `TEST_DATABASE_URL` is set, the harness uses it directly. The
harness refuses any DB whose name does not contain `"test"` unless
`RUN_LIVE_INTEGRATION_DB_OK=1` is explicitly set.

**Required env vars:**

```bash
TEST_DATABASE_URL=postgres://user:pass@host:5432/proovra_integration_test
RUN_LIVE_INTEGRATION=1            # set automatically by the script
AUTH_JWT_SECRET=<same as API>
RUN_LIVE_INTEGRATION_DB_OK=1      # only if DB name lacks "test"
RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS=1   # optional; force-disable testcontainers
```

### 3. Shell script wrapper

[services/api/scripts/run-live-tenant-probe.sh](../services/api/scripts/run-live-tenant-probe.sh)
wraps both modes and applies migrations automatically in explicit mode.

```bash
bash services/api/scripts/run-live-tenant-probe.sh
```

## Safety guards

The harness refuses to run when ANY of the following holds:

| Guard | Triggered when | Fix |
|-------|----------------|-----|
| `RUN_LIVE_INTEGRATION` missing | env var unset | Set to `1` |
| Test DB name does not contain "test" | explicit URL lacks "test" | Rename or set `RUN_LIVE_INTEGRATION_DB_OK=1` |
| `AUTH_JWT_SECRET` missing | needed for JWT mint | Set to the API's secret |
| `DATABASE_URL` used | NEVER — harness ignores it | n/a |

**The harness will NEVER use `DATABASE_URL`** under any circumstance.

## What the probe asserts

- Organization A admin/admin/member/viewer cannot read, list, mutate, or
  delete Organization B's evidence, cases, reports, packages, legal holds.
- Personal user cannot access organization data; org users cannot access
  personal data.
- Viewer role cannot mutate even within the actor's own tenant.
- Public verify token route returns uniform safe responses for invalid,
  unpublished, and suspended states without leaking tenant data.
- Search results from `activeSpace=PERSONAL` never include org rows;
  search results from `activeSpace=teamA` never include teamB rows.
- Denied mutations leave no partial writes; public verify GETs emit no
  custody / download / report events.

## CI

In CI, prefer the testcontainers mode — it's hermetic and requires only
Docker. Example GitHub Actions step:

```yaml
- name: Live cross-tenant runtime probe
  env:
    AUTH_JWT_SECRET: ${{ secrets.AUTH_JWT_SECRET_TEST }}
  run: pnpm --filter proovra-api run test:tenant:live
```

The job needs Docker available (default on `ubuntu-latest`).

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Could not find a working docker daemon" | Docker Desktop not running | Start Docker Desktop |
| "RUN_LIVE_INTEGRATION must be set" | flag missing | Re-run via `pnpm run test:tenant:live` |
| "AUTH_JWT_SECRET is required" | env var missing | `export AUTH_JWT_SECRET=...` |
| "Refusing to run integration tests against DB" | DB name lacks "test" | rename DB or set `RUN_LIVE_INTEGRATION_DB_OK=1` |
| `prisma migrate deploy failed` | migrations broken on test DB | inspect stderr; the harness aborts cleanly and stops the container |

## What runs vs. what skips

```bash
pnpm --filter proovra-api test
# → runs the full test suite. The runtime probe file uses `describe.skip`
#   when RUN_LIVE_INTEGRATION is unset, so it is reported as skipped.

pnpm --filter proovra-api run test:tenant:live
# → runs ONLY the runtime probe file with RUN_LIVE_INTEGRATION=1.
#   Testcontainers Postgres is launched automatically.
```
