/**
 * H1 — SIU routes honour the restricted-case rule (2026-09-29).
 *
 * Every SIU route authorized any ACTIVE workspace member with
 * identity.member.read, ignoring the case's access list — including the export
 * that bundles each record's report and verification package. Over real HTTP:
 *   * a member OFF a restricted case's access list gets the same 404 as a
 *     missing case (no SIU surface, no export);
 *   * a member ON the list, and the owner, reach it;
 *   * an unrestricted case is unchanged for any member.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("SIU — restricted cases (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  async function caseFor(restrictedTo: string[] | null) {
    const { teamA } = h.fixtures;
    const c = await prisma.case.create({
      data: { name: `siu ${randomUUID().slice(0, 8)}`, teamId: teamA.teamId, ownerUserId: teamA.ownerUserId } as never,
      select: { id: true },
    });
    for (const userId of restrictedTo ?? []) {
      await prisma.caseAccess.create({ data: { caseId: c.id, userId } });
    }
    return c.id;
  }

  const preflight = (caseId: string, token: string) =>
    h.app.inject({
      method: "GET",
      url: `/v1/cases/${caseId}/siu-export/preflight`,
      headers: { authorization: `Bearer ${token}` },
    });
  const exportBundle = (caseId: string, token: string) =>
    h.app.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/siu-export`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

  it("a member off the access list gets 404 — for the preflight and for the export", async () => {
    const { teamA } = h.fixtures;
    const caseId = await caseFor([teamA.adminUserId]);
    for (const res of [await preflight(caseId, teamA.memberToken), await exportBundle(caseId, teamA.memberToken)]) {
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
  });

  it("a member on the list, and the owner, pass the case gate", async () => {
    const { teamA } = h.fixtures;
    const caseId = await caseFor([teamA.memberUserId]);
    for (const token of [teamA.memberToken, teamA.ownerToken]) {
      const res = await preflight(caseId, token);
      // Past the gate: the case exists for them (it has no SIU profile yet).
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().error.code).toBe("siu_profile_not_found");
    }
  });

  it("an unrestricted case is unchanged for any member", async () => {
    const { teamA } = h.fixtures;
    const caseId = await caseFor(null);
    const res = await preflight(caseId, teamA.memberToken);
    expect(res.json().error?.code).toBe("siu_profile_not_found");
  });
});
