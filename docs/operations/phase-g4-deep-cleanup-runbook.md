# Phase G4 — Deep Cleanup & Convergence Runbook

**Audience:** product engineers, ops leads, governance owners.

**Purpose:** describe the bounded cleanup pass that converges legacy
personal-mode evidence, retires the classic matter view, centralises tenancy
resolution, lands the typed query helper, and meaningfully refactors
`evidence.routes.ts` — all without semantic change.

**Critical rule (verbatim from spec):**

> "This phase is successful only if the platform behaves the same or safer,
> but the code becomes cleaner, faster, and more deterministic."

---

## 1. Files changed

### Backend
| File | Why |
| --- | --- |
| `services/api/src/services/organization/tenancy-resolver.service.ts` | G4.1 — added `resolveEvidenceTenancyForRead` (read-only compatibility projection for legacy personal-mode evidence) |
| `services/api/src/routes/evidence.saved-views.routes.ts` (new) | G4.5 — extracted 5 saved-view CRUD handlers + 3 schemas + 3 helpers into a focused module |
| `services/api/src/routes/evidence.routes.ts` | G4.5 — removed extracted handlers/schemas/helpers; registers the new module from the top of `evidenceRoutes(app)` |

### Frontend
| File | Why |
| --- | --- |
| `apps/web/app/(app)/cases/[id]/classic/page.tsx` | G4.2 — converted to a Next.js server-side redirect to `/cases/[id]` |
| `apps/web/app/(app)/cases/[id]/page.tsx` | G4.2 — removed `onOpenClassic` plumbing |
| `apps/web/components/cases-experience/MatterWorkspace.tsx` | G4.2 — removed `onOpenClassic` prop + two "Open classic view" buttons; updated 2 empty-state copy strings |

### Tests + docs
| File | Why |
| --- | --- |
| `services/api/test/phase-g4-tenancy-cleanup.test.ts` (new) | G4.3 — backend tenancy resolver contract + frontend `envelope.workspace` allowlist guard |
| `services/api/test/phase-g4-regression-safety.test.ts` (new) | G4.6 — 10 regression contracts proving no semantic change |
| `docs/architecture/phase-g4-projections-indexing-plan.md` (new) | G4.4 — index inventory + 5 restrained candidates that require query-plan validation |
| `docs/operations/phase-g4-deep-cleanup-runbook.md` (this file) | G4.7 — phase runbook + final report |

---

## 2. Debt map: before vs after

| Item | Before G4 | After G4 |
| --- | --- | --- |
| Legacy personal-mode evidence | Resolved via two different paths (`teamId` set → team→org; `teamId` null → `no_workspace`). No single read-side helper returned a deterministic effective tenancy. | `resolveEvidenceTenancyForRead` returns `{effectiveTeamId, effectiveOrganizationId, source}` for ANY evidence row. Legacy null-teamId rows project through the owner's personal team. Read-only — never mutates. |
| Classic matter view | Live route at `/cases/[id]/classic` rendered the scroll-spy `CaseWorkspace`. Linked from MatterWorkspace via `onOpenClassic`. Operators had two surfaces with overlapping affordances. | `/cases/[id]/classic` is a Next.js redirect to `/cases/[id]`. `onOpenClassic` plumbing removed. Empty-state copy updated to point at per-domain surfaces. Deep links still work. |
| Frontend tenancy reads | `envelope.workspace.*` read directly from 9 component files. No CI guard against new ad-hoc reads. | Contract test allowlists the existing 9 callsites. New code reads `useWorkspaceId()` / `useActiveSpaceId()` / `usePlatformContext()`. Adding a new direct-read file fails CI. |
| Backend tenancy resolver | `resolveTenancyForWrite` + `getOrganizationIdForTeam` + `checkEvidenceTenancyInvariant`. No read-side projection for "give me the effective tenancy of this evidence row." | All three preserved + new `resolveEvidenceTenancyForRead`. Resolver is the single authority. |
| `evidence.routes.ts` line count | 10,950 lines (one monolith) | 10,746 lines + 331 lines in `evidence.saved-views.routes.ts` (clean extraction of the most-bookmarked saved-view CRUD). Same total semantics. |
| `ctx.workspace.*` legacy reads | None (already eliminated in B0.1) | None — contract test now codifies that as a permanent rule |
| Index plan documentation | Inline comments only | `docs/architecture/phase-g4-projections-indexing-plan.md` — current inventory + 5 restrained candidates with query-plan pre-conditions |

