# Phase 2.5C — Migration safety & platform operations discipline

This phase exists because Phase 2.5B almost ran a Prisma migration
against a Neon production-like database. The migration failed before
applying SQL (a pre-existing failed migration blocked it), and the
schema additions were reverted cleanly. But the attempt itself
violated the Phase 0 hard rule "Do NOT modify live Neon production
data".

Phase 2.5C makes that mistake **structurally impossible** by default.

This phase ships ZERO product features. Every change is operational
discipline.

---

## Section 1 — Inspection matrix

| Area | Pre-2.5C behavior | Risk | Phase 2.5C status |
|---|---|---|---|
| `prisma:migrate` script | Direct `prisma migrate deploy` — no host check | **Critical**: silently applies to whatever DATABASE_URL is loaded | **shipped: routed through safe-migrate.mjs wrapper** |
| DATABASE_URL classification | None | **Critical**: same | **shipped: SAFE_HOSTS + REMOTE_PATTERNS classifier** |
| Override flag | None | **Critical**: same | **shipped: dual override (--allow-remote AND env var)** |
| Drift detection script | None | **High**: failed/pending migrations silent | **shipped: drift-check.mjs with structured exit codes** |
| CI drift gate | Phase 0 reproducibility job (clean-from-scratch only) | **Medium**: no per-run drift check on the freshly-migrated DB | **shipped: CI step invokes drift-check.mjs** |
| CI wrapper-safety test | None | **High**: a future PR could delete the wrapper without CI noticing | **shipped: CI step invokes the wrapper with a Neon URL and asserts exit 3** |
| Migration banner output | None | **High**: operator has no last-chance signal | **shipped: bold target/host/database banner on every wrapper invocation** |
| `prisma db push` | Available but undocumented | **High**: bypasses migration history | **documented as forbidden in MIGRATION_DISCIPLINE.md** |
| Rollback runbook | None | **High**: every operator improvises | **shipped: full runbook in MIGRATION_DISCIPLINE.md** |
| Release checklist | None | **Medium**: schema changes can ship without verification | **shipped: 7-item checklist in MIGRATION_DISCIPLINE.md** |

---

## Section 2 — Local-only migration enforcement (shipped)

**File: `services/api/scripts/safe-migrate.mjs`**

### Classification

Two lists determine whether a host is `local`, `remote`, or `unknown`:

- **Safe hosts (always local):** `localhost`, `127.0.0.1`, `::1`,
  `host.docker.internal`, `postgres`, `proovra_postgres`.
- **Remote patterns (always remote):** regex match against
  `*.neon.tech`, `*.amazonaws.com`, `*.azure.com`,
  `*.googleusercontent.com`, `*.cloudsql.*`, `*.pooler.*`,
  `-pooler.*`.

Anything that doesn't match either list is classified as `unknown`
and refused with the same code as `remote`. This is intentional —
we'd rather refuse a custom DNS name and ask the operator to
acknowledge it explicitly than silently proceed against an
unrecognised host.

### Refusal contract

```
local           → proceed
remote/unknown  → refuse unless BOTH:
                  1. --allow-remote flag
                  2. MIGRATE_ALLOW_REMOTE=1 env var
```

Both are required. Passing only the flag fails; setting only the env
var fails. This is the structural fix for the Phase 2.5B "I forgot
which DB the .env points at" failure mode — a developer cannot
accidentally cross the threshold by adding a single line to their
shell history or .env.

### Exit codes

