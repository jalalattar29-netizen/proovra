/**
 * P2 DOMAIN REMEDIATION (2026-07-21) — invitation/membership coherence.
 *
 * The organization invitation is the canonical carrier of BOTH membership
 * layers: governance (OrganizationMembership, always) and operational
 * workspace access (TeamMember, ONLY for explicitly assigned workspaces).
 * These tests cover the canonical provisioning service and pin the atomic
 * accept-handler wiring.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SEAT AUTHORITY IS STUBBED HERE, AND THAT IS THE POINT OF THE STUB.
 *
 * `grantWorkspaceMembership` now consults `resolveWorkspaceSeatState` before
 * it seats anybody — it is the second of the two paths that create a workspace
 * member (the other is `acceptWorkspaceInvitation`, which has always claimed a
 * seat under an advisory lock) and it previously consulted no commercial
 * authority at all.
 *
 * That resolver reaches the whole commercial stack: plan resolution, the
 * enterprise contract and its status, the persisted seat count. These tests
 * are UNIT tests of the assignment rules — does the team belong to the org, is
 * it a personal space, what shape does the upsert take — driven by a
 * hand-rolled `fakeTx` proxy. Letting the real resolver run against that proxy
 * would not test seats; it would test how a Proxy behaves when the billing
 * layer asks it for a column, which is how a half-built double ends up
 * reaching a real socket.
 *
 * So the seat answer is stubbed to "room available" for the rules under test,
 * and the seat rule itself is asserted separately below with the stub told to
 * say the workspace is full.
 */
const seatState = vi.hoisted(() => ({
  current: {
    plan: "TEAM",
    used: 3,
    limit: 10,
    remaining: 7,
    featureIncluded: true,
    overLimit: false,
    source: "PLAN_CATALOG",
    contractLimits: {},
  },
}));
vi.mock("../src/services/billing/workspace-seats.service.js", () => ({
  resolveWorkspaceSeatState: async () => seatState.current,
}));

import {
  grantOrganizationMembership,
  grantWorkspaceMembership,
  parseWorkspaceAssignments,
} from "../src/services/identity/membership-provisioning.service.js";

const API_ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(API_ROOT, rel), "utf8");

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "44444444-4444-4444-8444-444444444444";

type Handler = (args: unknown) => unknown;
function fakeTx(handlers: Record<string, Handler>) {
  const calls: Array<{ op: string; args: unknown }> = [];
  const tx: unknown = new Proxy(
    {},
    {
      get(_t, model: string) {
        return new Proxy(
          {},
          {
            get(_t2, method: string) {
              return async (args: unknown) => {
                const op = `${model}.${String(method)}`;
                calls.push({ op, args });
                const h = handlers[op];
                if (h) return h(args);
                if (String(method).startsWith("find")) return null;
                return {};
              };
            },
          },
        );
      },
    },
  );
  return { tx: tx as never, calls };
}

describe("P2 — parseWorkspaceAssignments (fail-closed parsing)", () => {
  it("null/undefined → empty (governance-only invite)", () => {
    expect(parseWorkspaceAssignments(null)).toEqual({
      ok: true,
      assignments: [],
    });
    expect(parseWorkspaceAssignments(undefined)).toEqual({
      ok: true,
      assignments: [],
    });
  });

  it("valid list parses; duplicate teamIds dedupe first-wins", () => {
    const res = parseWorkspaceAssignments([
      { teamId: TEAM_ID, role: "MEMBER" },
      { teamId: TEAM_ID, role: "ADMIN" },
    ]);
    expect(res).toEqual({
      ok: true,
      assignments: [{ teamId: TEAM_ID, role: "MEMBER" }],
    });
  });

  it("rejects malformed roles, non-uuid teamIds, oversize lists, non-arrays", () => {
    expect(parseWorkspaceAssignments([{ teamId: TEAM_ID, role: "ROOT" }]).ok).toBe(false);
    expect(parseWorkspaceAssignments([{ teamId: "nope", role: "MEMBER" }]).ok).toBe(false);
    expect(parseWorkspaceAssignments("x").ok).toBe(false);
    expect(
      parseWorkspaceAssignments(
        Array.from({ length: 21 }, (_, i) => ({
          teamId: TEAM_ID.replace("1111", `${1000 + i}`),
          role: "MEMBER",
        })),
      ).ok,
    ).toBe(false);
  });
});

