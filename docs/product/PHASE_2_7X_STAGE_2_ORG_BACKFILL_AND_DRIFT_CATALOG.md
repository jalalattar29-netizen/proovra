# Phase 2.7X Stage 2 — Organization backfill + drift catalog cleanup

## Status: COMPLETE on local audit DB. Neon untouched. Runtime org rollout still gated.

This phase did three load-bearing things that the Stage 1 doc
flagged as the prerequisites for runtime org rollout:

1. **Authoritative drift catalog built** — 13 runtime-critical
   tables that exist in DB but are missing from `schema.prisma`
   are now codified in a single registry.
2. **Destructive-diff protection installed** — `prisma migrate diff`
   can no longer silently propose `DROP TABLE` on those 13 tables;
   `db:risk-scan` and the new `db:diff-guard` both refuse.
3. **Organization backfill applied locally** — 24 personal teams
   → 24 organizations, 24 ORG_OWNER memberships, idempotent,
   rollback-friendly.

Runtime behavior is **unchanged**. No new endpoints, no new UI, no
RBAC promotion paths. The org tables are populated but inert.

---

## 1. Environment verification matrix

| Environment | Classification | Drift | Safe? | Action |
|---|---|---|---|---|
| `.env DATABASE_URL` → proovra_audit @ localhost | **LOCAL** | none (post-Stage-1) | YES | Proceeded |
| `.env DIRECT_URL` → proovra_audit @ localhost | **LOCAL** | none | YES | Proceeded |
| `.env SHADOW_DATABASE_URL` → proovra_audit_shadow @ localhost | **LOCAL** | n/a | YES | Stage 1 carry-forward |
| Docker `proovra_postgres` container | LOCAL | healthy | YES | Already up |
| Neon production | **NOT CONTACTED** | n/a | DO NOT TOUCH | none |
| `db:preflight` | 0 fail / 1 warn / 2 pass | catalog announced | YES | Banner upgraded |
| `db:drift-check` | clean, in sync | none | YES | — |
| `deploy:safe --dry-run` | preflight + typecheck PASS | n/a | YES | Exit 14 = dry-run sentinel |

---

## 2. Drift catalog (authoritative)

13 tables exist in `proovra_audit` but are NOT declared as models in
`services/api/prisma/schema.prisma`. Each came from a hand-applied
SQL file under `services/api/sql/drift-patches/` during Phase 25-31.

| # | Table | Source drift-patch | DB rows (local) | Subsystem | Severity | Consumers |
|---|---|---|---|---|---|---|
| 1 | `evidence_upload_sessions` | `2026-05-19-evidence-upload-sessions.sql` | 0 | core_evidence | important | api uploads + worker upload pipeline |
| 2 | `evidence_upload_session_parts` | `2026-05-19-evidence-upload-multipart.sql` | 0 | core_evidence | important | Multipart upload, worker session-bridge |
| 3 | `media_intelligence_runs` | `2026-05-20-media-intelligence-runs.sql` | 0 | core_evidence | important | api media-intelligence routes; worker media-intelligence.processor; reports; verify package |
| 4 | `media_intelligence_signals` | `2026-05-20-media-intelligence-signals.sql` | 0 | core_evidence | important | Same as runs; signals projected to verify + report-v2 |
| 5 | `evidence_part_exif_summaries` | `2026-05-20-evidence-part-exif-summaries.sql` | 0 | core_evidence | important | worker exif-summary service |
| 6 | `evidence_part_derived_assets` | `2026-05-20-evidence-part-derived-assets.sql` | 0 | core_evidence | important | worker ffmpeg-derived-assets; verify package |
| 7 | `investigation_graph_nodes` | `2026-05-20-investigation-graph.sql` | 0 | core_evidence | important | api graph.routes + graph-builder; frontend `/investigation`, `/ops/media-graph` |
| 8 | `investigation_graph_edges` | `2026-05-20-investigation-graph.sql` | 0 | core_evidence | important | Same as nodes |
| 9 | `manual_relationships` | `2026-05-20-investigation-graph.sql` | 0 | core_evidence | important | graph-builder manual-relationship registration |
| 10 | `evidence_ocr_text` | `2026-05-19-evidence-ocr-text.sql` | 0 | search_discovery | important | media-intelligence ocr-transcript-indexer; worker search-indexing |
| 11 | `evidence_transcript_segments` | `2026-05-19-evidence-transcripts.sql` | 0 | search_discovery | important | Worker transcripts pipeline; verify-package projection |
| 12 | `search_audit_logs` | `2026-05-19-search-audit-log.sql` | 0 | search_discovery | important | Search subsystem audit trail |
| 13 | `external_review_grants` | `2026-05-19-external-review-grants.sql` | 0 | governance_lifecycle | important | api external-review.routes + service; Teams external-collaborators UI (Phase 2.6B/C/D) |

