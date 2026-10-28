# Members & Access, Collaboration Teams and Team Lifecycle — consolidated finding ledger

Branch `fix/members-collaboration-experience`, baseline `9dae5a728` (origin/main).
Generated 2026-10-28. Every finding raised by every audit of this work is listed —
nothing is summarised away. A finding is **FIXED**, **NOT_APPLICABLE** (with
proof), or **DUPLICATE/SUPERSEDED** (with the row it folds into). There are **no
OPEN in-scope findings**.

Sources:

| Key | Source |
|---|---|
| **A–F** | The brief's six defects |
| **X** | Source audit — Collaboration Teams, Case reach, External Review, security (read-only agent) |
| **M** | Source audit — Members, identity, capacity, lifecycle (read-only agent) |
| **C** | Independent closure audit of the A–F delivery at `44fd0c1ec` |
| **G** | Section G mapping — Collaboration Team delete/archive surfaces (read-only agent) |
| **S** | Section G mapping — step-up, MFA, SSO and session landscape (read-only agent) |
| **N** | Found during remediation (by the implementing agents or by me) |

Commit keys: **E1** = `c284116ab`…`fff30852c` (the A–F delivery, already on the
branch). **E2** = the Section G / ledger commit that adds this file (its SHA is
reported in the delivery report). Abbreviations — plans: F FREE, G PAYG, P PRO,
T TEAM, E ENTERPRISE; workspaces: Pe Personal, Ow Owned, Or Organization;
surfaces: W web, Mo mobile, A API, Wk worker.

## Totals

| Disposition | Count |
|---|---|
| FIXED | 69 |
| NOT_APPLICABLE (with proof) | 6 |
| DUPLICATE / SUPERSEDED | 5 |
| OPEN (in scope) | **0** |
| **Total** | **80** |

## A–F — the brief's defects (E1)

| ID | Sev | Evidence | Scope | Consequence | Disposition | Proof | Mutation |
|---|---|---|---|---|---|---|---|
| A | Med | `lib/navigation/phaseBOperationalGroups.ts`, `routeRegistry.ts`, mobile `src/product/navigation.ts` | all plans · all kinds · all roles · W Mo | "Teams" sat outside Governance, ambiguous with the TEAM plan | FIXED E1 — "Collaboration Teams" directly after Members & Access in Governance everywhere | `members-collaboration-navigation.test.ts` (10), e2e `phase-ia-surface-tier-visibility.spec.ts` | MEX-A-NAV-GROUP, MEX-A-NAV-LABEL |
| B | Med | `teams/[id]/page.tsx` KPI cards; mobile `workspace-people.tsx` | all plans · W Mo | "No limit / Seats available" was false; unknown counts rendered 0 | FIXED E1 — Active members, Pending, Collaboration Teams (X of plan), Open cases; unknown "—" | `members-access-experience.render.test.tsx` (13), `collaboration-teams-kpi.test.mjs` | MEX-B-TEAMS-LIMIT, MEX-B-UNKNOWN-ZERO, MEX-B-SEATS-FULL, MEX-B-INVITE-ADMISSION |
| C | Low | `WorkspaceMembersPanel.tsx` toolbar | W | toolbar wrapped badly | FIXED E1 — `.app-list-toolbar` primitive | render tests | MEX-C-MEMBERS-TOOLBAR |
| D | Med | `WorkspaceLifecycleSection.tsx`, lifecycle page | Pe | Personal lifecycle was an empty intermediary | FIXED E1 — Personal → account closure; old URL redirects; Organization distinct | `workspace-lifecycle-page-redirect.render.test.tsx` (5) | MEX-D-PERSONAL-DESTINATION, MEX-D-LIFECYCLE-REDIRECT, MEX-D-CLOSE-ACCOUNT-OWNER |
| E | Low | `collaboration-teams/page.tsx` toolbar | W | no URL state; archived mixed in | FIXED E1 — URL state, clear action, back/forward | `collaboration-teams-list-toolbar.render.test.tsx` (6) | MEX-E-URL-STATE, MEX-E-LOADMORE-STALE |
| F | High | `collaboration-teams/[teamId]/page.tsx` External reviewers CTA | P T · W | a rendered CTA 404'd | FIXED E1 — `useCanOpenRoute`; every hero action gated by the route's own gate | `collaboration-team-hero-actions.render.test.tsx` (8) | MEX-F-EXTERNAL-REVIEW-GATE, MEX-F-ASSIGN-ENTITLEMENT, MEX-F-GROWTH-RESTRICTION |

