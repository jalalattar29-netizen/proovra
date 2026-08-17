/**
 * PHASE 3 — MEMBERSHIP ORCHESTRATOR (2026-07-21).
 *
 * Part A — behavioral (mocked tx, real orchestrator):
 *   * role precedence: automated sources never mint owner-tier, never
 *     change a held role; trusted sources may;
 *   * source-aware revocation: multi-source memberships survive one-source
 *     revocation; single/legacy memberships are revoked;
 *   * SSO_JIT preserveExistingStatus: a login never reactivates SUSPENDED;
 *   * reactivation only from SUSPENDED (REVOKED requires explicit re-grant);
 *   * provenance rows written for grants (migration-window tolerant).
 *
 * Part B — machine-enforced writer registry: every FILE with a direct
 * membership write either composes the orchestrator or is a registered
 * residual with a pinned site count. A NEW direct write anywhere fails.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MEMBERSHIP_INTENTS,
  provisionMembership,
  resolveRolePrecedence,
} from "../src/services/identity/membership-provisioning.service.js";

// ---------------------------------------------------------------------------
// Minimal fake tx capturing writes.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
function makeTx(state: {
  teamMembers: Map<string, Row>; // key teamId:userId
  grants: Row[];
  orgMembers: Map<string, Row>; // key orgId:userId
  grantTableMissing?: boolean;
}) {
  let idSeq = 0;
  const nextId = () => `id-${++idSeq}`;
  return {
    teamMember: {
      findUnique: async ({ where }: { where: { teamId_userId?: { teamId: string; userId: string }; id?: string } }) => {
        if (where.teamId_userId) {
          return (
            state.teamMembers.get(
              `${where.teamId_userId.teamId}:${where.teamId_userId.userId}`,
            ) ?? null
          );
        }
        for (const row of state.teamMembers.values()) {
          if (row.id === where.id) return row;
        }
        return null;
      },
      upsert: async ({ where, update, create }: Record<string, never> & { where: { teamId_userId: { teamId: string; userId: string } }; update: Row; create: Row }) => {
        const key = `${where.teamId_userId.teamId}:${where.teamId_userId.userId}`;
        const existing = state.teamMembers.get(key);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { id: nextId(), ...create };
        state.teamMembers.set(key, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        for (const row of state.teamMembers.values()) {
          if (row.id === where.id) {
            Object.assign(row, data);
            return row;
          }
        }
        throw new Error("not found");
      },
    },
    organizationMembership: {
      findFirst: async ({ where }: { where: { organizationId: string; userId: string } }) =>
        state.orgMembers.get(`${where.organizationId}:${where.userId}`) ?? null,
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId(), ...data };
        state.orgMembers.set(`${data.organizationId}:${data.userId}`, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        for (const row of state.orgMembers.values()) {
          if (row.id === where.id) Object.assign(row, data);
        }
        return {};
      },
    },
    membershipGrant: {
      create: async ({ data }: { data: Row }) => {
        if (state.grantTableMissing) {
          throw Object.assign(new Error("table missing"), { code: "P2021" });
        }
        const row = { id: nextId(), revokedAtUtc: null, ...data };
        state.grants.push(row);
        return row;
      },
      findMany: async ({ where }: { where: { teamMemberId: string; revokedAtUtc: null } }) => {
        if (state.grantTableMissing) {
          throw Object.assign(new Error("table missing"), { code: "P2021" });
        }
        return state.grants.filter(
          (g) => g.teamMemberId === where.teamMemberId && g.revokedAtUtc === null,
        );
      },
      updateMany: async ({ where, data }: { where: { id?: { in: string[] } }; data: Row }) => {
        for (const g of state.grants) {
          if (where.id?.in.includes(g.id as string)) Object.assign(g, data);
        }
        return { count: 0 };
      },
    },
    team: {
      findUnique: async () => ({ organizationId: "org-1", isPersonal: false }),
    },
  } as never;
}

const fresh = () => ({
  teamMembers: new Map<string, Row>(),
  grants: [] as Row[],
  orgMembers: new Map<string, Row>(),
});

// ---------------------------------------------------------------------------
// Part A — behavior
// ---------------------------------------------------------------------------

describe("Phase 3 — role precedence (§6.3)", () => {
  it("automated sources never mint owner-tier on a NEW membership", () => {
    for (const source of ["INVITATION", "SCIM", "IDP_GROUP", "SSO_JIT"] as const) {
      expect(
        resolveRolePrecedence({ existingRole: null, incomingRole: "OWNER", source, ownerRoleName: "OWNER" }),
      ).toBe("MEMBER");
      expect(
        resolveRolePrecedence({ existingRole: null, incomingRole: "ORG_OWNER", source, ownerRoleName: "ORG_OWNER" }),
      ).toBe("ORG_MEMBER");
    }
  });

  it("automated sources never change a HELD role (no invite/SCIM demotion or escalation)", () => {
    for (const source of ["INVITATION", "SCIM", "IDP_GROUP", "SSO_JIT"] as const) {
      expect(
        resolveRolePrecedence({ existingRole: "ADMIN", incomingRole: "VIEWER", source, ownerRoleName: "OWNER" }),
      ).toBe("ADMIN");
      expect(
        resolveRolePrecedence({ existingRole: "VIEWER", incomingRole: "ADMIN", source, ownerRoleName: "OWNER" }),
      ).toBe("VIEWER");
    }
  });

  it("trusted sources (MANUAL / ENTERPRISE_BOOTSTRAP / SYSTEM_REPAIR) may change roles", () => {
    expect(
      resolveRolePrecedence({ existingRole: "MEMBER", incomingRole: "ADMIN", source: "MANUAL", ownerRoleName: "OWNER" }),
    ).toBe("ADMIN");
    expect(
      resolveRolePrecedence({ existingRole: null, incomingRole: "ORG_OWNER", source: "ENTERPRISE_BOOTSTRAP", ownerRoleName: "ORG_OWNER" }),
    ).toBe("ORG_OWNER");
  });
});

describe("Phase 3 — provisioning + provenance", () => {
  it("direct workspace grant creates the row + a provenance grant", async () => {
    const state = fresh();
    const tx = makeTx(state);
    const res = await provisionMembership(tx, {
      intent: "WORKSPACE_DIRECT_INVITE",
      source: "INVITATION",
      userId: "u1",
      workspace: { teamId: "t1", role: "MEMBER" },
    });
    expect(res.workspaceGrants).toBe(1);
    expect(state.teamMembers.get("t1:u1")).toMatchObject({ role: "MEMBER", status: "ACTIVE" });
    expect(state.grants).toHaveLength(1);
    expect(state.grants[0]).toMatchObject({ source: "INVITATION", intent: "WORKSPACE_DIRECT_INVITE" });
  });

  it("SSO_JIT preserveExistingStatus: a login NEVER reactivates a SUSPENDED member", async () => {
    const state = fresh();
    state.teamMembers.set("t1:u1", { id: "m1", role: "MEMBER", status: "SUSPENDED" });
    const tx = makeTx(state);
    await provisionMembership(tx, {
      intent: "SSO_JIT",
      source: "SSO_JIT",
      userId: "u1",
      workspace: { teamId: "t1", role: "MEMBER" },
      preserveExistingStatus: true,
    });
    expect(state.teamMembers.get("t1:u1")).toMatchObject({ status: "SUSPENDED" });
    // …but the JIT grant provenance IS recorded.
    expect(state.grants.some((g) => g.source === "SSO_JIT")).toBe(true);
  });

  it("migration-window: missing grant table (P2021) does not break provisioning", async () => {
    const state = { ...fresh(), grantTableMissing: true };
    const tx = makeTx(state);
    const res = await provisionMembership(tx, {
      intent: "SCIM_PROVISIONING",
      source: "SCIM",
      userId: "u2",
      workspace: { teamId: "t1", role: "MEMBER" },
    });
    expect(res.workspaceGrants).toBe(1);
    expect(state.teamMembers.get("t1:u2")).toBeTruthy();
  });
});

// PHASE 13 §4 (2026-08-17) — two describe blocks were REMOVED from here.
//
// They drove `revokeWorkspaceMembershipSource` and `reactivateWorkspaceMembership`
// against an in-memory fake tx. Both functions are gone: source-scoped
// revocation is a backlog contract with no product surface (recorded in
// docs/architecture/program-ledger.md), and per-member reactivation is
// `restoreMember` on `POST /v1/identity/members/:id/restore`, which is covered by
// the rbac suites. A test that exercises a function no caller reaches proves the
// function runs, not that the system does — and it was the only thing keeping
// these two writers looking alive.
//
// Part B below is UNCHANGED and is the assertion that still matters: it walks
// every TeamMember/OrganizationMembership write in the tree and requires each to
// be a registered orchestrator writer, so a removal here cannot smuggle a new
// unregistered membership writer in somewhere else.

describe("Phase 3 — membership intent vocabulary", () => {
  it("intent vocabulary is complete", () => {
    expect(MEMBERSHIP_INTENTS).toHaveLength(14);
  });
});

// ---------------------------------------------------------------------------
// Part B — machine-enforced writer registry
// ---------------------------------------------------------------------------

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const WRITE_RE =
  /(teamMember|organizationMembership)\.(create|update|updateMany|upsert|delete|deleteMany)\(/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f));
    else if (e.name.endsWith(".ts")) out.push(f);
  }
  return out;
}

/**
 * PHASE 3 COMPLETE (2026-07-22): residual direct production writers = 0.
 * The ONLY files allowed to touch membership rows directly are the two
 * documented system surfaces:
 *  - membership-provisioning.service.ts — the canonical orchestrator
 *    itself (every mutation primitive lives here);
 *  - rbac.service.ts — the MANUAL-intent lifecycle surface (validated
 *    state machine: suspend/revoke/restore/role-change with owner
 *    protection + transition validation; records provenance and closes
 *    grants via the orchestrator's helpers — a named member of the
 *    orchestrator family, not a competitor).
 * Everything else (organizations/teams routes, SCIM, groups,
 * reconciliation, closures) composes the orchestrator. Any new direct
 * write anywhere fails this test.
 */