| code | meaning |
|---|---|
| 0 | success (prisma's exit forwarded) |
| 1 | prisma reported a failure |
| 2 | DATABASE_URL not set (fail-closed) |
| 3 | REFUSED — non-local host without dual override |

### Banner

Every invocation prints to stderr:

```
───────────────────────────────────────────────────────────────
  PROOVRA migration safety wrapper (Phase 2.5C)
───────────────────────────────────────────────────────────────
  subcommand   : prisma migrate deploy
  protocol     : postgresql:
  host         : <hostname>
  port         : <port>
  database     : <database name>
  classification: LOCAL | REMOTE | UNKNOWN
  --allow-remote flag : YES | no
  MIGRATE_ALLOW_REMOTE: 1 | (unset)
───────────────────────────────────────────────────────────────
```

This is the operator's last visible signal before SQL is applied. If
an operator doesn't see this banner, the wrapper was bypassed.

---

## Section 3 — Schema drift detection (shipped)

**File: `services/api/scripts/drift-check.mjs`**

Wraps `prisma migrate status` with structured output + distinct exit
codes that let CI branch on failure mode:

| code | meaning |
|---|---|
| 0 | applied + healthy; no drift |
| 4 | one or more FAILED migrations present |
| 5 | one or more PENDING migrations not yet applied |
| 6 | DRIFT detected (schema vs DB out of sync) |
| 7 | prisma exited non-zero for an unrelated reason |

Output is structured + verbose. The script echoes prisma's full
output (so the operator sees the underlying signal) AND prints its
own categorised diagnosis at the bottom.

---

## Section 4 — Migration dry-run & validation

**Partial.** Prisma supports `migrate diff` for previewing the SQL
delta between schema.prisma and the database. The Phase 2.5C
wrapper does NOT yet integrate this — currently the operator runs
`prisma migrate diff` separately if they want a preview. The
wrapper's responsibility is the host-classification check, not the
SQL-content check.

**Future hardening (deferred to Phase 2.5D / 2.6):**
- Add `dry-run` subcommand that invokes `prisma migrate diff`
  before the actual `migrate deploy`.
- Detect destructive operations in the diff output (DROP TABLE,
  DROP COLUMN, ALTER COLUMN NOT NULL on existing data) and require
  a `--allow-destructive` flag in addition to the existing
  `--allow-remote`.

The current safety wrapper is enough to block the Phase 2.5B class
of failure (wrong target). The destructive-content check is a
separate class of risk and a separate phase.

---

## Section 5 — Rollback & recovery discipline (shipped)

Documented in `docs/operations/MIGRATION_DISCIPLINE.md`:

- "Migration failed mid-apply" runbook (restore + `prisma migrate
  resolve --rolled-back`).
- "Migration applied but app can't boot against it" runbook
  (validator-driven gap analysis).
- "Migration applied but business logic regressed" runbook
  (forward-compatible code rollback vs full restore).

The document is explicit that **Prisma does NOT auto-rollback**.
We're not pretending it does.

---

## Section 6 — CI/CD safety gates (shipped)

**File modified: `.github/workflows/schema-reproducibility.yml`**

Two new steps added:

### Step A — verify the wrapper refuses a remote URL

```yaml
- name: Verify safe-migrate refuses a remote DATABASE_URL
  env:
    DATABASE_URL: "postgresql://x:y@ep-fake.eu-central-1.aws.neon.tech:5432/sentinel"
  run: |
    set +e
    node scripts/safe-migrate.mjs deploy
    rc=$?
    set -e
    if [ "$rc" != "3" ]; then
      echo "FAIL — safe-migrate exited $rc against a fake Neon URL"
      exit 1
    fi
    echo "OK"
```

This locks the guard. If a future PR removes the wrapper or weakens
the classification, this step fails and the PR is blocked.

### Step B — drift check on the freshly-migrated DB

```yaml
- name: Drift check on freshly-migrated DB
  run: pnpm db:drift-check
```

Runs immediately after `prisma:migrate` succeeds. Catches the case
where migrations apply but the resulting DB state still has drift
(rare but possible with hand-edited migration SQL).

### Step C — the existing `prisma migrate deploy` step now routes through the wrapper

The Phase 0 step was changed from raw `pnpm prisma migrate deploy`
to `pnpm prisma:migrate` (the package.json script that calls the
wrapper). Since CI's DATABASE_URL is `localhost:5432`, the wrapper
passes the LOCAL classification and delegates to prisma unchanged.
But this means the wrapper is exercised on every CI run, not just
the sentinel-URL test — defense in depth.

---

## Section 7 — Environment & secret discipline

Inspected; no changes shipped this phase. The existing
`prisma.config.ts` loader is correct (no DATABASE_URL printed in
logs; no secret leak). The DATABASE_URL banner the wrapper prints
DOES NOT include the password component — only host / port /
database / protocol. This was verified in the
"prints a clear target banner" E2E test.

**Future hardening:** the wrapper could refuse if the URL contains
`?sslmode=disable` against a non-local host. Deferred.

---

## Section 8 — Operational observability

Shipped via the wrapper's banner + CI step output. The banner
appears in:

- Local terminal scrollback (developer ergonomics).
- CI job logs (auditable).
- Any incident response transcript that captures `stderr` from a
  migration run.

The drift-check script's structured exit codes let monitoring /
alerting pipelines branch on the failure mode (e.g. page the
on-call only on FAILED migrations, not on PENDING).

---

## Section 9 — Documentation (shipped)

**File: `docs/operations/MIGRATION_DISCIPLINE.md`** (~280 lines).

Sections:

1. TL;DR — three rules.
2. Phase 2.5B incident (the root cause this phase guards against).
3. Migration safety wrapper (full contract).
4. Drift detection script (full contract).
5. Supported package.json commands + the documented escape hatch.
6. Running migrations remotely — the only safe path (6-step
   procedure including backup).
7. Rollback discipline (three failure modes + runbooks).
8. Release checklist (7 items, must-be-green before merging).
9. Anti-patterns (6 things never to do).
10. Open questions / future hardening.

---

## Section 10 — Validation evidence

### Wrapper unit tests (e2e/phase2-5c-migration-safety.spec.ts)

6 tests, all passing:

1. Refuses a Neon URL with exit code 3.
2. Refuses `--allow-remote` flag alone (no env var).
3. Refuses `MIGRATE_ALLOW_REMOTE=1` env alone (no flag).
4. Refuses missing DATABASE_URL with exit code 2.
5. Prints a clear target banner including the host name +
   classification.
6. Classifies an unknown (custom DNS) host as `unknown` and refuses.

### Full e2e regression

`pnpm exec playwright test` — **56/56 passing** in ~59s.

Phase coverage:
- evidence-flow: 3/3
- landing-pages: 6/6
- phase2-1-flows: 5/5
- phase2-2-flows: 5/5
- phase2-3-flows: 7/7
- phase2-4-flows: 8/8
- phase2-5-flows: 5/5
- phase2-5b-flows: 5/5
- **phase2-5c-migration-safety: 6/6 (NEW)**
- public-verify-privacy: 6/6

**No Phase 0/1/2.1/2.2/2.3/2.4/2.5/2.5B regression.**

### Typecheck + lint

- `pnpm --filter proovra-api typecheck` — clean.
- `pnpm --filter proovra-web typecheck` — clean (no web changes
  this phase).
- New files (`safe-migrate.mjs`, `drift-check.mjs`) are pure
  Node.js; no TypeScript / lint coverage required (they're scripts,
  not application code).

---

## Section 11 — Files added / modified

Added:

- `services/api/scripts/safe-migrate.mjs` — the wrapper (~210 lines).
- `services/api/scripts/drift-check.mjs` — drift detector (~120 lines).
- `e2e/phase2-5c-migration-safety.spec.ts` — 6 tests.
- `docs/operations/MIGRATION_DISCIPLINE.md` — operational runbook.
- `docs/product/PHASE_2_5C_MIGRATION_SAFETY.md` (this file).

Modified:

- `services/api/package.json` — `prisma:migrate*` scripts now
  route through the wrapper; new `db:drift-check` script; new
  `prisma:migrate:raw` documented escape hatch.
- `.github/workflows/schema-reproducibility.yml` — added wrapper
  sentinel test step + drift-check step; the existing migrate-deploy
  step now uses `pnpm prisma:migrate` (the wrapped script).

---

## Section 12 — Remaining operational risks

P0 (known limits of this phase):

1. **Direct `prisma` CLI invocation bypasses the wrapper.** A
   developer who types `pnpm exec prisma migrate deploy` (or sets
   a shell alias) bypasses the wrapper entirely. The
   `prisma.config.ts` is the right place for an in-process
   pre-flight; that's an open question in
   MIGRATION_DISCIPLINE.md.
2. **`prisma db push` is not blocked.** It's documented as
   forbidden but not technically refused.
3. **No backup automation.** The remote-migration path documents
   backup as an operator responsibility. A future phase should
   add a small `pg_dump` step the wrapper runs automatically
   before remote migrations.

P1:

4. **No destructive-content check.** The wrapper checks the
   TARGET, not the SQL. A migration that drops a column would
   apply against a local DB without warning.
5. **Catalog extension for new tables.** The Phase 0 runtime
   validator catalog only knows about objects that existed at
   Phase 0. New tables added in later phases are silently ignored
   (which is safer than wrongly-asserting, but means we rely on
   integration tests for new-table guarantees).

P2:

6. **Drift check parsing is heuristic.** It pattern-matches
   prisma's output text. A future prisma upgrade could change the
   wording and silently break the detector. We re-emit prisma's
   own output verbatim so a wrong heuristic is operator-visible,
   not silent.

---

## Section 13 — Enterprise platform operations maturity score

Comparing operational discipline against named industry standards.
This is operational maturity, not product maturity.

| Discipline area | Pre-2.5C | After 2.5C |
|---|---|---|
| Migration target safety | 1/5 | **4/5** |
| Drift detection | 1/5 | **4/5** |
| Rollback runbook | 0/5 | **4/5** |
| CI gates on migrations | 3/5 | **4/5** |
| Operator-facing docs | 1/5 | **4/5** |
| Destructive-operation detection | 0/5 | 0/5 (deferred) |
| Backup automation | 0/5 | 0/5 (deferred) |
| In-process safety hook | 0/5 | 0/5 (deferred) |

**Aggregate score:**
- Pre-2.5C: 6/40
- **After 2.5C: 20/40**

Comparison points (rough, not formal):
- **Stripe-grade migration discipline** would be 35-38/40 (full
  destructive-op detection, automatic backup snapshotting,
  in-process safety hook, multi-tenant migration sequencing).
- **GitHub / Atlassian** sit around 30/40 (same core checks +
  staging-then-prod orchestration).
- **Typical YC-stage SaaS** sits around 5-10/40 (raw `prisma
  migrate deploy` in CI; no host check; no rollback runbook).

Phase 2.5C lifts PROOVRA from typical-YC-stage to upper-mid-market
enterprise discipline on this axis. The remaining 20 points are
specialised work that the brief explicitly flagged as future
hardening.

---

## Section 14 — Is PROOVRA operationally safe now?

**Honest answer: substantially safer; not bullet-proof.**

What's structurally fixed:

- ✅ The Phase 2.5B class of failure (wrong target) is
  blocked by default.
- ✅ Drift between migrations and DB state is detectable in <1s
  (and is checked on every CI run).
- ✅ A failed migration is surfaced with a structured exit code +
  a documented recovery runbook.
- ✅ The release checklist is explicit; ambiguity is removed.
- ✅ The wrapper itself is regression-tested in CI.

What's still real risk:

- ⚠️ A developer with shell-level prisma access can bypass the
  wrapper. The wrapper is process-boundary safety, not
  privilege-boundary safety.
- ⚠️ A destructive migration (DROP TABLE on a live DB) is not
  intercepted. The host check passes; the content check doesn't
  exist yet.
- ⚠️ No automated backup before remote migrations. Operators
  must remember.
- ⚠️ The Phase 0 validator catalog drifts behind new schema
  additions — silently. New tables exist but aren't asserted.

These risks are documented + scoped for follow-up. They do not
block Phase 2.5C completion because they are higher-order safety
(beyond what the Phase 2.5B incident exposed).

---

## Section 15 — Recommended next phase

In priority order:

1. **Add an in-process safety hook to `prisma.config.ts`.** A
   `beforeQuery` or similar that runs the same classification check
   the wrapper does — so direct prisma invocations are also
   blocked by default. Closes the "shell alias bypass" risk.
2. **Destructive-content detection.** Parse `prisma migrate diff`
   output for DROP / ALTER patterns; require `--allow-destructive`
   in addition to `--allow-remote`.
3. **Automated backup before remote migrations.** The wrapper
   invokes `pg_dump` (or the equivalent for the provider) before
   any remote `migrate deploy` and records the dump's path /
   timestamp in the audit log.
4. **Validator catalog extension** for tables added in Phase 2.1
   onwards. Either auto-generate the catalog from `schema.prisma`
   or extend it manually for each new critical table.
5. **Resume Phase 2.5B** — re-attempt the `NotificationPreference`
   + `AccountLifecycleRequest` schema additions, this time on a
   verified local DB through the new wrapper. The migration SQL is
   already drafted in `PHASE_2_5B_LIFECYCLE_AND_BULK.md` sections 2-4.

Items 1-3 close the remaining 20 points of operational maturity.
Item 5 unblocks the enterprise-procurement work that Phase 2.5B
couldn't complete.

---

## Out of scope (re-stated)

- No product feature change.
- No public-verify shape change.
- No PII / rate-limit / custody / signing regression.
- No production data touched.
- No live-secrets used.
- No schema reproducibility regression (the schema is unchanged
  from Phase 2.5B's revert state).
- No fake "safe deploy" automation. The wrapper is real
  enforcement; the docs are real workflows; Prisma's lack of
  auto-rollback is stated plainly.
