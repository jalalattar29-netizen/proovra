# PROOVRA Global Enterprise Remediation — Master Finding Register (Phase R0)

Status: **R0 baseline complete.** This register is the pre-implementation gate for
the R1–R17 remediation program. No finding may be implemented before it is recorded
here. Severities: **C**ritical / **H**igh / **M**edium / **L**ow.

Legend for "Verified": ✅ code-confirmed this session · 🟡 audit-agent finding (directional) · ⚠️ corrected/revised after code read.

---

## Register

| ID | Sev | Verified | Finding | Exact files | Exact fn/route/component | Root cause | Affected flows | Security/legal impact | Depends on | Phase | Validation required | Deletion candidates | Remaining uncertainty |
|----|-----|----------|---------|-------------|--------------------------|------------|----------------|-----------------------|------------|-------|---------------------|---------------------|------------------------|
| F1 | C | ✅ | Bulk TRASH/ARCHIVE skip the canonical legal-hold gate | `services/api/src/routes/evidence.routes.ts` | `POST /v1/evidence/bulk` TRASH (~6597) / ARCHIVE (~6563) vs single-record `runDestructiveActionGate` | Bulk path ran only lock+object-lock-retention asserts, not `runDestructiveActionGate` (only path checking `EvidenceLegalHold`) | Bulk trash/archive from Evidence list | Team-scoped legal-held evidence destroyable in bulk | — | **R1 (fix landed)** | Full RBAC/legal-hold test + build + runtime | — | None — fixed on branch `remediation/r1-bulk-legal-hold-gate` |
| F2 | ~~C~~→L | ⚠️ | "Personal-scope destructive-gate bypass" | `services/api/src/services/governance/destructive-action-gate.service.ts:82-86` | `runDestructiveActionGate` early-returns `{gated:false}` when `teamId===null` | By design | Personal evidence delete/archive | **Downgraded:** `EvidenceLegalHold.teamId` is NON-NULL (`schema.prisma:3528`) — personal legal holds cannot exist; personal *retention* IS enforced by `assertEvidenceDeletionAllowedByRetention` on both single + bulk paths | — | R1 (doc only) | Add explanatory test asserting the invariant | — | Confirm no other hold model is personal-scoped |
| F3 | C | 🟡+✅ | No canonical verification record | `schema.prisma` Report(:606)/VerificationPackage(:742)/Evidence.verificationStatus(:16) | `trustDecisionSnapshot` on Report & Package; `verificationStatus` on Evidence | Three independent trust writers; no shared `EvidenceVerificationRecord` | Report, Public Verify, Package, Offline Verifier | Report/verify/package can disagree ("verified" without proof) | F4,F5 | **R3** | Same evidenceId→recordId→recordHash across 4 surfaces | legacy snapshot fields (after adapter) | Adoption status of prior EVR design docs |
| F4 | H | ✅ | Enqueue-after-commit race | `services/api/src/services/evidence-complete.service.ts:1252-1254` | report enqueue after `$transaction` commit | Enqueue outside txn | Capture→report | Evidence stuck SIGNED, no report (matches root package.json warning) | — | **R4** | Crash-injection + reconciler test | — | Whether an outbox table exists already |
| F5 | H | ✅ | `verificationStatus` lag window | `evidence.service.ts:380`, worker `processor.ts:3180` | set `MATERIALS_AVAILABLE` at CREATE; promoted only at REPORTED | Column not authoritative between SIGNED→REPORTED | Home counters, evidence list badges | Under-reports trust state; feeds wrong counters | F3 | R3/R8 | Counter-vs-canonical parity test | — | — |
| F6 | H | ✅ | Three reviewer engines, divergent RBAC | `reviewer-ops.routes.ts`, `review-operations.routes.ts`, `reviewer-workspace.routes.ts` | assign/decide/bulk write same `EvidenceReviewWorkflow` via 3 resolvers (`evaluateMemberAccess` / `requirePermission` / `resolveReviewerRole`) | Phase-accreted parallel engines | Reviewer assign/decision/bulk | Authority differs by route for same workflow | route-lineage audit | **R5** | Parity + single-resolver test | Engine B (`review-operations`) + `/review/operations` after parity | Runtime confirm `/review/operations` unused |
| F7 | H | ✅ | Middleware no-auth + INTERNAL prod-404 bug | `apps/web/middleware.ts:19-49`, `apps/web/components/admin/admin-nav-config.ts:46-48` | `applySurfaceTierGate` rewrites INTERNAL→`/not-found` unconditionally; no session check; no `/login` redirect | Middleware does host/CSP only; auth is client-side | All `(app)/*`, all `/operations/*`, admin nav | Enterprise shells edge-reachable pre-auth; admin ops links 404 in prod | — | **R2** | Prod-mode browser check of admin/ops routes | — | Intended vs bug for pre-auth shell |
| F8 | M | 🟡 | `PageRouteGate` fails open on unknown routeId | `apps/web/components/navigation/PageRouteGate.tsx:60-74` | renders children + dev warn | No fail-closed default | `/operations/{exports,recovery,signers}` (reuse `workspace.security_center`) | Weaker client gate than siblings | F7 | **R2** | Fail-closed unit test + gate audit | — | Backend RBAC still authoritative |
| F9 | H | ✅ | Cases load without tenant pre-filter | `services/api/src/routes/cases.routes.ts:459,834,918` | `findUnique({where:{id}})` + post-fetch authz | Authorize-after-fetch pattern | Case view/edit/delete | No query-layer isolation (IDOR depth) | — | R1/R9 | Cross-tenant denial test | — | — |
| F10 | H | ✅ | Unlink nulls `teamId` | `cases.routes.ts:1241-1255` (`DELETE /v1/cases/:id/evidence/:evidenceId`); bulk REMOVE_FROM_CASE (`evidence.routes.ts:6557`) | sets `caseId:null, teamId:null` | Legacy attach model mutates evidence scope | Case unlink | Workspace scope loss on evidence row | F3? | **R1/R9** | Unlink-preserves-scope test | legacy `Evidence.caseId` writers (after R9) | Whether teamId-null is ever intended |
| F11 | M | ✅ | Duplicate governance/lifecycle stacks | `governance-lifecycle.routes.ts` vs `product-and-lifecycle.routes.ts`; `/governance/*` vs `/evidence-lifecycle/*` UI | retention/destruction/legal-hold implemented twice | Two phase programs (27 vs 4B) | Retention/holds/destruction | Product confusion; divergent status logic | F6 pattern | **R6** | Canonical-owner parity test | one stack after migration | Which is canonical owner per capability |
| F12 | M | 🟡 | Crons use boolean guards, not distributed locks | `services/worker/src/index.ts` schedulers | `*Running` flags | No Redis/pg advisory lock | retention/destruction/immutable reconciliation | Multi-replica double-run | — | **R10** | Multi-replica lock test | — | — |
| F13 | M | 🟡 | Producer-less queue + DLQ w/o replay | `worker/src/index.ts:1644` (`org-health-refresh`); `processor.ts:4388` (`report-dlq`) | consumer with no producer; DLQ no replay endpoint | Incomplete wiring | Ops recovery | Silent no-op; no report replay | — | **R10** | Wire producer or remove; add replay | `org-health-refresh` if unwired | Intended future producer? |
| F14 | M | ✅ | Double-completion re-enqueues report | `evidence-complete.service.ts:551,1253` | SIGNED short-circuit still returns `shouldEnqueueReport:true` | Idempotent branch re-enqueues | Retried completion | Queue churn (dedup saves exec) | F4 | **R4** | Idempotency test | — | — |
| F15 | M | ✅ | Saved-view filters silently dropped | `apps/web/app/(app)/evidence/page.tsx:899-910`, `services/api/src/routes/evidence.saved-views.routes.ts:44-57` | Zod schema omits `tsaStatus/otsStatus/publicVerifyState/verificationStatus` | Backend schema drift from UI | Saved views / Home deep-links | Views return wrong results silently | F3/F5 | **R8** | Round-trip filter test | — | — |
| F16 | M | ✅ | No detail-page report regeneration | `evidence.routes.ts:9831` (endpoint exists); only wired in `components/reports-experience/ReportsIndex.tsx:784` | `POST /v1/evidence/:id/reports/regenerate` | UI not wired on detail | Stuck report recovery | Dead-end on detail Artifacts tab | F4 | **R8** | Add action + test | — | — |
| F17 | H | ✅ | Trust Center sidebar link mis-wired | `apps/web/lib/navigation/routeRegistry.ts:1595` | `workspace.trust` href `/trust` (public) vs page `/trust-hub` | Href not updated after page move | Authenticated Trust nav | Operators land on public marketing page | — | **R7** | Nav click test | — | None — 1-line fix |
| F18 | M | ✅ | Broken link to nonexistent `/reviewer-ops/external` | `apps/web/app/(app)/investigation/reviewers/page.tsx:555,559` | `nextAction`/`adminAction` hrefs | External review is at `/review/external` | Investigation→reviewer nav | Hard 404 | F6 | **R7** | Link test | — | None — 2-line fix |
| F19 | M | ✅ | Dashboard file/URL inversion | `apps/web/app/(app)/operations/{quotas,batch-analysis}/page.tsx` re-export `../../dashboard/*/page`; `next.config.js:253,258` redirect dashboard→operations | 2 `/dashboard/*` files are the live impl host | Canonical URL depends on "legacy" file | Quotas/batch-analysis ops pages | Deleting dashboard files breaks build | F7 | **R7** | Build after inline | dashboard files (after inline) | — |
| F20 | M | 🟡 | Public verify is UUID-as-bearer | `evidence.routes.ts:10853` | `GET /public/verify/:id` unauthenticated, rate-limited | Public-by-id design | Public Verify | UUID is the only secret | F3 | R3/R16 | Confirm rate-limit + scope | — | Product-intended exposure |
| F21 | M | 🟡 | Committed `.js`/`.ts` twins | `apps/web/lib/api.js`, `lib/navigation/routeRegistry.js`, `lib/platform-context/*`, `lib/uploads/*` (~25) | compiled twins, 0 importers | Committed build artifacts | Build/maintenance | Dual-maintenance drift | — | **R14** | Prove 0 importers; CI guard | ~25 `.js` twins | Any build step consuming them |
| F22 | M | ✅ | Case orphan link rows on evidence delete | `cases.routes.ts` link-reconciliation; `CaseEvidenceLink` (`schema.prisma:8023`) | soft-deleted evidence keeps link row; reconciliation doesn't filter `deletedAt` | No cascade/soft-delete filter | Case evidence lists | Deleted evidence shows in diagnostics | F10 | **R9** | Orphan-link test | — | — |
| F23 | H | 🟡 | Object-level IDOR sweep incomplete | all 114 `services/api/src/routes/*.routes.ts` | authorize-after-fetch pattern (F9 is one instance) | No systematic object-level scoping audit | All sensitive reads/mutations | Potential cross-tenant access | F9 | **R1** | Per-route IDOR matrix | — | **Largest open item** — full sweep not done |
| F24 | H | 🟡 | Report/Verify/Package drift + stale OTS | `worker/src/report-v2/*`, `verification-package*.ts`, `ots-*.ts` | version-max "latest", no `isCurrent`; OTS pending→anchored not re-propagated | Independent snapshots (see F3) | Verify vs report vs package | Stale package can look current after OTS upgrade | F3 | **R3/R13** | Cross-surface state parity | legacy snapshots | Deep report/package trace was rate-limit-cut |
| F25 | M | 🟡 | Custody attestation offline-verify parity | `packages/offline-verifier/*`, `packages/shared-evidence-presentation/*` | offline vs online verdict derivation | possible 3 algorithm copies | Offline Verifier | Offline result may differ from online | F3 | **R13** | Parity harness | mirror impls (after shared core) | Offline parity not fully traced |
| F26 | M | 🟡 | Schema invariant gaps | `schema.prisma` — `Evidence.teamId`(:136 nullable), `verificationStatus`(:16 nullable); Report vs Package cascade asymmetry | nullable scope fields; no `isCurrent`; cascade mismatch | Historical nullability (Home zero-data foothold) | Counters, deletes | Zero-data class; cascade surprises | F3,F5 | **R11** | Additive migration + backfill test | unused enums/fields (TBD) | Full 241-model sweep not done |
| F27 | M | 🟡 | Storage/DB consistency | `services/*/storage.ts`, `orphan-scan.ts`, `retention-cleanup.ts` | DB-row/object mismatch; `retention-cleanup.ts` unscheduled | one-shot cleanup script not on cron | Downloads, retention | Ready flag without object; cleanup vs hold | F12 | **R12** | Consistency checker + hold-safety test | — | Cleanup×legal-hold interaction untraced |
| F28 | M | 🟡 | Hidden features / flag drift | `NEXT_PUBLIC_FEATURE_WORKFLOW_ENGINE_CAPTURE`, `NEXT_PUBLIC_RESUMABLE_UPLOADS_ENABLED` (`lib/uploads/*`) | default-off flags gating whole modules | Unfinished features shipped dark | Capture, uploads | Unreachable clusters unowned | — | **R15** | Classify+wire/remove | dead flags | Ownership of each cluster |
| F29 | L | ✅ | AI follow-up gaps | `services/api/src/services/ai/*` | regex forbidden-filter (`ai-policy.ts`); text-only payload | guardrail bypassable; injection depth untested | AI chat/capture | Low (no raw bytes; keys backend-only) | — | **R16** | Injection + quota test | — | Prompt-injection depth |
| F30 | L | 🟡 | Orphaned pages/endpoints/components | `/redaction/policy`, `/trust-center/methodology`, `/admin/identity/providers`, `/admin/contact-sales`, evidence `/certifications*`,`/reviewer-audit`,`PATCH /annotations`; `ReviewWorkspace.tsx` cluster; 13 zero-importer components; `api-keys` 410 tombstones | see audit §19–24 | phase leftovers | — | Low | — | **R14** | Dependency-proof each | listed items | Confirm no dynamic/email callers |
| F31 | L | ✅ | Duplicated presentation logic | ~11 `statusBadgeStyle()`, ~6 `statusLabel()`, ui-legacy vs new primitives | scattered copies | No shared consumption | UI consistency | Low | — | **R14** | Consolidation + guard | local copies | — |
| F32 | M | 🟡 | Counter/stat correctness (Home) | `apps/web/app/(app)/home/*`, `dashboard.routes.ts`, `me-operational-priorities.routes.ts` | counter→endpoint→query trace | reads laggy `verificationStatus`; teamId-null foothold | Home/Dashboard | Wrong/stale counts | F5,F26 | **R8** | Counter-vs-list parity | — | **Home trace rate-limit-cut** |
| F33 | M | 🟡 | Reviewer-workspace unguarded reads | `reviewer-workspace.routes.ts` | QC samples / disagreements / schemas reads no capability gate | inconsistent read gating | Reviewer reads | VIEWER may see QC/disagreements | F6 | **R5** | Read-gate matrix | — | Intended VIEWER visibility |
| F34 | M | 🟡 | Notifications/activity/audit completeness | `notifications.routes.ts`, audit-chain, custody events | event-emission matrix incomplete | not fully traced | Notifications/activity | Missing/duplicated events | — | **R16** | Emission matrix test | `NotificationPreferencesPanel` (0 importers) | Matrix not completed |
| F35 | M | 🟡 | Billing/entitlement/seat enforcement location | `billing.routes.ts`, `workspace-billing.ts`, entitlement checks | backend vs UI-only enforcement unverified | not traced | Seat limits, plan gates | UI-only gating risk | — | **R16** | Backend-enforcement test | — | Enforcement location unknown |