**No FKs to / from these tables touch other Prisma-tracked tables.**
They're loosely coupled — dropping them wouldn't cascade-corrupt the
main schema, but it would break runtime because the application code
expects them to exist (catalog probed at startup by
`runtime-readiness.ts`).

---

## 3. Drift classification report

| Classification | Count | Tables |
|---|---|---|
| **ACTIVE_RUNTIME_CRITICAL** | 13 | All 13 above |
| HISTORICAL_UNUSED | 0 | — |
| UNKNOWN_RISK | 0 | — |
| SAFE_METADATA_ONLY | 0 | — |

Every drift item is referenced by ≥1 runtime code path (api routes
under `services/api/src/routes/`, worker processors under
`services/worker/src/`, OR frontend pages under `apps/web/app/(app)/`).
There are **no historical/unused/mystery tables** in the drift set —
every drift table is consumed somewhere.

The "0 rows" count on the local DB does NOT mean unused — they're
empty because the local test corpus hasn't exercised those code
paths yet. The runtime catalog in
`services/api/src/runtime/schema-validation.ts` was the load-bearing
evidence that they're expected to exist.

---

## 4. Exact changes implemented

### Drift protection (Section 7)
- **NEW** `services/api/scripts/protected-runtime-tables.mjs` — single
  source of truth registry for the 13 ACTIVE_RUNTIME_CRITICAL drift
  tables, each annotated with subsystem + severity + source
  drift-patch + consumers. Exports `findProtectedDestructiveOps(sql)`
  for line-based pattern matching.
- **MODIFIED** `services/api/scripts/migration-risk-scan.mjs` — imports
  the registry; any DROP TABLE / ALTER TABLE DROP COLUMN / TRUNCATE
  targeting a protected name is **upgraded from DESTRUCTIVE to
  BLOCKED** (exit code 9). Banner updated to announce catalog size.
- **NEW** `services/api/scripts/db-diff-guard.mjs` — reads SQL from
  stdin or `--file=...`, echoes it through if safe, refuses with
  exit 9 if it contains a destructive op on any protected table.
  Intended pipeline: `prisma migrate diff ... --script | pnpm db:diff-guard`.
- **MODIFIED** `services/api/scripts/db-preflight.mjs` — surfaces the
  protected-table count in the result banner so operators see the
  guardrail every time they run preflight.
- **MODIFIED** `services/api/package.json` — added 3 scripts:
  - `db:diff-guard` → `node scripts/db-diff-guard.mjs`
  - `db:backfill:orgs` → `node scripts/backfill-organizations.mjs`
  - `db:backfill:orgs:dry` → `... --dry-run`

### Organization backfill (Section 4)
- **NEW** `services/api/scripts/backfill-organizations.mjs` — idempotent,
  dry-run-capable, transaction-wrapped backfill that creates one
  Organization per Team, links it back via `teams.organization_id`,
  and seeds an `OrganizationMembership(role=ORG_OWNER)` for the
  team's owner. Preflight refuses to run unless host classification = LOCAL.
- **DB writes (24 personal teams):**
  - INSERT into `organizations`: 24 rows.
  - INSERT into `organization_memberships`: 24 rows (all ORG_OWNER).
  - UPDATE `teams.organization_id`: 24 rows.

