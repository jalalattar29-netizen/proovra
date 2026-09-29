/**
 * ET-CUS-14 — client address and user-agent never seal into hashed audit
 * metadata; they land in the MASKED columns, and the request id fills the
 * requestId column. Live PostgreSQL 16, the real review-workspace route and
 * the real tenant-audit facade.
 *
 * On a40ca76f auditEvidenceAction put `ipAddress: req.ip` and the raw
 * user-agent into metadata (canonicalised into the V4 hash, so never
 * maskable), left the ipAddress/userAgent columns null, and left requestId
 * null — the admin requestId filter found none of these rows.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const RAW_UA = `Mozilla/5.0 (X11; Linux x86_64) ProovraAuditProbe/${randomUUID().slice(0, 8)}`;

describe("audit request context goes to masked columns (live PostgreSQL 16)", () => {
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

  async function rowFor(where: Record<string, unknown>) {
    for (let i = 0; i < 50; i++) {
      const row = await prisma.adminAuditLog.findFirst({
        where: where as never,
        orderBy: { createdAt: "desc" },
        select: { metadata: true, ipAddress: true, userAgent: true, requestId: true },
      });
      if (row) return row;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("audit row never written");
  }

  it("a route-driven tenant audit row: no raw address/UA in metadata, masked columns, requestId filled", async () => {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const { id } = await prisma.evidence.create({
      data: { title: `audit ctx ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId } as never,
      select: { id: true },
    });
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${id}/review-workspace`,
      headers: { authorization: `Bearer ${A.ownerToken}`, "user-agent": RAW_UA },
      remoteAddress: "203.0.113.77",
    });
    expect(res.statusCode, res.body).toBe(200);

    const row = await rowFor({ action: "evidence.review_workspace_viewed", resourceId: id });
    const sealed = JSON.stringify(row.metadata);
    expect(sealed).not.toContain("203.0.113.77");
    expect(sealed).not.toContain(RAW_UA);
    expect(row.ipAddress).toBeTruthy();
    expect(row.ipAddress).not.toBe("203.0.113.77");
    expect(row.userAgent ?? "").not.toBe(RAW_UA);
    expect(row.requestId).toBeTruthy();
  });

  it("the facade: metadata address/UA keys are lifted, correlationId fills requestId, the chain still verifies", async () => {
    const A = h.fixtures.teamA;
    const { emitTenantAudit } = await import("../src/services/audit/tenant-audit.service.js");
    const resourceId = randomUUID();
    await emitTenantAudit({
      action: "evidence.audit_ctx_probe",
      outcome: "success",
      sourceApp: "API",
      actorUserId: A.ownerUserId,
      workspaceId: A.teamId,
      resourceType: "evidence",
      resourceId,
      correlationId: "req-ctx-probe-1",
      metadata: { ipAddress: "198.51.100.9", userAgent: RAW_UA, reason: "probe" },
    });
    const row = await rowFor({ action: "evidence.audit_ctx_probe", resourceId });
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.ipAddress).toBeUndefined();
    expect(meta.userAgent).toBeUndefined();
    expect(meta.reason).toBe("probe");
    expect(row.ipAddress).not.toBe("198.51.100.9");
    expect(row.ipAddress).toBeTruthy();
    expect(row.requestId).toBe("req-ctx-probe-1");

    const { verifyAdminAuditChain } = await import("../src/services/platform-audit-log.service.js");
    expect(await verifyAdminAuditChain()).toMatchObject({ valid: true });
  });
});
