/**
 * AUD-37 (2026-10-20) — a location fix the device's provider reported as MOCK
 * is recorded with the record (bound into the creation custody event) and the
 * canonical location state states it — never an ordinary "Location recorded".
 * Live PostgreSQL 16, the real create and owner routes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MOCK_LOCATION_DETAIL } from "@proovra/shared";

import type { IntegrationHarness } from "../integration-harness.js";

describe("AUD-37 mock location truth (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  const create = async (gps: Record<string, unknown>) => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/evidence",
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ type: "PHOTO", mimeType: "image/jpeg", teamId: h.fixtures.teamA.teamId, gps }),
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json().id as string;
  };

  const ownerLocation = async (id: string) => {
    const res = await h.app.inject({ method: "GET", url: `/v1/evidence/${id}/review-workspace`, headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` } });
    expect(res.statusCode, res.body).toBe(200);
    const find = (o: unknown): Record<string, unknown> | null => {
      if (!o || typeof o !== "object") return null;
      const rec = o as Record<string, unknown>;
      if (rec.locationState && typeof rec.locationState === "object") return rec.locationState as Record<string, unknown>;
      for (const v of Object.values(rec)) {
        const hit = find(v);
        if (hit) return hit;
      }
      return null;
    };
    return find(res.json());
  };

  it("a mocked fix is bound into the creation custody event and stated on the owner surface", async () => {
    const id = await create({ lat: 48.8566, lng: 2.3522, accuracyMeters: 5, providerReportedMock: true });
    const created = await prisma.custodyEvent.findFirstOrThrow({ where: { evidenceId: id, eventType: "EVIDENCE_CREATED" }, select: { payload: true } });
    expect((created.payload as { gps?: { providerReportedMock?: boolean } }).gps?.providerReportedMock).toBe(true);
    const loc = await ownerLocation(id);
    expect(loc).toMatchObject({ state: "RECORDED", tone: "warning", detail: MOCK_LOCATION_DETAIL, providerReportedMock: true });
  });

  it("an ordinary fix records no mock flag and reads as an ordinary recorded location", async () => {
    const id = await create({ lat: 48.8566, lng: 2.3522, accuracyMeters: 5 });
    const created = await prisma.custodyEvent.findFirstOrThrow({ where: { evidenceId: id, eventType: "EVIDENCE_CREATED" }, select: { payload: true } });
    expect((created.payload as { gps?: Record<string, unknown> }).gps).not.toHaveProperty("providerReportedMock");
    const loc = await ownerLocation(id);
    expect(loc).toMatchObject({ state: "RECORDED", providerReportedMock: false });
    expect(loc?.tone).not.toBe("warning");
  });
});
