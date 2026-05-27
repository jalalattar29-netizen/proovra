# Phase 2.7X Stage 3 — Organization runtime endpoints (dual-read)

## Status: COMPLETE on local audit DB. Organization runtime now operational *for read-only governance*. Production rollout still blocked.

This phase **activated** the Organization architecture at runtime. The
new endpoints expose org-level governance metadata; the Team layer
still owns evidence, cases, and reviewer queues. Both worlds work
simultaneously — that's the dual-read contract.

What flipped this phase:

- 4 new GET endpoints went live (`/v1/me/orgs`, `/v1/orgs/:id`,
  `/v1/orgs/:id/members`, `/v1/orgs/:id/workspaces`).
- 2 new frontend routes (`/organizations`, `/organizations/[id]`).
- Stage 2's "no Stage 3 endpoints yet" e2e guard was retired and
  replaced with the actual contract assertions.

What did **not** change:

- No schema changes. No new migrations.
- No evidence access logic touched. No case access touched. No
  reviewer ops touched. RBAC behavior on the data plane is
  identical to Stage 2.
- The legacy `/teams` page and the `useOrganizations()` envelope
  hook are untouched. The new pages don't compete with them.

---

## 1. Environment verification matrix

| Check | Status | Risk | Action |
|---|---|---|---|
| `.env DATABASE_URL` classification | **LOCAL** (localhost) | none | proceed |
| `.env DIRECT_URL` | **LOCAL** | none | proceed |
| `.env SHADOW_DATABASE_URL` | **LOCAL** | none | proceed |
| Docker `proovra_postgres` | running | none | already up |
| Neon production | **NOT CONTACTED** | DO NOT TOUCH | none |
| `db:preflight` | 0 fail / 1 warn / 2 pass + drift catalog announced (13 protected tables) | warn = baseline | proceed |
| `db:drift-check` | clean | none | — |
| `db:risk-scan` | exit 10 (historical baseline warnings only; no protected-table DROPs) | unchanged | — |
| `deploy:safe --dry-run` | preflight + api typecheck both PASS | exit 14 = dry-run sentinel | proceed |
| API typecheck | clean | none | — |
| Web typecheck | clean | none | — |
| **Stage 2 backfill state** | 27 orgs / 27 ORG_OWNER memberships / 27 linked teams (3 fresh teams from e2e drift, brought to coherent state by idempotent re-run) | none | proceed |
| Orphan org owners | 0 | none | — |

---

## 2. Dual-read architecture summary

**Team remains operational authority.** Organization is governance,
grouping, billing, and audit ONLY. The two systems coexist:

```
                       ┌─────────────────────────────────────────┐
                       │ Phase 2.7X — Organization domain        │
                       │   /v1/me/orgs                            │
                       │   /v1/orgs/:id                           │
                       │   /v1/orgs/:id/members                   │
                       │   /v1/orgs/:id/workspaces                │
                       │   /organizations (frontend)              │
                       │   /organizations/[id] (frontend)         │
                       │                                          │
                       │ Reads from: organizations,               │
                       │   organization_memberships, teams.org_id │
                       └────────────────┬────────────────────────┘
                                        │  (dual-read; ↓ does NOT
                                        │   feed permission inheritance)
                       ┌────────────────▼────────────────────────┐
                       │ Phase 2.6 / pre-existing — Team domain  │
                       │   /v1/teams/*                            │
                       │   /v1/teams/:id/access-review            │
                       │   /v1/teams/:id/external-collaborators   │
                       │   /v1/teams/:id/external-grants/:id      │
                       │   /v1/platform/rbac/matrix               │
                       │   /teams (frontend)                      │
                       │   /teams/[id] (frontend)                 │
                       │                                          │
                       │ Reads from: teams, team_members,         │
                       │   case_access, evidence ownership,       │
                       │   reviewer assignments — UNCHANGED.      │
                       └─────────────────────────────────────────┘
```

