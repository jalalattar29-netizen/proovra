/**
 * NATIVE IMPLEMENTATION LEDGER — progress tracking, NOT a product authority.
 *
 * `tools/derive-product-manifest.mjs` decides WHICH Web surfaces Native must
 * implement, from canonical Web/backend evidence. This file records, for each
 * of those surfaces, WHERE the Native implementation lives and HOW FAR it has
 * got. It may never widen or narrow the scope: the coverage guard fails if a
 * NATIVE_REQUIRED route is missing here, and equally if a row here names a
 * route the manifest classified as admin/enterprise/marketing.
 *
 * `status` is deliberately blunt and is claimed only against evidence:
 *   NOT_STARTED               no Native destination exists yet
 *   SHELL                     a screen exists but is materially thinner than
 *                             the Web surface (fewer data sources, fewer
 *                             actions, or missing states)
 *   PARTIAL                   the primary journey works; named gaps remain
 *   CODE_PARITY               functional + content + state parity in code, with
 *                             no known gap a repository can close
 *   BLOCKED_BY_EXTERNAL       everything repository-executable is done; the
 *                             remainder needs something outside it. `blockedBy`
 *                             names the EXACT dependency
 *   BLOCKED_BY_USER_DECISION  a product/legal choice, not an implementation
 *                             one. `blockedBy` cites the evidence
 *
 * ===========================================================================
 * CODE_PARITY IS NOT PHYSICAL ACCEPTANCE. THEY ARE SEPARATE DIMENSIONS.
 * ===========================================================================
 * `status` was previously topped out by a `PARITY` that also meant
 * "device-verified", which made every surface un-completable from a repository
 * and held the completed column at zero no matter how much was actually
 * finished. That is not honesty, it is a broken instrument: it reported the
 * same number for "nothing works" and "everything works, untested on hardware".
 *
 * So the two are tracked independently. `status` is what the code does, and is
 * decidable here. `physicallyAccepted` is whether a human with a real device
 * ticked the surface off in `docs/physical-acceptance.md`, and may NEVER be set
 * from CI. A surface can be CODE_PARITY and physicallyAccepted: false — that is
 * the normal state of finished work awaiting hardware, and it is stated rather
 * than hidden.
 *
 * `webSources` names the canonical Web implementation being ported, so a later
 * reviewer can diff the two without rediscovering the mapping.
 */

/**
 * @typedef {"NOT_STARTED"|"SHELL"|"PARTIAL"|"CODE_PARITY"|"BLOCKED_BY_EXTERNAL"|"BLOCKED_BY_USER_DECISION"} DestinationStatus
 *
 * The two BLOCKED_* statuses are counted separately from NOT_STARTED so the
 * denominators stay honest: those rows are not waiting on effort inside this
 * repository. Each one must name what it is waiting for in `blockedBy`.
 */

