/**
 * AUD-0010 — the evidence-creation throttle is sized by the plan governing the
 * request. It always read the caller's PERSONAL plan, so a member with a Free
 * personal plan capturing into a Team (or Enterprise) workspace was held to the
 * Free tier, 10 a minute. The limit stays per person; its size follows the
 * workspace the person actively belongs to and captures into.
 *
 * Real route and PostgreSQL; the rate limiter's local Redis.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("AUD-0010 evidence-creation throttle follows the governing plan (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 300_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const create = (token: string, teamId: string) => {
    const bytes = Buffer.from(`aud-0010 ${randomUUID()}`);
    return h.app.inject({
      method: "POST",
      url: "/v1/evidence",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "DOCUMENT",
        mimeType: "text/plain",
        originalFileName: "t.txt",
        checksumSha256Base64: createHash("sha256").update(bytes).digest("base64"),
        teamId,
      },
    });
  };

  it("a Free-plan member capturing into a Team workspace gets the Team tier, not the personal Free tier", async () => {
    const A = h.fixtures.teamA;
    // The admin's own (personal) plan is FREE; the workspace is on TEAM.
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await create(A.adminToken, A.teamId)).statusCode);
    expect(statuses, statuses.join(",")).toEqual(Array(12).fill(201));
  }, 120_000);
});
