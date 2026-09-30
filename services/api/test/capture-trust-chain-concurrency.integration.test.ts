/**
 * ET-DC-10 — concurrent capture trust events extend ONE chain. Live
 * PostgreSQL 16.
 *
 * On a40ca76f each append read the chain's head and inserted the next link as
 * two unlocked statements, with no unique (chain, sequence): concurrent
 * declarations read the same head and wrote duplicate sequences, forking the
 * sub-chain (and making "first by sequence" nondeterministic).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("capture trust-event chain under concurrency (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let emit: (typeof import("../src/services/capture-trust/trust-event.service.js"))["emitCaptureTrustEvent"];
  let originalBilling: Record<string, unknown> | null = null;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ emitCaptureTrustEvent: emit } = await import("../src/services/capture-trust/trust-event.service.js"));
    originalBilling = (await prisma.team.findUniqueOrThrow({
      where: { id: h.fixtures.teamA.teamId },
      select: { billingPlan: true, billingStatus: true },
    })) as unknown as Record<string, unknown>;
    await prisma.team.update({
      where: { id: h.fixtures.teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never,
    });
  }, 180_000);

  afterAll(async () => {
    if (h && originalBilling) {
      await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: originalBilling as never }).catch(() => undefined);
    }
    await h?.cleanup();
  });

  it("eight concurrent events get distinct, consecutive sequences, each linked to the one before", async () => {
    const A = h.fixtures.teamA;
    const open = await h.app.inject({
      method: "POST",
      url: "/v1/capture/direct-sessions",
      headers: { authorization: `Bearer ${A.ownerToken}` },
      payload: { mode: "PROOVRA_MOBILE_APP", teamId: A.teamId, deviceId: null },
    });
    expect(open.statusCode, open.body).toBe(201);
    const sessionId = open.json().session.captureSessionId as string;

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        emit({
          teamId: A.teamId,
          captureSessionId: sessionId,
          evidenceId: null,
          deviceId: null,
          code: "CAPTURE_ARTIFACT_RECEIVED",
          payload: { n: i },
        }),
      ),
    );
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason).slice(0, 160))).toEqual([]);

    const chain = await prisma.captureTrustEventRecord.findMany({
      where: { captureSessionId: sessionId },
      orderBy: { sequence: "asc" },
      select: { sequence: true, eventHash: true, prevEventHash: true },
    });
    const sequences = chain.map((e) => e.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, i) => sequences[0]! + i));
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i]!.prevEventHash, `link ${chain[i]!.sequence}`).toBe(chain[i - 1]!.eventHash);
    }
  });
});