describe("P2 — grantOrganizationMembership (idempotent, never re-roles)", () => {
  it("creates when missing", async () => {
    const { tx, calls } = fakeTx({});
    const res = await grantOrganizationMembership(tx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      role: "ORG_MEMBER",
    });
    expect(res.created).toBe(true);
    expect(calls.some((c) => c.op === "organizationMembership.create")).toBe(true);
  });

  it("does NOT touch an existing membership (no silent role change)", async () => {
    const { tx, calls } = fakeTx({
      "organizationMembership.findFirst": () => ({ id: "m-1" }),
    });
    const res = await grantOrganizationMembership(tx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      role: "ORG_ADMIN",
    });
    expect(res.created).toBe(false);
    expect(calls.some((c) => c.op === "organizationMembership.create")).toBe(false);
    expect(calls.some((c) => c.op === "organizationMembership.update")).toBe(false);
  });
});

describe("P2 — grantWorkspaceMembership (explicit, validated, fail-closed)", () => {
  it("denies a team that does not belong to the organization", async () => {
    const { tx, calls } = fakeTx({
      "team.findUnique": () => ({
        organizationId: "99999999-9999-4999-8999-999999999999",
        isPersonal: false,
      }),
    });
    const res = await grantWorkspaceMembership(tx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      assignment: { teamId: TEAM_ID, role: "MEMBER" },
      accessReason: "test",
    });
    expect(res).toEqual({ ok: false, reason: "team_not_in_organization" });
    expect(calls.some((c) => c.op === "teamMember.upsert")).toBe(false);
  });

  it("denies personal spaces (never assignable via org invite)", async () => {
    const { tx } = fakeTx({
      "team.findUnique": () => ({ organizationId: ORG_ID, isPersonal: true }),
    });
    const res = await grantWorkspaceMembership(tx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      assignment: { teamId: TEAM_ID, role: "MEMBER" },
      accessReason: "test",
    });
    expect(res).toEqual({ ok: false, reason: "team_is_personal" });
  });

  it("upserts an ACTIVE membership; reactivation preserves the held role", async () => {
    const { tx, calls } = fakeTx({
      "team.findUnique": () => ({ organizationId: ORG_ID, isPersonal: false }),
    });
    const res = await grantWorkspaceMembership(tx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      assignment: { teamId: TEAM_ID, role: "VIEWER" },
      accessReason: "Organization invite inv-1",
    });
    expect(res).toEqual({ ok: true });
    const upsert = calls.find((c) => c.op === "teamMember.upsert");
    const args = upsert?.args as {
      update: { status: string; suspendedAtUtc: null };
      create: { role: string; status: string; accessReason: string };
    };
    expect(args.create.role).toBe("VIEWER");
    expect(args.create.status).toBe("ACTIVE");
    // Update path (existing row) re-activates WITHOUT touching role.
    expect(args.update.status).toBe("ACTIVE");
    expect("role" in args.update).toBe(false);
  });

  /**
   * THE SEAT GATE — the second path that seats a person now asks the same
   * authority the first one does.
   *
   * `acceptWorkspaceInvitation` claims a seat under an advisory lock and
   * refuses at capacity. This function — organization-invite acceptance, SSO
   * JIT and SCIM — consulted no commercial authority whatsoever, so an admin
   * could seat a hundred people into a ten-seat workspace by attaching
   * workspace assignments to invitations.
   */
  it("refuses when the workspace has no free seat", async () => {
    const previous = seatState.current;
    seatState.current = { ...previous, used: 10, limit: 10, remaining: 0 };
    try {
      const { tx, calls } = fakeTx({
        "team.findUnique": () => ({ organizationId: ORG_ID, isPersonal: false }),
      });
      const res = await grantWorkspaceMembership(tx, {
        organizationId: ORG_ID,
        userId: USER_ID,
        assignment: { teamId: TEAM_ID, role: "MEMBER" },
        accessReason: "test",
      });
      expect(res).toEqual({ ok: false, reason: "workspace_seat_limit_reached" });
      // Refused BEFORE the write, not rolled back after it.
      expect(calls.some((c) => c.op === "teamMember.upsert")).toBe(false);
    } finally {
      seatState.current = previous;
    }
  });

  /**
   * An ALREADY-ACTIVE member re-provisioning consumes no seat — `used` counts
   * ACTIVE members, so they are already in it. Refusing here would lock
   * existing members out of their own workspace the moment it filled up, on
   * every repeat SSO login and every idempotent replay.
   */
  it("does not refuse an already-active member when the workspace is full", async () => {
    const previous = seatState.current;
    seatState.current = { ...previous, used: 10, limit: 10, remaining: 0 };
    try {
      const { tx, calls } = fakeTx({
        "team.findUnique": () => ({ organizationId: ORG_ID, isPersonal: false }),
        "teamMember.findUnique": () => ({ status: "ACTIVE" }),
      });
      const res = await grantWorkspaceMembership(tx, {
        organizationId: ORG_ID,
        userId: USER_ID,
        assignment: { teamId: TEAM_ID, role: "MEMBER" },
        accessReason: "test",
      });
      expect(res).toEqual({ ok: true });
      expect(calls.some((c) => c.op === "teamMember.upsert")).toBe(true);
    } finally {
      seatState.current = previous;
    }
  });
});

