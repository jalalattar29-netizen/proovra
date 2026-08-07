/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — reusable negative-conformance
 * harness.
 *
 * Every route/service migrated to the canonical primitive authorizes by
 * composing `evaluateMemberAccess → evaluateAccess → evaluateMember`. That
 * shared decision point is where status, lifecycle, capability, and
 * no-actor closure actually live. This harness proves — for a given
 * canonical `Permission` — that the shared evaluator DENIES across the full
 * negative matrix, so a domain test can assert "this domain is closed" in
 * one line:
 *
 *     import { assertNegativeAuthorizationConformance } from
 *       "./helpers/authorization-conformance.js";
 *
 *     describe("retention/destruction is authorization-closed", () => {
 *       assertNegativeAuthorizationConformance("governance.retention.manage");
 *     });
 *
 * What it proves (each an `it(...)` registered by the caller's `describe`):
 *   - no actor (non-member)            → deny `no_actor`
 *   - SUSPENDED membership             → deny `member_not_active`
 *   - REVOKED membership               → deny `member_not_active`
 *   - access grant expired             → deny `member_access_expired`
 *   - org SUSPENDED (non-personal ws)  → deny `organization_not_active`
 *   - org ARCHIVED   (non-personal ws) → deny `organization_not_active`
 *   - capability-blind (role lacks it, no grant) → deny `permission_not_granted`
 *     (asserted only when the minimal role does NOT already carry the
 *     permission — for baseline read permissions the role floor legitimately
 *     grants it and capability enforcement is not the gate)
 *   - positive control: ACTIVE member + matching capability grant → ALLOW
 *
 * No DB. Pure evaluation against `evaluateAccess`, which is exactly what the
 * migrated routes call under the hood. The anti-enumeration HTTP mapping
 * (membership-failure reasons → 404) is proven separately at the middleware
 * layer in `phase-26-authorize.test.ts`; every reason this harness asserts
 * on the deny path is in that middleware's membership-failure set.
 */

import { expect, it } from "vitest";
import {
  type Permission,
  mapTeamRoleToCanonical,
  roleHasPermission,
} from "@proovra/shared";

import {
  evaluateAccess,
  type ActorSnapshot,
  type MemberAccessSnapshot,
} from "../../src/services/identity/access-policy.service.js";
const PAST = new Date(Date.now() - 60_000);

type MemberOverrides = Partial<
  Pick<
    MemberAccessSnapshot,
    | "role"
    | "status"
    | "accessExpiresAtUtc"
    | "workspaceKind"
    | "organizationStatus"
    | "capabilityGrants"
    | "delegatedAdminScopes"
  >
>;

/**
 * Build a MEMBER actor snapshot. Defaults describe a valid operating
 * context: ACTIVE MEMBER in an ORGANIZATION workspace whose parent CUSTOMER
 * Organization is ACTIVE, no grants — so the org-lifecycle gate is LIVE and
 * a positive control passes. Each negative case flips exactly one dimension
 * so the gate under test is unambiguous.
 */
export function buildMemberActor(overrides: MemberOverrides = {}): ActorSnapshot {
  return {
    kind: "MEMBER",
    member: {
      teamMemberId: "11111111-1111-4111-8111-111111111111",
      teamId: "22222222-2222-4222-8222-222222222222",
      userId: "33333333-3333-4333-8333-333333333333",
      role: overrides.role ?? "MEMBER",
      status: overrides.status ?? "ACTIVE",
      accessExpiresAtUtc: overrides.accessExpiresAtUtc ?? null,
      workspaceKind: overrides.workspaceKind ?? "ORGANIZATION",
      organizationStatus:
        overrides.organizationStatus === undefined
          ? "ACTIVE"
          : overrides.organizationStatus,
      // PHASE 12 REMEDIATION (2026-08-06) — snapshot fixture keeps pace with
      // the additive `organizationId` identity field. Informational only: it
      // is never consulted by `evaluateAccess`, so every existing negative
      // conformance assertion is unchanged in meaning.
      organizationId: "44444444-4444-4444-8444-444444444444",
      capabilityGrants: overrides.capabilityGrants ?? [],
      delegatedAdminScopes: overrides.delegatedAdminScopes ?? [],
    },
  };
}

const activeGrant = (permission: Permission) => ({
  id: "grant-0000-0000-0000-000000000000",
  permission,
  expiresAtUtc: null,
  revokedAtUtc: null,
});

/**
 * Register the negative-conformance matrix for `permission` as `it(...)`
 * cases. Call INSIDE a `describe(...)`.
 *
 * @param permission the canonical permission the migrated domain requires.
 * @param opts.label optional prefix disambiguating multiple permissions in
 *        one describe block.
 */
export function assertNegativeAuthorizationConformance(
  permission: Permission,
  opts: { label?: string } = {},
): void {
  const p = opts.label ? `${opts.label}: ` : "";

  it(`${p}denies a non-member (no_actor) for ${permission}`, () => {
    const d = evaluateAccess(null, { permission });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("no_actor");
  });

  it(`${p}denies a SUSPENDED member (member_not_active) for ${permission}`, () => {
    // OWNER role so the ONLY reason to deny is status — proves the gate is
    // status-driven, not permission-driven.
    const d = evaluateAccess(buildMemberActor({ role: "OWNER", status: "SUSPENDED" }), {
      permission,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("member_not_active");
  });

  it(`${p}denies a REVOKED member (member_not_active) for ${permission}`, () => {
    const d = evaluateAccess(buildMemberActor({ role: "OWNER", status: "REVOKED" }), {
      permission,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("member_not_active");
  });

  it(`${p}denies an expired-access member (member_access_expired) for ${permission}`, () => {
    const d = evaluateAccess(
      buildMemberActor({ role: "OWNER", accessExpiresAtUtc: PAST }),
      { permission },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("member_access_expired");
  });

  it(`${p}denies an ORGANIZATION member in a SUSPENDED org (organization_not_active) for ${permission}`, () => {
    const d = evaluateAccess(
      buildMemberActor({
        role: "OWNER",
        workspaceKind: "ORGANIZATION",
        organizationStatus: "SUSPENDED",
      }),
      { permission },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("organization_not_active");
  });

  it(`${p}denies an ORGANIZATION member in an ARCHIVED org (organization_not_active) for ${permission}`, () => {
    const d = evaluateAccess(
      buildMemberActor({
        role: "OWNER",
        workspaceKind: "ORGANIZATION",
        organizationStatus: "ARCHIVED",
      }),
      { permission },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("organization_not_active");
  });

  it(`${p}denies an ORGANIZATION member when the org row/status is missing (organization_not_active) for ${permission}`, () => {
    // FAIL CLOSED: an ORGANIZATION workspace whose parent org did not load
    // (null status) must DENY — no "null means skip".
    const d = evaluateAccess(
      buildMemberActor({
        role: "OWNER",
        workspaceKind: "ORGANIZATION",
        organizationStatus: null,
      }),
      { permission },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("organization_not_active");
  });

  it(`${p}denies when the workspace kind cannot be proven (workspace_kind_unresolved) for ${permission}`, () => {
    const d = evaluateAccess(
      buildMemberActor({ role: "OWNER", workspaceKind: "UNKNOWN" }),
      { permission },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("workspace_kind_unresolved");
  });

  // Capability-blind closure: an ACTIVE member whose role does NOT carry the
  // permission and who holds NO grant must be denied. Only asserted when the
  // minimal role genuinely lacks the permission (baseline read permissions
  // are legitimately granted by the role floor).
  const viewerLacks = !roleHasPermission(
    mapTeamRoleToCanonical("VIEWER"),
    permission,
  );
  if (viewerLacks) {
    it(`${p}denies an ACTIVE member lacking the capability (permission_not_granted) for ${permission}`, () => {
      const d = evaluateAccess(
        buildMemberActor({ role: "VIEWER" }),
        { permission },
      );
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toBe("permission_not_granted");
    });
  }

  it(`${p}ALLOWS an ACTIVE member with a matching capability grant for ${permission}`, () => {
    // Positive control — proves the negatives above deny for the RIGHT
    // reason (the gate under test), not because the permission is
    // unreachable. VIEWER role + explicit grant isolates the grant path.
    const d = evaluateAccess(
      buildMemberActor({
        role: "VIEWER",
        capabilityGrants: [activeGrant(permission)],
      }),
      { permission },
    );
    expect(d.allowed).toBe(true);
  });
}
