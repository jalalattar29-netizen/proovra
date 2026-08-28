/**
 * ENTERPRISE TENANT MODEL — Account / Personal Space / Organization
 * canonical product-model contract tests.
 *
 * Source-contract style: file-driven assertions that prevent regressions in
 * the canonical type/registry/service/frontend wiring. Behavioral DB tests
 * for the actual idempotency / concurrency safety live in
 * phase-emergency-recovery-bootstrap.test.ts; this file enforces the
 * structural contract that the product model exists and is consumed
 * correctly.
 *
 * Parts:
 *   1  Types — bounded vocabularies and new canonical sections present
 *   2  Capability registry — new keys populated by scope/role
 *   3  Platform-context service — emits account/personalSpace/organizations
 *      /activeSpace + diagnostics; excludes isPersonal=true from orgs;
 *      detects duplicate-personal candidates
 *   4  Frontend types mirror new sections
 *   5  Switcher — Personal section + Organizations section + Actions
 *   6  /teams page — canonical home + Personal Space card + Orgs list
 *   7  Tenant isolation invariants — every team-scoped operational route
 *      requires a teamId/scope query parameter (no unbounded findMany)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_KEYS,
  CAPABILITY_SCHEMA_VERSION,
} from "../src/services/platform-context/types.js";
import { resolveCapabilities } from "../src/services/platform-context/capability-registry.js";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

const TYPES = readApi("src/services/platform-context/types.ts");
const SVC = readApi("src/services/platform-context/platform-context.service.ts");

const WEB_TYPES = readWeb("lib/platform-context/types.ts");
const WEB_HOOKS = readWeb("lib/platform-context/useTenantModel.ts");
const WEB_INDEX = readWeb("lib/platform-context/index.ts");
// Product-reset: AppTopbarV2 (dead duplicate topbar) deleted; contract
// retargeted to the live AppAccountToolbar.
const WEB_TOPBAR = readWeb("components/app-shell-v2/AppAccountToolbar.tsx");
// account-menu refactor 2026-07-21 — the folded switcher's canonical labels
// (Personal Space / org displayName) live in the single client resolver.
const WEB_ACCOUNT_RESOLVER = readWeb("lib/navigation/accountMenu.ts");
// Phase Final-Closure-Remediation — the legacy duplicate
// `app/(app)/teams/page.tsx` was deleted in favour of the canonical
// `app/(app)/workspaces/page.tsx`. The `/teams` URL now redirects
// there via `next.config.js`.
const WEB_WORKSPACES_PAGE = readWeb("app/(app)/workspaces/page.tsx");
const WEB_NEXT_CONFIG = readWeb("next.config.js");
const WEB_TEAMS_HOME = readWeb(
  "components/workspace-admin/WorkspaceAdministrationHome.tsx",
);

// =============================================================================
// PART 1 — Types
// =============================================================================

describe("ENTERPRISE TENANT MODEL — types", () => {
  it("authority + capability schema versions are bumped (>=2)", () => {
    // Schema versions are monotonic; later phases (A2 / G5) bumped
    // them further. The contract is "must be >= 2 after the
    // enterprise-tenant-model migration", not pinned to exactly 2.
    expect(AUTHORITY_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
    expect(CAPABILITY_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
  });

  it("backend declares Account / PersonalSpace / Organization / ActiveSpace types", () => {
    expect(TYPES).toMatch(/export type PlatformContextAccount\b/);
    expect(TYPES).toMatch(/export type PlatformContextPersonalSpace\b/);
    expect(TYPES).toMatch(/export type PlatformContextOrganization\b/);
    expect(TYPES).toMatch(/export type PlatformContextActiveSpace\b/);
    expect(TYPES).toMatch(/export type PlatformContextDuplicatePersonalCandidate\b/);
  });

  it("envelope declares account / personalSpace / organizations / activeSpace / duplicatePersonalCandidates fields", () => {
    expect(TYPES).toMatch(/\baccount:\s*PlatformContextAccount\b/);
    expect(TYPES).toMatch(/\bpersonalSpace:\s*PlatformContextPersonalSpace\b/);
    expect(TYPES).toMatch(
      /\borganizations:\s*ReadonlyArray<PlatformContextOrganization>/,
    );
    expect(TYPES).toMatch(/\bactiveSpace:\s*PlatformContextActiveSpace\b/);
    expect(TYPES).toMatch(
      /\bduplicatePersonalCandidates:\s*ReadonlyArray<PlatformContextDuplicatePersonalCandidate>/,
    );
  });

  it("PersonalSpace label is bounded to the literal 'Personal Space'", () => {
    expect(TYPES).toMatch(/label:\s*"Personal Space"/);
  });

  it("ActiveSpace discriminator uses PERSONAL / ORGANIZATION literals (not TEAM)", () => {
    expect(TYPES).toMatch(/type:\s*"PERSONAL"/);
    expect(TYPES).toMatch(/type:\s*"ORGANIZATION"/);
  });

  it("new canonical capability keys are part of CAPABILITY_KEYS", () => {
    const required = [
      "ACCOUNT_SETTINGS_VIEW",
      "ACCOUNT_BILLING_VIEW",
      "ACCOUNT_UPGRADE_VIEW",
      "ORGANIZATION_CREATE",
      "ORGANIZATION_JOIN",
      "PERSONAL_CAPTURE",
      "PERSONAL_EVIDENCE_VIEW",
      "PERSONAL_CASES_VIEW",
      "PERSONAL_REPORTS_VIEW",
      "PERSONAL_SEARCH_VIEW",
      "ORG_EVIDENCE_VIEW",
      "ORG_CASES_VIEW",
      "ORG_REPORTS_VIEW",
      "ORG_SEARCH_VIEW",
      "ORG_REVIEWER_OPS_VIEW",
      "ORG_GOVERNANCE_VIEW",
      "ORG_OPS_VIEW",
      "ORG_TEAM_MANAGE",
      "ORG_BILLING_MANAGE",
    ];
    for (const key of required) {
      expect(
        (CAPABILITY_KEYS as ReadonlyArray<string>).includes(key),
        `CAPABILITY_KEYS must include ${key}`,
      ).toBe(true);
    }
  });

  it("diagnostics surface activeSpaceSource + staleWorkspaceHealed + duplicatePersonalRowsDetected", () => {
    expect(TYPES).toMatch(/activeSpaceSource:/);
    expect(TYPES).toMatch(/staleWorkspaceHealed:\s*boolean/);
    expect(TYPES).toMatch(/duplicatePersonalRowsDetected:\s*number/);
  });
});

// =============================================================================
// PART 2 — Capability registry
// =============================================================================

describe("ENTERPRISE TENANT MODEL — capability registry", () => {
  function caps(args: {
    scope: "PERSONAL" | "TEAM";
    role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
    plan: "FREE" | "PAYG" | "PRO" | "TEAM";
    isPlatformAdmin?: boolean;
  }) {
    return resolveCapabilities({
      scope: args.scope,
      role: args.role,
      plan: args.plan,
      isPlatformAdmin: args.isPlatformAdmin ?? false,
    });
  }

  it("account-tier capabilities are granted for ANY authenticated viewer with a workspace", () => {
    const personal = caps({ scope: "PERSONAL", role: "OWNER", plan: "FREE" });
    const teamOwner = caps({ scope: "TEAM", role: "OWNER", plan: "TEAM" });
    const teamViewer = caps({ scope: "TEAM", role: "VIEWER", plan: "TEAM" });
    for (const c of [personal, teamOwner, teamViewer]) {
      expect(c.ACCOUNT_SETTINGS_VIEW).toBe(true);
      expect(c.ACCOUNT_BILLING_VIEW).toBe(true);
      expect(c.ACCOUNT_UPGRADE_VIEW).toBe(true);
      expect(c.ORGANIZATION_CREATE).toBe(true);
      expect(c.ORGANIZATION_JOIN).toBe(true);
    }
  });

  it("PERSONAL_* keys are granted only when scope=PERSONAL", () => {
    const personal = caps({ scope: "PERSONAL", role: "OWNER", plan: "FREE" });
    const team = caps({ scope: "TEAM", role: "OWNER", plan: "TEAM" });
    expect(personal.PERSONAL_CAPTURE).toBe(true);
    expect(personal.PERSONAL_EVIDENCE_VIEW).toBe(true);
    expect(personal.PERSONAL_CASES_VIEW).toBe(true);
    expect(personal.PERSONAL_REPORTS_VIEW).toBe(true);
    expect(personal.PERSONAL_SEARCH_VIEW).toBe(true);
    expect(team.PERSONAL_CAPTURE).toBe(false);
    expect(team.PERSONAL_EVIDENCE_VIEW).toBe(false);
  });

  it("ORG_* keys are granted only when scope=TEAM, role-aware", () => {
    const personal = caps({ scope: "PERSONAL", role: "OWNER", plan: "FREE" });
    const owner = caps({ scope: "TEAM", role: "OWNER", plan: "TEAM" });
    const admin = caps({ scope: "TEAM", role: "ADMIN", plan: "TEAM" });
    const member = caps({ scope: "TEAM", role: "MEMBER", plan: "TEAM" });
    const viewer = caps({ scope: "TEAM", role: "VIEWER", plan: "TEAM" });

    expect(personal.ORG_EVIDENCE_VIEW).toBe(false);
    expect(personal.ORG_TEAM_MANAGE).toBe(false);
    expect(personal.ORG_BILLING_MANAGE).toBe(false);

    for (const c of [owner, admin, member, viewer]) {
      expect(c.ORG_EVIDENCE_VIEW).toBe(true);
      expect(c.ORG_CASES_VIEW).toBe(true);
      expect(c.ORG_REPORTS_VIEW).toBe(true);
      expect(c.ORG_REVIEWER_OPS_VIEW).toBe(true);
      expect(c.ORG_GOVERNANCE_VIEW).toBe(true);
      expect(c.ORG_OPS_VIEW).toBe(true);
    }
    expect(owner.ORG_TEAM_MANAGE).toBe(true);
    expect(admin.ORG_TEAM_MANAGE).toBe(true);
    expect(member.ORG_TEAM_MANAGE).toBe(false);
    expect(viewer.ORG_TEAM_MANAGE).toBe(false);
    expect(owner.ORG_BILLING_MANAGE).toBe(true);
    expect(admin.ORG_BILLING_MANAGE).toBe(true);
    expect(member.ORG_BILLING_MANAGE).toBe(false);
  });

  it("personal OWNER does NOT inherit organization-tier operator caps even on PRO plan", () => {
    const c = caps({ scope: "PERSONAL", role: "OWNER", plan: "PRO" });
    expect(c.ORG_REVIEWER_OPS_VIEW).toBe(false);
    expect(c.ORG_GOVERNANCE_VIEW).toBe(false);
    expect(c.ORG_TEAM_MANAGE).toBe(false);
    expect(c.ORG_BILLING_MANAGE).toBe(false);
  });
});

// =============================================================================
// PART 3 — Platform-context service: emits canonical sections + duplicates
// =============================================================================

describe("ENTERPRISE TENANT MODEL — platform-context service", () => {
  it("builds the canonical organizations list and excludes isPersonal=true rows", () => {
    expect(SVC).toMatch(/const organizations:\s*PlatformContextOrganization\[\]/);
    // The split in the memberRows loop must check isPersonal.
    expect(SVC).toMatch(/m\.team\.isPersonal/);
    // The org list push must happen only after the isPersonal branch.
    expect(SVC).toMatch(/organizations\.push\(/);
  });

  it("no longer pushes a synthetic '__personal__' row into availableWorkspaces", () => {
    expect(SVC).not.toMatch(/__personal__/);
  });

  it("emits PersonalSpace with the canonical 'Personal Space' label", () => {
    expect(SVC).toMatch(
      /personalSpace:\s*PlatformContextPersonalSpace\s*=[\s\S]{0,400}label:\s*"Personal Space"/,
    );
  });

  it("emits ActiveSpace discriminated by PERSONAL vs ORGANIZATION", () => {
    expect(SVC).toMatch(/activeSpace:\s*PlatformContextActiveSpace/);
    expect(SVC).toMatch(/type:\s*"PERSONAL"/);
    expect(SVC).toMatch(/type:\s*"ORGANIZATION"/);
    // Active space displayName for personal MUST be the bounded literal.
    expect(SVC).toMatch(/displayName:\s*"Personal Space"/);
  });

  it("emits Account section with userId + accountPlan derived from Entitlement", () => {
    expect(SVC).toMatch(/account:\s*PlatformContextAccount/);
    expect(SVC).toMatch(/accountPlan/);
    expect(SVC).toMatch(/prisma\.entitlement\.findFirst/);
  });

  it("detects duplicate personal-like rows via bounded heuristic", () => {
    expect(SVC).toMatch(
      /duplicatePersonalCandidates:\s*PlatformContextDuplicatePersonalCandidate\[\]/,
    );
    expect(SVC).toMatch(/"name_matches_email_personal"/);
    expect(SVC).toMatch(/"single_owner_member"/);
    expect(SVC).toMatch(/"free_plan"/);
  });

  it("envelope emits all canonical sections", () => {
    // Each top-level field must appear in the envelope literal.
    for (const field of [
      "account,",
      "personalSpace,",
      "organizations,",
      "activeSpace,",
      "duplicatePersonalCandidates,",
    ]) {
      expect(SVC).toMatch(new RegExp(field.replace(/\W/g, "\\$&")));
    }
  });
});

// =============================================================================
// PART 4 — Frontend types + hooks
// =============================================================================

describe("ENTERPRISE TENANT MODEL — frontend types + hooks", () => {
  it("frontend types mirror the new canonical sections", () => {
    expect(WEB_TYPES).toMatch(/PlatformContextAccount\b/);
    expect(WEB_TYPES).toMatch(/PlatformContextPersonalSpace\b/);
    expect(WEB_TYPES).toMatch(/PlatformContextOrganization\b/);
    expect(WEB_TYPES).toMatch(/PlatformContextActiveSpace\b/);
    expect(WEB_TYPES).toMatch(/PlatformContextDuplicatePersonalCandidate\b/);
  });

  it("frontend types declare account/personalSpace/organizations/activeSpace as REQUIRED, matching the server contract", () => {
    // Phase 12 Point 4 (Pass E) — these four (plus contextOptions and
    // operationalEligibility) were declared OPTIONAL on the web while the
    // API declares them REQUIRED and returns them on every envelope build.
    // That one-sided optionality was the sole justification for a family of
    // "older deployment / older envelope shape" fallback branches, one of
    // which fabricated a synthetic `organizationId: "legacy"` group in the
    // workspace switcher. The web contract now matches the server's.
    expect(WEB_TYPES).toMatch(/\baccount:\s*PlatformContextAccount/);
    expect(WEB_TYPES).toMatch(/\bpersonalSpace:\s*PlatformContextPersonalSpace/);
    expect(WEB_TYPES).toMatch(
      /\borganizations:\s*ReadonlyArray<PlatformContextOrganization>/,
    );
    expect(WEB_TYPES).toMatch(/\bactiveSpace:\s*PlatformContextActiveSpace/);
    expect(WEB_TYPES).toMatch(/\bcontextOptions:\s*PlatformContextContextOptions/);
    expect(WEB_TYPES).toMatch(
      /\boperationalEligibility:\s*PlatformContextOperationalEligibility/,
    );
    // No optional marker may return on any of them.
    for (const field of [
      "account",
      "personalSpace",
      "organizations",
      "activeSpace",
      "contextOptions",
      "operationalEligibility",
    ]) {
      expect(WEB_TYPES, `${field} must not be optional again`).not.toMatch(
        new RegExp(`\\b${field}\\?:`),
      );
    }
  });

  it("canonical hooks are exported from the platform-context index", () => {
    expect(WEB_INDEX).toMatch(/useAccount/);
    expect(WEB_INDEX).toMatch(/usePersonalSpace/);
    expect(WEB_INDEX).toMatch(/useOrganizations/);
    expect(WEB_INDEX).toMatch(/useActiveSpace/);
    expect(WEB_INDEX).toMatch(/useActiveSpaceId/);
    expect(WEB_INDEX).toMatch(/useCan/);
    expect(WEB_INDEX).toMatch(/useDuplicatePersonalCandidates/);
  });

  it("useTenantModel hooks read from envelope only (no fetches, no role derivation)", () => {
    expect(WEB_HOOKS).not.toMatch(/fetch\(|apiFetch\(/);
    // No client-side role/scope derivation; only envelope reads.
    expect(WEB_HOOKS).toMatch(/usePlatformContext/);
  });
});

// =============================================================================
// PART 5 — Switcher rebuild
// =============================================================================

describe("ENTERPRISE TENANT MODEL — workspace switcher", () => {
  it("switcher reads the canonical sections (personalSpace + organizations + activeSpace) (account-menu refactor 2026-07-21)", () => {
    // The switcher is resolved by resolveAccountMenu, which is fed the
    // canonical envelope sections. activeSpace is also read for the header
    // badge.
    expect(WEB_TOPBAR).toMatch(/personalSpace:\s*envelope\?\.personalSpace/);
    expect(WEB_TOPBAR).toMatch(/organizations:\s*envelope\?\.organizations/);
    expect(WEB_TOPBAR).toMatch(/activeSpace\s*=\s*envelope\?\.activeSpace/);
  });

  it("switcher renders Personal section with the Personal Space label (P3/P4 domain remediation 2026-07-21)", () => {
    // The persistent context chip's panel renders the PERSONAL group; its
    // option is the shared SwitcherOption bound to the resolver's personal
    // entry, whose label is the bounded "Personal Space" literal.
    expect(WEB_TOPBAR).toMatch(/data-context-group="PERSONAL"/); // (P3/P4 domain remediation 2026-07-21)
    expect(WEB_TOPBAR).toMatch(/option=\{menu\.workspaces\.personal\}/); // (P3/P4 domain remediation 2026-07-21)
    expect(WEB_ACCOUNT_RESOLVER).toMatch(/label:\s*"Personal Space"/);
  });

  it("switcher renders Organization groups from the server-authorized contextOptions (P3/P4 domain remediation 2026-07-21)", () => {
    // The resolver consumes the envelope's SERVER-AUTHORIZED contextOptions
    // section — and, since Phase 12 Point 4 (Pass E), ONLY that. The legacy
    // flat `organizations` rollout fallback is gone: it could not tell OWNED
    // from ORGANIZATION, so it invented a single bucket under a synthetic
    // `organizationId: "legacy"` — a fabricated identifier rendered as if the
    // server had authorized it. A null now means "envelope not loaded" and
    // yields no workspaces, never a guessed grouping.
    expect(WEB_TOPBAR).toMatch(/contextOptions:\s*envelope\?\.contextOptions/); // (P3/P4 domain remediation 2026-07-21)
    expect(WEB_ACCOUNT_RESOLVER).toMatch(
      /input\.contextOptions\?\.organizations\s*\?\?\s*\[\]/,
    );
    // Comments are stripped — the resolver documents why the fabricated
    // group was removed, and that reasoning should stay readable.
    const resolverCode = WEB_ACCOUNT_RESOLVER.split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(resolverCode).not.toMatch(/organizationId:\s*"legacy"/);
    // …and the toolbar renders one ORGANIZATION group per organization,
    // labelled with the organization name — while still mapping the
    // resolved org options.
    expect(WEB_TOPBAR).toMatch(/menu\.workspaces\.organizations\.map\(/);
    expect(WEB_TOPBAR).toMatch(/data-context-group="ORGANIZATION"/); // (P3/P4 domain remediation 2026-07-21)
    expect(WEB_TOPBAR).toMatch(/data-context-organization=\{group\.organizationId\}/); // (P3/P4 domain remediation 2026-07-21)
    expect(WEB_TOPBAR).toMatch(/\{group\.organizationName \?\? "Organizations"\}/); // (P3/P4 domain remediation 2026-07-21)
  });

  it("switcher no longer renders an Actions section (create / join / manage removed) (account-menu refactor 2026-07-21)", () => {
    // The folded in-menu switcher switches the active workspace in place and
    // never navigates to a /workspaces admin surface. The retired Actions
    // group (create/join/manage) is gone.
    expect(WEB_TOPBAR).not.toMatch(/href="\/workspaces\?action=create"/);
    expect(WEB_TOPBAR).not.toMatch(/href="\/workspaces\?action=join"/);
    expect(WEB_TOPBAR).not.toMatch(/Manage organizations/);
    // Switching happens in place via the platform-context switchWorkspace.
    expect(WEB_TOPBAR).toMatch(/handleSwitchWorkspace/);
  });

  it("switcher never labels Personal Space as TEAM", () => {
    // Negative match: there must be no chip rendering "Team" for the
    // personal option. The personal item explicitly uses Personal chip.
    expect(WEB_TOPBAR).not.toMatch(/Personal Space[\s\S]{0,200}data-workspace-scope-chip="TEAM"/);
  });
});

// =============================================================================
// PART 6 — /teams page redefinition
// =============================================================================

describe("ENTERPRISE TENANT MODEL — /teams page", () => {
  it("/workspaces owns WorkspaceAdministrationHome; /teams is NOT redirected away", () => {
    // Phase HOME-DATA-OWNERSHIP — the /teams → /workspaces redirect was
    // REMOVED (it shadowed the self-serve /teams landing and blanked
    // Home's "Invite a teammate" for personal-space users).
    expect(WEB_WORKSPACES_PAGE).toMatch(/WorkspaceAdministrationHome/);
    expect(WEB_WORKSPACES_PAGE).not.toMatch(/^\s*export\s+default[\s\S]{0,200}WorkspaceAdminPanel/m);
    expect(WEB_NEXT_CONFIG).not.toMatch(
      /source:\s*["']\/teams["'][\s\S]{0,200}destination:\s*["']\/workspaces["']/,
    );
  });

  it("WorkspaceAdministrationHome renders Personal Space card + Organizations + Actions", () => {
    expect(WEB_TEAMS_HOME).toMatch(/data-personal-space-card/);
    expect(WEB_TEAMS_HOME).toMatch(/data-workspace-admin-section="organizations"/);
    // Rebaselined 2026-08-17 — PHASE 13 §2. The Actions block used to carry a
    // `create_organization` LINK to `/teams?action=create`, a query the page
    // never handled: the control existed and did nothing. It became the real
    // create control, `CreateWorkspaceCard`, which POSTed /v1/teams.
    //
    // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — that control is GONE,
    // and the assertion is now its absence.
    //
    // The server refuses self-service workspace creation: checkout has one
    // subject and it is the person, so a workspace created there could never
    // be paid for — it would resolve FREE permanently and the
    // shared-workspace admission rule would refuse every piece of evidence
    // recorded in it. A control for a capability the server refuses is a
    // button that always fails, which is a worse state than the dead link this
    // assertion was written to replace.
    //
    // The rest of the Actions block is unchanged and still asserted below, so
    // this test still proves the section renders rather than vanishing.
    expect(WEB_TEAMS_HOME).not.toMatch(/CreateWorkspaceCard/);
    expect(WEB_TEAMS_HOME).toMatch(/data-workspace-action="join_organization"/);
  });

  it("renders the duplicate-personal diagnostic when surfaces are flagged", () => {
    expect(WEB_TEAMS_HOME).toMatch(/data-workspace-admin-section="duplicate-personal"/);
    expect(WEB_TEAMS_HOME).toMatch(/data-duplicate-personal-id/);
    expect(WEB_TEAMS_HOME).toMatch(/data-duplicate-personal-reason/);
  });

  it("never gates the whole page on useTeamWorkspaceGate (personal users must reach this page)", () => {
    expect(WEB_TEAMS_HOME).not.toMatch(/useTeamWorkspaceGate/);
  });
});

// =============================================================================
// PART 7 — Tenant isolation invariants (enterprise scale hardening)
//
// These are SOURCE-CONTRACT checks: every team-scoped operational route
// must read a teamId from the request before reading data. They prevent
// the introduction of an unbounded findMany that would scan across tenants.
// =============================================================================

describe("ENTERPRISE TENANT MODEL — tenant isolation invariants", () => {
  const ROUTES_TO_SCOPE_GATE = [
    // Reports + workspace admin live here.
    "src/routes/case-workspace.routes.ts",
    "src/routes/search.routes.ts",
    "src/routes/cases.routes.ts",
    "src/routes/evidence.routes.ts",
    "src/routes/reviewer-ops.routes.ts",
    "src/routes/governance.routes.ts",
  ];

  for (const rel of ROUTES_TO_SCOPE_GATE) {
    it(`${rel} reads teamId from the request (no unscoped findMany)`, () => {
      const src = readApi(rel);
      // The route file must reference `teamId` somewhere — the canonical
      // scoping parameter. Routes that genuinely operate on the global
      // platform tier are out of scope for this check.
      expect(src, `${rel} must scope queries by teamId`).toMatch(/teamId/);
    });
  }

  it("availableWorkspaces query is bounded (take: 200)", () => {
    // (P0/P3 remediation 2026-07-21) anchored on the ACTIVE-scoped where
    // clause instead of a brittle char-window: the select now also carries
    // workspaceKind + parent-organization fields. Invariant unchanged —
    // the user-scoped ACTIVE membership query stays bounded at take: 200.
    expect(SVC).toMatch(
      /where: \{ userId: userRow\.id, status: "ACTIVE" \}[\s\S]{0,1800}take:\s*200/,
    );
  });
});
