/**
 * Closure 2 ("sem" item 5, PRO-W1-04) — a package OWED after its report
 * committed is recovered without the backfill flag; nothing else is.
 *
 * The stranding (before): a report request commits report vN (stage
 * REPORT_COMMITTED, in the same transaction as the report row), then its
 * package step fails until BullMQ's retry budget is spent, and the request goes
 * FAILED_TERMINAL. The record is REPORTED with no package vN. The only producer
 * that re-asks a missing package — the worker's MISSING PACKAGE pass — ran only
 * with OUTPUT_PACKAGE_RECOVERY_ENABLED=true (default off; production value
 * unknown) or a gate-blocked marker, so the package waited for a person.
 *
 * Live PostgreSQL + Redis, the REAL worker reconciliation and the REAL request
 * writer, with OUTPUT_PACKAGE_RECOVERY_ENABLED unset throughout.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const MIN = 60_000;

describe("sem item 5 — owed package recovery after a committed report (flag off)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let reconcile: typeof import("../../worker/src/first-issuance-reconciliation.js");
  let lifecycle: typeof import("@proovra/shared-runtime");
  const created: string[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    lifecycle = await import("@proovra/shared-runtime");
    lifecycle.registerPrisma(prisma as never);
    reconcile = await import("../../worker/src/first-issuance-reconciliation.js");
  }, 180_000);

  afterAll(async () => {
    if (created.length) {
      await prisma?.evidence
        .updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } })
        .catch(() => undefined);
    }
    await harness?.cleanup();
  });

  beforeEach(() => {
    reconcile.resetFirstIssuanceCursors();
    delete process.env.OUTPUT_PACKAGE_RECOVERY_ENABLED;
    delete process.env.OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED;
  });

  const P = () => harness.fixtures.personal;

  async function setPlan(plan: "FREE" | "PRO") {
    const ent = await prisma.entitlement.findFirst({ where: { userId: P().userId }, select: { id: true } });
    if (ent) await prisma.entitlement.update({ where: { id: ent.id }, data: { plan } });
    else await prisma.entitlement.create({ data: { userId: P().userId, plan } });
  }

  /**
   * A REPORTED record with report v1 and no package, and (unless told
   * otherwise) the report request that committed v1 and then died.
   */
  async function strandedRecord(opts: {
    terminalReason?: string;
    diedMinutesAgo?: number;
    committedRun?: boolean;
    outputsHeld?: boolean;
    lifecycleState?: "ACTIVE" | "ARCHIVED";
  } = {}) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: P().teamId }, select: { organizationId: true } });
    const signedAtUtc = new Date(Date.now() - 3 * 60 * MIN);
    const ev = await prisma.evidence.create({
      data: {
        title: `sem-w104 ${randomUUID().slice(0, 6)}`,
        type: "PHOTO",
        status: "REPORTED",
        teamId: P().teamId,
        organizationId: team.organizationId,
        ownerUserId: P().userId,
        signedAtUtc,
        fingerprintHash: "9".repeat(64),
        fileSha256: "8".repeat(64),
        createdAt: signedAtUtc,
        latestReportVersion: 1,
        ...(opts.outputsHeld ? { outputsHeldAtUtc: new Date() } : {}),
        ...(opts.lifecycleState ? { lifecycleState: opts.lifecycleState } : {}),
      } as never,
      select: { id: true },
    });
    created.push(ev.id);
    await prisma.report.create({
      data: {
        evidenceId: ev.id,
        version: 1,
        storageBucket: "sem-w104",
        storageKey: `reports/${ev.id}/v1.pdf`,
        generatedAtUtc: new Date(Date.now() - 2 * 60 * MIN),
      } as never,
    });
    if (opts.committedRun !== false) {
      await prisma.reportGenerationRequest.create({
        data: {
          teamId: P().teamId,
          evidenceId: ev.id,
          idempotencyKey: `REPORT:${ev.id}:v0`,
          artifactType: "REPORT",
          purpose: "evidence_completed",
          state: "FAILED_TERMINAL",
          stage: "REPORT_COMMITTED",
          reportVersion: 1,
          terminalReasonCode: opts.terminalReason ?? "RETRY_BUDGET_EXHAUSTED",
          requestedByMachineId: "sem-w104-seed",
          completedAtUtc: new Date(Date.now() - (opts.diedMinutesAgo ?? 60) * MIN),
        } as never,
      });
    }
    return ev.id;
  }

  const packageRequests = (evidenceId: string) =>
    prisma.reportGenerationRequest.findMany({
      where: { evidenceId, artifactType: "VERIFICATION_PACKAGE" },
      select: { reportVersion: true, purpose: true, intent: true, state: true },
    });
  const reportRequests = (evidenceId: string) =>
    prisma.reportGenerationRequest.count({ where: { evidenceId, artifactType: "REPORT" } });
  const run = () => reconcile.runFirstIssuanceReconciliation({ trigger: "sem-w104", batchSize: 1000 });

  it("a stranded package (report committed, run died on a technical terminal, rested) is re-asked package-only for exactly that version, with the flag OFF", async () => {
    await setPlan("PRO");
    const id = await strandedRecord();
    const s = await run();
    expect(s.packageOwedRecovered).toBeGreaterThanOrEqual(1);
    const pkgs = await packageRequests(id);
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]).toMatchObject({ reportVersion: 1, purpose: "package_recovery", intent: "RECOVER" });
    // Never a new report: only the dead committed run exists for REPORT.
    expect(await reportRequests(id)).toBe(1);
  });

  it("recovery is idempotent: repeated ticks leave exactly one package request", async () => {
    await setPlan("PRO");
    const id = await strandedRecord();
    await run();
    reconcile.resetFirstIssuanceCursors();
    await run();
    reconcile.resetFirstIssuanceCursors();
    await run();
    expect(await packageRequests(id)).toHaveLength(1);
    expect(await reportRequests(id)).toBe(1);
  });

  it("concurrent ticks (two replicas) issue no double request", async () => {
    await setPlan("PRO");
    const ids = [await strandedRecord(), await strandedRecord()];
    await Promise.all([run(), run(), run()]);
    for (const id of ids) {
      expect(await packageRequests(id), id).toHaveLength(1);
      expect(await reportRequests(id)).toBe(1);
    }
  });

  it("an ineligible record is not issued: not entitled, an integrity terminal, still resting, an output-policy hold, an archived record, or no committed run at all", async () => {
    await setPlan("PRO");
    const integrity = await strandedRecord({ terminalReason: "REPORT_INTEGRITY_MISMATCH" });
    const resting = await strandedRecord({ diedMinutesAgo: 5 });
    const held = await strandedRecord({ outputsHeld: true });
    const archived = await strandedRecord({ lifecycleState: "ARCHIVED" });
    const noCommittedRun = await strandedRecord({ committedRun: false });
    const s = await run();
    for (const id of [integrity, resting, held, archived, noCommittedRun]) {
      expect(await packageRequests(id), id).toEqual([]);
    }
    expect(s.packageOwedNotTechnical).toBeGreaterThanOrEqual(1);
    expect(s.packageOwedResting).toBeGreaterThanOrEqual(1);

    // Not entitled (FREE plan): the same stranded shape gets nothing.
    await setPlan("FREE");
    reconcile.resetFirstIssuanceCursors();
    const free = await strandedRecord();
    await run();
    expect(await packageRequests(free)).toEqual([]);
    await setPlan("PRO");
  });
});
