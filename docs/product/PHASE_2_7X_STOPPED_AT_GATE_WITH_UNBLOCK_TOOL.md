# Phase 2.7X — Safe Org migration & multi-workspace activation: STOPPED AT GATE

## Status: REFUSED at Section 1 environment verification (same as Phase 2.7A)

The Phase 2.7X brief's Section 1 hard rule mandates:

> "NO migration execution allowed on REMOTE classification."

The Phase 2.5E `db:preflight` aggregator (re-run at the start of
this session) classified the active `DATABASE_URL` as **REMOTE**
(Neon production-like, same host as Phase 2.7A). No migration was
attempted.

**Net new this session:** rather than reproduce the Phase 2.7A
doc, I shipped a small operator-helper script that reduces the
unblock from 6 manual steps to 2 commands.

---

## What was shipped (non-migration)

### `prepare-local-env.mjs` operator helper

**File:** `services/api/scripts/prepare-local-env.mjs` (~150 lines).

Reads credentials from the running `proovra_postgres` docker
container, writes a SIBLING file `services/api/.env.audit-local`
(never the active `.env` without explicit consent), and prints a
clear "next steps" menu.

Two modes:

1. **Default** (`pnpm db:use-audit-local`): write the sibling file;
   print the operator's options. Active `.env` untouched.
2. **Swap** (`pnpm db:use-audit-local --swap --yes-i-know`): back
   up the existing `.env` to `.env.production-backup-<timestamp>`
   and replace it. **Both flags required** — `--swap` alone exits
   with code 4 REFUSED.

Hard rules baked in:
- Never applies a migration.
- Never prints the password to stdout.
- Never touches Neon credentials.
- Fails closed when docker isn't running.

Exit codes: 0 default success, 2 docker not running, 3 docker read
failed, 4 swap refused (missing `--yes-i-know`), 5 swap completed.

### npm script alias

Added to `services/api/package.json`:

```
"db:use-audit-local": "node scripts/prepare-local-env.mjs"
```

So the operator's command becomes:

```
pnpm --filter proovra-api db:use-audit-local
```

---

## Operator's two-command unblock

Replaces the Phase 2.7A 6-step procedure:

```
# Step 1 — prepare the sibling .env.audit-local from docker creds.
pnpm --filter proovra-api db:use-audit-local

# Step 2 — swap, with double acknowledgement.
pnpm --filter proovra-api db:use-audit-local --swap --yes-i-know

# Verify.
pnpm --filter proovra-api db:preflight
# Expected: [PASS] ✓ DATABASE_URL classification — host=localhost (local)

# Restore at any time.
cp services/api/.env.production-backup-<timestamp> services/api/.env
```

After Step 2 succeeds, re-run the Phase 2.7X brief and Section 1
will pass.

---

## Verification matrix (per brief's required output)

| Environment | Classification | Safe? | Action this session |
|---|---|---|---|
| Active `services/api/.env` (Neon pooler host) | **REMOTE** | **NO** | Refused — brief's hard rule |
| Generated `services/api/.env.audit-local` (NEW) | **LOCAL** (localhost) | Yes, after operator swap | Sibling file written; operator can inspect + swap |
| Docker `proovra_postgres` container | running, healthy | Yes | Credentials harvested by helper |
| Phase 2.5C wrapper sentinel test (CI) | still passes | Yes | Unchanged |
| Phase 2.5D in-process hook sentinel test (CI) | still passes | Yes | Unchanged |
| 86 e2e tests | 85/86 (same Phase 2.3 HMR flake) | Yes | No regression |

---

## What was NOT shipped (and why)

Per the brief's "NO migration execution allowed on REMOTE
classification" rule:

- ❌ No Organization schema applied (Stage 1 of Phase 2.7).
- ❌ No backfill executed (Stage 2 of Phase 2.7).
- ❌ No dual-read endpoints implemented (Stage 3 of Phase 2.7).
- ❌ No frontend org surface (Stage 4 of Phase 2.7).

All four stages have precise designs + runbooks in
`docs/product/PHASE_2_7_ORGANIZATION_ARCHITECTURE.md` §2-10 and
operator instructions in
`docs/product/PHASE_2_7A_LOCAL_ORG_MIGRATION_STOPPED_AT_GATE.md` §2.