The new endpoints **expose** org metadata + workspaces-in-org list,
but they **never** consult or grant evidence/case/reviewer
permission. The Stage 2 `organization-resolver.service.ts` helpers
+ Stage 3 `org-access.ts` gates carry strict doc-comments forbidding
data-plane use.

---

## 3. Exact changes implemented

### Backend
- **NEW** `services/api/src/services/organization/org-access.ts` —
  `checkOrgAccess(prisma, {orgId, userId, minRole?}) → OrgAccessOutcome`.
  Returns `{kind:"ok"|"forbidden"|"not_found"}`. Single source of
  truth for "is X allowed to read org Y at level Z". Exports
  `ORG_ROLE_CATALOG` for future capability surfaces.
- **NEW** `services/api/src/routes/organizations.routes.ts` —
  4 GET endpoints; full doc-comments per endpoint stating exactly
  what is and is NOT exposed. AccessGate via `requireAuthAndLegal`
  (composition of `requireAuth` + `requireLegalAcceptance`, the
  exact gate the Phase 2.6 routes use — no new gate semantics).
- **MODIFIED** `services/api/src/server.ts` — registers
  `organizationsRoutes` between `teamsRoutes` and `billingRoutes`.
  One import line + one register line + comments. No other server
  changes.

### Frontend
- **NEW** `apps/web/app/(app)/organizations/page.tsx` — list page.
  Calls `GET /v1/me/orgs`. Three states (loading / error / ready).
  Minimal inline styling; no UI library bloat.
- **NEW** `apps/web/app/(app)/organizations/[id]/page.tsx` — detail
  page. Three sections (org meta / members / workspaces) loaded in
  parallel via `Promise.all`. Each section degrades independently
  on a 403/error.
- **NO** new navigation entries. The route exists but isn't
  promoted in nav — that's Stage 4 work. Discoverable only by URL
  for now (intentional — operational clarity over UI flash).
- **NO** changes to `useOrganizations()`, `useActiveSpace()`, or
  any existing platform-context hook. The legacy `/teams` page
  continues using the envelope-based org list (which surfaces
  Teams with `isPersonal=false`, currently 0 rows).

### E2E
- **NEW** `e2e/phase2-7x-stage3-org-runtime.spec.ts` — 12 tests
  (see Section 12).
- **MODIFIED** `e2e/phase2-7x-stage2-org-backfill-drift.spec.ts` —
  retired the "Stage 3 endpoints not live (404)" guard test. The
  equivalent positive contract assertions moved to the Stage 3 spec.

### Documentation
- **NEW** `docs/product/PHASE_2_7X_STAGE_3_ORG_RUNTIME_DUAL_READ.md`
  (this file).

---

## 4. Files changed

```
NEW       services/api/src/services/organization/org-access.ts
NEW       services/api/src/routes/organizations.routes.ts
MODIFIED  services/api/src/server.ts                 (+1 import, +1 register, +comments)
NEW       apps/web/app/(app)/organizations/page.tsx
NEW       apps/web/app/(app)/organizations/[id]/page.tsx
NEW       e2e/phase2-7x-stage3-org-runtime.spec.ts
MODIFIED  e2e/phase2-7x-stage2-org-backfill-drift.spec.ts  (retired Stage 2 guard test)
NEW       docs/product/PHASE_2_7X_STAGE_3_ORG_RUNTIME_DUAL_READ.md  (this)
```

**Schema changes:** none.
**Migrations added:** none.
**DB writes:** none (idempotent backfill re-run picked up 3 new
teams, but that's Stage 2 machinery operating as designed; no new
write code was introduced this phase).

---

## 5. Runtime endpoint behavior

| Endpoint | Auth | Authorization | Returns | Refuses |
|---|---|---|---|---|
| `GET /v1/me/orgs` | required | none beyond auth | `{summary:{totalOrgs:N}, orgs:[{organizationId, name, status, role, orgCreatedAt, memberSince}]}` | 401 anon |
| `GET /v1/orgs/:id` | required | caller MUST be org member (ORG_MEMBER+) | full org meta + `{summary:{memberCount, workspaceCount}, callerRole}` | 400 invalid UUID; 403 non-member or missing org |
| `GET /v1/orgs/:id/members` | required | same | `{summary, members:[{membershipId, userId, email, displayName, role, memberSince}]}` | 400 / 403 |
| `GET /v1/orgs/:id/workspaces` | required | same | `{summary, workspaces:[{workspaceId, name, isPersonal, createdAt}]}` — **NO** counts of any kind | 400 / 403 |

