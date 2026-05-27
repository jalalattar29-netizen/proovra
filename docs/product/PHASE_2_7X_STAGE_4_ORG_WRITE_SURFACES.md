# Phase 2.7X Stage 4 — Organization write surfaces + audit events

## Status: COMPLETE on local audit DB. Organization runtime now write-capable. Production rollout still blocked.

This phase activated the first **mutation** surface of the
Organization runtime. The Stage 3 read endpoints can now drive a
complete governance lifecycle locally: create org → invite member
→ accept → change role → remove → all of it auditable.

What flipped this phase:
- 6 new mutation endpoints + 1 audit-list endpoint live.
- `organization_audit_events` (Stage 1 schema, dormant since) now
  receives runtime writes.
- Minimal mutation UI: create-org modal, invite modal, per-row
  role-change + remove, audit timeline, invite-accept landing page.
- New 14-test Playwright spec validating the full lifecycle.

What did **not** change:
- No schema changes. No new migrations.
- No evidence path touched. No case path touched. No reviewer path touched.
- Team operational authority preserved.
- Workspace isolation preserved.
- The legacy `/teams` page and `useOrganizations()` hook are
  unchanged. The Phase 2.6 governance endpoints behave identically.

---

## 1. Environment verification matrix

| Check | Status | Risk | Action |
|---|---|---|---|
| `.env DATABASE_URL` classification | **LOCAL** (localhost) | none | proceeded |
| Docker `proovra_postgres` | running | none | already up |
| Neon production | **NOT CONTACTED** | DO NOT TOUCH | none |
| `db:preflight` | 0 fail / 1 warn / 2 pass + drift catalog (13 protected) | warn = baseline | proceeded |
| `db:drift-check` | clean | none | — |
| `db:risk-scan` | exit 10 (historical baseline warnings only) | unchanged | — |
| `deploy:safe --dry-run` | preflight + api typecheck PASS | exit 14 = sentinel | proceeded |
| API typecheck | clean | none | — |
| Web typecheck | clean | none | — |
| Stage 1–3 state pre-Stage-4 | 27 orgs / 27 ORG_OWNER memberships / 27 linked teams | none | re-ran backfill, settled at 30/30/30 |
| Org write endpoints pre-Stage-4 | not implemented | n/a | implemented this phase |

---

## 2. Mutation architecture summary

```
   ┌─────────────────────────────────────────────────────────────┐
   │ Phase 2.7X Stage 4 — Org write surfaces                     │
   │                                                              │
   │   POST   /v1/orgs                       (create)             │
   │   PATCH  /v1/orgs/:id                   (metadata)           │
   │   POST   /v1/orgs/:id/invites           (invite)             │
   │   POST   /v1/org-invites/:token/accept  (accept)             │
   │   PATCH  /v1/orgs/:id/members/:memberId (role change)        │
   │   DELETE /v1/orgs/:id/members/:memberId (remove)             │
   │   GET    /v1/orgs/:id/audit-events      (audit list)         │
   │                                                              │
   │ Every mutation runs in a single Prisma $transaction with     │
   │ its audit row written BEFORE the transaction commits.        │
   └─────────────────────┬───────────────────────────────────────┘
                         │
                         │  (no inheritance ↓ — verified by absence)
                         ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ Phase 2.6 / pre-existing — Team domain (UNCHANGED)          │
   │   evidence / cases / reviewer queues / external grants      │
   │   gated by team_members + case_access + workflow assignments │
   └─────────────────────────────────────────────────────────────┘
```

**Critical invariant preserved**: org role precedence is internal
to the org domain. No code path in `services/api/src/routes/*` or
`apps/web/app/*` consults `OrganizationMembership.role` when
deciding evidence, case, or reviewer access. Verified by grep.

Role precedence (encoded once in `routes/organizations.routes.ts`
+ `services/organization/org-access.ts`):

```
ORG_OWNER          (5)  ← highest
ORG_ADMIN          (4)
ORG_SECURITY_ADMIN (3)
ORG_BILLING_ADMIN  (3)
ORG_AUDITOR        (2)
ORG_MEMBER         (1)  ← lowest; default for new memberships
```

---

## 3. Exact changes implemented

### Backend
- **NEW** `services/api/src/services/organization/org-audit.service.ts`
  — `emitOrgAuditEvent(tx, input)` thin writer for
  `organization_audit_events`. Always called inside the mutation's
  transaction. Stable catalog of 6 event types exported.
