# Caller-less write routes: classification register

Finding: PRO-CENZ-01. Owner decision K, 2026-11-21. Source state: origin/main
`9c76edede` plus branch `closure/shell`.

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
| SUPPORTED_API_ONLY | 19 |
| NON_CLIENT_INTEGRATION | 1 |
| MISSING_INTENDED_UI | 13 (1 wired on this branch: EP-0379) |
| OBSOLETE | 8 (1 already a refusal tombstone: EP-1111; none newly retired) |
| NOT_CALLER_LESS | 3 |
| **Total** | **44** |

## Register

Abbreviations in the "Authorization test" column:
- "new: ws-shell-caller-less" means `services/api/test/ws-shell-caller-less-authz.integration.test.ts`, added on this branch.
- Other test files are named without the `.integration.test.ts` suffix, under `services/api/test/`.

| EP | Route | Class | Evidence | Authorization test (refusal) | Action |
|---|---|---|---|---|---|
| EP-0164 | POST /v1/capture/devices | SUPPORTED_API_ONLY | capture-trust.routes.ts header UC-ARCH-007 ("server-only, de-scoped"); disp MISSING_PRODUCT_UI_POST_RELEASE "UC-2 prerequisite, grants no trust today"; web copy CaptureDevicesSection.tsx "No PROOVRA app or extension registers capture devices… yet"; test/capture-trust-client-surfaces.test.ts pins "no client registers a capture device" | free-audit-g1-reach "B4-F-204: a Viewer cannot register a capture signing device"; runtime-proof-evidence-capture-a "POST /v1/capture/devices refuses a personal-space caller and a foreign workspace pointer…" | Keep |
| EP-0174 | POST /v1/capture/direct-sessions/:id/attestation | SUPPORTED_API_ONLY | Same UC-ARCH-007 header; disp UC-2 prerequisite (Play Integrity / App Attest); the verifier fails closed | **new**: ws-shell-caller-less "EP-0174 attestation: another member and another tenant get the unknown-session answer…" | Keep; authz test added |
| EP-0219 | POST /v1/cases/:id/share-team | OBSOLETE | disp SUPERSEDED_REMOVE, replaced by POST /v1/cases/:id/access (MatterAccessTab.tsx:272; its header calls share-team "the same grant under an older name"). The web called it until 7243702f9 (2026-09-17). | members-reaudit2-case-reach "…POST /access, share-team and team-access with themself are concealed 404"; ws-reach-roots "share-team: a MEMBER cannot restrict…" | Keep live; retirement candidate (see below) |
| EP-0220 | POST /v1/cases/:id/share-email | SUPPORTED_API_ONLY | disp INTENTIONALLY_BACKEND_ONLY "SECURITY_SENSITIVE_NO_UI"; cases.routes.ts route comment (D6 uniform answer); MatterAccessTab.tsx "share-email exists for address-based callers" | matter-access-tab "a non-manager MEMBER is refused 403; another tenant is answered exactly as a missing case" | Keep |
| EP-0261 | POST /v1/collaboration-team-invites/:token/accept | OBSOLETE (sunset documented) | disp SUPERSEDED_REMOVE, replaced by the body form `/accept` (web collaboration-teams.ts, mobile invite/[token].tsx). Route comment WCR-20 keeps it for stale clients "until no PENDING legacy invitation can be in flight"; the create route already answers 410. | cov-page-apis "a member who is not the addressee is refused…" | Keep until the stated sunset |
| EP-0273 | POST /v1/collaboration/threads | NOT_CALLER_LESS | Web EvidenceDiscussionPanel.tsx and mobile evidence-discussion.tsx call it since 62027182e (2026-11-18, RG-31) | case-reach-matrix "…a thread cannot be opened on it"; free-audit-0ea0-lane-b "a Viewer, a foreign thread id and a restricted record all look missing" | Leaves the finding |
| EP-0343 | PATCH /v1/evidence-requests/:id | MISSING_INTENDED_UI | disp MISSING_PRODUCT_UI_POST_RELEASE "DRAFT edit has no control"; the web creates, sends and reads only | runtime-proof-evidence-capture-b "PATCH refuses a viewer (403), a non-member (404) and an assignee from another tenant (400)…" | Follow-up (medium) |
| EP-0379 | PATCH /v1/evidence/:id/annotations/:annotationId | MISSING_INTENDED_UI | disp "annotation edit has no control"; the API projects viewerCanEdit; the web error registry (error-code-registry.ts) says "the record panels offer Edit only to the author"; sibling panels offer Edit | ws-reach-privacy "PRO-E2-03 — a manager cannot rewrite another member's annotation (403 AUTHOR_ONLY_EDIT); the author can" | **Wired on this branch**: author-only Edit in AnnotationPanel.tsx |
| EP-0389 | PATCH /v1/evidence/:id/relationships/:relationshipId | MISSING_INTENDED_UI | disp "relationship edit has no control"; the web only removes links | case-reach-matrix "a relationship cannot be edited or removed through its open end" | Follow-up (small) |
| EP-0425 | POST /v1/external-review/invitations | OBSOLETE (owner to confirm) | DEC-01: one issuing path, `/invitations/bulk` (console page.tsx and ExternalReviewSubjectPanel.tsx both use /bulk, "no second issuing path"). disp (reviewed 2026-08-16, before DEC-01) says MISSING_PRODUCT_UI. | runtime-proof-collab-teams-inbox-b "…a MEMBER is refused NOT_PERMITTED"; cov-external-reviewer "a member without the tier, and no step-up, issue nothing; a foreign record is refused" | Keep live; owner confirms DEC-01 overrides disp |
| EP-0446 | POST /v1/external-review/invitations/:id/send-email | OBSOLETE | disp SUPERSEDED_REMOVE, replaced by `/resend` (console page.tsx). Git history: no first-party client ever called it. | phase-12-sec-001-stale-pointer "SEND-EMAIL: a non-member cannot cause any outbound delivery" | Keep live; retirement candidate |
| EP-0447 | POST /v1/external-review/grants | SUPPORTED_API_ONLY | disp "primitive grant issue… product issues through the invitations layer"; fully gated (legal_hold.manage, entitlement, step-up), lifecycle-tested | runtime-proof-collab-teams-inbox-b "…a MEMBER and a foreign owner are refused" | Keep |
| EP-0449 | POST /v1/external-review/grants/:id/revoke | OBSOLETE | disp SUPERSEDED_REMOVE, replaced by `/invitations/:id/revoke` (console, ExternalReviewSubjectPanel.tsx). Git history: no client ever called it. | **new**: ws-shell-caller-less "EP-0449 grant revoke: a member without the manage capability and another tenant's owner revoke nothing…" | Keep live; authz test added; retirement candidate |
| EP-0450 | POST /v1/external-review/grants/:id/renew | MISSING_INTENDED_UI | members-and-access-model.md SEC-08: "renewal an explicit audited action"; owner share links have Renew in the web, grants do not; capmap BACKEND_ONLY_UNWIRED | tenant-reach-a2-round3 "revoked reach: … renew / reveal / resend answer like a missing grant and change nothing" | Follow-up (small, needs step-up modal) |
| EP-0469 | POST /v1/governance/lifecycle/evidence/:id/transition | SUPPORTED_API_ONLY | disp INTENTIONALLY_BACKEND_ONLY "SECURITY_SENSITIVE_NO_UI"; the product path is destruction reviews; DESTROYED refused 409 | lifecycle-force-destroy-refused "another tenant is still concealed…"; auth-factors-step-up-integrity "matrix review 6.1 …" (quarantine 403) | Keep |
| EP-0487 | POST /v1/governance/legal-holds | SUPPORTED_API_ONLY (temporary compatibility) | slice-d.json INTENTIONALLY_API_ONLY; wiring-registry INTENTIONALLY_INTERNAL; disp COMPATIBILITY_TOMBSTONE, replaced by /v1/lifecycle/legal-holds; governance.routes.ts lists six removal conditions (backfill, convergence report, removal migration, zero production traffic) | phase-12-trust-administration-residue-matrix "every mutating adapter refuses without the manage capability and writes NOTHING"; cov-legal-hold-contract "before the term: every placement route refuses…" | Keep until its in-code removal conditions are met |
| EP-0488 | POST /v1/governance/legal-holds/:id/release | SUPPORTED_API_ONLY (temporary compatibility) | as EP-0487 | residue matrix (as above); "PRO-G2-12: a CASE hold id on the evidence release route is refused before any write" | Keep |
| EP-0490 | POST /v1/governance/case-legal-holds | SUPPORTED_API_ONLY (temporary compatibility) | as EP-0487 | residue matrix; cov-legal-hold-contract | Keep |
| EP-0491 | POST /v1/governance/case-legal-holds/:id/release | SUPPORTED_API_ONLY (temporary compatibility) | as EP-0487 | residue matrix; "releasing a case hold enforces the workspace approval gate BEFORE any release" | Keep |
| EP-0538 | POST /v1/identity-security/sessions/revoke | NON_CLIENT_INTEGRATION (operator tooling) | docs/runbooks/suspicious-login-burst.md:16 makes it an operator step; the session hash is only reachable by operators. **Conflict**: disp SUPERSEDED_REMOVE (replaced by /v1/admin/identity/sessions/:id/revoke). | phase-12b-identity-selfservice-matrix "sessions/revoke: permission denial → 403 with ZERO revocation"; coverage-residual-reach "a session revocation cannot be aimed outside the workspace" | Keep; owner decides runbook step vs disp |
| EP-0615 | POST /v1/intelligence/evidence/:evidenceId/run/bytes | SUPPORTED_API_ONLY | disp INTENTIONALLY_BACKEND_ONLY "SECURITY_SENSITIVE_NO_UI"; the governed product path is /media-intelligence/run; D62 provenance | defects-intelligence-run-bytes "answers another workspace's evidence exactly like a missing one" | Keep |
| EP-0655 | POST /v1/me/inbox/items/:itemKey/remind | SUPPORTED_API_ONLY | inbox/page.tsx comment: the row action was removed by product choice and the endpoint stays for existing clients (disp and capmap are stale on this) | runtime-proof-collab-teams-inbox-a "every per-item action refuses an unauthenticated caller (401) and a malformed key (400)…" (state is per user) | Keep |
| EP-0657 | POST /v1/me/inbox/items/:itemKey/undismiss | SUPPORTED_API_ONLY (alias) | disp COMPATIBILITY_TOMBSTONE, alias of unarchive, boot-checked in LEGACY_ACTION_ALIASES | as EP-0655 | Keep |
| EP-0658 | POST /v1/me/inbox/items/:itemKey/snooze | SUPPORTED_API_ONLY (alias) | disp COMPATIBILITY_TOMBSTONE for shipped mobile builds; phase-ia-reliability-inbox-state pins it | as EP-0655 | Keep |
| EP-0806 | POST /v1/orgs/:id/policies/retention | MISSING_INTENDED_UI | Copy at apps/web/app/(app)/organizations/[id]/admin/retention/page.tsx says "Publish a template from Evidence Lifecycle → Retention", but that page only posts the workspace route; disp MISSING_PRODUCT_UI_POST_RELEASE; workspace-operating-model-runbook.md "publish org retention template (ORG_ADMIN+)" | org-persona-authorization-matrix "write: publish the retention template" (excluded roles 403, cross-org, anonymous 401) | Follow-up (small) |
| EP-0842 | POST /v1/orgs/:id/data-export | MISSING_INTENDED_UI | Commit 29a7277d2 (GOV-015): "the owner now requests it…"; copy CustomerContractPanel.tsx "…the window in which the owner can export the organization's data"; capmap BACKEND_ONLY_UNWIRED; runbook 32 is stale | governance-remediation-rem3 "only the organization owner may ask; a member of another organization gets 404" | Follow-up (medium) |
| EP-0843 | POST /v1/orgs/:id/data-export/:requestId/manifest | MISSING_INTENDED_UI | as EP-0842 | **new**: ws-shell-caller-less "EP-0843 / EP-0844 data-export manifest and links: only the organization owner gets past the owner gate…" | Follow-up with EP-0842; authz test added |
| EP-0844 | POST /v1/orgs/:id/data-export/:requestId/links | MISSING_INTENDED_UI | as EP-0842 | **new**: same case | Follow-up with EP-0842; authz test added |
| EP-0934 | PATCH /v1/redaction/policy | OBSOLETE | disp COMPATIBILITY_TOMBSTONE "Legacy unversioned policy write… back-compat shim", replaced by POST /v1/redaction/policies plus version transitions (web redaction/policy/page.tsx) | **new**: ws-shell-caller-less "EP-0934 PATCH /v1/redaction/policy: a member, a viewer and another tenant write no policy version…" | Keep live; authz test added; retirement candidate |
| EP-0980 | POST /v1/reviewer-ops/reviews/:workflowId/reassign | SUPPORTED_API_ONLY | docs/runbooks/workflow-stuck.md:18 operator step; disp PRESERVED_POST_RELEASE_CONTRACT "no product contract to build"; same guards and service as /assign | members-assignment-surfaces "REV-05 — … cannot hand out reviews; review.assign can"; "console reassign: an unplaced member is refused…" | Keep |
| EP-1066 | POST /v1/search/relationships | OBSOLETE | Duplicates POST /v1/evidence/:id/relationships, which web (EvidenceRelationshipDialog.tsx) and mobile (capture-links.ts) use; capmap COMPATIBILITY_TEMPORARY | **new**: ws-shell-caller-less "EP-1066 POST /v1/search/relationships: a non-operator, another tenant and a cross-tenant pair write no link…"; also case-reach-matrix (409) | Keep live; authz test added; retirement candidate |
| EP-1067 | POST /v1/search/reindex/evidence/:id | SUPPORTED_API_ONLY | slice-c.json INTENTIONALLY_API_ONLY, "per-document operator escape hatch" | **new**: ws-shell-caller-less "EP-1067 … a non-operator, another tenant and a cross-tenant record index nothing…" | Keep; runtime authz test added |
| EP-1081 | PUT /v1/cases/:id/siu-profile | NOT_CALLER_LESS | Web SiuPanel.tsx:185 since 4da502569 (PRO-K1-10) | authz-coverage-defect-closures "SIU: a VIEWER writes nothing…"; ws-ent-enterprise-surfaces | Leaves the finding; status/field edits remain a follow-up |
| EP-1082 | POST /v1/cases/:id/siu-profile/checklist/:itemId/map-evidence | MISSING_INTENDED_UI | SiuPanel.tsx header ("…see the bounded evidence checklist… request a follow-up"); docs/verticals/insurance-siu-workflows.md §2 and §4 list the reviewer actions | ws-ent-enterprise-surfaces "PRO-K1-04: a VIEWER is refused every SIU write…"; "a non-Enterprise workspace owner is refused…" | Follow-up (medium, needs an evidence picker) |
| EP-1083 | POST …/siu-profile/checklist/:itemId/status | MISSING_INTENDED_UI | as EP-1082 | as EP-1082 | Follow-up (small) |
| EP-1084 | POST …/siu-profile/indicators | MISSING_INTENDED_UI | as EP-1082 ("Mark evidence gap") | as EP-1082 | Follow-up (small) |
| EP-1085 | POST …/siu-profile/follow-ups | MISSING_INTENDED_UI | as EP-1082 ("Request follow-up") | as EP-1082 | Follow-up (small to medium) |
| EP-1086 | POST …/siu-profile/follow-ups/:followUpId/status | MISSING_INTENDED_UI | as EP-1082 | as EP-1082 | Follow-up with EP-1085 |
| EP-1111 | DELETE /v1/teams/:id | OBSOLETE, already tombstoned | Zero mutations for every caller since 0ddb608dd; typed 403/409 with nextAction, pointing at POST /v1/teams/:id/closure | workspace-lifecycle-no-hard-delete "non-owner — DELETE is a typed 403 and nothing moves"; runtime-proof-collab-teams-inbox-a | None (refusal tombstone kept for old clients) |
| EP-1118 | POST /v1/teams/:id/leave | NOT_CALLER_LESS | Web WorkspaceMembersPanel.tsx (ee3e47afa) and mobile workspace-people.ts (4f456403d) | members-membership-commands "LIFE-15 — a MEMBER may leave; the OWNER may not" | Leaves the finding |
| EP-1124 | POST /v1/teams/:id/cases/link | SUPPORTED_API_ONLY | UI deliberately removed in 3065dc3b8 ("no case linking on Members & Access"); adopts legacy unworkspaced cases; members-and-access-model.md:304. The comment at apps/web/app/(app)/teams/[id]/page.tsx:1255 is stale. | members-access-convergence "ROLE-02 — an ADMIN cannot link another tenant's unlinked case…"; authz-coverage-defect-closures | Keep |
| EP-1125 | DELETE /v1/teams/:id/cases/:caseId | SUPPORTED_API_ONLY | Counterpart of link; UI removed with it; re-hardened in a9c1b4337 (PRO-T1-07) | ws-reach-roots "an ADMIN cannot detach someone else's case…" | Keep |
| EP-1138 | POST /v1/trust/articles | SUPPORTED_API_ONLY | Entitlement-gated customer authoring (ws-out-trust-center-entitlement "every other trust write is [customer-authored]"); no copy promises an in-app editor | members-delegated-admin "N-1: a workspace ADMIN and a MEMBER are refused…"; ws-out-trust-authoring "PRO-G2-13 …" | Keep |
| EP-1142 | POST /v1/trust/subprocessors | SUPPORTED_API_ONLY | as EP-1138 | free-audit-0ea0-lane-b "Trust Center authoring: a workspace without FEATURE_TRUST_CENTER is refused…"; members-delegated-admin | Keep |

