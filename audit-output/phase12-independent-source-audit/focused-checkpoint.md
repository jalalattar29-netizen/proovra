# Focused Reachability Closure — Checkpoint

Revision `a7863bec33f10549d84a839ee7ab353509626a2a` · clean tree · read-only.
This pass supersedes the prior PARTIAL_BASELINE. Prior inventory preserved; prior conclusions revalidated.

## FC-01 Migration correction [DONE]
Prior claim "destructive DROP only in comments" WITHDRAWN AS FALSE. Cause: comment-strip on `^\s*--`
plus treating `DROP TABLE IF EXISTS` as guarded; dynamic SQL in `DO $$ … EXECUTE format()` was invisible.
Read in full: persona precondition+drop, evidence.case_id removal, legal-hold legacy removal, Point-4
contract. All correctly guarded; guard always PRECEDES the drop. Residual = artifact assembly (UNK-001).

## FC-02 Reachable graph [DONE]
Import-graph BFS from API(1) / Worker(1) / Web(242) / Mobile(18) / Script(52) seeds.
Resolver defects found and fixed mid-pass (side-effect imports dropped; then multi-line bindings dropped).
Final: 1767 non-test code files → REACHABLE 1658 (API 776, Web 723, Worker 111, Mobile 48),
SCRIPT_ONLY 52, BUILD_ONLY 11, TYPE_ONLY 5, UNREACHABLE_CANDIDATE 41.
All 41 re-verified by exact import-path grep → 14 DEAD_UNREACHABLE confirmed.

## FC-03 Dead authority discovery [DONE]
Automation execution engine (dispatcher/actions/delivery-runtime) is a closed mutual-import cluster with
zero external importers and is the SOLE writer of AutomationRun + AutomationWebhookDelivery → ARCH-005.
authorization-allowlist.ts: zero production importers, PENDING array empty while status-blind gates exist
→ feeds AUTH-004. require-enterprise-feature.ts dead duplicate; live gate is billing-enforcement.service.

## FC-04 Route gate equivalence [DONE]
1081 routes mapped to the gate they ACTUALLY call; every per-file helper body read and classified.
CANONICAL_VIA_HELPER 419 · CANONICAL_INLINE 101 · STATUS_AWARE_HELPER 89 · PUBLIC_OR_FILE_LEVEL 77 ·
AUTHENTICATED_ONLY 283 · PLATFORM_ADMIN 38 · INLINE_MEMBERSHIP_CHECK 28 · STATUS_BLIND_HELPER 17 ·
CRON 12 · TOKEN_SCOPED 10 · POLICY_ENGINE 6 · INTERNAL 1.
Corrects prior "101/1081" → 526 reach the canonical primitive.

## FC-05 CRITICAL discovery [DONE]
external-portal.routes.ts:187 resolveInternalTeam authorizes off User.currentWorkspaceId with NO status
check and returns success for a caller with NO membership (workspaceRole null). 8 of 12 callers add
requireCap (fails closed on null role); routes at :341 :430 :637 :1033 add nothing.
Confirmed membership revoke/suspend never clears currentWorkspaceId (membership-provisioning + rbac).
→ SEC-001 CRITICAL.

## FC-06 Prior HIGH findings revalidated [DONE]
AUTH-001 intelligence.routes.ts:80/:101 — reconfirmed by re-read.
AUTH-002 me-inbox.routes.ts:875/943/2559/2620 — reconfirmed.
AUTH-003 case-permission.service.ts:309 — reconfirmed.
AUTH-004 — restated with measured adoption numbers.

## FC-07 Writers / web / mobile [DONE]
1188 write sites (1093 reachable), 269 raw SQL (252 reachable), 256 models.
TeamMember 2 files · OrganizationMembership 1 · CaseEvidenceLink 1 · EvidenceLegalHold 1.
Web 1346 actions, 4 empty-handler candidates all read and cleared → DisconnectedWebActions 0.
Mobile 18 screens / 43 onPress / 0 empty / 24 endpoints; 1 disconnected surface (Teams tab).

## FC-08 Queue [DONE] 17 queues / 15 workers / 2 by-design DLQs / 17 registry names; orphans 0.

## CLOSURE
UnclassifiedReachableNodes = 0. Artifacts: focused-checkpoint.md, reachable-graph.json,
authority-matrix.json, backend-route-matrix.json, database-writer-matrix.json, web-action-matrix.json,
mobile-action-matrix.json, queue-runtime-matrix.json, findings.json, focused-final-report.md.
1 CRITICAL · 5 HIGH · 8 MEDIUM · 6 LOW · 4 UNKNOWN_BLOCKED.
No production file, schema, migration, config or test modified/read/executed.
