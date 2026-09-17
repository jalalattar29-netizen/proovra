/**
 * D63 — destruction request refusals are bounded, never a 500 or a leaked
 * internal message.
 *
 * `POST /v1/lifecycle/destruction/requests/:id/approve` let the service's bare
 * `Error("destruction_request_not_found")` reach the central handler: an
 * unknown id was a 500 and a critical operational page. `…/execute` did the
 * opposite: every error — including an infrastructure fault — became a 409
 * whose `denial` was the raw internal message.
 *
 * Proven through the real routes against a disposable PostgreSQL 16.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("D63 destruction request refusals (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  const post = (path: string) =>
    h.app.inject({
      method: "POST",
      url: path,
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}`, "content-type": "application/json" },
      payload: {},
    });

  async function seedRequest(teamId: string, state: string) {
    return (
      await prisma.destructionRequest.create({
        data: {
          teamId,
          state,
          evidenceIds: [],
          reason: "D63 fixture",
          requestedByUserId: h.fixtures.teamA.ownerUserId,
        },
        select: { id: true },
      })
    ).id;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { teamA } = h.fixtures;
    await prisma.user.update({ where: { id: teamA.ownerUserId }, data: { currentWorkspaceId: teamA.teamId } });
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamA.teamId }, select: { organizationId: true } });
    const { grantDelegatedAdmin } = await import("../src/services/governance/delegated-admin.service.js");
    for (const tier of ["ORG_ADMIN", "COMPLIANCE_OFFICER"] as const) {
      const res = await grantDelegatedAdmin({
        teamId: teamA.teamId,
        organizationId: team.organizationId,
        departmentId: null,
        workspaceId: null,
        granteeUserId: teamA.ownerUserId,
        tier,
        grantedByUserId: teamA.ownerUserId,
      });
      expect(res.ok, `granting ${tier}`).toBe(true);
    }
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const NOT_FOUND = { denial: "DESTRUCTION_REQUEST_NOT_FOUND" };

  it("approve and execute answer an unknown id with a bounded 404", async () => {
    const id = randomUUID();
    const approve = await post(`/v1/lifecycle/destruction/requests/${id}/approve`);
    expect(approve.statusCode, approve.body).toBe(404);
    expect(approve.json()).toEqual(NOT_FOUND);
    const execute = await post(`/v1/lifecycle/destruction/requests/${id}/execute`);
    expect(execute.statusCode, execute.body).toBe(404);
    expect(execute.json()).toEqual(NOT_FOUND);
  });

  it("another workspace's request reads exactly like a missing one, and is not touched", async () => {
    const foreign = await seedRequest(h.fixtures.teamB.teamId, "APPROVED");
    for (const action of ["approve", "execute"]) {
      const res = await post(`/v1/lifecycle/destruction/requests/${foreign}/${action}`);
      expect(res.statusCode, `${action}: ${res.body}`).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
    }
    const row = await prisma.destructionRequest.findUniqueOrThrow({ where: { id: foreign } });
    expect(row).toMatchObject({ state: "APPROVED", executedAtUtc: null });
  });

  it("executing a request that is not approved is a bounded 409 naming the state rule, and changes nothing", async () => {
    const id = await seedRequest(h.fixtures.teamA.teamId, "REQUESTED");
    const res = await post(`/v1/lifecycle/destruction/requests/${id}/execute`);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual({ denial: "DESTRUCTION_REQUEST_NOT_APPROVED" });
    expect(res.body).not.toContain("destruction_request_not_approved");
    const row = await prisma.destructionRequest.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ state: "REQUESTED", executedAtUtc: null });
  });
});