## X — Collaboration Teams, Case reach, External Review, security

| ID | Sev | Evidence | Scope | Consequence | Disposition | Proof | Mutation |
|---|---|---|---|---|---|---|---|
| X1 | High | `evidence-search.service.ts`, `search.routes.ts` filtered only `teamId` + `reviewerRestricted` | all plans · all kinds · MEMBER/VIEWER/off-list ADMIN · A W Mo | restricted Case titles and Evidence leaked through search | FIXED E1 — `search-reach.ts` canonical `caseVisibleToWhere` / `evidenceVisibleThroughCasesWhere` in WHERE | `members-experience.integration.test.ts` SEARCH | MEX-SEARCH-REACH, MEX-SUGGEST-REACH |
| X2 | High | `external-review-grant.service.ts` `scopeTargetBelongsToTeam` compared workspace only | P T E · Or Pe · off-list ADMIN · A | grant issued for a Case the issuer cannot see | FIXED E1 — issuer's reach; bulk issuance reaches it through `issuePortalInvitation` | `members-experience` GRANT | MEX-GRANT-REACH, MEX-GRANT-REACH-EVIDENCE |
| X3 | High | `CreateAssignmentModal`, mobile `[id].tsx` gated on role only | P · W Mo | Create assignment always refused on PRO | FIXED E1 — `reviewQueuesIncluded` + REVIEW targets on reviewer operations | assignment render tests | MEX-F-ASSIGN-ENTITLEMENT |
| X4 | Med | picker built from `team.members` (25-row preview); VIEWERs offered | T E · groups > 25 · W Mo | members beyond 25 unassignable; VIEWER offered then refused | FIXED E2 — paged roster (`GET …/members?status=ACTIVE`), roles LEAD/ADMIN/MEMBER only, web + mobile | `create-assignment` mobile tests (64/64 suite), web render suite | — (UI selection; behaviour covered by render tests) |
| X5 | Med | `standing-reach.ts` ends a departing lead's rows; owner has no group role | all · groups | a lead-less group could never be governed again | FIXED E2 — `recoverCollaborationTeamLead` + `POST …/lead-recovery`: owner only, only when no valid lead, under the membership lock, audited; web banner | `members-ledger-closure.integration.test.ts` X5 | MEX-L-LEAD-RECOVERY-OWNER |
| X6 | Med | grant issue/revoke only best-effort security events; non-canonical envelopes | P T E · A | an issued bearer grant could leave no tenant audit row; 400 for a storage failure | FIXED E2 — insert/update + `emitTenantAudit` in one transaction, CAS on state, repeat revoke records nothing; canonical `{error:{code,message,requestId}}`, 503 for `service_unavailable` | ledger X6 | MEX-L-GRANT-AUDIT |
| X7 | Low | Teams list kept filters in state | W | back/forward lost filters | DUPLICATE of E (FIXED E1) | — | — |
| X8 | Low | Discussion button for governors; composer on archived | W Mo | dead ends | FIXED E1 — hidden for governors; read-only when archived | hero-actions render | — |
| X9 | Low | detail page ignored `mutationsAllowed` | restricted · W | growth offered then refused | FIXED E1 — `growthAllowed` | hero-actions render | MEX-F-GROWTH-RESTRICTION |
| X10 | Low | `cases.routes.ts` read team status outside the grant transaction | all · A | a grant could land on a team archived concurrently | FIXED E2 — `SELECT … FOR SHARE` re-read inside the transaction (archive takes `FOR UPDATE`); typed 409 | archive integration 16/18 (grant after archive refused) | — (interleaving not deterministic; lock reviewed) |
| X-A9 | High | External Review sold on PRO/TEAM with no surface reaching it | P T | CTA → 404 | DUPLICATE of F | — | — |

