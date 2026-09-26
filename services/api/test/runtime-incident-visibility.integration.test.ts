/**
 * THE OTHER HALF OF TENANT ISOLATION — a workspace's own incident is still
 * SEEN by that workspace. Proven against PostgreSQL with the real writers and
 * the real read routes.
 *
 * 6eeeba23 narrowed the platform `queues` readiness check to PLATFORM-scope
 * incidents so workspace B's incidents could no longer degrade workspace A's
 * status. The global status endpoint therefore deliberately does NOT carry a
 * workspace's own incidents. That is only correct if the existing, authorized
 * workspace surfaces still do:
 *
 *   * the Inbox (`GET /v1/me/inbox`) lists a record-level report failure to
 *     the workspace's members, once, however many retries fail;
 *   * Operations (`GET /v1/ops/incidents?teamId=`) lists the workspace's
 *     incidents — including a record-level OTS exhaustion — to its operators;
 *   * none of it reaches workspace B, through any of those routes or the
 *     global status endpoint;
 *   * a resolved incident leaves no active warning;
 *   * a declared PLATFORM incident reaches every tenant's service status.
 *
 * The incidents are written through the worker's own bridge
 * (`recordWorkerIncident`) — the same call the report pipeline and the OTS
 * upgrader make — so scope and dedupe are the production rules.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type InboxItem = {
  itemKey: string;
  category: string;
  context?: { incidentId?: string; teamId?: string | null; occurrenceCount?: number };
  body?: string;
};

describe("workspace incidents stay visible to their workspace — and only to it (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let readiness: typeof import("../src/runtime/runtime-readiness.js");
  let emitter: typeof import("../../worker/src/governance/incident-emitter.js");
  const created: string[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    readiness = await import("../src/runtime/runtime-readiness.js");
    emitter = await import("../../worker/src/governance/incident-emitter.js");
  }, 180_000);

  beforeEach(async () => {
    readiness.resetTenantRuntimeCacheForTests();
    if (created.length) {
      await prisma.operationalIncident.deleteMany({ where: { id: { in: created.splice(0) } } });
    }
  });

  afterAll(async () => {
    if (created.length) {
      await prisma?.operationalIncident.deleteMany({ where: { id: { in: created } } }).catch(() => undefined);
    }
    await harness?.cleanup();
  });

  const get = (token: string, url: string) =>
    harness.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  async function inbox(token: string): Promise<InboxItem[]> {
    const res = await get(token, "/v1/me/inbox");
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: InboxItem[] }).items;
  }

  /** A report-generation failure, exactly as processor.ts records one. */
  async function reportFailure() {
    const A = harness.fixtures.teamA;
    const row = await emitter.recordWorkerIncident({
      sourceId: "pipeline.report_generation_failed",
      teamId: A.teamId,
      category: "REPORT",
      severity: "HIGH",
      fingerprint: `REPORT:${A.evidenceId}:VISIBILITY_TEST_FAILURE`,
      title: "Report generation retry budget exhausted (visibility test)",
      safeSummary: "Report generation failed for this record.",
      relatedEvidenceId: A.evidenceId,
      relatedJobId: "job-visibility-1",
      metadata: { queueName: "report", retriable: true, errorClass: "VISIBILITY_TEST_FAILURE" },
    });
    expect(row).not.toBeNull();
    if (!created.includes(row!.id)) created.push(row!.id);
    return row!;
  }

  it("A's report failure is in A's inbox exactly once — retries raise the occurrence, not new items", async () => {
    const first = await reportFailure();
    const second = await reportFailure();
    const third = await reportFailure();
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);

    const items = (await inbox(harness.fixtures.teamA.ownerToken)).filter(
      (i) => i.category === "report_failure" && i.context?.incidentId === first.id,
    );
    expect(items).toHaveLength(1);
    expect(items[0].context?.teamId).toBe(harness.fixtures.teamA.teamId);
    expect(items[0].context?.occurrenceCount).toBe(3);
  });

  it("B receives nothing about A's incident — not in its inbox, not through Operations, not in service status", async () => {
    const inc = await reportFailure();
    const B = harness.fixtures.teamB;
    const bInbox = await inbox(B.ownerToken);
    expect(JSON.stringify(bInbox)).not.toContain(inc.id);
    expect(JSON.stringify(bInbox)).not.toContain(harness.fixtures.teamA.teamId);

    // B's operator asking for A's incidents is refused, not answered empty.
    const cross = await get(B.ownerToken, `/v1/ops/incidents?teamId=${harness.fixtures.teamA.teamId}`);
    expect([403, 404]).toContain(cross.statusCode);
    expect(cross.body).not.toContain(inc.id);

    // B's own Operations list does not carry it.
    const own = await get(B.ownerToken, `/v1/ops/incidents?teamId=${B.teamId}`);
    expect(own.statusCode).toBe(200);
    expect(own.body).not.toContain(inc.id);

    // The global status is caller-independent and discloses no workspace.
    const status = await get(B.ownerToken, "/v1/runtime/status");
    expect(status.body).not.toContain(harness.fixtures.teamA.teamId);
    expect(status.body).not.toContain(inc.id);
  });

  it("A's operators see A's incidents on Operations — including a record-level OTS exhaustion", async () => {
    const A = harness.fixtures.teamA;
    const report = await reportFailure();
    const ots = await emitter.recordWorkerIncident({
      sourceId: "evidence_integrity.ots_budget_exhausted",
      teamId: A.teamId,
      category: "WORKER",
      severity: "CRITICAL",
      fingerprint: `OTS:${A.evidenceId}:GLOBAL_BUDGET_EXHAUSTED`,
      title: "OTS anchoring gave up (visibility test)",
      safeSummary: "Global budget exhausted.",
      relatedEvidenceId: A.evidenceId,
      relatedJobId: "job-ots-1",
    });
    created.push(ots!.id);
    const res = await get(A.ownerToken, `/v1/ops/incidents?teamId=${A.teamId}&status=OPEN&limit=100`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(report.id);
    expect(res.body).toContain(ots!.id);
  });

  it("a record-level OTS failure never becomes a platform queue outage", async () => {
    const A = harness.fixtures.teamA;
    const ots = await emitter.recordWorkerIncident({
      sourceId: "evidence_integrity.ots_budget_exhausted",
      teamId: A.teamId,
      category: "WORKER",
      severity: "CRITICAL",
      fingerprint: `OTS:${A.evidenceId}:GLOBAL_BUDGET_EXHAUSTED:2`,
      title: "OTS anchoring gave up (queue test)",
      safeSummary: "Global budget exhausted.",
      relatedEvidenceId: A.evidenceId,
    });
    created.push(ots!.id);
    const report = await readiness.runReadinessCheck(prisma as never, null);
    expect(report.subsystems.find((s) => s.id === "queues")!.status).toBe("HEALTHY");
  });

  it("a Personal owner sees their own report failure; an organization member does not, and vice versa", async () => {
    const P = harness.fixtures.personal;
    const personal = await emitter.recordWorkerIncident({
      sourceId: "pipeline.report_generation_failed",
      teamId: P.teamId,
      category: "REPORT",
      severity: "HIGH",
      fingerprint: `REPORT:${P.evidenceId}:VISIBILITY_TEST_PERSONAL`,
      title: "Report generation failure (personal visibility test)",
      safeSummary: "Report generation failed for this record.",
      relatedEvidenceId: P.evidenceId,
    });
    created.push(personal!.id);
    const org = await reportFailure();
    const personalInbox = JSON.stringify(await inbox(P.token));
    expect(personalInbox).toContain(personal!.id);
    expect(personalInbox).not.toContain(org.id);
    const orgInbox = JSON.stringify(await inbox(harness.fixtures.teamA.ownerToken));
    expect(orgInbox).toContain(org.id);
    expect(orgInbox).not.toContain(personal!.id);
  });

  it("a resolved incident leaves no active warning in the inbox", async () => {
    const inc = await reportFailure();
    await prisma.operationalIncident.update({
      where: { id: inc.id },
      data: { status: "RESOLVED", resolvedAtUtc: new Date() },
    });
    const items = await inbox(harness.fixtures.teamA.ownerToken);
    expect(items.some((i) => i.context?.incidentId === inc.id)).toBe(false);
  });

  it("a declared PLATFORM worker incident reaches every tenant's service status, with no incident detail", async () => {
    const row = await prisma.operationalIncident.create({
      data: {
        scope: "PLATFORM",
        teamId: null,
        category: "WORKER",
        severity: "CRITICAL",
        status: "OPEN",
        fingerprint: "platform:visibility-test",
        title: "Platform worker incident (visibility test)",
        safeSummary: "Platform-wide.",
      },
      select: { id: true },
    });
    created.push(row.id);
    for (const token of [
      harness.fixtures.teamA.ownerToken,
      harness.fixtures.teamB.ownerToken,
      harness.fixtures.personal.token,
    ]) {
      readiness.resetTenantRuntimeCacheForTests();
      const res = await get(token, "/v1/runtime/status");
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; capabilities: Record<string, string> };
      expect(body.status).toBe("DEGRADED");
      expect(["DEGRADED", "UNAVAILABLE"]).toContain(body.capabilities.artifactGeneration);
      expect(res.body).not.toContain(row.id);
      expect(res.body.toLowerCase()).not.toContain("incident");
    }
  });
});