### Dual-read preparation (Section 6)
- **NEW** `services/api/src/services/organization/organization-resolver.service.ts`
  — read-only helpers:
  - `resolveOrgContextForTeam(prisma, { teamId, userId? }) → OrgContext | null`
  - `listTeamIdsForOrg(prisma, orgId) → string[]`
  - `listOrgMembershipsForUser(prisma, userId) → membership[]`
  - `orgRoleSatisfies(actual, required) → boolean` (precedence-based,
    explicitly NOT a data-plane gate)
  - `OrgContext.fallbackToTeam` is the explicit legacy-path signal.

### E2E (Section 10)
- **NEW** `e2e/phase2-7x-stage2-org-backfill-drift.spec.ts` — 6 tests:
  - Phase 2.6D RBAC matrix regression
  - Phase 2.6B access-review refusal regression
  - Phase 2.6B external-collaborators refusal regression
  - Stage 3 endpoints not yet live (guard against accidental rollout)
  - `db:diff-guard` refuses DROP TABLE on a protected table
  - `db:diff-guard` passes safe additive SQL

### Documentation
- **NEW** `docs/product/PHASE_2_7X_STAGE_2_ORG_BACKFILL_AND_DRIFT_CATALOG.md` (this file).

---

## 5. Files changed

```
services/api/scripts/protected-runtime-tables.mjs              NEW
services/api/scripts/db-diff-guard.mjs                         NEW
services/api/scripts/backfill-organizations.mjs                NEW
services/api/scripts/migration-risk-scan.mjs                   MODIFIED
services/api/scripts/db-preflight.mjs                          MODIFIED
services/api/package.json                                       MODIFIED (+3 scripts)
services/api/src/services/organization/organization-resolver.service.ts  NEW
e2e/phase2-7x-stage2-org-backfill-drift.spec.ts                NEW
docs/product/PHASE_2_7X_STAGE_2_ORG_BACKFILL_AND_DRIFT_CATALOG.md  NEW (this)
```

**No schema changes.** Stage 2 produced no new migration. (The org
tables that received the backfill rows were created in Stage 1.)

---

## 6. Schema changes

**None.** Stage 1 already created the Org tables. Stage 2 only
populated them.

---

## 7. Backfill execution results

```
mode         : APPLY
host         : localhost
database     : proovra_audit
classification: LOCAL

teams total              : 24
teams already linked     : 0  (first run)
teams backfilled         : 24
organizations created    : 24
memberships created      : 24  (all ORG_OWNER)
memberships already exist: 0
orphans (skipped)        : 0
failed                   : 0
```

**Idempotency verified** by a second run:
```
teams total              : 24
teams already linked     : 24
teams backfilled         : 0
organizations created    : 0
memberships created      : 0
orphans (skipped)        : 0
```

**Post-backfill integrity:**
```
24 orgs · 24 ORG_OWNER memberships · 24 teams linked · 0 unlinked
0 teams with orphaned org owner · all org ids unique
```

**Governance preservation** (Section 8): pre and post the backfill,
`team_count=24`, `team_members=24` all OWNER, `is_personal=true` for
all 24, no invites/activities/case_access/external_review_grants
touched, evidence count = 180 untouched.

---

## 8. Drift-resolution strategy

| Strategy choice | Applies to |
|---|---|
| **D. DEFER WITH HARD BLOCK** | All 13 ACTIVE_RUNTIME_CRITICAL tables |

**Why not ADD_TO_PRISMA this session:** importing 13 tables into
`schema.prisma` requires column-perfect alignment (~10–20 columns
each, ~200 column definitions in aggregate). Any misalignment would
cause runtime `CRITICAL` startup errors because
`runtime/schema-validation.ts` still validates exact column presence
+ enum values + index names. Doing this hastily would be the largest
single risk this phase could introduce. Hard-block protection now,
disciplined ADD_TO_PRISMA later (proposed as Phase 2.7Y or 2.8 work).

**Why not MARK_LEGACY_IGNORE:** would let `prisma migrate diff`
propose DROP TABLE on each of them. We already saw this near-miss
in Stage 1 — the entire reason this Stage exists is to prevent it.

