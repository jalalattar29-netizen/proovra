/**
 * ET-ACQ-03 — the one-time completion fan-out survives a failure after the
 * finalize commit, and still runs only once. Live PostgreSQL 16.
 *
 * On a40ca76f the evidence.completed webhook, the malware scan and the
 * finalization fan-out ran after the commit and only on the first finalize.
 * When the retention / lock-snapshot step (or a crash) failed after the
 * commit, the retry took the already-finalized path, which returned before
 * them: the record never got a scan or a fan-out.
 *
 * The fixture is a record in exactly that state: SIGNED (committed), its
 * storage lock recorded, the fan-out never run.
 */
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const SCAN_FLAG = "MALWARE_SCANNING_ENABLED";

describe("completion fan-out once (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let completeEvidence: (typeof import("../src/services/evidence-complete.service.js"))["completeEvidence"];
  const created: string[] = [];
  const flagBefore = process.env[SCAN_FLAG];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ completeEvidence } = await import("../src/services/evidence-complete.service.js"));
  }, 180_000);

  afterEach(() => {
    if (flagBefore === undefined) delete process.env[SCAN_FLAG];
    else process.env[SCAN_FLAG] = flagBefore;
  });

  afterAll(async () => {
    if (created.length) {
      await prisma?.fileSecurityScan.deleteMany({ where: { evidenceId: { in: created } } }).catch(() => undefined);
      await prisma?.evidence
        .updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } })
        .catch(() => undefined);
    }
    await h?.cleanup();
  });

  /** SIGNED and locked by a first finalize whose post-commit fan-out never ran. */
  async function committedWithoutFanout(): Promise<{ id: string; ownerUserId: string }> {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const { id } = await prisma.evidence.create({
      data: {
        title: "Fan-out fixture",
        type: "PHOTO",
        status: "SIGNED",
        teamId: A.teamId,
        organizationId: team.organizationId,
        ownerUserId: A.ownerUserId,
        sizeBytes: 1_000n,
        signedAtUtc: new Date(),
        fileSha256: "a".repeat(64),
        storageBucket: "evidence",
        storageKey: `evidence/${randomUUID()}`,
        storageObjectLockMode: "GOVERNANCE",
      } as never,
      select: { id: true },
    });
    created.push(id);
    return { id, ownerUserId: A.ownerUserId };
  }

  const scans = (evidenceId: string) => prisma.fileSecurityScan.count({ where: { evidenceId } });
  const marker = (id: string) =>
    prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: { completionFanoutDoneAtUtc: true },
    });

  it("the retry of a finalize that failed after its commit runs the fan-out; a further duplicate does not", async () => {
    process.env[SCAN_FLAG] = "true";
    const ev = await committedWithoutFanout();

    const retry = await completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId });
    expect(retry.alreadyFinalized).toBe(true);
    expect(await scans(ev.id)).toBe(1);
    expect((await marker(ev.id)).completionFanoutDoneAtUtc).toBeInstanceOf(Date);

    await completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId });
    expect(await scans(ev.id)).toBe(1);
  });

  it("concurrent retries run it exactly once", async () => {
    process.env[SCAN_FLAG] = "true";
    const ev = await committedWithoutFanout();

    await Promise.all(
      Array.from({ length: 5 }, () => completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId })),
    );
    expect(await scans(ev.id)).toBe(1);
  });

  it("a claim whose lease lapsed (a crashed run) is re-driven", async () => {
    process.env[SCAN_FLAG] = "true";
    const ev = await committedWithoutFanout();
    await prisma.evidence.update({
      where: { id: ev.id },
      data: { completionFanoutClaimedAtUtc: new Date(Date.now() - 11 * 60_000) },
    });

    await completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId });
    expect(await scans(ev.id)).toBe(1);
    expect((await marker(ev.id)).completionFanoutDoneAtUtc).toBeInstanceOf(Date);
  });
});
