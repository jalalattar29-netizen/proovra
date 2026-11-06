/**
 * PRO-049 / EVIDENCE-04 — the legacy guest claim (live PostgreSQL).
 *
 * Two parallel claims of one guest's records both answered {claimed:1} and wrote
 * two EVIDENCE_CLAIMED custody events to different users, so the chain recorded
 * a transfer that did not happen. A malformed token answered 500.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("legacy guest claim (PRO-049)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let signJwt: typeof import("../src/services/jwt.js").signJwt;

  const claim = (token: string, guestToken: string) =>
    h.app.inject({
      method: "POST",
      url: "/v1/evidence/claim",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ guestToken }),
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  async function guestWithRecord() {
    const email = `guest-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const guest = await prisma.user.create({
      data: { email, provider: "GUEST", providerUserId: email } as never,
      select: { id: true },
    });
    const evidence = await prisma.evidence.create({
      data: { title: "guest draft", type: "PHOTO", status: "CREATED", ownerUserId: guest.id } as never,
      select: { id: true },
    });
    const token = signJwt(
      { sub: guest.id, provider: "GUEST", email, authAt: Math.floor(Date.now() / 1000) } as never,
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { guestId: guest.id, evidenceId: evidence.id, token };
  }

  it("two parallel claims move the record once and record one transfer", async () => {
    const { teamA } = h.fixtures;
    for (let round = 0; round < 5; round++) {
      const g = await guestWithRecord();
      const [a, b] = await Promise.all([claim(teamA.ownerToken, g.token), claim(teamA.memberToken, g.token)]);
      expect(a.statusCode, a.body).toBe(200);
      expect(b.statusCode, b.body).toBe(200);
      const counts = [a.json().claimed, b.json().claimed].sort();
      expect(counts, `round ${round}`).toEqual([0, 1]);
      const owner = (await prisma.evidence.findUniqueOrThrow({ where: { id: g.evidenceId }, select: { ownerUserId: true } })).ownerUserId;
      const events = await prisma.custodyEvent.findMany({
        where: { evidenceId: g.evidenceId, eventType: "EVIDENCE_CLAIMED" },
        select: { payload: true },
      });
      expect(events, `round ${round}`).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({ fromUserId: g.guestId, toUserId: owner });
      expect([teamA.ownerUserId, teamA.memberUserId]).toContain(owner);
    }
  });

  it("a malformed or forged guest token is 400 and moves nothing", async () => {
    const { teamA } = h.fixtures;
    const g = await guestWithRecord();
    for (const bad of ["not-a-jwt", `${g.token.slice(0, -4)}abcd`]) {
      const res = await claim(teamA.ownerToken, bad);
      expect(res.statusCode, res.body).toBe(400);
    }
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id: g.evidenceId }, select: { ownerUserId: true } });
    expect(row.ownerUserId).toBe(g.guestId);
    // Positive control: the genuine token claims it.
    const ok = await claim(teamA.ownerToken, g.token);
    expect(ok.json()).toEqual({ claimed: 1 });
  });
});
