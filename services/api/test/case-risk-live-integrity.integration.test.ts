/**
 * ET-SEC-21 — a case's integrity risk reads the LIVE record state. Live
 * PostgreSQL 16, the real risk engine.
 *
 * On a40ca76f it read evidence_integrity_snapshots, backfilled once for
 * SIGNED/REPORTED rows and never refreshed; an integrity rejection moves a
 * record to FAILED_HASH_MISMATCH, which was never snapshotted, so the case risk
 * could not report a failed record.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("case risk integrity (live PostgreSQL 16)", () => {
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

  it("a FAILED_HASH_MISMATCH record linked to a case raises the case's integrity risk", async () => {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const caseId = (await prisma.case.create({ data: { name: `risk ${randomUUID().slice(0, 6)}`, teamId: A.teamId, ownerUserId: A.ownerUserId }, select: { id: true } })).id;
    const ev = await prisma.evidence.create({
      data: { title: "rejected", type: "PHOTO", status: "FAILED_HASH_MISMATCH", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId } as never,
      select: { id: true },
    });
    await prisma.caseEvidenceLink.create({ data: { caseId, evidenceId: ev.id } });
    // No snapshot exists for it — exactly the production shape.
    expect(await prisma.evidenceIntegritySnapshot.count({ where: { evidenceId: ev.id } })).toBe(0);

    const { computeCaseRisk } = await import("../src/services/cases/case-risk-engine.service.js");
    const risk = await computeCaseRisk({ teamId: A.teamId, caseId });
    expect((risk as { reasonCodes: string[] }).reasonCodes).toContain("INTEGRITY_FAILED");
  });
});
