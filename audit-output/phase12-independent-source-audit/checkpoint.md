# Phase 12 Independent Source Audit — Append-Only Checkpoint

Source revision: `a7863bec33f10549d84a839ee7ab353509626a2a` (branch `main`, clean tree, == origin/main)
Mode: READ-ONLY. No production file modified. No test read, executed, or used as evidence.

---

## CP-01 — Step 0 release identity  [COMPLETE]
- Branch `main`, HEAD `a7863bec`, worktree CLEAN (`git status --porcelain` empty).
- Remote tracking `origin/main` at the same SHA. UntrackedProductionFiles = 0. DeletedProductionFiles = 0.
- 3,584 tracked files.

## CP-02 — Production file inventory  [COMPLETE]
- ProductionFilesDiscovered = 2,187
- ProductionFilesClassified = 2,187
- ProductionFilesUnclassified = 0
- ProductionFilesExcluded = 1,397 (tests/fixtures/mocks/snapshots/e2e/docs)
- Artifact: `production-file-inventory.json`

## CP-03 — Schema authority  [COMPLETE for tenancy core]
- ~330 models / ~110 enums in `services/api/prisma/schema.prisma` (13,085 lines).
- `Team` IS the Workspace (`@@map("teams")`). Discriminator `workspaceKind WorkspaceKind?` (PERSONAL|OWNED|ORGANIZATION) — **NULLABLE**; no DB CHECK/NOT NULL enforces it.
- Legacy co-discriminator `Team.isPersonal Boolean` still present alongside `workspaceKind`.
- `Team.organizationId` NOT NULL, FK Restrict. `Organization.kind` SYSTEM|CUSTOMER.
- `OrganizationMembership` has **no status/lifecycle column** (contrast: `TeamMember.status`).
- Commercial state on `Team` (billingPlan/billingStatus/includedSeats/overSeatLimit) AND a separate
  per-USER `Entitlement` (userId, plan, teamSeats) + per-USER `Subscription`.

## CP-04 — Workspace-kind writers  [COMPLETE]
Exactly 4 `team.create` sites; all set `workspaceKind` explicitly:
- `routes/teams.routes.ts:452/460` → OWNED
- `services/enterprise-provisioning.service.ts:565/575` and `:857/868` → ORGANIZATION
- `services/platform-context/workspace-bootstrap.service.ts:222/229` → PERSONAL
Canonical classifier = ONE implementation: `packages/shared/src/workspace-kind.ts:normalizeWorkspaceKind`,
delegated by `services/api/src/services/identity/workspace-kind.ts` and `services/worker/src/workspace-billing.ts`.

## CP-05 — Route inventory + authentication coverage  [COMPLETE]
- 125 route modules; **all 125 reachable** (123 registered in `server.ts`; `evidence.saved-views.routes`
  registered from `evidence.routes.ts:82`; `_governance-error-bound` is a helper imported by 4 modules).
  DeadRouteModules = 0.
- 1,081 registered HTTP routes.
- 94 routes carry no `requireAuth` in the handler body; **all 94 verified guarded** by an alternative
  server-side mechanism (hoisted `preHandler` const, `ADMIN_PRE`, `requireApiKey`+scope, cron secret,
  SCIM token, webhook signature, portal token, or are intentionally public auth/SSO/health surfaces).
  UnauthenticatedPrivilegedRoutes = 0.
- Canonical `authorizeOrFail` / `requireAuthorize` used by 101 routes.

## CP-06 — Membership status enforcement  [COMPLETE]
- Canonical primitive `middleware/authorize.ts` → `access-policy.service.ts:evaluateMember` is
  status-aware, org-lifecycle-aware, and fail-closed on UNKNOWN workspace kind. PROVEN_MATCH.
- 201 `teamMember.*` reads total across API+worker.
  - 51 constrain status in the query; 58 select status and check it in code.
  - 83 neither constrain nor consume status.
    - 29 sit behind a canonical authorize (secondary role-refinement reads) → not defects.
    - 54 have no canonical gate in scope → candidate defects, triaged individually (see findings.json).
