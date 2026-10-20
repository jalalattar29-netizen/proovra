/**
 * AUD-30 (2026-10-20) — platform admin, operations and matter-queue backlog
 * counts name only records an output is OWED for. Live PostgreSQL 16.
 *
 * Before this phase every SIGNED record without a report was a "gap": an
 * archived record the producer guard refuses, and a FREE workspace's record
 * that never earned an output, were counted beside real failures — a backlog
 * that could never clear and that hid the records that mattered.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";

describe("AUD-30 owed-output backlog (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  const seeded: string[] = [];
  const cases: string[] = [];
  let ids: { entitled: string; archived: string; freeNever: string; freeEarned: string };

  async function seed(teamId: string, extra: Record<string, unknown> = {}): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const id = randomUUID();
    await prisma.evidence.create({
      data: {
        id,
        teamId,
        organization: { connect: { id: team.organizationId } },
        type: "PHOTO",
        ownerUserId: team.ownerUserId,
        uploadedByUserId: team.ownerUserId,
        status: "SIGNED",
        title: "aud30",
        tsaStatus: "SUCCESS",
        latestReportVersion: null,
        ...extra,
      },
    });
    seeded.push(id);
    return id;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { entitleFixtureWorkspace } = await import("../helpers/output-entitlement.js");
    const A = h.fixtures.teamA.teamId;
    const B = h.fixtures.teamB.teamId;
    await entitleFixtureWorkspace(prisma, A);
    // Workspace B stays on its default plan: FREE, no purchased credits.
    await prisma.team.update({ where: { id: B }, data: { billingPlan: "FREE", billingStatus: "ACTIVE" } });
    ids = {
      entitled: await seed(A),
      archived: await seed(A, { lifecycleState: "ARCHIVED", archivedAt: new Date() }),
      freeNever: await seed(B),
      freeEarned: await seed(B, { outputEarnedBasis: "FREE_ALLOWANCE", outputEarnedPlan: "FREE", outputEarnedAtUtc: new Date() }),
    };
  }, 300_000);

  afterAll(async () => {
    try {
      await prisma.caseEvidenceLink.deleteMany({ where: { caseId: { in: cases } } });
      await prisma.case.deleteMany({ where: { id: { in: cases } } });
      await prisma.evidence.deleteMany({ where: { id: { in: seeded } } });
    } catch {
      /* the harness drops the database anyway */
    }
    await h?.cleanup();
  }, 120_000);

  it("the admin drill-down lists the owed records and not the refused ones", async () => {
    const { listAdminEvidenceRecords } = await import("../../src/services/admin/evidence-records.service.js");
    const listed = new Set<string>();
    for (const teamId of [h.fixtures.teamA.teamId, h.fixtures.teamB.teamId]) {
      const r = await listAdminEvidenceRecords({ signal: "SIGNED_NO_REPORT", page: 1, limit: 200, teamId });
      for (const row of r.items) listed.add(row.id);
    }
    expect(listed.has(ids.entitled)).toBe(true);
    expect(listed.has(ids.freeEarned)).toBe(true);
    expect(listed.has(ids.archived)).toBe(false);
    expect(listed.has(ids.freeNever)).toBe(false);
  });

  it("reported-without-package names only owed records (drill-down and operations count)", async () => {
    const { listAdminEvidenceRecords } = await import("../../src/services/admin/evidence-records.service.js");
    const { buildEvidenceHealthSnapshot } = await import("../../src/services/operations/evidence-health.service.js");
    const reported = { status: "REPORTED", latestReportVersion: 1, verificationPackageVersion: null };
    const read = async () => (await buildEvidenceHealthSnapshot()).packages.verificationBacklog;
    const before = await read();
    const owed = await seed(h.fixtures.teamA.teamId, reported);
    const refused = await seed(h.fixtures.teamB.teamId, reported);
    const after = await read();
    expect(before).not.toBeNull();
    expect(after! - before!).toBe(1);
    const listed = new Set<string>();
    for (const teamId of [h.fixtures.teamA.teamId, h.fixtures.teamB.teamId]) {
      const r = await listAdminEvidenceRecords({ signal: "REPORTED_NO_PACKAGE", page: 1, limit: 200, teamId });
      for (const row of r.items) listed.add(row.id);
    }
    expect(listed.has(owed)).toBe(true);
    expect(listed.has(refused)).toBe(false);
  });

  it("the cohort drill-down and its count agree, and exclude the refused records", async () => {
    const { buildEvidenceHealthCohorts } = await import("../../src/services/admin/evidence-health-cohorts.service.js");
    const { listAdminEvidenceRecords } = await import("../../src/services/admin/evidence-records.service.js");
    const p = await buildEvidenceHealthCohorts();
    expect(p.arithmetic.agrees).toBe(true);
    const r = await listAdminEvidenceRecords({ cohort: "SIGNED_NO_REPORT_ONLY", page: 1, limit: 200, teamId: h.fixtures.teamB.teamId });
    const listed = r.items.map((x) => x.id);
    expect(listed).toContain(ids.freeEarned);
    expect(listed).not.toContain(ids.freeNever);
    const a = await listAdminEvidenceRecords({ cohort: "RETRYABLE", page: 1, limit: 200, teamId: h.fixtures.teamA.teamId });
    expect(a.items.map((x) => x.id)).toContain(ids.entitled);
    expect(a.items.map((x) => x.id)).not.toContain(ids.archived);
  });

  it("the operations count moves by the owed records only", async () => {
    const { buildEvidenceHealthSnapshot } = await import("../../src/services/operations/evidence-health.service.js");
    const read = async () => (await buildEvidenceHealthSnapshot()).evidence.withoutReport;
    const before = await read();
    await seed(h.fixtures.teamB.teamId);
    await seed(h.fixtures.teamA.teamId, { lifecycleState: "ARCHIVED", archivedAt: new Date() });
    await seed(h.fixtures.teamA.teamId);
    const after = await read();
    expect(before).not.toBeNull();
    expect(after! - before!).toBe(1);
  });

  it("a matter's evidence-gap count names only owed records", async () => {
    const { buildMatterQueue } = await import("../../src/services/cases/matter-queue.service.js");
    const B = h.fixtures.teamB;
    const c = await prisma.case.create({ data: { name: "aud30 matter", ownerUserId: B.ownerUserId, teamId: B.teamId } });
    cases.push(c.id);
    for (const evidenceId of [ids.freeNever, ids.freeEarned]) {
      await prisma.caseEvidenceLink.create({ data: { caseId: c.id, evidenceId, teamId: B.teamId } });
    }
    const q = await buildMatterQueue({ teamId: B.teamId, userId: B.ownerUserId, role: "OWNER", filter: {} as never, limit: 200 });
    const item = q.items.find((i) => i.id === c.id);
    expect(item, JSON.stringify(q).slice(0, 400)).toBeTruthy();
    expect(item!.evidenceGapCount).toBe(1);
  });
});