const RESIDUAL_WRITERS: Record<string, number> = {
  "membership-provisioning.service.ts": 99,
  "rbac.service.ts": 5,
};

describe("Phase 3 — no unregistered direct membership writes", () => {
  it("every direct write site is orchestrated or registered (counts pinned)", () => {
    const offenders: string[] = [];
    for (const file of walk(API_SRC)) {
      const b = basename(file);
      const src = readFileSync(file, "utf8");
      const writes = src.match(WRITE_RE) ?? [];
      if (writes.length === 0) continue;
      const allowed = RESIDUAL_WRITERS[b] ?? 0;
      if (writes.length > allowed) {
        offenders.push(`${b}: ${writes.length} direct writes (allowed ${allowed})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("migrated identity writers compose the orchestrator", () => {
    for (const rel of [
      "src/services/access-control/sso.service.ts",
      "src/services/security/saml-user-mapping.service.ts",
      "src/services/access-control/scim.service.ts",
      "src/services/enterprise-provisioning.service.ts",
      "src/services/platform-context/workspace-bootstrap.service.ts",
      "src/routes/teams.routes.ts",
      "src/services/identity/rbac.service.ts",
    ]) {
      const src = readFileSync(join(API_SRC, "..", rel), "utf8");
      expect(src, rel).toContain("membership-provisioning.service.js");
    }
  });
});