- CONFIRMED status-blind PRIMARY gates (read + traced):
  - `routes/intelligence.routes.ts:86,107` (`requireMember`/`requireReviewerMember`, 8 call sites)
  - `routes/me-inbox.routes.ts:875,943,2559,2620`
  - `services/cases/case-permission.service.ts:310`
- Verified NOT defects (status IS consumed): `routes/collaboration.routes.ts:71`,
  `services/governance/destructive-action-gate.service.ts:89`, `routes/ops.routes.ts:96`,
  `routes/search.routes.ts:144`, `routes/identity.routes.ts:182` (pre-checks are anti-enumeration only;
  the real gate is `evaluateMemberAccess`/`authorizeOrFail`).

---

## NEXT (not yet executed)
- CP-07 commercial/entitlement authority (§8)
- CP-08 context contract / platform-context (§7)
- CP-09 migrations (§5)
- CP-10 queue/worker topology (§10)
- CP-11 web frontend (§11) + CP-12 mobile (§12)
- CP-13 security/config/infra (§14/§15)
- CP-14 legacy/dead/duplicate (§16)

---

## CP-07 — Commercial / entitlement authority  [COMPLETE]
ONE catalog (`packages/shared-billing/src/plan-catalog.ts:PLAN_CAPABILITIES`), ONE effective-plan
decision (`resolveWorkspaceEffectivePlan`, kind→plan only), ONE API envelope
(`billing/commercial-context.service.ts:resolveCommercialContext`, explicit discriminated subject,
409 fail-closed on declared-kind mismatch). Owned-workspace creation limit excludes Personal Space and
CUSTOMER-org workspaces and is serialized with `pg_advisory_xact_lock` + in-transaction re-count.
Defects: COMM-001 (status-blind seat counts), COMM-002 (pricing-page literal fallbacks), ARCH-001
(`workspaceType` PERSONAL|TEAM parallel vocabulary, 82 sites).

## CP-08 — Context contract  [COMPLETE]
ACTIVE-only membership enumeration, org-lifecycle exclusion, UNKNOWN-kind exclusion, stale
`currentWorkspaceId` revalidation, `noPersonalSpace` never healed into Personal. Client mirror is
tenant-generation-stamped. Defect: ARCH-003 (`organizations` envelope field carries Team ids).

## CP-09 — Migrations  [COMPLETE] — 222 migrations, ~5,673 statements
0 unguarded DROP TABLE / RENAME in executable SQL; 3 ungated SET NOT NULL (deliberate staged cutovers);
22 DROP COLUMN confined to 3 baseline-era/repair migrations. 3 duplicate timestamps (deterministic order).
Blocked: UNK-002/003/004 need a read-only production metadata connection.

## CP-10 — Queue topology  [COMPLETE]
17 Queue objects / 15 Workers / 2 by-design DLQ sinks; registry declares exactly 17 names.
producerWithoutProcessor=0, processorWithoutProducer=0.

## CP-11 — Web  [COMPLETE] — 200 pages, 26 layouts, 6 route handlers, 1 middleware
CSP nonce hazard closed (root layout force-dynamic + CSP on request headers). Unscoped tenant caches = 0.

## CP-12 — Mobile  [COMPLETE] — 53 files, SecureStore tokens, Personal-Space-only by design
MOBILE-001 disconnected Teams tab; MOBILE-002 parity gap.

## CP-13 — Security / infra  [COMPLETE]
0 unauthenticated privileged routes. INFRA-001: prod compose defaults both images to `:latest`.

## CP-14 — Legacy / dead / duplicate  [COMPLETE]
DeadRouteModules 0 · JS/TS twins 0 · TeamWorkspaceConcepts 0 (LEGACY-001 naming only) ·
LEGACY-002 untracked `.p8-release-wave/A_B/schema.prisma`.

---

## CLOSURE
All 8 required artifacts written. ProductionFilesUnclassified = 0.
0 CRITICAL · 4 HIGH · 7 MEDIUM · 6 LOW · 4 UNKNOWN_BLOCKED.
No production file modified. No test read, executed, or used as evidence. `git status` shows only
`?? audit-output/` (untracked, unstaged).