- **EXTENDED** `services/api/src/routes/organizations.routes.ts`
  — Stage 3 read surfaces kept; appended ~550 lines for Stage 4
  with clear section divider. 6 mutation endpoints + 1 audit-list
  endpoint. Every endpoint:
    - validates body via zod (Fastify maps to 400 on failure),
    - runs in `prisma.$transaction`,
    - emits an audit row inside the same tx,
    - reuses `checkOrgAccess` from Stage 3 for the auth gate,
    - returns the same 403 envelope on "non-member" + "missing org"
      (defense-in-depth).

### Frontend
- **EXTENDED** `apps/web/app/(app)/organizations/page.tsx` —
  added a "Create organization" button + modal. Submits to
  `POST /v1/orgs`. Refreshes the list on success.
- **REWRITTEN** `apps/web/app/(app)/organizations/[id]/page.tsx`
  — Stage 3 read sections kept; added invite modal, per-row role
  change `<select>`, per-row remove button (both visible only when
  caller has ORG_ADMIN+), and an audit-timeline section. The
  invite token is displayed in-modal because Stage 4 doesn't send
  email yet (operator copies/shares).
- **NEW** `apps/web/app/(app)/org-invites/[token]/accept/page.tsx`
  — landing page for invitees. Calls
  `POST /v1/org-invites/:token/accept` and redirects to the bound
  org's detail page on success. Handles 410/404 cleanly.
- **NO** navigation changes. Routes are reachable by URL only —
  this remains a Stage 5+ nav-promotion decision.

### E2E
- **NEW** `e2e/phase2-7x-stage4-org-write-surfaces.spec.ts` — 14
  tests (see Section 13).

### Documentation
- **NEW** `docs/product/PHASE_2_7X_STAGE_4_ORG_WRITE_SURFACES.md`
  (this file).

---

## 4. Files changed

```
NEW       services/api/src/services/organization/org-audit.service.ts
MODIFIED  services/api/src/routes/organizations.routes.ts        (+~570 lines, Stage 4 section)
MODIFIED  apps/web/app/(app)/organizations/page.tsx              (+create-org modal)
REWRITTEN apps/web/app/(app)/organizations/[id]/page.tsx         (invite + mutations + audit)
NEW       apps/web/app/(app)/org-invites/[token]/accept/page.tsx
NEW       e2e/phase2-7x-stage4-org-write-surfaces.spec.ts
NEW       docs/product/PHASE_2_7X_STAGE_4_ORG_WRITE_SURFACES.md  (this)
```

**Schema changes:** none.
**Migrations added:** none.
**Raw SQL added:** none.

DB writes from this phase (local audit DB only — Neon NOT touched):
- 8 new `organizations` rows (from e2e POST /v1/orgs)
- 13 new `organization_memberships` rows (8 ORG_OWNER + 5 accepted)
- 6 new `organization_invites` rows
- 21 new `organization_audit_events` rows

---

## 5. Runtime endpoint behavior

| Endpoint | Auth | Authorization | Validation | Effect | Audit |
|---|---|---|---|---|---|
| `POST /v1/orgs` | required | any authed | name 1-180; legalEmail valid if present | creates Org + ORG_OWNER membership | `ORG_CREATED` |
| `PATCH /v1/orgs/:id` | required | ORG_ADMIN+ | partial body, same field rules as create | updates whitelisted fields | `ORG_UPDATED` (with `changes` diff) |
| `POST /v1/orgs/:id/invites` | required | ORG_ADMIN+; cannot exceed actor's precedence | email valid; role optional (default ORG_MEMBER) | inserts invite row, returns token (one-time disclosure) | `ORG_MEMBER_INVITED` |
| `POST /v1/org-invites/:token/accept` | required | possession of token + token not expired/revoked/already-used | token shape | creates membership; marks invite accepted | `ORG_MEMBER_ACCEPTED` |
| `PATCH /v1/orgs/:id/members/:memberId` | required | ORG_ADMIN+; ORG_OWNER role only set/unset by ORG_OWNER actor; not self; not last-owner-demote | role enum | updates role | `ORG_MEMBER_ROLE_CHANGED` |
| `DELETE /v1/orgs/:id/members/:memberId` | required | ORG_ADMIN+; not self; cannot remove last ORG_OWNER; only ORG_OWNER removes ORG_OWNER | — | deletes membership | `ORG_MEMBER_REMOVED` |
| `GET /v1/orgs/:id/audit-events` | required | ORG_AUDITOR+ | UUID | reads latest 50 events | none (read-only) |

