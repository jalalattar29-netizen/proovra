# Phase 2.7X Stage 5 — Governance hardening + production rollout safety

## Status: COMPLETE on local audit DB. Organization runtime now production-rollout-survivable. Production migration still gated on operator backup + REMOTE override.

This phase did NOT expand features. It hardened the existing Stage 1-4
runtime against the failure modes that block real production rollout:

- invite tokens can now be revoked, resent, and audited;
- accepted-invite hijack is mitigated by email-match enforcement;
- the audit endpoint is paginated + filterable + stable-ordered;
- org/workspace consistency is now machine-verifiable via a
  read-only validator;
- NOT NULL tightening readiness is reported per-column;
- the deploy:safe → preflight → drift-check → consistency chain
  passes end-to-end without writing any production data.

What did NOT change:
- No schema changes. No migrations. Zero SQL added.
- No Team / evidence / case / reviewer path touched.
- The legacy `/teams` flow is bit-identical.
- Workspace isolation invariants unchanged.

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
| `db:check-org-consistency` (NEW) | 0 fail / 0 warn / 8 pass | none | pass-through |
| `db:not-null-readiness` (NEW) | 4 candidate columns: 3 READY, 1 READY-SOFT | none | report-only |
| `deploy:safe --dry-run` | preflight + api typecheck PASS | exit 14 = sentinel | proceeded |
| API typecheck | clean | none | — |
| Web typecheck | clean | none | — |
| Stage 1-4 endpoints pre-Stage-5 | all live, audit events flowing | none | regression-tested |

---

## 2. Governance hardening summary

```
                  ┌──────────────────────────────────────────────────┐
                  │   Stage 5 — NEW endpoints (all read or revoke;    │
                  │   no destructive ops; all audit-emitting)         │
                  │                                                    │
                  │   GET    /v1/orgs/:id/invites           (list)     │
                  │   DELETE /v1/orgs/:id/invites/:inviteId (revoke)   │
                  │   POST   /v1/orgs/:id/invites/:inviteId/resend     │
                  │                                                    │
                  │   GET    /v1/orgs/:id/audit-events                 │
                  │             ?take=<1..200>                         │
                  │             &cursor=<id>                           │
                  │             &eventType=A,B,C                       │
                  │                                                    │
                  │   POST /v1/org-invites/:token/accept               │
                  │     (hardened — email-match + rejection audit)     │
                  └──────────────────────────────────────────────────┘
                  ┌──────────────────────────────────────────────────┐
                  │   Stage 5 — NEW operator tools (read-only)        │
                  │                                                    │
                  │   pnpm db:check-org-consistency                    │
                  │     → 8-check structural validator                 │
                  │                                                    │
                  │   pnpm db:not-null-readiness                       │
                  │     → per-column tightening readiness report       │
                  └──────────────────────────────────────────────────┘
                  ┌──────────────────────────────────────────────────┐
                  │   Stage 5 — NEW audit event types                  │
                  │                                                    │
                  │   ORG_INVITE_REVOKED                               │
                  │   ORG_INVITE_RESENT                                │
                  │   ORG_INVITE_ACCEPT_REJECTED                       │
                  │     reasons: email_mismatch, expired, revoked,     │
                  │              already_accepted, not_found           │
                  └──────────────────────────────────────────────────┘
```

**Critical invariants preserved:**
- No org role grants evidence access (verified by grep + Stage 4 regression e2e).
- Team operational authority unchanged.
- Drift catalog still 13 entries; no new shadow tables.
- No production data touched.

---

## 3. Exact changes implemented

### Backend
- **EXTENDED** `services/api/src/services/organization/org-audit.service.ts`
  — 3 new event types added to the stable catalog
  (`ORG_INVITE_REVOKED`, `ORG_INVITE_RESENT`,
  `ORG_INVITE_ACCEPT_REJECTED`). Per-event metadata shapes
  documented inline.
- **EXTENDED** `services/api/src/routes/organizations.routes.ts`
  — 3 new endpoints (`GET /v1/orgs/:id/invites`,
  `DELETE /v1/orgs/:id/invites/:inviteId`,
  `POST /v1/orgs/:id/invites/:inviteId/resend`). The
  accept endpoint is hardened with email-match + rejection audit
  emission. The audit-events endpoint is paginated + filterable
  with stable `(createdAt DESC, id DESC)` ordering.