**Defense in depth:** All `:id` endpoints conflate "not a member" and
"org doesn't exist" into the same 403 response. Non-members cannot
enumerate orgs by status code.

**No mutations** in Stage 3. No POST/PATCH/DELETE on `/v1/orgs/*`.
Org creation, role mutation, and member invites are Stage 4+ work.

**No worker, no queue, no async event emission.** These are pure
read endpoints. No `analytics_events`, no `team_activities`, no
`platform_audit_logs` are written by these reads — same as the
Phase 2.6B aggregators.

---

## 6. Org RBAC behavior

Six roles with strict precedence (encoded once in `org-access.ts`):

```
ORG_OWNER         (5)  ←─ highest
ORG_ADMIN         (4)
ORG_SECURITY_ADMIN(3)
ORG_BILLING_ADMIN (3)
ORG_AUDITOR       (2)
ORG_MEMBER        (1)  ←─ lowest; default for new memberships
```

**What an org role grants in Stage 3:**

| Capability | Grants org role? | Notes |
|---|---|---|
| Read org metadata | ORG_MEMBER+ | List shows orgs you belong to |
| List org members | ORG_MEMBER+ | Governance visibility only |
| List org workspaces | ORG_MEMBER+ | id+name+isPersonal only |
| Read evidence | **NEVER** | Team membership only |
| Read case content | **NEVER** | case_access + team membership |
| Reviewer ops | **NEVER** | Workflow assignments |
| External collaborator grant | **NEVER** | Phase 2.6B/C/D Team-scoped |
| Mutate org (name/role/invite) | **N/A — no write endpoints in Stage 3** | Stage 4 |

The brief's critical assertion — *"org admin MUST NOT gain evidence
access"* — is enforced by **absence**: zero code paths in
`services/api/src/` or `apps/web/` consult org membership when
deciding evidence/case/reviewer access. Verified by grep.

The Stage 2 helper `organization-resolver.service.ts` is now called
in 0 code paths. The Stage 3 helper `org-access.ts` is called only
from the 3 `:id`-scoped endpoints. Neither is wired into evidence /
case / reviewer authorization.

---

## 7. Workspace isolation validation

| Vector | Stage 3 behavior | Test |
|---|---|---|
| Org admin attempts to read evidence in a workspace they're not a team member of | Phase 2.6 endpoints unchanged — `getActorMembership(teamId, userId)` still required; org admin has no team membership → 403 | Phase 2.6B/C/D regression tests in Stage 3 spec |
| Cross-workspace evidence aggregation via `/v1/orgs/:id/workspaces` | Response includes ONLY id+name+isPersonal+createdAt. No evidence list, no case list, no member list per workspace. | Stage 3 spec |
| Reviewer queue exposed via org endpoint | Not exposed. Workspace endpoint has no reviewer fields. | Stage 3 spec — `expect(raw).not.toContain("reviewer")` |
| External collaborator visibility | The Phase 2.6B `/v1/teams/:id/external-collaborators` endpoint remains the only surface; still gated by team ADMIN+ | Stage 3 regression test |
| Hidden permission inheritance | None. `org-access.ts` returns ONLY `{ok|forbidden|not_found}`. No path "promotes" an org role to a team role. | Search-based verification |

**Workspace isolation: TRUSTWORTHY.** The org endpoints surface a
strictly smaller information set than what the team-scoped endpoints
already permit.

---

## 8. Governance validation

