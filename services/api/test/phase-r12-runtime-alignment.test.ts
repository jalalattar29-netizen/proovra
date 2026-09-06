/**
 * Phase R12 — Runtime Model Alignment & Access Consolidation
 * source-contract test.
 *
 * Pins the Phase 3 deliverables produced under
 * docs/architecture/phase-3-runtime-refactor-readiness.md:
 *
 *   Stage 2 — Canonical workspace ID hook (`useActiveWorkspaceId`)
 *             promoted; the other three hooks carry @deprecated.
 *   Stage 3 — Canonical denial vocabulary in `@proovra/shared` maps
 *             AccessState / AccessGateKind / AuthorizationDenialCode
 *             onto a single `DenialReason`.
 *   Stage 4 — Canonical TOM persona projection in `@proovra/shared`
 *             returns one of 8 constitutional personas.
 *   Stage 5 — Inline `WorkspaceScope = "SINGLE_OCCUPANT" | "SHARED"`
 *             duplicates carry @deprecated.
 *   Stage 6 — Dead PERSONAL_* + ORG_* capability keys carry
 *             @deprecated. The grants in the capability registry
 *             still fire (no behaviour change).
 *   Stage 7 — Backend canonical workspace resolver +
 *             `mapAuthorizationDenial` helpers exist and re-export the
 *             shared denial mapping.
 *
 * This test does NOT exercise runtime behaviour. It greps the source
 * tree and asserts shared-package constants. Its job is to make
 * Phase 3 drift LOUD at CI time.
 *
 * Adding, changing, or relaxing any Phase 3 contract requires:
 *   1. Editing docs/architecture/phase-3-runtime-refactor-readiness.md
 *   2. Editing this test
 *   3. Architecture board approval.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  // Stage 3
  DENIAL_REASONS,
  accessStateToDenialReason,
  accessGateKindToDenialReason,
  authorizationDenialCodeToDenialReason,
  anyDenialToCanonical,
  denialReasonHeadline,
  denialReasonGuidance,
  // Stage 4
  TOM_PERSONA_KINDS,
  projectTomPersona,
  tomPersonaLabel,
  isSoloTomPersona,
  isOrgTomPersona,
} from "@proovra/shared";

// =============================================================================
// Path helpers
// =============================================================================

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const apiSrc = join(repoRoot, "services", "api", "src");
const webRoot = join(repoRoot, "apps", "web");
const sharedSrc = join(repoRoot, "packages", "shared", "src");

function read(rel: string): string {
  const full = join(repoRoot, rel);
  if (!existsSync(full)) {
    throw new Error(`R12: required file is missing: ${rel}`);
  }
  return readFileSync(full, "utf8");
}

// =============================================================================
// Stage 2 — Canonical workspace-id hook
// =============================================================================

describe("Phase R12 — Stage 2: canonical useActiveWorkspaceId", () => {
  const gateModule = read(
    "apps/web/lib/platform-context/useTeamWorkspaceGate.ts",
  );
  const tenantModule = read(
    "apps/web/lib/platform-context/useTenantModel.ts",
  );

  it("promotes useActiveWorkspaceId as PHASE 3 CANONICAL", () => {
    expect(gateModule).toMatch(/PHASE 3 CANONICAL/);
    expect(gateModule).toMatch(
      /export function useActiveWorkspaceId\(\): string \| null/,
    );
  });

  it("marks useTeamId as @deprecated", () => {
    const block = gateModule.match(
      /@deprecated[\s\S]{0,1200}export function useTeamId/,
    );
    expect(block).not.toBeNull();
  });

  it("marks useWorkspaceId as @deprecated", () => {
    const block = gateModule.match(
      /@deprecated[\s\S]{0,1200}export function useWorkspaceId/,
    );
    expect(block).not.toBeNull();
  });

  it("marks useActiveSpaceId as @deprecated", () => {
    const block = tenantModule.match(
      /@deprecated[\s\S]{0,1200}export function useActiveSpaceId/,
    );
    expect(block).not.toBeNull();
  });
});

// =============================================================================
// Stage 3 — Canonical denial vocabulary
// =============================================================================

describe("Phase R12 — Stage 3: canonical DenialReason vocabulary", () => {
  it("ships an 11-reason canonical enum", () => {
    expect(DENIAL_REASONS).toContain("AUTH_REQUIRED");
    expect(DENIAL_REASONS).toContain("PERMISSION_REQUIRED");
    expect(DENIAL_REASONS).toContain("ORGANIZATION_REQUIRED");
    expect(DENIAL_REASONS).toContain("WORKSPACE_REQUIRED");
    expect(DENIAL_REASONS).toContain("UPGRADE_REQUIRED");
    expect(DENIAL_REASONS).toContain("PLATFORM_ADMIN_REQUIRED");
    expect(DENIAL_REASONS).toContain("RECOVERY_REQUIRED");
    expect(DENIAL_REASONS).toContain("LEGAL_ACCEPTANCE_REQUIRED");
    expect(DENIAL_REASONS).toContain("SESSION_REVOKED");
    expect(DENIAL_REASONS).toContain("FEATURE_UNAVAILABLE");
    expect(DENIAL_REASONS).toContain("OPERATIONAL_ERROR");
    // exact length pins the canonical surface area.
    expect(DENIAL_REASONS.length).toBe(11);
  });

  it("maps every AccessState to a DenialReason (or null for ALLOWED)", () => {
    expect(accessStateToDenialReason("ALLOWED")).toBeNull();
    expect(accessStateToDenialReason("DENIED_NO_CAPABILITY")).toBe(
      "PERMISSION_REQUIRED",
    );
    expect(accessStateToDenialReason("NEEDS_ORGANIZATION")).toBe(
      "ORGANIZATION_REQUIRED",
    );
    expect(accessStateToDenialReason("NEEDS_PERSONAL_OR_ORG")).toBe(
      "WORKSPACE_REQUIRED",
    );
    expect(accessStateToDenialReason("NEEDS_UPGRADE")).toBe(
      "UPGRADE_REQUIRED",
    );
    expect(accessStateToDenialReason("PLATFORM_ADMIN_ONLY")).toBe(
      "PLATFORM_ADMIN_REQUIRED",
    );
    expect(accessStateToDenialReason("RECOVERY_REQUIRED")).toBe(
      "RECOVERY_REQUIRED",
    );
  });

  it("maps AccessGateKind variants to the canonical reason", () => {
    expect(accessGateKindToDenialReason("PLAN_UPGRADE")).toBe(
      "UPGRADE_REQUIRED",
    );
    for (const k of [
      "ASK_ADMIN",
      "REQUEST_ACCESS",
      "CONTACT_OWNER",
      "PERMISSION_REQUIRED",
    ]) {
      expect(accessGateKindToDenialReason(k)).toBe("PERMISSION_REQUIRED");
    }
    expect(accessGateKindToDenialReason("WORKSPACE_REQUIRED")).toBe(
      "WORKSPACE_REQUIRED",
    );
    expect(accessGateKindToDenialReason("FEATURE_UNAVAILABLE")).toBe(
      "FEATURE_UNAVAILABLE",
    );
  });

  it("maps every AuthorizationDenialCode to the canonical reason", () => {
    expect(authorizationDenialCodeToDenialReason("missing_actor")).toBe(
      "AUTH_REQUIRED",
    );
    expect(authorizationDenialCodeToDenialReason("no_actor")).toBe(
      "AUTH_REQUIRED",
    );
    expect(authorizationDenialCodeToDenialReason("missing_team_id")).toBe(
      "WORKSPACE_REQUIRED",
    );
    for (const c of [
      "member_not_active",
      "member_access_expired",
      "service_account_revoked",
      "service_account_disabled",
      "service_account_expired",
      "contributor_session_revoked",
      "contributor_session_expired",
    ]) {
      expect(authorizationDenialCodeToDenialReason(c)).toBe("SESSION_REVOKED");
    }
    for (const c of [
      "service_account_scope_missing",
      "contributor_unsupported_permission",
      "permission_not_granted",
    ]) {
      expect(authorizationDenialCodeToDenialReason(c)).toBe(
        "PERMISSION_REQUIRED",
      );
    }
    expect(
      authorizationDenialCodeToDenialReason("authorization_unavailable"),
    ).toBe("OPERATIONAL_ERROR");
  });

  it("ensures personal users never get ORGANIZATION_REQUIRED for personal-safe routes", () => {
    // The PERSONAL_OR_ORG-required route emits NEEDS_PERSONAL_OR_ORG —
    // that must map to WORKSPACE_REQUIRED, NOT ORGANIZATION_REQUIRED.
    expect(accessStateToDenialReason("NEEDS_PERSONAL_OR_ORG")).not.toBe(
      "ORGANIZATION_REQUIRED",
    );
    expect(accessStateToDenialReason("NEEDS_PERSONAL_OR_ORG")).toBe(
      "WORKSPACE_REQUIRED",
    );
    // Org-only pages still say organization required.
    expect(accessStateToDenialReason("NEEDS_ORGANIZATION")).toBe(
      "ORGANIZATION_REQUIRED",
    );
    // Permission denial is distinct from missing workspace.
    expect(accessStateToDenialReason("DENIED_NO_CAPABILITY")).not.toBe(
      "WORKSPACE_REQUIRED",
    );
    // Upgrade-required is distinct from permission-denied.
    expect(accessStateToDenialReason("NEEDS_UPGRADE")).not.toBe(
      "PERMISSION_REQUIRED",
    );
  });

  it("provides headline + guidance copy for every reason", () => {
    for (const r of DENIAL_REASONS) {
      const h = denialReasonHeadline(r);
      const g = denialReasonGuidance(r);
      expect(typeof h).toBe("string");
      expect(typeof g).toBe("string");
      expect(h.length).toBeGreaterThan(0);
      expect(g.length).toBeGreaterThan(0);
    }
  });

  it("anyDenialToCanonical accepts inputs from any of the three vocabularies", () => {
    expect(anyDenialToCanonical("NEEDS_ORGANIZATION")).toBe(
      "ORGANIZATION_REQUIRED",
    );
    expect(anyDenialToCanonical("PLAN_UPGRADE")).toBe("UPGRADE_REQUIRED");
    expect(anyDenialToCanonical("missing_team_id")).toBe("WORKSPACE_REQUIRED");
    expect(anyDenialToCanonical(null)).toBeNull();
    expect(anyDenialToCanonical("does-not-exist")).toBeNull();
  });
});

// =============================================================================
// Stage 4 — Canonical TOM persona projection
// =============================================================================

describe("Phase R12 — Stage 4: canonical TOM persona projection", () => {
  it("ships the 8 constitutional TOM personas", () => {
    expect(TOM_PERSONA_KINDS).toEqual([
      "INDIVIDUAL",
      "JOURNALIST",
      "LAWYER",
      "INVESTIGATOR",
      "SMALL_TEAM",
      "ORGANIZATION",
      "ENTERPRISE",
      "GOVERNMENT_AGENCY",
    ]);
    expect(TOM_PERSONA_KINDS.length).toBe(8);
  });

  it("projects INDIVIDUAL when no workspace kind is available", () => {
    expect(
      projectTomPersona({
        workspaceKind: null,
        plan: null,
        useCaseProfile: null,
        role: null,
        hasSsoOrScim: false,
        isGovernmentTenant: false,
        activeMemberCount: null,
      }),
    ).toBe("INDIVIDUAL");
  });

  it("projects personal vertical personas from the use-case profile", () => {
    const base = {
      workspaceKind: "PERSONAL" as const,
      plan: "free",
      role: null,
      hasSsoOrScim: false,
      isGovernmentTenant: false,
      activeMemberCount: 1,
    };
    expect(
      projectTomPersona({ ...base, useCaseProfile: "JOURNALIST" }),
    ).toBe("JOURNALIST");
    expect(projectTomPersona({ ...base, useCaseProfile: "LAWYER" })).toBe(
      "LAWYER",
    );
    expect(
      projectTomPersona({ ...base, useCaseProfile: "INVESTIGATOR" }),
    ).toBe("INVESTIGATOR");
    // Insurance is an investigator vertical.
    expect(projectTomPersona({ ...base, useCaseProfile: "INSURANCE" })).toBe(
      "INVESTIGATOR",
    );
    // Anything else → INDIVIDUAL.
    expect(projectTomPersona({ ...base, useCaseProfile: null })).toBe(
      "INDIVIDUAL",
    );
    expect(projectTomPersona({ ...base, useCaseProfile: "UNKNOWN" })).toBe(
      "INDIVIDUAL",
    );
  });

  it("projects organization personas correctly", () => {
    const orgBase = {
      workspaceKind: "ORGANIZATION" as const,
      useCaseProfile: "ENTERPRISE_COMPLIANCE",
      role: "OWNER",
      activeMemberCount: 50,
    };

    // government tenant always wins
    expect(
      projectTomPersona({
        ...orgBase,
        plan: "enterprise",
        hasSsoOrScim: true,
        isGovernmentTenant: true,
      }),
    ).toBe("GOVERNMENT_AGENCY");

    // SSO/SCIM ⇒ ENTERPRISE
    expect(
      projectTomPersona({
        ...orgBase,
        plan: "team",
        hasSsoOrScim: true,
        isGovernmentTenant: false,
      }),
    ).toBe("ENTERPRISE");

    // enterprise plan ⇒ ENTERPRISE
    expect(
      projectTomPersona({
        ...orgBase,
        plan: "enterprise",
        hasSsoOrScim: false,
        isGovernmentTenant: false,
      }),
    ).toBe("ENTERPRISE");

    // small headcount ⇒ SMALL_TEAM
    expect(
      projectTomPersona({
        ...orgBase,
        plan: "team",
        hasSsoOrScim: false,
        isGovernmentTenant: false,
        activeMemberCount: 4,
      }),
    ).toBe("SMALL_TEAM");

    // large org without enterprise plan ⇒ ORGANIZATION
    expect(
      projectTomPersona({
        ...orgBase,
        plan: "team",
        hasSsoOrScim: false,
        isGovernmentTenant: false,
        activeMemberCount: 100,
      }),
    ).toBe("ORGANIZATION");
  });

  it("classifies solo vs org personas", () => {
    for (const k of [
      "INDIVIDUAL",
      "JOURNALIST",
      "LAWYER",
      "INVESTIGATOR",
    ] as const) {
      expect(isSoloTomPersona(k)).toBe(true);
      expect(isOrgTomPersona(k)).toBe(false);
    }
    for (const k of [
      "SMALL_TEAM",
      "ORGANIZATION",
      "ENTERPRISE",
      "GOVERNMENT_AGENCY",
    ] as const) {
      expect(isOrgTomPersona(k)).toBe(true);
      expect(isSoloTomPersona(k)).toBe(false);
    }
  });

  it("provides display labels for every persona", () => {
    for (const k of TOM_PERSONA_KINDS) {
      expect(tomPersonaLabel(k).length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// Stage 5 — WorkspaceScope inline duplicates are marked @deprecated
// =============================================================================

describe("Phase R12 — Stage 5: WorkspaceScope inline duplicates carry @deprecated", () => {
  const SITES = [
    "apps/web/components/workspace-admin/types.ts",
    "apps/web/components/command-center/types.ts",
    "services/api/src/services/workspace-admin/workspace-admin.service.ts",
    "services/api/src/services/dashboard/command-center.service.ts",
    "services/api/src/services/dashboard/persona-resolver.service.ts",
  ];

  for (const site of SITES) {
    it(`marks the inline WorkspaceScope in ${site} as @deprecated`, () => {
      const body = read(site);
      const block = body.match(
        /@deprecated[\s\S]{0,800}export type WorkspaceScope = "SINGLE_OCCUPANT" \| "SHARED"/,
      );
      expect(block).not.toBeNull();
    });
  }
});

// =============================================================================
// Stage 6 — dead PERSONAL_*/ORG_* capability keys carry @deprecated
// =============================================================================

