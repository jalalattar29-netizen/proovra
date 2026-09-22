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
 *   NOT_STARTED  no Native destination exists yet
 *   SHELL        a screen exists but is materially thinner than the Web surface
 *                (fewer data sources, fewer actions, or missing states)
 *   PARTIAL      the primary journey works; named gaps remain in `gaps`
 *   PARITY       visual + functional + content + state parity, device-verified
 *
 * `PARITY` may not be set from CI alone — it requires the physical-device
 * acceptance recorded in `docs/native-conversion-ledger.md`.
 *
 * `webSources` names the canonical Web implementation being ported, so a later
 * reviewer can diff the two without rediscovering the mapping.
 */

/** @typedef {"NOT_STARTED"|"SHELL"|"PARTIAL"|"PARITY"} DestinationStatus */

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
    routeFile: null,
    status: "NOT_STARTED",
    webSources: ["apps/web/app/auth/mfa-recovery/verify/page.tsx"],
    gaps: ["MFA recovery verification has no Native destination"],
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
    status: "SHELL",
    webSources: ["apps/web/app/(app)/capture/page.tsx", "apps/web/app/(app)/capture/_lib/*"],
    gaps: [
      "one capture type per session; no mixed-media composer",
      "no templates / intake stages / readiness / suggestions",
      "uploads cannot complete on device (crypto)",
      "Discard leaves a reserved Evidence record",
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
    webSources: ["apps/web/app/(app)/evidence/[id]/page.tsx", "apps/web/app/(app)/evidence/[id]/_tabs/*"],
    gaps: [
      "no download of the original",
      "no comments / annotations / legal notes / relationships / duplicates",
      "no report retrieval or regeneration",
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
    status: "SHELL",
    webSources: ["apps/web/app/(app)/notifications/page.tsx"],
    gaps: ["no notification preferences, schedule, snooze, or delivery history"],
  },
  "/inbox": {
    routeFile: "(tabs)/notifications.tsx",
    status: "SHELL",
    webSources: ["apps/web/app/(app)/inbox/page.tsx"],
    gaps: ["converged onto the notifications surface; severity ordering not ported"],
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
    webSources: ["apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx"],
    gaps: ["no membership or role mutation"],
  },
  "/collaboration-teams/[teamId]/collaboration": {
    routeFile: null,
    status: "NOT_STARTED",
    webSources: ["apps/web/app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx"],
    gaps: ["collaboration hub (threads/discussion) has no Native destination"],
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
    routeFile: null,
    status: "NOT_STARTED",
    webSources: ["apps/web/app/(app)/org-invites/[token]/accept/page.tsx"],
    gaps: ["organization invite acceptance has no Native destination"],
  },
  "/organizations": {
    routeFile: null,
    status: "NOT_STARTED",
    webSources: ["apps/web/app/(app)/organizations/page.tsx"],
    gaps: ["membership-gated org list (explicitly NOT enterprise-gated) has no Native destination"],
  },
  "/organizations/[id]": {
    routeFile: null,
    status: "NOT_STARTED",
    webSources: ["apps/web/app/(app)/organizations/[id]/page.tsx"],
    gaps: ["member-safe org detail has no Native destination"],
  },
  "/people": {
    routeFile: null,
    status: "NOT_STARTED",
    webSources: ["apps/web/app/(app)/teams/[id]/page.tsx"],
    gaps: ["workspace people/members surface has no Native destination"],
  },
  "/teams/[id]": {
    routeFile: null,
    status: "NOT_STARTED",
    webSources: ["apps/web/app/(app)/teams/[id]/page.tsx"],
    gaps: ["same surface as /people"],
  },
  "/workspaces": {
    routeFile: null,
    status: "NOT_STARTED",
    webSources: ["apps/web/app/(app)/workspaces/page.tsx"],
    gaps: ["workspace list has no Native destination"],
  },
  "/operations/batch-analysis": {
    routeFile: null,
    status: "NOT_STARTED",
    webSources: ["apps/web/app/(app)/operations/batch-analysis/page.tsx"],
    gaps: ["classified NATIVE_REQUIRED by dashboard.batch_analysis; disposition needs product review"],
  },
  "/operations/quotas": {
    routeFile: null,
    status: "NOT_STARTED",
    webSources: ["apps/web/app/(app)/operations/quotas/page.tsx"],
    gaps: ["classified NATIVE_REQUIRED by dashboard.quotas; disposition needs product review"],
  },
  "/settings/reviewer-criteria": {
    routeFile: null,
    status: "NOT_STARTED",
    webSources: ["apps/web/app/(app)/settings/reviewer-criteria/page.tsx"],
    gaps: [],
  },
  "/settings/security/saml": {
    routeFile: null,
    status: "NOT_STARTED",
    webSources: ["apps/web/app/(app)/settings/security/saml/page.tsx"],
    gaps: ["inherits account.settings; SSO config is plausibly enterprise — needs product review"],
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
    status: "NOT_STARTED",
    webSources: ["apps/web/app/share/[id]/page.tsx"],
    gaps: ["public share link has no Native destination"],
  },
  "/legal/[slug]": {
    routeFile: null,
    status: "NOT_STARTED",
    webSources: ["apps/web/app/legal/[slug]/page.tsx"],
    gaps: ["public legal reader has no Native destination"],
  },
  "/settings/legal/[slug]": {
    routeFile: null,
    status: "NOT_STARTED",
    webSources: ["apps/web/app/(app)/settings/legal/[slug]/page.tsx"],
    gaps: ["authenticated legal reader has no Native destination"],
  },
  "/privacy": { routeFile: null, status: "NOT_STARTED", webSources: ["apps/web/app/privacy/page.tsx"], gaps: ["redirects to /legal/privacy"] },
  "/terms": { routeFile: null, status: "NOT_STARTED", webSources: ["apps/web/app/terms/page.tsx"], gaps: ["redirects to /legal/terms"] },
  "/subprocessors": { routeFile: null, status: "NOT_STARTED", webSources: ["apps/web/app/subprocessors/page.tsx"], gaps: ["redirects to /legal/subprocessors"] },
  "/data-retention": { routeFile: null, status: "NOT_STARTED", webSources: ["apps/web/app/data-retention/page.tsx"], gaps: ["redirects to /legal/data-retention"] },
  "/abuse-reporting": { routeFile: null, status: "NOT_STARTED", webSources: ["apps/web/app/abuse-reporting/page.tsx"], gaps: ["redirects to /legal/abuse-reporting"] },

  "/support": {
    routeFile: null,
    status: "NOT_STARTED",
    webSources: ["apps/web/app/support/page.tsx"],
    gaps: [
      "the app routes users here from its own error boundary, not-found and Search — native has no equivalent escape hatch",
      "content lives at /legal/support, which the legal reader covers; the SUPPORT ENTRY POINT is what is missing",
    ],
  },
  "/trust": {
    routeFile: null,
    status: "NOT_STARTED",
    webSources: ["apps/web/app/trust/page.tsx"],
    gaps: ["linked from Settings privacy and the legal document shell; public Trust Center content"],
  },
  "/trust-center": { routeFile: null, status: "NOT_STARTED", webSources: ["apps/web/app/(app)/trust-center/page.tsx"], gaps: [] },
  "/trust-center/ai-disclosure": { routeFile: null, status: "NOT_STARTED", webSources: ["apps/web/app/(app)/trust-center/ai-disclosure/page.tsx"], gaps: [] },
  "/trust-center/methodology": { routeFile: null, status: "NOT_STARTED", webSources: ["apps/web/app/(app)/trust-center/methodology/page.tsx"], gaps: [] },
  "/trust-center/security": { routeFile: null, status: "NOT_STARTED", webSources: ["apps/web/app/(app)/trust-center/security/page.tsx"], gaps: [] },
  "/trust-center/status": { routeFile: null, status: "NOT_STARTED", webSources: ["apps/web/app/(app)/trust-center/status/page.tsx"], gaps: [] },
  "/trust-center/subprocessors": { routeFile: null, status: "NOT_STARTED", webSources: ["apps/web/app/(app)/trust-center/subprocessors/page.tsx"], gaps: [] },

  /* --------------------------------------------------- intake / portal flows */
  "/intake/[token]": { routeFile: null, status: "NOT_STARTED", webSources: ["apps/web/app/intake/[token]/page.tsx"], gaps: ["external intake has no Native destination"] },
  "/intake/[token]/capture": { routeFile: null, status: "NOT_STARTED", webSources: ["apps/web/app/intake/[token]/capture/page.tsx"], gaps: ["external intake capture has no Native destination"] },
  "/portal": { routeFile: null, status: "NOT_STARTED", webSources: ["apps/web/app/portal/page.tsx"], gaps: ["external reviewer portal entry has no Native destination"] },
  "/portal/[token]": { routeFile: null, status: "NOT_STARTED", webSources: ["apps/web/app/portal/[token]/page.tsx"], gaps: [] },
  "/portal/[token]/work/[workflowId]": { routeFile: null, status: "NOT_STARTED", webSources: ["apps/web/app/portal/[token]/work/[workflowId]/page.tsx"], gaps: [] },
  "/portal/accept/[grantId]": { routeFile: null, status: "NOT_STARTED", webSources: ["apps/web/app/portal/accept/[grantId]/page.tsx"], gaps: [] },
};

/** Counts by status — used by the ledger report and the coverage guard. */
export function destinationCounts() {
  const counts = { NOT_STARTED: 0, SHELL: 0, PARTIAL: 0, PARITY: 0 };
  for (const d of Object.values(NATIVE_DESTINATIONS)) counts[d.status] += 1;
  return counts;
}