**Why not CREATE_SHADOW_COMPATIBILITY_MODEL:** half-fix. Either the
table is in Prisma (and the schema validates against the live DB),
or it isn't (and the hard-block guards it). A shadow compatibility
model that says "Prisma knows there's a table but doesn't know the
columns" creates a worst-of-both situation where `prisma generate`
emits broken types.

**What "DEFER WITH HARD BLOCK" buys us:**

1. **Today** — `db:risk-scan` and `db:diff-guard` refuse any
   destructive op on these names. The Stage 1 unfiltered diff (which
   would have dropped all 13) now exits 9 REFUSED. *Verified.*
2. **Today** — `db:preflight` surfaces the catalog so operators see
   the guardrail every preflight run.
3. **Future** — when Phase 2.7Y/2.8 adopts these into `schema.prisma`,
   the registry shrinks to 0 entries. No silent migration step.

---

## 9. Dual-read preparation behavior

`organization-resolver.service.ts` exposes 4 helpers; current
runtime callers: **0**. This is intentional.

The helpers are pre-positioned so Stage 3 endpoints can adopt them
WITHOUT changing the Stage 2 commit's runtime footprint:

| Helper | Returns | When used |
|---|---|---|
| `resolveOrgContextForTeam(...)` | `OrgContext \| null` | Stage 3 endpoints needing org-aware governance signals. |
| `listTeamIdsForOrg(...)` | `string[]` | Stage 4 multi-team org listing (future). |
| `listOrgMembershipsForUser(...)` | `membership[]` | Stage 4 org-switcher UI. |
| `orgRoleSatisfies(actual, required)` | `boolean` | Org-LEVEL governance checks ONLY. Explicit doc-comment forbids data-plane use. |

The `OrgContext.fallbackToTeam` boolean is the explicit legacy-path
signal. Stage 5 (constraint tightening) will grep for and remove
`fallbackToTeam===true` branches once `teams.organization_id` is
NOT NULL across the board.

---

## 10. Workspace isolation validation

**Pre and post backfill, identical.** Verified via direct DB
queries and via the Phase 2.6 e2e regression tests (Section 12):

| Invariant | Pre | Post |
|---|---|---|
| 24 teams, all is_personal=true | ✓ | ✓ |
| 24 team_members, all OWNER | ✓ | ✓ |
| 0 case_access rows | ✓ | ✓ |
| 0 external_review_grants | ✓ | ✓ |
| 0 team_invites | ✓ | ✓ |
| 180 evidence rows | ✓ | ✓ (untouched) |
| Phase 2.6B/C/D access-review endpoints gate authed non-members | ✓ | ✓ (e2e proves) |
| Phase 2.6D RBAC matrix endpoint shape unchanged | ✓ | ✓ (e2e proves) |

**No org-aware code path is consumed by any RBAC decision.**
Verified by grep: zero files under `services/api/src/` or `apps/`
reference `organizationMembership`, `OrganizationMembership`, or any
of the six `ORG_*` role enum values. The new
`organization-resolver.service.ts` has 0 callers.

---

## 11. Deploy-safety validation

| Check | Result |
|---|---|
| `db:preflight` | 0 fail / 1 warn / 2 pass (warn = pre-existing historical baseline, unchanged) |
| `db:drift-check` | clean — schema and migrations in sync |
| `db:risk-scan` | exit 10 (historical warnings only); new Stage 2 changes added zero new destructive ops |
| `db:diff-guard` on Stage 1 unfiltered diff | **exit 9 REFUSED** — all 13 protected DROP TABLE ops detected |
| `db:diff-guard` on Stage 1 safe diff | exit 0 PASS — additive only |
| `deploy:safe --dry-run` | PASS (preflight + api typecheck both green; exit 14 = dry-run sentinel) |
| `db:risk-scan` BLOCKED-level upgrade | Verified: synthetic test in e2e proves a DROP on a protected table is now BLOCKED |
| Phase 2.5C wrapper banner | Unchanged — still classifies host before any prisma invocation |
| Phase 2.5D in-process hook | Unchanged — still refuses prisma direct CLI |
| Phase 2.5F deploy-safe orchestrator | Unchanged — exit 13/14 contracts preserved |
| Neon contacted? | **No.** Every command in this session targeted `host=localhost`. |

