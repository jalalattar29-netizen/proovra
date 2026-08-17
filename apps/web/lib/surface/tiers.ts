/**
 * Phase IA-surface-tier — centralized product-surface visibility model.
 *
 * The platform serves a wide surface area (capture, governance, reviewer
 * ops, intelligence, organization admin, internal tools …). The current
 * go-to-market target is INDIVIDUALS, INDEPENDENT LAWYERS, SMALL LAW
 * OFFICES, JOURNALISTS, PRIVATE INVESTIGATORS, INSURANCE / CLAIM
 * CONSULTANTS, and SMALL PROFESSIONAL TEAMS. The product must feel
 * simple and focused — NOT like a full enterprise/government investigation
 * suite — at first login.
 *
 * This module is the SINGLE SOURCE OF TRUTH for which surfaces are
 * visible / accessible to which audience.
 *
 *   * Path-prefix based — rules match the URL pathname, independent of
 *     the routeRegistry id, so it covers routes that have not yet been
 *     registered AND routes that are registered with multiple ids.
 *   * Conservative defaults — an unmapped path is treated as CORE
 *     (visible to every authenticated user). This prevents accidental
 *     hiding of a new route that hasn't been classified yet.
 *   * NO backend deletion — the underlying API routes still exist and
 *     are still permission-gated by the API. This module ONLY governs
 *     what the WEB UI shows + what the WEB middleware lets through.
 *
 * Tier semantics:
 *
 *   CORE          — visible to every plan + every role. The simple
 *                   sidebar for a personal-account user.
 *   PROFESSIONAL  — visible on PRO+ plans (paid individual / small
 *                   team). Hidden on FREE/PAYG unless promoted.
 *   ENTERPRISE    — visible only when the workspace is enterprise (or
 *                   the user has an explicit reviewer/governance role).
 *                   Hidden by default for personal + team plans.
 *   INTERNAL      — platform-admin / debug surfaces. Never visible to
 *                   workspace users regardless of plan.
 *
 * Direct-access policy (when a non-eligible user types the URL):
 *
 *   "allow"     — render normally (CORE default).
 *   "redirect"  — server middleware 308s to the configured redirectTo
 *                 (defaults to /home). Used for plan-gated surfaces:
 *                 the user might upgrade, so we don't 404.
 *   "notFound"  — server middleware rewrites to /not-found, returning
 *                 the standard 404 page. Used for INTERNAL surfaces
 *                 and feature-removed legacy paths.
 *   "forbidden" — server middleware rewrites to /403 (or a forbidden
 *                 page). Used when the surface exists for the plan but
 *                 the user lacks the role.
 *
 * This file is read by:
 *   - `apps/web/lib/surface/access.ts`  — `canAccessSurface`,
 *     `getVisibleSurfaces`, `getDirectAccessDecision`
 *   - `apps/web/middleware.ts`          — direct-URL backstop
 *   - `apps/web/lib/navigation/*`       — sidebar / All Tools filter
 *
 * Future expansion: when product packaging adds an ENTERPRISE plan, the
 * tier model upgrades automatically because the SERVER-projected
 * `PlatformContextFlags.isEnterpriseWorkspace` are already wired in.
 */

/** Tier the surface belongs to. Determines who sees it. */
export const SURFACE_TIERS = [
  "CORE",
  "PROFESSIONAL",
  "ENTERPRISE",
  "INTERNAL",
] as const;
export type SurfaceTier = (typeof SURFACE_TIERS)[number];

/** What happens when a non-eligible user types the URL directly. */
export const DIRECT_ACCESS_POLICIES = [
  "allow",
  "redirect",
  "notFound",
  "forbidden",
] as const;
export type DirectAccessPolicy = (typeof DIRECT_ACCESS_POLICIES)[number];

export type SurfaceTierRule = {
  /**
   * Path-prefix matched against `req.nextUrl.pathname`. An entry like
   * `/governance` matches `/governance` AND `/governance/anything`.
   * For more precise matches the pattern can include the full path
   * (e.g. `/investigation/graph`). First-match-wins evaluation.
   */
  pathPrefix: string;
  tier: SurfaceTier;
  /**
   * OpsCenter visibility remediation (2026-07-18) — optional COMMERCIAL
   * ENTITLEMENT override. When set, the surface decision follows the
   * backend-computed `envelope.planFeatures.<key>` boolean (the canonical
   * PLAN_CAPABILITIES projection) wherever the envelope is available;
   * `tier` remains only the fail-closed fallback while the value is
   * unknown (loading / degraded envelope). This keeps the tier table free
   * of plan-literal duplication of the pricing catalog.
   */
  entitlementOverride?: "intakeIncluded";
  directAccessPolicy: DirectAccessPolicy;
  /**
   * For `redirect` policy. Defaults to `/home`. Operators see a friendly
   * landing instead of a hard 404 — they might upgrade.
   */
  redirectTo?: string;
  /**
   * One-liner used by smoke tooling + dashboards. Not user-facing.
   */
  reason: string;
};

