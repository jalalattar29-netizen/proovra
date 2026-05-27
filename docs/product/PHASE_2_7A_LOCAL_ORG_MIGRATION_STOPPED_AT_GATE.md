# Phase 2.7A — Local Organization migration execution: STOPPED AT GATE

## Status: REFUSED at Section 1 environment verification

**This phase did not execute migration work.** The Phase 2.7A brief's
own Section 1 hard rule mandated the stop:

> "If environment is NOT local-safe: STOP. Do NOT continue migration
> work."

The Phase 2.5E `db:preflight` aggregator classified the active
`DATABASE_URL` as **REMOTE** (Neon production-like). Per the brief +
Phase 0 reproducibility rule + Phase 2.5C/D/E/F discipline, no
migration apply is safe in this session.

This is the discipline working exactly as the prior 7 phases
designed it to.

---

## Section 1 — Environment verification matrix

Real output from `pnpm --filter proovra-api db:preflight` in this session:

```
═══════════════════════════════════════════════════════════════
  PROOVRA migration preflight (Phase 2.5E)
═══════════════════════════════════════════════════════════════
  [FAIL] ✗  DATABASE_URL classification
         host=ep-long-hat-ag5kk101-pooler.c-2.eu-central-1.aws.neon.tech
         (remote) — refusing without --allow-remote + MIGRATE_ALLOW_REMOTE=1
  [WARN] ⚠  Migration risk scan
         DESTRUCTIVE patterns detected (historical baseline; review manually)
  [WARN] ⚠  Drift check
         skipped (host remote; would require connecting to a non-local DB)
═══════════════════════════════════════════════════════════════
  Result: 1 fail / 2 warn / 0 pass
═══════════════════════════════════════════════════════════════
```

Matrix per the brief's Section 1 required format:

| Environment | Classification | Safe? | Drift? | Risk | Action required |
|---|---|---|---|---|---|
| Active `DATABASE_URL` (Neon pooler host) | **REMOTE** | **NO** | skipped (refused to connect) | Phase 2.5B incident vector — applying schema here would mutate a production-like DB | **STOP — switch to local audit DB before any migration** |
| Available local `proovra_audit` DB (docker container) | unverified in `.env` | unknown to wrapper | n/a | None — but inaccessible without `.env` switch | Operator must `cp .env.audit-local.example services/api/.env`, fill in credentials, re-run preflight |
| `proovra_postgres` docker container itself | running | n/a | n/a | Container is healthy (10h uptime) with `audit` user + `proovra_audit` database + 157 tables already seeded | Available; only the env wiring is missing |

**Per brief: STOP.** The environment is not local-safe.

---

## Section 2 — What an operator must do to unblock Phase 2.7A

This is the precise procedure. It MUST run in a session where the
operator (not Claude) has shell access to confirm the env switch.

### Step 1 — Switch the active env to the local audit DB

```
# Back up the current Neon-pointing .env (it's gitignored anyway,
# but operator should keep a copy for production deploys).
cp services/api/.env services/api/.env.production-backup-$(date +%s)

# Copy the Phase 2.5F template.
cp .env.audit-local.example services/api/.env

# Edit services/api/.env to fill in the actual local Postgres
# credentials. The docker container in this session uses:
#   POSTGRES_USER=audit
#   POSTGRES_DB=proovra_audit
#   POSTGRES_PASSWORD=<see docker exec proovra_postgres env>
# So the DATABASE_URL line should become:
#
#   DATABASE_URL=postgresql://audit:<password>@localhost:5432/proovra_audit
#   DIRECT_URL=postgresql://audit:<password>@localhost:5432/proovra_audit
#
# Use the .env.audit-local.example as a reference for the rest.
```

### Step 2 — Verify the switch

```
pnpm --filter proovra-api db:preflight
```

Expected output:

```
[PASS] ✓  DATABASE_URL classification
       host=localhost (local)
[...] Migration risk scan
[...] Drift check
```

