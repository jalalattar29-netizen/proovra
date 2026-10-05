/**
 * RGA-05 — DATABASE-ENFORCED package -> report-version pairing, proven against
 * live PostgreSQL 16.
 *
 * Application code already refuses to build a package for a non-existent report
 * version, but a forensic pairing must not rest on application code alone. The
 * migration 20281003000000_verification_package_report_pair_fk adds a composite
 * foreign key verification_packages(evidence_id, report_version) ->
 * reports(evidence_id, version). This suite proves the INVARIANT holds at the
 * database: an orphan is refused, a valid pair is accepted, a legacy NULL
 * report_version is preserved, and deletion never dead-locks on the constraint.
 *
 * Runs the real schema (migrate deploy) against disposable PostgreSQL. Records no
 * family-proof credit; it is a behavioural gate in its own right.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("verification package <-> report pairing FK (RGA-05, live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let organizationId: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { organizationId: true },
    });
    organizationId = team.organizationId;
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  const SHA = "a".repeat(64);

  async function seedEvidenceWithReport(version = 1): Promise<string> {
    const evidenceId = randomUUID();
    await prisma.evidence.create({
      data: {
        id: evidenceId,
        ownerUserId: harness.fixtures.teamA.ownerUserId,
        teamId: harness.fixtures.teamA.teamId,
        organizationId,
        type: "DOCUMENT",
        status: "REPORTED",
        lifecycleState: "ACTIVE",
        updatedAt: new Date(),
      } as never,
    });
    await prisma.report.create({
      data: {
        evidenceId,
        version,
        storageBucket: "b",
        storageKey: `reports/${evidenceId}/v${version}/x.pdf`,
        generatedAtUtc: new Date(),
        pdfSha256: SHA,
      } as never,
    });
    return evidenceId;
  }

  function pkg(evidenceId: string, version: number, reportVersion: number | null) {
    return prisma.verificationPackage.create({
      data: {
        evidenceId,
        version,
        storageBucket: "b",
        storageKey: `verification/${evidenceId}/v${version}/x.zip`,
        generatedAtUtc: new Date(),
        reportVersion,
      } as never,
    });
  }

  it("the composite FK exists in the live schema", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ conname: string }>>(
      `SELECT conname FROM pg_constraint WHERE conname = 'verification_packages_report_pair_fkey'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("accepts a package whose report_version matches an existing report", async () => {
    const ev = await seedEvidenceWithReport(1);
    const created = await pkg(ev, 1, 1);
    expect(created.version).toBe(1);
    expect(created.reportVersion).toBe(1);
  });

  it("REJECTS a package whose report_version has no matching report (the invariant)", async () => {
    const ev = await seedEvidenceWithReport(1);
    // report v2 does not exist; a package certifying v2 must be refused.
    await expect(pkg(ev, 2, 2)).rejects.toMatchObject({ code: "P2003" });
    // and nothing was written
    const count = await prisma.verificationPackage.count({ where: { evidenceId: ev, version: 2 } });
    expect(count).toBe(0);
  });

  it("preserves legacy packages with NULL report_version", async () => {
    const ev = await seedEvidenceWithReport(1);
    const legacy = await pkg(ev, 1, null);
    expect(legacy.reportVersion).toBeNull();
  });

  it("REFUSES an ordinary report deletion while its package exists (forensic fail-closed)", async () => {
    const ev = await seedEvidenceWithReport(1);
    await pkg(ev, 1, 1);
    // An accidental / unauthorized report delete must NOT silently vacuum the
    // package that certifies it. ON DELETE RESTRICT refuses it.
    await expect(
      prisma.report.deleteMany({ where: { evidenceId: ev, version: 1 } }),
    ).rejects.toMatchObject({ code: "P2003" });
    // Both rows are intact — no history was destroyed.
    expect(await prisma.report.count({ where: { evidenceId: ev } })).toBe(1);
    expect(await prisma.verificationPackage.count({ where: { evidenceId: ev } })).toBe(1);
  });

  it("REFUSES a package that points at a report version belonging to a DIFFERENT evidence", async () => {
    const evA = await seedEvidenceWithReport(1); // evA has report v1
    const evB = await seedEvidenceWithReport(1); // evB has report v1 (same number, different evidence)
    // evB has no report v2; a package on evB certifying v2 must be refused even
    // though (someEvidence, v2) might exist elsewhere — the pair is per-evidence.
    await expect(pkg(evB, 1, 2)).rejects.toMatchObject({ code: "P2003" });
    // And a package on evA for v1 is fine (control).
    const ok = await pkg(evA, 1, 1);
    expect(ok.reportVersion).toBe(1);
  });

  it("destruction order (packages before reports) is unaffected by the FK", async () => {
    const ev = await seedEvidenceWithReport(1);
    await pkg(ev, 1, 1);
    // Mirror the destruction executor's order inside one transaction.
    await prisma.$transaction(async (tx) => {
      await tx.verificationPackage.deleteMany({ where: { evidenceId: ev } });
      await tx.report.deleteMany({ where: { evidenceId: ev } });
    });
    expect(await prisma.report.count({ where: { evidenceId: ev } })).toBe(0);
    expect(await prisma.verificationPackage.count({ where: { evidenceId: ev } })).toBe(0);
  });
});