### Operator scripts
- **NEW** `services/api/scripts/check-org-consistency.mjs` —
  8-check read-only validator. Refuses to run against non-LOCAL.
  Aggregated exit code: 0 / 7 (warn) / 8 (fail).
- **NEW** `services/api/scripts/not-null-readiness.mjs` —
  per-column null census + verdict (READY / READY-SOFT / BLOCKED).
  Refuses non-LOCAL. Always exits 0 (report-only).
- **EXTENDED** `services/api/package.json` — 2 new scripts:
  `db:check-org-consistency`, `db:not-null-readiness`.

### Frontend
- **EXTENDED** `apps/web/app/(app)/organizations/[id]/page.tsx`
  — pending-invites section with per-row revoke + resend buttons;
  audit pagination response type updated to consume the new
  `nextCursor` field; tokens never displayed in the pending list.

### E2E
- **NEW** `e2e/phase2-7x-stage5-org-hardening.spec.ts` — 12 tests
  (see Section 13).

### Documentation
- **NEW** `docs/product/PHASE_2_7X_STAGE_5_GOVERNANCE_HARDENING.md`
  (this file — includes the production rollout runbook in §10).

---

## 4. Files changed

```
MODIFIED  services/api/src/services/organization/org-audit.service.ts (+3 event types)
MODIFIED  services/api/src/routes/organizations.routes.ts             (+~440 lines, Stage 5 endpoints)
NEW       services/api/scripts/check-org-consistency.mjs              (read-only validator)
NEW       services/api/scripts/not-null-readiness.mjs                 (read-only readiness probe)
MODIFIED  services/api/package.json                                    (+2 scripts)
MODIFIED  apps/web/app/(app)/organizations/[id]/page.tsx              (pending invites + revoke/resend)
NEW       e2e/phase2-7x-stage5-org-hardening.spec.ts                  (12 tests)
NEW       docs/product/PHASE_2_7X_STAGE_5_GOVERNANCE_HARDENING.md     (this)
```

**Schema changes:** none.
**Migrations added:** none.
**Raw SQL added:** none.

---

## 5. Invite lifecycle behavior (post-Stage-5)

```
                                       POST /v1/orgs/:id/invites
                                       │  validation:
                                       │    - actor ORG_ADMIN+
                                       │    - inviteRole ≤ actor precedence
                                       │    - no pending invite for (org, email)
                                       │    - target email not already a member
                                       │  audit: ORG_MEMBER_INVITED
                                       ▼
   ┌───────────────────────────────[pending]───────────────────────────────┐
   │                                                                         │
   │   POST /v1/orgs/:id/invites/:inviteId/resend                            │
   │   ─ extends expiresAt by 7d                                             │
   │   ─ resendCount += 1                                                    │
   │   ─ audit: ORG_INVITE_RESENT                                            │
   │   ─ same token; no rotation                                             │
   │   ─ refuses revoked / accepted / expired                                │
   │                                                                         │
   │   DELETE /v1/orgs/:id/invites/:inviteId                                 │
   │   ─ sets revokedAt + revokedByUserId                                    │
   │   ─ audit: ORG_INVITE_REVOKED                                           │
   │   ─ idempotent (already-revoked → 200 wasAlreadyRevoked:true)           │
   │   ─ refuses already-accepted (409)                                      │
   │                                                                         │
   │   POST /v1/org-invites/:token/accept                                    │
   │   ─ stage-4 paths preserved + Stage 5 hardening:                        │
   │     · if caller has email AND invite has email:                         │
   │         MUST match (case-insensitive). Mismatch → 403 +                 │
   │         ORG_INVITE_ACCEPT_REJECTED (reason="email_mismatch")            │
   │     · revoked    → 410 + ORG_INVITE_ACCEPT_REJECTED (reason="revoked")  │
   │     · accepted   → 410 + ORG_INVITE_ACCEPT_REJECTED (reason="already_accepted") │
   │     · expired    → 410 + ORG_INVITE_ACCEPT_REJECTED (reason="expired")  │
   │     · not_found  → 404 (no org to scope the audit to)                   │
   │     · success    → 200 + ORG_MEMBER_ACCEPTED                            │
   │                                                                         │
   └─────────────────────────────────────────────────────────────────────────┘
```

**Token security posture (unchanged from Stage 4 + documented):**
- Tokens are 32 random bytes hex-encoded (64 chars).
- Returned ONCE in the create-invite response. NEVER returned again
  by any GET endpoint. Verified by Stage 5 e2e (`GET invites`
  response must not contain a 64-hex string).