---

## Cross-cutting notes

- **Largest open audit gaps (rate-limit casualties, not yet closed):** F23 full IDOR sweep, F32 Home counter trace, F24/F25 report/verify/package + offline-verifier parity, F26 full 241-model schema pass. These must be completed as their phases begin; they are recorded here as known-incomplete rather than assumed-clean.
- **Route-family classifications (Route Lineage Audit):** Teams = SEPARATE VALID CAPABILITIES; Trust = PARTIAL SHADOW SYSTEM (F17); Reviewer = PARTIAL SHADOW SYSTEM (F6); Dashboard/Home/Operations = PARTIAL SHADOW SYSTEM (F19). Feed R7.
- **Non-deletable-today (proven live callers):** `/teams/[id]` (4 links + test), `/trust` (10+ public links), `dashboard/{quotas,batch-analysis}` files (operations re-exports), Engine B until `/review/operations` runtime-confirmed unused.

## R1 Execution Log (Phase R1 — Critical security & legal-hold corrections)

Branch: `remediation/r1-bulk-legal-hold-gate`. Verification: API typecheck exit 0;
**full API suite 17,421 passed / 0 failed / 64 skipped (485 files)**; API production
build (incl. shared deps) exit 0. Runtime note: changes are backend authorization
logic (not browser-observable); verified via the full route/service test suite, NOT a
live multi-tenant exploit-replay (that needs a provisioned API+DB+Redis stack).