/**
 * Ordered rule set — FIRST MATCH WINS. Specific paths come BEFORE the
 * broad prefix that contains them.
 *
 * Pattern matching is greedy on path-segment boundaries:
 *   `/foo` matches `/foo` and `/foo/bar` but NOT `/foobar`.
 */
export const SURFACE_TIER_RULES: ReadonlyArray<SurfaceTierRule> = [
  // ---------------------------------------------------------------------
  // CORE — the simple normal-user surface. Every authenticated user
  // sees these in the sidebar. Direct URL renders normally.
  // ---------------------------------------------------------------------
  { pathPrefix: "/home", tier: "CORE", directAccessPolicy: "allow", reason: "home dashboard" },
  { pathPrefix: "/capture", tier: "CORE", directAccessPolicy: "allow", reason: "evidence capture" },
  { pathPrefix: "/cases", tier: "CORE", directAccessPolicy: "allow", reason: "case workspace" },
  { pathPrefix: "/evidence-requests", tier: "CORE", directAccessPolicy: "allow", reason: "evidence request lifecycle" },
  // Evidence detail + listing + report-latest are CORE.
  { pathPrefix: "/evidence", tier: "CORE", directAccessPolicy: "allow", reason: "evidence vault" },
  { pathPrefix: "/search", tier: "CORE", directAccessPolicy: "allow", reason: "search surface" },
  { pathPrefix: "/reports", tier: "CORE", directAccessPolicy: "allow", reason: "report generation" },
  // Phase IA-surface-tier-pricing — `/teams` is a TEAM-collaboration
  // surface. Per the pricing page it unlocks at PRO/TEAM (PRO = up to 2
  // teams, TEAM = up to 5 teams).
  { pathPrefix: "/teams", tier: "PROFESSIONAL", directAccessPolicy: "redirect", reason: "workspace (PRO/TEAM)" },
  // OpsCenter visibility remediation (2026-07-18) — `/intake-links` is
  // gated by the COMMERCIAL ENTITLEMENT (PLAN_CAPABILITIES.intakeIncluded:
  // PAYG/PRO/TEAM/ENTERPRISE include intake; FREE does not). The rule's
  // `entitlementOverride` makes the backend-computed
  // `envelope.planFeatures.intakeIncluded` the source of truth wherever
  // the envelope is available; the PROFESSIONAL tier remains ONLY as the
  // fail-closed fallback while the envelope is loading/unknown. The
  // previous plan-literal PRO/TEAM tier wrongly excluded PAYG, which the
  // canonical catalog includes.
  { pathPrefix: "/intake-links", tier: "PROFESSIONAL", entitlementOverride: "intakeIncluded", directAccessPolicy: "redirect", reason: "intake links (per intakeIncluded entitlement)" },
  // OpsCenter visibility remediation (2026-07-18) — the Operations
  // Center is an OPERATIONAL surface, not a paid-plan surface. The
  // backend serves /v1/me/inbox to every authenticated account, mandatory
  // evidence-integrity items are delivered to every plan, and the
  // categories INSIDE the surface are governed by the canonical
  // operationalEligibility projection + actual-item override
  // (operationsFilterPolicy). Tier is therefore CORE; the previous
  // plan-literal PROFESSIONAL tier left FREE users receiving operational
  // items with no surface to work them.
  { pathPrefix: "/inbox", tier: "CORE", directAccessPolicy: "allow", reason: "operations center — operational surface; categories governed by operationalEligibility" },
  // CORE alias for the canonical `/trust-center` URL — pinned by the
  // surface-tier wiring test (Phase IA-surface-tier-wiring).
  { pathPrefix: "/trust-center", tier: "CORE", directAccessPolicy: "allow", reason: "trust center" },
  { pathPrefix: "/settings", tier: "CORE", directAccessPolicy: "allow", reason: "unified account settings workspace (/settings — incl. the Security section)" },
  { pathPrefix: "/billing", tier: "CORE", directAccessPolicy: "allow", reason: "billing" },
  // Phase IA-surface-tier-finishing — these surfaces were CORE in the
  // first pass; the GTM brief explicitly excluded them from the
  // normal-user sidebar. They remain reachable for users who NEED them
  // but are PROFESSIONAL/ENTERPRISE-tier so the personal sidebar stays
  // at the 12 items the brief listed:
  //   * `/workspaces`    — workspace switcher belongs to multi-workspace
  //                        users (TEAM+).
  //   * `/notifications` — operators monitor incidents from /inbox; the
  //                        full notifications hub is a PRO surface.
  //   * `/organizations` — visible only to enterprise/TEAM users who
  //                        actually have org memberships to manage.
  //   * `/persona`       — workflow profile picker is a power-user
  //                        affordance — TEAM tier upward.
  // Phase IA-self-serve-simplification — settings-like surfaces.
  // For self-serve plans these belong inside /settings, not as
  // standalone product pages. The bounded redirect targets surface
  // operators inside the canonical Settings location instead of a
  // hard 404.
  { pathPrefix: "/workspaces", tier: "ENTERPRISE", directAccessPolicy: "redirect", redirectTo: "/collaboration-teams", reason: "Phase 2B — workspace switcher is ENTERPRISE; self-serve users are sent to the canonical Teams product (/collaboration-teams), NOT the deleted /teams landing (which would loop)" },
  { pathPrefix: "/notifications", tier: "ENTERPRISE", directAccessPolicy: "redirect", redirectTo: "/settings", reason: "notifications → /settings (self-serve)" },
  // Phase IA-surface-tier-pricing — Organizations are ENTERPRISE_ONLY
  // per the pricing page. Self-serve TEAM users manage collaboration
  // through /teams; the Organizations entity (departments, governance,
  // delegated admin, access reviews) is reserved for the sales-led
  // enterprise plan. Direct URL returns 404 — no upsell, the surface
  // simply does not exist for self-serve plans.
  // PHASE 13 (NEW-063) — the tier stays ENTERPRISE; the DIRECT-ACCESS answer
  // does not.
  //
  // The `notFound` policy above contradicted a later correction the product
  // made in two other places and never propagated here:
  //
  //   * `routeRegistry.ts` (12B correction, above ENTERPRISE_ONLY_ROUTE_IDS):
  //     "the organizations LIST + member-safe DETAIL are MEMBERSHIP-gated, not
  //     enterprise-workspace-gated — a FREE-plan personal user with an ACTIVE
  //     org membership must reach their org list even while their ACTIVE
  //     workspace is personal". `account.organizations` accordingly declares
  //     `requiredCapabilities: []`.
  //   * `lib/navigation/accountMenu.ts` (account-menu refactor 2026-07-21):
  //     "Organization settings" is offered when `activeOrganizations.length > 0
  //     && routeLoads("account.organizations")` — membership, never plan.
  //
  // `isEnterpriseWorkspace` is derived from the ACTIVE WORKSPACE's plan, so an
  // ORG_OWNER whose active space is their Personal Space is out of tier — and
  // `SurfaceGate` 404'd them on the very link the account menu had just shown
  // them. Same shape as NEW-033: a working navigation item that always lands on
  // a dead end.
  //
  // `allow` is the narrowest correction available. The tier is UNCHANGED, so
  // nothing about visibility moves: `canAccessSurface("/organizations")` still
  // answers false for self-serve plans and the surface stays out of nav, the
  // command palette and All Tools, exactly as the pricing intent requires. Only
  // the direct-URL denial is withdrawn, and what replaces it is stronger than a
  // client-side guess: `PageRouteGate` still resolves `account.organizations` /
  // `account.organization-detail`, every ADMIN surface beneath the detail stays
  // in ENTERPRISE_ONLY_ROUTE_IDS, and the org routes themselves refuse a
  // non-member server-side. A user with no membership reaches an empty list.
  { pathPrefix: "/organizations", tier: "ENTERPRISE", directAccessPolicy: "allow", reason: "Organizations entity — membership-gated (12B correction); nav visibility stays ENTERPRISE" },
  { pathPrefix: "/dashboard/batch-analysis", tier: "PROFESSIONAL", directAccessPolicy: "redirect", reason: "batch analysis (PRO upsell)" },
  { pathPrefix: "/dashboard/quotas", tier: "PROFESSIONAL", directAccessPolicy: "redirect", reason: "quota dashboard (PRO upsell)" },

  // ---------------------------------------------------------------------
  // PROFESSIONAL — surfaces appropriate for PRO / TEAM plans.
  // Hidden on FREE/PAYG by default; direct URL → redirect /home.
  //
  // Phase IA-self-serve-simplification — the formerly-PROFESSIONAL
  // surfaces below (exchange / integrations / workflows /
  // communications / collaboration / evidence-lifecycle / packaging)
  // moved to ENTERPRISE. They are not packaged for self-serve plans
  // and confuse the simplified product. See the ENTERPRISE section
  // below for their rules.
  // ---------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // ENTERPRISE — only visible / accessible to enterprise workspaces OR
  // users with the explicit role. Direct URL → 404 (the surface does
  // not exist for this user, full stop).
  // ---------------------------------------------------------------------

  // Phase IA-self-serve-simplification — advanced professional surfaces.
  // These were tier=PROFESSIONAL in an earlier pass but the GTM brief
  // pulled them out of self-serve packaging. They are now ENTERPRISE
  // until each one is product-ready as a polished self-serve surface.
  // Per-rule redirect targets land the user on the closest self-serve
  // equivalent so they're never lost.
  { pathPrefix: "/collaboration", tier: "ENTERPRISE", directAccessPolicy: "redirect", redirectTo: "/inbox", reason: "collaboration legacy → /inbox" },
  { pathPrefix: "/evidence-lifecycle", tier: "ENTERPRISE", directAccessPolicy: "redirect", redirectTo: "/evidence", reason: "evidence lifecycle → /evidence (self-serve)" },
  { pathPrefix: "/exchange", tier: "ENTERPRISE", directAccessPolicy: "redirect", redirectTo: "/reports", reason: "exchange → /reports (self-serve uses Reports for share/export)" },
  { pathPrefix: "/integrations", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "API keys + webhooks (ENTERPRISE until packaged)" },
  { pathPrefix: "/workflows", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "workflow templates (ENTERPRISE until simplified templates ship)" },
  { pathPrefix: "/communications", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "communications hub (ENTERPRISE/ops)" },
  { pathPrefix: "/packaging", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "packaging entitlement admin (INTERNAL/ENTERPRISE)" },

  // Reviewer Operations
  { pathPrefix: "/review-operations", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "reviewer operations" },
  { pathPrefix: "/reviewer-ops", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "reviewer ops console" },
  { pathPrefix: "/reviewer-workspace", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "reviewer workspace" },
  { pathPrefix: "/review", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "review surfaces" },
  { pathPrefix: "/redaction", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "redaction platform" },

  // Governance / Compliance
  { pathPrefix: "/governance-platform", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "governance platform (org admin)" },
  { pathPrefix: "/governance", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "governance lifecycle + policy" },
  // Phase 1 (leakage fix) — Audit / Compliance transparency center. This
  // route (id `workspace.audit_transparency`) was previously unclassified
  // and fell through to the CORE default, so a FREE/PRO user could reach
  // the org-activity audit surface via Command Palette / All Tools /
  // direct URL. Audit is an ENTERPRISE compliance surface (sibling of
  // /governance, /executive, /budget-center) and must never appear for
  // self-serve plans.
  { pathPrefix: "/audit-transparency", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "audit / compliance transparency center (ENTERPRISE)" },

  // Enterprise Identity / Admin
  // Phase IA-surface-tier-pricing — explicit admin/organizations entry
  // BEFORE the generic /admin prefix so the bound is unambiguous
  // (first-match-wins). All three variants 404 for non-enterprise.
  { pathPrefix: "/admin/organizations", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "admin organizations console (ENTERPRISE_ONLY)" },
  { pathPrefix: "/admin/identity", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "admin identity hub" },
  { pathPrefix: "/admin", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "admin surface (org admin / platform admin entry)" },
  { pathPrefix: "/organization-admin", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "organization admin (ENTERPRISE_ONLY)" },
  { pathPrefix: "/security-center", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "security center (admin form). Personal security lives in /settings#security (CORE)" },
  { pathPrefix: "/identity-security", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "identity security ops" },

  // Enterprise Analytics / Ops
  { pathPrefix: "/executive", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "executive dashboard" },
  { pathPrefix: "/intelligence-quality", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "intelligence quality" },
  { pathPrefix: "/intelligence", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "intelligence enterprise layer" },
  { pathPrefix: "/budget-center", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "intelligence budget center" },

  // Investigation Power Tools
  { pathPrefix: "/investigation", tier: "ENTERPRISE", directAccessPolicy: "notFound", reason: "investigation graph/timeline/relationships" },

  // ---------------------------------------------------------------------
  // INTERNAL — platform-admin / debug. Never visible to workspace
  // users regardless of plan. Direct URL → 404.
  // ---------------------------------------------------------------------
  { pathPrefix: "/tools", tier: "INTERNAL", directAccessPolicy: "notFound", reason: "All Tools — internal/debug catalog" },
  { pathPrefix: "/ops", tier: "INTERNAL", directAccessPolicy: "notFound", reason: "platform ops console" },
  { pathPrefix: "/operations", tier: "INTERNAL", directAccessPolicy: "notFound", reason: "platform operations" },
  { pathPrefix: "/platform", tier: "INTERNAL", directAccessPolicy: "notFound", reason: "platform internal" },
];