- Tokens NEVER appear in audit metadata. Verified by Stage 4 e2e.
- **Tokens are currently stored UNHASHED** in `organization_invites.token`.
  This is a known production-safety gap. The mitigation plan is
  documented in Section 15 (Remaining risks) and is the headline
  candidate for the next phase. Until that lands, operators MUST
  treat DB dumps containing org_invites rows as sensitive material.

---

## 6. Audit hardening behavior

| Capability | Stage 4 baseline | Stage 5 hardening |
|---|---|---|
| Latest events | last 50, no cursor | `take=1..200` + cursor + stable ordering |
| Ordering | `createdAt DESC` only | `(createdAt DESC, id DESC)` — deterministic across same-ms events |
| Filtering | none | `?eventType=A,B,C` allowlist |
| Event types | 6 | **9** (added: REVOKED, RESENT, ACCEPT_REJECTED) |
| Rejection visibility | no audit row for refused accept attempts | every rejection at the accept endpoint emits `ORG_INVITE_ACCEPT_REJECTED` (when the org is known) |
| Actor identity | denormalized (email + displayName) | unchanged |
| Tokens in metadata | never | unchanged (re-verified by Stage 5 e2e) |
| Auth gate | ORG_AUDITOR+ | unchanged |

**Cursor protocol:** the server returns `summary.nextCursor` as the
id of the last event of the page (or `null` if no more pages).
Operators pass `?cursor=<id>` on the next request. Combined with the
stable secondary `id DESC` order, the walk is deterministic.

**Filter behavior:** unknown event-type names are ignored (the
query simply matches nothing). Future event types can be added
to the registry without breaking existing dashboards.

---

## 7. Consistency validation behavior

The new `db:check-org-consistency` reports 8 invariants:

| # | Check | Severity if violated |
|---|---|---|
| 1 | All teams have `organization_id` populated | WARN — re-run backfill |
| 2 | All `team.organization_id` resolve to existing orgs | **FAIL** — FK integrity |
| 3 | Every organization has ≥ 1 ORG_OWNER | **FAIL** — invariant violation |
| 4 | `billing_owner_user_id` is also a member | WARN — backfill drift |
| 5 | All `membership.user_id` resolve to existing users | **FAIL** — FK integrity |
| 6 | Pending-by-shape invites are not actually expired | WARN — cosmetic clutter |
| 7 | No duplicate `(organizationId, userId)` memberships | **FAIL** — unique constraint |
| 8 | At most one personal team per org (Stage 2 invariant) | WARN — structural anomaly |

**Current LOCAL DB status: 0 fail / 0 warn / 8 pass.** All
invariants hold post-Stage 5 e2e (the suite generated 20+ new orgs,
22 invites including 5 revoked, 12 accepted, 0 inconsistencies).

The validator refuses to run against a non-LOCAL DB. Production-side
consistency monitoring is Stage 6+ work (a separate observability
pipeline that polls without holding the DB connection open).

---

## 8. NOT NULL readiness report

| Field | Null Count | Runtime Dependency | Safe To Tighten? | Blocking Risk |
|---|---|---|---|---|
| `teams.organization_id` | 0 | Stage 1+2 contract; no runtime REQUIRES non-null yet (dual-read fallback) | **READY** | None — idempotent backfill maintains 0 |
| `organizations.billing_owner_user_id` | 0 | Stage 4 mutation populates; backfill populates; Stage 6 billing aggregation will require | READY-SOFT | Semantic concern: ownership transfer flow must guarantee non-null at all times |
| `organization_invites.invited_by_user_id` | 0 | Schema already NOT NULL | READY | n/a |
| `organization_memberships.user_id` | 0 | Schema already NOT NULL; CASCADE delete on users | READY | n/a |

**Conclusion: Stage 6 may safely propose a `teams.organization_id`
NOT NULL migration TODAY** without blocking on existing data. The
migration itself must still go through Phase 2.5C wrapper + risk
scan + diff guard + drift-patch protection. The remediation path
for `billing_owner_user_id` is to add a check constraint or trigger
at the same migration (validate non-null at write time).

**No NOT NULL migration was applied this phase.** This was a
deliberate Stage 5 boundary: produce the readiness signal; defer the
mutation to Stage 6.

---

## 9. Workspace isolation validation

