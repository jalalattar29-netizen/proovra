/**
 * Closure 2 ("sem" item 3a/3b) — who may remove trust from a trusted device.
 *
 * Before: POST /v1/identity-security/devices/:id/revoke took ANY member's
 * device in the workspace on `identity.access_review.action` alone — no
 * step-up, no rank rule — while the device's own person could not revoke it
 * unless they also administered identity.
 *
 * Now (live PostgreSQL, the real route, the real step-up ceremony):
 *  - another person's device: identity administrator + the members rank rule
 *    + a step-up bound to THAT device (purpose MFA_TRUSTED_DEVICE_RESET);
 *  - one's own device: any member, no step-up;
 *  - a non-administrator naming someone else's device: 404, nothing written.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Res = { statusCode: number; body: string };

describe("sem item 3 — trusted-device revocation authority", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let ceremony: ReturnType<typeof import("./support/step-up-ceremony.js").createStepUpCeremony>;
  let ip = 1;
  const A = () => h.fixtures.teamA;
  const url = (id: string) => `/v1/identity-security/devices/${id}/revoke`;

  const call = (token: string, id: string, extra: Record<string, string> = {}): Promise<Res> =>
    h.app.inject({
      method: "POST",
      url: url(id),
      remoteAddress: `198.51.100.${(ip++ % 250) + 1}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
      payload: { teamId: A().teamId, reason: "sem item 3" },
    }) as unknown as Promise<Res>;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { createStepUpCeremony } = await import("./support/step-up-ceremony.js");
    ceremony = createStepUpCeremony({
      prisma: prisma as never,
      inject: (opts) => h.app.inject(opts as never) as never,
    });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const deviceOf = (userId: string) =>
    prisma.trustedDevice.create({
      data: {
        teamId: A().teamId,
        userId,
        deviceIdHash: createHash("sha256").update(randomUUID()).digest("hex"),
        trustedUntilUtc: new Date(Date.now() + 30 * 86_400_000),
      },
      select: { id: true },
    });
  const statusOf = async (id: string) =>
    (await prisma.trustedDevice.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
  const proof = (token: string, userId: string, deviceId: string) =>
    ceremony.approvedHeader({
      token,
      userId,
      teamId: A().teamId,
      purpose: "MFA_TRUSTED_DEVICE_RESET",
      resourceKind: "trusted_device",
      resourceId: deviceId,
    });

  it("another member's device: an ADMIN is refused 401 without a step-up and with one bound to another device; one bound to THIS device revokes it", async () => {
    const d = await deviceOf(A().memberUserId);
    const other = await deviceOf(A().memberUserId);

    const bare = await call(A().adminToken, d.id);
    expect(bare.statusCode, bare.body).toBe(401);
    expect(JSON.parse(bare.body).error.code).toBe("STEP_UP_REQUIRED");
    expect(await statusOf(d.id)).toBe("ACTIVE");

    const wrong = await call(A().adminToken, d.id, await proof(A().adminToken, A().adminUserId, other.id));
    expect(wrong.statusCode, wrong.body).not.toBe(200);
    expect(await statusOf(d.id)).toBe("ACTIVE");

    const ok = await call(A().adminToken, d.id, await proof(A().adminToken, A().adminUserId, d.id));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await statusOf(d.id)).toBe("REVOKED");
    expect(await statusOf(other.id)).toBe("ACTIVE");
  });

  it("the rank rule: an ADMIN cannot revoke the OWNER's device even with a step-up; the OWNER can revoke the ADMIN's", async () => {
    const ownerDevice = await deviceOf(A().ownerUserId);
    const refused = await call(A().adminToken, ownerDevice.id, await proof(A().adminToken, A().adminUserId, ownerDevice.id));
    expect(refused.statusCode, refused.body).toBe(403);
    expect(JSON.parse(refused.body).error.reason).toBe("rank_insufficient");
    expect(await statusOf(ownerDevice.id)).toBe("ACTIVE");

    const adminDevice = await deviceOf(A().adminUserId);
    const ok = await call(A().ownerToken, adminDevice.id, await proof(A().ownerToken, A().ownerUserId, adminDevice.id));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await statusOf(adminDevice.id)).toBe("REVOKED");
  });

  it("a MEMBER or VIEWER naming another person's device gets 404 and nothing changes", async () => {
    const d = await deviceOf(A().adminUserId);
    for (const token of [A().memberToken, A().viewerToken]) {
      const res = await call(token, d.id);
      expect(res.statusCode, res.body).toBe(404);
    }
    expect(await statusOf(d.id)).toBe("ACTIVE");
  });

  it("self-service: a MEMBER, a VIEWER and an ADMIN each remove trust from their OWN device with no step-up", async () => {
    for (const [token, userId] of [
      [A().memberToken, A().memberUserId],
      [A().viewerToken, A().viewerUserId],
      [A().adminToken, A().adminUserId],
    ] as const) {
      const d = await deviceOf(userId);
      const res = await call(token, d.id);
      expect(res.statusCode, res.body).toBe(200);
      expect(await statusOf(d.id)).toBe("REVOKED");
    }
  });

  it("a device of another workspace is 404 to everyone, step-up or not", async () => {
    const foreign = await prisma.trustedDevice.create({
      data: {
        teamId: h.fixtures.teamB.teamId,
        userId: h.fixtures.teamB.memberUserId,
        deviceIdHash: createHash("sha256").update(randomUUID()).digest("hex"),
        trustedUntilUtc: new Date(Date.now() + 30 * 86_400_000),
      },
      select: { id: true },
    });
    const res = await call(A().ownerToken, foreign.id);
    expect(res.statusCode, res.body).toBe(404);
    expect(await statusOf(foreign.id)).toBe("ACTIVE");
  });
});