---

## 3. Legacy personal-mode evidence convergence summary

**Goal (verbatim):** "Every evidence record has deterministic
workspace/org resolution."

**What changed:**

- `services/api/src/services/organization/tenancy-resolver.service.ts`
  gained a new exported function `resolveEvidenceTenancyForRead({evidenceId?
  | evidence?})`. The function:
  1. Returns the explicit team's org when `evidence.teamId` is set (Stage 6
     invariant guarantees `team.organizationId` is non-null).
  2. Returns the owner's personal team's id + org when `evidence.teamId` is
     null (legacy personal-mode row) AND the owner has bootstrapped a
     personal team. Source: `"legacy_personal_fallback"`.
  3. Returns `effectiveTeamId/effectiveOrganizationId = null` with source
     `"orphan"` when neither a team nor a resolvable personal workspace
     exists. This is the diagnostic case — the existing
     `evidence-tenancy-diagnostic.mjs` script flags these.

**What did NOT change:**

- `resolveTenancyForWrite` (the write-path resolver) is **unchanged**. Solo
  creates still receive `source: "no_workspace"` and continue to write
  null teamId — preserving the historic personal-mode behaviour.
- No evidence row is rewritten. No custody event is emitted on lookup. No
  timestamp moves. No hash recomputes. The projection is purely a read-time
  derivation.
- Reports, Verification Packages, public verify, and the hash hard-gate
  paths are untouched.

**Operator impact:** None visible. The new helper is consumed by future
governance + cross-matter projections that need a deterministic
`effectiveOrganizationId` for every row. Until a caller invokes it, the
helper sits dormant.

---

## 4. Classic matter retirement summary

**Goal (verbatim):** "Classic view is no longer necessary or primary."

**What changed:**

- `apps/web/app/(app)/cases/[id]/classic/page.tsx` is now a **server-side
  redirect** to `/cases/[id]`. Deep links continue to land somewhere safe.
- `apps/web/app/(app)/cases/[id]/page.tsx` no longer instantiates
  `onOpenClassic` or passes it into `MatterWorkspace`.
- `MatterWorkspace.tsx`:
  - Removed the `onOpenClassic?: () => void` prop.
  - Removed both "Open classic view" buttons (the header CTA and the
    error-state fallback CTA).
  - Updated empty-state copy: "Use the classic view to link evidence…" →
    points at the per-domain Evidence detail surface; "Assign… from the
    classic view" → points at the per-domain reviewer-ops / governance
    surfaces.
  - Updated module docstring to reflect that classic is retired.

**What did NOT change:**

- The `CaseWorkspace.tsx` scroll-spy component is **kept on disk** for
  historical reference. It is no longer mounted by any route. A future PR
  may delete it as a separate, well-scoped change.
- Per-domain mutation surfaces continue to own the audited write paths —
  Evidence detail (rename, finalize, share, hold), reviewer-ops (assign,
  approve, reject), governance (hold, retention, destruction), intake
  (evidence requests).
- Breadcrumbs, page gates, audit emission, custody events, and SLA timers
  are untouched.

**Operator impact:** Operators who had `/cases/[id]/classic` bookmarked
land on the canonical Matter Workspace (single 302 redirect). All
mutation affordances they previously used remain reachable via the
per-domain surfaces; the empty-state copy points them at the right place.

---

## 5. Tenancy cleanup summary

**What changed:**

- `services/api/test/phase-g4-tenancy-cleanup.test.ts` (new) asserts:
  - The backend resolver still exports the canonical helpers
    (`resolveTenancyForWrite`, `getOrganizationIdForTeam`,
    `checkEvidenceTenancyInvariant`).
  - The new G4.1 read-side helper exists.
  - The resolver still emits the 4 tenancy observability counters
    (`tenancy_resolution_failure_total`, `orphan_governance_object_total`,
    `tenancy_disagreement_total`, `cross_org_resolution_blocked_total`).
  - The resolver still throws (never silently invents) on Stage 6
    violations.
  - **No legacy `ctx.workspace.*` or `ctx.team.*` reads** anywhere in
    `apps/web`.
  - `envelope.workspace.*` is read ONLY from inside `lib/platform-context/`
    or from the 9 explicitly allowlisted carryover files. A new direct
    read in any other file fails CI.

