/**
 * ET-SEC-14 — a report / package regeneration runs the workspace output
 * policy that governs first issuance. Live PostgreSQL 16, real HTTP.
 *
 * On a40ca76f POST /v1/evidence/:id/reports/regenerate checked only
 * `evidence.generate_report`, so a workspace requiring review before a report
 * (or disabling reports / packages) was bypassed by asking for an updated
 * version or a recovery. The policy refusal is 403 with its reason and
 * creates no request.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("report regeneration governance (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let clearRates: () => Promise<unknown>;
  const created: string[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    await prisma.team.update({
      where: { id: h.fixtures.teamA.teamId },
      data: { billingPlan: "TEAM", billingStatus: "ACTIVE" },
    });
  }, 180_000);

  afterAll(async () => {
    if (created.length) {
      await prisma?.evidence
        .updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } })
        .catch(() => undefined);
    }
    await prisma?.workspaceGovernancePolicy
      .deleteMany({ where: { teamId: h.fixtures.teamA.teamId } })
      .catch(() => undefined);
    await h?.cleanup();
  });

  beforeEach(async () => {
    await clearRates();
  });

  const A = () => h.fixtures.teamA;

  async function policy(over: Record<string, boolean>) {
    await prisma.workspaceGovernancePolicy.upsert({
      where: { teamId: A().teamId },
      create: { teamId: A().teamId, ...over },
      update: {
        requireReviewBeforeReport: false,
        requireReviewBeforePackage: false,
        allowReportDownload: true,
        allowPackageDownload: true,
        ...over,
      },
    });
  }

  /** A signed record with a complete v1 pair (the state that offers NEW_VERSION). */
  async function completePair(): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: A().teamId },
      select: { organizationId: true, ownerUserId: true },
    });
    const { id } = await prisma.evidence.create({
      data: {
        title: "Regenerate governance fixture",
        type: "PHOTO",
        status: "REPORTED",
        lifecycleState: "ACTIVE",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: team.ownerUserId,
        sizeBytes: 5_000n,
      } as never,
      select: { id: true },
    });
    created.push(id);
    await prisma.report.create({
      data: { evidenceId: id, version: 1, storageBucket: "b", storageKey: `reports/${id}/v1.pdf`, generatedAtUtc: new Date(), sizeBytes: 1_000n },
    });
    await prisma.verificationPackage.create({
      data: { evidenceId: id, version: 1, storageBucket: "b", storageKey: `verification/${id}/v1.zip`, generatedAtUtc: new Date(), sizeBytes: 9_000n, reportVersion: 1 },
    });
    return id;
  }

  // RGA-02 — an updated report confirms against the signed offer the caller is
  // shown; read it first, exactly as a client dialog does.
  const newVersion = async (id: string) => {
    const st = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${id}/artifacts/status`,
      headers: { authorization: `Bearer ${A().ownerToken}` },
    });
    const revision =
      st.statusCode === 200
        ? (st.json() as { outputs?: { offer?: { revision?: string } | null } }).outputs?.offer?.revision
        : undefined;
    return h.app.inject({
      method: "POST",
      url: `/v1/evidence/${id}/reports/regenerate`,
      headers: { authorization: `Bearer ${A().ownerToken}`, "idempotency-key": `gov-${randomUUID()}` },
      payload: { intent: "NEW_VERSION", reason: "Document the later anchor", ...(revision ? { offerRevision: revision } : {}) },
    });
  };
  const requests = (id: string) => prisma.reportGenerationRequest.count({ where: { evidenceId: id } });

  it("review required before a report: an updated version is refused 403 with the policy reason and creates nothing", async () => {
    await policy({ requireReviewBeforeReport: true });
    const id = await completePair();

    const res = await newVersion(id);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ code: "REPORT_BLOCKED_BY_POLICY", reason: "review_required_before_report" });
    expect(await requests(id)).toBe(0);

    // The audit write is fire-and-forget; wait for it. (The audit layer
    // records a blocked request as outcome "denied".)
    await expect
      .poll(() =>
        prisma.adminAuditLog.findFirst({
          where: { action: "evidence.report.regenerate_requested", resourceId: id },
          orderBy: { createdAt: "desc" },
          select: { outcome: true, metadata: true },
        }),
      )
      .toMatchObject({
        outcome: "denied",
        metadata: { reason: "governance_policy", governedAction: "generate_report" },
      });
  });

  it("packages disabled by policy: the regeneration is refused on the package action", async () => {
    await policy({ allowPackageDownload: false });
    const id = await completePair();

    const res = await newVersion(id);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ reason: "package_disabled_by_policy" });
    expect(await requests(id)).toBe(0);
  });

  it("the same record under a permissive policy is accepted (control)", async () => {
    await policy({});
    const id = await completePair();

    const res = await newVersion(id);
    expect(res.statusCode, res.body).toBe(202);
    expect(await requests(id)).toBe(1);
  });
});