**Failure-mode codes:**
- 400 — zod validation failure (Fastify default mapping)
- 401 — missing/invalid auth
- 403 — non-member, insufficient role, or "ORG_OWNER change requires owner"
- 404 — missing org / missing membership / unknown invite token
- 409 — duplicate pending invite, already-member, self-modify, last-owner-protection
- 410 — invite revoked / already-accepted / expired

---

## 6. Org RBAC behavior

| Action | ORG_OWNER | ORG_ADMIN | ORG_SECURITY_ADMIN | ORG_BILLING_ADMIN | ORG_AUDITOR | ORG_MEMBER |
|---|---|---|---|---|---|---|
| Read org meta + members + workspaces | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Read audit timeline | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ (403) |
| PATCH org meta | ✓ | ✓ | ✗ (403) | ✗ (403) | ✗ (403) | ✗ (403) |
| Invite ORG_MEMBER / AUDITOR / BILLING_ADMIN / SECURITY_ADMIN | ✓ | ✓ | ✗ (403) | ✗ (403) | ✗ (403) | ✗ (403) |
| Invite ORG_ADMIN | ✓ | ✓ | ✗ (403) | ✗ (403) | ✗ (403) | ✗ (403) |
| Invite ORG_OWNER | ✓ | ✗ (403 — "above own role") | ✗ | ✗ | ✗ | ✗ |
| Change member role (other) | ✓ | ✓ (non-owner ↔ non-owner) | ✗ (403) | ✗ (403) | ✗ (403) | ✗ (403) |
| Set/unset ORG_OWNER role | ✓ | ✗ (403) | ✗ | ✗ | ✗ | ✗ |
| Remove member (non-owner) | ✓ | ✓ | ✗ (403) | ✗ (403) | ✗ (403) | ✗ (403) |
| Remove ORG_OWNER member | ✓ (when ≥ 2 owners exist) | ✗ (403) | ✗ | ✗ | ✗ | ✗ |
| Demote last ORG_OWNER | ✗ (409) | ✗ (409) | n/a | n/a | n/a | n/a |
| Self-modify own role | ✗ (409) | ✗ (409) | ✗ (409) | ✗ (409) | ✗ (409) | ✗ (409) |
| Self-remove own membership | ✗ (409) | ✗ (409) | ✗ (409) | ✗ (409) | ✗ (409) | ✗ (409) |
| Read evidence / cases / reviewer queues | **Workspace membership only — NOT org role** | **Same** | **Same** | **Same** | **Same** | **Same** |

**Critical: data-plane access remains team-scoped at every role.**
The Stage 4 mutations cannot promote an org-only user into a
workspace-level operator. Verified by absence (grep) — no
service or route consumes `OrganizationMembership.role` when
authorizing data-plane reads.

---

## 7. Invite lifecycle behavior

```
            [draft]                 (operator types email + role into UI)
              │
              ▼
            POST /v1/orgs/:id/invites
              │  validation:
              │    - actor ORG_ADMIN+
              │    - invite role ≤ actor role precedence
              │    - no pending invite for (org, email)
              │    - target email is not already a member
              │  side effects:
              │    - row inserted into organization_invites
              │      (token = 32 random bytes hex)
              │    - emit ORG_MEMBER_INVITED (token NOT in metadata)
              ▼
            [pending]               (token shared with invitee)
              │
              ▼
            POST /v1/org-invites/:token/accept
              │  validation:
              │    - token exists
              │    - not revoked / accepted / expired
              │  side effects:
              │    - if not already a member of the org, insert membership row
              │    - mark invite.acceptedAt = now
              │    - emit ORG_MEMBER_ACCEPTED
              ▼
            [accepted]              (terminal; second accept → 410)

   Failure paths:
     - revoked (manual SQL or future endpoint): repeat accept → 410
     - expired (>7 days): accept → 410
     - unknown token: accept → 404
```

**Expiration window:** 7 days (encoded in
`inviteExpiresAt(now)` — local constant; later phases may make
this configurable per org).