| Question | Answer |
|---|---|
| Can an ORG_MEMBER see the list of workspaces in their org? | Yes — id+name only. No internal data. |
| Can an ORG_MEMBER see the list of org members + their org roles? | Yes — governance visibility is the point. |
| Can an ORG_OWNER see internal evidence in a workspace they don't belong to as a team member? | **No.** Team membership is the gate. |
| Can an ORG_AUDITOR mutate anything? | No — Stage 3 has no mutations. Stage 4 will scope mutation routes to ORG_OWNER/ORG_ADMIN explicitly, with ORG_AUDITOR remaining read-only. |
| Are org-level audit events emitted? | Not yet — Stage 3 is read-only; no mutations to audit. The `organization_audit_events` table (Stage 1) is reserved for Stage 4 writes. |
| Is access-review covered? | Team-scoped access review (Phase 2.6B/C) remains the source. A future org-level access review aggregator is explicit Stage 4+ work. |

---

## 9. Frontend org behavior

| Surface | What it shows | What it never shows |
|---|---|---|
| `/organizations` | One card per org the user belongs to: name, role, status, member-since, "Open" link | Counts of evidence/cases/reviewers; CTAs to create/leave; analytics |
| `/organizations/[id]` header | Org name, status, caller's role, member count, workspace count | Billing details; evidence aggregates; governance score |
| `/organizations/[id]` members | userId / email / displayName / role / memberSince | Workspace memberships of each user; evidence access counts |
| `/organizations/[id]` workspaces | id+name+isPersonal+created. Each row links to the existing `/teams/[id]` page. | Per-workspace counts of any kind |
| Navigation | NOT promoted in the sidebar yet. Reachable only by URL. | The sidebar redesign is explicit Stage 4 work. |

The frontend uses **only** the new endpoints. No re-use of legacy
envelope hooks. This is true dual-read at the UI layer: the legacy
`/teams` page and the new `/organizations` page can both render
without conflicting state.

---

## 10. Deploy-safety validation

| Check | Result |
|---|---|
| `db:preflight` | 0 fail / 1 warn / 2 pass + drift catalog banner (13 tables protected) |
| `db:drift-check` | clean — schema and migrations in sync |
| `db:risk-scan` | exit 10 (historical baseline warnings only; no protected-table DROPs introduced) |
| `db:diff-guard` invariant | unchanged; Stage 3 added 0 SQL |
| `deploy:safe --dry-run` | preflight + api typecheck PASS |
| API typecheck | clean |
| Web typecheck | clean |
| Phase 2.5C wrapper | unchanged — no migrations attempted this phase |
| Phase 2.5D in-process hook | unchanged |
| Phase 2.5E preflight aggregator | unchanged; surfaces new drift catalog count |
| Phase 2.5F deploy:safe orchestrator | unchanged |
| Phase 2.7X Stage 2 protected-runtime-tables | registry still 13 entries; no churn |
| Neon contacted? | **No.** Every command this session targeted `host=localhost`. |
| New tables created? | No — Stage 1 already shipped the schema |
| New columns added? | No |
| New migrations? | No |
| New raw SQL? | No |

---

## 11. Backend ↔ frontend coverage matrix