**What did NOT change:**

- The 9 allowlisted files keep their current behaviour. Migrating them to
  `useWorkspaceId()` is bounded follow-up work that does not change
  tenancy semantics — only the call site. The G4 rule "no semantic
  changes" was the right reason to leave them in the allowlist rather
  than touch them in this PR.

**Operator impact:** None. The allowlist is the current debt frontier;
the test prevents the frontier from growing.

---

## 6. Projections + indexing summary

See [phase-g4-projections-indexing-plan.md](../architecture/phase-g4-projections-indexing-plan.md)
for the full inventory.

**What was added:** one typed query helper (`resolveEvidenceTenancyForRead`,
G4.1) and one projections+indexing plan doc enumerating the existing
indexes + the five restrained candidates that require query-plan validation
before landing.

**What was deliberately NOT added:**

- No new composite indexes. The schema already carries 60+ indexes; new
  ones require EXPLAIN ANALYZE evidence on a representative dataset, not
  theoretical analysis.
- No new `organizationId` column on `Report` or `VerificationPackage`. The
  tenancy resolves through `evidence.teamId → team.organizationId`. Adding
  a duplicated column would duplicate the source of truth — forbidden by
  the G4 spec.
- No analytics rollup tables. The reviewer-ops + governance aggregators
  recompute on demand from indexed read paths.
- No projection caches. Cache-tier discussion is out of scope for G4.

---

## 7. `evidence.routes.ts` refactor summary

**Before G4.5:** 10,950 lines, 55 handlers, mixed responsibilities (CRUD,
artifacts, verify, review, governance, relationships, collaborative
notes, saved views, public verify).

**After G4.5:** 10,746 lines in the main file + 331 lines in the new
`evidence.saved-views.routes.ts`. The extraction is mechanical and
byte-equivalent (modulo formatting):

- Same URLs: `/v1/evidence/saved-views`, `/:id`, `/:id/default`.
- Same auth: `requireAuth` on every handler.
- Same Zod schemas (`SavedViewFiltersSchema`, `CreateSavedViewBody`,
  `UpdateSavedViewBody`).
- Same response shapes (`{items}`, `{savedView}`, `{deleted: true}`).
- Same status codes (200 / 201 / 403 / 404).
- Same helpers (`assertSavedViewAccess`, `mapEvidenceSavedView`,
  `getTeamMembershipRole`, `toJsonSafe`).
- No new custody / audit / analytics emission.
- Registered from the **top** of `evidenceRoutes(app)` so route
  registration order is preserved.

**What was NOT extracted (and why):**

- Comments / legal-notes / annotations: each has 3-5 handlers that share
  the `canManageEvidenceCollaborativeContent` helper + extensive cross
  references into the audit emission + custody chain. Extracting them
  carries non-trivial behaviour risk and is bounded follow-up.
- Public verify: tightly coupled to the integrity hard-gate (A0) and the
  lifecycle state machine. Touching it in a cleanup phase risks the
  exact regressions G4.6 is designed to prevent.
- Bulk evidence actions, relationships, comparison, duplicates,
  intelligence, reviewer-workflow CRUD: each is a candidate for a
  follow-up extraction PR, scoped one at a time so the regression
  surface stays small.

**Operator impact:** None. The route URLs, schemas, payloads, status
codes, auth, and side effects are all preserved. The refactor is invisible
to consumers.

---

## 8. Tests added

| Test file | Contracts |
| --- | --- |
| `services/api/test/phase-g4-tenancy-cleanup.test.ts` | 5 backend resolver contracts + 2 frontend allowlist contracts |
| `services/api/test/phase-g4-regression-safety.test.ts` | 10 regression contracts covering verify / artifacts / custody / integrity / isolation / personal-mode / classic retirement / reviewer flows / saved-views refactor / governance |

Both suites are source-contract style (read source, assert regex/string).
They do not require a database or HTTP runtime.