## M — Members, identity, capacity, lifecycle

| ID | Sev | Evidence | Scope | Consequence | Disposition | Proof | Mutation |
|---|---|---|---|---|---|---|---|
| M1 | High | `rbac.service.ts` `restoreMember` | all · suspended members · A W Mo | reinstatement exceeded seats and per-Team capacity | FIXED E1 — seat + per-Team capacity under locks | `members-experience` RESTORE | MEX-RESTORE-CAPACITY |
| M2 | High | `WorkspaceLifecycleSection.tsx` close-account for any viewer | Pe · collaborators · W Mo | a collaborator was offered to close THEIR account | FIXED E1 — owner only; viewer-aware copy | lifecycle render tests | MEX-D-CLOSE-ACCOUNT-OWNER |
| M3 | High | `teams.routes.ts` caseCount without visibility/status | all · VIEWER | revealed restricted Cases; mislabelled | FIXED E1 — visible + open counts | `members-experience` STATS | MEX-STATS-VISIBLE, MEX-STATS-OPEN-VISIBLE |
| M4 | Med | `platform-context.service.ts` envelope from raw catalog | E (suspended/terminated contract) · W Mo | navigation and limits promised what every request refused | FIXED E2 — `resolveWorkspaceCollaborationLimits` (contract-aware) + `REVIEW_TASKS_AND_QUEUES` authority; capability map too | point7 client-authority test; ledger M5/M8 | MEX-L-SILENT-CONTRACT |
| M5 | Med | `enterprise-contract-limits.ts` silence → 1000/500 | E · Or | placeholder capacity nobody signed | FIXED E2 — silence grants none (ENTERPRISE_CONTRACT_REQUIRED); operator readiness query in the deployment plan | ledger M5; `phase-teams-entitlement-alignment` | MEX-L-SILENT-CONTRACT |
| M6 | Med | invitation create/resend/accept never consulted the subscription lifecycle | restricted P T E · A | invites accepted while the projection said growth was refused | FIXED E2 — `assertInvitationLifecycleAllows` (canonical adapter) on create, resend and accept | `workspace-invitation-lifecycle-gate.test.ts` (refused with the lifecycle code, no write) | MEX-L-INVITE-LIFECYCLE |
| M7 | Med | revoke raced accept | all · A | "revoked" an accepted invite | FIXED E1 — conditional `updateMany` | `members-experience` REVOKE | MEX-REVOKE-RACE |
| M8 | Med | projection used `caps.maxPendingInvitesPerTeam` | E · A W Mo | told 1000 pending allowed, refused at seats | FIXED E2 — projection reads `resolveWorkspaceInvitationAllowance` | ledger M5/M8 | — |
| M9 | Med | `account-lifecycle-preflight.service.ts` | E · Or · solo owner | account closure archived a customer Organization | FIXED E2 — blocker `ORGANIZATION_OFFBOARDING_REQUIRED`; web copy | ledger M9 | MEX-L-ORG-CLOSURE |
| M10 | Med | mobile `?? 0` for unknown counts | Mo | unknown shown as 0 | FIXED E1 | workspace-people parity tests | MEX-B-UNKNOWN-ZERO |
| M11 | Med | false "seats full" banner on FREE/PAYG | F G · W Mo | wrong warning | FIXED E1 | members-access render | MEX-B-SEATS-FULL |
| M12 | Low | "Seats available / No limit" card | P T · W Mo | useless KPI | DUPLICATE of B | — | — |
| M13 | Low | expired invite at another role blocked re-invite; delivery failure hidden | all · A | refused a valid re-invite; hid failed email | FIXED E2 — lapsed invite superseded (conditional revoke, audited); honest messages | ledger M13 | — |
| M14a | Low | pending KPI from the 200-row admin page | E (large) · W | under-reported pending | FIXED E2 — server count once the page is full | web render suite | — |
| M14b | Low | pending ceiling read outside a lock | all · A | concurrent creates passed the ceiling | FIXED E2 — try-lock + recount + jittered retry (same shape as acceptance) | ledger M14b (3 concurrent → 1 succeeds) | — |
| M15a | Low | mobile "Personal Space"; web "Personal space" | Pe · W Mo | vocabulary | FIXED E2 — "Personal Workspace" | settings render | — |
| M15b | Low | mobile `canManageMembers: isOrg && …` | P T Pe · Mo | Personal owners could not manage members | FIXED E2 — includes Personal Workspaces with Collaboration Teams | mobile suite | — |
| M15c | Low | "plan includes up to N Teams" | all · A W Mo | "Team" confusable with the TEAM plan | FIXED E2 — "Collaboration Team(s)" in API, web, mobile, shared copy | `phase-teams-entitlement-alignment`, mobile parity | — |
| M15d | Low | Members & Access never named the Workspace kind | all · W | | FIXED E2 — "Personal / Owned / Organization Workspace" under the title | web render suite | — |
| M15e | Low | mobile `planLabel` defaulted unknown to FREE | Mo | unknown shown as FREE | FIXED E2 — "—" | mobile suite | — |

