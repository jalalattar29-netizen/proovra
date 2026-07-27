/**
 * PHASE 1 — final closure pass: destructive Evidence access
 * (archive / unarchive / delete).
 *
 * Behavioral proof (mocked prisma, real canonical engine) that
 * `resolveEvidenceDestructiveAccess`:
 *   1. Personal-scope evidence (teamId null): owner allowed, non-owner denied.
 *   2. Workspace evidence: an ACTIVE ORGANIZATION member holding the
 *      capability is allowed even when NOT the creator.
 *   3. A SUSPENDED / REVOKED former creator is denied — creator identity
 *      grants nothing for workspace evidence.
 *   4. An ACTIVE member WITHOUT the capability (VIEWER) is denied.
 *   5. A denial performs NO mutation (reads only — no update/delete/enqueue).
 *   6. Anti-enumeration: truly-missing evidence, existing cross-tenant
 *      evidence, and inactive membership produce IDENTICAL public
 *      projections (404 + stable `not_found` code) — paired equality test.
 *
 * Plus source contracts pinning that the three routes compose the service
 * and reply with the shared PUBLIC_NOT_FOUND_BODY (never the internal
 * reason).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_ADMIN = "22222222-2222-4222-8222-222222222222";
const OUTSIDER = "33333333-3333-4333-8333-333333333333";
const TEAM_ORG = "44444444-4444-4444-8444-444444444444";
const EV_PERSONAL = "55555555-5555-4555-8555-555555555555";
const EV_TEAM = "66666666-6666-4666-8666-666666666666";

const H = vi.hoisted(() => ({
  // evidenceId -> row (minimal persisted binding)
  evidence: new Map<string, { id: string; teamId: string | null; ownerUserId: string }>(),
  // `${teamId}:${userId}` -> { role, status }
  members: new Map<string, { role: string; status: string }>(),
  mutations: 0, // any update/updateMany/delete/deleteMany/create on evidence
}));

vi.mock("../src/db.js", () => {
  const countMutation = async () => {
    H.mutations += 1;
    return {};
  };
  return {
    prisma: {
      evidence: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          H.evidence.get(where.id) ?? null,
        update: countMutation,
        updateMany: countMutation,
        delete: countMutation,
        deleteMany: countMutation,
      },
      teamMember: {
        findUnique: async ({
          where,
        }: {
          where: { teamId_userId: { teamId: string; userId: string } };
        }) => {
          const m = H.members.get(
            `${where.teamId_userId.teamId}:${where.teamId_userId.userId}`,
          );
          if (!m) return null;
          return {
            id: "tm-1",
            teamId: where.teamId_userId.teamId,
            userId: where.teamId_userId.userId,
            role: m.role,
            status: m.status,
            accessExpiresAtUtc: null,
            team: {
              isPersonal: false,
              workspaceKind: "ORGANIZATION",
              billingPlan: "ENTERPRISE",
              organization: { status: "ACTIVE" },
            },
            capabilityGrants: [],
            delegatedAdminScopes: [],
          };
        },
      },
      securityEvent: { create: async () => ({ id: "se-1" }) },
    },
  };
});

import {
  PUBLIC_NOT_FOUND_BODY,
  resolveEvidenceDestructiveAccess,
} from "../src/services/evidence/evidence-destructive-access.service.js";

/** The exact public projection the routes send for EVERY denial. */
function publicProjection(result: { allowed: boolean }) {
  return result.allowed
    ? { status: 200 }
    : { status: 404, body: PUBLIC_NOT_FOUND_BODY };
}

beforeEach(() => {
  H.evidence.clear();
  H.members.clear();
  H.mutations = 0;
  H.evidence.set(EV_PERSONAL, {
    id: EV_PERSONAL,
    teamId: null,
    ownerUserId: OWNER,
  });
  H.evidence.set(EV_TEAM, { id: EV_TEAM, teamId: TEAM_ORG, ownerUserId: OWNER });
});