// =============================================================================
// Plan / role membership in each tier
// =============================================================================

/**
 * Which tiers does a given plan unlock? Used by `canAccessSurface`.
 *
 *   FREE       — CORE only (the simple onboarding experience).
 *   PAYG       — CORE only.
 *   PRO        — CORE + PROFESSIONAL.
 *   TEAM       — CORE + PROFESSIONAL + (some) ENTERPRISE flags via the
 *                explicit role gate; the plan alone does NOT unlock
 *                ENTERPRISE — the workspace must be enterprise OR the
 *                user must hold the per-surface role.
 *
 * INTERNAL is NEVER unlocked by plan — only by `isPlatformAdmin`.
 */
// PHASE 12B Track 1A — tiersAllowedByPlan (the client raw-plan tier authority)
// was DELETED. PROFESSIONAL visibility is the SERVER-projected
// planFeatures.professionalSurfacesIncluded (commercial-catalog-derived);
// ENTERPRISE is the server isEnterpriseWorkspace flag; INTERNAL is
// isPlatformAdmin. The frontend never derives a tier from a plan name.

// PHASE 12 POINT 4 STEP 1 — `rolesUnlockingEnterprise` was DELETED.
//
// It was the last role-shaped tier authority in the frontend. After the
// Phase IA-surface-tier-correction narrowing it ignored its `role`
// argument entirely and returned `isPlatformAdmin`, so it had no
// production caller: `lib/surface/access.ts` referenced it only with a
// `void` statement to keep the import lint-clean. The ENTERPRISE branch
// reads the SERVER-projected `isPlatformAdmin` / `isEnterpriseWorkspace`
// flags directly and is the single decision point.
//
// The invariant it used to encode ("no workspace role unlocks ENTERPRISE
// on its own") is now proven behaviourally against `canAccessSurface` /
// `getDirectAccessDecision` for every role in `WORKSPACE_ROLES`, in
// services/api/test/phase-ia-surface-tier.test.ts Section K.

