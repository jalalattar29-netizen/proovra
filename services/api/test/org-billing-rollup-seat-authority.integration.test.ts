/**
 * SECOND RE-AUDIT ENT-05 / N-6 — the organization billing rollup and the seats
 * CSV answer from the ONE seat authority, against live PostgreSQL.
 *
 * Both endpoints used to count `_count.members` — every membership row of any
 * status, the OWNER, REVOKED and SUSPENDED included — against the contract or
 * the raw `Team.includedSeats` column. With a 4-seat Enterprise contract,
 * owner + 4 ACTIVE + 1 REVOKED + 1 SUSPENDED, and a stale legacy
 * `includedSeats: 2`, the legacy answer was "7 / 2 seats · over" while the Seats
 * card (`resolveWorkspaceSeatState`: owner excluded, ACTIVE only, bounded only
 * by an ACTIVE Enterprise contract) said 4 / 4, within limit.
 *
 * Proves, for GET /v1/orgs/:id/billing/rollup and GET /v1/orgs/:id/reports/seats.csv:
 *   1. the stale legacy state reads 4 / 4, within limit, on both;
 *   2. positive control: 5 ACTIVE members on 4 seats is over on both;
 *   3. a lapsed (SUSPENDED) contract: both say exactly what the authority says.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedOrganizationTenant,
  seedUser,
  type FixtureDeps,
} from "./point7/product-fixtures.js";

type RollupBody = {
  totalIncludedSeats: number;
  totalUsedSeats: number;
  overSeatWorkspaceCount: number;
  workspaces: Array<{
    id: string;
    includedSeats: number;
    seatLimit: number | null;
    usedSeats: number;
    overSeat: boolean;
  }>;
};

describe("ENT-05 / N-6 — org billing rollup + seats CSV use the seat authority (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let resolveWorkspaceSeatState: typeof import("../src/services/billing/workspace-seats.service.js")["resolveWorkspaceSeatState"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ resolveWorkspaceSeatState } = await import("../src/services/billing/workspace-seats.service.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `rollup-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          secret,
          60 * 60,
        ),
    };
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  /** Owner + `active` ACTIVE members + one REVOKED + one SUSPENDED, a contract of `seats`, stale legacy columns. */
  async function seedStaleWorkspace(active: number, seats: number, contractStatus: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
    const t = await seedOrganizationTenant(deps, { memberCount: active, contractStatus });
    await prisma.enterpriseContract.update({
      where: { organizationId: t.organizationId },
      data: { seatCount: seats },
    });
    for (const status of ["REVOKED", "SUSPENDED"] as const) {
      const u = await seedUser(deps, `rollup-${status.toLowerCase()}`);
      await prisma.teamMember.create({
        data: { teamId: t.workspaceId, userId: u.userId, role: "MEMBER", status },
      });
    }
    // What the legacy writer left behind: a raw column the old formula read.
    await prisma.team.update({
      where: { id: t.workspaceId },
      data: { includedSeats: 2, overSeatLimit: true },
    });
    // The rows the legacy formula counted: owner + active + revoked + suspended.
    expect(await prisma.teamMember.count({ where: { teamId: t.workspaceId } })).toBe(active + 3);
    return t;
  }

  async function rollup(orgId: string, token: string): Promise<RollupBody> {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/orgs/${orgId}/billing/rollup`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as RollupBody;
  }

  async function seatsCsv(orgId: string, token: string): Promise<Record<string, string>> {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/orgs/${orgId}/reports/seats.csv`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const lines = res.body.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    const header = lines[0]!.split(",");
    const cells = lines[1]!.split(",");
    return Object.fromEntries(header.map((h, i) => [h.replace(/"/g, ""), (cells[i] ?? "").replace(/"/g, "")]));
  }

  it("stale legacy state, owner + 4 ACTIVE (+ REVOKED + SUSPENDED) on a 4-seat contract: 4 / 4, within limit — rollup", async () => {
    const t = await seedStaleWorkspace(4, 4);
    const body = await rollup(t.organizationId, t.owner.token);
    const ws = body.workspaces.find((w) => w.id === t.workspaceId)!;
    expect(ws).toMatchObject({ usedSeats: 4, seatLimit: 4, includedSeats: 4, overSeat: false });
    expect(body).toMatchObject({ totalUsedSeats: 4, totalIncludedSeats: 4, overSeatWorkspaceCount: 0 });
  });

  it("the same stale state in the seats CSV: 4 / 4, not over", async () => {
    const t = await seedStaleWorkspace(4, 4);
    const row = await seatsCsv(t.organizationId, t.owner.token);
    expect(row).toMatchObject({ workspaceId: t.workspaceId, includedSeats: "4", usedSeats: "4", overSeat: "false" });
  });

  it("positive control: 5 ACTIVE members on a 4-seat contract is over — rollup and CSV", async () => {
    const t = await seedStaleWorkspace(5, 4);
    const body = await rollup(t.organizationId, t.owner.token);
    const ws = body.workspaces.find((w) => w.id === t.workspaceId)!;
    expect(ws).toMatchObject({ usedSeats: 5, seatLimit: 4, includedSeats: 4, overSeat: true });
    expect(body.overSeatWorkspaceCount).toBe(1);

    const row = await seatsCsv(t.organizationId, t.owner.token);
    expect(row).toMatchObject({ includedSeats: "4", usedSeats: "5", overSeat: "true" });
  });

  it("a SUSPENDED contract: the rollup and the CSV say exactly what the seat authority says", async () => {
    const t = await seedStaleWorkspace(4, 10, "SUSPENDED");
    const seats = await resolveWorkspaceSeatState(t.workspaceId, prisma as never);
    const body = await rollup(t.organizationId, t.owner.token);
    const ws = body.workspaces.find((w) => w.id === t.workspaceId)!;
    expect(ws).toMatchObject({ usedSeats: seats.used, seatLimit: seats.limit, overSeat: seats.overLimit });
    expect(seats.used).toBe(4);
    const row = await seatsCsv(t.organizationId, t.owner.token);
    expect(row).toMatchObject({ usedSeats: String(seats.used), overSeat: String(seats.overLimit) });
  });
});
