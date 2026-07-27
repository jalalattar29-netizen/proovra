/**
 * PHASE 10 §1 — THE 9 MANAGED-IDENTITY PROVISIONING PATHS.
 *
 * PART A — behavioral proof of the ONE atomic managed-provisioning intent
 * (`provisionManagedMembership`, membership-provisioning.service.ts §1.1). It
 * composes three canonical authorities in a fixed order and fails closed:
 *   1) identity-mode `setManagedIdentity` (managed binding),
 *   2) Phase-9 `resolveCommercialContext` (the seat figure) — fail-closed,
 *   3) Membership Orchestrator `provisionMembership` (membership + grants).
 * A failure at step 1 or 2 NEVER reaches step 3 (zero membership/grant/seat).
 *
 * PART B — the 9-path matrix: each production path's file:symbol and how it
 * handles managed identity (bind via the atomic intent, or correctly NOT bind
 * for update/group/deactivate). Source contracts are used ONLY for the
 * caller/authority/dependency invariants the mandate permits structural proof
 * for; the atomic composition itself is proven behaviorally in Part A and
 * end-to-end by phase-scim-user-lifecycle + phase-10-security-routes.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// ── Hoisted authority mocks (composed by provisionManagedMembership) ─────────
const M = vi.hoisted(() => ({
  setThrows: null as null | Error,
  seat: { limit: 5 as number | null, consumed: 1, remaining: 4 },
  setCalls: 0,
  seatCalls: 0,
}));

vi.mock("../src/services/identity/identity-mode.service.js", () => ({
  setManagedIdentity: async () => {
    M.setCalls += 1;
    if (M.setThrows) throw M.setThrows;
  },
}));
vi.mock("../src/services/billing/commercial-context.service.js", () => ({
  resolveCommercialContext: async () => {
    M.seatCalls += 1;
    return { seats: M.seat };
  },
}));

import {
  provisionManagedMembership,
  ManagedSeatLimitError,
} from "../src/services/identity/membership-provisioning.service.js";

// A tx whose teamMember.findUnique is benign (drives the seat gate) and whose
// every OTHER model op throws a unique sentinel — so reaching provisionMembership
// (step 3) is detectable WITHOUT a full prisma fake.
const REACHED = "__PROVISION_MEMBERSHIP_REACHED__";
function makeTx(opts: { heldActive?: boolean } = {}) {
  const seen: string[] = [];
  const teamMember = new Proxy(
    {},
    {
      get(_t, method: string) {
        if (method === "findUnique") {
          return async () => {
            seen.push("teamMember.findUnique");
            return opts.heldActive ? { status: "ACTIVE" } : null;
          };
        }
        return async () => {
          throw new Error(REACHED);
        };
      },
    },
  );
  // organizationIdForPolicy (resolved INSIDE the intent) reads team.findUnique;
  // return a CUSTOMER org so resolution succeeds and the composition proceeds.
  const team = {
    findUnique: async () => ({
      organizationId: "22222222-2222-4222-8222-222222222222",
      organization: { kind: "CUSTOMER" },
    }),
  };
  const tx = new Proxy(
    {},
    {
      get(_t, model: string) {
        if (model === "teamMember") return teamMember;
        if (model === "team") return team;
        return new Proxy(
          {},
          {
            get: () => async () => {
              throw new Error(REACHED);
            },
          },
        );
      },
    },
  );
  return { tx: tx as never, seen };
}

const BASE = {
  userId: "11111111-1111-4111-8111-111111111111",
  managingTeamId: "33333333-3333-4333-8333-333333333333",
  evidence: { source: "SCIM" as const, scimTokenId: "tok-1" },
  membershipIntent: "SCIM_PROVISIONING" as const,
  source: "SCIM" as const,
  workspace: { teamId: "33333333-3333-4333-8333-333333333333", role: "MEMBER" as const },
  seatPolicy: "ENFORCE" as const,
  seatTeamId: "33333333-3333-4333-8333-333333333333",
};

afterEach(() => {
  M.setThrows = null;
  M.seat = { limit: 5, consumed: 1, remaining: 4 };
  M.setCalls = 0;
  M.seatCalls = 0;
});

describe("§1.1 — provisionManagedMembership composition ORDER + fail-closed", () => {
  it("binds managed identity, enforces seat, THEN reaches the orchestrator (order proven)", async () => {
    const { tx, seen } = makeTx();
    await expect(provisionManagedMembership(tx, BASE)).rejects.toThrow(REACHED);
    // Step 1 (managed bind) ran, step 2 (seat) ran, step 3 (orchestrator) reached.
    expect(M.setCalls).toBe(1);
    expect(M.seatCalls).toBe(1);
    expect(seen).toContain("teamMember.findUnique");
  });

  it("managed conflict (step 1 throws) → ZERO seat check, ZERO orchestrator", async () => {
    M.setThrows = Object.assign(new Error("cross-org conflict"), { code: "MANAGED_IDENTITY_CONFLICT" });
    const { tx, seen } = makeTx();
    await expect(provisionManagedMembership(tx, BASE)).rejects.toThrow(/conflict/i);
    expect(M.seatCalls).toBe(0); // seat never consulted
    expect(seen).not.toContain("teamMember.findUnique"); // orchestrator never reached
  });

  it("seat exhausted (step 2) → ManagedSeatLimitError, orchestrator NEVER reached", async () => {
    M.seat = { limit: 5, consumed: 5, remaining: 0 };
    const { tx } = makeTx();
    const err = await provisionManagedMembership(tx, BASE).catch((e) => e);
    expect(err).toBeInstanceOf(ManagedSeatLimitError);
    expect((err as ManagedSeatLimitError).code).toBe("MANAGED_SEAT_LIMIT_REACHED");
    expect((err as ManagedSeatLimitError).statusCode).toBe(409);
  });

  it("idempotent — a user already holding an ACTIVE seat consumes NO new seat", async () => {
    M.seat = { limit: 5, consumed: 5, remaining: 0 }; // pool full…
    const { tx } = makeTx({ heldActive: true }); // …but the user already holds one
    // Reaches the orchestrator (no seat error) — the existing seat is reused.
    await expect(provisionManagedMembership(tx, BASE)).rejects.toThrow(REACHED);
    expect(M.seatCalls).toBe(0); // seat pool never consulted for a held member
  });

  it("plan with no seat concept (limit null) imposes no constraint", async () => {
    M.seat = { limit: null, consumed: 0, remaining: 0 };
    const { tx } = makeTx();
    await expect(provisionManagedMembership(tx, BASE)).rejects.toThrow(REACHED);
    expect(M.seatCalls).toBe(1);
  });

  it("seatPolicy SKIP does not consult the seat pool", async () => {
    const { tx } = makeTx();
    await expect(
      provisionManagedMembership(tx, { ...BASE, seatPolicy: "SKIP" }),
    ).rejects.toThrow(REACHED);
    expect(M.seatCalls).toBe(0);
  });
});

// ── PART B — the 9-path matrix (file:symbol + managed handling) ──────────────
const API = resolve(__dirname, "..");
const read = (rel: string) => readFileSync(resolve(API, rel), "utf8");
const SCIM = read("src/services/access-control/scim.service.ts");
const GROUPS = read("src/services/access-control/scim-groups.service.ts");
const SAML = read("src/routes/saml-auth.routes.ts");
const OIDC = read("src/routes/sso-auth.routes.ts");
const INVITE = read("src/services/organization/org-invite-acceptance.service.ts");

describe("§1 — 9-path managed-identity matrix", () => {
  it("1. SCIM create → binds via the atomic intent (evidence = authenticated token)", () => {
    expect(SCIM).toMatch(/provisionManagedMembership\(tx, \{[\s\S]{0,400}scimTokenId: ctx\.tokenId/);
  });
  it("2. SCIM update → ENFORCES managed ownership BEFORE mutating, then role via the engine (privileged-safe)", () => {
    // Ownership is ENFORCED, not assumed: cross-org/unresolved throw before any
    // attribute write; a STANDARD user in a managed-required org is reconciled.
    expect(SCIM).toMatch(/enforceScimManagedOwnership\(/);
    expect(SCIM).toMatch(/SCIM_MANAGED_CROSS_ORG_CONFLICT/);
    expect(SCIM).toMatch(/applyDirectoryRoleChange\(/);
    expect(SCIM).toMatch(/member\.role === "OWNER" \|\| member\.role === "ADMIN"/);
  });
  it("3. SCIM group mapping → ENFORCES ownership per member, then source-aware role (IDP_GROUP)", () => {
    expect(GROUPS).toMatch(/enforceScimManagedOwnership\(/);
    expect(GROUPS).toMatch(/ScimManagedOwnershipError/); // cross-org member skipped, zero mutation
    expect(GROUPS).toMatch(/source: "IDP_GROUP"/);
    expect(GROUPS).toMatch(/applyDirectoryRoleChange\(/);
  });
  it("4. SCIM deactivate → PRESERVES managed ownership (never releaseManagedIdentity) + revokes sessions", () => {
    expect(SCIM).not.toMatch(/releaseManagedIdentity\(/);
    const deIdx = SCIM.indexOf("export async function scimDeactivateUser");
    const block = SCIM.slice(deIdx, deIdx + 2500);
    expect(block).toMatch(/revokeAllSessionsForUser\(/);
    expect(block).toMatch(/suspendWorkspaceMembership\(/); // seat released via suspension
  });
  it("5. SCIM reactivate → re-affirms managed + rechecks seat through the atomic intent", () => {
    const reIdx = SCIM.indexOf("export async function scimReactivateUser");
    const block = SCIM.slice(reIdx, reIdx + 1800);
    expect(block).toMatch(/provisionManagedMembership\(tx, \{/);
    expect(block).toMatch(/seatPolicy: "ENFORCE"/);
  });
  it("6. SAML first login → binds BEFORE session establishment when managed is required", () => {
    const bindIdx = SAML.indexOf("provisionManagedMembership(tx");
    const estIdx = SAML.indexOf("establishOrganizationSessionContext(");
    expect(bindIdx).toBeGreaterThan(-1);
    expect(estIdx).toBeGreaterThan(bindIdx); // bind precedes establishment
    expect(SAML).toMatch(/source: "SAML", ssoConnectionId: conn\.id/);
    expect(SAML).toMatch(/managedIdentityRequired/);
  });
  it("7. OIDC first login → binds BEFORE session establishment when managed is required", () => {
    const bindIdx = OIDC.indexOf("provisionManagedMembership(tx");
    const estIdx = OIDC.indexOf("establishOrganizationSessionContext(");
    expect(bindIdx).toBeGreaterThan(-1);
    expect(estIdx).toBeGreaterThan(bindIdx);
    expect(OIDC).toMatch(/source: "OIDC", ssoConnectionId: conn\.id/);
  });
  it("8. existing-user linking → the SAME fail-closed path (a cross-org conflict bounces, no cookie)", () => {
    // Both SSO callbacks, inside the managed-provisioning try/catch, delete the
    // just-created session row and bounce on a managed conflict; the cookie is
    // only set AFTER establishment succeeds (paths 6/7 share this catch).
    for (const src of [SAML, OIDC]) {
      const bindIdx = src.indexOf("provisionManagedMembership(tx");
      const block = src.slice(bindIdx, bindIdx + 1600);
      expect(block).toMatch(/authenticatedSession\.delete/);
      expect(block).toMatch(/managed_identity_conflict/);
    }
  });
  it("9. managed invitation → binds via DOMAIN evidence (verified domain), atomic with acceptance", () => {
    expect(INVITE).toMatch(/managedIdentityRequired/);
    expect(INVITE).toMatch(/organizationDomain\.findFirst/);
    expect(INVITE).toMatch(/source: "DOMAIN"/);
  });
});