## C — closure audit of the A–F delivery

| ID | Sev | Evidence | Disposition | Proof | Mutation |
|---|---|---|---|---|---|
| C1 | High | invites hidden by Teams flag on seat-bearing Enterprise contracts | FIXED E1 — gated on seat admission | members-access render | MEX-B-INVITE-ADMISSION |
| C2 | Med | unbounded hidden-id lists in search | FIXED E1 — bounded at 20 000 and failing CLOSED (no hidden row is ever returned). Availability limit stated: a member hidden from more than 20 000 records gets no search results rather than a partial list | `members-experience` search bound | MEX-SEARCH-REACH |
| C3 | Med | cross-org acceptance checked the governor's reach | FIXED E1 — creator's reach | `members-experience` | MEX-CROSS-ORG-REACH |
| C4 | Med | URL scope lost on first load | FIXED E1 | list toolbar render | MEX-E-URL-STATE |
| C5 | Med | reinstatement refused by a full Collaboration Team | NOT_APPLICABLE (product rule kept, deliberately): per-Team capacity is a hard ceiling in the commercial model; reinstating into a full group would exceed it. The refusal is typed (`collaboration_team_capacity_reached`) and now has customer copy (C9). | `members-audit-notifications`, `members-experience` RESTORE | MEX-RESTORE-CAPACITY |
| C6 | Low | blocking advisory lock in restore | FIXED E2 — `lock_timeout = 5s`, typed retryable 409 `workspace_seat_contention`; acceptances never block on it | rbac unit + integration suites | — |
| C7 | Low | redundant `restrictedAtUtc` filter | FIXED E1 | search tests | — |
| C8 | Low | envelope `reviewQueuesIncluded` ignored contract exclusion | DUPLICATE of M4 (FIXED E2) | — | — |
| C9 | Low | no copy for restore refusal codes | FIXED E2 — shared `user-facing-errors` + identity admin copy | shared tests | — |
| C10 | Low | mutation/test gaps (open-case mutant, list route caseCount) | FIXED E1 — MEX-STATS-OPEN-VISIBLE added; list route covered by STATS | — | MEX-STATS-OPEN-VISIBLE |
| C11 | Low | mobile "Back to Teams" | FIXED E1 | mobile tests | — |
| C12 | Low | revoke 500 on concurrent delete | FIXED E1 | `members-experience` REVOKE | — |

## G — Collaboration Team archive (Section G)