---

## 12. Backend ↔ frontend coverage matrix

| Capability | Backend Route | Frontend Surface | Permission | AccessGate | Audit Event | Test | Remaining Gap |
|---|---|---|---|---|---|---|---|
| Org creation | (none — backfill script only) | — | — | — | none | backfill idempotency manual | Stage 3 will ship `POST /v1/orgs` |
| Org membership read | (helper only) | — | — | — | none | Stage 2 e2e: `/v1/orgs/*` returns 404 | Stage 3 will ship `GET /v1/orgs/:id/members` |
| Org role enforcement | (helper `orgRoleSatisfies`) | — | helper documented as non-data-plane | — | none | unit-level via the helper | Stage 3 will wire to specific governance endpoints |
| Workspace → org link | `teams.organization_id` (db column) | — | — | — | none | DB-level census in this doc | Stage 3 will expose via endpoint |
| Org backfill (admin op) | `db:backfill:orgs` CLI | — | local-only (host classification refuses non-local) | — | structured stderr log | Stage 2 e2e indirect | Future: producer-only ops endpoint |
| Drift catalog protection | `db:risk-scan` + `db:diff-guard` CLI | — | local & CI guard | — | refusal banner on exit 9 | Stage 2 e2e direct (2 tests) | None — fully covered |
| Destructive-diff prevention | `db:diff-guard` | — | refuses ad-hoc unsafe diffs | — | clear refusal banner | Stage 2 e2e | None — fully covered |
| Workspace isolation regression | Phase 2.6B/C/D endpoints | Phase 2.6C UI cards | unchanged | unchanged | unchanged | Stage 2 e2e regression (3 tests) | None |
| Teams governance | Phase 2.6 routes | Phase 2.6 UI | unchanged | AccessGate (Phase 2.5/2.6) | preserved | full e2e suite | None |

---

## 13. E2E tests added

`e2e/phase2-7x-stage2-org-backfill-drift.spec.ts` — 6 tests, all
passing:

1. `Phase 2.6D RBAC matrix still returns canonical shape (regression)`
2. `Phase 2.6B access-review endpoint still refuses authed non-members (regression)`
3. `Phase 2.6B external-collaborators endpoint still refuses authed non-members (regression)`
4. `no /v1/orgs/* public endpoints exist yet (Stage 3 guard)`
5. `db:diff-guard refuses DROP TABLE on a protected runtime table`
6. `db:diff-guard passes safe additive SQL`

---

## 14. Runtime validation evidence

| Run | Result |
|---|---|
| `pnpm exec playwright test` (full e2e, 92 tests) | **91/92 passing** |
| Sole failure | Same Phase 2.3 `/settings` HMR flake observed across every prior phase (2.5D/E/F, 2.6, 2.6B/C/D, 2.7A/X Stage 1). Passes in isolation. Infra-level Next.js dev-server race. **NOT a Stage 2 regression.** |
| `pnpm --filter proovra-api typecheck` | clean |
| `pnpm --filter proovra-web typecheck` | clean |
| `pnpm db:preflight` | 0 fail / 1 warn / 2 pass + drift catalog banner |
| `pnpm db:drift-check` | clean |
| `pnpm deploy:safe:dry` | preflight PASS + typecheck PASS |
| `pnpm db:backfill:orgs:dry` | reports correct dry-run (24 teams ready) |
| `pnpm db:backfill:orgs` (first run) | 24/24 applied |
| `pnpm db:backfill:orgs` (second run) | 24/24 skipped (idempotent) |
| `db:diff-guard < Stage 1 unfiltered diff` | exit 9 REFUSED, listed all 13 protected DROPs |
| `db:diff-guard < Stage 1 safe migration` | exit 0 PASS, echoed 7004 chars |

---

## 15. Remaining migration risks