// =============================================================================
// Path lookup
// =============================================================================

/**
 * Match a pathname against the rule table. Returns the first matching
 * rule. Path-segment boundary aware: `/foo` matches `/foo` and `/foo/x`
 * but NOT `/foobar`. Unmatched paths fall through to the CORE default.
 */
export function findSurfaceTierRule(
  pathname: string,
): SurfaceTierRule | null {
  // Normalize trailing slash so `/capture/` matches the `/capture`
  // pattern.
  const p = pathname.endsWith("/") && pathname.length > 1
    ? pathname.slice(0, -1)
    : pathname;
  for (const rule of SURFACE_TIER_RULES) {
    if (p === rule.pathPrefix) return rule;
    if (p.startsWith(rule.pathPrefix + "/")) return rule;
  }
  return null;
}

/** Convenience: tier for a path, defaulting to CORE on no match. */
export function getSurfaceTier(pathname: string): SurfaceTier {
  return findSurfaceTierRule(pathname)?.tier ?? "CORE";
}

/**
 * Convenience: direct-access policy for a path, defaulting to "allow"
 * on no match.
 */
export function getDirectAccessPolicy(pathname: string): DirectAccessPolicy {
  return findSurfaceTierRule(pathname)?.directAccessPolicy ?? "allow";
}
