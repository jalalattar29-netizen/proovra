# Caller-less write routes: classification register

Finding: PRO-CENZ-01. Owner decision K, 2026-11-21. Source state: origin/main
`9c76edede` plus branch `closure/shell`; updated by closure phase 2, branch
`closure2/ui` (base `2307542a8`), for the evidence, request and external-review
routes, decisions I and G, and the obsolete set (see "Closure phase 2" below).
The organization and SIU rows (EP-0806, EP-0842..0844, EP-1082..1086) belong to
the parallel `closure2/ui2` lane and are unchanged here.

## Where the list comes from

The audit census lists 44 write routes as LIVE_NO_CLIENT: no shipped web,
native, extension, shared-package or worker caller.
- Census file: `D:\pw\pro-audit-cdcb8ae\final\census\ENDPOINT-CALLERS.csv`, classification `LIVE_NO_CLIENT`, methods POST/PUT/PATCH/DELETE.
- Each route was re-checked at 9c76edede:
  - registration line and whether it is still live;
  - its guards;
  - a fresh caller grep across `apps/web`, `apps/mobile`, `apps/extension`, `packages`, `services/worker`;
  - evidence of intent from docs/, `services/api/scripts/capability-authority/manifests/route-dispositions.json` ("disp"), `docs/architecture/current-runtime-capability-map.json` ("capmap"), `docs/architecture/route-classification/*.json`, runbooks, product copy and git history;
  - route-level authorization tests.

## Rules (decision K)

- Having no client caller does not make a route defective.
- Supported API behaviour is kept, with its authorization tests.
- A missing promised control is wired only where it is clearly absent and small. Otherwise it is listed below with the exact UI location.
- Only demonstrably obsolete routes are retired, with a compatibility note. There is no bulk deletion.

### Classes

| Class | Meaning |
|---|---|
| SUPPORTED_API_ONLY | Deliberate API behaviour, documented or tested as such. |
| MISSING_INTENDED_UI | Product copy, docs or the disposition plan promise a control that is absent. |
| NON_CLIENT_INTEGRATION | A legitimate caller that is not a browser or app, such as operator tooling named in a runbook. |
| OBSOLETE | Superseded by a route the clients use. Nothing documents it as intended. |
| NOT_CALLER_LESS | A first-party caller now exists. The route leaves the finding. |

## Totals

| Class | Count |
|---|---|
| SUPPORTED_API_ONLY | 20 (EP-0449 moved here in phase 2) |
| NON_CLIENT_INTEGRATION | 1 (EP-0538) |
| MISSING_INTENDED_UI | 0 (the 9 organization and SIU rows were wired on `closure2/ui2`) |
| OBSOLETE | 7: 5 are typed tombstones (EP-1111 refusal tombstone; EP-0425, EP-0446, EP-0934, EP-1066 retired in phase 2); 2 kept with a sunset (EP-0219, EP-0261) |
| NOT_CALLER_LESS | 16 (EP-0273, EP-1081, EP-1118; phase 2: EP-0343, EP-0379, EP-0389, EP-0450; ui2: EP-0806, EP-0842..0844, EP-1082..1086) |
| **Total** | **44** |

Phase-2 moves: EP-0343, EP-0379, EP-0389, EP-0450 MISSING_INTENDED_UI → NOT_CALLER_LESS;
EP-0449 OBSOLETE → SUPPORTED_API_ONLY; EP-0425, EP-0446, EP-0934, EP-1066 OBSOLETE
(live) → OBSOLETE (retired to typed 410 tombstones). EP-0538 is confirmed
NON_CLIENT_INTEGRATION.

## Register

Abbreviations in the "Authorization test" column:
- "new: ws-shell-caller-less" means `services/api/test/ws-shell-caller-less-authz.integration.test.ts`, added on this branch.
- Other test files are named without the `.integration.test.ts` suffix, under `services/api/test/`.