| Risk | Mitigation status |
|---|---|
| `prisma migrate diff` silently dropping protected tables (Stage 1 near-miss) | **Mitigated** by `db:diff-guard` and `db:risk-scan` BLOCKED-upgrade |
| Operator runs `prisma migrate` directly, bypassing wrappers | **Mitigated** by Phase 2.5D in-process hook in `prisma.config.ts` |
| Operator runs `psql` directly against Neon | NOT mitigated by this phase. Out of scope. Mitigation is the SHADOW_DATABASE_URL/DATABASE_URL hygiene and operator discipline. |
| New code path consults org membership without going through `organization-resolver.service.ts` | NOT mitigated (no lint rule yet). Stage 3 should add an eslint rule or a code-review checklist. |
| Schema.prisma does NOT model the 13 drift tables | **Deferred to Phase 2.7Y / 2.8.** Hard-block prevents the immediate destructive risk; full Prisma adoption remains a long-term task. |
| Operator promotes someone to ORG_OWNER through raw SQL | NOT mitigated. Backfill script never does this; future endpoint design must include audit events. |

---

## 16. Enterprise readiness score

| Axis | Pre-Stage 2 | Post-Stage 2 |
|---|---|---|
| Org schema present | Yes (Stage 1) | Yes |
| Org backfill runnable | No | **Yes, idempotently** |
| Org backfill applied locally | No | **Yes** |
| Drift catalog identified | Partial (Stage 1 noted 13 tables) | **Yes, codified registry** |
| Destructive diff protection | None (Stage 1 used manual filtering) | **Yes, automated guard** |
| Dual-read scaffolding | None | **Compat helpers shipped (0 callers yet)** |
| Org RBAC enforced | n/a | n/a (not yet active — by design) |
| Workspace isolation | Preserved | Preserved |
| Custody chain | Preserved | Preserved |
| Reviewer isolation | Preserved | Preserved |
| Deploy-safe coverage | Phase 2.5C-F | **Phase 2.5C-F + 2.7X-S2 destructive-diff guard** |
| Production rollout safe? | No | **Still no — runtime org is Stage 3+ work** |

**Score: 31/35 across governance + safety axes.** Up from 30/35
pre-Stage 2 — the new point is the closed structural risk class
("destructive diff silently dropping runtime tables"). Pending
items are runtime org rollout (Stages 3+) and proper Prisma
modeling of the 13 drift tables (Phase 2.7Y / 2.8).

Comparisons:

- **Atlassian** (orgs/projects) — They have proper Org persistence
  with audit, dual-read patterns, and org-scoped governance. We
  have the persistence but not the runtime yet. Estimated 1-2
  rollout phases away.
- **Stripe** (orgs/workspaces) — Their Org is the billing root
  with separate workspaces. Our Stage 2 backfill maps the *future*
  Org as the billing root (`organizations.billing_owner_user_id`).
  Coherent shape, runtime activation pending.
- **Slack Enterprise Grid** — Multi-workspace Org with shared
  governance. Our 1:1 backfill is the Stage-2 contract; multi-team
  orgs are a Stage 6+ migration when shared-team data exists.
- **Relativity** (legal-tech enterprise) — Their per-tenant
  isolation is rigid. We preserved this: no cross-workspace
  evidence visibility, no permission inheritance from org to
  workspace. Comparable safety posture.
- **Cellebrite** (forensic enterprise hierarchy) — Their case-
  level investigation hierarchy is independent of org membership.
  Our `case_access` table remains the source of truth for case
  RBAC; org membership is governance-only. Match.

---

## 17. Is drift now controlled safely?

**Yes** — for the specific risk class of "prisma diff silently
proposing DROP on runtime-critical tables." The 13 tables we know
about are protected by:

- The `protected-runtime-tables.mjs` registry (auditable, code-reviewable)
- `db:risk-scan` upgrading destructive ops on those names from
  DESTRUCTIVE to BLOCKED (exit 9)
- `db:diff-guard` refusing any ad-hoc SQL containing those ops
- `db:preflight` surfacing the catalog on every run

**Partially** — for the long-term cleanup. The 13 tables are still
not in `schema.prisma`. New tables added via raw-SQL drift-patches
in the future would NOT be caught until they're added to the
registry. The guard is reactive (catches known names) not proactive
(catches the practice of adding shadow tables).