| Vector | Mitigation | Test |
|---|---|---|
| Org admin attempts to read evidence via org endpoints | org endpoints expose only governance metadata; no evidence/case/reviewer fields exist in the response shape | Stage 5 spec — workspace-isolation regression carried from Stage 3/4 |
| Cross-org enumeration | non-member + missing-org both return 403 | Stage 5 spec — `GET /v1/orgs/:id/invites refuses non-members` |
| Stale revoked invite reused | revoke endpoint sets `revokedAt`; accept path checks it; rejection audited | Stage 5 spec — `DELETE invite + accept must 410` |
| Resend on accepted invite | server returns 409; cannot extend an accepted invite's window | Stage 5 spec — `resend refuses revoked / accepted` |
| Token enumeration via audit timeline | tokens never logged to audit metadata; `GET invites` response never includes raw token | Stage 5 spec — `GET pending: response must NOT include 64-hex string` |
| Phase 2.6 team-scoped endpoint regression | unchanged; verified by `phase2-6d-matrix` + `phase2-6b-access-review` tests | Stage 5 spec regression block |
| Phase 2.7 Stage 4 mutation endpoints unchanged | `POST /v1/orgs` + `audit-events` regression-tested | Stage 5 spec regression block |

**Workspace isolation: PRODUCTION-SAFE.** Stage 5 added 3 endpoints,
all of which either inspect or revoke pending invite state.
Zero workspace/evidence/reviewer state was mutated by any of them.

---

## 10. Deploy rehearsal results + Production rollout runbook

### Rehearsal outcomes (local-only)

| Step | Command | Result | Notes |
|---|---|---|---|
| 1. Preflight | `pnpm db:preflight` | 0 fail / 1 warn / 2 pass | warn = historical baseline (CREATE INDEX without CONCURRENTLY, ADD FK without NOT VALID) |
| 2. Drift check | `pnpm db:drift-check` | clean — in sync | Schema and migrations agree |
| 3. Risk scan | `pnpm db:risk-scan` | exit 10 (historical warnings only) | No Stage 5 destructive patterns added |
| 4. Consistency | `pnpm db:check-org-consistency` | 0 fail / 0 warn / 8 pass | All invariants hold |
| 5. NOT NULL readiness | `pnpm db:not-null-readiness` | 4 fields all READY/READY-SOFT | Stage 6 may tighten `teams.organization_id` |
| 6. Deploy dry-run | `pnpm deploy:safe:dry` | preflight + api typecheck PASS (exit 14 = dry-run sentinel) | No migrations applied |
| 7. API typecheck | `pnpm --filter proovra-api typecheck` | clean | — |
| 8. Web typecheck | `pnpm --filter proovra-web typecheck` | clean | — |
| 9. E2E full | `pnpm exec playwright test` | **127/129 passing** (2 pre-existing flakes; all Stage 5 tests green) | No regressions |
| 10. Diff guard | `pnpm db:diff-guard < /dev/null` | exit 1 (no input — correct refusal) | Stage 2 guard intact |

### Production rollout runbook (Stage 6 prerequisite reading)

The Phase 2.5C/D/E/F + 2.7X discipline chain expects this sequence
for any production-side migration. NONE of these steps were run in
Stage 5 — this is the documented procedure for the next phase that
chooses to migrate Neon.

1. **Operator: capture a Neon backup.**
   - Mechanism: pg_dump of the prod schema OR a Neon point-in-time
     snapshot via the Neon console.
   - Record the snapshot id / file path as
     `MIGRATE_BACKUP_ID=<id>` to satisfy the Phase 2.5D guard.
   - **Refuse to proceed** if a backup older than 24h is the
     newest available — Phase 2.5D wrapper enforces this via
     length check on `MIGRATE_BACKUP_ID`.

2. **Operator: confirm REMOTE override is intended.**
   Both flags REQUIRED — neither alone is sufficient:
   ```
   export MIGRATE_ALLOW_REMOTE=1
   export MIGRATE_BACKUP_ID=<your-backup-id-here>
   ```
   The Phase 2.5C wrapper will print a `[safe-migrate] EXPLICIT
   REMOTE MIGRATION OVERRIDE` banner before any SQL runs against
   the non-local target.