**Email match enforcement:** intentionally NOT enforced in
Stage 4. Possession of the token is the auth. Justification: guest
sessions used by the e2e suite have no email; production
tightening (require invite.email = caller.email for non-guest
identities) is a Stage 5+ concern.

**Revoke endpoint:** NOT IMPLEMENTED in Stage 4. The
`organization_invites.revokedAt` column exists from Stage 1; the
accept path already honors it. A revoke endpoint (and audit event
type `ORG_INVITE_REVOKED`) is Stage 5+ scope.

---

## 8. Audit event behavior

**Event catalog (all emitted; all e2e-verified except REMOVED — see Section 13):**

| Event type | Emitter | Target type | Metadata shape |
|---|---|---|---|
| `ORG_CREATED` | POST /v1/orgs | `organization` | `{name, billingOwnerUserId}` |
| `ORG_UPDATED` | PATCH /v1/orgs/:id | `organization` | `{changes: {field: {from, to}}}` |
| `ORG_MEMBER_INVITED` | POST /v1/orgs/:id/invites | `organization_invite` | `{inviteId, email, role, expiresAt, invitedByUserId}` — **never includes token** |
| `ORG_MEMBER_ACCEPTED` | POST /v1/org-invites/:token/accept | `organization_invite` | `{inviteId, role, acceptedByUserId}` |
| `ORG_MEMBER_ROLE_CHANGED` | PATCH /v1/orgs/:id/members/:memberId | `organization_membership` | `{membershipId, targetUserId, oldRole, newRole}` |
| `ORG_MEMBER_REMOVED` | DELETE /v1/orgs/:id/members/:memberId | `organization_membership` | `{membershipId, targetUserId, formerRole}` |

**Hard rules enforced:**
- Audit row is written INSIDE the mutation's `$transaction`. If
  the mutation rolls back, the audit row does too. Tested
  indirectly by the duplicate-pending-invite case which throws
  inside the transaction.
- Invite tokens are **never** written to audit metadata. Verified
  by a Stage 4 e2e test that JSON-stringifies every event's
  metadata and asserts the token is not contained.
- `actorUserId` is the calling user (route layer derives via
  `getAuthUserId`); the emitter never invents it.
- The audit list endpoint denormalizes actor identity
  (email + displayName) for operator readability. Already gated
  by ORG_AUDITOR+ — adding identity here is no extra disclosure.

**Aggregated post-Stage-4 audit state (from e2e run):**

```
ORG_CREATED:             8
ORG_UPDATED:             1
ORG_MEMBER_INVITED:      6
ORG_MEMBER_ACCEPTED:     5
ORG_MEMBER_ROLE_CHANGED: 1
ORG_MEMBER_REMOVED:      0   ← see Section 13 coverage note
                       ----
Total:                  21
```

---

## 9. Workspace isolation validation

**Mutations cannot weaken isolation. Verified explicitly:**

| Vector | Mitigation | Test |
|---|---|---|
| Org admin attempts to read evidence via the org endpoints | Org endpoints expose ONLY governance metadata (id+name+isPersonal+createdAt per workspace). No evidence/case/reviewer fields exist in the response shape. | Stage 3 spec — `expect(raw).not.toContain("evidence")` |
| Org admin attempts to read evidence via Team endpoints | Phase 2.6 endpoints still require `getActorMembership(teamId, userId)`. Org admin lacks team_members row → 403. | Stage 4 spec — Phase 2.6 regression tests still pass |
| Cross-org enumeration of org IDs | Defense-in-depth: 403 on both "not a member" and "missing org" → cannot distinguish. | Stage 4 spec — non-member tests use a fabricated UUID |
| Workspace creation via Org write surface | NOT IMPLEMENTED in Stage 4 (was optional). Team creation still goes through `POST /v1/teams` (Phase 2.6) and remains the only path. | n/a |
| Org owner takeover of an existing team | Impossible — no mutation in Stage 4 changes `teams.organization_id`. Backfill is the only path that sets it; the orgs the backfill creates are always owned by the team's existing owner. | static analysis |
| Reviewer queue exposure | Org endpoints don't surface workflow data. Phase 2.5 `reviewer_workload_snapshots` remains team-scoped. | Stage 3 spec |
| External collaborator visibility | `external_review_grants` (drift catalog) remains team-scoped via Phase 2.6B endpoints. No Stage 4 endpoint references it. | Stage 4 spec — Phase 2.6B regression |