If `[PASS] ✓` does not appear on the first row, **STOP**. Do not
proceed. Verify the `.env` edit. Re-run.

### Step 3 — Confirm 86/86 e2e still passes on the local DB

```
pnpm exec playwright test
```

The active stack (API + worker + web) needs to be restarted to
pick up the new env. The CI workflow runs against this exact env
shape on every push, so passing this step locally is reasonable
ground truth.

### Step 4 — Run Phase 2.7 Stage 1 migration

Reference: `docs/product/PHASE_2_7_ORGANIZATION_ARCHITECTURE.md`
§2 (schema additions) + §10 (apply runbook).

```
# 4a. Copy the Phase 2.7 §2 schema additions into
#     services/api/prisma/schema.prisma.

# 4b. Generate the migration via the safe wrapper.
pnpm --filter proovra-api prisma:migrate:dev \
  --name p2_7a_stage1_org_model_additive

# 4c. Verify SAFE classification.
pnpm --filter proovra-api db:risk-scan
# Expected: the new migration must classify SAFE (additive CREATE
# TABLE + nullable column only).

# 4d. Run drift check.
pnpm --filter proovra-api db:drift-check
# Expected: exit 0.

# 4e. Re-run E2E.
pnpm exec playwright test
# Expected: 86/86 — no regression because no code path consumes
# the new tables yet.
```

If Step 4c shows DESTRUCTIVE or BLOCKED, the migration design has
drifted from the safe additive plan — **STOP** and revert.

### Step 5 — Run Phase 2.7 Stage 2 backfill

Reference: `docs/product/PHASE_2_7_ORGANIZATION_ARCHITECTURE.md`
§3 (backfill script + idempotency contract).

```
# 5a. Save the backfill script at
#     services/api/scripts/backfill-organizations.mts (copy from §3
#     of the Phase 2.7 design doc).

# 5b. Dry-run first by adding a --dry-run flag and listing what
#     would be created.

# 5c. Run for real.
pnpm --filter proovra-api tsx scripts/backfill-organizations.mts

# 5d. Verify counts.
docker exec proovra_postgres psql -U audit -d proovra_audit \
  -c "SELECT count(*) AS teams_without_org FROM team WHERE organization_id IS NULL"
# Expected: 0

docker exec proovra_postgres psql -U audit -d proovra_audit \
  -c "SELECT count(*) AS orgs_created FROM organizations"
# Expected: matches the team count
```

### Step 6 — Stages 3 + 4 (separate operator sessions)

Each stage is its own deliverable. Phase 2.7 doc §10 gives the per-stage
checklist. Do not bundle stages — the discipline only works if each
stage is validated before the next begins.

---

## Section 3 — Architecture / deploy analysis