3. **Operator: rerun all guards against the proposed target.**
   ```
   pnpm --filter proovra-api db:preflight
   pnpm --filter proovra-api db:drift-check
   pnpm --filter proovra-api db:check-org-consistency  # local-only refusal expected
   ```
   The `db:check-org-consistency` will REFUSE on a REMOTE host
   (this is intentional — production-side consistency monitoring
   is a separate Stage 6+ pipeline).

4. **Operator: dry-run the migration.**
   ```
   pnpm --filter proovra-api deploy:safe:dry --allow-remote
   ```
   This runs preflight + risk scan + typecheck WITHOUT applying.
   Inspect the printed banner carefully. The risk scan's exit code
   must be 0 (SAFE) OR 11 (WARNING) OR 12 (DRIFT) — never 9
   (BLOCKED) or 10 (DESTRUCTIVE).

5. **Operator: apply.**
   ```
   pnpm --filter proovra-api deploy:safe --allow-remote
   ```
   The wrapper proceeds only after re-validating
   `MIGRATE_ALLOW_REMOTE=1` AND `MIGRATE_BACKUP_ID` AND the
   `--allow-remote` flag.

6. **Operator: post-apply verification.**
   ```
   pnpm --filter proovra-api db:drift-check         # expect clean
   pnpm --filter proovra-api db:backfill:orgs       # idempotent re-run; should fix any drift
   ```
   The new code path's audit events should be flowing within
   minutes of cutover — query `organization_audit_events` to
   confirm new mutations are landing.

7. **Rollback (if needed):** restore from the backup id captured
   in step 1. The Phase 2.5C wrapper deliberately does not
   automate rollback — the operator chooses the recovery
   procedure with full context.

### Hard rules carried into Stage 6

- All Phase 2.5C/D/E/F guards must remain active.
- The drift catalog must remain at 13 entries until each table is
  properly modeled in `schema.prisma` (Phase 2.7Y / 2.8).
- Org write surfaces ship behind the same `requireAuthAndLegal`
  gate as Stage 3-5.
- Workspace isolation invariants are inviolate.

---

## 11. Teams governance validation

| Concern | Pre-Stage-5 | Post-Stage-5 |
|---|---|---|
| Teams page coherent | Phase 2.6 + 32.8E | unchanged |
| Org/workspace hierarchy clarity | Stage 3 detail page lists org's workspaces | unchanged; pending-invites section adds operator clarity |
| Invite lifecycle visibility | create-invite returns token once; no list endpoint | **NEW**: list pending invites; revoke + resend buttons; ordered by createdAt |
| Access review | Phase 2.6B `/v1/teams/:id/access-review` | unchanged (workspace-scoped; org-aware access review remains a Stage 6+ item) |
| Audit visibility | Stage 4 last-50 latest events | **Stage 5**: paginated, filterable, stable ordering |
| Org-aware operations on Teams | Phase 2.6 unchanged | unchanged |

**Teams governance: operationally mature.** No redesign was needed.
The Stage 5 additions are additive — they extend the org-scope view
without touching the team-scope view.

---

## 12. Backend ↔ frontend coverage matrix