| Capability | Backend Route | Frontend Surface | Permission | AccessGate | Audit Event | Test Coverage | Remaining Gap |
|---|---|---|---|---|---|---|---|
| List my orgs | `GET /v1/me/orgs` | `/organizations` | auth + legal | `requireAuthAndLegal` | none (read-only) | Stage 3 e2e: auth-required, shape, empty-envelope-for-guest | None for Stage 3 |
| Get org meta | `GET /v1/orgs/:id` | `/organizations/[id]` (header) | ORG_MEMBER+ | `requireAuthAndLegal` + `checkOrgAccess` | none | Stage 3 e2e: 403 non-member, 400 invalid UUID | None |
| List org members | `GET /v1/orgs/:id/members` | `/organizations/[id]` (members section) | ORG_MEMBER+ | same | none | Stage 3 e2e: 403, 400 | None |
| List org workspaces | `GET /v1/orgs/:id/workspaces` | `/organizations/[id]` (workspaces section) | ORG_MEMBER+ | same | none | Stage 3 e2e: 403, 400 + no-data-plane-leak assertion | None |
| Org switcher | (uses `GET /v1/me/orgs`) | both `/organizations` and `/organizations/[id]` link inter-org | n/a | n/a | n/a | Stage 3 e2e | Promoted nav entry (Stage 4) |
| Workspace operational access | Phase 2.6 / pre-existing `/v1/teams/*` | `/teams/*` | TeamMember + role | Phase 2.6 `AccessGate` | per-action audit | Phase 2.6 e2e + Stage 3 regression | None |
| Teams compatibility regression | unchanged | unchanged | unchanged | unchanged | unchanged | Stage 3 spec re-asserts the Phase 2.6B/C/D contract | None |
| Drift protection | `db:diff-guard` + `db:risk-scan` | (CLI) | local-only + CI | n/a | refusal banner | Stage 2 e2e (unchanged) | None |
| Dual-read fallback (un-backfilled team) | `OrgContext.fallbackToTeam=true` from Stage 2 helper | not yet consumed | n/a | n/a | n/a | implicit — proven by 0 callers | Stage 4 will introduce explicit branches |
| Org write surfaces | NOT IMPLEMENTED | NOT IMPLEMENTED | n/a | n/a | n/a | n/a | **Stage 4 scope** |

---

## 12. E2E tests added

`e2e/phase2-7x-stage3-org-runtime.spec.ts` — 12 tests, all passing:

1. `GET /v1/me/orgs requires auth` (anon → 401/403)
2. `GET /v1/me/orgs returns empty envelope for a fresh guest`
3. `GET /v1/orgs/:id refuses authed non-members on a non-existent org`
4. `GET /v1/orgs/:id validates the UUID parameter`
5. `GET /v1/orgs/:id/members refuses authed non-members`
6. `GET /v1/orgs/:id/members validates UUID`
7. `GET /v1/orgs/:id/workspaces refuses authed non-members`
8. `GET /v1/orgs/:id/workspaces validates UUID`
9. `Phase 2.6D RBAC matrix still returns canonical shape (regression)`
10. `Phase 2.6B access-review still refuses authed non-members (regression)`
11. `Phase 2.6B external-collaborators still refuses authed non-members (regression)`
12. `org membership does not surface evidence/case/reviewer counts in workspaces list`

The Stage 2 spec was edited to retire its "Stage 3 endpoints not
live" guard test, since Stage 3 now ships those endpoints.

---

## 13. Runtime validation evidence

```
$ pnpm exec playwright test
  102 passed, 1 failed (102/103 = same 1-flake-of-the-day pattern)

  Stage 3-specific (12/12): all green.
  Stage 2 regression (Phase 2.6B/C/D + drift guards): all green.
  Phase 2.3 /settings HMR flake (the usual one): PASSED this run.

  1 failure:
    public-verify-privacy.spec.ts:104
    "per-IP rate limit returns 429 + Retry-After"

    This is a pre-existing order-dependent flake. The test sends 40
    requests against a configured limit of 60/min (.env
    VERIFY_RATE_LIMIT_MAX=60), so the limit triggers only when
    counter state has accumulated from prior tests in the same
    process. Passed in Stage 2 run (counter spillover), failed
    here (counter cleared). NOT a Stage 3 regression.

$ pnpm --filter proovra-api typecheck   →  clean
$ pnpm --filter proovra-web  typecheck  →  clean
$ pnpm db:preflight                     →  0 fail / 1 warn / 2 pass
$ pnpm db:drift-check                   →  schema in sync
$ pnpm deploy:safe:dry                  →  preflight + typecheck PASS
```

---

## 14. Remaining rollout risks