describe("destructive evidence access — decision matrix", () => {
  it("1: personal-scope evidence — owner allowed; non-owner denied", async () => {
    const owner = await resolveEvidenceDestructiveAccess({
      userId: OWNER,
      evidenceId: EV_PERSONAL,
      permission: "evidence.delete",
    });
    expect(owner.allowed).toBe(true);

    const nonOwner = await resolveEvidenceDestructiveAccess({
      userId: OUTSIDER,
      evidenceId: EV_PERSONAL,
      permission: "evidence.delete",
    });
    expect(nonOwner.allowed).toBe(false);
  });

  it("2: ACTIVE ORGANIZATION member with the capability is allowed (not the creator)", async () => {
    H.members.set(`${TEAM_ORG}:${OTHER_ADMIN}`, {
      role: "ADMIN",
      status: "ACTIVE",
    });
    for (const permission of ["evidence.archive", "evidence.delete"] as const) {
      const d = await resolveEvidenceDestructiveAccess({
        userId: OTHER_ADMIN,
        evidenceId: EV_TEAM,
        permission,
      });
      expect(d.allowed).toBe(true);
    }
  });

  it("3: SUSPENDED / REVOKED former creator is denied on workspace evidence", async () => {
    for (const status of ["SUSPENDED", "REVOKED"] as const) {
      H.members.set(`${TEAM_ORG}:${OWNER}`, { role: "OWNER", status });
      const d = await resolveEvidenceDestructiveAccess({
        userId: OWNER, // IS the creator (ownerUserId) — must not matter
        evidenceId: EV_TEAM,
        permission: "evidence.delete",
      });
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.internalReason).toBe("member_not_active");
    }
  });

  it("4: ACTIVE member WITHOUT the capability (VIEWER) is denied", async () => {
    H.members.set(`${TEAM_ORG}:${OUTSIDER}`, {
      role: "VIEWER",
      status: "ACTIVE",
    });
    const d = await resolveEvidenceDestructiveAccess({
      userId: OUTSIDER,
      evidenceId: EV_TEAM,
      permission: "evidence.delete",
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.internalReason).toBe("permission_not_granted");
  });

  it("5: denial performs NO evidence mutation (reads only)", async () => {
    H.members.set(`${TEAM_ORG}:${OWNER}`, { role: "OWNER", status: "REVOKED" });
    const d = await resolveEvidenceDestructiveAccess({
      userId: OWNER,
      evidenceId: EV_TEAM,
      permission: "evidence.delete",
    });
    expect(d.allowed).toBe(false);
    expect(H.mutations).toBe(0);
  });
});

describe("destructive evidence access — paired anti-enumeration", () => {
  it("6: missing record == cross-tenant record == inactive membership (status, body, code)", async () => {
    // (a) Truly missing evidence.
    const missing = await resolveEvidenceDestructiveAccess({
      userId: OUTSIDER,
      evidenceId: "99999999-9999-4999-8999-999999999999",
      permission: "evidence.delete",
    });
    // (b) EXISTING evidence in a workspace the caller has NO membership in.
    const crossTenant = await resolveEvidenceDestructiveAccess({
      userId: OUTSIDER,
      evidenceId: EV_TEAM,
      permission: "evidence.delete",
    });
    // (c) EXISTING evidence, membership present but SUSPENDED.
    H.members.set(`${TEAM_ORG}:${OUTSIDER}`, {
      role: "ADMIN",
      status: "SUSPENDED",
    });
    const inactive = await resolveEvidenceDestructiveAccess({
      userId: OUTSIDER,
      evidenceId: EV_TEAM,
      permission: "evidence.delete",
    });

    const a = publicProjection(missing);
    const b = publicProjection(crossTenant);
    const c = publicProjection(inactive);
    // Identical externally observable response: status, body, stable code.
    expect(a).toEqual({ status: 404, body: { error: { code: "not_found" } } });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // Internal reasons DIFFER (they stay internal) — proving the public
    // equality is a projection, not an accident of a single reason.
    expect((missing as { internalReason?: string }).internalReason).toBe(
      "evidence_not_found",
    );
    expect((crossTenant as { internalReason?: string }).internalReason).toBe(
      "no_actor",
    );
    expect((inactive as { internalReason?: string }).internalReason).toBe(
      "member_not_active",
    );
  });
});

describe("evidence.routes — archive/unarchive/delete compose the canonical gate", () => {
  const SRC = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
      "routes",
      "evidence.routes.ts",
    ),
    "utf8",
  );
  const routeBlock = (marker: string | RegExp) => {
    const idx =
      typeof marker === "string"
        ? SRC.indexOf(marker)
        : SRC.search(marker);
    expect(idx).toBeGreaterThan(-1);
    return SRC.slice(idx, idx + 2600);
  };

  for (const [marker, permission] of [
    ['"/v1/evidence/:id/archive"', "evidence.archive"],
    ['"/v1/evidence/:id/unarchive"', "evidence.archive"],
    [/app\.delete\(\s*"\/v1\/evidence\/:id"/, "evidence.delete"],
  ] as const) {
    it(`${marker} → resolveEvidenceDestructiveAccess(${permission}) + PUBLIC_NOT_FOUND_BODY`, () => {
      const block = routeBlock(marker);
      expect(block).toContain("resolveEvidenceDestructiveAccess");
      expect(block).toContain(`permission: "${permission}"`);
      expect(block).toContain("PUBLIC_NOT_FOUND_BODY");
      // Owner-identity gate must NOT be the authorization on these routes.
      expect(block).not.toContain("getEvidenceWithOwnerAccess");
      // The internal reason is logged, never sent.
      expect(block).not.toMatch(/send\([^)]*internalReason/);
    });
  }
});