| EP | Route | Class | Evidence | Authorization test (refusal) | Action |
|---|---|---|---|---|---|
| EP-0164 | POST /v1/capture/devices | SUPPORTED_API_ONLY | capture-trust.routes.ts header UC-ARCH-007 ("server-only, de-scoped"); disp MISSING_PRODUCT_UI_POST_RELEASE "UC-2 prerequisite, grants no trust today"; web copy CaptureDevicesSection.tsx "No PROOVRA app or extension registers capture devices… yet"; test/capture-trust-client-surfaces.test.ts pins "no client registers a capture device" | free-audit-g1-reach "B4-F-204: a Viewer cannot register a capture signing device"; runtime-proof-evidence-capture-a "POST /v1/capture/devices refuses a personal-space caller and a foreign workspace pointer…" | Keep |
| EP-0174 | POST /v1/capture/direct-sessions/:id/attestation | SUPPORTED_API_ONLY | Same UC-ARCH-007 header; disp UC-2 prerequisite (Play Integrity / App Attest); the verifier fails closed | **new**: ws-shell-caller-less "EP-0174 attestation: another member and another tenant get the unknown-session answer…" | Keep; authz test added |
| EP-0219 | POST /v1/cases/:id/share-team | OBSOLETE (kept, sunset) | disp SUPERSEDED_REMOVE, replaced by POST /v1/cases/:id/access (MatterAccessTab.tsx:272). The web called it until 7243702f9 (2026-09-17); no native or extension build ever did (git log -S"share-team" over apps/mobile finds only a copy string). | members-reaudit2-case-reach "…POST /access, share-team and team-access with themself are concealed 404"; ws-reach-roots "share-team: a MEMBER cannot restrict…" | Phase 2: kept. It is the one obsolete route with a historical first-party caller, and a pre-2026-09-17 web tab cannot be ruled out without access logs. Sunset: retire to a typed 410 (canonical POST /v1/cases/:id/access) once the lead's production access-log check shows zero calls for 30 days |
| EP-0220 | POST /v1/cases/:id/share-email | SUPPORTED_API_ONLY | disp INTENTIONALLY_BACKEND_ONLY "SECURITY_SENSITIVE_NO_UI"; cases.routes.ts route comment (D6 uniform answer); MatterAccessTab.tsx "share-email exists for address-based callers" | matter-access-tab "a non-manager MEMBER is refused 403; another tenant is answered exactly as a missing case" | Keep |
| EP-0261 | POST /v1/collaboration-team-invites/:token/accept | OBSOLETE (kept, sunset documented) | disp SUPERSEDED_REMOVE, replaced by the body form `/accept` (web collaboration-teams.ts, mobile invite/[token].tsx). Shipped native builds before the body form used the path-token accept (apps/mobile/app/(stack)/invite/[token].tsx:78 "This used to POST to /v1/collaboration-team-invites/:token/accept"). Route comment WCR-20 keeps it for stale clients "until no PENDING legacy invitation can be in flight"; the create route already answers 410. | cov-page-apis "a member who is not the addressee is refused…" | Phase 2: kept (shipped native builds depend on it). Sunset unchanged: no PENDING legacy invitation in flight and the oldest supported native build uses the body form |
| EP-0273 | POST /v1/collaboration/threads | NOT_CALLER_LESS | Web EvidenceDiscussionPanel.tsx and mobile evidence-discussion.tsx call it since 62027182e (2026-11-18, RG-31) | case-reach-matrix "…a thread cannot be opened on it"; free-audit-0ea0-lane-b "a Viewer, a foreign thread id and a restricted record all look missing" | Leaves the finding |
| EP-0343 | PATCH /v1/evidence-requests/:id | NOT_CALLER_LESS (phase 2) | Capability `evidence_request.create` (same as Send), DRAFT only, record/case reach, assignee in workspace. Intended user: whoever manages requests. Promise: disp "DRAFT edit has no control" | runtime-proof-evidence-capture-b "PATCH refuses a viewer (403), a non-member (404) and an assignee from another tenant (400)…" | **Wired (phase 2)**: EditDraftRequestDialog from EvidenceRequestPanel (DRAFT rows) and the request page (managers, DRAFT) |
| EP-0379 | PATCH /v1/evidence/:id/annotations/:annotationId | NOT_CALLER_LESS | Author-only (DEC-15 / PRO-E2-03); the API projects viewerCanEdit | ws-reach-privacy "PRO-E2-03 — a manager cannot rewrite another member's annotation (403 AUTHOR_ONLY_EDIT); the author can" | Verified on main (86bdc21ef). Phase 2: Edit now fails closed (`viewerCanEdit === true`; a row without the projection gets no Edit) |
| EP-0389 | PATCH /v1/evidence/:id/relationships/:relationshipId | NOT_CALLER_LESS (phase 2) | Capability `evidence.update_metadata` on this record, the link's open end, record open for writes (PRO-E2-05). Promise: disp "relationship edit has no control" | case-reach-matrix "a relationship cannot be edited or removed through its open end"; closure2-ui-caller-less "EP-0389 PATCH relationship: a writer changes type and note; a VIEWER and another tenant change nothing" | **Wired (phase 2)**: Edit relationship (type, note) beside Remove in EvidenceRelationshipsSection.tsx |
| EP-0425 | POST /v1/external-review/invitations | OBSOLETE, **retired (phase 2)** | DEC-01: one issuing path, `/invitations/bulk` (console page.tsx and ExternalReviewSubjectPanel.tsx). No web, native, extension, worker or script caller ever (git log -S"external-review/invitations" over apps/mobile and apps/extension: none; apps/web uses only GET). It duplicated /bulk and returned the raw bearer token to any administrative-tier caller, where the product's only reveal (reveal-token) is OWNER-only break-glass | closure2-ui-caller-less "retired to typed 410 tombstones…"; cov-external-reviewer "a member without the tier, and no step-up, issue nothing…" (tombstone + /bulk refusals); runtime-proof-collab-teams-inbox-b | Typed 410 `EXTERNAL_REVIEW_SINGLE_INVITATION_RETIRED`, canonical /bulk; GET list unchanged |
| EP-0446 | POST /v1/external-review/invitations/:id/send-email | OBSOLETE, **retired (phase 2)** | disp SUPERSEDED_REMOVE, replaced by `/resend` (console page.tsx). It mailed invitations the retired single-issue route issued without email; /bulk emails on issue. No first-party client ever called it | closure2-ui-caller-less; phase-12-sec-001-stale-pointer "SEND-EMAIL…"; tenant-reach-a2-round3; cov-external-reviewer "delivery and reveal…" (now through /resend) | Typed 410 `EXTERNAL_REVIEW_SEND_EMAIL_RETIRED`, canonical /resend |
| EP-0447 | POST /v1/external-review/grants | SUPPORTED_API_ONLY | disp "primitive grant issue… product issues through the invitations layer"; fully gated (legal_hold.manage, entitlement, step-up), lifecycle-tested | runtime-proof-collab-teams-inbox-b "…a MEMBER and a foreign owner are refused" | Keep |
| EP-0449 | POST /v1/external-review/grants/:id/revoke | SUPPORTED_API_ONLY (phase 2) | The revoke counterpart of the kept primitive EP-0447 (same teamId addressing, same `governance.legal_hold.manage` authority); protective, never plan-gated. The invitation revoke asks a different authority (review.assign + administrative tier, current workspace) | ws-shell-caller-less "EP-0449 grant revoke: a member without the manage capability and another tenant's owner revoke nothing…" | Keep. Sunset: retired together with EP-0447 if the primitive grant family is retired |
| EP-0450 | POST /v1/external-review/grants/:id/renew | NOT_CALLER_LESS (phase 2) | Capability `governance.legal_hold.manage`, subject reach, External Review entitlement, step-up EXTERNAL_REVIEW_GRANT_ISSUE bound to the grant; audited `external_review.grant_renewed`. Promise: members-and-access-model.md SEC-08 "renewal an explicit audited action" | tenant-reach-a2-round3 "revoked reach…"; closure2-ui-caller-less "EP-0450 — the grant lists project whether THIS viewer may renew" (3 cases) | **Wired (phase 2)**: Renew in ExternalReviewSubjectPanel and the console drawer, offered only where GET /grants and GET /invitations project `viewerCanRenew` |
| EP-0469 | POST /v1/governance/lifecycle/evidence/:id/transition | SUPPORTED_API_ONLY | disp INTENTIONALLY_BACKEND_ONLY "SECURITY_SENSITIVE_NO_UI"; the product path is destruction reviews; DESTROYED refused 409 | lifecycle-force-destroy-refused "another tenant is still concealed…"; auth-factors-step-up-integrity "matrix review 6.1 …" (quarantine 403) | Keep |
| EP-0487 | POST /v1/governance/legal-holds | SUPPORTED_API_ONLY (temporary compatibility) | slice-d.json INTENTIONALLY_API_ONLY; wiring-registry INTENTIONALLY_INTERNAL; disp COMPATIBILITY_TOMBSTONE, replaced by /v1/lifecycle/legal-holds; governance.routes.ts lists six removal conditions (backfill, convergence report, removal migration, zero production traffic) | phase-12-trust-administration-residue-matrix "every mutating adapter refuses without the manage capability and writes NOTHING"; cov-legal-hold-contract "before the term: every placement route refuses…" | Keep until its in-code removal conditions are met |
| EP-0488 | POST /v1/governance/legal-holds/:id/release | SUPPORTED_API_ONLY (temporary compatibility) | as EP-0487 | residue matrix (as above); "PRO-G2-12: a CASE hold id on the evidence release route is refused before any write" | Keep |
| EP-0490 | POST /v1/governance/case-legal-holds | SUPPORTED_API_ONLY (temporary compatibility) | as EP-0487 | residue matrix; cov-legal-hold-contract | Keep |
| EP-0491 | POST /v1/governance/case-legal-holds/:id/release | SUPPORTED_API_ONLY (temporary compatibility) | as EP-0487 | residue matrix; "releasing a case hold enforces the workspace approval gate BEFORE any release" | Keep |
| EP-0538 | POST /v1/identity-security/sessions/revoke | NON_CLIENT_INTEGRATION (operator tooling, confirmed phase 2) | docs/runbooks/suspicious-login-burst.md:16. Authority verified: `identity.access_review.action` (OWNER/ADMIN only), Enterprise `sessionGovernance`, DEC-08 org-governed identities only, step-up for another person's session (decision C); one's own current session is a sign-out. It addresses a session by hash (what a security event carries), the admin console route by inventory id, so it is not superseded. disp updated to ADMIN_OPERATOR | free-audit-g2-identity NEW-RG08-2 block (allowed with step-up, refused without, DEC-08, cross-workspace); closure2-ui-caller-less "EP-0538 … a MEMBER and a VIEWER are refused 403 and another tenant 404; no session ends" | Keep, API-only. Authz not weaker than operator use requires: no change |
| EP-0615 | POST /v1/intelligence/evidence/:evidenceId/run/bytes | SUPPORTED_API_ONLY | disp INTENTIONALLY_BACKEND_ONLY "SECURITY_SENSITIVE_NO_UI"; the governed product path is /media-intelligence/run; D62 provenance | defects-intelligence-run-bytes "answers another workspace's evidence exactly like a missing one" | Keep |
| EP-0655 | POST /v1/me/inbox/items/:itemKey/remind | SUPPORTED_API_ONLY | inbox/page.tsx comment: the row action was removed by product choice and the endpoint stays for existing clients (disp and capmap are stale on this) | runtime-proof-collab-teams-inbox-a "every per-item action refuses an unauthenticated caller (401) and a malformed key (400)…" (state is per user) | Keep |
| EP-0657 | POST /v1/me/inbox/items/:itemKey/undismiss | SUPPORTED_API_ONLY (alias) | disp COMPATIBILITY_TOMBSTONE, alias of unarchive, boot-checked in LEGACY_ACTION_ALIASES | as EP-0655 | Keep |
| EP-0658 | POST /v1/me/inbox/items/:itemKey/snooze | SUPPORTED_API_ONLY (alias) | disp COMPATIBILITY_TOMBSTONE for shipped mobile builds; phase-ia-reliability-inbox-state pins it | as EP-0655 | Keep |
| EP-0806 | POST /v1/orgs/:id/policies/retention | NOT_CALLER_LESS (closure2/ui2) | Was MISSING_INTENDED_UI: the Retention tab told admins to "publish a template from Evidence Lifecycle → Retention", which only posts the workspace route. Now web `apps/web/app/(app)/organizations/[id]/admin/retention/page.tsx` publishes the template (retentionDays or indefinite, floor flag, description), offered only on the new read projection `viewer.canPublish` (the POST's own gate: ORG_OWNER/ORG_ADMIN of a CUSTOMER organization); the wrong copy is gone | org-persona-authorization-matrix "write: publish the retention template"; **new**: closure2-ui2-org-siu-callers "viewer.canPublish agrees with the publish route for every organization role; a non-member and a SYSTEM organization get neither" | Leaves the finding |
| EP-0842 | POST /v1/orgs/:id/data-export | NOT_CALLER_LESS (closure2/ui2) | Was MISSING_INTENDED_UI (GOV-015, 29a7277d2; CustomerContractPanel.tsx copy). Now web `apps/web/app/(app)/organizations/[id]/_components/OrgDataExportPanel.tsx`, mounted on the organization page's owner-only lifecycle card for `callerRole === "ORG_OWNER"` on a CUSTOMER organization: history, request with the step-up proof in the body, one active request | governance-remediation-rem3 "only the organization owner may ask…"; **new**: closure2-ui2-org-siu-callers "the owner requests with a step-up; another organization's owner creates nothing"; "the owner of a SYSTEM organization is refused the export" | Leaves the finding |
| EP-0843 | POST /v1/orgs/:id/data-export/:requestId/manifest | NOT_CALLER_LESS (closure2/ui2) | Same panel: "Download manifest" saves the server's bytes (SHA-256 shown) | ws-shell-caller-less "EP-0843 / EP-0844 …"; **new**: closure2-ui2-org-siu-callers "a READY export is read only through its own organization: another organization's request id, org id or records are never reached" | Leaves the finding |
| EP-0844 | POST /v1/orgs/:id/data-export/:requestId/links | NOT_CALLER_LESS (closure2/ui2) | Same panel: paged sealed-version links (offset), withheld-by-hold count | as EP-0843 | Leaves the finding |
| EP-0934 | PATCH /v1/redaction/policy | OBSOLETE, **retired (phase 2)** | disp COMPATIBILITY_TOMBSTONE "legacy unversioned policy write… back-compat shim", replaced by POST /v1/redaction/policies plus version transitions (web redaction/policy/page.tsx). git log -S'"/v1/redaction/policy"' over apps/web and apps/mobile: no commit | ws-shell-caller-less "EP-0934 PATCH /v1/redaction/policy (retired)…"; closure2-ui-caller-less | Typed 410 `REDACTION_POLICY_PATCH_RETIRED`, canonical /v1/redaction/policies; GET unchanged |
| EP-0980 | POST /v1/reviewer-ops/reviews/:workflowId/reassign | SUPPORTED_API_ONLY | docs/runbooks/workflow-stuck.md:18 operator step; disp PRESERVED_POST_RELEASE_CONTRACT "no product contract to build"; same guards and service as /assign | members-assignment-surfaces "REV-05 — … cannot hand out reviews; review.assign can"; "console reassign: an unplaced member is refused…" | Keep |
| EP-1066 | POST /v1/search/relationships | OBSOLETE, **retired (phase 2)** | Duplicated POST /v1/evidence/:id/relationships (web EvidenceRelationshipDialog.tsx, native capture-links.ts). Native only ever READ GET /v1/search/relationships/:evidenceId | ws-shell-caller-less "EP-1066 POST /v1/search/relationships (retired)…"; case-reach-matrix "the search link route refuses a closed end and writes nothing" (tombstone + canonical route 404); closure2-ui-caller-less | Typed 410 `SEARCH_RELATIONSHIP_CREATE_RETIRED`, canonical /v1/evidence/{evidenceId}/relationships; GET read unchanged |
| EP-1067 | POST /v1/search/reindex/evidence/:id | SUPPORTED_API_ONLY | slice-c.json INTENTIONALLY_API_ONLY, "per-document operator escape hatch" | **new**: ws-shell-caller-less "EP-1067 … a non-operator, another tenant and a cross-tenant record index nothing…" | Keep; runtime authz test added |
| EP-1081 | PUT /v1/cases/:id/siu-profile | NOT_CALLER_LESS | Web SiuPanel.tsx:185 since 4da502569 (PRO-K1-10) | authz-coverage-defect-closures "SIU: a VIEWER writes nothing…"; ws-ent-enterprise-surfaces | Leaves the finding; status/field edits remain a follow-up |
| EP-1082 | POST /v1/cases/:id/siu-profile/checklist/:itemId/map-evidence | NOT_CALLER_LESS (closure2/ui2) | Was MISSING_INTENDED_UI (SiuPanel.tsx header; insurance-siu-workflows.md §2, §4). Now web `apps/web/app/(app)/cases/components/SiuReviewActions.tsx` (item editor in SiuPanel): "Map record" offers the case's records the reader can open (matter envelope), not yet mapped. Every SIU control is offered only on the new read projection `viewer.canWrite` from `siuCaseGateRefusal`, the function the write routes now share (Enterprise organization, case mutation matrix, case plan gate) | ws-ent-enterprise-surfaces "PRO-K1-04: a VIEWER is refused every SIU write…"; **new**: closure2-ui2-org-siu-callers "viewer.canWrite agrees with every SIU write for each role, then for the workspace once it stops being Enterprise" | Leaves the finding |
| EP-1083 | POST …/siu-profile/checklist/:itemId/status | NOT_CALLER_LESS (closure2/ui2) | Same editor: status + optional note | as EP-1082 | Leaves the finding |
| EP-1084 | POST …/siu-profile/indicators | NOT_CALLER_LESS (closure2/ui2) | Same editor: "Mark evidence gap" (MISSING_REQUIRED_EVIDENCE, severity); other indicator codes stay API-only (docs list only this reviewer action) | as EP-1082 | Leaves the finding |
| EP-1085 | POST …/siu-profile/follow-ups | NOT_CALLER_LESS (closure2/ui2) | Same editor: "Request follow-up" (due date, private note); intake-link binding stays API-only (§4 step 3 "Future") | as EP-1082 | Leaves the finding |
| EP-1086 | POST …/siu-profile/follow-ups/:followUpId/status | NOT_CALLER_LESS (closure2/ui2) | New "Follow-up requests" list in SiuPanel: status per row, returned record on received/satisfied | as EP-1082 | Leaves the finding |
| EP-1111 | DELETE /v1/teams/:id | OBSOLETE, already tombstoned | Zero mutations for every caller since 0ddb608dd; typed 403/409 with nextAction, pointing at POST /v1/teams/:id/closure. No native build ever sent DELETE /v1/teams/:id | workspace-lifecycle-no-hard-delete "non-owner — DELETE is a typed 403 and nothing moves"; runtime-proof-collab-teams-inbox-a | Phase 2: kept as is (refusal tombstone for old clients) |
| EP-1118 | POST /v1/teams/:id/leave | NOT_CALLER_LESS | Web WorkspaceMembersPanel.tsx (ee3e47afa) and mobile workspace-people.ts (4f456403d) | members-membership-commands "LIFE-15 — a MEMBER may leave; the OWNER may not" | Leaves the finding |
| EP-1124 | POST /v1/teams/:id/cases/link | SUPPORTED_API_ONLY | UI deliberately removed in 3065dc3b8 ("no case linking on Members & Access"); adopts legacy unworkspaced cases; members-and-access-model.md:304. The comment at apps/web/app/(app)/teams/[id]/page.tsx:1255 is stale. | members-access-convergence "ROLE-02 — an ADMIN cannot link another tenant's unlinked case…"; authz-coverage-defect-closures | Keep |
| EP-1125 | DELETE /v1/teams/:id/cases/:caseId | SUPPORTED_API_ONLY | Counterpart of link; UI removed with it; re-hardened in a9c1b4337 (PRO-T1-07) | ws-reach-roots "an ADMIN cannot detach someone else's case…" | Keep |
| EP-1138 | POST /v1/trust/articles | SUPPORTED_API_ONLY | Entitlement-gated customer authoring (ws-out-trust-center-entitlement "every other trust write is [customer-authored]"); no copy promises an in-app editor | members-delegated-admin "N-1: a workspace ADMIN and a MEMBER are refused…"; ws-out-trust-authoring "PRO-G2-13 …" | Keep |
| EP-1142 | POST /v1/trust/subprocessors | SUPPORTED_API_ONLY | as EP-1138 | free-audit-0ea0-lane-b "Trust Center authoring: a workspace without FEATURE_TRUST_CENTER is refused…"; members-delegated-admin | Keep |

All routes that are still caller-less (28 after phase 2) have at least one route-level authorization test with a refusal case. The three NOT_CALLER_LESS routes have one too. Seven routes had none and were given one on this branch:
- EP-0174
- EP-0449
- EP-0843
- EP-0844
- EP-0934
- EP-1066
- EP-1067: before this branch it had only source-regex checks.

## Missing UI: follow-ups with the exact location

| EP | Control | Where | Size |
|---|---|---|---|
| EP-0343 | Edit a DRAFT evidence request | **Wired on closure2/ui** (EditDraftRequestDialog) | done |
| EP-0389 | Edit a relationship type or note | **Wired on closure2/ui** (EvidenceRelationshipsSection) | done |
| EP-0450 | Renew an external-review grant | **Wired on closure2/ui** (ExternalReviewSubjectPanel, console drawer) | done |
| EP-0806 | Publish the organization retention template | **Wired on closure2/ui2** (retention/page.tsx) | done |
| EP-0842..0844 | Owner offboarding export: request, history, manifest download, paged links | **Wired on closure2/ui2** (`_components/OrgDataExportPanel.tsx` on the organization page) | done |
| EP-1082..1086 | SIU checklist status, indicators, follow-ups, map evidence | **Wired on closure2/ui2** (SiuPanel.tsx + SiuReviewActions.tsx) | done |

## Retirement: compatibility note

The repo's retirement pattern is a typed 410 tombstone that authenticates and
changes nothing. Examples:
- `services/api/src/routes/collaboration.routes.ts` (header);
- `/v1/api-keys*` in `enterprise.routes.ts`;
- `/v1/search/reindex/workflow/:id`.

EP-1111 is a refusal tombstone already.

Superseded by closure phase 2 (below): EP-0425, EP-0446, EP-0934 and EP-1066
are retired; EP-0449 is kept as API; EP-0219 and EP-0261 keep a sunset. The
original candidate list was:
- EP-0219: replaced by POST /access;
- EP-0446: replaced by /resend;
- EP-0449: replaced by invitations revoke;
- EP-0934: replaced by versioned policies;
- EP-1066: replaced by POST /v1/evidence/:id/relationships;
- EP-0425: DEC-01, needing the owner's confirmation against disp.

"Demonstrably obsolete" still needs one fact this branch cannot get: production
API access logs showing zero calls over a window. Shipped native builds and any
session-holding script would see a hard break, and there is no production
access here. Git history shows that no first-party client ever called EP-0446
or EP-0449, so they are the first to tombstone once the access-log check is
clean.

EP-0261 keeps its own documented sunset: it goes once no PENDING legacy
invitation can be in flight.

When one is retired:
1. Replace the handler with the 410 tombstone (authenticate, no reads or writes, a typed body naming the replacement).
2. Update the disp entry.
3. Convert that route's behaviour tests to the tombstone contract in the same commit.
4. Regenerate `pnpm audit:architecture`.

## Observations while checking (not changed here)

- EP-0449 revoke authorizes on `governance.legal_hold.manage` and the grant's team only. EP-0450 renew also checks the actor's reach to the grant's subject. A revoke is protective, so this is noted, not treated as a defect.
- Stale documents:
  - disp and capmap still say the web calls inbox `remind`;
  - disp has no entry for EP-0842..0844;
  - runbook 32 says there is no customer-facing export (closure2/ui2 wired the owner's export in the web; the runbook is still not updated);
  - `apps/web/app/(app)/teams/[id]/page.tsx:1255` claims case linking is still in the product.

## Closure-integration addendum (2026-11-21, `closure/integration`)

The register above is the census at 9c76edede. Three write routes added by other
closure branches also have no shipped web, native, extension or worker caller on
the integrated tree. They are recorded here so the register stays complete; none
is defective under decision K, and each has route-level authorization tests.

| Route | Branch / finding | Class | Authz tests | Action |
|---|---|---|---|---|
| POST /v1/evidence/:id/owner-destruction-approval | closure/money, MATRIX-M626 (decision I) | NOT_CALLER_LESS (phase 2) | m626-teamless-destruction-approval "the approval is the owner's, for this record and this trash cycle only — never retention, never another person"; "an Enterprise record needs its own governed approval; an owner approval is refused and does not count" | **Wired (phase 2)**: OwnerDestructionApprovalPanel on the trashed record page |
| DELETE /v1/evidence/:id/owner-destruction-approval | closure/money, MATRIX-M626 (decision I) | NOT_CALLER_LESS (phase 2) | same file (withdrawal); closure2-ui-caller-less (claimed → 409) | **Wired (phase 2)**: Withdraw, not offered while destruction is claimed |
| POST /v1/evidence-requests/:id/recipient-contact | closure/reach, NEW-RG-19-1 (decision G) | NOT_CALLER_LESS (phase 2) | new-rg-19-1-request-contact-reveal "a reveal without a step-up is refused…", "a role without the reveal authority (VIEWER) is refused (403)…", "cross-tenant…", "a request on a restricted case the caller cannot reach answers as missing" | **Wired (phase 2)**: masked contact + stepped-up, transient reveal on the request page |

## Closure phase 2 (`closure2/ui`, 2026-11-21)

Per route: actual method/path, capability, intended user, product promise, what
was done, and the tests. Web render tests are under `apps/web/__tests__/render/`
(real `apiFetch` over a stubbed fetch, RTL `cleanup()`); API tests are under
`services/api/test/`.

| EP | Route · capability · intended user | Promise | Change | Tests |
|---|---|---|---|---|
| EP-0343 | PATCH /v1/evidence-requests/:id · `evidence_request.create`, DRAFT only, record/case reach · request managers | disp "DRAFT edit has no control" | `apps/web/components/evidence-requests/EditDraftRequestDialog.tsx`: Edit draft on DRAFT rows (EvidenceRequestPanel.tsx) and on the request page for managers; deliverables sent only when changed (unedited fields carried over); contact never shown raw; 409 `request_not_editable` / 403 / 404 said | evidence-request-edit-draft.render (5); runtime-proof-evidence-capture-b (refusals) |
| EP-0379 | PATCH /v1/evidence/:id/annotations/:annotationId · author only · the annotation's author | error registry "the record panels offer Edit only to the author" | Verified on main (86bdc21ef); Edit now fails closed on a missing `viewerCanEdit` | annotation-panel-author-edit.render (4, +1 new); ws-reach-privacy PRO-E2-03 |
| EP-0389 | PATCH /v1/evidence/:id/relationships/:relationshipId · `evidence.update_metadata`, open end, open record · record writers | disp "relationship edit has no control" | Edit relationship (type, note) beside Remove in EvidenceRelationshipsSection.tsx; refusals said | evidence-relationship-edit.render (3); closure2-ui-caller-less "EP-0389 PATCH relationship…"; case-reach-matrix |
| EP-0450 | POST /v1/external-review/grants/:id/renew · `governance.legal_hold.manage` + reach + entitlement + step-up · workspace owner/admin | SEC-08 "renewal an explicit audited action" | The grant lists project `viewerCanRenew` (`services/external-review/external-review-renew-authority.ts`: every gate of the renew route but the challenge: permission, the same subject-reach predicate batched (a live reachable record or case, or a published package), entitlement, the step-up middleware's session-quarantine refusal, and the grant INVITED/ACTIVE and unexpired; review L-1); Renew (confirmed, 7 days, step-up) in ExternalReviewSubjectPanel and the console drawer only where projected | external-review-grant-renew.render (6); closure2-ui-caller-less EP-0450 (5, incl. trashed subject and quarantined session) |
| M626 | POST/DELETE /v1/evidence/:id/owner-destruction-approval (+ new read GET) · record owner, team-less sealed record in the trash · the legacy record's owner | decision I | OwnerDestructionApprovalPanel on the trashed record page, shown only when the GET offers it; approve with step-up; withdraw not offered while claimed; hold and earliest-deletion verdicts from the record projection | owner-destruction-approval.render (6); closure2-ui-caller-less M626 (2); m626-teamless-destruction-approval (7) |
| RG-19-1 | POST /v1/evidence-requests/:id/recipient-contact · reach + `workflow.intake_recipient_contact.reveal` + step-up · authorized operational users | decision G | Masked contact on the request page; Reveal only where `recipientContactRevealAuthorized` and no intake link; values held one minute or until Hide | evidence-request-contact-reveal.render (6); new-rg-19-1-request-contact-reveal (8) |
| EP-0425 | POST /v1/external-review/invitations · retired | DEC-01 one issuing path | Typed 410 tombstone → /bulk | closure2-ui-caller-less tombstones (2); cov-external-reviewer; runtime-proof-collab-teams-inbox-b; phase-3-external-review-grant-step-up; phase-rw-rbac-hardening |
| EP-0446 | POST /v1/external-review/invitations/:id/send-email · retired | replaced by /resend | Typed 410 tombstone → /resend | closure2-ui-caller-less; cov-external-reviewer; phase-12-sec-001-stale-pointer; phase-12-sec-001-completion; tenant-reach-a2-round3; phase-rw-rbac-hardening |
| EP-0934 | PATCH /v1/redaction/policy · retired | replaced by versioned policies | Typed 410 tombstone → /v1/redaction/policies | ws-shell-caller-less; closure2-ui-caller-less |
| EP-1066 | POST /v1/search/relationships · retired | duplicate of POST /v1/evidence/:id/relationships | Typed 410 tombstone → canonical link route | ws-shell-caller-less; case-reach-matrix; closure2-ui-caller-less |
| EP-0449 | POST /v1/external-review/grants/:id/revoke · `governance.legal_hold.manage` · API clients of the primitive grant route | revoke counterpart of EP-0447 | Kept (SUPPORTED_API_ONLY); sunset with EP-0447 | ws-shell-caller-less EP-0449 |
| EP-0538 | POST /v1/identity-security/sessions/revoke · `identity.access_review.action` (OWNER/ADMIN) + Enterprise sessionGovernance + DEC-08 + step-up · the Organization's security operator | runbook suspicious-login-burst step 2 | Kept API-only; authz verified sufficient, no change | free-audit-g2-identity NEW-RG08-2; closure2-ui-caller-less EP-0538 |
| EP-0219, EP-0261, EP-1111 | see the register rows | | Kept (sunsets stated; EP-1111 already a tombstone) | as listed |

Every retired route keeps `requireAuth`, reads and writes nothing, answers 410
with a stable code inside `error` and a `canonical` pointer, and has a
`COMPATIBILITY_TOMBSTONE` entry in route-dispositions.json. Its codes are
`internal` in the web error registry (no first-party caller).

## Closure phase 3: retirement compatibility (`closure3/sec`, 2026-11-22)

Scope: the four routes retired to typed 410 tombstones in phase 2 (EP-0425, EP-0446,
EP-0934, EP-1066), EP-0219 (kept, sunset pending an access-log check) and, for
completeness, the other two OBSOLETE rows (EP-0261, EP-1111). Production runs API
8e3b57ba3, which contains every tombstone below.

**What git history can and cannot show.** A `git log -S` over `apps/web`,
`apps/mobile` and `apps/extension` shows only whether a *first-party* build ever
called a route. It says nothing about customer scripts, integrations, curl users or
an old browser tab. "No first-party caller" is therefore the compatibility basis
for retiring, not a proof that nobody calls the route. Only production request logs
can settle usage.

### Per route

| EP | Retired / kept route (registration) | Compatibility basis | Canonical replacement and its behaviour | Proof the replacement works | Usage evidence available here | Status |
|---|---|---|---|---|---|---|
| EP-0425 | POST /v1/external-review/invitations, typed 410 `EXTERNAL_REVIEW_SINGLE_INVITATION_RETIRED` (external-portal.routes.ts:545) | DEC-01, one issuing path. No first-party caller ever: the web uses only the GET list on this path. The retired handler returned the raw bearer token to any administrative-tier caller. | POST /v1/external-review/invitations/bulk: tier + entitlement + `EXTERNAL_REVIEW_GRANT_ISSUE` step-up, emails on issue, never returns the token (reveal-token is OWNER-only break-glass) | cov-external-reviewer "a member without the tier, and no step-up, issue nothing; a foreign record is refused" and "POSITIVE: the invitation writes the grant, its role row, the activity and the tenant audit; the token is not stored" (18/18 on closure3/sec) | git history only (no first-party caller) | Retired. **Must not be reactivated**, even if calls are found: it is the unsafe token-returning path. A caller found in the logs is moved to /bulk. |
| EP-0446 | POST /v1/external-review/invitations/:id/send-email, typed 410 `EXTERNAL_REVIEW_SEND_EMAIL_RETIRED` (external-portal.routes.ts:1480) | It mailed invitations issued by the retired single-issue route, which sent no email; /bulk emails on issue. No first-party caller ever. | POST /v1/external-review/invitations/:id/resend: same authority as issue, re-mints and mails | cov-external-reviewer "delivery and reveal: the email goes to the reviewer, and reveal retires the token it replaces" (uses /resend) | git history only | Retired |
| EP-0934 | PATCH /v1/redaction/policy, typed 410 `REDACTION_POLICY_PATCH_RETIRED` (redaction.routes.ts:1351; GET at :1040 unchanged) | Unversioned back-compat shim ("COMPATIBILITY_TOMBSTONE" in disp). No web or native commit ever sent it. | POST /v1/redaction/policies, then versions and assignments (FEATURE_REDACTION entitlement, policy audit) | **new** closure3-retirement-canonical "EP-0934: PATCH /v1/redaction/policy answers 410 and writes nothing; POST /v1/redaction/policies creates the versioned policy" | git history only | Retired |
| EP-1066 | POST /v1/search/relationships, typed 410 `SEARCH_RELATIONSHIP_CREATE_RETIRED` (search.routes.ts:586; GET /v1/search/relationships/:evidenceId unchanged) | Duplicate of the record route. Native only ever read the GET. | POST /v1/evidence/:id/relationships: `evidence.update_metadata`, both ends open to the caller | **new** closure3-retirement-canonical "EP-1066: POST /v1/search/relationships answers 410 and links nothing; POST /v1/evidence/:id/relationships links the records"; case-reach-matrix | git history only | Retired |
| EP-0219 | POST /v1/cases/:id/share-team, **live** (cases.routes.ts:2047) | The one obsolete route with a historical first-party caller: the web called it until 7243702f9 (2026-09-17). | POST /v1/cases/:id/access: the same access-target rules and Cases entitlement | **new** closure3-retirement-canonical "EP-0219 (kept, sunset): the canonical POST /v1/cases/:id/access grants an ACTIVE member (201)"; matter-access-tab "CONTROL…" | Not available here. Needs the production query below. | Kept. Retire to a typed 410 only after the query shows zero calls over a window of at least 30 days (see the retention caveat) |
| EP-0261 | POST /v1/collaboration-team-invites/:token/accept, **live** (collaboration-teams.routes.ts:1643) | Shipped native builds before the body form used it | POST /v1/collaboration-team-invites/accept (token in the body) | rg26-invite-families-inviter-authority; cov-page-apis | Same query (path logged as `/v1/collaboration-team-invites/[redacted]/accept`; the body form logs as `/v1/collaboration-team-invites/[redacted]`) | Kept. Own sunset unchanged: no PENDING legacy invitation in flight and the oldest supported native build uses the body form |
| EP-1111 | DELETE /v1/teams/:id, refusal tombstone (typed 403/409 with nextAction) | Never deleted anything since 0ddb608dd | POST /v1/teams/:id/closure | workspace-lifecycle-no-hard-delete | Same query | Kept as is |

**Compatibility fix made here.** Two older tombstones (2026-09-16), the
collaboration-team guests routes (`COLLABORATION_TEAM_GUESTS_RETIRED`,
collaboration-completion.routes.ts) and the thread contributor routes
(`COLLABORATION_THREAD_CONTRIBUTORS_RETIRED`, collaboration.routes.ts), named
`canonical: "/v1/external-review/invitations"`. Since EP-0425 that POST is itself a
410, so a stale client that followed the pointer reached a second tombstone. Both
now name `/v1/external-review/invitations/bulk`. Test: closure3-retirement-canonical
"no tombstone points a stale client at another tombstone…" (revert-proof: fails on
the old pointer).

### The production evidence that settles usage (lead runs on the host)

The API writes one pino line per request, from the `onResponse` hook in
services/api/src/server.ts. Field names:
- `msg`: `request.completed`, or `request.completed.business_error` for any status of 400 or more (every 410 tombstone answer lands here), `.bounded_unavailable`, or `.infrastructure_error`;
- `method`;
- `url`: passed through the canonical redactor, so token segments read `[redacted]` and the query string is kept;
- `statusCode`;
- `userId`: an account id, never an address;
- `time`: epoch milliseconds.

**Retention caveat.** Container logs use the json-file driver
(infra/docker/docker-compose.prod.yml: `max-size: 50m`, `max-file: 5`, so at most
about 250 MB per container), and every deploy recreates the container, which
discards the old container's log. `docker logs` therefore covers only the current
API container's lifetime, capped by size. Production was redeployed on 2026-11-21
and 2026-11-22, so this window is probably about one day today. The output of step 1 states
the window actually covered. A clean result over that window does **not** satisfy
EP-0219's 30-day rule. Either keep running step 2 across deploys, appending to a
file the lead keeps, until 30 days are covered, or use a longer-lived source if the
host has one (Caddy access logs only exist if the host's Caddyfile has a `log`
directive; it is not in the repository).

```bash
# 1. The window covered (container start, first and last log line).
docker inspect -f 'created={{.Created}} started={{.State.StartedAt}} log={{.HostConfig.LogConfig.Type}} {{.HostConfig.LogConfig.Config}}' docker-proovra-api-1
docker logs docker-proovra-api-1 2>&1 | jq -Rr 'fromjson? | select(type=="object" and .time) | .time' | sed -n '1p;$p' \
  | while read t; do date -u -d "@$((t/1000))" +%FT%TZ; done

# 2. Every call to a retired / sunset route in that window, one TSV line each:
#    time, METHOD path (ids collapsed), status, userId.
docker logs docker-proovra-api-1 2>&1 | jq -Rr '
  fromjson? | select(type=="object" and ((.msg // "") | startswith("request.completed")))
  | (.method + " " + ((.url // "") | sub("\\?.*$"; "")
      | gsub("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"; ":id"))) as $mp
  | select($mp | test("^(POST /v1/external-review/invitations|POST /v1/external-review/invitations/:id/send-email|PATCH /v1/redaction/policy|POST /v1/search/relationships|POST /v1/cases/:id/share-team|POST /v1/collaboration-team-invites/\\[redacted\\]/accept|DELETE /v1/teams/:id)$"))
  | [((.time/1000) | todate), $mp, (.statusCode|tostring), (.userId // "-")] | @tsv' \
  | tee -a /opt/proovra/retired-route-calls.tsv

# 3. Summary: calls per route and status, and distinct accounts per route.
cut -f2,3 /opt/proovra/retired-route-calls.tsv | sort | uniq -c | sort -rn
cut -f2,4 /opt/proovra/retired-route-calls.tsv | sort -u | cut -f1 | uniq -c
```

How to read it:
- For EP-0425, EP-0446, EP-0934 and EP-1066, any line is a caller still on the retired route. Expect status 410 (or 401 when signed out). Contact the account by `userId` and point it at the canonical route; never reopen the route.
- For EP-0219 and EP-0261, lines with status 200 or 201 are live use: the sunset is not met.
- For EP-1111, any line is an old client meeting the refusal tombstone.
- Because the step 2 file is appended, repeated runs may duplicate lines from the same container. De-duplicate with `sort -u` before counting.

The result is not known here. Until the lead runs this over a window long enough
for the decision, EP-0219's retirement stays pending (missing evidence), and for the
four retired routes "no external caller" remains an unverified assumption, bounded
by the tombstones: they authenticate, read and write nothing, and name the
replacement.