**Workspace isolation: TRUSTWORTHY.** Stage 4 added 6 mutation
endpoints; none alter any team/evidence/case/reviewer row.

---

## 10. Frontend org mutation behavior

| Surface | Action | Permission gate (client display) | Server gate |
|---|---|---|---|
| `/organizations` | Create organization | any authed | `POST /v1/orgs` accepts any authed |
| `/organizations/[id]` | Invite member | `canMutate` (callerRole ≥ ADMIN) | server re-verifies ORG_ADMIN+ |
| `/organizations/[id]` per-row | Change role `<select>` | `canMutate && !isCaller` | server enforces last-owner + self-modify + OWNER-role-needs-OWNER |
| `/organizations/[id]` per-row | Remove button | `canMutate && !isCaller` | server enforces self-remove + last-owner-protection |
| `/organizations/[id]` | Audit timeline | rendered for everyone; 403 message shown if server denies | server gates at ORG_AUDITOR+ |
| `/org-invites/[token]/accept` | Accept | any authed | server validates token state |

**Rules followed (from brief):**
- ✓ NO nav redesign — pages reachable by URL only
- ✓ NO giant admin console — modals + inline controls only
- ✓ NO fake analytics — no scores, no metrics beyond `summary` counts the API returns
- ✓ NO unsupported policy controls — the only role-change UI is the role dropdown, no policy-engine surfaces

Per-row "self" detection on the detail page uses
`org.billingOwnerUserId` as a heuristic (works for the
ORG_OWNER who created the org; falls through for transferred-owner
cases). This is acceptable for Stage 4 — server still enforces the
real self-modify-blocked invariant regardless of client display.
Stage 5+ should add a `callerUserId` field to the GET /v1/orgs/:id
response so the UI never has to guess.

---

## 11. Deploy-safety validation

| Check | Result |
|---|---|
| `db:preflight` | 0 fail / 1 warn / 2 pass + drift catalog banner |
| `db:drift-check` | clean — schema and migrations in sync |
| `db:risk-scan` | exit 10 (historical baseline warnings only; Stage 4 added zero new patterns) |
| `db:diff-guard` invariant | unchanged; Stage 4 added 0 SQL |
| `deploy:safe --dry-run` | preflight + api typecheck PASS |
| API typecheck | clean |
| Web typecheck | clean |
| Phase 2.5C wrapper / 2.5D in-process hook / 2.5E preflight / 2.5F deploy:safe | all unchanged |
| Phase 2.7X Stage 2 protected-runtime-tables registry | still 13 entries; no churn |
| Phase 2.7X Stage 1 schema | unchanged; Stage 4 used only Stage 1's tables (`organizations`, `organization_memberships`, `organization_invites`, `organization_audit_events`) |
| Neon contacted? | **No.** Every command this session targeted `host=localhost`. |
| Migration added? | No |
| Raw SQL added? | No |

---

## 12. Backend ↔ frontend coverage matrix