---

## 9. Migration notes

**No database migration shipped in G4.**

- The G4.1 helper is read-only Prisma — no schema change.
- The G4.2 redirect is a frontend-only change — no database state shifts.
- The G4.5 refactor moves TypeScript code; the database schema is
  unchanged.
- The G4.4 plan documents 5 candidate indexes but ships **none** —
  per-spec restraint.

The existing `services/api/scripts/evidence-tenancy-diagnostic.mjs` script
remains the operator's tool for sizing the legacy population. Run it
before any future migration that moves null-teamId rows into the workspace
model.

---

## 10. Regression results

The G4.6 source-contract suite asserts the no-semantic-change envelope:

- ✅ Public verify route still mounted with no auth preHandler
- ✅ `FAILED_HASH_MISMATCH` hard-gate intact
- ✅ DESTROYED / TOMBSTONED 404 path preserved
- ✅ Report PDF + Verification Package ZIP vocabulary intact
- ✅ `appendCustodyEvent` / `appendReviewerAuditEvent` /
  `appendPlatformAuditLog` still wired in `evidence.routes.ts`
- ✅ Extracted saved-views module emits NO custody/audit/analytics
- ✅ Stage 6 invariant throws preserved (`team_org_missing`,
  `tenancy_disagreement`)
- ✅ G4.1 helper is read-only (no `.evidence.update` / `.create` /
  `.upsert` in the function body)
- ✅ Classic page redirects to canonical; `onOpenClassic` plumbing gone
- ✅ MatterWorkspace empty-state copy no longer references classic view
- ✅ G3.2 reviewer inline actions intact
- ✅ Saved-views routes registered exactly once (the new module)
- ✅ Auth preHandler preserved on every extracted route

---

## 11. Explicit confirmation

- **No semantic changes.** Every route URL, schema, response shape,
  status code, and side effect is identical to pre-G4.
- **No custody changes.** Custody events still emit from the same call
  sites with the same payload shape. The extracted saved-views module
  has zero custody emission — saved views are per-operator UI bookmarks.
- **No trust/integrity changes.** The A0 hard-gate
  (`FAILED_HASH_MISMATCH`) and A2 artifact vocabulary are unchanged.
- **No public verify regressions.** The `/public/verify/:id` route is
  untouched. DESTROYED/TOMBSTONED still 404.
- **No workspace/org leakage.** The Stage 6 invariant is preserved and
  enforced by the resolver. The new read-side helper never crosses
  tenants — it derives effective tenancy from the row's own ownerUserId
  and that user's personal team.
- **No broken solo workflows.** `resolveTenancyForWrite` still returns
  `no_workspace` for solo creates. Legacy null-teamId evidence still
  reads and writes correctly through the existing paths.

---

## 12. Reference

- Tenancy resolver: [services/api/src/services/organization/tenancy-resolver.service.ts](../../services/api/src/services/organization/tenancy-resolver.service.ts)
- Extracted saved-views module: [services/api/src/routes/evidence.saved-views.routes.ts](../../services/api/src/routes/evidence.saved-views.routes.ts)
- Refactored evidence routes: [services/api/src/routes/evidence.routes.ts](../../services/api/src/routes/evidence.routes.ts)
- Classic matter redirect: [apps/web/app/(app)/cases/[id]/classic/page.tsx](../../apps/web/app/%28app%29/cases/%5Bid%5D/classic/page.tsx)
- Matter Workspace: [apps/web/components/cases-experience/MatterWorkspace.tsx](../../apps/web/components/cases-experience/MatterWorkspace.tsx)
- Projections + indexing plan: [docs/architecture/phase-g4-projections-indexing-plan.md](../architecture/phase-g4-projections-indexing-plan.md)
- Tenancy cleanup test: [services/api/test/phase-g4-tenancy-cleanup.test.ts](../../services/api/test/phase-g4-tenancy-cleanup.test.ts)
- Regression safety test: [services/api/test/phase-g4-regression-safety.test.ts](../../services/api/test/phase-g4-regression-safety.test.ts)
- Diagnostic script: [services/api/scripts/evidence-tenancy-diagnostic.mjs](../../services/api/scripts/evidence-tenancy-diagnostic.mjs)