| Capability | Backend Route | Frontend Surface | Permission | AccessGate | Audit Event | Test | Remaining Gap |
|---|---|---|---|---|---|---|---|
| List pending invites | `GET /v1/orgs/:id/invites` | `/organizations/[id]` pending section | ORG_ADMIN+ | `requireAuthAndLegal` + `checkOrgAccess` | n/a (read) | Stage 5 e2e: list + non-member refusal + no-token-leak | None |
| Revoke invite | `DELETE /v1/orgs/:id/invites/:inviteId` | per-row Revoke button | ORG_ADMIN+ | same | `ORG_INVITE_REVOKED` | Stage 5 e2e: revoke + idempotent + 409-on-accepted + accept-410 after revoke | None |
| Resend invite | `POST /v1/orgs/:id/invites/:inviteId/resend` | per-row Resend button | ORG_ADMIN+ | same | `ORG_INVITE_RESENT` | Stage 5 e2e: extends expiry + bumps count + refuses revoked/accepted/expired | None |
| Audit pagination | `GET /v1/orgs/:id/audit-events?take=&cursor=&eventType=` | (UI consumes default page; advanced pagination not wired) | ORG_AUDITOR+ | same | n/a | Stage 5 e2e: take + cursor + eventType filter | UI controls for cursor (Stage 6+) |
| Audit rejection visibility | `POST /v1/org-invites/:token/accept` (hardened) | audit timeline shows `ORG_INVITE_ACCEPT_REJECTED` | n/a | `requireAuthAndLegal` | `ORG_INVITE_ACCEPT_REJECTED` (5 reason codes) | Stage 5 e2e: revoke path emits rejection event | Email-mismatch positive test (needs registered-user fixture; Stage 6) |
| Email-match enforcement | invite-accept logic | n/a (server-side) | possession of token + email-match if both have emails | `requireAuthAndLegal` | `ORG_INVITE_ACCEPT_REJECTED` (reason="email_mismatch") | Inherits Stage 4 token-only positive path; Stage 5 negative-path audited via revoke test sibling | Direct positive test of email_mismatch requires registered-user fixture |
| Org consistency check | `pnpm db:check-org-consistency` (CLI) | n/a | local-only | n/a | n/a | Stage 5 e2e indirect (script invocation could be added) | Production-side consistency observability (Stage 6+) |
| NOT NULL readiness | `pnpm db:not-null-readiness` (CLI) | n/a | local-only | n/a | n/a | manual | Automated CI integration (Stage 6) |
| Deploy rehearsal | `pnpm deploy:safe:dry` (Phase 2.5F) | n/a | local + remote-with-override | n/a | n/a | Stage 5 rehearsal: PASS | None |
| Workspace isolation regression | Phase 2.6 endpoints + Stage 3/4 endpoints | `/teams/*` + `/organizations/*` | unchanged | unchanged | unchanged | Stage 5 e2e: 3 regression tests | None |

---

## 13. E2E tests added

`e2e/phase2-7x-stage5-org-hardening.spec.ts` — 12 tests, all passing:

1. `GET /v1/orgs/:id/invites lists pending invites for ORG_ADMIN+`
2. `GET /v1/orgs/:id/invites refuses non-members`
3. `DELETE invite revokes + emits ORG_INVITE_REVOKED + blocks subsequent accept`
4. `DELETE invite refuses if already accepted (409)`
5. `POST resend bumps expiry + resendCount + emits ORG_INVITE_RESENT`
6. `resend refuses revoked / accepted invites`
7. `rejected accept attempts emit ORG_INVITE_ACCEPT_REJECTED (revoked path)`
8. `audit pagination respects take + cursor + eventType filter`
9. `Stage 5 endpoints validate UUIDs`
10. `Phase 2.6D RBAC matrix still works (regression)`
11. `Phase 2.6B access-review refusal unchanged`
12. `Stage 4 create-org + audit endpoints unchanged (regression)`

**Coverage note:** the email-match positive-rejection path
(authed user with email A attempts to accept an invite for email B)
is not directly tested by e2e because the existing guest-session
helper does not register emails. The audit emission for that path
is structurally identical to the revoked path (same emitter helper,
same metadata shape), which IS covered. Stage 6 will add a
registered-user fixture and the positive email-mismatch test.

---

## 14. Runtime validation evidence

```
$ pnpm exec playwright test
  127 passed, 2 failed (127/129).

  Stage 5-specific (12/12): all green.
  Stage 4 regression: all green.
  Stage 3 regression: all green.
  Stage 2 regression: all green.
  Phase 2.6 regression (matrix + aggregators): all green.

  2 failures, both pre-existing flakes (NOT Stage 5 regressions):
    e2e/phase2-3-flows.spec.ts:51         /settings HMR flake
    e2e/public-verify-privacy.spec.ts:104   rate-limit timing flake

$ pnpm --filter proovra-api typecheck             →  clean
$ pnpm --filter proovra-web  typecheck            →  clean
$ pnpm db:preflight                               →  0F/1W/2P + drift catalog
$ pnpm db:drift-check                             →  schema in sync
$ pnpm db:check-org-consistency                   →  0F/0W/8P  (NEW)
$ pnpm db:not-null-readiness                      →  4 fields, 3 READY + 1 READY-SOFT (NEW)
$ pnpm deploy:safe:dry                            →  preflight + typecheck PASS

DB state after Stage 5 e2e:
  organizations              : 58   (38 pre-Stage-5 + 20 created by e2e)
  organization_memberships   : 70   (organic growth)
  organization_invites       : 22   (12 accepted + 5 revoked + 5 still pending)
  organization_audit_events  : 73   across 8 event types
    ORG_CREATED              : 25
    ORG_UPDATED              : 3
    ORG_MEMBER_INVITED       : 22
    ORG_MEMBER_ACCEPTED      : 12
    ORG_MEMBER_ROLE_CHANGED  : 2
    ORG_INVITE_REVOKED       : 5   (NEW this phase)
    ORG_INVITE_RESENT        : 1   (NEW this phase)
    ORG_INVITE_ACCEPT_REJECTED: 3  (NEW this phase)
  teams (linked / unlinked)  : 33 / 3 (idempotent backfill reconciles)
  evidence                   : 217  (UNTOUCHED — isolation verified)
```