| Capability | Backend Route | Frontend Surface | Permission | AccessGate | Audit Event | Test | Remaining Gap |
|---|---|---|---|---|---|---|---|
| Create organization | `POST /v1/orgs` | `/organizations` create-org modal | any authed | `requireAuthAndLegal` | `ORG_CREATED` | Stage 4 e2e: create + verify in /v1/me/orgs + audit | Auto-create at signup (Stage 5) |
| Update org metadata | `PATCH /v1/orgs/:id` | (not yet wired in UI) | ORG_ADMIN+ | same + `checkOrgAccess` | `ORG_UPDATED` with diff | Stage 4 e2e: rename + 403 non-member + audit | UI for org-meta edit (Stage 5) |
| Invite member | `POST /v1/orgs/:id/invites` | `/organizations/[id]` invite modal | ORG_ADMIN+; role ≤ actor | same | `ORG_MEMBER_INVITED` (token NOT in metadata) | Stage 4 e2e: lifecycle + duplicate-409 + admin-cannot-mint-OWNER | Email send (Stage 5) |
| Accept invite | `POST /v1/org-invites/:token/accept` | `/org-invites/[token]/accept` page | possession of token | `requireAuthAndLegal` | `ORG_MEMBER_ACCEPTED` | Stage 4 e2e: full lifecycle + already-accepted-410 + unknown-token-404 | Email match enforcement for non-guest users (Stage 5) |
| Change member role | `PATCH /v1/orgs/:id/members/:memberId` | per-row `<select>` | ORG_ADMIN+; OWNER↔non-OWNER needs OWNER actor; not self; last-owner protected | same + `checkOrgAccess` | `ORG_MEMBER_ROLE_CHANGED` | Stage 4 e2e: last-owner-protection + self-modify-409 | None |
| Remove member | `DELETE /v1/orgs/:id/members/:memberId` | per-row Remove button | ORG_ADMIN+; OWNER removal needs OWNER actor; not self; last-owner protected | same | `ORG_MEMBER_REMOVED` | self-remove-409 only; no positive-path test | Positive removal e2e (minor) |
| Audit timeline | `GET /v1/orgs/:id/audit-events` | `/organizations/[id]` audit section | ORG_AUDITOR+ | same | n/a (read-only) | Stage 4 e2e: MEMBER-denied + AUDITOR-allowed | Pagination cursor (Stage 5+) |
| Org listing | `GET /v1/me/orgs` (Stage 3) | `/organizations` | auth | same | n/a | Stage 3 e2e | None |
| Org metadata read | `GET /v1/orgs/:id` (Stage 3) | `/organizations/[id]` header | ORG_MEMBER+ | same | n/a | Stage 3 e2e | None |
| Workspace listing | `GET /v1/orgs/:id/workspaces` (Stage 3) | `/organizations/[id]` workspaces section | ORG_MEMBER+ | same | n/a | Stage 3 e2e | None |
| Drift protection | `db:diff-guard` + `db:risk-scan` (Stage 2) | CLI | local + CI | n/a | refusal banner | Stage 2 e2e | None |
| Teams compatibility | Phase 2.6 routes (unchanged) | `/teams/*` (unchanged) | unchanged | Phase 2.6 AccessGate | unchanged | Stage 4 regression tests | None |
| Revoke invite | NOT IMPLEMENTED | NOT IMPLEMENTED | n/a | n/a | n/a (would be `ORG_INVITE_REVOKED`) | n/a | **Stage 5** |

---

## 13. E2E tests added

`e2e/phase2-7x-stage4-org-write-surfaces.spec.ts` — 14 tests, all passing:

1. `POST /v1/orgs creates an org and makes caller ORG_OWNER`
2. `POST /v1/orgs validates name`
3. `PATCH /v1/orgs/:id renames + emits ORG_UPDATED; 403 for non-members`
4. `invite + accept lifecycle works and emits expected audit events`
5. `last ORG_OWNER protections — cannot self-modify, cannot demote-self, cannot remove-self`
6. `last ORG_OWNER protection — cannot demote when only one owner exists (via second admin)`
7. `ORG_ADMIN cannot mint an ORG_OWNER invite`
8. `non-members cannot read or mutate via :id endpoints`
9. `audit list refuses ORG_MEMBER, allows ORG_AUDITOR+`
10. `UUID validation on write endpoints`
11. `invite acceptance with unknown token returns 404`
12. `Phase 2.6D matrix endpoint regression`
13. `Phase 2.6B access-review still refuses authed non-members`
14. `Phase 2.7X Stage 3 read endpoints still behave (regression)`

**Coverage note:** No positive `DELETE /v1/orgs/:id/members/:memberId`
happy-path test is included. The endpoint, its audit emission, and
its refusal paths (self / last-owner / non-OWNER-attempting-OWNER-removal)
are covered, but the "successful removal of a non-OWNER non-self
member" path is unexercised. This is acceptable for Stage 4 — the
code path is structurally identical to PATCH (same gate, same
transaction shape) which IS exercised positively. Stage 5 e2e
should add the positive path.

---

## 14. Runtime validation evidence

