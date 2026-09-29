/**
 * ET-DC-06 — a continuous capture that keeps uploading is never stranded by a
 * fixed session expiry. Live PostgreSQL 16, the production direct-capture
 * service with injected clocks.
 *
 * On a40ca76f the session's expiry was fixed at open (1h): a recording whose
 * segments kept arriving for longer was refused SESSION_EXPIRED at the next
 * declaration — after the app had deleted its local segments.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const MIN = 60 * 1000;

describe("direct-capture session expiry slides on activity (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let svc: typeof import("../src/services/capture-trust/direct-capture-ingest.service.js");
  let originalBilling: Record<string, unknown> | null = null;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    svc = await import("../src/services/capture-trust/direct-capture-ingest.service.js");
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { billingPlan: true, billingStatus: true },
    });
    originalBilling = team as unknown as Record<string, unknown>;
    await prisma.team.update({
      where: { id: harness.fixtures.teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never,
    });
  }, 600_000);
  afterAll(async () => {
    if (harness && originalBilling) {
      await prisma.team.update({ where: { id: harness.fixtures.teamA.teamId }, data: originalBilling as never }).catch(() => undefined);
    }
    await harness?.cleanup();
  });

  const digest = () => randomBytes(32).toString("hex");

  it("each declaration moves the expiry; a segment 70 minutes in is still accepted", async () => {
    const A = harness.fixtures.teamA;
    const t0 = new Date();
    const open = await svc.openDirectCaptureSession({
      ownerUserId: A.ownerUserId,
      teamId: A.teamId,
      mode: "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
      deviceId: null,
      now: t0,
    });
    const at = (m: number) => new Date(t0.getTime() + m * MIN);
    await svc.reserveDirectCaptureEvidence({
      sessionId: open.captureSessionId,
      ownerUserId: A.ownerUserId,
      type: "VIDEO",
      mimeType: "video/mp4",
      now: at(1),
    } as never);
    const declare = (partIndex: number, m: number) =>
      svc.declareDirectCapturePart({
        sessionId: open.captureSessionId,
        ownerUserId: A.ownerUserId,
        partIndex,
        sha256: digest(),
        clientReportedSource: "UNKNOWN",
        signed: null,
        now: at(m),
      });
    await declare(0, 30);
    await declare(1, 50);
    // Past the opening hour: accepted because the previous segment slid the expiry.
    await expect(declare(2, 70)).resolves.toMatchObject({ created: true });
    const row = await prisma.captureSession.findUniqueOrThrow({
      where: { id: open.captureSessionId },
      select: { expiresAtUtc: true, status: true },
    });
    expect(row.status).toBe("ACTIVE");
    expect(row.expiresAtUtc!.getTime()).toBe(at(130).getTime());
  });

  it("the expiry never passes the absolute session lifetime, and a silent session still expires", async () => {
    const A = harness.fixtures.teamA;
    const t0 = new Date();
    const open = await svc.openDirectCaptureSession({
      ownerUserId: A.ownerUserId,
      teamId: A.teamId,
      mode: "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
      deviceId: null,
      now: t0,
    });
    const at = (m: number) => new Date(t0.getTime() + m * MIN);
    // Force the session near its lifetime cap, then declare.
    await prisma.captureSession.update({
      where: { id: open.captureSessionId },
      data: { expiresAtUtc: at(24 * 60 - 10) },
    });
    await svc.reserveDirectCaptureEvidence({
      sessionId: open.captureSessionId,
      ownerUserId: A.ownerUserId,
      type: "VIDEO",
      mimeType: "video/mp4",
      now: at(24 * 60 - 20),
    } as never);
    const row = await prisma.captureSession.findUniqueOrThrow({ where: { id: open.captureSessionId }, select: { expiresAtUtc: true } });
    expect(row.expiresAtUtc!.getTime()).toBe(t0.getTime() + svc.MAX_SESSION_LIFETIME_SECONDS * 1000);
    // Silence past the expiry: refused.
    await expect(
      svc.declareDirectCapturePart({
        sessionId: open.captureSessionId,
        ownerUserId: A.ownerUserId,
        partIndex: 0,
        sha256: digest(),
        clientReportedSource: "UNKNOWN",
        signed: null,
        now: at(24 * 60 + 1),
      }),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });
});