describe("Phase R12 — Stage 6: dead PERSONAL_*/ORG_* keys carry @deprecated", () => {
  const DEAD_KEYS = [
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

  it("flags every dead key with @deprecated in the API CAPABILITY_KEYS array", () => {
    const body = read(
      "services/api/src/services/platform-context/types.ts",
    );
    for (const key of DEAD_KEYS) {
      const pattern = new RegExp(
        `@deprecated PHASE 3[\\s\\S]{0,400}"${key}"`,
      );
      expect(body, `missing @deprecated for ${key}`).toMatch(pattern);
    }
  });

  it("flags every dead key with @deprecated in the web CAPABILITY_KEYS array", () => {
    const body = read("apps/web/lib/platform-context/types.ts");
    for (const key of DEAD_KEYS) {
      const pattern = new RegExp(
        `@deprecated PHASE 3[\\s\\S]{0,400}"${key}"`,
      );
      expect(body, `missing @deprecated for ${key}`).toMatch(pattern);
    }
  });

  it("retains the grants in capability-registry.ts (no behaviour change)", () => {
    const body = read(
      "services/api/src/services/platform-context/capability-registry.ts",
    );
    // The grant arrays still contain every dead key.
    for (const key of DEAD_KEYS) {
      expect(body, `${key} no longer granted`).toContain(`"${key}"`);
    }
    // And the grant blocks carry the @deprecated marker so the
    // contract is discoverable from the grant site.
    expect(body).toMatch(/@deprecated PHASE 3/);
  });
});

// =============================================================================
// Stage 7 — backend canonical workspace helpers exist
// =============================================================================

// =============================================================================
// Stage 7 — the canonical workspace binding for collaboration surfaces
//
// WORKSPACE AND COLLABORATION ARCHITECTURE RECONCILIATION (2026-09-06) —
// `services/api/src/services/access/canonical-workspace-resolver.ts` was
// DELETED, and the three contracts below moved to the module that replaced it.
//
// The resolver read an `x-team-id` header the web client never sent and then
// FELL BACK to the caller's Personal Space, so every collaboration read and
// write operated on the caller's personal workspace no matter which workspace
// the product said they were in. An Organization owner saw "0 of 5 teams used"
// on a workspace holding a team with a thousand members. Its two production
// consumers were the two collaboration route files; when they moved to the
// canonical primitive it had none left, and the module-reachability gate
// required a disposition.
//
// The replacement is stricter in exactly the place the old one was loose:
// there is no fallback at all. A request that cannot prove which workspace it
// is operating in is a DENIAL, concealed as 404, rather than an invitation to
// pick a workspace on the caller's behalf. The Personal-First invariant is
// preserved where it belongs — a personal workspace is a perfectly good
// candidate when the caller's own pointer names it — but it is REVALIDATED
// like any other, never assumed.
// =============================================================================

describe("Phase R12 — Stage 7: the canonical workspace binding", () => {
  const path =
    "services/api/src/services/collaboration-team/collaboration-authorization.ts";

  it("the superseded resolver is gone, not merely bypassed", () => {
    expect(
      existsSync(
        join(apiSrc, "services", "access", "canonical-workspace-resolver.ts"),
      ),
    ).toBe(false);
    // And nothing imports it or its entry point any more.
    const routes = read(
      "services/api/src/routes/collaboration-teams.routes.ts",
    );
    expect(routes).not.toMatch(/canonical-workspace-resolver/);
    // The name survives only in the comment recording what was replaced and
    // why; no executable line calls it.
    const executable = routes
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(executable).not.toMatch(/resolveActiveOperationalWorkspace/);
  });

  it("resolves the operational workspace from the request, with NO personal fallback", () => {
    const body = read(path);
    expect(body).toMatch(/export async function authorizeCollaborationWorkspace/);
    // The workspace is NAMED by the request or by the caller's own pointer …
    expect(body).toMatch(/x-proovra-workspace-id/);
    expect(body).toMatch(/currentWorkspaceId/);
    // … and either way it is revalidated by the canonical primitive.
    expect(body).toMatch(/authorizeWorkspaceOrFail/);
    expect(body).toMatch(/authorizeCurrentWorkspaceOrFail/);
    // The regression this replaced: no silent substitution of a personal space.
    expect(body).toMatch(/NO personal fallback/i);
  });

  it("denials go through the canonical concealing path, not a local mapper", () => {
    const body = read(path);
    // A foreign team id and a nonexistent one are indistinguishable.
    expect(body).toMatch(/not_found/);
    expect(body).toMatch(/404/);
  });

  it("layers group authority ON TOP of workspace authority, never instead of it", () => {
    const body = read(path);
    const teamGate = body.indexOf("export async function authorizeCollaborationTeam");
    expect(teamGate).toBeGreaterThan(-1);
    const scoped = body.slice(teamGate);
    // Workspace first …
    const wsIdx = scoped.indexOf("authorizeCollaborationWorkspace(");
    // … then the group, bound to that same workspace.
    const bindIdx = scoped.indexOf("team.workspaceId !== workspace.workspaceId");
    const groupIdx = scoped.indexOf("collaborationTeamRoleHasPermission");
    expect(wsIdx).toBeGreaterThan(-1);
    expect(bindIdx).toBeGreaterThan(wsIdx);
    expect(groupIdx).toBeGreaterThan(wsIdx);
  });
});

// =============================================================================
// Sanity — shared package barrel exposes the new Phase 3 symbols
// =============================================================================

describe("Phase R12 — shared package barrel exposes Phase 3 symbols", () => {
  it("re-exports denial-vocabulary + canonical-persona from packages/shared", () => {
    const barrel = read("packages/shared/src/index.ts");
    expect(barrel).toContain("./architecture/denial-vocabulary.js");
    expect(barrel).toContain("./architecture/canonical-persona.js");
    expect(barrel).toContain("DENIAL_REASONS");
    expect(barrel).toContain("TOM_PERSONA_KINDS");
  });

  it("places the new modules under packages/shared/src/architecture/", () => {
    expect(
      existsSync(join(sharedSrc, "architecture", "denial-vocabulary.ts")),
    ).toBe(true);
    expect(
      existsSync(join(sharedSrc, "architecture", "canonical-persona.ts")),
    ).toBe(true);
  });
});

// =============================================================================
// Spot-checks — Phase 3 surface-level contracts referenced in the prompt
// =============================================================================

describe("Phase R12 — Phase 3 constitutional non-negotiables", () => {
  it("does NOT introduce a new workspace kind beyond PERSONAL / ORGANIZATION", () => {
    // The shared package still exports exactly the two target kinds.
    // (Imported indirectly: any extra kind would have to appear in
    // TARGET_WORKSPACE_KINDS — the R11 test already pins that array
    // length, so we just assert the canonical persona vocabulary did
    // not invent any new ones.)
    expect(TOM_PERSONA_KINDS).not.toContain("TEAM");
    expect(TOM_PERSONA_KINDS).not.toContain("REVIEWER");
    expect(TOM_PERSONA_KINDS).not.toContain("GOVERNANCE");
  });

  it("does NOT rename teamId globally — the column and the param keep their name", () => {
    // The deleted resolver used to carry this contract. It survives in the
    // binding that replaced it, and it is the sharper statement of the rule:
    // `Team.id` IS the workspace id, and `:teamId` on a collaboration route is
    // a CollaborationTeam id. Both names stay, and the binding says which is
    // which rather than renaming either.
    const body = read(
      "services/api/src/services/collaboration-team/collaboration-authorization.ts",
    );
    expect(body).toMatch(/teamId/);
    expect(body).toMatch(/COLLABORATION TEAM id/);
    // The canonical primitive still exposes the workspace id under its own
    // name, so a caller never has to guess which of the two it holds.
    const authorize = read("services/api/src/middleware/authorize.ts");
    expect(authorize).toMatch(/readonly workspaceId: string/);
  });

  it("does NOT mark Team as Organization-required (Personal-First invariant intact)", () => {
    // The canonical workspace kinds still include PERSONAL, and a personal
    // workspace is authorized by the same path as every other kind — it is a
    // candidate, revalidated, never a silent fallback.
    const authorize = read("services/api/src/middleware/authorize.ts");
    expect(authorize).toMatch(
      /CanonicalWorkspaceKind = "PERSONAL" \| "OWNED" \| "ORGANIZATION"/,
    );
    const body = read(
      "services/api/src/services/collaboration-team/collaboration-authorization.ts",
    );
    // Nothing here requires an organization to reach a collaboration team.
    expect(body).not.toMatch(/organizationId\s*!==?\s*null/);
    expect(body).not.toMatch(/requiresOrganization/);
  });
});

// Touch the imports the file owns so unused-symbol lints stay quiet
// when contributors run partial suites.
void apiSrc;
void webRoot;