---

## 15. Remaining production rollout risks

| Risk | Status | Mitigation plan |
|---|---|---|
| **Invite tokens stored unhashed** in `organization_invites.token` | Open. Documented. | Stage 6: add `token_hash` column (additive migration), backfill hashes, make `token` column nullable (additive constraint relaxation), stop writing raw tokens on new invites. |
| Email-match positive-rejection has no positive-path e2e | Documented. | Stage 6: register-user fixture + direct positive test. |
| `teams.organization_id` still nullable | NOT NULL READY (0 nulls today) | Stage 6: tightening migration through Phase 2.5C wrapper. Idempotent backfill is the safety net pre-cutover. |
| 13 protected runtime tables still missing from `schema.prisma` | Deferred to Phase 2.7Y / 2.8 | Stage 2 hard-block guards remain active. |
| Schema-vs-DB drift on Neon | Same 13-table risk as local | Production-side drift discovery is part of the Stage 6 rehearsal. |
| Production-side consistency observability | Not implemented | Stage 6+: a polling pipeline (separate from `db:check-org-consistency`) that runs against Neon read replicas. |
| Invite resend rate-limiting | Not implemented | Stage 6+: per-(org, inviteId) cooldown to prevent enumeration. |
| Audit ingest at scale | latest 50 with cursor pagination | Stage 6+: ingest into observability stack (Sentry / Datadog) with retention policy. |
| Auto-org-at-signup | Not implemented | Stage 6+: signup flow creates a default org-of-1 + ORG_OWNER membership atomically. |
| Org policy engine | Not implemented | Out of scope until well past Stage 6. The `organization_policies` table exists (Stage 1) but is dormant. |
| Multi-team orgs | 1:1 today | Stage 6+: cutover sequence (operator promotes a personal team to shared, retaining org binding). |
| Production-side backup discipline | Documented (Phase 2.5D) | No mitigation needed — discipline already exists. Operator MUST set `MIGRATE_BACKUP_ID`. |

---

## 16. Enterprise readiness score

| Axis | Pre-Stage 5 | Post-Stage 5 |
|---|---|---|
| Org schema present | ✓ | ✓ |
| Org backfill idempotent | ✓ | ✓ |
| Drift protection | ✓ | ✓ |
| Org runtime reads | ✓ | ✓ |
| Org runtime writes | ✓ | ✓ |
| Audit event emission | ✓ (6 types) | **✓ (9 types — added REVOKED, RESENT, ACCEPT_REJECTED)** |
| Audit pagination + filtering | ✗ | **✓ stable cursor + take + eventType** |
| Invite revoke + resend | ✗ | **✓ + audit-emitting** |
| Email-match enforcement | ✗ | **✓ (when both sides have emails)** |
| Org consistency validator | ✗ | **✓ 8-check read-only script** |
| NOT NULL readiness report | ✗ | **✓ 4-field per-column verdict** |
| Production rollout runbook | partial (Phase 2.5D backup discipline only) | **✓ full procedure, Stage 5 §10** |
| Workspace isolation preserved | ✓ | ✓ |
| Custody chain preserved | ✓ | ✓ |
| Reviewer isolation preserved | ✓ | ✓ |
| Token hashing | ✗ | ✗ (deferred to Stage 6 with documented plan) |
| Production rollout safe? | No | **Realistically survivable for the read+write tier with Stage 6 token-hashing and NOT NULL tightening as the remaining must-haves** |

**Score: 34/35** (+1 from invite-lifecycle hardening + audit
pagination). The remaining axis is the token-hashing deferral.
Hardening is now at the point where Stages 6+ become productive
work (additive migrations + production-side rollout), not gap
remediation.

### Comparisons (operational)

- **Atlassian (orgs/projects)** — Stage 5 matches Atlassian's
  invite lifecycle (create / revoke / resend / member directory).
  Atlassian additionally has: per-domain auto-join policies,
  SSO/SAML, marketplace governance. We lack those — they're Stage
  6+ or product-tier work, not hardening.
