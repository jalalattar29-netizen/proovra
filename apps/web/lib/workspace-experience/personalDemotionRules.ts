/**
 * PHASE R1.5B — Personal-mode sidebar demotion rules.
 *
 * The bounded set of route ids that, in PERSONAL experience mode,
 * the sidebar should bucket into `moreAdvancedItems` rather than
 * `primaryItems` / `secondaryItems`. Routes remain:
 *
 *   - reachable via the "More / Advanced" disclosure in the sidebar,
 *   - present in `allToolsItems` (All Tools page),
 *   - present in the Command Palette,
 *   - reachable via direct URL,
 *   - reachable via search.
 *
 * Authorization is NOT affected. The canonical `routeAccessResolver`
 * already returns `canLoad: false` + a "Create organization" CTA for
 * these routes in personal context; R1.5B simply moves them out of
 * primary sidebar prominence so the Personal Space doesn't read like
 * an admin console.
 *
 * Every entry below is an `ORGANIZATION_ONLY` route with
 * `sidebarEligible: true`. Adding non-ORG-only routes to this list
 * would be a real progressive-disclosure decision that belongs to R5.
 */

export const PERSONAL_MODE_DEMOTION_ROUTE_IDS: ReadonlySet<string> = new Set([
  // Review operations — only meaningful inside an organization
  // (queues, escalations, SLA all assume team membership).
  "review.escalations",
  "review.queue",
  "review.sla",

  // Governance & compliance — policy / retention / lifecycle /
  // destruction / analytics / notifications all assume an org with
  // governance posture configured.
  "governance.hub",
  "governance.policy",
  "governance.retention",
  "governance.lifecycle",
  "governance.destruction",
  "governance.analytics",
  "governance.notifications",
]);