export const NATIVE_DESTINATIONS = {
  /* ------------------------------------------------------------------ auth */
  "/login": {
    routeFile: "(stack)/auth.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/login/page.tsx"],
    gaps: [
      "LEDGER CORRECTION: the recorded gap 'Google unconfigured in built binaries (B-2)' is stale. eas.json now carries EXPO_PUBLIC_GOOGLE_IOS/ANDROID/WEB_CLIENT_ID on the build profiles, so a preview build is configured; docs/physical-acceptance.md records that a build made BEFORE that change is not, and will report OAUTH_GOOGLE_UNCONFIGURED.",
      "the second recorded gap, 'visual parity with the web auth shell unverified', is physical acceptance and is tracked on that dimension, not as a code gap",
    ],
  },
  "/register": {
    routeFile: "(stack)/register.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/register/page.tsx", "packages/shared/src/password-rules.ts"],
    gaps: [
      "the password rules panel and strength meter are ported, from the SAME module the web uses: apps/web/lib/passwordRules.ts moved to @proovra/shared/password-rules when Native needed it, and the web imports it from there. Two password panels that disagree about what a valid password is would be worse than either alone.",
      "this screen previously checked ONLY password.length >= 12, so a twelve-character all-lowercase password was submitted, refused by the server, and the user was told nothing about which of the other four rules they had missed",
    ],
  },
  "/forgot-password": {
    routeFile: "(stack)/forgot-password.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/forgot-password/page.tsx"],
    gaps: [
      "POST /v1/auth/password-reset/request, the same single endpoint the web calls, with the same deliberately indistinguishable answer for a known and an unknown address",
    ],
  },
  "/reset-password": {
    routeFile: "(stack)/reset-password.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/reset-password/page.tsx", "packages/shared/src/password-rules.ts"],
    gaps: [
      "POST /v1/auth/password-reset/confirm, reached by the emailed link through the credential deep-link family",
      "the same shared password rules panel as register and as both web pages - a reset that accepted a password the register screen would refuse is the kind of disagreement one module prevents",
    ],
  },
  "/auth/verify-email": {
    routeFile: "(stack)/verify-email.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/auth/verify-email/page.tsx"],
    gaps: [
      "POST /v1/auth/email/verify and the resend, reached by the emailed link",
      "the web additionally POSTs /v1/evidence/claim to adopt evidence captured while anonymous. Native has NO guest mode at all - auth-context.tsx states 'guest is no longer an authentication mode' and 'there is NO guest fallback: with no stored token the app stays signed out' - so there is nothing to claim, and porting it would post a guestToken that can never exist.",
    ],
  },
  "/auth/mfa-challenge": {
    routeFile: "(stack)/mfa.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/auth/mfa-challenge/page.tsx","apps/web/components/mfa-recovery/MfaRecoveryRequestPanel.tsx"],
    gaps: [
      "TOTP and recovery-code verification over POST /v1/auth/mfa/verify",
      "the lost-factor recovery CREATE leg is now here too. The verify leg and the admin approve/reject legs were wired long before anything in the product could FILE a request, and native had neither half: a user who lost their authenticator saw a code box and nothing else.",
      "the panel resolves its own eligibility with GET /v1/auth/session-light, because the create route refuses an MFA-pending token - a control that 401s on tap is worse than one that says why it cannot be used",
      "a 409 is not a failure: it carries the id of the request already in flight, which is the only route to the resend control for a user whose verification email never arrived",
    ],
  },
  "/auth/mfa-recovery/verify": {
    routeFile: "(stack)/mfa-recovery-verify.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/auth/mfa-recovery/verify/page.tsx"],
    gaps: [
      "reached by the emailed link through the credential deep-link family, which needs no session - the whole premise is that the user cannot get in",
      "the boundary is stated on success, not in fine print: confirming the email does not sign the user in and does not reset their second factor",
    ],
  },
  "/auth": {
    routeFile: "(stack)/auth.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/auth/page.tsx"],
    gaps: [
      "the auth gateway; email, Google and Apple, with the same canonical endpoints",
    ],
  },
  "/auth/callback/ui": {
    routeFile: "(stack)/auth.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/auth/callback/ui/page.tsx"],
    gaps: [
      "NOT A GAP, a platform difference: the web callback route exists because a browser OAuth flow has to land somewhere after the redirect. Native OAuth returns in-app through expo-auth-session, so there is no redirect to land, and a native screen for it would be a page nothing can reach.",
    ],
  },

  /* --------------------------------------------------------------- product */
  "/home": {
    routeFile: "(tabs)/index.tsx",
    status: "PARTIAL",
    webSources: [
      "apps/web/app/(app)/home/page.tsx",
      "apps/web/components/home-experience/SelfServeHomeDashboard.tsx",
      "apps/web/components/home-experience/useHomeData.ts",
      "apps/web/components/home-experience/home-view-model.ts",
    ],
    gaps: [
      "Overview tab ported: summary band, five canonical KPIs, severity-ranked priority queue, recent evidence, active matters, storage",
      "the web Operations / Analytics / Activity tabs are not ported — records-by-type donut, activity chart and the workspace-health matrix",
      "no enterprise CommandCenter fork (native targets the self-serve surface)",
      "device acceptance outstanding",
    ],
  },
  "/capture": {
    routeFile: "(stack)/capture.tsx",
    alsoRouteFiles: ["(stack)/screen-capture.tsx", "(stack)/continuous-capture.tsx"],
    status: "PARTIAL",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/capture/page.tsx", "apps/web/app/(app)/capture/_lib/*"],
    gaps: [
      "LEDGER CORRECTION: three of the four gaps recorded here were closed by the capture convergence and the row was never updated. Mixed media is supported (the type lock is gone; deriveBatchEvidenceType yields DOCUMENT for a mixed session); uploads compute their digests through expo-crypto with no crypto.subtle; and Discard no longer leaves a reserved Evidence record, because staging now opens a DRAFT capture session that holds no Evidence at all.",
      "still absent: capture templates, intake stages, readiness checks and suggestions",
      "native acquisition sources (UC-2 / UC-3 / UC-5) are reached from here and are deliberately NOT on Home",
      "device acceptance outstanding — docs/physical-acceptance.md section 2",
    ],
  },
  "/evidence": {
    routeFile: "(tabs)/evidence.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/evidence/page.tsx", "apps/web/app/(app)/evidence/evidence-library.css"],
    gaps: [
      "LEDGER CORRECTION: two of the three recorded gaps were stale. Saved-view management and bulk actions are both wired - parseSavedViews / buildSavedViewBody and the per-scope bulk action set over POST /v1/evidence/bulk, whose EVIDENCE_BULK_MAX_IDS is read from @proovra/shared so an over-long selection is refused and EXPLAINED before submitting rather than returning as an opaque 400.",
      "lifecycle state is now rendered, and only where it says something the scope tabs do not. The tabs already separate ARCHIVED and TRASHED; LOCKED is the one that coexists with ACTIVE, and a locked record was rendering identically to an unlocked one - 'this cannot be changed' is not a detail to leave a user to discover by trying.",
      "four lifecycle scopes, search, type/status/source/report filters, sort, cursor paging, workspace metrics and the record inspector",
    ],
  },
  "/evidence/[id]": {
    routeFile: "(stack)/evidence/[id].tsx",
    alsoRouteFiles: ["(stack)/legal/[slug].tsx"],
    status: "PARTIAL",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/evidence/[id]/page.tsx", "apps/web/app/(app)/evidence/[id]/_tabs/*"],
    gaps: [
      "ported: overview, integrity, custody, technical metadata, relationships, artifacts, the record's FILES, reviewer DISCUSSION, and the UC-4 derived review",
      "Files: the screen had custody, integrity and technical metadata but never listed the files themselves, so on a multi-part record - what every mixed-media capture produces - there was no way to see what was actually in it. `downloadable` is the SERVER's decision and is never widened: a control the server refused is not offered, and when it cannot be offered the reason is shown rather than a button that silently does nothing.",
      "Discussion: a record under review is discussed by the people reviewing it, and that conversation lived only on the web - a reviewer on a phone could read every hash and custody event and not a single word anyone had said. Visibility defaults to workspace-only, and an unrecognised visibility reads as the NARROWER one, because a comment that turns out wider than its author intended cannot be un-seen.",
      "not ported: annotations, legal notes, duplicate detection, and report REGENERATION (retrieval is present)",
    ],
  },
  "/cases": {
    routeFile: "(tabs)/cases.tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/(app)/cases/page.tsx"],
    gaps: ["no case summary metrics, bulk actions, or matter queue"],
  },
  "/cases/[id]": {
    routeFile: "(stack)/case/[id].tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/(app)/cases/[id]/page.tsx"],
    gaps: ["no access management, assignment mutation, risk, or export"],
  },
  "/search": {
    routeFile: "(stack)/search.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/search/page.tsx", "apps/web/app/(app)/search/search.css"],
    gaps: [
      "query, result families, typeahead, cursor paging, result count, the recency window, and the keyword/blended/meaning mode switch",
      "the mode switch appears ONLY when the server reports semantic search is available, and when the server answers with a different mode than the one asked for, the surface says so. A control that asks for meaning-based search and silently gets keyword is worse than no control: the user reads an empty result as 'nothing matches' rather than 'that was not the search I asked for'.",
      "an API build that reports no semantic envelope at all is treated as having no semantic search - the safe direction for a capability the client cannot otherwise observe",
      "9 of the 11 search endpoints are gated on isPlatformAdmin and are out of scope; saved views and the reconcile/backfill controls are the operator surface",
    ],
  },
  "/notifications": {
    routeFile: "(tabs)/notifications.tsx",
    alsoRouteFiles: ["(stack)/settings/notifications.tsx"],
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: [
      "apps/web/app/(app)/notifications/page.tsx",
      "apps/web/components/notifications/NotificationPreferencesPanel.tsx",
    ],
    gaps: [
      "severity ordering, category/unread filters, per-item read/unread/dismiss, mark-all, and snooze",
      "snooze had been modelled and tested here since before anything could reach it: the list had no control, and snoozedUntil was missing from the item type, so the return time the endpoint had always sent was invisible. Both are fixed, and a snoozed item states when it comes back.",
      "Q2 RESOLVED and its premise was wrong: NOTIFICATION_PREFERENCE_CHANNELS is [IN_APP, EMAIL] and the repository contains no push infrastructure at all. Preferences and the quiet-hours schedule are ported.",
      "contact-channel verification (/v1/communications/verify/*) deliberately NOT ported: it verifies a phone number, and with no SMS channel in the enum it would let a user configure a delivery the platform cannot perform",
      "delivery history is an operator surface and stays excluded",
    ],
  },
  "/inbox": {
    routeFile: "(tabs)/notifications.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/inbox/page.tsx"],
    gaps: [
      "ALIAS, not a second surface: next.config.mjs answers /inbox with a permanent 308 to /notifications, so the web never renders app/(app)/inbox/page.tsx at all. Native converges the same way, onto (tabs)/notifications.tsx over the same /v1/me/inbox envelope.",
      "the shadowed web page is unreachable dead code and is a deletion candidate (tracked in the duplication pass), not a Native gap",
    ],
  },
  "/settings": {
    routeFile: "(tabs)/settings.tsx",
    alsoRouteFiles: [
      "(stack)/settings/security.tsx",
      "(stack)/settings/notifications.tsx",
      "(stack)/settings/privacy.tsx",
      "(stack)/settings/reviewer-criteria.tsx",
    ],
    status: "PARTIAL",
    physicallyAccepted: false,
    webSources: [
      "apps/web/app/(app)/settings/page.tsx",
      "apps/web/app/(app)/settings/_sections/*",
      "apps/web/lib/settings/settingsNavigation.ts",
    ],
    gaps: [
      "a responsive web PANE model split into native screens, because the web renders Settings as one page with a pane switcher and that does not fit a phone",
      "ported: account, language, security (password, sign-in methods, two-factor, sessions, activity), notification preferences and quiet hours, PRIVACY (data export and account closure), reviewer criteria, organizations, workspace people, quotas, batch analysis, billing, legal and support",
      "Privacy closes the largest hole: data export and account closure are rights a user has over their own account and neither existed on the device. All three safety facts come from the server and none is restated in the client - the blockers, the exact confirmationPhrase the route checks, and the cooling-off period. A phrase the client believed in and the route rejected would make closure impossible with no explanation the user could act on.",
      "not ported: TOTP ENROLMENT start/verify (removal and status are present), and the cookie-consent control, which governs a web browser's storage and has no device analogue",
    ],
  },
  "/reports": {
    routeFile: "(stack)/reports.tsx",
    status: "PARTIAL",
    webSources: [
      "apps/web/app/(app)/reports/page.tsx",
      "apps/web/components/reports-experience/ReportsIndex.tsx",
    ],
    gaps: [
      "deliverables index ported: six canonical counters, lifecycle filters, cursor paging, result count, per-row state",
      "read-only, as the web index is — generation and download are gated on Evidence detail",
      "no saved views (operator surface), no per-row download yet",
      "device acceptance outstanding",
    ],
  },
  "/billing": {
    routeFile: "(stack)/billing.tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/(app)/billing/page.tsx", "apps/web/app/(app)/billing/billing.css"],
    gaps: ["read-only; no plan change, storage add-ons, or checkout handoff"],
  },
  "/pricing": {
    routeFile: "(stack)/billing.tsx",
    status: "PARTIAL",
    physicallyAccepted: false,
    webSources: ["apps/web/app/pricing/page.tsx"],
    gaps: [
      "converged onto Billing, which is where the endpoint says this content belongs: buildPricingCatalogResponse is published 'so the public Pricing page AND in-app Billing UI both source Enterprise capability copy from the same place'. Same GET /v1/billing/pricing, no second price list.",
      "NO purchase, upgrade or checkout control, and the screen states the reason rather than leaving a missing button: mobile app-store rules govern digital-goods purchases inside an app. This is a commercial/compliance decision, not an implementation gap.",
      "not ported: the marketing page's comparison chrome, storage add-on catalogue and the pay-per-evidence credit offer",
    ],
  },
  "/intake-links": {
    routeFile: "(stack)/intake-links.tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/(app)/intake-links/page.tsx", "apps/web/app/(app)/intake-links/intake-links.css"],
    gaps: ["view + revoke only; no send, submissions, archive, or recipient-contact reveal"],
  },
  "/evidence-requests/[id]": {
    routeFile: "(stack)/evidence-request/[id].tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/(app)/evidence-requests/[id]/page.tsx"],
    gaps: ["no send, cancel, close, needs-more-info, deliveries, or response review"],
  },
  "/collaboration-teams": {
    routeFile: "(tabs)/teams.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/collaboration-teams/page.tsx"],
    gaps: [
      "the list, cursor paging, and group creation gated on the SERVER's canCreateCollaborationTeam",
      "the client computes no capacity. The entitlement envelope's own words: 'Server-decided affordances. The browser renders these; it does not derive them. Each is the same predicate its gate enforces, so an enabled control and a 2xx cannot drift apart.' The web console's comment records the alternative - a user who 'saw 1 of 2, got an enabled Create button, and met a 409'.",
      "when creation is refused the reason is shown, from the server's exceededDimensions and plan lock, rather than an enabled control that meets a 409",
      "a 403 on the list is the workspace having no collaboration capability - rendered as an honest unavailable state, never as an error",
    ],
  },
  "/collaboration-teams/[teamId]": {
    routeFile: "(stack)/collaboration-team/[id].tsx",
    status: "PARTIAL",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx"],
    gaps: [
      "ported: overview, members, pending invitations and Discussion (threads, messages, resolve/reopen)",
      "not ported: the Work tab (the group's operational assignments) and the Settings tab, which also carries the administrative activity history",
      "a 404 from any collaboration route is an AUTHORIZATION answer - the routes answer 404 rather than 403 so a denial never confirms a group exists - and Discussion renders it as 'open to reviewers', never as 'there is nothing here'",
    ],
  },
  "/collaboration-teams/[teamId]/collaboration": {
    routeFile: "(stack)/collaboration-team/[id].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx"],
    gaps: [
      "RETIRED DESTINATION, and the web page says so: it was a second page for one group holding five panels, three of which did nothing at all (guests wrote a row and sent no invitation, access review enforced no decision, the Daily digest had no consumer in the worker) and two of which duplicated existing surfaces. It survives as a redirect to ?tab=discussion because the links are in people's history.",
      "Native converges the same way: the conversation lives beside the group's members on (stack)/collaboration-team/[id].tsx, not behind a second screen.",
    ],
  },
  "/collaboration-teams/invites/[token]/accept": {
    routeFile: "(stack)/invite/[token].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/collaboration-teams/invites/[token]/accept/page.tsx"],
    gaps: [
      "the same acceptance surface as /invite/[token] - one native screen, because they are one flow reached by one link",
    ],
  },
  "/invite/[token]": {
    routeFile: "(stack)/invite/[token].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/collaboration-teams/invites/[token]/accept/page.tsx"],
    gaps: [
      "POST /v1/collaboration-team-invites/:token/accept, with the intent preserved through Sign In when there is no session",
      "400/404 collapse to one answer (invalid, expired or already used), which is the anti-enumeration behaviour the route intends",
    ],
  },
  "/org-invites/[token]/accept": {
    routeFile: "(stack)/org-invite/[token].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/org-invites/[token]/accept/page.tsx"],
    gaps: [
      "a SEPARATE family from the collaboration invite: different token namespace and endpoint. Sending an org token to /v1/collaboration-team-invites answers 404 by design, which would tell the user their invitation was invalid when it was only sent to the wrong place.",
      "a 401 preserves the intent through Sign In, which is what the web's ?next= does without a URL to carry",
      "with workspace grants the member chooses where to go, matching the web's deliberate removal of the auto-redirect",
    ],
  },
  "/organizations": {
    routeFile: "(stack)/organizations/index.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/organizations/page.tsx"],
    gaps: [
      "membership-gated, not enterprise-gated: every authenticated user gets it, over the same GET /v1/me/orgs the web reads",
      "the CUSTOMER-kind and ACTIVE-membership filters are the SERVER'S and are not re-applied client-side - a client filter over a server-filtered list is a second authority that will disagree the moment either changes",
    ],
  },
  "/organizations/[id]": {
    routeFile: "(stack)/organizations/[id].tsx",
    status: "PARTIAL",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/organizations/[id]/page.tsx"],
    gaps: [
      "ported: governance detail, members and workspaces, each loading independently so one role-gated refusal never blanks the page",
      "NOT ported, deliberately: ownership transfer, leaving the organization, and closure. Each is a one-way door the web builds real confirmation around, and a phone-sized version of a one-way door is not a smaller feature but a worse one. The screen says where they are rather than implying they do not exist.",
      "not ported: the org audit-event feed and invitation management",
    ],
  },
  "/people": {
    routeFile: "(stack)/workspace-people.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/people/page.tsx"],
    gaps: [
      "RESOLVER, not a surface: the web page reads no membership and renders no roster. Its whole job is to answer which workspace's people and replace() itself out of the back stack. Native has no URL bar, so the destination takes the active workspace from the canonical platform context directly and there is nothing left to resolve.",
    ],
  },
  "/teams/[id]": {
    routeFile: "(stack)/workspace-people.tsx",
    status: "PARTIAL",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/teams/[id]/page.tsx"],
    gaps: [
      "Workspace People ported: roster with roles and status, cursor paging, seats from the server's stats, invite/resend/revoke gated on canManageMembers",
      "counts come from stats, never from members.length - the web route's own comment records what happened when a detail read carried every membership",
      "not ported: ownership transfer, workspace closure, role changes on an existing member, case links and the activity feed",
    ],
  },
  "/workspaces": {
    routeFile: "(stack)/workspace-people.tsx",
    status: "PARTIAL",
    physicallyAccepted: false,
    webSources: [
      "apps/web/app/(app)/workspaces/page.tsx",
      "apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx",
    ],
    gaps: [
      "the canonical workspace-admin landing. Its people/seats half is ported onto the same native screen as /teams/[id] and /people - one workspace roster, not three.",
      "not ported: the administration home's workspace LIST and cross-workspace administration; native switches workspace through the account menu rather than administering several at once",
    ],
  },
  "/operations/batch-analysis": {
    routeFile: "(stack)/operations/batch-analysis.tsx",
    status: "PARTIAL",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/operations/batch-analysis/page.tsx"],
    gaps: [
      "Q3 RESOLVED from the registry itself: dashboard.batch_analysis states \"Gate stays PERSONAL_WORKSPACE - self-service view\". It shares the /operations URL prefix with the OPS console (a Phase R7.5 move from /dashboard) but its domain is PERSONAL_WORKSPACE, so the derivation is right and there is no registry omission to correct.",
      "read-only: the list and per-job progress are ported; create, process, cancel and export are not, and are absent rather than stubbed",
      "UPSTREAM DEFECT, not ported over: BatchAnalysisService keeps jobs in a process-local object (private jobs = {}), so the list is neither durable nor shared across API instances. Native matches the web exactly rather than diverging, but the console can legitimately show nothing after a restart.",
      "the endpoint computes progress as (processed + failed) / totalItems with no zero guard; the native projection clamps it and reports null for a job with no items",
    ],
  },
  "/operations/quotas": {
    routeFile: "(stack)/operations/quotas.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/operations/quotas/page.tsx"],
    gaps: [
      "Q3 RESOLVED from the registry itself: dashboard.quotas states \"Gate stays PERSONAL_WORKSPACE/DASHBOARD_VIEW: this is a self-service quota view, NOT a platform-admin tool.\"",
      "both canonical sources ported (/v1/quotas, /v1/usage-stats), read independently so a usage failure never blanks the allowances",
    ],
  },
  "/settings/reviewer-criteria": {
    routeFile: "(stack)/settings/reviewer-criteria.tsx",
    status: "PARTIAL",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/settings/reviewer-criteria/page.tsx"],
    gaps: [
      "ported: the catalogue with per-set status and latest version, and the publish / duplicate / retire transitions, each stating its consequence before it happens",
      "no edit affordance on a PUBLISHED set, deliberately: the API answers 409 published_immutable, and offering an action that cannot succeed implies the record could be rewritten - which is what versioned criteria exist to prevent",
      "not ported: authoring the criterion rows of a draft (a multi-row editor; a draft half-written on a phone is a draft nobody can publish) and the per-version usage read",
      "gated on REVIEWER_OPS_VIEW, which a personal workspace does not hold at all - the 403 renders as 'this workspace has no reviewer workflow', never as an error",
    ],
  },

  /* ------------------------------------------------- public / trust / legal */
  "/verify": {
    routeFile: "verify.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/verify/page.tsx", "apps/web/app/verify/_components/*"],
    gaps: [
      "paste-to-verify, the record's integrity artifacts, and the custody list",
      "the BOUNDARY section is ported, which was the gap that mattered: the screen had hashes, a custody list and a green badge with nothing to bound them, and a verification surface that shows a tick and says nothing about its limits makes exactly the overclaim the safe-language contract forbids - the reader supplies the missing sentence, and supplies the wrong one",
      "both claim lists are quoted VERBATIM from @proovra/shared-evidence-presentation's claims-matrix, the canonical list the contract tests grep against. The heading carries the negation once rather than rewriting each line, because string surgery on canonical text is not good enough on a legal-boundary surface.",
      "the marketing landing's use-case and materials sections are not ported and are not product: the native entry is the verify action itself",
    ],
  },
  "/verify/[token]": {
    routeFile: "verify.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/verify/[token]/page.tsx"],
    gaps: [
      "public verification of a record by its token, over the same public endpoint",
    ],
  },
  "/share/[id]": {
    routeFile: null,
    status: "BLOCKED_BY_USER_DECISION",
    blockedBy: "Q5",
    webSources: ["apps/web/app/share/[id]/page.tsx"],
    gaps: [
      "THE WEB SURFACE IS DECOMMISSIONED AND SAYS SO. The page renders 'Share Link Page Not Active - This page is not used in the current sharing flow', inside a marketing shell. It reads no share, resolves no id and calls no API.",
      "Zero inbound links: every remaining reference to /share/ is a path-PREFIX rule in privacy redaction and analytics rejection (apps/web/lib/privacy/redact.ts, packages/shared/src/tenant-url.ts and their tests), which are about URLs that may still exist in logs, not about this page.",
      "Porting a page whose own text says it is not used would be building a dead surface. Deleting the web route changes what a live URL answers - today a polite notice, afterwards a 404 - which is a web product decision, not a Native one.",
    ],
  },
  "/legal/[slug]": {
    routeFile: "(stack)/legal/[slug].tsx",
    alsoRouteFiles: ["(stack)/legal/index.tsx"],
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: [
      "apps/web/app/legal/[slug]/page.tsx",
      "apps/web/app/legal/legal-content.tsx",
      "apps/web/content/legal/en/*.md",
    ],
    gaps: [
      "Q1 RESOLVED: the corpus is served by GET /v1/legal/:slug from @proovra/shared/legal, generated from the one authored corpus. Nothing is bundled and no browser is opened.",
      "the web reader's enhance pass (provider panels, contact rows, chip rows) is a desktop reading affordance and is deliberately not reproduced",
    ],
  },
  "/settings/legal/[slug]": {
    routeFile: "(stack)/legal/[slug].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: [
      "apps/web/app/(app)/settings/legal/[slug]/page.tsx",
      "apps/web/app/legal/legal-content.tsx",
    ],
    gaps: [
      "the web has two readers for one corpus because it has two shells (public and App Shell); native has one stack, so a cross-reference simply pushes the next document",
    ],
  },
  "/privacy": {
    routeFile: "(stack)/legal/[slug].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/privacy/page.tsx"],
    gaps: [
      "the web route is nothing but redirect(\"/legal/privacy\"); native resolves it to the same reader via parsePublicDocumentDeepLink rather than giving it a screen",
    ],
  },
  "/terms": {
    routeFile: "(stack)/legal/[slug].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/terms/page.tsx"],
    gaps: [
      "the web route is nothing but redirect(\"/legal/terms\"); native resolves it to the same reader via parsePublicDocumentDeepLink rather than giving it a screen",
    ],
  },
  "/subprocessors": {
    routeFile: "(stack)/legal/[slug].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/subprocessors/page.tsx"],
    gaps: [
      "the web route is nothing but redirect(\"/legal/subprocessors\"); native resolves it to the same reader via parsePublicDocumentDeepLink rather than giving it a screen",
    ],
  },
  "/data-retention": {
    routeFile: "(stack)/legal/[slug].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/data-retention/page.tsx"],
    gaps: [
      "the web route is nothing but redirect(\"/legal/data-retention\"); native resolves it to the same reader via parsePublicDocumentDeepLink rather than giving it a screen",
    ],
  },
  "/abuse-reporting": {
    routeFile: "(stack)/legal/[slug].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/abuse-reporting/page.tsx"],
    gaps: [
      "the web route is nothing but redirect(\"/legal/abuse-reporting\"); native resolves it to the same reader via parsePublicDocumentDeepLink rather than giving it a screen",
    ],
  },

  "/support": {
    routeFile: "(stack)/support.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/support/page.tsx"],
    gaps: [
      "a real in-app destination despite being a public page: the authenticated app routes users here from five call sites (app/(app)/error.tsx, not-found.tsx, Search, billing), so a phone user who hit an error had nowhere to go",
      "every reference document opens in the canonical legal reader by SLUG, so no DPA or security overview text is copied into the app; the Trust Center route is the IN-APP one, not the public marketing page",
      "the four route cards and their contact addresses are UI copy over a fixed set of destinations, which is the one thing here with no canonical source to read from",
    ],
  },
  "/trust": {
    routeFile: "(stack)/trust-center.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: [
      "apps/web/app/trust/page.tsx",
      "packages/shared-evidence-presentation/src/trust-center-content.ts",
    ],
    gaps: [
      "the canonical copy is ALREADY a shared package. apps/web/app/trust/page.tsx imports TRUST_CENTER_SECTIONS / PAGE_INTRO / BOUNDARY_CALLOUT from @proovra/shared-evidence-presentation and keeps importing them specifically so the module 'stays available to any private/authenticated Trust Center surface (e.g. an in-product hub) that needs to render the full list'. That surface is the native Trust Center, which now renders it.",
      "Native imports the shared package rather than copying the text or adding an endpoint to re-serve it: it is already the declared source of truth, and a second copy of a boundary statement is the one kind of drift a trust surface cannot afford.",
      "the public page's marketing chrome is not ported and is not meant to be - the web itself treats /trust as a PUBLIC EXIT from the App Shell (isAuthenticatedPublicExit), and it dropped its own visible sections band as a UX decision about that page, not about the content",
    ],
  },
  "/trust-center": {
    routeFile: "(stack)/trust-center.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/trust-center/page.tsx"],
    gaps: [
      "one native screen with a section per article kind, each loading and failing independently, over the same GET /v1/trust/articles?kind=",
      "version history ported: an article's earlier versions are readable, and a version that was never published is MARKED rather than hidden - it is not a position the platform ever held, but its existence is part of the record",
      "the canonical public trust copy (@proovra/shared-evidence-presentation) renders here too, including every section's LIMITATIONS: a trust surface that lists what a subsystem records and omits what it does not establish is making the overclaim the boundary contract exists to stop",
      "authoring and publishing articles stays on the web; it is a delegated-tier operator action",
    ],
  },
  "/trust-center/ai-disclosure": {
    routeFile: "(stack)/trust-center.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/trust-center/ai-disclosure/page.tsx"],
    gaps: [
      "one native screen with a section per article kind, each loading and failing independently, over the same GET /v1/trust/articles?kind=",
      "version history ported: an article's earlier versions are readable, and a version that was never published is MARKED rather than hidden - it is not a position the platform ever held, but its existence is part of the record",
      "the canonical public trust copy (@proovra/shared-evidence-presentation) renders here too, including every section's LIMITATIONS: a trust surface that lists what a subsystem records and omits what it does not establish is making the overclaim the boundary contract exists to stop",
      "authoring and publishing articles stays on the web; it is a delegated-tier operator action",
    ],
  },
  "/trust-center/methodology": {
    routeFile: "(stack)/trust-center.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/trust-center/methodology/page.tsx"],
    gaps: [
      "one native screen with a section per article kind, each loading and failing independently, over the same GET /v1/trust/articles?kind=",
      "version history ported: an article's earlier versions are readable, and a version that was never published is MARKED rather than hidden - it is not a position the platform ever held, but its existence is part of the record",
      "the canonical public trust copy (@proovra/shared-evidence-presentation) renders here too, including every section's LIMITATIONS: a trust surface that lists what a subsystem records and omits what it does not establish is making the overclaim the boundary contract exists to stop",
      "authoring and publishing articles stays on the web; it is a delegated-tier operator action",
    ],
  },
  "/trust-center/security": {
    routeFile: "(stack)/trust-center.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/trust-center/security/page.tsx"],
    gaps: [
      "one native screen with a section per article kind, each loading and failing independently, over the same GET /v1/trust/articles?kind=",
      "version history ported: an article's earlier versions are readable, and a version that was never published is MARKED rather than hidden - it is not a position the platform ever held, but its existence is part of the record",
      "the canonical public trust copy (@proovra/shared-evidence-presentation) renders here too, including every section's LIMITATIONS: a trust surface that lists what a subsystem records and omits what it does not establish is making the overclaim the boundary contract exists to stop",
      "authoring and publishing articles stays on the web; it is a delegated-tier operator action",
    ],
  },
  "/trust-center/status": {
    routeFile: "(stack)/trust-center.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/trust-center/status/page.tsx"],
    gaps: [
      "one native screen with a section per article kind, each loading and failing independently, over the same GET /v1/trust/articles?kind=",
      "version history ported: an article's earlier versions are readable, and a version that was never published is MARKED rather than hidden - it is not a position the platform ever held, but its existence is part of the record",
      "the canonical public trust copy (@proovra/shared-evidence-presentation) renders here too, including every section's LIMITATIONS: a trust surface that lists what a subsystem records and omits what it does not establish is making the overclaim the boundary contract exists to stop",
      "authoring and publishing articles stays on the web; it is a delegated-tier operator action",
    ],
  },
  "/trust-center/subprocessors": {
    routeFile: "(stack)/trust-center.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/trust-center/subprocessors/page.tsx"],
    gaps: [
      "one native screen with a section per article kind, each loading and failing independently, over the same GET /v1/trust/articles?kind=",
      "version history ported: an article's earlier versions are readable, and a version that was never published is MARKED rather than hidden - it is not a position the platform ever held, but its existence is part of the record",
      "the canonical public trust copy (@proovra/shared-evidence-presentation) renders here too, including every section's LIMITATIONS: a trust surface that lists what a subsystem records and omits what it does not establish is making the overclaim the boundary contract exists to stop",
      "authoring and publishing articles stays on the web; it is a delegated-tier operator action",
    ],
  },

  /* --------------------------------------------------- intake / portal flows */
  "/intake/[token]": {
    routeFile: null,
    status: "BLOCKED_BY_EXTERNAL",
    blockedBy: "the production web domain must host /.well-known/apple-app-site-association and /.well-known/assetlinks.json, and the app must declare associatedDomains (iOS) and App Links intent filters (Android) for it. docs/EXTERNAL_CONFIG.md records this as 'Universal / App Links (M7) - pending'; app.json declares only the proovra:// scheme and no domain at all.",
    webSources: ["apps/web/app/intake/[token]/page.tsx"],
    gaps: [
      "TOKEN-ONLY ENTRY: this surface is reachable only by its link. The API mints that link from WEB_BASE_URL as an https URL (evidence-request.service.ts, workflow-intake-links.routes.ts, portal-invitation-email.service.ts) and no proovra:// form of it exists anywhere, so on a phone it opens the browser and will keep doing so until the association files are hosted.",
      "Building the screen first would recreate the exact failure this conversion already fixed once: (stack)/verify-email, reset-password and invite/[token] were complete screens that NOTHING in the app could navigate to, while a superseded contract called them REACHABLE.",
      "The page states its own contract: it calls no authenticated endpoint and passes auth:false so the reader's session is never attached. Its reader is an external contributor with no PROOVRA account.",
    ],
  },
  "/intake/[token]/capture": {
    routeFile: null,
    status: "BLOCKED_BY_EXTERNAL",
    blockedBy: "the production web domain must host /.well-known/apple-app-site-association and /.well-known/assetlinks.json, and the app must declare associatedDomains (iOS) and App Links intent filters (Android) for it. docs/EXTERNAL_CONFIG.md records this as 'Universal / App Links (M7) - pending'; app.json declares only the proovra:// scheme and no domain at all.",
    webSources: ["apps/web/app/intake/[token]/capture/page.tsx"],
    gaps: [
      "TOKEN-ONLY ENTRY: this surface is reachable only by its link. The API mints that link from WEB_BASE_URL as an https URL (evidence-request.service.ts, workflow-intake-links.routes.ts, portal-invitation-email.service.ts) and no proovra:// form of it exists anywhere, so on a phone it opens the browser and will keep doing so until the association files are hosted.",
      "Building the screen first would recreate the exact failure this conversion already fixed once: (stack)/verify-email, reset-password and invite/[token] were complete screens that NOTHING in the app could navigate to, while a superseded contract called them REACHABLE.",
      "Uploads go straight to S3 via presigned PUT from the public API, deliberately outside the authenticated capture orchestration the app is built around.",
    ],
  },
  "/portal": {
    routeFile: null,
    status: "BLOCKED_BY_EXTERNAL",
    blockedBy: "the production web domain must host /.well-known/apple-app-site-association and /.well-known/assetlinks.json, and the app must declare associatedDomains (iOS) and App Links intent filters (Android) for it. docs/EXTERNAL_CONFIG.md records this as 'Universal / App Links (M7) - pending'; app.json declares only the proovra:// scheme and no domain at all.",
    webSources: ["apps/web/app/portal/page.tsx"],
    gaps: [
      "TOKEN-ONLY ENTRY: this surface is reachable only by its link. The API mints that link from WEB_BASE_URL as an https URL (evidence-request.service.ts, workflow-intake-links.routes.ts, portal-invitation-email.service.ts) and no proovra:// form of it exists anywhere, so on a phone it opens the browser and will keep doing so until the association files are hosted.",
      "Building the screen first would recreate the exact failure this conversion already fixed once: (stack)/verify-email, reset-password and invite/[token] were complete screens that NOTHING in the app could navigate to, while a superseded contract called them REACHABLE.",
      "The external reviewer portal entry. Its reader is a reviewer outside the workspace.",
    ],
  },
  "/portal/[token]": {
    routeFile: null,
    status: "BLOCKED_BY_EXTERNAL",
    blockedBy: "the production web domain must host /.well-known/apple-app-site-association and /.well-known/assetlinks.json, and the app must declare associatedDomains (iOS) and App Links intent filters (Android) for it. docs/EXTERNAL_CONFIG.md records this as 'Universal / App Links (M7) - pending'; app.json declares only the proovra:// scheme and no domain at all.",
    webSources: ["apps/web/app/portal/[token]/page.tsx"],
    gaps: [
      "TOKEN-ONLY ENTRY: this surface is reachable only by its link. The API mints that link from WEB_BASE_URL as an https URL (evidence-request.service.ts, workflow-intake-links.routes.ts, portal-invitation-email.service.ts) and no proovra:// form of it exists anywhere, so on a phone it opens the browser and will keep doing so until the association files are hosted.",
      "Building the screen first would recreate the exact failure this conversion already fixed once: (stack)/verify-email, reset-password and invite/[token] were complete screens that NOTHING in the app could navigate to, while a superseded contract called them REACHABLE.",
      "The reviewer dashboard authenticates with the route token as its own bearer - a session that is not a PROOVRA user session.",
    ],
  },
  "/portal/[token]/work/[workflowId]": {
    routeFile: null,
    status: "BLOCKED_BY_EXTERNAL",
    blockedBy: "the production web domain must host /.well-known/apple-app-site-association and /.well-known/assetlinks.json, and the app must declare associatedDomains (iOS) and App Links intent filters (Android) for it. docs/EXTERNAL_CONFIG.md records this as 'Universal / App Links (M7) - pending'; app.json declares only the proovra:// scheme and no domain at all.",
    webSources: ["apps/web/app/portal/[token]/work/[workflowId]/page.tsx"],
    gaps: [
      "TOKEN-ONLY ENTRY: this surface is reachable only by its link. The API mints that link from WEB_BASE_URL as an https URL (evidence-request.service.ts, workflow-intake-links.routes.ts, portal-invitation-email.service.ts) and no proovra:// form of it exists anywhere, so on a phone it opens the browser and will keep doing so until the association files are hosted.",
      "Building the screen first would recreate the exact failure this conversion already fixed once: (stack)/verify-email, reset-password and invite/[token] were complete screens that NOTHING in the app could navigate to, while a superseded contract called them REACHABLE.",
      "Reached only from inside the portal dashboard, which is itself token-only.",
    ],
  },
  "/portal/accept/[grantId]": {
    routeFile: null,
    status: "BLOCKED_BY_EXTERNAL",
    blockedBy: "the production web domain must host /.well-known/apple-app-site-association and /.well-known/assetlinks.json, and the app must declare associatedDomains (iOS) and App Links intent filters (Android) for it. docs/EXTERNAL_CONFIG.md records this as 'Universal / App Links (M7) - pending'; app.json declares only the proovra:// scheme and no domain at all.",
    webSources: ["apps/web/app/portal/accept/[grantId]/page.tsx"],
    gaps: [
      "TOKEN-ONLY ENTRY: this surface is reachable only by its link. The API mints that link from WEB_BASE_URL as an https URL (evidence-request.service.ts, workflow-intake-links.routes.ts, portal-invitation-email.service.ts) and no proovra:// form of it exists anywhere, so on a phone it opens the browser and will keep doing so until the association files are hosted.",
      "Building the screen first would recreate the exact failure this conversion already fixed once: (stack)/verify-email, reset-password and invite/[token] were complete screens that NOTHING in the app could navigate to, while a superseded contract called them REACHABLE.",
      "portal-invitation-email.service.ts mints this from WEB_BASE_URL as /portal/accept/<grantId>?token=...",
    ],
  },
};

/** Counts by status — used by the ledger report and the coverage guard. */
export function destinationCounts() {
  const counts = { NOT_STARTED: 0, BLOCKED_BY_DECISION: 0, SHELL: 0, PARTIAL: 0, PARITY: 0 };
  for (const d of Object.values(NATIVE_DESTINATIONS)) counts[d.status] += 1;
  return counts;
}