The unblock helper this session ships makes those runbooks
1-command-away from executable in the next session.

---

## Files added / modified

Added:
- `services/api/scripts/prepare-local-env.mjs` (~150 lines)
- `docs/product/PHASE_2_7X_STOPPED_AT_GATE_WITH_UNBLOCK_TOOL.md` (this file)

Modified:
- `services/api/package.json` — `db:use-audit-local` npm script alias
- `services/api/.env.audit-local` — generated sibling env file
  (gitignored by the existing `.env.*` rule, with the
  `!.env.audit-local.example` exception NOT applying because this
  is the populated `.env.audit-local`, not the `.example`)

**Schema changes:** none.
**Backfill executed:** no.
**Frontend org surfaces:** none.

---

## Validation evidence

- `pnpm --filter proovra-api db:preflight` → exit 12 (FAIL on
  REMOTE classification, banner captured above).
- `pnpm --filter proovra-api db:use-audit-local` (default mode) →
  exit 0; sibling file written; active `.env` untouched
  (preflight re-run still REMOTE).
- `pnpm --filter proovra-api db:use-audit-local --swap` (without
  `--yes-i-know`) → exit 4 REFUSED.
- `pnpm exec playwright test` (full suite) → **85/86 passing**;
  the 1 failure is the same Phase 2.3 `/settings` HMR flake
  observed across Phase 2.5D / 2.5E / 2.5F / 2.6 / 2.6B / 2.6C /
  2.6D — passes in isolation, infra-level Next.js dev-server race.

---

## Phase 2.7X required final output (concise)

1. **Environment verification matrix:** above.
2. **Root-cause / deploy analysis:** unchanged from Phase 2.7A §3.
3. **Exact changes implemented:** operator helper + npm alias +
   sibling .env.audit-local generation. **No application code.**
4. **Files changed:** listed above.
5. **Schema changes:** none.
6. **Backfill execution results:** not executed.
7. **Dual-read compatibility behavior:** not implemented.
8. **Org RBAC behavior:** not implemented (Phase 2.7 design intact).
9. **Workspace isolation validation:** preserved by inaction.
10. **Teams governance completion:** unchanged from Phase 2.6D.
11. **Runtime org behavior:** none yet.
12. **Deploy-safety validation:** discipline working — refused.
13. **Backend↔frontend coverage matrix:** unchanged from Phase 2.7
    §11; all org capabilities remain "Stage 3/4 (operator session)".
14. **E2E tests added:** none.
15. **Runtime validation evidence:** above.
16. **Remaining migration risks:** active env still Neon; operator
    must run the 2-command unblock.
17. **Enterprise readiness score:** unchanged — 30/35 across
    governance axes (Phase 2.6D + 2.7 design).
18. **Is Organization runtime operational?** **No.** Gate not passed.
19. **Is production rollout safe?** **No.** Local validation not
    yet performed.
20. **Is PROOVRA now structurally enterprise-ready?** Single-team:
    yes (Phase 2.6D). Multi-workspace: design complete, application
    one operator session away.
21. **Recommended next phase:** re-run Phase 2.7X in a session where
    `pnpm --filter proovra-api db:use-audit-local --swap --yes-i-know`
    has been executed.

---

## Why I stopped (again) instead of bypassing

Same answer as Phase 2.7A. The Phase 2.5C wrapper + 2.5D
in-process hook + 2.5E preflight + 2.5F deploy:safe exist
specifically to prevent the action this brief was poised to
perform. Bypassing them would waste the entire Phase 2.5C-F
discipline chain.

The improvement over Phase 2.7A is that the unblock is now 2
commands instead of 6 manual steps. The operator can authorize
the swap, re-run `db:preflight`, and the next session executes
the migration cleanly.

---

## Out of scope (re-stated)

- No application code changes this session.
- No schema mutations.
- No backfill execution.
- No frontend org UI.
- No bypass of the Phase 2.5C/D/E/F guards.
- No production data touched.
- The active `services/api/.env` is INTENTIONALLY untouched —
  swapping requires operator `--swap --yes-i-know` consent.