(The brief's required Section 2 root-cause / deploy analysis matrix.)

| Area | Current state in this session | Risk if Phase 2.7A had proceeded | Required fix |
|---|---|---|---|
| Active DATABASE_URL | Neon production-like | **Critical** — Phase 2.5B incident replay | Operator runs §2 above |
| Local audit DB availability | `proovra_audit` exists in docker container (157 tables) | None — DB is ready; only env wiring missing | Operator runs §2 Step 1 |
| Phase 2.5C wrapper | refused fake Neon URL with exit 3 in CI sentinel test (still passing) | None — discipline working | n/a |
| Phase 2.5D in-process hook | refused fake Neon URL with exit 8 in CI sentinel test (still passing) | None — discipline working | n/a |
| Phase 2.5E preflight aggregator | correctly failed in this session with exit 12 (FAIL row above) | None — discipline working | n/a |
| Phase 2.5F deploy:safe | unchanged | None | n/a |
| Phase 0 reproducibility CI | unchanged | None | n/a |
| Active e2e suite (86 tests) | 86/86 passing in this session (no code changed) | None | n/a |

The platform's operational discipline is intact. The discipline
specifically refused to do migration work, which is the success
mode for this session.

---

## Section 4 — Exact changes implemented

**None to application code.**

**Added:**
- `docs/product/PHASE_2_7A_LOCAL_ORG_MIGRATION_STOPPED_AT_GATE.md` (this file)

**Modified:** none.

**Schema changes:** none.

**Backfill executed:** no.

**Dual-read compatibility:** not implemented (would require Stage 1
schema first).

**Frontend org surfaces:** not built (would violate "no fake
enterprise hierarchy" without backend).

---

## Section 5 — Why I refused to bypass

The Phase 2.7A brief's Section 1 contains a singular sentence:

> "If environment is NOT local-safe: STOP. Do NOT continue migration
> work."

The brief also says, explicitly:

- "do NOT point migrations at Neon"
- "do NOT bypass deploy:safe"
- "do NOT bypass db-preflight"
- "all migrations validated locally first"
- "NO Neon bypass"

These are the same rules the prior phases enforced. The
right answer is to honor them.

The Phase 2.5C wrapper + Phase 2.5D in-process hook + Phase 2.5E
preflight + Phase 2.5F deploy:safe orchestrator were all built to
prevent EXACTLY the action this brief was poised to perform. If I
had bypassed them, the entire operational discipline chain would
have been wasted, and the next operator would have inherited a
platform with a potentially-poisoned migration history on Neon.

The honest deliverable for this session is the verification matrix
+ the unblock runbook + the documented refusal. The migration
work moves to the next operator session in the way the brief +
prior phases mandated.

---

## Section 6 — Validation evidence

- `pnpm --filter proovra-api db:preflight` → exit 12 (FAIL on
  classification). Output captured in §1 above.
- `pnpm exec playwright test` (no code changed) → **86/86 passing
  in ~2m**.
- `pnpm --filter proovra-api typecheck` → clean.
- `pnpm --filter proovra-web typecheck` → clean.

No regression introduced. No tests broken.

---

## Section 7 — Files added / modified

Added:
- `docs/product/PHASE_2_7A_LOCAL_ORG_MIGRATION_STOPPED_AT_GATE.md`
  (this file)

Modified: NONE.

---

## Section 8 — Coverage matrices (per brief's required output)

### Backend ↔ frontend coverage matrix

| Capability | Backend route | Frontend surface | Permission | Audit event | AccessGate | Test coverage | Status |
|---|---|---|---|---|---|---|---|
| Org creation | not built | not built | — | — | — | — | **Stage 3 (operator)** |
| Org membership | not built | not built | — | — | — | — | **Stage 3 (operator)** |
| Org roles | not built | not built | — | — | — | — | **Stage 3 (operator)** |
| Org invites | not built | not built | — | — | — | — | **Stage 3 (operator)** |
| Workspace linking | not built | not built | — | — | — | — | **Stage 3 (operator)** |
| Workspace switching (org-grouped) | not built | not built | — | — | — | — | **Stage 4 (operator)** |
| Org RBAC | not built | not built | — | — | — | — | **Stage 3 (operator)** |
| Org access review | not built | not built | — | — | — | — | **Stage 3 (operator)** |
| Org auditability | not built | not built | — | — | — | — | **Stage 3 (operator)** |
| Org/workspace boundaries | designed (Phase 2.7 §4) | not built | — | — | — | — | **Stage 3 + 4** |
| Phase 2.6D RBAC matrix endpoint | shipped (Phase 2.6D) | hardcoded matrix (refactor pending) | auth | n/a | n/a | Phase 2.6D e2e | unchanged |
| All Phase 2.6-2.6D Team flows | unchanged | unchanged | unchanged | unchanged | unchanged | unchanged | unchanged |

### E2E tests added

None this session. Phase 2.7 design doc §12 lists the planned
Stage 3 + Stage 4 tests for when the migration actually runs.

---

## Section 9 — Remaining migration risks

P0 (Phase 2.7A unblock — operator action required):

1. **Active `services/api/.env` points at Neon.** Operator must
   switch to the local audit DB per §2 Step 1.
2. **Local audit DB credentials are not in the env example file**
   (they live in docker's container env). Operator either
   copies them from `docker exec proovra_postgres env` or updates
   `.env.audit-local.example` to point at the actual local
   container creds.

P1 (when migration runs):

3. **Backfill script must be tested in dry-run mode first.** The
   Phase 2.7 design has the idempotent script; operators must
   prove it before running for real.
4. **Stage 4 frontend refactor needs the Phase 2.6D matrix
   endpoint extended** to include org roles (`orgRoles` + `orgCategories`).
   That endpoint change ships in Stage 3.

---

## Section 10 — Enterprise readiness score

Unchanged from Phase 2.7 design-only:

| Discipline | Score |
|---|---|
| Single-team governance | 5/5 (Phase 2.6D) |
| Multi-team Organization runtime | 0/5 (gate not passed) |
| Multi-team Organization design | 5/5 (Phase 2.7) |
| Workspace isolation | 5/5 (preserved) |
| Operational discipline | 5/5 (Phase 2.5C-F + this refusal) |
| Migration safety | 5/5 (proved by this refusal) |
| Schema reproducibility | 5/5 (Phase 0 preserved) |

**Aggregate: 30/35 — unchanged from Phase 2.7.**

---

## Section 11 — Is local Organization migration successful?

**No — because it was never attempted, by design.** The brief's
own gate refused the attempt. The fact that the gate refused is a
SUCCESS for the operational discipline; it is a FAILURE for the
Phase 2.7A "execute the migration" goal. Both are true.

The migration is one operator action (env switch) away from being
executable. The Phase 2.7 design doc + this Phase 2.7A doc together
contain the precise runbook.

---

## Section 12 — Is production rollout safe yet?

**No.** Phase 2.7A's purpose was to validate the migration LOCALLY
before any production rollout. The local validation has not yet
happened. Production rollout is at minimum:

1. Phase 2.7A executed on local DB (this brief, future session)
2. Phase 2.7A re-executed on a staging-quality DB (separate
   session, requires real backup ack via `MIGRATE_BACKUP_ID`)
3. Phase 2.7A re-executed on production-shaped Neon (full Phase
   2.5C-F dual-override path with operator pair-review)
4. Post-rollout access-review verification (Phase 2.6B + 2.6C
   aggregators must show identical counts pre/post)

Steps 1-3 are sequential. Step 1 is the unblock.

---

## Section 13 — Recommended next phase

**Recommended: re-run Phase 2.7A in a session where the operator
has confirmed `db:preflight` returns LOCAL classification.**

The unblock is §2 Step 1 above. After it succeeds, the operator
re-runs the same brief (Phase 2.7A) and Section 1 passes, allowing
Sections 2-10 to execute.

No design changes needed. No code changes needed in this session.
The work is purely environmental.

---

## Out of scope (re-stated)

- No application code changes this session.
- No schema mutations.
- No backfill execution.
- No frontend org UI.
- No bypass of the Phase 2.5C/D/E/F guards.
- No production data touched.
- No `services/api/.env` modification (operator decision, not mine).

---

## Honest closing note

The user has built (with me) an operational-discipline chain over
8+ phases that exists exactly to prevent this session's outcome
from being "I migrated production by accident." When the user's
own Phase 2.7A brief contained a hard STOP gate that triggered on
the very first check, the right answer was to stop — and to
produce the precise unblock procedure so the migration can land
cleanly in the next operator session.

The 86 e2e tests remain green. The Phase 2.5C-F migration safety
infrastructure remains intact. The Phase 2.7 architectural design
is unchanged and ready for execution. Nothing was lost in this
session; the gate did its job.