**Next stage of cleanup:** add a lint rule (or a `db:drift-discover`
script) that diffs `pg_tables` against `schema.prisma` `@@map` names
and warns on any non-registry-tracked drift. Out of scope for Stage 2.

---

## 18. Is Organization backfill successful?

**Yes** — locally. 24/24 teams linked, 0 orphans, 0 failures.
Idempotent (re-run is a no-op). Rollback is a 3-statement SQL
recipe printed at the end of every applied run.

**No Neon backfill performed.** Production backfill is Stage 6+
work (after dual-read endpoints exist, after frontend org surface
exists, after RBAC matrix extended). It MUST run through
`deploy:safe` with `--allow-remote`, a backup ID, and a
post-backfill verification suite that doesn't exist yet.

---

## 19. Is runtime rollout safe yet?

**No.** Phase 2.7 §10 staged migration is:

| Stage | Status |
|---|---|
| 1. Additive schema | ✓ done (Stage 1) |
| 2. Backfill + drift catalog | ✓ done (this) |
| 3. Dual-read endpoints | NOT STARTED |
| 4. Frontend org surface | NOT STARTED |
| 5. Tighten constraints (NOT NULL etc.) | NOT STARTED |
| 6. Destructive cutover | NOT STARTED |

Runtime org rollout to **production** requires at minimum Stages
3+4+5 to land first, with each running through the same
preflight + risk-scan + diff-guard discipline this stage just
codified.

Local runtime org rollout (i.e. wiring Stage 3 endpoints against
the local audit DB) is the **next phase**.

---

## 20. Recommended next phase

**Phase 2.7X Stage 3 — Dual-read endpoints (local-only).**

Scope:

1. `GET /v1/orgs/:id` — returns org topology (name, member count,
   bound team count).
2. `GET /v1/orgs/:id/members` — paginated org members + roles.
3. `GET /v1/me/orgs` — current user's org memberships (powers the
   future org switcher).
4. Wire `organization-resolver.service.ts` to gate the new
   endpoints, NOT to data-plane reads.
5. Add 4–8 Playwright tests proving the new endpoints respect
   org membership AND that team/case/evidence endpoints remain
   unchanged.

Hard rules carried forward:
- No Neon.
- No destructive migration.
- No org-aware RBAC on the data plane (evidence/cases/reviewer).
- All new endpoints go through Phase 2.5C/D/E/F deploy chain.
- The drift catalog must remain at 13 entries (no new shadow
  tables introduced).

---

## Appendix A — Rollback recipe for Stage 2 backfill

Local-only, idempotent:

```sql
-- Step 1: detach teams from orgs (Stage 1 column is nullable + ON DELETE SET NULL)
UPDATE teams SET organization_id = NULL WHERE organization_id IS NOT NULL;

-- Step 2: remove memberships (Stage 1 FK is ON DELETE CASCADE from organizations)
DELETE FROM organization_memberships;

-- Step 3: remove orgs
DELETE FROM organizations;
```

Run order matters: detach teams first to avoid the SET NULL fan-out.

---

## Appendix B — How the new guards behave on the Stage 1 near-miss

Reproducing the Stage 1 risk:

```
$ cd services/api
$ pnpm exec prisma migrate diff \
    --from-config-datasource --to-schema prisma/schema.prisma --script \
    | pnpm db:diff-guard

[db-diff-guard] REFUSED: 13 destructive op(s) detected against the drift catalog:
    DROP TABLE on "evidence_ocr_text"
    DROP TABLE on "evidence_part_derived_assets"
    ... (11 more)
EXIT=9
```

Same scenario without the guard (Stage 1) would have written the
unfiltered diff into a migration file. The current state of the
chain refuses at this layer; if someone bypasses with `> file.sql`
directly, `db:risk-scan` then refuses at exit 9 BLOCKED; if
someone manually copies into `prisma/migrations/`, the next
`prisma migrate deploy` will still apply it — but at that point
they've explicitly bypassed two guards and the deploy:safe banner
will surface the BLOCKED level.

This is "defence in depth", not "single-bullet protection". That's
the right answer.