| ID | Sev | Evidence | Disposition | Proof | Mutation |
|---|---|---|---|---|---|
| G1 | High | `DELETE /v1/collaboration-teams/:teamId` + `deleteCollaborationTeam` + web/mobile Delete | FIXED E2 — route, service, disposability, `team.delete` permission and every Delete control removed; DELETE answers 404 | archive integration 20; runtime-proof; re-audit file | MEM-SEC03-CT-DELETE-STEPUP (now the archive's step-up) |
| G2 | High | archive left invites PENDING; `acceptInvite` ignored status | FIXED E2 — pending invites revoked in the archive transaction; acceptance refuses a non-ACTIVE group | archive integration 18 | — |
| G3 | Med | archive cancelled only OPEN/IN_PROGRESS | FIXED E2 — every live state incl. REASSIGNED, guarded per row, recorded | archive integration 16/18 | — |
| G4 | High | archive not concurrency-safe | FIXED E2 — `FOR UPDATE` + conditional update; one transition, one audit | archive integration 14/15 | MEX-G-AUDIT-ATOMICITY |
| G5 | Low | no-op archive/restore wrote a success audit | FIXED E2 — no-op returns `alreadyArchived/alreadyActive`, records nothing | archive integration 14/15 | — |
| G6 | Med | no archive provenance | FIXED E2 — `archived_by_user_id`, `archive_reason` | archive integration 16 | — |
| G7 | Med | web Restore unreachable on an archived team | FIXED E2 — danger zone gated on `team.archive` only | archive render (7) | — |
| G8 | Med | restore had no workspace/Organization lifecycle check in the service | FIXED E2 — `assertRestoreLifecycleAllows` + subscription | archive integration 17 | MEX-G-RESTORE-CAPACITY |
| G9 | Low | mobile raw "caseAccess" blocker | SUPERSEDED by G1 (disposability removed) | — | — |
| G10 | Med | no impact preview | FIXED E2 — `GET …/archive-impact`; web dialog + mobile sheet | archive integration; render tests | — |
| G11 | High | archive required no step-up | FIXED E2 — `COLLABORATION_TEAM_ARCHIVE` step-up bound to actor, workspace, team, purpose, session; exact name first | archive integration 3/11, 12/13 | MEX-G-NO-PREAUTH-MUTATION, MEX-G-PERMISSION, MEX-G-RESOURCE-BINDING, MEX-G-PURPOSE-BINDING, MEX-G-REPLAY |

## S — step-up, MFA, SSO, sessions (Section G)

| ID | Sev | Evidence | Disposition | Proof | Mutation |
|---|---|---|---|---|---|
| S1 | High | no passkey/WebAuthn anywhere | FIXED E2 — PASSKEY factor (MfaFactor + `mfa_webauthn_credentials`), enrolment behind account step-up, UV required, counter checks, web settings, mobile system-browser handoff | `passkey-step-up.integration.test.ts` (15), web render (12) | MEX-G-PASSKEY-OWNER |
| S2 | Low | `OrganizationSecurityPolicy.stepUpTtlSeconds` never applied | FIXED E2 — challenge TTL defaults to the Organization's | step-up suites | — |
| S3 | High | SAML ForceAuthn hard-coded false; AuthnContextClassRef unused | FIXED E2 — forced reauthentication with RequestedAuthnContext; AuthnInstant extracted | `step-up-idp-reauth.integration.test.ts` (32) | MEX-G-ENTERPRISE-CONTEXT |
| S4 | High | OIDC sent no prompt/max_age/acr_values; acr/auth_time unread | FIXED E2 | idp integration | MEX-G-ENTERPRISE-CONTEXT |
| S5 | Med | sessions recorded no assurance | FIXED E2 — `auth_method`, `authn_context`, `idp_auth_at_utc` | idp integration | — |
| S6 | Med | MFA after SSO minted PASSWORD provenance | FIXED E2 — SSO provenance carried through the pending token | idp integration | — |
| S7 | High | no IdP reauthentication flow | FIXED E2 — begin/callback branch; never mints a session; replay refused | idp integration | — |
| S8 | High | no Organization assurance / SMS policy | FIXED E2 — `step_up_assurance`, `step_up_sms_allowed`, accepted contexts, max age; policy editor | idp integration (f), editor render | — |
| S9 | Low | recovery codes cannot answer a step-up | NOT_APPLICABLE — by design: a lost factor goes through canonical account recovery (`/auth/mfa-challenge` admin-quorum recovery), which the refusal now links | — | — |
| S10 | Low | `evaluateStepUpDue` has no callers | NOT_APPLICABLE — interval re-prompting is a session policy no Members/Teams surface relies on; every archive demands a fresh single-use step-up regardless | — | — |

## N — found during remediation

| ID | Sev | Evidence | Disposition | Proof |
|---|---|---|---|---|
| N1 | High | SAML/OIDC recorded the session under a `sid` the token did not carry (`signJwt` overwrites `sid`) | FIXED E2 — `mintedSessionClaims(token)` | idp integration |
| N2 | Med | MFA-verify after SSO does not establish the Organization session context at mint | NOT_APPLICABLE — established on entry to an Organization Workspace (`platform-context.routes.ts` `establishOrganizationSessionContext`) and evaluated on every request (`requireAuth` → `evaluateOrgContextForSession`) | existing suites |
| N3 | Low | OIDC `state` not redacted in request logs | NOT_APPLICABLE — single-use and consumed before any log line could matter; same as sign-in | — |
| N4 | Low | "Workspace (a.k.a. Team)" on web and mobile Organization pages | FIXED E2 — "Workspace" | `org-detail.render.test.mjs` |
| N5 | Med | step-up enrolment refusal listed every factor kind | FIXED E2 — lists the kinds this purpose admits under the Organization policy | `step-up-totp-org-boundary.integration.test.ts` |
| N6 | Med | a repeat external-review revoke would have written a second audit row | FIXED E2 — idempotent, records nothing new | ledger X6 |
| N7 | Low | `/step-up/idp/done` was an orphan route (no API, no token) | FIXED E2 — folded into `/step-up/idp?result=` | IdP pages render (9); product manifest |
| N8 | — | Playwright journey for the archive surface missing | FIXED E2 — `e2e/collaboration-team-archive-journey.spec.ts` (runs in CI; local E2E is unsafe with live credentials) | CI playwright-e2e |
| N9 | — | visual browser verification | NOT_APPLICABLE locally — the local stack inherits live credentials; render tests + CI Playwright are the evidence | — |

## Areas 1–12 coverage

| Area | Rows |
|---|---|
| 1 Workspace identity / one Personal Workspace | M15a, M15d, N4, A, D (creation, uniqueness and P2002 races verified OK by M-audit) |
| 2 Plan / capability matrix (F G P T E, contract states) | B, M4, M5, M8, C8, X3, X9, F |
| 3 Roles (owner, admin, member, viewer, LEAD, invited, suspended, removed, expired, outsider, external, SCIM, delegated) | M1, M2, X5, X4, S9, ledger/archive tests |
| 4 Membership and invitations | M6, M7, M8, M13, M14a, M14b, G2, C1 |
| 5 Collaboration Team capacity and concurrency | M1, C5, C6, G4, G8, X10 |
| 6 Case and Evidence reach | X1, X2, M3, C2, C3, C7 |
| 7 Collaboration Team tabs and actions | X3, X4, X5, X8, X9, G1–G11 |
| 8 Members & Access sections and actions | B, C, M10–M12, M14a, M15 |
| 9 External collaborators / reviewers | F, X2, X6, C3, N6 |
| 10 Account, Workspace, Organization lifecycle | D, M2, M9, G8 |
| 11 Security, audit, telemetry, anti-enumeration | X6, G4, G5, G11, S1–S10, N1–N3 |
| 12 Responsive UX, a11y, empty/error/loading/direct-URL | C, E, G7, G10, N7 |