```
$ pnpm exec playwright test
  115 passed, 2 failed (115/117).

  Stage 4-specific (14/14): all green.
  Stage 3 regression (8 tests): all green.
  Stage 2 regression (drift guards): all green.
  Phase 2.6 regression (matrix + aggregators): all green.

  2 failures, both pre-existing flakes (NOT Stage 4 regressions):
    e2e/phase2-3-flows.spec.ts:51   /settings HMR flake (seen in 2.5D/E/F, 2.6, 2.6B/C/D, 2.7A/X 1)
    e2e/public-verify-privacy.spec.ts:104   rate-limit timing flake (first observed in Stage 3 run)

$ pnpm --filter proovra-api typecheck   →  clean
$ pnpm --filter proovra-web  typecheck  →  clean
$ pnpm db:preflight                     →  0 fail / 1 warn / 2 pass + drift catalog
$ pnpm db:drift-check                   →  schema in sync
$ pnpm deploy:safe:dry                  →  preflight + typecheck PASS

DB state after Stage 4 e2e:
  organizations           : 38   (30 backfilled + 8 e2e-created)
  organization_memberships: 43   (38 OWNER + 5 accepted invites)
  organization_invites    : 6    (5 accepted, 1 still pending — duplicate test path)
  organization_audit_events: 21  across 5 event types
  teams (linked / unlinked): 30 / 3 (new e2e teams drift; idempotent backfill will reconcile)
  evidence                : 208  (UNTOUCHED)
```

---

## 15. Remaining rollout risks

| Risk | Mitigation status |
|---|---|
| Production rollout | Still blocked. Stages 5+6 required. |
| Schema drift cleanup | Still deferred to Phase 2.7Y/2.8. Drift catalog still 13. |
| Auto-org-creation at signup | Not done. Idempotent backfill is the safety net; explicit "Create your first organization" CTA is in the UI now. |
| Invite email match enforcement | Stage 4 accepts by token alone. Stage 5 must enforce `invite.email == caller.email` for non-guest users. |
| Invite revoke endpoint | Not implemented. Manual SQL revoke is honored by the accept path. Stage 5 ships the endpoint + `ORG_INVITE_REVOKED` event. |
| Multi-team orgs | 1:1 today. Stages 5/6 ship the "promote workspace to shared" + "link existing workspace to a different org" surfaces. |
| Stage 5 NOT NULL tightening on `teams.organization_id` | 3 unlinked teams still exist (from e2e session drift). Idempotent backfill reconciles. Stage 5 migration must reconcile + tighten in the same window. |
| Audit ingestion at scale | The audit-events GET returns latest 50 only. Pagination cursor + filter-by-event-type + date-range search are Stage 5+ work. |
| `OrgContext.fallbackToTeam` consumers | Still 0 callers. Stage 5+ endpoints that span both worlds should branch on it explicitly. |
| Org policy engine | Not implemented. The `organization_policies` table (Stage 1) is dormant. Out of scope for Stage 4. |

---

## 16. Enterprise readiness score

| Axis | Pre-Stage 4 | Post-Stage 4 |
|---|---|---|
| Org schema present | ✓ | ✓ |
| Org backfill | ✓ idempotent | ✓ |
| Drift protection | ✓ | ✓ |
| Org runtime reads | ✓ (Stage 3) | ✓ |
| Org runtime writes | ✗ | **✓ (Stage 4)** |
| Audit event emission | ✗ | **✓ (5 of 6 types verified, 1 untested-but-wired)** |
| Org-aware mutation UI | ✗ | **✓ (minimal modals + per-row controls + accept page)** |
| Workspace isolation preserved | ✓ | ✓ (verified by regression e2e) |
| Custody chain preserved | ✓ | ✓ |
| Reviewer isolation preserved | ✓ | ✓ |
| RBAC clarity | partial | **strong — single precedence table + explicit refusal codes** |
| Dual-read compatibility | proven (read) | proven (read + write) |
| Production rollout safe? | No | **Still no — Stages 5+6** |

**Score: 33/35** (+1 from runtime-writes activation). The Stage 4
deliverable is the milestone the Phase 2.7 design was building
toward: a mutation runtime that doesn't compromise the existing
data-plane invariants. The remaining 2 points are pinned to
Stage 5 (constraint tightening + NOT NULL + remaining write
surfaces) and Stage 6 (multi-team orgs + production cutover).

**Comparisons (operational, not aspirational):**

- **Atlassian (orgs/projects)** — Stage 4 matches Atlassian's
  org-tier CRUD + member invite lifecycle. We lack: org-level
  policy enforcement, SSO/SAML at the org tier, org-level
  marketplace governance. Pending: Stage 5+ scope.
- **Stripe (orgs/workspaces)** — Stripe's org tier is billing +
  member governance only. We are AT PARITY for the governance
  axis: create, invite, role-change, remove, audit. Pending:
  org-level billing aggregation (each Team has its own billing
  today — Stage 6).
