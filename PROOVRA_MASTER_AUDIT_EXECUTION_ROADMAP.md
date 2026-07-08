# PROOVRA — Master Audit Execution Roadmap

**Turns `PROOVRA_ENTERPRISE_PRODUCT_ARCHITECTURE_MASTER_AUDIT.md` into a sequenced, safe implementation plan.**
**Date:** 2026-07-07. **No code modified.** Every file/route cited is from the audited repo.

**Sequencing principle:** ordered lowest-risk-highest-value → highest-risk. Phases 1–2 are reversible UX/deletion with no data impact. Phase 6 (backend team-model unification) is last because it needs a data migration. **Each phase is independently shippable and independently revertable** (one feature branch per phase, no phase depends on a later phase).

---

## Phase 0 — Pre-flight (do once, before Phase 1)

Not a change phase; a safety net that every later phase relies on.

- **Establish canonical decisions** (these are the only architectural choices left; make them now so engineers don't decide mid-execution):
  1. Canonical Operations URL: **`/ops/*`** (impl lives there; `/operations→/ops` already exists at `next.config.js:34`). *(Resolves the redirect conflict — Phase 4.)*
  2. Canonical Trust URL: **`/trust`** (marketing page) is the public target; the **authenticated** trust landing is **`/trust-hub`** OR fold trust content under a single authenticated route. Decide before Phase 2 deletes anything trust-related.
  3. Canonical Teams backend: **`/v1/collaboration-teams`** (Phase 6 target).
  4. Product nouns: **Workspace** (Personal | Organization) › **Team** (= today's `CollaborationTeam`) › **Member**. (Phase 3.)
- **Baseline the safety net:**
  - Snapshot the current route inventory: `find apps/web/app -name page.tsx | sort` → commit as `docs/inventory/routes-before.txt`.
  - Run and record the current test baseline: `pnpm -r typecheck`, `pnpm -r test`, `pnpm test:e2e:playwright`. Save output.
  - Confirm the route-persona contract test is green first: `services/api/test/phase-r13-route-persona-matrix.test.ts`.
- **Rollback for the whole program:** each phase = one squash-merge commit → `git revert <sha>` restores prior state; no destructive DB change until Phase 6 (which has its own reversible expand/contract migration).

---

## Phase 1 — Fix persona visibility & onboarding leakage

**Goal:** stop enterprise/ops surface leaking to CORE personas (journalist, individual), and move onboarding out of Settings into a coherent first-run. Pure UX; no deletion.

### Files to modify
| File | Change |
|---|---|
| `apps/web/components/app-shell-v2/AppSidebarV2.tsx` (~line 667) | Pass the active persona into `resolveNavigationGroups(items, { persona })`. Persona is already available via `usePersonaProfile` (imported line 45). This activates the dormant `PERSONA_PILLAR_VISIBILITY` overlay. |
| `apps/web/lib/navigation/navigationGroupingResolver.ts` (99–110) | No logic change — verify `visiblePillarsForPersona(persona)` filters to Cmd-K/Tools (not 404) for hidden pillars, per its own doc comment. |
| `apps/web/lib/navigation/pillarRegistry.ts` (340, `PERSONA_PILLAR_VISIBILITY`) | Audit the 8-pillar × 7-persona map against `docs/persona-aware-ux.md`; correct any row (e.g. JOURNALIST must exclude GOVERN/ADMINISTER). |
| `apps/web/app/(app)/home/page.tsx` (74L) | Add the 3-step first-run checklist (Capture → Verify → Invite/Upgrade) for new personal users; gate on `onboardingCompleted=false`. |
| `apps/web/app/(app)/settings/persona/page.tsx` (505L) | Keep as a settings *toggle*; extract the use-case selector into a reusable component the post-signup step renders. |
| **New (design-only here):** post-signup persona step | A one-screen use-case selector shown once after first login, skippable → defaults `INDIVIDUAL`. PATCHes `WorkspacePersonaProfile.primaryProfile` only (never permissions). |

### Files to delete
None (Phase 1 is additive/wiring).

### Routes affected
All sidebar routes (visibility recomputed per persona); `/home` (checklist); `/settings/persona` (repurposed). No URL changes.

### Risk: **LOW**
Only nav *visibility* and onboarding placement change; capabilities/data are untouched (persona is provably permission-neutral, `workspace-persona.routes.ts:12-14`). Worst case: a route wrongly hidden from a persona — still reachable via Cmd-K/Tools (filter demotes, never 404s).

### Rollback
Revert the `AppSidebarV2.tsx` one-line change → persona filter goes dormant again (current behavior). Revert `home` checklist independently.

### Tests to run
- `services/api/test/phase-r13-route-persona-matrix.test.ts` — extend with persona-**visibility** assertions (currently pins capability/active-space, not pillar visibility).
- `apps/web/lib/navigation/__tests__/*` — unit tests for `resolveNavigationGroups({persona})` per persona.
- Persona-neutrality pins: the tests behind `workspace-persona.routes.ts` / `types.ts:121-128` must still pass (persona grants no capability).
- Playwright: sign in as each persona fixture → assert enterprise pillars absent from sidebar, present in Cmd-K.

### Expected user-facing result
A journalist/individual sees a clean sidebar (Capture/Evidence/Cases/Reports) with **no** governance/ops/enterprise noise; new users get a 3-step home checklist instead of a buried Settings wizard. Enterprise users unchanged.

---

## Phase 2 — Delete proven redirect / stub / byte-identical / orphan pages

**Goal:** remove the ~13 proven-dead surfaces. Every item was proven in the audit (redirect-only, stub-no-API, byte-identical, or orphan-no-nav). **Gated deletes** require a one-command verification first.

### Files to delete (with gate)
| Delete | Lines | Proof | Pre-delete gate |
|---|---|---|---|
| `apps/web/app/(app)/security/trust-center/` (entire dir, 6 files) | ~776 | byte-identical to `trust-center/*` | confirm no `routeRegistry.ts` id points at `/security/trust-center/*`; add 308 → `/trust-hub` (or canonical) |
| `apps/web/app/(app)/teams/page.tsx` | 230 | stub, no API | confirm `admin.teams` registry href = `/workspaces` (not `/teams`); keep `/teams/[id]` for now (Phase 6) |
| `apps/web/app/(app)/governance/page.tsx` | 35 | stub hub, no call | inline `GovernanceControlPlane` as the `/governance` page or redirect to first child |
| `apps/web/app/(app)/reviewer-ops/queue/page.tsx` | 16 | `redirect("/review")` | remove dead `review.queue` registry id |
| `apps/web/app/(app)/settings/security/saml/page.tsx` | 39 | redirect → `/security-center/sso` | add `next.config` 308 for the URL, then delete page |
| `apps/web/app/(app)/inspect/page.tsx` | 662 | orphan: no registry id, no nav, no Cmd-K | grep repo for `/inspect` links; if none, delete |
| `apps/web/app/(app)/verify-references/page.tsx` | 59 | orphan, no registry entry | grep for links; delete |
| `apps/web/app/(app)/intelligence-platform/page.tsx` | 439 | dup `/v1/intelligence/*` domain | **first** fold provider-budget panel into `/intelligence`; then delete |
| `apps/web/app/(app)/trust-hub/page.tsx` **OR** the `/trust` redirect chain | 272 | registry comment says hub relocated to `/trust`, but `/trust` = marketing page | **HARD GATE:** resolve Phase-0 decision #2 first. Do NOT delete until the authenticated trust landing is confirmed to render. |
| `apps/web/app/(app)/operations/{analytics,automation,media-graph,observability,runbooks,batch-analysis,quotas}` (7 shells) | ~10 ea | `export {default} from …` re-exports | **defer to Phase 4** (tied to the /ops↔/operations decision) |

### Files to modify
- `apps/web/lib/navigation/routeRegistry.ts` — remove entries for every deleted route; remove dead ids (`review.queue`, `workspace.intelligence_platform`).
- `apps/web/next.config.js` — add 308 redirects only for externally-shareable URLs being retired (`/settings/security/saml`, `/security/trust-center/*`).
- `apps/web/components/**` — delete now-orphaned components: duplicate trust-center section components under `security/trust-center/`; `intelligence-platform`-only panels after the fold.

### Routes affected
`/security/trust-center/*`, `/teams` (landing only), `/governance` (behavior), `/reviewer-ops/queue`, `/settings/security/saml`, `/inspect`, `/verify-references`, `/intelligence-platform`. All either dead or redirected.

### Risk: **LOW–MEDIUM**
Reversible via git. The only real hazard is deleting a redirect whose target doesn't render (the `/trust` trap) — mitigated by the hard gate. `/collaboration/page.tsx` is **explicitly excluded** from Phase 2 (it hits `/v1/collaboration/threads` — verify the threads feature isn't lost before touching it).

### Rollback
`git revert` the phase commit restores every page + registry entry + redirect. Because deletes are gated on "no inbound links," revert risk is minimal.

### Tests to run
- Full route-render smoke: `node scripts/e2e-web-smoke.mjs` (asserts every registry route 200s).
- `pnpm --filter proovra-web build` (catches broken imports from deleted components).
- Delete/migrate snapshot tests pinned to `navigation-config.ts` and `security/trust-center/*`.
- Playwright: assert retired URLs 308 to a rendering target (no 404 loops); assert `/intelligence` now shows the folded budget panel.

### Expected user-facing result
No visible loss of function. Duplicate trust-center pages gone; SAML settings reachable only at `/security-center/sso`; intelligence budget lives inside `/intelligence`. ~13 dead surfaces removed → app inventory drops from 154 toward ~140.

---

## Phase 3 — Standardize Teams / Workspace / Organization naming

**Goal:** fix the #1 IA debt — the industry-inverted nouns — **at the product-facing (label/copy/route) layer only.** Per the `team-vs-workspace.md` constitution, the **Prisma `Team` model is NOT renamed** (it remains the tenancy backing table). This phase changes *what users see*, not the schema.

### Files to modify
| Layer | Files | Change |
|---|---|---|
| Labels/copy | `apps/web/lib/navigation/routeRegistry.ts`, `canonicalNavigationGroups.ts`, `pillarRegistry.ts` | User-visible label for the tenancy-admin route → "Workspace / Organization" (not "Team"); product-facing "Team" reserved for `/collaboration-teams`. |
| Product noun map | `apps/web/lib/**` copy constants; `packages/ui` labels | "Team" (collaboration) = `CollaborationTeam`; "Workspace" = active space; "Organization" = enterprise grouping. |
| Docs | `docs/architecture/team-vs-workspace.md`, `proovra-domain-model.md` | Add a "product-facing vocabulary" section codifying the mapping; keep the Prisma-model constitution intact. |
| Persona/terminology | `services/api/src/services/platform-context/persona-*`, `packages/shared/src/architecture/canonical-persona.ts` | Terminology projections use the standardized nouns. |

### Files to delete
None in Phase 3 (label-only). (`/teams` landing already deleted in Phase 2.)

### Routes affected
No URL changes (URLs like `/collaboration-teams`, `/workspaces` stay; only labels change). *Optional later:* alias `/collaboration-teams` → `/teams` once the legacy `/teams` backend is retired (Phase 6) — deferred.

### Risk: **MEDIUM** (copy/label churn touches many files; no logic risk)
Pure presentation. Risk is missed strings (inconsistent labels), not breakage.

### Rollback
Revert the label commit. No data/logic touched.

### Tests to run
- `pnpm -r typecheck` (constant renames).
- Snapshot/i18n tests for nav labels.
- Manual/Playwright: assert consistent nouns across sidebar, settings, breadcrumbs.
- Vocabulary-pinning test (`team-vs-workspace.md` Phase-8 vocabulary test) — ensure no new workspace *kinds* introduced (still only PERSONAL/ORGANIZATION).

### Expected user-facing result
Consistent, industry-standard vocabulary: users see **Workspace/Organization** for tenancy and **Team** for collaboration groups — no more three-way "team" confusion.

---

## Phase 4 — Consolidate navigation & route registry

**Goal:** one canonical URL per feature; resolve the `/ops`↔`/operations` redirect conflict; make `routeRegistry.ts` the exact set of live routes (no dead ids, no stale metadata).

### Files to modify
| File | Change |
|---|---|
| `apps/web/next.config.js` | **Resolve the conflict:** line 34 (`/operations→/ops`) vs lines 205–225 (`/ops/*→/operations/*`) contradict. Per Phase-0 decision #1, make **`/ops/*` canonical**: keep `/operations→/ops`, change lines 205–225 to redirect `/operations/*→/ops/*` (not the reverse), removing the loop. |
| `apps/web/app/(app)/operations/{analytics,automation,media-graph,observability,runbooks,batch-analysis,quotas}/page.tsx` (7 shells) | **Delete** the re-export shells; their impls already live at `ops/*` + `dashboard/*`. |
| `apps/web/app/(app)/operations/{exports,queues,recovery,reliability,signers}/page.tsx` | These have **no `/ops` twin** — **move** them under `/ops/*` (or keep `/operations/*` for these five and make ONLY these the canonical exceptions — document the choice). |
| `apps/web/lib/navigation/routeRegistry.ts` | Point every ops sidebar id at the canonical `/ops/*`; remove stale metadata (`dashboard.batch-analysis`/`dashboard.quotas` marked "page does not exist" though pages exist); remove `review.queue`, `workspace.intelligence_platform`. |
| `apps/web/lib/navigation-config.ts` | **Delete** after migrating the legacy tests that still import it (`NAVIGATION_GROUPS`, `ACCOUNT_MENU_ITEMS`, `DEPRECATED_ROUTE_REDIRECTS`). |

### Files to delete
- 7 `operations/*` re-export shells (above).
- `apps/web/lib/navigation-config.ts` (after test migration).
- Dead `futurePersonaTags` block and unused `CAPABILITY_KEYS` (~15 dead: `PERSONAL_*`/`ORG_*`, `platform-context/types.ts:277-305`, `capability-registry.ts:332-384`).

### Routes affected
`/operations/*` (consolidated to `/ops/*`), `/dashboard/{batch-analysis,quotas}` (already redirect). URL canonicalization only; redirects preserve external links.

### Risk: **MEDIUM**
Redirect edits can create loops — the whole point is to **remove** the existing loop, so test redirect chains explicitly. Moving the five real `/operations/*` impls is the only code-move risk.

### Rollback
Revert `next.config.js` + registry commit. Keep the impl moves in a separate commit so they can revert independently.

### Tests to run
- Redirect-chain test: assert `/operations`, `/operations/analytics`, `/ops/analytics` all resolve to exactly one 200 with no loop.
- `node scripts/e2e-web-smoke.mjs` (every registry route 200s).
- Nav drift test (the one that fails if a shell imports `navigation-config.ts`).
- `pnpm --filter proovra-web build`.

### Expected user-facing result
One URL per operations feature; no redirect loops; the registry exactly matches the live route set. Inventory drops to ~130. Nothing visibly moves for users (redirects cover old links).

---

## Phase 5 — Enterprise progressive disclosure by plan / persona / role

**Goal:** enforce the Phase-D capability matrix consistently — every route's `tier`/`requiredCapabilities`/`directAccessPolicy` matches the plan matrix, so CORE never sees ENTERPRISE and vice-versa. This is an **audit-and-align** phase (Phase 1 wired persona *visibility*; this aligns *entitlement*).

### Files to modify
| File | Change |
|---|---|
| `apps/web/lib/navigation/routeRegistry.ts` | For each route, verify `tier` ∈ {CORE, PROFESSIONAL, ENTERPRISE, INTERNAL} matches the Phase-D matrix (e.g. governance/lifecycle/identity = ENTERPRISE; investigation/review = PROFESSIONAL; capture/evidence = CORE). Fix mismatches. |
| `apps/web/lib/surface/tiers.ts`, `access.ts` | Confirm ENTERPRISE unlock rule (`isEnterpriseWorkspace`/`plan==="ENTERPRISE"`/platform-admin) is the sole gate; verify `directAccessPolicy` (`notFound` for governance-platform, `redirect` for evidence-lifecycle) is set for every enterprise route so direct hits don't leak. |
| `packages/shared-billing/src/plan-catalog.ts` | No change (source of truth) — used to generate the expected matrix for the contract test. |
| `services/api/src/middleware/require-enterprise-feature.ts` | Confirm each enterprise route's API is 402-gated by the matching `enterpriseFeatures.*` flag (belt-and-suspenders: nav hides it, API enforces it). |

### Files to delete
None (alignment phase).

### Routes affected
All gated routes (tier/capability metadata verified). No URL changes.

### Risk: **MEDIUM**
Over-hiding could block a legitimately-entitled user; under-hiding leaks enterprise UI (cosmetic — API still 402s). Mitigate with the contract test below (fail-closed comparison against `plan-catalog.ts`).

### Rollback
Revert the registry `tier` changes; API gates are unchanged so security posture never regresses.

### Tests to run
- **Extend `phase-r13-route-persona-matrix.test.ts`** to assert `registry.tier` == expected tier derived from `plan-catalog.ts` for all 8 personas × plans (the doc already declares "if a row disagrees with the registry, the registry is wrong").
- API gate tests: each enterprise endpoint returns 402 `ENTERPRISE_FEATURE_REQUIRED` for non-enterprise scope (`billing-enforcement.service.ts`).
- Playwright per plan fixture (FREE/PRO/TEAM/ENTERPRISE): assert visible/hidden/upgrade-CTA route sets match the matrix.

### Expected user-facing result
Each plan sees exactly its entitled surface: FREE = capture/evidence/reports (+3-evidence cap, upgrade CTAs); PRO/TEAM = collaboration + investigation/review; ENTERPRISE = governance/lifecycle/identity/org. Consistent, no leaks, clean product-led-growth upgrade prompts.

---

## Phase 6 — Backend migration: `/v1/teams` → `/v1/collaboration-teams`

**Goal:** retire the parallel legacy team stack. **Highest risk, done last, with a reversible expand/contract data migration.** This is a backend program, not a UI change.

### Scope (proven parallel stacks)
- Legacy: `services/api/src/routes/teams.routes.ts` (2626L, `/v1/teams/*`), the Prisma `Team`/`TeamMember` product surface, and `team-management.routes.ts` (925L — an **in-memory, non-Prisma** org stub).
- New: `services/api/src/routes/collaboration-teams.routes.ts` (1046L, `/v1/collaboration-teams/*`), `CollaborationTeam*` models.
- **Nuance (must preserve):** the Prisma `Team` model is ALSO the **tenancy/billing/workspace** backing table — it is NOT deletable. Only the **product-facing "team-as-collaboration-group"** responsibilities of `/v1/teams` migrate to `/v1/collaboration-teams`; the tenancy role stays on `Team` (renamed conceptually to "Workspace" per Phase 3).

### Sub-steps (expand → migrate → contract)
1. **Expand:** ensure `/v1/collaboration-teams` covers every capability `/v1/teams` exposes as a collaboration group (members, invites, roles, assignments, activity). Gap-fill.
2. **Dual-write / backfill:** migrate existing `TeamMember`-as-collaboration rows into `CollaborationTeamMember` (data migration, reversible — keep source rows).
3. **Redirect frontend:** point `/teams/[id]` UI + any `/v1/teams` client calls at `/v1/collaboration-teams`; keep `/v1/teams` responding (deprecated) during bake.
4. **Retire `team-management.routes.ts`:** route `/v1/organizations/*` to the real Organization service (finish or freeze Organization — Phase C open item).
5. **Contract:** after a bake period with zero `/v1/teams` collaboration traffic, delete `teams.routes.ts` collaboration endpoints and `/teams/[id]` page.

### Files to modify / delete (staged)
| Stage | Files |
|---|---|
| Expand | `collaboration-teams.routes.ts`, `services/api/src/services/collaboration-team/*` |
| Migrate | new Prisma migration (`CollaborationTeamMember` backfill); `services/api/src/services/collaboration/*` |
| Redirect | `apps/web/app/(app)/teams/[id]/page.tsx` → call new API or redirect to `/collaboration-teams/[teamId]` |
| Retire | **delete** `services/api/src/routes/team-management.routes.ts` (in-memory stub); **delete** `/v1/teams` collaboration endpoints in `teams.routes.ts`; **delete** `apps/web/app/(app)/teams/[id]/page.tsx` |

### Routes affected
`/v1/teams/*` (deprecated → removed), `/v1/organizations/*` (stub → real service), `/teams/[id]` (→ `/collaboration-teams/[teamId]`).

### Risk: **HIGH**
Data migration + two live backends. Tenancy `Team` role must be untouched. Billing (`Team.billingPlan`, seats) must not regress — the `team-vs-workspace.md` constitution forbids touching billing/Stripe code.

### Rollback
Expand/contract makes each stage reversible: keep `/v1/teams` live until contract; the backfill preserves source rows so the migration is `down`-able. If contract fails, re-point the frontend to `/v1/teams` (still present) and revert.

### Tests to run
- `services/api/test/*collaboration-team*` + `*team*` suites; add parity tests asserting `/v1/collaboration-teams` == `/v1/teams` behavior for every migrated capability.
- Data-migration test on a staging DB snapshot (backfill correctness + reversibility).
- The Phase-5/6 collaboration-team pins (`team-vs-workspace.md` references Phase 5/6 tests) must stay green.
- Billing regression: seat limits, plan capacity (`billing-enforcement.service.ts`) unchanged.

### Expected user-facing result
A single Teams product on one backend; the legacy `/teams/[id]` and in-memory org stub gone. No user-visible feature loss; tenancy/billing unchanged.

---

## Program-level summary

| Phase | Theme | Risk | Reversible | Inventory after | Ship gate |
|---|---|---|---|---|---|
| 0 | Pre-flight decisions + baseline | — | — | 154 | decisions recorded, tests green |
| 1 | Persona visibility + onboarding | LOW | yes (1-line) | 154 | persona matrix test extended, green |
| 2 | Delete dead pages | LOW–MED | yes (git) | ~140 | smoke + build green, redirect gates pass |
| 3 | Noun standardization | MED | yes (labels) | ~140 | vocabulary test green |
| 4 | Nav/registry consolidation | MED | yes | ~130 | no redirect loops, smoke green |
| 5 | Progressive disclosure | MED | yes | ~130 | matrix contract test green per plan |
| 6 | Team backend unification | HIGH | staged expand/contract | ~128 | parity + migration-reversibility tests |

**Critical gates that must not be skipped:**
1. **Phase 2 trust gate** — do not delete `trust-hub`/trust redirects until the authenticated trust landing is confirmed to render (`/trust` currently = marketing page; no `app/(app)/trust/page.tsx`).
2. **Phase 4 redirect-loop gate** — the `/ops`↔`/operations` conflict must be removed, not duplicated.
3. **Phase 6 tenancy gate** — the Prisma `Team` model stays (it backs workspace/billing); only its collaboration-group responsibilities migrate. Never touch billing code (constitution).

**What this delivers:** a product that reads as designed-from-day-one — one canonical route set, one vocabulary, persona-clean navigation, plan-consistent disclosure, and a single team backend — achieved through **finish-the-migration consolidation**, not redesign, with every step independently revertable.
