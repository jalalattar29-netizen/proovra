/**
 * ET-DC-11 — capture scope and authority tidy-ups. Live PostgreSQL 16, real HTTP.
 *
 * On a40ca76f:
 *   - an extension (capture.direct) token could presign parts on ANY unsealed
 *     record its user owned — the parts route is on its allowlist;
 *   - the capture-draft route admitted any ACTIVE membership row for the
 *     body's teamId (a VIEWER, an expired member);
 *   - the continuous manifest part was relabelled AFTER the record was sealed;
 *   - device-identity carried an uncalled lookup.
 * (The last two are held by source pins in phase-1b-mobile-capture-trust and
 * the UC-3 suite.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("capture scope and draft authority (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let extensionToken: string;
  let originalBilling: Record<string, unknown> | null = null;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const { EXTENSION_CAPTURE_SCOPE } = await import("../src/services/auth/extension-scope.js");
    const A = h.fixtures.teamA;
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: A.ownerUserId }, select: { email: true } });
    extensionToken = signJwt(
      {
        sub: A.ownerUserId,
        provider: "EMAIL",
        email: owner.email,
        authMethod: "PASSWORD",
        authAt: Math.floor(Date.now() / 1000),
        scope: EXTENSION_CAPTURE_SCOPE,
      } as never,
      process.env.AUTH_JWT_SECRET!,
      3600,
    );
    originalBilling = (await prisma.team.findUniqueOrThrow({
      where: { id: A.teamId },
      select: { billingPlan: true, billingStatus: true },
    })) as unknown as Record<string, unknown>;
    await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
  }, 180_000);

  afterAll(async () => {
    if (h && originalBilling) {
      await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: originalBilling as never }).catch(() => undefined);
    }
    await h?.cleanup();
  });

  const A = () => h.fixtures.teamA;
  const post = (token: string, url: string, payload: unknown) =>
    h.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: payload as never });

  it("an extension token cannot presign parts on a record its own capture did not reserve", async () => {
    const created = await post(A().ownerToken, "/v1/evidence", { type: "PHOTO", teamId: A().teamId, mimeType: "image/jpeg" });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;

    const res = await post(extensionToken, `/v1/evidence/${id}/parts`, { partIndex: 0, mimeType: "image/png" });
    expect(res.statusCode, res.body).toBe(403);
    expect(await prisma.evidencePart.count({ where: { evidenceId: id } })).toBe(0);
  });

  it("an extension token presigns parts for the record its own capture session reserved (control)", async () => {
    const open = await post(extensionToken, "/v1/capture/direct-sessions", {
      mode: "DIRECT_WEB_CAPTURE_EXTENSION",
      teamId: A().teamId,
      deviceId: null,
    });
    expect(open.statusCode, open.body).toBe(201);
    const sessionId = open.json().session.captureSessionId as string;
    const reserve = await post(extensionToken, `/v1/capture/direct-sessions/${sessionId}/evidence`, {
      type: "PHOTO",
      mimeType: "image/png",
    });
    expect(reserve.statusCode, reserve.body).toBe(201);
    const evidenceId = reserve.json().evidence.evidenceId as string;

    const part = await post(extensionToken, `/v1/evidence/${evidenceId}/parts`, { partIndex: 0, mimeType: "image/png" });
    expect([200, 201]).toContain(part.statusCode);
  });

  it("a capture draft in a workspace takes the canonical evidence.create decision (VIEWER and expired member refused)", async () => {
    const viewer = await post(A().viewerToken, "/v1/capture/sessions", { teamId: A().teamId });
    expect(viewer.statusCode, viewer.body).toBe(403);
    expect(viewer.json()).toMatchObject({ code: "WORKSPACE_MEMBERSHIP_REQUIRED" });

    const where = { teamId_userId: { teamId: A().teamId, userId: A().memberUserId } };
    await prisma.teamMember.update({ where, data: { accessExpiresAtUtc: new Date(Date.now() - 60_000) } });
    try {
      const expired = await post(A().memberToken, "/v1/capture/sessions", { teamId: A().teamId });
      expect(expired.statusCode, expired.body).toBe(403);
    } finally {
      await prisma.teamMember.update({ where, data: { accessExpiresAtUtc: null } });
    }

    const admin = await post(A().adminToken, "/v1/capture/sessions", { teamId: A().teamId });
    expect([200, 201]).toContain(admin.statusCode);
  });
});