All 41 routes that are still caller-less have at least one route-level authorization test with a refusal case. The three NOT_CALLER_LESS routes have one too. Seven routes had none and were given one on this branch:
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
| EP-0343 | Edit a DRAFT evidence request | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx`, DRAFT row next to Send | medium (deliverables form) |
| EP-0389 | Edit a relationship's type or note | `apps/web/app/(app)/evidence/[id]/components/EvidenceRelationshipsSection.tsx`, beside Remove | small |
| EP-0450 | Renew an external-review grant | `apps/web/components/external-review/ExternalReviewSubjectPanel.tsx`, on each grant row, wrapped in the panel's StepUpModal | small |
| EP-0806 | Publish the organization retention template | `apps/web/app/(app)/organizations/[id]/admin/retention/page.tsx` (form: retentionDays, immutable, description), or correct its copy at :139 | small |
| EP-0842..0844 | Owner offboarding export: request, history, manifest download, paged links | `apps/web/app/(app)/organizations/[id]/page.tsx`, owner-only closure section (already step-up wired) | medium |
| EP-1082..1086 | SIU checklist status, indicators, follow-ups, map evidence | `apps/web/app/(app)/cases/components/SiuPanel.tsx`, checklist table, "Review indicators" and a new follow-ups list | small each; map-evidence medium |

## Retirement: compatibility note

The repo's retirement pattern is a typed 410 tombstone that authenticates and
changes nothing. Examples:
- `services/api/src/routes/collaboration.routes.ts` (header);
- `/v1/api-keys*` in `enterprise.routes.ts`;
- `/v1/search/reindex/workflow/:id`.

EP-1111 is a refusal tombstone already.

No route was retired on this branch. Each of the following is a retirement
candidate:
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
  - runbook 32 says there is no customer-facing export;
  - `apps/web/app/(app)/teams/[id]/page.tsx:1255` claims case linking is still in the product.

## Closure-integration addendum (2026-11-21, `closure/integration`)

The register above is the census at 9c76edede. Three write routes added by other
closure branches also have no shipped web, native, extension or worker caller on
the integrated tree. They are recorded here so the register stays complete; none
is defective under decision K, and each has route-level authorization tests.

| Route | Branch / finding | Class | Authz tests | Action |
|---|---|---|---|---|
| POST /v1/evidence/:id/owner-destruction-approval | closure/money, MATRIX-M626 (decision I) | MISSING_INTENDED_UI | m626-teamless-destruction-approval "the approval is the owner's, for this record and this trash cycle only — never retention, never another person"; "an Enterprise record needs its own governed approval; an owner approval is refused and does not count" | Keep; web control for the record owner is a follow-up (out-money.md) |
| DELETE /v1/evidence/:id/owner-destruction-approval | closure/money, MATRIX-M626 (decision I) | MISSING_INTENDED_UI | same file (withdrawal) | Keep; same follow-up |
| POST /v1/evidence-requests/:id/recipient-contact | closure/reach, NEW-RG-19-1 (decision G) | MISSING_INTENDED_UI | new-rg-19-1-request-contact-reveal "a reveal without a step-up is refused…", "a role without the reveal authority (VIEWER) is refused (403)…", "cross-tenant…", "a request on a restricted case the caller cannot reach answers as missing" | Keep; masked contact plus a step-up reveal control on the request detail page is a follow-up (out-reach.md) |