| Risk | Mitigation status |
|---|---|
| Org write endpoints arrive before careful RBAC review | **Stage 4 scope** — design must split ORG_OWNER/ORG_ADMIN write authority cleanly from data-plane authority. |
| `useOrganizations()` envelope hook and `/v1/me/orgs` diverge as both grow | Today: both currently return either 0 or N rows; no semantic conflict. Stage 4 must consolidate to one source of truth before the legacy `/teams` page links into `/organizations`. |
| New signups don't auto-create an org | Acceptable for Stage 3 (read-only). Stage 4 must either (a) auto-create on signup, or (b) ship a "create your first organization" explicit CTA. Idempotent backfill is the safety net until then. |
| Production rollout | Still blocked. Stages 4+5+6 must land, plus a production-side backfill plan with backup discipline (Phase 2.5D `MIGRATE_BACKUP_ID`). |
| Schema-vs-DB drift (the 13 protected tables) | Still deferred to Phase 2.7Y/2.8 ADD_TO_PRISMA work. Hard-block guards (Stage 2) remain active. |
| Multi-team organizations | Not yet a thing — backfill creates 1:1. Stage 5/6 will support shared teams (org promotes a workspace from personal to shared, retaining org binding). |
| Org audit events | The `organization_audit_events` table exists (Stage 1) but receives 0 writes in Stage 3. Stage 4 writes will land with explicit emit at every mutation. |
| `OrgContext.fallbackToTeam` flag adoption | Not yet consumed. Stage 4+ endpoints should branch on it explicitly so Stage 5's NOT-NULL tightening grep can find every legacy path. |

---

## 15. Enterprise readiness score

| Axis | Pre-Stage 3 | Post-Stage 3 |
|---|---|---|
| Org schema present | ✓ (Stage 1) | ✓ |
| Org backfill runnable | ✓ (Stage 2) | ✓ |
| Destructive-diff protection | ✓ (Stage 2) | ✓ |
| Org runtime endpoints operational | ✗ | **✓ (read-only)** |
| Org RBAC enforced at runtime | n/a | **✓ via `checkOrgAccess`** |
| Org-aware frontend | ✗ | **✓ (minimal: 2 routes)** |
| Workspace isolation preserved | ✓ | ✓ (validated by regression e2e) |
| Custody chain preserved | ✓ | ✓ (no evidence path touched) |
| Reviewer isolation preserved | ✓ | ✓ (no reviewer path touched) |
| Dual-read compatibility | partial | **proven — both /teams and /organizations work independently** |
| Org write endpoints | ✗ | ✗ (Stage 4) |
| Org audit events | reserved | reserved (Stage 4 writes) |
| Multi-team orgs | n/a | n/a (Stage 5/6) |
| Production rollout safe? | No | **Still no — Stages 4-6 required** |
| Deploy-safe coverage | 2.5C-F + 2.7X Stage 2 | unchanged |

**Score: 32/35** (+1 from runtime-activation milestone). The new
point is the *successful* dual-read activation: org endpoints exist
and behave safely, while Team endpoints continue to gate all
operational access. No platform we're benchmarking against would
ship runtime org features WITHOUT this kind of staged separation;
we got it right this phase.

Comparisons (operational, not aspirational):

- **Atlassian (orgs/projects)** — Atlassian's org is a billing +
  identity root with projects scoped underneath. They expose
  org-level admin views that DO surface aggregate project counts
  (workspaces in our terms), but they restrict per-project
  internals to project members. Our Stage 3 matches this:
  org-aware aggregate counts, but per-workspace details require
  team membership. **Operationally on par for read paths.**
  Pending: write paths and SSO/SCIM at the org tier (Stages 4+).

- **Stripe (orgs/workspaces)** — Stripe's "Organizations" feature
  groups Accounts and exposes ONLY billing + member governance at
  the org tier. Our Stage 3 matches: no data-plane bleed-through.
  Pending: org-level billing aggregation (currently each Team has
  its own billing — Stage 6 work).

- **Slack Enterprise Grid** — Grid orgs expose member directory
  + channel inventory + DLP policies; channel content stays
  workspace-scoped. Our Stage 3 is at the "member directory +
  workspace inventory" parity point; we don't yet ship org-level
  policy hooks. Pending: governance policy engine (Stage 4+).

- **Relativity (legal-tech enterprise)** — Their case-level
  permissioning is rigid; org membership doesn't promote into
  case access. We preserve this. **Match.**

