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
    status: "PARTIAL",
    webSources: ["apps/web/app/login/page.tsx"],
    gaps: ["Google unconfigured in built binaries (B-2)", "visual parity with web auth shell unverified"],
  },
  "/register": {
    routeFile: "(stack)/register.tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/register/page.tsx"],
    gaps: ["password-requirement affordances + visual parity unverified"],
  },
  "/forgot-password": {
    routeFile: "(stack)/forgot-password.tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/forgot-password/page.tsx"],
    gaps: [],
  },
  "/reset-password": {
    routeFile: "(stack)/reset-password.tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/reset-password/page.tsx"],
    gaps: [],
  },
  "/auth/verify-email": {
    routeFile: "(stack)/verify-email.tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/auth/verify-email/page.tsx"],
    gaps: [],
  },
  "/auth/mfa-challenge": {
    routeFile: "(stack)/mfa.tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/auth/mfa-challenge/page.tsx"],
    gaps: [],
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
    status: "PARTIAL",
    webSources: ["apps/web/app/auth/page.tsx"],
    gaps: [],
  },
  "/auth/callback/ui": {
    routeFile: "(stack)/auth.tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/auth/callback/ui/page.tsx"],
    gaps: ["native OAuth returns in-app rather than via a web callback route"],
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
    status: "PARTIAL",
    webSources: ["apps/web/app/(app)/evidence/page.tsx", "apps/web/app/(app)/evidence/evidence-library.css"],
    gaps: ["no saved-view management", "no bulk archive/lock", "no lifecycle-state rendering"],
  },
  "/evidence/[id]": {
    routeFile: "(stack)/evidence/[id].tsx",
    status: "PARTIAL",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/evidence/[id]/page.tsx", "apps/web/app/(app)/evidence/[id]/_tabs/*"],
    gaps: [
      "no download of the original",
      "no comments / annotations / legal notes / duplicates",
      "no report regeneration (retrieval is present)",
      "UC-4 DISPOSITION: the Derived Review tab is ported, under the SAME record-property gate the web applies (acquisition category DIRECT_SCREEN_CAPTURE, never a workspace kind). Read + generate/regenerate over /v1/evidence/:id/derived-review. It matters more here than on the web: UC-2, UC-3 and UC-5 are the modes that PRODUCE those records, and the device that made the recording could not read what was reconstructed from it.",
      "derived blocks are paged server-side; the native tab reads the first page and states the remainder rather than paging",
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
    status: "PARTIAL",
    webSources: ["apps/web/app/(app)/search/page.tsx", "apps/web/app/(app)/search/search.css"],
    gaps: [
      "query, result families, typeahead, cursor paging and result count ported",
      "9 of the 11 /v1/search* endpoints are operator surfaces gated on isPlatformAdmin (saved views, audit, diagnostics, reconcile, semantic backfill) and are correctly excluded",
      "no semantic/hybrid mode switch, no updatedSince filter, no relationship search",
      "device acceptance outstanding",
    ],
  },
  "/notifications": {
    routeFile: "(tabs)/notifications.tsx",
    alsoRouteFiles: ["(stack)/settings/notifications.tsx"],
    status: "PARTIAL",
    physicallyAccepted: false,
    webSources: [
      "apps/web/app/(app)/notifications/page.tsx",
      "apps/web/components/notifications/NotificationPreferencesPanel.tsx",
    ],
    gaps: [
      "severity ordering, category/unread filters and per-item read/unread/dismiss ported",
      "snooze is modelled and testable but has no control on the row yet",
      "Q2 RESOLVED, and its premise was wrong: NOTIFICATION_PREFERENCE_CHANNELS is [IN_APP, EMAIL] and the repository contains no push infrastructure at all, so these preferences never governed push. They govern the inbox Native already renders and the email a Native user already receives. Preferences and schedule are ported.",
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
    // A responsive web PANE model split into native screens: the web renders
    // Settings as one page with a pane switcher, which does not fit a phone.
    // The order allows one web surface to map to several native ones; the
    // guard checks every file named here.
    routeFile: "(tabs)/settings.tsx",
    alsoRouteFiles: ["(stack)/settings/security.tsx"],
    status: "PARTIAL",
    webSources: [
      "apps/web/app/(app)/settings/page.tsx",
      "apps/web/app/(app)/settings/_sections/*",
      "apps/web/lib/settings/settingsNavigation.ts",
      "apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx",
    ],
    gaps: [
      "Security pane ported (password, sign-in methods, two-factor, sessions, activity)",
      "TOTP enrolment start/verify not yet surfaced; step-up reported but not collected in-app",
      "privacy pane (data export, account closure, cookie consent) not started",
      "notification preferences and schedule not started",
      "billing overview read-only",
      "device acceptance outstanding for everything above",
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
    routeFile: null,
    status: "NOT_STARTED",
    webSources: ["apps/web/app/pricing/page.tsx"],
    gaps: ["no Native plan catalogue; upgrade path undefined"],
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
    status: "PARTIAL",
    webSources: ["apps/web/app/(app)/collaboration-teams/page.tsx"],
    gaps: ["read-only list"],
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
    status: "PARTIAL",
    webSources: ["apps/web/app/(app)/collaboration-teams/invites/[token]/accept/page.tsx"],
    gaps: [],
  },
  "/invite/[token]": {
    routeFile: "(stack)/invite/[token].tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/invite/[token]/page.tsx"],
    gaps: [],
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
    status: "PARTIAL",
    webSources: ["apps/web/app/verify/page.tsx", "apps/web/app/verify/_components/VerifyHero.tsx"],
    gaps: ["paste-to-verify entry present; the explanatory sections are not ported"],
  },
  "/verify/[token]": {
    routeFile: "verify.tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/verify/[token]/page.tsx"],
    gaps: [],
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
    routeFile: null,
    status: "NOT_STARTED",
    webSources: ["apps/web/app/support/page.tsx"],
    gaps: [
      "LEDGER CORRECTION: this row was recorded as blocked by Q1 (legal delivery). It is not. apps/web/app/support/page.tsx is a Support Operations Center page built from marketing components and contact routes, and reads no legal document. The legal corpus does contain a `support` slug (Support Policy), which is a different thing and is now reachable through the legal reader.",
      "signed-in users are routed here by app/(app)/error.tsx, not-found.tsx, billing and Search, so it is a real destination with no Native equivalent",
    ],
  },
  "/trust": {
    routeFile: null,
    status: "NOT_STARTED",
    webSources: [
      "apps/web/app/trust/page.tsx",
      "apps/web/lib/trust/trust-center-copy.ts",
    ],
    gaps: [
      "LEDGER CORRECTION: this row was recorded as blocked by Q1 (legal delivery). It is not. The public Trust Center renders TRUST_CENTER_SECTIONS / TRUST_CENTER_PAGE_INTRO constants under a safe-language contract, and reads no legal document.",
      "distinct from the in-app /trust-center/* articles, which ARE ported ((stack)/trust-center.tsx) and come from GET /v1/trust/articles",
      "the public page's copy has no API; porting it needs the constants to become canonical data or the page to be accepted as web-only",
    ],
  },
  "/trust-center": {
    // The five web trust-centre routes converge onto ONE native screen with a
    // section per article kind. Same canonical source (/v1/trust/articles); a
    // phone has no sidebar to hold five destinations that each show one list.
    routeFile: "(stack)/trust-center.tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/(app)/trust-center/_section-list.tsx"],
    gaps: [
      "version history (/v1/trust/articles/:id/versions) not ported",
      "device acceptance outstanding",
    ],
  },
  "/trust-center/ai-disclosure": {
    // The five web trust-centre routes converge onto ONE native screen with a
    // section per article kind. Same canonical source (/v1/trust/articles); a
    // phone has no sidebar to hold five destinations that each show one list.
    routeFile: "(stack)/trust-center.tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/(app)/trust-center/_section-list.tsx"],
    gaps: [
      "version history (/v1/trust/articles/:id/versions) not ported",
      "device acceptance outstanding",
    ],
  },
  "/trust-center/methodology": {
    // The five web trust-centre routes converge onto ONE native screen with a
    // section per article kind. Same canonical source (/v1/trust/articles); a
    // phone has no sidebar to hold five destinations that each show one list.
    routeFile: "(stack)/trust-center.tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/(app)/trust-center/_section-list.tsx"],
    gaps: [
      "version history (/v1/trust/articles/:id/versions) not ported",
      "device acceptance outstanding",
    ],
  },
  "/trust-center/security": {
    // The five web trust-centre routes converge onto ONE native screen with a
    // section per article kind. Same canonical source (/v1/trust/articles); a
    // phone has no sidebar to hold five destinations that each show one list.
    routeFile: "(stack)/trust-center.tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/(app)/trust-center/_section-list.tsx"],
    gaps: [
      "version history (/v1/trust/articles/:id/versions) not ported",
      "device acceptance outstanding",
    ],
  },
  "/trust-center/status": {
    // The five web trust-centre routes converge onto ONE native screen with a
    // section per article kind. Same canonical source (/v1/trust/articles); a
    // phone has no sidebar to hold five destinations that each show one list.
    routeFile: "(stack)/trust-center.tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/(app)/trust-center/_section-list.tsx"],
    gaps: [
      "version history (/v1/trust/articles/:id/versions) not ported",
      "device acceptance outstanding",
    ],
  },
  "/trust-center/subprocessors": {
    // The five web trust-centre routes converge onto ONE native screen with a
    // section per article kind. Same canonical source (/v1/trust/articles); a
    // phone has no sidebar to hold five destinations that each show one list.
    routeFile: "(stack)/trust-center.tsx",
    status: "PARTIAL",
    webSources: ["apps/web/app/(app)/trust-center/_section-list.tsx"],
    gaps: [
      "version history (/v1/trust/articles/:id/versions) not ported",
      "device acceptance outstanding",
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