describe("P2 — accept-handler + invite-create wiring (source contracts)", () => {
  const ROUTES = read("src/routes/organizations.routes.ts");

  it("accept runs through the canonical provisioning service in one transaction", () => {
    // PHASE 5 §8 (2026-07-22) — the accept transaction moved into the
    // canonical org-invite-acceptance.service (idempotent replay +
    // guarded concurrency claim). The provisioning-service wiring is
    // pinned THERE now; the route stays a thin adapter.
    const ACCEPTANCE = read(
      "src/services/organization/org-invite-acceptance.service.ts",
    );
    expect(ACCEPTANCE).toMatch(/grantOrganizationMembership\(tx,/);
    expect(ACCEPTANCE).toMatch(/grantWorkspaceMembership\(tx,/);
    expect(ACCEPTANCE).toMatch(/parseWorkspaceAssignments\(/);
    expect(ACCEPTANCE).toMatch(/acceptedByUserId: userId/);
    expect(ACCEPTANCE).toMatch(/assignedWorkspaceIds/);
    expect(ROUTES).toMatch(/acceptOrganizationInvite\(\{/);
  });

  it("invite creation validates assignments belong to the org (fail-closed 400)", () => {
    expect(ROUTES).toMatch(/invalid_workspace_assignment/);
    expect(ROUTES).toMatch(
      /organizationId: orgId, isPersonal: false/,
    );
  });

  it("schema + migration carry workspaceAssignments and acceptedByUserId", () => {
    const schema = read("prisma/schema.prisma");
    expect(schema).toMatch(/workspaceAssignments Json\?\s+@map\("workspace_assignments"\)/);
    expect(schema).toMatch(/acceptedByUserId String\?\s+@map\("accepted_by_user_id"\)/);
    const migration = read(
      "prisma/migrations/20270920100000_org_invite_workspace_assignments/migration.sql",
    );
    expect(migration).toMatch(/ADD COLUMN "workspace_assignments" JSONB/);
    expect(migration).toMatch(/ADD COLUMN "accepted_by_user_id" UUID/);
  });
});
