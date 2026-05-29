/**
 * Phase 32.8 Foundation — Canonical PlatformContext source-contract tests.
 *
 * Parts:
 *   1  Types module — bounded vocabularies and envelope shape
 *   2  Capability registry — purity + completeness + role/scope rules
 *   3  Navigation registry — capability gates only, no role-lists
 *   4  Platform-context builder — pure read + per-section degradation
 *   5  Route — GET only, no audit emission, no mutations
 *   6  Server registration — route is wired
 *   7  Personal vs team vs PRO clarity (no MEMBER fallback)
 *   8  Authority versioning constants present
 *   9  No-regression invariants
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_KEYS,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
  WORKSPACE_PLANS,
  WORKSPACE_ROLES,
  WORKSPACE_SCOPES,
} from "../src/services/platform-context/types.js";
import {
  resolveCapabilities,
  resolvePersona,
} from "../src/services/platform-context/capability-registry.js";
import {
  NAVIGATION_REGISTRY,
  filterNavigationRegistry,
} from "../src/services/platform-context/navigation-registry.js";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

/**
 * Strip JS/TS comments so source-contract negative-matches don't
 * trip on documentation that mentions a forbidden token. This is
 * deliberately not a perfect comment-stripper — it only handles
 * standard block / line comments which is enough for our shell
 * components.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const TYPES = readApi("src/services/platform-context/types.ts");
const CAP = readApi("src/services/platform-context/capability-registry.ts");
const NAV = readApi("src/services/platform-context/navigation-registry.ts");
const SVC = readApi("src/services/platform-context/platform-context.service.ts");
const ROUTE = readApi("src/routes/platform-context.routes.ts");
const SERVER = readApi("src/server.ts");

const WEB_TYPES = readWeb("lib/platform-context/types.ts");
const WEB_PROVIDER = readWeb("lib/platform-context/PlatformContextProvider.tsx");
const WEB_INDEX = readWeb("lib/platform-context/index.ts");
const WEB_DEGRADED = readWeb("lib/platform-context/CapabilityDegradedPanel.tsx");
const WEB_TOPBAR = readWeb("components/app-shell-v2/AppTopbarV2.tsx");
const WEB_SIDEBAR = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
const WEB_SHELL = readWeb("components/app-shell-v2/AppShellV2.tsx");
const WEB_LAYOUT = readWeb("app/(app)/layout.tsx");
// Phase 32.8 Foundation cleanup — legacy useActiveWorkspaceId.ts
// was deleted. The canonical replacement is useTeamWorkspaceGate.
const WEB_LEGACY_HOOK = readWeb("lib/platform-context/useTeamWorkspaceGate.ts");
// Phase Final-Closure-Remediation — the legacy `/teams` page file
// was deleted (it duplicated `/workspaces/page.tsx`). The canonical
// `admin.teams` route resolves to `/workspaces`, and the legacy
// `/teams` URL now redirects there via `next.config.js`. The
// per-team detail page `/teams/[id]` is untouched (it is the active
// admin detail surface).
const WEB_WORKSPACES_PAGE = readWeb("app/(app)/workspaces/page.tsx");
const WEB_NEXT_CONFIG = readWeb("next.config.js");
const WEB_TEAMS_DETAIL = readWeb("app/(app)/teams/[id]/page.tsx");
const API_TEAMS_ROUTES = readApi("src/routes/teams.routes.ts");

// =============================================================================
// PART 1 — Types
// =============================================================================

describe("Phase 32.8 Foundation — types module", () => {
  it("declares the bounded WORKSPACE_ROLES vocabulary matching Prisma TeamRole", () => {
    expect(WORKSPACE_ROLES).toEqual(["OWNER", "ADMIN", "MEMBER", "VIEWER"]);
  });

  it("declares the bounded WORKSPACE_SCOPES vocabulary", () => {
    expect(WORKSPACE_SCOPES).toEqual(["PERSONAL", "TEAM"]);
  });

  it("declares the bounded WORKSPACE_PLANS vocabulary matching Prisma PlanType", () => {
    expect(WORKSPACE_PLANS).toEqual(["FREE", "PAYG", "PRO", "TEAM"]);
  });

  it("exports authority/capability/navigation schema versions as numeric constants", () => {
    expect(typeof AUTHORITY_SCHEMA_VERSION).toBe("number");
    expect(typeof CAPABILITY_SCHEMA_VERSION).toBe("number");
    expect(typeof NAVIGATION_SCHEMA_VERSION).toBe("number");
  });

  it("envelope type exposes diagnostics with per-section status", () => {
    expect(TYPES).toMatch(/diagnostics:\s*PlatformContextDiagnostics/);
    expect(TYPES).toMatch(/user:\s*SectionStatus/);
    expect(TYPES).toMatch(/workspace:\s*SectionStatus/);
    expect(TYPES).toMatch(/capabilities:\s*SectionStatus/);
    expect(TYPES).toMatch(/navigation:\s*SectionStatus/);
    expect(TYPES).toMatch(/availableWorkspaces:\s*SectionStatus/);
  });

  it("envelope declares the required canonical sections", () => {
    for (const field of [
      "user:",
      "platform:",
      "workspace:",
      "flags:",
      "persona:",
      "capabilities:",
      "navigation:",
      "availableWorkspaces:",
      "diagnostics:",
    ]) {
      expect(TYPES).toContain(field);
    }
  });
});

// =============================================================================
// PART 2 — Capability registry
// =============================================================================

describe("Phase 32.8 Foundation — capability registry", () => {
  it("CAPABILITY_KEYS contains the required platform vocabulary", () => {
    for (const key of [
      "DASHBOARD_VIEW",
      "EVIDENCE_VIEW",
      "EVIDENCE_CAPTURE",
      "EVIDENCE_MANAGE",
      "CASES_VIEW",
      "CASES_MANAGE",
      "REPORTS_VIEW",
      "REPORTS_GENERATE",
      "SEARCH_VIEW",
      "REVIEWER_OPS_VIEW",
      "REVIEWER_OPS_ACT",
      "SLA_VIEW",
      "ESCALATIONS_VIEW",
      "GOVERNANCE_VIEW",
      "GOVERNANCE_ACT",
      "LIFECYCLE_VIEW",
      "OPS_CENTER_VIEW",
      "OBSERVABILITY_VIEW",
      "RUNBOOKS_VIEW",
      "SECURITY_CENTER_VIEW",
      "TEAM_VIEW",
      "TEAM_MANAGE",
      "BILLING_VIEW",
      "BILLING_MANAGE",
      "INTEGRATIONS_MANAGE",
      "INTAKE_LINKS_MANAGE",
      "SETTINGS_VIEW",
      "SETTINGS_MANAGE",
      "PLATFORM_ADMIN",
      "BULK_ACTIONS",
    ]) {
      expect(CAPABILITY_KEYS).toContain(key);
    }
  });

  it("resolveCapabilities is pure — same input yields the same output", () => {
    const a = resolveCapabilities({
      scope: "TEAM",
      role: "ADMIN",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    const b = resolveCapabilities({
      scope: "TEAM",
      role: "ADMIN",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    expect(a).toEqual(b);
  });

  it("resolveCapabilities returns a complete map — every key present", () => {
    const caps = resolveCapabilities({
      scope: "TEAM",
      role: "OWNER",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    for (const key of CAPABILITY_KEYS) {
      expect(caps).toHaveProperty(key);
      expect(typeof caps[key]).toBe("boolean");
    }
  });

  it("PERSONAL workspace grants OWNER-equivalent self-management", () => {
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "PRO",
      isPlatformAdmin: false,
    });
    expect(caps.EVIDENCE_MANAGE).toBe(true);
    expect(caps.CASES_MANAGE).toBe(true);
    expect(caps.REPORTS_GENERATE).toBe(true);
    expect(caps.SETTINGS_MANAGE).toBe(true);
  });

  it("PERSONAL workspace does NOT grant team-only operator capabilities", () => {
    // Phase ROUTE-FIX — TEAM_VIEW and BILLING_VIEW were promoted to
    // ACCOUNT-tier capabilities (personal users can reach a
    // create-team entry + their personal billing). The truly
    // team-only operator capabilities (REVIEWER_OPS, GOVERNANCE,
    // TEAM_MANAGE, BULK_ACTIONS) remain false.
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "PRO",
      isPlatformAdmin: false,
    });
    expect(caps.REVIEWER_OPS_VIEW).toBe(false);
    expect(caps.REVIEWER_OPS_ACT).toBe(false);
    expect(caps.GOVERNANCE_VIEW).toBe(false);
    expect(caps.GOVERNANCE_ACT).toBe(false);
    expect(caps.TEAM_MANAGE).toBe(false);
    expect(caps.BULK_ACTIONS).toBe(false);
  });

  it("TEAM workspace OWNER receives the full management surface", () => {
    const caps = resolveCapabilities({
      scope: "TEAM",
      role: "OWNER",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    expect(caps.TEAM_VIEW).toBe(true);
    expect(caps.TEAM_MANAGE).toBe(true);
    expect(caps.BILLING_MANAGE).toBe(true);
    expect(caps.GOVERNANCE_VIEW).toBe(true);
    expect(caps.GOVERNANCE_ACT).toBe(true);
    expect(caps.BULK_ACTIONS).toBe(true);
  });

  it("TEAM workspace VIEWER receives reads, never writes", () => {
    const caps = resolveCapabilities({
      scope: "TEAM",
      role: "VIEWER",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    expect(caps.TEAM_VIEW).toBe(true);
    expect(caps.EVIDENCE_VIEW).toBe(true);
    expect(caps.EVIDENCE_MANAGE).toBe(false);
    expect(caps.CASES_MANAGE).toBe(false);
    expect(caps.REPORTS_GENERATE).toBe(false);
    expect(caps.TEAM_MANAGE).toBe(false);
    expect(caps.REVIEWER_OPS_ACT).toBe(false);
    expect(caps.GOVERNANCE_ACT).toBe(false);
  });

  it("Platform admin elevation grants platform-tier caps without weakening role gates", () => {
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "FREE",
      isPlatformAdmin: true,
    });
    expect(caps.PLATFORM_ADMIN).toBe(true);
    expect(caps.OBSERVABILITY_VIEW).toBe(true);
    expect(caps.RUNBOOKS_VIEW).toBe(true);
    expect(caps.SECURITY_CENTER_VIEW).toBe(true);
    // Platform admin alone does NOT grant TEAM_MANAGE on a personal workspace.
    expect(caps.TEAM_MANAGE).toBe(false);
  });

  it("PRO plan on a personal workspace does NOT grant team-operator capabilities", () => {
    // Phase ROUTE-FIX — TEAM_VIEW was promoted to an account-tier
    // capability (personal users see a Teams create-entry). The
    // truly team-operator capabilities (Reviewer Ops, Governance
    // Act, Team Manage) remain false.
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "PRO",
      isPlatformAdmin: false,
    });
    expect(caps.REVIEWER_OPS_VIEW).toBe(false);
    expect(caps.TEAM_MANAGE).toBe(false);
    expect(caps.GOVERNANCE_VIEW).toBe(false);
  });

  it("resolvePersona returns INDIVIDUAL for personal workspaces", () => {
    expect(resolvePersona({ scope: "PERSONAL", role: "OWNER" })).toBe("INDIVIDUAL");
  });

  it("resolvePersona returns role-shaped persona for team workspaces", () => {
    expect(resolvePersona({ scope: "TEAM", role: "OWNER" })).toBe(
      "WORKSPACE_OWNER",
    );
    expect(resolvePersona({ scope: "TEAM", role: "ADMIN" })).toBe("TEAM_ADMIN");
    expect(resolvePersona({ scope: "TEAM", role: "MEMBER" })).toBe(
      "TEAM_MEMBER",
    );
    expect(resolvePersona({ scope: "TEAM", role: "VIEWER" })).toBe(
      "TEAM_VIEWER",
    );
  });
});

// =============================================================================
// PART 3 — Navigation registry
// =============================================================================

describe("Phase 32.8 Foundation — navigation registry", () => {
  it("NAVIGATION_REGISTRY declares the canonical groups in stable order (sidebar 4 + account)", () => {
    // Phase ROUTE-FIX — added a 5th ACCOUNT group surfaced only via
    // the account-menu projection, not the sidebar.
    expect(NAVIGATION_REGISTRY.map((g) => g.id)).toEqual([
      "workspace",
      "review_governance",
      "platform_health",
      "administration",
      "account",
    ]);
  });

  it("every nav item uses capability-keyed visibility — NO role lists", () => {
    expect(NAV).not.toMatch(/roles:\s*\[/);
    expect(NAV).not.toMatch(/requiresPlatformAdmin:/);
    for (const group of NAVIGATION_REGISTRY) {
      for (const item of group.items) {
        // requiresCapability is the only gate.
        expect(item).toHaveProperty("requiresCapability");
      }
    }
  });

  it("Teams nav entry is gated on TEAM_VIEW only", () => {
    const adminGroup = NAVIGATION_REGISTRY.find((g) => g.id === "administration");
    const teams = adminGroup?.items.find((i) => i.id === "admin.teams");
    expect(teams).toBeTruthy();
    expect(teams!.requiresCapability).toBe("TEAM_VIEW");
    expect(teams!.href).toBe("/teams");
  });

  it("Teams nav visible to every team member AND to personal users (as create-team entry)", () => {
    // Phase ROUTE-FIX — Teams is now an ACCOUNT-tier entry point.
    // Personal users see it in the sidebar as a "create your first
    // team workspace" CTA. Team management (TEAM_MANAGE) remains
    // OWNER/ADMIN scoped inside the /teams page.
    const teamMemberNav = filterNavigationRegistry(
      resolveCapabilities({
        scope: "TEAM",
        role: "MEMBER",
        plan: "TEAM",
        isPlatformAdmin: false,
      }),
    );
    const adminGroup = teamMemberNav.find((g) => g.id === "administration");
    expect(adminGroup?.items.some((i) => i.id === "admin.teams")).toBe(true);

    const personalNav = filterNavigationRegistry(
      resolveCapabilities({
        scope: "PERSONAL",
        role: "OWNER",
        plan: "PRO",
        isPlatformAdmin: false,
      }),
    );
    const personalAdminGroup = personalNav.find(
      (g) => g.id === "administration",
    );
    expect(
      personalAdminGroup?.items.some((i) => i.id === "admin.teams") ?? false,
    ).toBe(true);
  });

  it("filterNavigationRegistry hides empty groups", () => {
    const minimalCaps = resolveCapabilities({
      scope: null,
      role: null,
      plan: null,
      isPlatformAdmin: false,
    });
    const visible = filterNavigationRegistry(minimalCaps);
    // No active workspace ⇒ no workspace/review/platform groups; only
    // the administration → Settings entry survives because
    // SETTINGS_VIEW is granted to every authenticated user.
    expect(visible.find((g) => g.id === "workspace")).toBeUndefined();
    expect(visible.find((g) => g.id === "review_governance")).toBeUndefined();
    const admin = visible.find((g) => g.id === "administration");
    expect(admin?.items.some((i) => i.id === "admin.settings")).toBe(true);
  });

  it("Reviewer Ops nav: review.queue hidden in personal workspaces, visible in team workspaces", () => {
    // Phase 2.1 promoted EVIDENCE_VIEW-gated surfaces (Intelligence,
    // Workflows, Investigation) inside the review_governance group
    // and granted EVIDENCE_VIEW universally. The GROUP therefore
    // still surfaces in PERSONAL mode — but the REVIEWER_OPS_VIEW
    // capability (which gates the actual review queue) is NOT
    // granted to PERSONAL operators, so `review.queue` is hidden in
    // personal and visible only in team workspaces.
    const personalNav = filterNavigationRegistry(
      resolveCapabilities({
        scope: "PERSONAL",
        role: "OWNER",
        plan: "PRO",
        isPlatformAdmin: false,
      }),
    );
    const personalReview = personalNav.find(
      (g) => g.id === "review_governance",
    );
    expect(
      personalReview?.items.some((i) => i.id === "review.queue") ?? false,
    ).toBe(false);

    const teamNav = filterNavigationRegistry(
      resolveCapabilities({
        scope: "TEAM",
        role: "VIEWER",
        plan: "TEAM",
        isPlatformAdmin: false,
      }),
    );
    const review = teamNav.find((g) => g.id === "review_governance");
    expect(review?.items.some((i) => i.id === "review.queue")).toBe(true);
  });
});

// =============================================================================
// PART 4 — Platform-context builder source contract
// =============================================================================

describe("Phase 32.8 Foundation — platform-context builder", () => {
  it("buildPlatformContext is exported and async", () => {
    expect(SVC).toMatch(/export async function buildPlatformContext/);
  });

  it("builder is side-effect free — no audit, no signed URLs, no enqueue", () => {
    expect(SVC).not.toMatch(/appendPlatformAuditLog\(/);
    expect(SVC).not.toMatch(/getSignedUrl\(/);
    expect(SVC).not.toMatch(/enqueue[A-Z]\w*\(/);
    expect(SVC).not.toMatch(/generateReport\(/);
    expect(SVC).not.toMatch(/generatePackage\(/);
    expect(SVC).not.toMatch(/writeAnalyticsEvent\(/);
  });

  it("builder has per-section try/catch (degraded resilience)", () => {
    // catch{} blocks for user, workspace, capabilities, navigation,
    // and availableWorkspaces sections. Matches both `} catch {` and
    // `.catch(...)` styles.
    const catchCount = (SVC.match(/(?:^|[^a-zA-Z_])catch\s*[\(\{]/g) ?? [])
      .length;
    expect(catchCount).toBeGreaterThanOrEqual(5);
    expect(SVC).toMatch(/sectionStatus:/);
  });

  it("builder NEVER falls back to the literal 'MEMBER' string for role", () => {
    // The MEMBER value is a legitimate Prisma TeamRole, but the
    // canonical builder must NEVER use it as a UI fallback when the
    // real role cannot be resolved — it returns null in that case.
    // Guard against accidental reintroduction of a hardcoded "MEMBER"
    // role fallback.
    expect(SVC).not.toMatch(/role:\s*['"]MEMBER['"]/);
  });

  it("builder synthesizes OWNER membership for personal workspaces", () => {
    // PERSONAL block sets membership.role: "OWNER" (with literal in
    // the synthesized object, only inside the personal branch).
    expect(SVC).toMatch(/role:\s*['"]OWNER['"]/);
    expect(SVC).toMatch(/isOwner:\s*true/);
  });

  it("builder includes authority schema versions in envelope", () => {
    expect(SVC).toMatch(/AUTHORITY_SCHEMA_VERSION/);
    expect(SVC).toMatch(/CAPABILITY_SCHEMA_VERSION/);
    expect(SVC).toMatch(/NAVIGATION_SCHEMA_VERSION/);
  });
});

// =============================================================================
// PART 5 — Route source contract
// =============================================================================

describe("Phase 32.8 Foundation — route", () => {
  it("registers GET /v1/platform/context and POST /v1/platform/context/switch-workspace only", () => {
    expect(ROUTE).toMatch(/app\.get\(\s*['"]\/v1\/platform\/context['"]/);
    expect(ROUTE).toMatch(
      /app\.post\(\s*['"]\/v1\/platform\/context\/switch-workspace['"]/,
    );
    expect(ROUTE).not.toMatch(/app\.put\(/);
    expect(ROUTE).not.toMatch(/app\.patch\(/);
    expect(ROUTE).not.toMatch(/app\.delete\(/);
  });

  it("route requires authentication", () => {
    expect(ROUTE).toMatch(/requireAuth/);
  });

  it("route does NOT emit audit logs or analytics events", () => {
    expect(ROUTE).not.toMatch(/appendPlatformAuditLog/);
    expect(ROUTE).not.toMatch(/writeAnalyticsEvent/);
  });

  it("switch-workspace requires ACTIVE team membership", () => {
    expect(ROUTE).toMatch(/workspace_membership_required/);
    expect(ROUTE).toMatch(/code\(403\)/);
    expect(ROUTE).toMatch(/membership\.status\s*!==\s*['"]ACTIVE['"]/);
  });

  it("route returns 404 with user_not_found code on missing user", () => {
    expect(ROUTE).toMatch(/user_not_found/);
    expect(ROUTE).toMatch(/code\(404\)/);
  });
});

// =============================================================================
// PART 6 — Server wiring
// =============================================================================

describe("Phase 32.8 Foundation — server registration", () => {
  it("server.ts imports platformContextRoutes", () => {
    expect(SERVER).toMatch(
      /import\s*\{\s*platformContextRoutes\s*\}\s*from\s*['"]\.\/routes\/platform-context\.routes\.js['"]/,
    );
  });

  it("server.ts registers platformContextRoutes", () => {
    expect(SERVER).toMatch(/app\.register\(platformContextRoutes\)/);
  });
});

// =============================================================================
// PART 7 — Personal / Team / PRO clarity
// =============================================================================

describe("Phase 32.8 Foundation — personal vs team vs PRO clarity", () => {
  it("PERSONAL workspace OWNER on PRO plan resolves OWNER, not MEMBER", () => {
    // The builder's PERSONAL branch synthesizes OWNER regardless of
    // plan. We can't run the builder here (no DB), but the source
    // must not contain branching that maps PRO → MEMBER.
    expect(SVC).not.toMatch(/['"]MEMBER['"][^,;\n]*plan/);
    expect(SVC).not.toMatch(/plan[^,;\n]*['"]MEMBER['"]/);
  });

  it("flags carry isProAccount, isPersonalWorkspace, isTeamWorkspace, isEnterpriseWorkspace", () => {
    expect(SVC).toMatch(/isProAccount/);
    expect(SVC).toMatch(/isPersonalWorkspace/);
    expect(SVC).toMatch(/isTeamWorkspace/);
    expect(SVC).toMatch(/isEnterpriseWorkspace/);
  });

  it("plan and scope are independent fields in the envelope", () => {
    expect(TYPES).toMatch(/scope:\s*WorkspaceScope/);
    expect(TYPES).toMatch(/plan:\s*WorkspacePlan/);
  });
});

// =============================================================================
// PART 8 — Authority versioning
// =============================================================================

describe("Phase 32.8 Foundation — authority versioning", () => {
  it("envelope carries all three schema-version fields", () => {
    expect(TYPES).toMatch(/authoritySchemaVersion:/);
    expect(TYPES).toMatch(/capabilitySchemaVersion:/);
    expect(TYPES).toMatch(/navigationSchemaVersion:/);
  });

  it("version constants are exported from types module", () => {
    expect(TYPES).toMatch(/export const AUTHORITY_SCHEMA_VERSION/);
    expect(TYPES).toMatch(/export const CAPABILITY_SCHEMA_VERSION/);
    expect(TYPES).toMatch(/export const NAVIGATION_SCHEMA_VERSION/);
  });

  it("diagnostics includes resolvedAt + requestId", () => {
    expect(TYPES).toMatch(/resolvedAt:\s*string/);
    expect(TYPES).toMatch(/requestId:\s*string/);
  });
});

// =============================================================================
// PART 9 — Frontend canonical layer (F-2)
// =============================================================================

describe("Phase 32.8 Foundation — frontend canonical layer (F-2)", () => {
  it("frontend types mirror the backend bounded vocabularies", () => {
    expect(WEB_TYPES).toMatch(/WORKSPACE_ROLES\s*=\s*\[/);
    expect(WEB_TYPES).toMatch(/['"]OWNER['"]/);
    expect(WEB_TYPES).toMatch(/['"]ADMIN['"]/);
    expect(WEB_TYPES).toMatch(/['"]MEMBER['"]/);
    expect(WEB_TYPES).toMatch(/['"]VIEWER['"]/);
    expect(WEB_TYPES).toMatch(/WORKSPACE_SCOPES\s*=\s*\[/);
    expect(WEB_TYPES).toMatch(/['"]PERSONAL['"]/);
    expect(WEB_TYPES).toMatch(/['"]TEAM['"]/);
    expect(WEB_TYPES).toMatch(/WORKSPACE_PLANS\s*=\s*\[/);
    expect(WEB_TYPES).toMatch(/['"]FREE['"]/);
    expect(WEB_TYPES).toMatch(/['"]PRO['"]/);
    expect(WEB_TYPES).toMatch(/CAPABILITY_KEYS/);
  });

  it("frontend types declare the workspace switching state machine states", () => {
    for (const s of ["IDLE", "LOADING_CONTEXT", "READY", "SWITCHING", "FAILED"]) {
      expect(WEB_TYPES).toMatch(new RegExp(`['"]${s}['"]`));
    }
  });

  it("provider implements the workspace switching state machine", () => {
    expect(WEB_PROVIDER).toMatch(/state:\s*PlatformContextState/);
    expect(WEB_PROVIDER).toMatch(/switchWorkspace/);
    expect(WEB_PROVIDER).toMatch(/refresh/);
    expect(WEB_PROVIDER).toMatch(/SWITCHING/);
    expect(WEB_PROVIDER).toMatch(/LOADING_CONTEXT/);
    expect(WEB_PROVIDER).toMatch(/FAILED/);
    expect(WEB_PROVIDER).toMatch(/READY/);
  });

  it("provider discards stale schema-version envelopes", () => {
    expect(WEB_PROVIDER).toMatch(/versionsAreCompatible/);
    expect(WEB_PROVIDER).toMatch(/AUTHORITY_SCHEMA_VERSION/);
    expect(WEB_PROVIDER).toMatch(/CAPABILITY_SCHEMA_VERSION/);
    expect(WEB_PROVIDER).toMatch(/NAVIGATION_SCHEMA_VERSION/);
  });

  it("provider uses sequence numbers to prevent out-of-order envelope writes", () => {
    expect(WEB_PROVIDER).toMatch(/fetchSequenceRef/);
    expect(WEB_PROVIDER).toMatch(/seq\s*!==\s*fetchSequenceRef\.current/);
  });

  it("provider exposes can(capability) lookup that fails closed", () => {
    expect(WEB_PROVIDER).toMatch(/can:\s*\(capability:\s*CapabilityKey\)\s*=>/);
    expect(WEB_PROVIDER).toMatch(/readCapability/);
    // The fail-closed branch returns false at the bottom of
    // readCapability. Source assertion that the function returns
    // boolean false unless explicitly true.
    expect(WEB_PROVIDER).toMatch(/return\s+false/);
  });

  it("provider hits /v1/platform/context and /v1/platform/context/switch-workspace only", () => {
    expect(WEB_PROVIDER).toMatch(
      /apiFetch\(\s*['"]\/v1\/platform\/context['"]/,
    );
    expect(WEB_PROVIDER).toMatch(
      /apiFetch\(\s*\n?\s*['"]\/v1\/platform\/context\/switch-workspace['"]/,
    );
    // No call-site to legacy authority endpoints.
    expect(WEB_PROVIDER).not.toMatch(/apiFetch\(\s*['"]\/v1\/users\/me/);
    expect(WEB_PROVIDER).not.toMatch(/apiFetch\(\s*['"]\/v1\/teams/);
  });

  it("provider barrel re-exports usePlatformContext + provider + types", () => {
    expect(WEB_INDEX).toMatch(/PlatformContextProvider/);
    expect(WEB_INDEX).toMatch(/usePlatformContext/);
    expect(WEB_INDEX).toMatch(/CapabilityDegradedPanel/);
    expect(WEB_INDEX).toMatch(/export\s+\*\s+from\s+['"]\.\/types['"]/);
  });

  it("CapabilityDegradedPanel renders structured surface, never raw UUID", () => {
    expect(WEB_DEGRADED).toMatch(/data-capability-degraded-panel/);
    expect(WEB_DEGRADED).toMatch(/requiredCapability/);
    // The component only consumes workspace.name and workspace.scope —
    // never workspace.id in interpolated JSX. The negative check is
    // restricted to actual JSX `{workspace.id}` / `{envelope.workspace.id}`
    // interpolations rather than any mention in comments.
    expect(WEB_DEGRADED).not.toMatch(/\{envelope\?\.workspace\.id/);
    expect(WEB_DEGRADED).not.toMatch(/\{envelope\.workspace\.id/);
    expect(WEB_DEGRADED).toMatch(/workspace\.name/);
    expect(WEB_DEGRADED).toMatch(/workspace\.scope/);
  });
});

// =============================================================================
// PART 10 — Shell rewiring (F-3)
// =============================================================================

describe("Phase 32.8 Foundation — shell rewiring (F-3)", () => {
  it("(app)/layout mounts PlatformContextProvider", () => {
    expect(WEB_LAYOUT).toMatch(/PlatformContextProvider/);
    expect(WEB_LAYOUT).toMatch(/<PlatformContextProvider>/);
  });

  it("(app)/layout no longer derives isPlatformAdmin from user.platformRole", () => {
    expect(WEB_LAYOUT).not.toMatch(/platformRole\s*===/);
    expect(WEB_LAYOUT).not.toMatch(/isPlatformAdmin\s*=\s*user/);
  });

  it("AppShellV2 no longer accepts user or isPlatformAdmin props", () => {
    expect(WEB_SHELL).not.toMatch(/user:\s*AppShellUserV2/);
    expect(WEB_SHELL).not.toMatch(/isPlatformAdmin:\s*boolean/);
  });

  it("AppTopbarV2 consumes platform context only — no apiFetch", () => {
    const code = stripComments(WEB_TOPBAR);
    expect(WEB_TOPBAR).toMatch(/usePlatformContext/);
    expect(code).not.toMatch(/apiFetch\(/);
    expect(code).not.toMatch(/useActiveWorkspaceId\(/);
  });

  it("AppTopbarV2 never substitutes a hardcoded 'Member' fallback", () => {
    // Negative match on the literal "Member" used as a UI fallback.
    const code = stripComments(WEB_TOPBAR);
    expect(code).not.toMatch(/['"]Member['"]/);
  });

  it("AppSidebarV2 renders navigation from the canonical envelope + route registry", () => {
    // Phase 32.8 → 38.9: the sidebar still consumes the canonical
    // platform-context envelope for capabilities + activeSpace +
    // persona, but the navigation tree itself now comes from the
    // canonical ROUTE_REGISTRY (rendered via resolveRouteAccess +
    // resolveWorkflowExposure) — eliminating the dual source of nav
    // truth that the legacy `envelope.navigation.groups` projection
    // had introduced.
    const code = stripComments(WEB_SIDEBAR);
    expect(WEB_SIDEBAR).toMatch(/usePlatformContext/);
    expect(WEB_SIDEBAR).toMatch(/ROUTE_REGISTRY/);
    expect(WEB_SIDEBAR).toMatch(/resolveRouteAccess/);
    expect(code).not.toMatch(/apiFetch\(/);
    expect(code).not.toMatch(/useActiveWorkspaceId\(/);
    expect(code).not.toMatch(/selectNavigationGroups\(/);
  });

  it("canonical useTeamWorkspaceGate is a thin context reader — no fetching", () => {
    const code = stripComments(WEB_LEGACY_HOOK);
    expect(WEB_LEGACY_HOOK).toMatch(/usePlatformContext/);
    expect(code).not.toMatch(/apiFetch\(/);
    expect(code).not.toMatch(/\/v1\/users\/me/);
    expect(code).not.toMatch(/\/v1\/teams/);
  });
});

// =============================================================================
// PART 11 — Teams restoration (F-4)
// =============================================================================

describe("Phase 32.8 Foundation — Teams restoration (F-4)", () => {
  it("Teams nav item exists in canonical navigation registry", () => {
    expect(NAV).toMatch(/id:\s*['"]admin\.teams['"]/);
    expect(NAV).toMatch(/href:\s*['"]\/teams['"]/);
    expect(NAV).toMatch(/requiresCapability:\s*['"]TEAM_VIEW['"]/);
  });

  it("/teams URL resolves to the workspace administration panel via canonical /workspaces", () => {
    // Phase Final-Closure-Remediation — the canonical surface for the
    // workspace administration panel is `/workspaces/page.tsx`; the
    // legacy `/teams` URL is now a permanent 308 redirect declared in
    // `next.config.js`. Behaviour parity preserved; routing layer is
    // the single source of truth.
    expect(WEB_WORKSPACES_PAGE).toMatch(/WorkspaceAdministrationHome/);
    expect(WEB_NEXT_CONFIG).toMatch(
      /source:\s*["']\/teams["'][\s\S]{0,200}destination:\s*["']\/workspaces["']/,
    );
  });

  it("/teams/[id] surface retains invite + members + roles + seats functionality", () => {
    // Invitation flow
    expect(WEB_TEAMS_DETAIL).toMatch(/\/v1\/teams\/.+\/invites/);
    expect(WEB_TEAMS_DETAIL).toMatch(/inviteEmail/);
    expect(WEB_TEAMS_DETAIL).toMatch(/inviteRole/);
    // Members list
    expect(WEB_TEAMS_DETAIL).toMatch(/team\?\.members/);
    expect(WEB_TEAMS_DETAIL).toMatch(/memberCount/);
    // Pending invites
    expect(WEB_TEAMS_DETAIL).toMatch(/invites/);
    // Seat / billing indicators
    expect(WEB_TEAMS_DETAIL).toMatch(/seatLimit|teamMembersUsed/);
  });

  it("backend Teams routes are all preserved (no functional disappearance)", () => {
    for (const route of [
      'app.get("/v1/teams"',
      'app.post("/v1/teams"',
      '"/v1/teams/:id/invites"',
      '"/v1/teams/:id/members/:memberId"',
      '"/v1/teams/:id/activity"',
      '"/v1/teams/invites/:token/accept"',
    ]) {
      expect(API_TEAMS_ROUTES).toContain(route);
    }
  });

  it("Teams nav resolves to true for every team member, not just OWNER/ADMIN", () => {
    for (const role of ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const) {
      const caps = resolveCapabilities({
        scope: "TEAM",
        role,
        plan: "TEAM",
        isPlatformAdmin: false,
      });
      expect(caps.TEAM_VIEW).toBe(true);
    }
  });

  it("TEAM_MANAGE is restricted to OWNER/ADMIN (mutation gate)", () => {
    const ownerCaps = resolveCapabilities({
      scope: "TEAM",
      role: "OWNER",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    const adminCaps = resolveCapabilities({
      scope: "TEAM",
      role: "ADMIN",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    const memberCaps = resolveCapabilities({
      scope: "TEAM",
      role: "MEMBER",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    expect(ownerCaps.TEAM_MANAGE).toBe(true);
    expect(adminCaps.TEAM_MANAGE).toBe(true);
    expect(memberCaps.TEAM_MANAGE).toBe(false);
  });
});

// =============================================================================
// PART 12 — ReviewerOps + Governance personal-mode repair (F-5)
// =============================================================================

describe("Phase 32.8 Foundation — ReviewerOps + Governance repair (F-5)", () => {
  const REVIEWER_CONSOLE = readWeb(
    "components/reviewer-experience/ReviewerCommandConsole.tsx",
  );
  const GOVERNANCE_CONSOLE = readWeb(
    "components/governance-experience/GovernanceControlPlane.tsx",
  );

  it("ReviewerCommandConsole gates personal mode via ctx.can('REVIEWER_OPS_VIEW')", () => {
    expect(REVIEWER_CONSOLE).toMatch(/usePlatformContext/);
    expect(REVIEWER_CONSOLE).toMatch(/can\(\s*['"]REVIEWER_OPS_VIEW['"]\s*\)/);
    expect(REVIEWER_CONSOLE).toMatch(/CapabilityDegradedPanel/);
  });

  it("GovernanceControlPlane gates personal mode via ctx.can('GOVERNANCE_VIEW')", () => {
    expect(GOVERNANCE_CONSOLE).toMatch(/usePlatformContext/);
    expect(GOVERNANCE_CONSOLE).toMatch(/can\(\s*['"]GOVERNANCE_VIEW['"]\s*\)/);
    expect(GOVERNANCE_CONSOLE).toMatch(/CapabilityDegradedPanel/);
  });

  it("ReviewerCommandConsole renders the structured panel BEFORE the legacy ShellNoWorkspace branch", () => {
    const reviewerIdx = REVIEWER_CONSOLE.indexOf("CapabilityDegradedPanel");
    const fallbackIdx = REVIEWER_CONSOLE.indexOf("ShellNoWorkspace />");
    expect(reviewerIdx).toBeGreaterThan(0);
    if (fallbackIdx > 0) {
      expect(reviewerIdx).toBeLessThan(fallbackIdx);
    }
  });

  it("GovernanceControlPlane renders the structured panel BEFORE the legacy ShellNoWorkspace branch", () => {
    const governanceIdx = GOVERNANCE_CONSOLE.indexOf("CapabilityDegradedPanel");
    const fallbackIdx = GOVERNANCE_CONSOLE.indexOf("ShellNoWorkspace />");
    expect(governanceIdx).toBeGreaterThan(0);
    if (fallbackIdx > 0) {
      expect(governanceIdx).toBeLessThan(fallbackIdx);
    }
  });
});

// =============================================================================
// PART 13 — Legacy cleanup + regression-prevention (F-6)
// =============================================================================

describe("Phase 32.8 Foundation — legacy cleanup (F-6)", () => {
  const WEB_HEADER = readWeb("components/header.tsx");

  it("dead AppHeader function + APP_NAV array are removed from header.tsx", () => {
    expect(WEB_HEADER).not.toMatch(/export\s+function\s+AppHeader/);
    expect(WEB_HEADER).not.toMatch(/APP_NAV:\s*AppNavItem\[\]\s*=/);
    expect(WEB_HEADER).not.toMatch(/type\s+AppNavItem\s*=/);
  });

  it("shell components do NOT import legacy workspace-profile / navigation-config", () => {
    const topbar = stripComments(WEB_TOPBAR);
    const sidebar = stripComments(WEB_SIDEBAR);
    const shell = stripComments(WEB_SHELL);
    expect(topbar).not.toMatch(/from\s+['"][^'"]*workspace-profile['"]/);
    expect(sidebar).not.toMatch(/from\s+['"][^'"]*workspace-profile['"]/);
    expect(shell).not.toMatch(/from\s+['"][^'"]*workspace-profile['"]/);
    expect(topbar).not.toMatch(/from\s+['"][^'"]*navigation-config['"]/);
    expect(sidebar).not.toMatch(/from\s+['"][^'"]*navigation-config['"]/);
    expect(shell).not.toMatch(/from\s+['"][^'"]*navigation-config['"]/);
  });

  it("(app)/layout does NOT pass user or isPlatformAdmin props anywhere", () => {
    const code = stripComments(WEB_LAYOUT);
    expect(code).not.toMatch(/isPlatformAdmin=/);
    expect(code).not.toMatch(/user=\{/);
  });

  it("shell components do NOT call apiFetch directly", () => {
    const topbar = stripComments(WEB_TOPBAR);
    const sidebar = stripComments(WEB_SIDEBAR);
    const shell = stripComments(WEB_SHELL);
    expect(topbar).not.toMatch(/apiFetch\(/);
    expect(sidebar).not.toMatch(/apiFetch\(/);
    expect(shell).not.toMatch(/apiFetch\(/);
  });

  it("shell components do NOT call useActiveWorkspaceId", () => {
    const topbar = stripComments(WEB_TOPBAR);
    const sidebar = stripComments(WEB_SIDEBAR);
    const shell = stripComments(WEB_SHELL);
    expect(topbar).not.toMatch(/useActiveWorkspaceId\(/);
    expect(sidebar).not.toMatch(/useActiveWorkspaceId\(/);
    expect(shell).not.toMatch(/useActiveWorkspaceId\(/);
  });

  it("canonical useTeamWorkspaceGate hook reads from context only", () => {
    // The legacy useActiveWorkspaceId.ts file has been deleted; the
    // canonical replacement is useTeamWorkspaceGate (read here as
    // WEB_LEGACY_HOOK for backward-compatible test naming).
    expect(WEB_LEGACY_HOOK).toMatch(/useTeamWorkspaceGate/);
    expect(WEB_LEGACY_HOOK).toMatch(/usePlatformContext/);
  });

  it("no shell component derives isPlatformAdmin from platformRole inline", () => {
    const topbar = stripComments(WEB_TOPBAR);
    const sidebar = stripComments(WEB_SIDEBAR);
    const shell = stripComments(WEB_SHELL);
    const layout = stripComments(WEB_LAYOUT);
    for (const code of [topbar, sidebar, shell, layout]) {
      expect(code).not.toMatch(/platformRole\s*===\s*['"]OWNER['"]/);
      expect(code).not.toMatch(/platformRole\s*===\s*['"]ADMIN['"]/);
      expect(code).not.toMatch(/platformRole\s*===\s*['"]admin['"]/);
    }
  });

  it("no shell component declares a parallel WorkspaceRole enum", () => {
    const topbar = stripComments(WEB_TOPBAR);
    const sidebar = stripComments(WEB_SIDEBAR);
    expect(topbar).not.toMatch(/const\s+WORKSPACE_ROLES\s*=/);
    expect(sidebar).not.toMatch(/const\s+WORKSPACE_ROLES\s*=/);
  });
});

// =============================================================================
// PART 14 — No-regression invariants
// =============================================================================

describe("Phase 32.8 Foundation — no regressions", () => {
  it("capability registry does not reference any specific role string in switch", () => {
    // It DOES use role variables, but only via the bounded
    // WorkspaceRole union — not via inline string equality checks
    // on persona strings from other vocabularies (e.g. REVIEWER,
    // EXTERNAL_REVIEWER).
    expect(CAP).not.toMatch(/['"]REVIEWER['"]/);
    expect(CAP).not.toMatch(/['"]EXTERNAL_REVIEWER['"]/);
    expect(CAP).not.toMatch(/['"]GOVERNANCE_OFFICER['"]/);
  });

  it("navigation registry has no hardcoded persona tags", () => {
    expect(NAV).not.toMatch(/futurePersonaTags/);
    expect(NAV).not.toMatch(/workspaceScope/);
  });

  it("builder source does not call /v1/users/me or /v1/teams as authority", () => {
    expect(SVC).not.toMatch(/\/v1\/users\/me/);
    expect(SVC).not.toMatch(/\/v1\/teams/);
  });
});
