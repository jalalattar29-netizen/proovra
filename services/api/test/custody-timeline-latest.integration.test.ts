/**
 * ET-CUS-13 — a long custody chain is displayed as its LATEST events, and
 * every count is over the WHOLE chain. Live PostgreSQL 16, the real
 * review-workspace route.
 *
 * On a40ca76f the handler read the chain `take: 500`, oldest first: a record
 * with 512 events showed events 1..500, never the latest ones (here a legal
 * hold placed last), and counted 499 access events where 510 were recorded.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("custody timeline shows the latest events of a long chain (live PostgreSQL 16)", () => {
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

  it("512 events: the latest are shown, counts cover all, the slice is declared", async () => {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const { id } = await prisma.evidence.create({
      data: {
        title: `timeline ${randomUUID().slice(0, 6)}`,
        type: "PHOTO",
        status: "SIGNED",
        teamId: A.teamId,
        organizationId: team.organizationId,
        ownerUserId: A.ownerUserId,
      } as never,
      select: { id: true },
    });
    const { appendCustodyEvent } = await import("../src/services/custody-events.service.js");
    await appendCustodyEvent({ evidenceId: id, eventType: "EVIDENCE_CREATED" as never, payload: { n: 0 } });
    for (let n = 1; n <= 510; n++) {
      await appendCustodyEvent({ evidenceId: id, eventType: "EVIDENCE_VIEWED" as never, payload: { n } });
    }
    await appendCustodyEvent({ evidenceId: id, eventType: "LEGAL_HOLD_PLACED" as never, payload: { n: 511 } });

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${id}/review-workspace`,
      headers: { authorization: `Bearer ${A.ownerToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      custodyLifecycle: {
        forensicEventCount: number;
        accessEventCount: number;
        forensicEvents: Array<{ sequence: number; eventType: string }>;
        accessEvents: Array<{ sequence: number; eventType: string }>;
        truncated: boolean;
        displayLimit: number;
      };
      custodyDisplayCounts: { currentAccessEvents: number; currentForensicEvents: number };
    };
    const c = body.custodyLifecycle;

    // Counts: the whole chain.
    expect(c.accessEventCount).toBe(510);
    expect(c.forensicEventCount).toBe(2);
    expect(body.custodyDisplayCounts.currentAccessEvents).toBe(510);
    expect(body.custodyDisplayCounts.currentForensicEvents).toBe(2);

    // Display: the LATEST events, declared as a slice.
    expect(c.forensicEvents.map((e) => e.eventType)).toContain("LEGAL_HOLD_PLACED");
    expect(c.accessEvents).toHaveLength(500);
    const shownSequences = c.accessEvents.map((e) => e.sequence);
    expect(Math.max(...shownSequences)).toBe(511);
    expect(Math.min(...shownSequences)).toBe(12);
    expect(c.truncated).toBe(true);
    expect(c.displayLimit).toBe(500);
  }, 180_000);
});
