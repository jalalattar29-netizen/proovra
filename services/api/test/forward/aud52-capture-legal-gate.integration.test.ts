/**
 * AUD-52 (2026-10-20) — the capture steps that ADD or COMMIT content require
 * the current legal acceptance, as opening and reserving always did; the
 * declaration and every seal route skipped it. DISCARD stays available
 * (withdrawing one's own unsealed draft adds nothing). Live PostgreSQL 16.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";

describe("AUD-52 capture legal gate (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  let saved: Array<{ userId: string; policyKey: string; policyVersion: string }> = [];

  const call = (method: string, url: string, body?: unknown) =>
    h.app.inject({
      method: method as never,
      url,
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}`, "content-type": "application/json" },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });

  async function openAndReserve(): Promise<string> {
    const o = await call("POST", "/v1/capture/direct-sessions", {
      mode: "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
      teamId: h.fixtures.teamA.teamId,
      deviceId: null,
    });
    expect(o.statusCode, o.body).toBe(201);
    const sessionId = o.json().session.captureSessionId as string;
    const r = await call("POST", `/v1/capture/direct-sessions/${sessionId}/evidence`, { type: "VIDEO", mimeType: "video/mp4" });
    expect(r.statusCode, r.body).toBe(201);
    return sessionId;
  }

  async function withdrawAcceptance() {
    const userId = h.fixtures.teamA.ownerUserId;
    saved = await prisma.userLegalAcceptance.findMany({ where: { userId }, select: { userId: true, policyKey: true, policyVersion: true } });
    await prisma.userLegalAcceptance.deleteMany({ where: { userId } });
  }
  async function restoreAcceptance() {
    for (const row of saved) {
      await prisma.userLegalAcceptance.upsert({
        where: { userId_policyKey: { userId: row.userId, policyKey: row.policyKey } } as never,
        update: { policyVersion: row.policyVersion },
        create: row as never,
      });
    }
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
  }, 180_000);
  afterAll(async () => {
    await restoreAcceptance().catch(() => undefined);
    await h?.cleanup();
  });

  it("with terms pending re-acceptance, declaring, stating a loss, attesting and every seal answer 428; discard still works", async () => {
    const sessionId = await openAndReserve();
    await withdrawAcceptance();
    try {
      const digest = "a".repeat(64);
      const refused = [
        await call("POST", `/v1/capture/direct-sessions/${sessionId}/parts/0/declaration`, { sha256: digest, clientReportedSource: "SCREEN_SEGMENT", recordedThrough: 1, signed: null }),
        await call("POST", `/v1/capture/direct-sessions/${sessionId}/parts/0/loss`, {}),
        await call("POST", `/v1/capture/direct-sessions/${sessionId}/attestation`, {}),
        await call("POST", `/v1/capture/direct-sessions/${sessionId}/complete`, {}),
        await call("POST", `/v1/capture/direct-sessions/${sessionId}/web-complete`, { manifestJson: "{}" }),
        await call("POST", `/v1/capture/direct-sessions/${sessionId}/screen-complete`, { manifestJson: "{}" }),
        await call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, { manifestJson: "{}" }),
      ];
      for (const res of refused) {
        expect(res.statusCode, res.body).toBe(428);
        expect(JSON.parse(res.body).error.code).toBe("LEGAL_REACCEPT_REQUIRED");
      }
      const discard = await call("POST", `/v1/capture/direct-sessions/${sessionId}/discard`, {});
      expect(discard.statusCode, discard.body).toBe(200);
      expect(discard.json().result.discarded).toBe(true);
    } finally {
      await restoreAcceptance();
    }
  });

  it("with acceptance current, the declaration is accepted (the gate is not a blanket refusal)", async () => {
    const sessionId = await openAndReserve();
    const res = await call("POST", `/v1/capture/direct-sessions/${sessionId}/parts/0/declaration`, {
      sha256: "b".repeat(64),
      clientReportedSource: "SCREEN_SEGMENT",
      recordedThrough: 1,
      signed: null,
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it("a checksum sent at record creation is refused, never silently ignored", async () => {
    const res = await call("POST", "/v1/evidence", {
      type: "PHOTO",
      mimeType: "image/png",
      checksumSha256Base64: Buffer.alloc(32, 1).toString("base64"),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().code).toBe("CHECKSUM_BELONGS_TO_PART");
  });
});