| Finding | Outcome | Change | Tests added |
|---------|---------|--------|-------------|
| **F1** Bulk legal-hold bypass | **FIXED** | `evidence.routes.ts` bulk TRASH+ARCHIVE now call `runDestructiveActionGate` (canonical `EvidenceLegalHold` enforcement), mirroring single-record handlers | `phase-r1-bulk-destructive-gate.test.ts` (4) |
| **F2** Personal-scope gate "bypass" | **RESOLVED (non-issue)** | No code change: `EvidenceLegalHold.teamId` is non-nullable → personal holds cannot exist; personal retention already enforced both paths | `phase-r1-legal-hold-scope-invariant.test.ts` (3) — pins the invariant |
| **F36** Upload-session evidence↔team IDOR (NEW, found by F23 sweep) | **FIXED** | `createUploadSession` now loads `evidence WHERE id=evidenceId AND teamId=teamId` before writing any row; new `evidence_not_found` denial → anti-enumeration 404 in both upload routes. Closes a cross-tenant custody-tampering write (attach `EvidencePart` to another team's evidence via the Phase-30.12 bridge) | `phase-r1-upload-session-evidence-scope.test.ts` (3) |
| **F23** Object-level IDOR sweep (all sensitive routes) | **COMPLETE** | 3-domain sweep (evidence/reports/downloads · cases/teams/orgs · reviewer/admin/ops). **Exactly one real gap (F36) found & fixed.** All signed-download endpoints, reviewer workflows, admin/platform routes, notifications, redaction, governance correctly re-apply the tenant filter on object load. Only accepted note: by-design global queue-job operator surface (Low) | — |
| **F9** Case tenant post-fetch filtering | **DEFERRED → R9** | No actual bypass (post-fetch authz present & correct); query-layer scoping is hardening that risks pinned 404/403 semantics — belongs with the R9 case-model work + full case-suite validation | — |
| **F10** Unlink clears `teamId` | **DEFERRED → R9 (reclassified)** | `teamId` is authorization-bearing (`getEvidenceWithReadAccess:2527` grants team members read). Clearing on unlink REVOKES access (safe); the audit's proposed "stop clearing it" would RETAIN team read-access post-unlink = weaker authz (violates safety rule 9). Real fix = R9 `CaseEvidenceLink` migration stopping the `teamId` case-scope overload | — |

**R1 gate status: GREEN for all fixable items** (F1, F2, F36, F23). F9/F10 explicitly and justifiably deferred to R9. Files changed: `services/api/src/routes/evidence.routes.ts`, `services/api/src/routes/upload-sessions.routes.ts`, `services/api/src/routes/integrations-uploads.routes.ts`, `services/api/src/services/uploads/upload-session.service.ts`. Files added: 3 test files + `REMEDIATION_REGISTER.md`. No files deleted. No commits (awaiting review).

## R2 Execution Log (Phase R2 — Authentication, route gating & platform access)

Branch: `remediation/r1-bulk-legal-hold-gate` (continued). Verification: web typecheck
exit 0; **full web suite 1,591 passed / 0 failed (71 suites)**; new R2 regression test
4/4; web production build exit 0. Runtime note: the gate-*behavior* (admin sees page,
non-admin sees denial panel, anon gets 404) needs the deployed **prod app-host** (the
middleware tier gate runs only under `if (isAppHost)`, skipped on localhost) plus a
seeded platform-admin vs non-admin — not reproducible locally. Verified via logic +
source-contract tests + full suite + build instead of a live screenshot; **live
prod-host validation is the one deferred gate item for R2.**

| Finding | Outcome | Change | Tests |
|---------|---------|--------|-------|
| **F8** Wrong routeIds on global-ops pages | **FIXED** | `/operations/queues` → `platform.queue_ops`; `/operations/{signers,exports,recovery}` → new dedicated `operations.{signers,exports,recovery}` registry entries — all `requiredActiveSpace: PLATFORM_ADMIN`, replacing the weaker `workspace.security_center` (OPS/PERSONAL_OR_ORG) gate | `phase-r2-route-gating.test.ts` (F8 ×2) |
| **F7** Middleware INTERNAL prod-404 bug | **FIXED** | `applySurfaceTierGate` now 404s the INTERNAL shell ONLY when `proovra_session` is absent (matches the module's documented intent). Authenticated users fall through to `PageRouteGate` (now correctly PLATFORM_ADMIN for ops pages), so platform admins are no longer 404'd on `/operations/*` + `/tools` admin-nav links in prod, and logged-in non-admins get the denial panel, not the page. Cookie confirmed `domain:.proovra.com` → readable on app host | `phase-r2-route-gating.test.ts` (F7) |
| **F18** Broken `/reviewer-ops/external` link | **FIXED** | `investigation/reviewers/page.tsx` both hrefs → real `/review/external` page | `phase-r2-route-gating.test.ts` (F18) |
| **F7b** No anonymous→`/login` redirect | **DEFERRED (documented)** | The app deliberately does client-side auth (blank-until-`authReady`); a middleware `/login` redirect for `(app)/*` risks redirect loops with the OAuth callback and can't be validated without the prod host + a real unauthenticated session. Data is already API-gated (401); this is UX, not a data-exposure hole. Proposed approach: middleware redirect for app-host non-public routes when `proovra_session` absent, excluding `/auth/*`. Needs deployed-env validation before landing | — |
| **F8b** `PageRouteGate` fail-open on unknown routeId | **RETAINED (documented)** | Deliberate design (avoids bricking the app on a typo during migration; source-contract tests catch unregistered ids). After the F8 routeId fix, NO INTERNAL/ops page relies on it — every ops page now resolves a registered PLATFORM_ADMIN entry. Left as-is with rationale | — |

**R2 gate status: GREEN for the implemented fixes** (F8, F7, F18) at typecheck/test/build level; **F7 live prod-host behavior validation deferred to deployment.** F7b + F8b deferred/retained with documented reasons (avoid destabilizing the working auth flow / deliberate design). Files changed: `middleware.ts`, `lib/navigation/routeRegistry.ts` (+3 entries), 4 `operations/*` pages, `investigation/reviewers/page.tsx`. Added: `phase-r2-route-gating.test.ts`. No deletions. No commits.

## R4 Execution Log (Phase R4 — Reliable job dispatch & lifecycle recovery)

Branch: `remediation/r1-bulk-legal-hold-gate` (continued). Verification: worker
typecheck exit 0; **worker suite 800 passed / 1 failed — the single failure is
PRE-EXISTING and unrelated (F37, present on `main`, in files I never touched)**;
new R4 behavioural test 6/6; worker production build exit 0. Runtime note: live
recovery (inject a stuck-SIGNED row → reconciler re-enqueues) needs a worker+DB+Redis
stack; verified via mocked behavioural tests + build. Live end-to-end deferred.

| Finding | Outcome | Change | Tests |
|---------|---------|--------|-------|
| **F4** Commit-to-enqueue crash window (evidence stuck SIGNED, no report) | **FIXED (reconciler)** | New `services/worker/src/lifecycle-recovery.ts` + scheduler in `index.ts`: periodically finds `status=SIGNED, deletedAt=null, reports:{none:{}}` in a `signedAtUtc` age window and idempotently re-enqueues the report job. Reuses the processor's OWN plan guard (`resolveEffectivePlanForEvidence` + `canPlanGenerateReports`) so it never enqueues an ineligible plan (churn-free). Idempotent (deterministic report jobId) → multi-replica/overlap safe. Non-destructive (enqueue only). `LIFECYCLE_RECOVERY_ENABLED` kill-switch, 5-min default. Chose reconciler over transactional outbox (prompt-sanctioned) — additive, does not touch the hot commit path | `phase-r4-lifecycle-recovery.test.ts` (6) |
| **F13** report-dlq has no replay tooling | **RESOLVED (non-issue)** | Verified report-dlq IS already replayable via the GENERIC operator surface: `queue-replay-safety.service.ts` lists `report-dlq/GenerateReport` as `requires_step_up`, and `operations-queues.routes.ts` exposes a step-up-gated `POST /v1/operations/queues/:queueName/jobs/:jobId/replay` + safety matrix. The audit compared to media-intelligence-dlq's *dedicated* endpoint; the generic surface covers report-dlq. No redundant tooling built | — |
| **F14** Double-completion re-enqueue churn | **ACCEPTED (documented, no change)** | Harmless: `enqueueGenerateReportJob` dedupes by deterministic jobId, so a retried completion re-check either skips or replaces — no double execution. It also provides a COMPLEMENTARY client-driven recovery path for the same crash window the F4 reconciler covers. Touching the hot completion path for cosmetic queue churn would add risk without correctness benefit | — |
| **F37** (NEW) Pre-existing timestamp-display-policy violations | **RECORDED (not silenced)** | Discovered running the worker suite: 3 admin pages format timestamps directly instead of via the shared layer — `admin/evidence-ops/page.tsx:487`, `admin/page.tsx:159` (`new Date().toLocaleString`), `organizations/[id]/admin/domains/page.tsx:429` (`toLocaleDateString`). Present on `main` (commit 8361187e); NOT caused by remediation. Out of scope for R4; belongs to R8/R14. Left failing (rule 8 — never silence) and recorded here | — |

**R4 gate status: GREEN for the F4 fix** (typecheck/tests/build); F13 verified non-issue; F14 accepted-harmless; **F37 pre-existing failure disclosed, not silenced.** Files changed: `services/worker/src/index.ts` (+60). Added: `lifecycle-recovery.ts`, `phase-r4-lifecycle-recovery.test.ts`. No deletions. No commits.

## R5 Execution Log (Phase R5 — Reviewer engine & RBAC consolidation)

Branch: `remediation/r1-bulk-legal-hold-gate` (continued). Verification: API typecheck
exit 0; reviewer suites 620/620; **full API suite 17,425 passed / 0 failed**; API
production build exit 0. Also re-ran web typecheck (0) + web suite (1,595/0) + web build
(0) after the R2-completion fix below. Runtime note: live per-role authority proof
(MEMBER denied bulk-assign, SUPERVISOR allowed) needs a seeded multi-role stack;
verified via the capability-model invariant + source contracts + full suite.

**Resolver divergence — VERIFIED, not assumed** (the crux):
- **A ≡ B**: reviewer-ops `evaluateMemberAccess("evidence_request.review")` and
  review-operations `requirePermission(...,"evidence_request.review")` BOTH reduce to
  the same shared `roleHasPermission` catalog → they cannot diverge. The audit's "three
  divergent resolvers" is, for A vs B, pure code-shape duplication (safe).
- **A vs C — genuine divergence found (F38)**: see below.

| Finding | Outcome | Change | Tests |
|---------|---------|--------|-------|
| **F38** (NEW) reviewer-ops bulk-ASSIGN privilege-escalation / authority divergence | **FIXED (tightening)** | `POST /v1/reviewer-ops/reviews/bulk` gated only on the boolean `evidence_request.review` (`requireReviewerCapable`), yet `executeBulkTriage` supports an ASSIGN action — letting a MEMBER (REVIEWER role, which lacks `review.assign`/`review.bulk`) bulk-ASSIGN what they cannot single-assign (the single-assign routes already require the granular `review.assign`), AND diverging from the parallel reviewer-workspace bulk surface (requires `review.bulk`). Added `requireReviewerBulkCapable` → `callerHasCapability(resolution, "review.bulk")` on the bulk route. Authority is now identical across single-assign, reviewer-ops bulk, and reviewer-workspace bulk. Strictly a TIGHTENING (never grants a previously-denied action) → rule-9 safe | `phase-r5-reviewer-bulk-capability.test.ts` (4) |
| **F6** "Three reviewer engines, divergent RBAC" (original audit High) | **PARTIALLY RESOLVED / re-scoped** | The authority-divergence *hole* (F38) is closed. The remaining items are consolidation of DUPLICATE (not divergent) logic: Engine B (`review-operations`) uses an equivalent resolver (A≡B) and is a retirement candidate pending runtime confirmation `/review/operations` is unused; Engine C (coding/QC) is a separate valid capability, not a duplicate. Full engine-collapse + Engine-B deletion deferred (needs product sign-off + parity harness + zero-caller proof) | — |

**Product-visible note (flagged for veto):** F38's fix removes MEMBER bulk-reviewer access on reviewer-ops (they retain single-decide). This aligns with the engine's own single-assign gate + the parallel engine and closes an escalation bypass, so it is treated as a bug fix — but if MEMBER bulk was an intended feature, this is the line to revert.

### R2-completion fix (cross-package regression I missed by only running the web suite in R2)
Running R5's **full API suite** surfaced 3 failures caused by my **R2** changes (the API package has cross-package tests that read the web app): my 3 new `operations.{signers,exports,recovery}` registry entries were unmapped in `PILLAR_FOR_ROUTE_ID` (`pillarRegistry.ts`) and the Phase-B operational groups (`phaseBOperationalGroups.ts`), and my R2 middleware reword dropped the exact comment phrase a source-contract middleware test pins. **All 3 fixed** (added the routeIds to both mappings; restored the pinned phrase — behavior unchanged). This closes the honest gap noted in the R2 log: R2 was verified only at the web-suite level; the full cross-package API suite is now green too.

**R5 gate status: GREEN** (typecheck/tests/build across API + web). F38 fixed; A≡B proven equivalent; F6 engine-collapse deferred with rationale; R2 cross-package regressions closed.

## R6 Execution Log (Phase R6 — Governance & lifecycle consolidation)

Branch: `remediation/r1-bulk-legal-hold-gate` (continued). Verification: worker typecheck
exit 0; **worker suite 807 passed / 1 failed (the failure is the SAME pre-existing F37,
unrelated)**; new R6 test 7/7; worker production build exit 0. Runtime note: live proof
(place a 4B hold → automated destruction refuses) needs a worker+DB stack with retention
policies; verified via mocked helper behaviour + source contracts + build.

**Verified overlap (the crux — three coexisting legal-hold models):**
- `EvidenceLegalHold` (4A, per-record) + `CaseLegalHold` (4A, case-level) — written by the `/governance/*` trash/delete UI.
- `LegalHold` (4B, EVIDENCE/WORKSPACE/ORGANIZATION/CASE scope) — written by the LIVE `/lifecycle/legal-holds` UI (`createLegalHold`), a pure scope-level record that NEVER mirrors into `EvidenceLegalHold` or `Evidence.lifecycleState`.
- The API-side canonical `isUnderLegalHold` unions all three. Interactive delete/archive gates use it (via `enforceSensitiveAction`). **The two WORKER automated-destruction stages did NOT.**

| Finding | Outcome | Change | Tests |
|---------|---------|--------|-------|
| **F39** (NEW, **High**) Automated retention destruction bypasses Phase-4B legal holds | **FIXED (fail-closed tightening)** | Both worker stages — `retention-reconciliation.worker` (scheduler, line ~115) and `destruction-orchestrator.worker` (executor, `gatherDestructionFacts`) — checked only the 4A models, so evidence under an active 4B hold placed via `/lifecycle/legal-holds` could be AUTOMATICALLY DESTROYED (spoliation of litigation-held evidence). New worker helper `governance/lifecycle-legal-hold.ts#hasActiveLifecycleLegalHold` mirrors the canonical 4B scope query; wired into BOTH stages (scheduler skips + notifies "hold"; executor folds it into `hasActiveDirectHold` → BLOCKED_BY_HOLD). Strictly additive — only adds block conditions; tolerates an absent `legal_holds` table | `phase-r6-lifecycle-legal-hold.test.ts` (7) |
| **F11** Duplicate governance/lifecycle stacks (retention/destruction/legal-hold ×2) | **PARTIALLY RESOLVED / re-scoped** | The most dangerous consequence of the duplication — a hold-enforcement GAP on the automated destruction path (F39) — is closed, and the worker now has ONE canonical 4B-hold helper used by both stages. The remaining work is STRUCTURAL: the two full API+UI stacks (`governance-lifecycle`/Phase-27 `/governance/*` and `product-and-lifecycle`/Phase-4B `/evidence-lifecycle/*`) and the THREE coexisting hold models are a genuine consolidation target, but collapsing them (pick one canonical model, migrate data, delete a stack) requires product sign-off + a data-migration plan + parity harness + zero-caller proof. Deferred with recommendation: 4B `LegalHold` is the superset model (multi-scope) → adopt as canonical; back-fill/adapter the 4A per-record holds; retire the duplicate | — |

**Recommended canonical owners (for the deferred structural merge):** legal hold → 4B `LegalHold` (superset scope); retention/destruction → Phase-4B `product-and-lifecycle` lifecycle engine (already scope-aware); the ideal end-state is a SINGLE shared hold-check helper used by API gates AND worker stages (this R6 fix created the worker half; unifying with the API `isUnderLegalHold` is the follow-up).

**R6 gate status: GREEN for the F39 fix** (typecheck/tests/build). F11 structural stack-collapse deferred with a canonical-owner recommendation + rationale. Files changed: `retention-reconciliation.worker.ts` (+23), `destruction-orchestrator.worker.ts` (+15). Added: `governance/lifecycle-legal-hold.ts`, `phase-r6-lifecycle-legal-hold.test.ts`.

## R7 Execution Log (Phase R7 — Route namespace, ownership, navigation, legacy decommission)

Branch: `remediation/r1-bulk-legal-hold-gate` (continued). Verification: web typecheck
exit 0; **web suite 1,602 passed / 0 failed**; web production build exit 0 (regenerated
route types); API typecheck exit 0; **API suite 17,426 passed / 0 failed**; new R7
anti-regression test 7/7. Runtime note: gate/nav *behavior* (authed user lands on
/trust-hub; /operations pages render for admins) needs the deployed prod-host + seeded
roles — verified via source contracts + full suites + build.

| Finding | Outcome | Change | Tests |
|---------|---------|--------|-------|
| **F17** (R7.3) Trust nav mis-wired to public page | **FIXED** | `workspace.trust` href `/trust` → `/trust-hub` in BOTH the frontend `routeRegistry.ts` AND the backend `navigation-registry.ts` (they must match — `phase3-nav-frontend-drift` pins it). Public `/trust` preserved; `/trust-center/*` docs untouched. | new `phase-r7-route-namespace.test.ts` + updated `workspace-surface-audit`, `phase-1a-pillar-ia`, `phase3-nav-frontend-drift` |
| **F19** (R7.5) Dashboard→Operations file/URL inversion | **FIXED** | `git mv` the live impls `dashboard/{quotas,batch-analysis}/page.tsx` → `operations/{quotas,batch-analysis}/page.tsx` (identical relative-import depth → zero import breakage); deleted the re-export wrappers + the empty `(app)/dashboard/` dir; registry hrefs → `/operations/*`; legacy `/dashboard/*` URLs remain next.config 308 redirects. Quotas/batch keep their PERSONAL_WORKSPACE gate (self-service views, NOT platform-admin tools — distinct from queues/signers/exports/recovery which R2 made PLATFORM_ADMIN). | `phase-r7-route-namespace.test.ts` (7) + updated `phase-32-8-c`, `phase-38-14/15`, `phase-cr1`, `phase-g5`, `phase-r10` |
| **F21** (partial) `.js`/`.ts` registry twin drift | **MITIGATED (synced)** | The stale `routeRegistry.js` twin (imported by `phase-r10`) was synced for the 3 changed hrefs. This is a recurring hazard; full twin removal is R14. | (covered by r10) |

**Prior-phase R7 coverage (already landed):** R2 → operations routeIds → PLATFORM_ADMIN (R7.5.8–9), middleware prod-404 fix (R7.5.6–7), `/reviewer-ops/external`→`/review/external` (R7.4.5); R5 → unified reviewer bulk permission on the canonical engine (R7.4.3).

### R7.6 — Remaining route-family classifications (audit)
- **governance / governance-platform** → SEPARATE VALID CAPABILITIES (workspace-tier vs org-tier), but overlapping access-review + hold surfaces feed the R6 structural consolidation (deferred).
- **product-and-lifecycle / evidence-lifecycle** → SEPARATE surfaces over DUPLICATE hold models (F39 fixed the enforcement gap; structural model-merge deferred to R6).
- **intelligence / intelligence-quality** → SEPARATE VALID CAPABILITIES (reviewer-intelligence ops vs correction analytics).
- **collaboration / collaboration-teams** → `/collaboration` is DEAD/ORPHANED (redirects to `/inbox`); `/collaboration-teams` is the product.
- **access-review surfaces (×3: governance-platform, admin/identity, organizations/[id]/admin)** → SEPARATE scopes (platform/org/workspace); INCONCLUSIVE — needs product decision on canonical owner.
- **admin vs organization-admin** → SEPARATE VALID CAPABILITIES (platform-admin vs tenant-admin).

### Deferred within R7 (need full-stack browser validation / product sign-off; R7.9 forbids unvalidated deletion)
- **R7.2 — `/teams/[id]` → `/workspaces/[workspaceId]` migration.** Runtime Ownership Proof: business=workspace tenancy admin; nav=`admin.teams` (sidebar off) + 4 `<Link>` callers (`WorkspaceAdministrationHome:299`, `organizations/[id]:945`, `organizations/[id]/setup:1117`, `integrations:777`); API=`/v1/teams/*`; models=`Team/TeamMember/TeamInvite`; child components in `teams/[id]/components/*`; back-compat test `phase9-teams-redirect-backcompat`. Plan: `git mv teams/[id] → workspaces/[workspaceId]` (same depth → imports preserved), rename `params.id`→`params.workspaceId`, migrate 4 hrefs, add `/teams/:id`→`/workspaces/:id` redirect, delete old. **Deferred:** it's authenticated tenancy admin (member mgmt / invites / access reviews) I cannot browser-validate locally, and R7.5 showed a 2-file move cascades into ~7 test files — a page+param+caller migration needs the deployed stack to validate safely.
- **R7.4 — Engine B (`review-operations`) retirement + `/review/operations` removal.** Needs zero-caller runtime proof (it's command-palette-reachable), a parity harness, and confirmation no independent `EvidenceReviewWorkflow` writes remain. The authority *divergence* is already closed (R5/F38); retirement is structural. Deferred.

**R7 gate status: GREEN for the implemented migrations** (F17 trust nav, F19 dashboard inversion; + R7.6 classification). R7.2 workspace-route move and R7.4 Engine-B retirement deferred with Runtime Ownership Proofs + plans (unvalidatable-locally / product sign-off). Files: 2 moved (dashboard→operations), 2 deleted (wrappers), 8 changed (registry ×3, middleware, backend nav, 4 ops pages) + 8 tests updated; 1 new test.

## R8 Execution Log (Phase R8 — Internal page-to-API wiring & counter correctness)

Branch: `remediation/r1-bulk-legal-hold-gate` (continued). Verification: API typecheck 0
+ **API suite 17,428 / 0**; web typecheck 0 + **web suite 1,602 / 0** + web build 0;
**worker suite 808 / 0 — first fully-green worker suite across all phases** (F37 closed
the one standing red). New R8 test 2/2.

| Finding | Outcome | Change | Tests |
|---------|---------|--------|-------|
| **F5 / F32** Home/dashboard counter correctness (audit headline, rate-limit-cut) | **VERIFIED NON-ISSUE** | Traced the command-center counters: they read AUTHORITATIVE sources — `reports: { some: {} }` / `verificationPackages: { some: {} }` (actual row existence) and `Evidence.status` (the state machine) — NOT the laggy `verificationStatus` column the audit blamed. A `Phase HOME-NUMERIC-TRUTH-FIX` was already applied. No counter fix warranted; `verificationStatus` lag (F5) is a column-semantics issue that does not feed the counts. | — |
| **F15** Saved-view silently drops trust filters | **FIXED** | `SavedViewFiltersSchema` now declares `tsaStatus`/`otsStatus`/`publicVerifyState`/`verificationStatus` (string, default "all", matching the sibling multi-enum filters). The evidence LIST endpoint already applies all four (evidence.routes.ts:2224-2246), so Zod was silently stripping them on save → a saved/deep-linked view returned different results than applied. | `phase-r8-saved-view-trust-filters.test.ts` (2) |
| **F37** (found in R4) Direct timestamp formatting in 3 admin pages | **FIXED** | `admin/page.tsx`, `admin/evidence-ops/page.tsx`, `organizations/[id]/admin/domains/page.tsx` now route timestamps through the shared `formatUserDateTime`/`formatUserDate` helpers instead of `new Date().toLocaleString()`/`.toLocaleDateString()`. Closes the standing `timestamp-policy.contract` red → **worker suite fully green.** | existing `timestamp-policy.contract.test.ts` (now 3/3) |
| **F16** No regenerate-report action on evidence detail | **DEFERRED (lower priority now)** | The endpoint exists (`POST /v1/evidence/:id/reports/regenerate`, owner-only) but the detail Artifacts tab's stale-pending banner offers only "Re-check status". Adding a regenerate action needs a new handler + owner-gate + loading state plumbed through `_lib.tsx`/`[id]/page.tsx` + a button, and browser validation (a stuck-report evidence to see the banner) not reproducible locally. **R4's lifecycle-recovery reconciler already auto-recovers stuck reports**, so the systemic fix is in place; the manual button is now a convenience. Deferred with plan. | — |

**R8 gate status: GREEN** for the implemented fixes (F15, F37) + F5/F32 verified non-issue. F16 deferred (browser-validation-gated UI; R4 covers the systemic case). **Milestone: all three package suites (API/web/worker) are now fully green — zero failures anywhere.** Files: `evidence.saved-views.routes.ts` + 3 admin pages changed; 1 new test.

## R9 Execution Log (Phase R9 — Case / team / workspace / ownership consistency)

Branch: `remediation/r1-bulk-legal-hold-gate` (continued). Verification: API typecheck 0;
case/matter suites 245/0; **full API suite 17,431 / 0**; new R9 test 3/3.

| Finding | Outcome | Change | Tests |
|---------|---------|--------|-------|
| **F22** Soft-deleted evidence remains in case UI + inflates counts | **FIXED** | A trashed evidence row keeps its legacy `caseId` (and its `CaseEvidenceLink` survives), but the case/matter evidence views filtered by `caseId` / `id in evidenceIds` with NO `deletedAt: null`. Added it to: `case-workspace.service.ts` linked-evidence count, recent count, linked list, and case timeline list; `matter-workspace.service.ts` evidence board. Deleted evidence no longer renders as linked or counts toward linked totals. | `phase-r9-case-evidence-soft-delete.test.ts` (3) |
| **F10** Unlink clears `teamId` (scope loss) | **DEFERRED (auth-entangled; needs migration)** | Re-confirmed: `teamId` is authorization-bearing (`getEvidenceWithReadAccess:2527` grants team read). The current behavior is a genuine tradeoff on ONE overloaded column — `null`-on-unlink correctly REVOKES access for personal-evidence-attached-to-team-case, but wrongly orphans TEAM-owned evidence to personal scope. Neither direction is fully correct without SEPARATING case-scope from workspace-home. Fix = the canonical migration: route case attach/unlink exclusively through `CaseEvidenceLink` (which never touches `teamId`) + a durable workspace-home column, then stop the legacy `Evidence.caseId`/`teamId` mutation. Big, auth-changing, data-migration + browser-validation required. Deferred with plan. | — |
| **F9** Case tenant post-fetch filtering | **DEFERRED (no bug; hardening)** | Post-fetch authorization is present and correct (verified R1 — no actual bypass). Query-layer tenant pre-scoping is defense-in-depth that risks changing pinned 404/403 semantics; belongs with the F10 case-model migration + full-suite validation. | — |

**Not attempted in R9 (no audit finding + belongs elsewhere):** DB-level invariants (partial indexes / FK cascade tightening / a canonical-current constraint) are additive **schema** changes — deferred to **R11** (the schema phase) per the "additive-first, schema changes batched" discipline. Ownership-transfer / team-offboarding had no specific finding and weren't touched.

**R9 gate status: GREEN for F22** (the concrete, safe consistency bug). F10 + F9 deferred with a shared migration plan (separate case-scope from workspace-home via `CaseEvidenceLink`); DB invariants routed to R11.

## R10 Execution Log (Phase R10 — Worker / queue / cron / distributed-system hardening)

Branch: `remediation/r1-bulk-legal-hold-gate` (continued). Verification: worker typecheck
0; **worker suite 813 / 0**; worker build 0; new R10 test 5/5. Runtime note: true
multi-replica proof (two workers, one skips per tick) needs 2 worker instances + Redis;
verified via mocked-Redis behaviour (acquire/held/fail-open/check-and-delete) + source
contracts + build.

| Finding | Outcome | Change | Tests |
|---------|---------|--------|-------|
| **F12** Crons use boolean guards, not distributed locks (multi-replica double-run) | **FIXED** | New `cron-lock.ts#withCronLock` — Redis `SET key val NX PX ttl` advisory lock with Lua check-and-delete release, TTL-bounded (crashed holder auto-frees), **fail-OPEN** on Redis error (never worse than pre-R10). Wrapped the 5 state-mutating reconcilers whose double-run is genuinely harmful: retention-reconciliation, destruction-orchestrator, immutable-storage-reconciliation, archive-tier-auto-transition, reviewer-ops-reconciliation. The per-process boolean flag stays as the cheap intra-process guard; this adds the cross-process layer. Read-only/idempotent crons (orphan-scan, lifecycle-recovery, mfa-gc) left unwrapped by design. No schema change (Redis, not a lock table → avoids R11). | `phase-r10-cron-lock.test.ts` (5) |
| **F13a** report-dlq replay | **NON-ISSUE (verified R4)** | Generic operator replay surface already covers report-dlq. | — |
| **F13b** `org-health-refresh` producer-less queue | **CONFIRMED orphan — documented** | Verified: NO producer anywhere enqueues it; the registered consumer is idle (never receives jobs). Harmless (idle worker registration), but a genuine orphan. Deletion touches the queue helper + processor + registration for a "Phase 37.98" surface that may be unfinished-vs-abandoned; wiring needs product intent (when/how org-health refreshes). **Recommendation:** wire a scheduled producer (e.g., a locked cron enqueuing per-team) OR remove the consumer — a product decision, not a mechanical fix. Deferred with recommendation. | — |
| **F14** Double-completion re-enqueue churn | **ACCEPTED (verified R4)** | Harmless (jobId dedup) + provides a complementary recovery path. | — |

**Also noted (from the R4 worker/queue map, low-harm, documented not forced):** (1) capture-draft expiry is scanned by BOTH the API `capture-draft-expiry-sweep` and the worker `capture-reaper` — cross-SERVICE duplication the worker-only cron lock does not cover; idempotent (deleting already-expired = no-op), so low-harm; consolidating to one owner is a follow-up. (2) `retention-cleanup.ts` is an unscheduled one-shot script — intentional-vs-gap is unclear; the scheduled governance reconcilers (now locked) cover ongoing lifecycle, so this standalone script is likely a manual/external-cron tool; documented.

**R10 gate status: GREEN for F12** (the headline — distributed cron locks on the 5 harmful-to-double-run reconcilers). F13a/F14 verified non-issues (R4); F13b org-health orphan + capture double-schedule + retention-cleanup documented with recommendations (wire-or-remove needs product intent). Files: `index.ts` (+95); added `cron-lock.ts`, `phase-r10-cron-lock.test.ts`.

## R11 Execution Log (Phase R11 — Database / schema / migration consistency)

Branch: `remediation/r1-bulk-legal-hold-gate` (continued). Verification: **`prisma validate`
passes** (schema internally valid, no DB needed); full API suite **17,437 / 0** (compiles
against the generated client → schema↔code consistent); new R11 test 6/6. **No schema
migration was applied** — this environment has no database (or shadow DB), so an
untested migration on a forensic prod schema would violate the safety rules; `migrate
diff` drift-vs-DB is not runnable here (needs a shadow DB). The mandate's "fix OR
document" is satisfied via invariant pins + classification + a validated plan.

**F26 — precise classification (correcting the audit):**

| Item | Verdict | Detail |
|------|---------|--------|
| `Evidence.teamId` nullable "should be invariant" | **INTENTIONAL — audit WRONG** | `teamId === null` IS the personal-scope signal; making it non-null would break personal capture entirely. Pinned via test so nobody "fixes" it into a regression. The real tenancy invariant (`team_id ⇒ organization_id`) already exists as the Phase-A1 migration + check. |
| `Evidence.verificationStatus` nullable | **LOW-VALUE — document** | Not the source of truth (R8 proved counters/reports read authoritative sources). A non-null backfill is risk without benefit. |
| Report vs VerificationPackage cascade asymmetry | **REAL but LATENT — document + recommend** | `Report` = Restrict (no `onDelete`), `VerificationPackage` = `onDelete: Cascade`. Only fires on HARD-delete; evidence uses soft-delete, so latent. Recommend aligning BOTH to Restrict (forensic-safe — never silently drop a report/package). Needs a DB-validated migration. |
| No `isCurrent` on Report/Package | **PARTIALLY HANDLED — R3** | "Current" is tracked via denormalized `Evidence.latestReportVersion` / `verificationPackageVersion`, not a row flag. The full canonical current/superseded model = R3 (`EvidenceVerificationRecord`). |
| Missing indexes | **NOT SPECULATIVELY ADDED** | Schema is already heavily indexed (Evidence alone has ~15 `@@index`). Adding indexes without query-plan (`EXPLAIN`) analysis risks redundant write-amplifying indexes. Needs deployed-DB analysis; documented. |
| Write-only / read-only fields | **ALREADY ANNOTATED — document** | The schema itself annotates pending/dead fields ("no current writer populates them"). No action; tracked. |
| Schema↔migration drift | **UNVERIFIABLE HERE** | `migrate diff` needs a shadow DB. `prisma validate` (schema valid) + the passing API suite (client compiles) are the available proxies; full drift check deferred to CI/deployed env. |

| Finding | Outcome | Change | Tests |
|---------|---------|--------|-------|
| **F26** Schema invariant gaps | **CLASSIFIED + PINNED (no risky migration)** | Comprehensive forensic schema-invariant contract test: custody hash-chain (`@@unique[evidenceId,sequence]` + prev/eventHash), Report/Package versioning (`@@unique[evidenceId,version]`), `EvidenceLegalHold.teamId` non-null (guards F2), Evidence crypto fields present, **`Evidence.teamId` intentionally nullable** (personal-scope), Phase-A1 tenancy migration exists. Locks the schema against silent weakening. | `phase-r11-schema-invariants.test.ts` (6) |
| **R9 DB invariants** (parked here) | **DEFERRED — needs DB** | The genuinely-useful invariant (a durable workspace-home column separate from case-scope) is the F10/F9 `CaseEvidenceLink` migration — a data migration, not a constraint. Cascade alignment + any index additions need a validated migration against a real DB. |

**R11 gate status: GREEN for the invariant pins + classification.** No schema migration applied (correctly — unvalidatable against a forensic DB here). Deliverables: F26 classified (audit corrected on `teamId`), 6 forensic invariants pinned, migration recommendations (cascade alignment, index EXPLAIN analysis) documented for the deployed env. Files: `phase-r11-schema-invariants.test.ts` (new).

## Phase gate order (dependency-sorted)

R0(done) → **R1** (F1✅,F2⚠️,F9,F10,F23) → R2 (F7,F8) → R3 (F3,F5,F20,F24) → R4 (F4,F14) → R5 (F6,F33) → R6 (F11) → R7 (F17,F18,F19 + all families) → R8 (F15,F16,F32) → R9 (F10,F22) → R10 (F12,F13) → R11 (F26) → R12 (F27) → R13 (F24,F25) → R14 (F21,F30,F31) → R15 (F28) → R16 (F29,F34,F35) → R17 (E2E).