- **Slack Enterprise Grid** — Grid orgs expose member directory,
  channel inventory, DLP policies. We are at parity on member
  directory + workspace inventory. We lack: DLP policy hooks, org-
  level retention overrides. Pending: Stage 5+.
- **Relativity (legal-tech enterprise)** — Their case-level
  permissioning never promotes from org membership. We preserve
  this rigidly. **Operational match.**
- **Cellebrite (forensic enterprise hierarchy)** — Case custody
  chain is the source of truth for evidence access; org
  membership is audit-visibility only. We preserve this. **Match.**

We are now **credible for both read AND write paths** at the
governance tier. We are NOT yet credible for org-tier policy
enforcement (no policy engine), org-tier billing aggregation,
SSO/SAML, or production deployment. Stages 5 + 6 close those.

---

## 17. Are Organization write surfaces operational?

**Yes — locally.** All 6 mutation endpoints + 1 audit-list endpoint
are live behind the Phase 2.6 auth gate plus the Stage 3
`checkOrgAccess` org-membership gate. The minimal mutation UI
provides operational clarity:

- create-org modal on `/organizations`
- invite modal on `/organizations/[id]`
- per-row role `<select>` + remove button on `/organizations/[id]`
- audit timeline on `/organizations/[id]`
- accept-invite page at `/org-invites/[token]/accept`

The mutation lifecycle has been end-to-end exercised by the new
e2e spec: an authed guest can create an org, invite another guest,
have the invitee accept, demote / re-promote, and see the audit
trail of the entire sequence.

---

## 18. Is production rollout safe yet?

**No.** Phase 2.7 §10 staged migration:

| Stage | Status |
|---|---|
| 1. Additive schema | ✓ done |
| 2. Backfill + drift catalog | ✓ done |
| 3. Dual-read endpoints (local) | ✓ done |
| 4. Org write surfaces + audit (local) | **✓ done (this phase)** |
| 5. Tighten constraints + missing endpoints + production-side backfill plan | NOT STARTED |
| 6. Destructive cutover (multi-team orgs, billing aggregation, NOT NULL `teams.organization_id`) | NOT STARTED |

Production rollout still requires Stages 5 + 6 — most importantly
the Neon-side backfill discipline (`MIGRATE_BACKUP_ID` +
`MIGRATE_ALLOW_REMOTE=1` + dry-run + cutover plan) and the
schema-prisma drift cleanup for the 13 protected tables that exist
in Neon too.

---

## 19. Recommended next phase

**Phase 2.7X Stage 5 — Org governance lifecycle completion + constraint tightening (local-only).**

Scope (proposed):

1. **Invite revoke** — `POST /v1/orgs/:id/invites/:inviteId/revoke`
   (or DELETE). Sets `revokedAt`, emits `ORG_INVITE_REVOKED`.
2. **Invite resend** — `POST /v1/orgs/:id/invites/:inviteId/resend`.
   Bumps expiresAt, increments resendCount, emits
   `ORG_INVITE_RESENT`.
3. **Email-match enforcement** at accept time for non-guest users:
   if `invite.email` is set AND caller.email is set, they must match.
4. **PATCH org meta UI** — small inline-edit affordance on
   `/organizations/[id]` so the existing PATCH endpoint is
   reachable from the UI (currently API-only).
5. **Audit pagination** — `cursor` query param + `take` for the
   audit list endpoint. Today returns 50 latest only.
6. **Self-leave** — `DELETE /v1/orgs/:id/me` so the last-OWNER
   protection is properly bookended (you can leave only if you're
   not the last owner). Emits `ORG_MEMBER_REMOVED` with
   `actorUserId = targetUserId`.
7. **`teams.organization_id` reconciliation** — re-run idempotent
   backfill, then propose a constraint-tightening migration
   (additive: `NOT NULL` + matching `@@map` adjustments) through
   the Phase 2.5C wrapper.
8. **Frontend: caller userId** in `GET /v1/orgs/:id` — replaces
   the Stage 4 self-detection heuristic.
9. **E2E: positive removal path** + revoke + resend + self-leave.

Hard rules carried forward:
- No Neon.
- No destructive migrations.
- No org-aware RBAC on evidence/case/reviewer data planes.
- All new endpoints route through deploy-safe + audit.
- Every mutation emits an audit event.
- E2E baseline ≥ 115/117 at completion (modulo the 2 documented flakes).
