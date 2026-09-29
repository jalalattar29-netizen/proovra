/**
 * RECORD CONDITIONS WITH NO WORKSPACE ROW (2026-09-29) — live PostgreSQL 16.
 *
 * A report/package failure for a Personal record stored with team_id NULL is
 * written LEGACY_UNSCOPED with team_id NULL. Before this, such a condition was
 * listed only incidentally on the platform console, had no detail, could not be
 * remediated (the tenant route needs a workspace, and the durable writer refused
 * a record with no team), was never swept, and a manual resolve was always
 * refused as UNKNOWN.
 *
 * Pinned here: creation + dedupe, operator listing with the exact target,
 * detail, remediation through the canonical component recovery (scoped to the
 * record's personal workspace, never assigning the row a team), the still-
 * missing condition staying open, an exact-version repair closing it through the
 * verified transition (a wrong-version repair does not), authorization denial,
 * no tenant leakage — and the same path for a regular workspace condition.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  bootstrapPersonalSpace,
  seedOwnedWorkspace,
  seedPersonalTenant,
  seedUser,
  type FixtureDeps,
  type SeededUser,
} from "./point7/product-fixtures.js";

describe("record conditions with no workspace row (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let admin: SeededUser;
  let personalOwner: SeededUser;
  let personalTeamId: string;
  let wsOwner: SeededUser;
  let workspaceId: string;
  let outsider: SeededUser;

  async function as(user: SeededUser, method: "GET" | "POST", url: string, payload?: unknown) {
    const res = await harness.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${user.token}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { statusCode: res.statusCode, body: res.body, json: () => JSON.parse(res.body) };
  }

  async function paidSubscription(userId: string) {
    await prisma.subscription.create({
      data: {
        userId,
        provider: "STRIPE",
        providerSubId: `unscoped-${randomUUID()}`,
        status: "ACTIVE",
        plan: "PRO",
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
      },
    });
  }

  /** A finalized record with report v1 and NO package v1. */
  async function reportedRecord(input: { teamId: string | null; ownerUserId: string; organizationId?: string | null }) {
    const ev = await prisma.evidence.create({
      data: {
        title: `unscoped ${deps.tag}`,
        type: "DOCUMENT",
        status: "REPORTED",
        teamId: input.teamId,
        organizationId: input.organizationId ?? null,
        ownerUserId: input.ownerUserId,
        fileSha256: "a".repeat(64),
        signedAtUtc: new Date(),
        latestReportVersion: 1,
      } as never,
      select: { id: true },
    });
    await prisma.report.create({
      data: {
        evidenceId: ev.id,
        version: 1,
        storageBucket: "test-bucket",
        storageKey: `reports/${ev.id}/v1.pdf`,
        generatedAtUtc: new Date(),
      },
    });
    return ev.id;
  }

  async function packageCondition(evidenceId: string, teamId: string | null) {
    const { recordIncident } = await import("../src/services/observability/incident.service.js");
    return recordIncident({
      teamId,
      sourceId: "pipeline.package_generation_failed",
      category: "PACKAGE",
      severity: "CRITICAL",
      fingerprint: `PACKAGE:${evidenceId}:v1:VERIFICATION_PACKAGE_STORAGE_REJECTED`,
      title: `Verification package failed (${evidenceId.slice(0, 8)})`,
      safeSummary: "The verification package could not be published.",
      relatedEvidenceId: evidenceId,
    } as never);
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `unscoped-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          secret,
          60 * 60,
        ),
    };
    admin = await seedUser(deps, "unscoped-admin");
    await prisma.user.update({ where: { id: admin.userId }, data: { platformRole: "admin" } });

    const pro = await seedPersonalTenant(deps, "PRO");
    personalOwner = pro.owner;
    personalTeamId = pro.personalTeamId;
    await paidSubscription(personalOwner.userId);

    wsOwner = await seedUser(deps, "unscoped-ws-owner");
    await bootstrapPersonalSpace(deps, wsOwner.userId);
    const ws = await seedOwnedWorkspace(deps, {
      ownerUserId: wsOwner.userId,
      name: `unscoped-ws-${deps.tag}`,
      billingPlan: "TEAM",
      billingStatus: "ACTIVE",
    });
    workspaceId = ws.teamId;
    outsider = (await seedPersonalTenant(deps, "PRO")).owner;
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("creation: a Personal record's condition is LEGACY_UNSCOPED with team_id NULL, and a repeat dedupes onto it", async () => {
    const eid = await reportedRecord({ teamId: null, ownerUserId: personalOwner.userId });
    const first = await packageCondition(eid, null);
    const again = await packageCondition(eid, null);
    const rows = await prisma.operationalIncident.findMany({ where: { relatedEvidenceId: eid } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ teamId: null, scope: "LEGACY_UNSCOPED" });
    expect((again as { incident?: { id: string } }).incident?.id ?? rows[0]!.id).toBe(
      (first as { incident?: { id: string } }).incident?.id ?? rows[0]!.id,
    );
  });

  it("operator path: listed with its exact target, inspectable, still missing stays open, recovered by the canonical path, closed only by the exact repair", async () => {
    const eid = await reportedRecord({ teamId: null, ownerUserId: personalOwner.userId });
    await packageCondition(eid, null);
    const row = await prisma.operationalIncident.findFirstOrThrow({ where: { relatedEvidenceId: eid } });

    // LIST — found, with the component and version it names.
    const list = await as(admin, "GET", "/v1/admin/incidents?status=OPEN");
    expect(list.statusCode).toBe(200);
    const listed = (list.json().items as Array<{ id: string; target: unknown; affected: unknown }>).find((i) => i.id === row.id);
    expect(listed?.target).toEqual({ component: "VERIFICATION_PACKAGE", evidenceId: eid, reportVersion: 1 });
    expect(listed?.affected).toBeNull();

    // DETAIL — read in the RECORD's workspace; the package is still missing.
    const detail = await as(admin, "GET", `/v1/admin/incidents/${row.id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({
      target: { component: "VERIFICATION_PACKAGE", evidenceId: eid, reportVersion: 1 },
      recordWorkspaceId: personalTeamId,
      sourceActivity: "ACTIVE",
    });

    // STILL MISSING — a manual resolve is refused, and the sweep keeps it open.
    const refused = await as(admin, "POST", `/v1/admin/incidents/${row.id}/resolve`, {});
    expect(refused.statusCode).toBe(409);
    const { sweepUnscopedSourceTruthRecoveries } = await import(
      "../src/services/operations/source-truth-recovery.service.js"
    );
    await sweepUnscopedSourceTruthRecoveries({ sourceId: "pipeline.package_generation_failed" });
    expect((await prisma.operationalIncident.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("OPEN");

    // REMEDIATE — the canonical component recovery, for EXACTLY package v1,
    // scoped to the record's personal workspace. The condition row keeps no team.
    const noReason = await as(admin, "POST", `/v1/admin/incidents/${row.id}/remediate`, {});
    expect(noReason.statusCode).toBe(400);
    const remediated = await as(admin, "POST", `/v1/admin/incidents/${row.id}/remediate`, {
      reason: "Object Lock checksum fix deployed",
    });
    expect(remediated.statusCode, remediated.body).toBe(200);
    expect(remediated.json()).toMatchObject({ result: expect.stringMatching(/QUEUED|QUEUE_UNAVAILABLE|ALREADY_IN_PROGRESS/) });
    const request = await prisma.reportGenerationRequest.findFirstOrThrow({
      where: { evidenceId: eid },
      orderBy: { createdAtUtc: "desc" },
    });
    expect(request).toMatchObject({ artifactType: "VERIFICATION_PACKAGE", reportVersion: 1, teamId: personalTeamId });
    expect((await prisma.operationalIncident.findUniqueOrThrow({ where: { id: row.id } })).teamId).toBeNull();
    // A second click collapses onto the same durable request.
    await as(admin, "POST", `/v1/admin/incidents/${row.id}/remediate`, { reason: "again" });
    expect(await prisma.reportGenerationRequest.count({ where: { evidenceId: eid } })).toBe(1);

    // A WRONG-VERSION repair does not close it…
    await prisma.verificationPackage.create({
      data: { evidenceId: eid, version: 2, storageBucket: "test-bucket", storageKey: `verification/${eid}/v2.zip`, generatedAtUtc: new Date() } as never,
    });
    await sweepUnscopedSourceTruthRecoveries({ sourceId: "pipeline.package_generation_failed" });
    expect((await prisma.operationalIncident.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("OPEN");

    // …the EXACT repair does, through the verified transition.
    await prisma.verificationPackage.create({
      data: { evidenceId: eid, version: 1, storageBucket: "test-bucket", storageKey: `verification/${eid}/v1.zip`, generatedAtUtc: new Date() } as never,
    });
    const sweep = await sweepUnscopedSourceTruthRecoveries({ sourceId: "pipeline.package_generation_failed" });
    expect(sweep.resolved).toBeGreaterThanOrEqual(1);
    const closed = await prisma.operationalIncident.findUniqueOrThrow({ where: { id: row.id } });
    expect(closed.status).toBe("RESOLVED");
    expect(closed.resolvedByUserId).toBeNull();
    const events = await prisma.operationalIncidentEvent.findMany({ where: { incidentId: row.id } });
    expect(events.map((e) => e.eventType)).toContain("resolved_by_domain_truth");
  });

  it("authorization: no customer can inspect or remediate it, and no tenant surface lists it", async () => {
    const eid = await reportedRecord({ teamId: null, ownerUserId: personalOwner.userId });
    await packageCondition(eid, null);
    const row = await prisma.operationalIncident.findFirstOrThrow({ where: { relatedEvidenceId: eid } });

    for (const user of [personalOwner, outsider, wsOwner]) {
      expect((await as(user, "GET", `/v1/admin/incidents/${row.id}`)).statusCode).toBeGreaterThanOrEqual(401);
      const denied = await as(user, "POST", `/v1/admin/incidents/${row.id}/remediate`, { reason: "try it" });
      expect([401, 403, 404]).toContain(denied.statusCode);
    }
    expect(await prisma.reportGenerationRequest.count({ where: { evidenceId: eid } })).toBe(0);

    // No tenant listing returns it — not the owner's personal workspace, not another workspace.
    const { listIncidents } = await import("../src/services/observability/incident.service.js");
    for (const teamId of [personalTeamId, workspaceId]) {
      const page = await listIncidents({ teamId, limit: 500 });
      const ids = page.incidents.map((i) => i.id);
      expect(ids).not.toContain(row.id);
    }
  });

  it("a regular workspace condition gets the same operator recovery, scoped to its workspace", async () => {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: workspaceId }, select: { organizationId: true } });
    await paidSubscription(wsOwner.userId);
    const eid = await reportedRecord({ teamId: workspaceId, ownerUserId: wsOwner.userId, organizationId: team.organizationId });
    await packageCondition(eid, workspaceId);
    const row = await prisma.operationalIncident.findFirstOrThrow({ where: { relatedEvidenceId: eid } });
    expect(row).toMatchObject({ teamId: workspaceId, scope: "WORKSPACE" });

    const detail = await as(admin, "GET", `/v1/admin/incidents/${row.id}`);
    expect(detail.json()).toMatchObject({ recordWorkspaceId: workspaceId, sourceActivity: "ACTIVE" });
    const remediated = await as(admin, "POST", `/v1/admin/incidents/${row.id}/remediate`, { reason: "operator recovery" });
    expect(remediated.statusCode, remediated.body).toBe(200);
    const request = await prisma.reportGenerationRequest.findFirstOrThrow({ where: { evidenceId: eid } });
    expect(request).toMatchObject({ artifactType: "VERIFICATION_PACKAGE", reportVersion: 1, teamId: workspaceId });
  });
});
