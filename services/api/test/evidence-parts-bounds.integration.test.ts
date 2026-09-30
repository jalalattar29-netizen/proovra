/**
 * ET-ACQ-07 — a record's parts are bounded, and part presigning is rate
 * limited. Live PostgreSQL 16, real HTTP.
 *
 * On a40ca76f POST /v1/evidence/:id/parts accepted any non-negative partIndex
 * with no rate limit: the owner could create any number of part rows and
 * presigned upload URLs, and completion sealed whatever existed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const RATE_ENV = "EVIDENCE_PART_PRESIGN_RATE_LIMIT_PER_USER";

describe("evidence part bounds (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let clearRates: () => Promise<unknown>;
  const rateBefore = process.env[RATE_ENV];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 180_000);

  beforeEach(async () => {
    await clearRates();
  });
  afterEach(() => {
    if (rateBefore === undefined) delete process.env[RATE_ENV];
    else process.env[RATE_ENV] = rateBefore;
  });
  afterAll(async () => {
    await h?.cleanup();
  });

  const A = () => h.fixtures.teamA;
  const auth = () => ({ authorization: `Bearer ${A().ownerToken}` });

  async function newRecord(): Promise<string> {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/evidence",
      headers: auth(),
      payload: { type: "PHOTO", teamId: A().teamId, mimeType: "image/jpeg" },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }
  const part = (id: string, partIndex: number) =>
    h.app.inject({
      method: "POST",
      url: `/v1/evidence/${id}/parts`,
      headers: auth(),
      payload: { partIndex, mimeType: "image/jpeg" },
    });

  it("an index past the bound is refused 400 and creates no part; the last index inside it is accepted", async () => {
    const id = await newRecord();
    const over = await part(id, 200);
    expect(over.statusCode, over.body).toBe(400);
    expect(await prisma.evidencePart.count({ where: { evidenceId: id, partIndex: 200 } })).toBe(0);

    const last = await part(id, 199);
    expect([200, 201]).toContain(last.statusCode);
  });

  it("part presigning is rate limited per user (429, nothing created past the limit)", async () => {
    process.env[RATE_ENV] = "2";
    const id = await newRecord();
    expect([200, 201]).toContain((await part(id, 0)).statusCode);
    expect([200, 201]).toContain((await part(id, 1)).statusCode);
    const third = await part(id, 2);
    expect(third.statusCode, third.body).toBe(429);
    expect(await prisma.evidencePart.count({ where: { evidenceId: id } })).toBe(2);
  });
});
