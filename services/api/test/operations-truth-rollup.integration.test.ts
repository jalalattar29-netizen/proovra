// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * OPERATIONS TRUTH CLOSURE — OPS-034, the Enterprise roll-up (live PostgreSQL).
 *
 * The roll-up is the union of each workspace's OWN Operations summary over the
 * organisation's workspaces the caller may read: its totals equal the sum of
 * `/v1/ops/summary` for those workspaces, a workspace the caller cannot read
 * is counted and never named, and a non-member of the organisation is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, bootOps, makeUser, makeWorkspace, seedIncident, type Ctx } from "./operations-truth-fixtures.js";

describe("Operations truth closure — Enterprise roll-up (live PostgreSQL 16)", () => {
  let c: Ctx;
  beforeAll(async () => {
    c = await bootOps();
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  it("OPS-034 totals are the union of the readable workspaces' own summaries; others are counted, not named", async () => {
    const owner = await makeUser(c, "rollup-owner");
    const other = await makeUser(c, "rollup-other");
    const w1 = await makeWorkspace(c, owner.id, { name: "rollup-one", billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
    const w2 = await makeWorkspace(c, owner.id, { name: "rollup-two", orgId: w1.orgId, billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
    // A third workspace in the SAME organisation the owner is not a member of.
    const w3 = await makeWorkspace(c, other.id, { name: "rollup-three", orgId: w1.orgId, billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
    await c.prisma.organizationMembership.create({ data: { organizationId: w1.orgId, userId: other.id, role: "ORG_MEMBER" } }).catch(() => null);
    for (const [teamId, n] of [[w1.teamId, 2], [w2.teamId, 1], [w3.teamId, 5]] as const) {
      for (let i = 0; i < n; i++) await seedIncident(c, teamId, { sourceId: "governance.policy_condition", severity: i === 0 ? "CRITICAL" : "HIGH" });
    }

    const res = await c.inj("GET", `/v1/orgs/${w1.orgId}/operations/rollup`, owner.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.coverage).toMatchObject({ workspacesInOrganization: 3, workspacesIncluded: 2, workspacesNotReadable: 1, complete: false });
    expect(body.workspaces.map((w: { workspaceId: string }) => w.workspaceId).sort()).toEqual([w1.teamId, w2.teamId].sort());
    expect(JSON.stringify(body)).not.toContain(w3.teamId);
    expect(JSON.stringify(body)).not.toContain("rollup-three");

    // Conservation: the totals are exactly the per-workspace summaries summed.
    let open = 0;
    let critical = 0;
    for (const teamId of [w1.teamId, w2.teamId]) {
      const s = (await c.inj("GET", `/v1/ops/summary?teamId=${teamId}`, owner.token)).json().summary;
      open += s.open;
      critical += s.critical;
    }
    expect(body.totals.open).toBe(open);
    expect(body.totals.critical).toBe(critical);
    expect(open).toBe(3);
  });

  it("OPS-034 a person outside the organisation is refused", async () => {
    const owner = await makeUser(c, "rollup-owner-2");
    const stranger = await makeUser(c, "rollup-stranger");
    const w = await makeWorkspace(c, owner.id, { name: "rollup-private", billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
    await addMember(c, w.teamId, owner.id, "OWNER").catch(() => null);
    const res = await c.inj("GET", `/v1/orgs/${w.orgId}/operations/rollup`, stranger.token);
    expect([403, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain(w.teamId);
  });
});