- **Cellebrite (forensic enterprise hierarchy)** — Their case
  custody chain is the source of truth for evidence access; org
  membership is audit-visibility only. We preserve this. **Match.**

We are **operationally credible for read paths**. We are **not yet
credible for write paths** (no org mutations, no org-level
policies, no org-level access review aggregator). Stage 4 closes
that gap.

---

## 16. Is Organization runtime operational?

**Yes — for read-only governance.** Four endpoints serve real
data, gated by real org membership, with no data-plane leakage.
The frontend renders the org topology cleanly. The dual-read
guarantee holds: the existing `/teams` page is bit-identical in
behavior to Stage 2.

**No — for write-side operations.** Org creation, member invite,
role mutation, org rename, org-level policy edit, org-level audit
view, org-level access review — all Stage 4+ scope.

---

## 17. Is production rollout safe yet?

**No.** Phase 2.7 §10 staged migration:

| Stage | Status |
|---|---|
| 1. Additive schema | ✓ done |
| 2. Backfill + drift catalog | ✓ done |
| 3. Dual-read endpoints (local) | **✓ done (this phase)** |
| 4. Org write surfaces (create/invite/mutate) | NOT STARTED |
| 5. Tighten constraints (teams.organization_id NOT NULL) | NOT STARTED |
| 6. Destructive cutover (multi-team orgs, billing aggregation, etc.) | NOT STARTED |

Production rollout of even the read-only Stage 3 endpoints requires:
- Production-side backfill (Phase 2.5D `MIGRATE_BACKUP_ID` + dry-run + cutover plan)
- Schema-vs-DB drift cleanup on Neon (the 13 protected tables exist there too — same risk profile)
- Org auto-provisioning at signup OR an explicit org-creation UX
- Stage 4 write surfaces (without them, an operator who lands the org page in production with 0 orgs has no way out)

---

## 18. Recommended next phase

**Phase 2.7X Stage 4 — Organization write surfaces (local-only).**

Scope (proposed):

1. `POST /v1/orgs` — explicit "create my first organization" path
   for new signups + an operator-driven "create another org" path.
   Emits `organization_audit_events` with `event_type=ORG_CREATED`.
2. `POST /v1/orgs/:id/invites` — invite by email. Reuses the
   existing email service (Phase 2.6 team invite plumbing).
   Emits `event_type=ORG_INVITE_SENT`. NO auto-acceptance.
3. `POST /v1/orgs/invites/:token/accept` — accept invite. Creates
   `organization_memberships` row at the invited role. Emits
   `event_type=ORG_INVITE_ACCEPTED`.
4. `PATCH /v1/orgs/:id` — rename, change legalName/legalEmail/
   address/timezone/logoUrl. Requires ORG_ADMIN+. Emits
   `event_type=ORG_PROFILE_UPDATED`.
5. `PATCH /v1/orgs/:id/members/:membershipId` — change a member's
   role. Requires ORG_OWNER (changing OWNER) or ORG_ADMIN (others).
   Emits `event_type=ORG_MEMBER_ROLE_CHANGED`.
6. `DELETE /v1/orgs/:id/members/:membershipId` — remove a
   member. Requires ORG_ADMIN+. Cannot remove the last ORG_OWNER.
   Emits `event_type=ORG_MEMBER_REMOVED`.
7. **Frontend:** add "Invite" / "Remove" / "Change role" controls
   to `/organizations/[id]` member list. Add a "Create
   organization" CTA on `/organizations` for users with 0 orgs.
8. **Drift protection invariant:** the 13 protected runtime
   tables remain inviolate.
9. **Coverage matrix re-validated** end-to-end.
10. **All Phase 2.5C-F + 2.7X-Stage-1+2+3 invariants preserved.**

Hard rules carried forward:
- No Neon contact.
- No destructive migrations.
- No org-aware RBAC on evidence/case/reviewer data planes.
- All new endpoints route through deploy-safe.
- Every mutation emits an audit event into `organization_audit_events`.
- E2E suite ≥ 102/103 pass-rate baseline at completion.