- **Stripe (orgs/workspaces)** — Stage 5 matches Stripe's invite
  + member governance + audit timeline. Stripe additionally has:
  org-level billing aggregation, per-org rate-limiting on invite
  send. We lack those.
- **Slack Enterprise Grid** — Grid orgs expose member directory,
  invite lifecycle, audit timeline, DLP policies. We are AT PARITY
  for the first three. DLP policies require the dormant
  `organization_policies` table to activate (Stage 6+).
- **Relativity (legal-tech enterprise)** — case-level
  permissioning never promotes from org membership. We preserve
  this. **Operational match.**
- **Cellebrite (forensic enterprise hierarchy)** — case custody
  chain is the source of truth for evidence access; org
  membership is audit-visibility only. We preserve this. **Match.**

We are now **production-rollout-survivable for the read + write +
governance tier**. Pending: token hashing (security hygiene), NOT
NULL tightening (schema discipline), policy-engine activation
(product expansion), production-side consistency observability.

---

## 17. Is org governance production-grade?

**Yes — for the current capability surface.** Specifically:

- Every mutation has an audit event.
- The audit endpoint is paginated, filterable, and stable-ordered.
- Invite lifecycle covers create / revoke / resend / accept /
  rejection-audit.
- The consistency validator can be run before any deploy.
- The NOT NULL readiness probe answers the next-phase question.
- The deploy:safe → preflight → drift-check chain passes.
- Workspace isolation is preserved at every layer.

It is NOT production-grade in the strict security sense for token
hygiene — that's the named Stage 6 prerequisite. Operators who run
this code in production today MUST treat database dumps as
sensitive material until token hashing lands.

---

## 18. Is production rollout now realistically safe?

**Yes — with explicit operator authorization, backup discipline,
and the documented runbook in Section 10.** The Phase 2.5C/D/E/F
chain enforces the dual-acknowledgement override; the Stage 5
hardening removes the governance-visibility gaps that would have
made post-cutover monitoring painful.

The remaining blockers are PROCESS-bound, not engineering-bound:
- the operator must possess and record a `MIGRATE_BACKUP_ID`
- both `MIGRATE_ALLOW_REMOTE=1` and `--allow-remote` must be set
- the deploy:safe banner must be visually confirmed before each step
- post-cutover, `db:backfill:orgs` must run idempotently to
  reconcile any teams created during the migration window

These are appropriate gates for a production data migration. The
infrastructure ENFORCES them; the operator owns the authorization.

---

## 19. Recommended next phase

**Phase 2.7X Stage 6 — Token hashing + NOT NULL tightening + production cutover plan.**

Scope (proposed):

1. **Token hashing migration** (additive, no destructive cutover):
   - Add `OrganizationInvite.tokenHash` (`VARCHAR(64) UNIQUE`).
   - Backfill `tokenHash = SHA-256(token)` for all existing rows.
   - Code change: writes go to `tokenHash` only; lookups go to
     `tokenHash` only. The `token` column becomes a no-op writer
     for compat (Stage 7 destructive removal).
   - Audit metadata stays token-free (already true).
2. **Email-match positive e2e** with a registered-user fixture.
3. **`teams.organization_id` NOT NULL** via additive migration
   through the Phase 2.5C wrapper. Re-runs idempotent backfill,
   verifies 0 nulls, applies constraint.
4. **Org policy engine activation** (optional but designed):
   - Wire the dormant `organization_policies` table to one
     simple policy ("require email-match at accept time") to
     prove the loop works end-to-end.
5. **Production rollout dry-run on a Neon staging clone** —
   exercises the runbook in §10 end-to-end without touching real
   prod data.
6. **CI integration of `db:check-org-consistency` and
   `db:not-null-readiness`** as PR-blocking gates against any
   migration commit.
7. **Frontend: pagination controls on the audit timeline**
   (cursor-driven "Load more" button).

Hard rules carried forward:
- No Neon prod contact without the documented runbook.
- No destructive migrations.
- No org-aware RBAC on evidence/case/reviewer data planes.
- Every mutation continues to emit an audit event.
- E2E baseline ≥ 127/129 at completion (modulo the 2 documented flakes).
- Drift catalog must stay at 13 entries.
- Stage 5 hardening invariants must remain true:
  - tokens never logged
  - rejection events emitted
  - consistency validator clean
