/**
 * TERMINAL-LOCKOUT CLOSURE (RGA-07) — proven against live PostgreSQL 16.
 *
 * THE DEFECT, reproduced earlier by executing the real writer:
 *   A customer "Issue updated report" (NEW_VERSION) confirm computes the same
 *   `REPORT:<evidenceId>:v<N>:force` idempotency key as an earlier attempt at the
 *   same baseline. When that earlier attempt is a dead TECHNICAL `FAILED_TERMINAL`
 *   row, every later confirm COLLAPSED onto it (deduplicated), enqueued nothing,
 *   and no v(N+1) could ever be created — a permanent customer lockout. Only the
 *   operator path escaped it. The web client could also act on a stale offer.
 *
 * THE FIX (this suite proves it, red path and green path, against real rows):
 *   1. the offer no longer withholds the updated report behind a SETTLED TECHNICAL
 *      terminal (packages/shared evidence-output-lifecycle);
 *   2. the customer NEW_VERSION path asks the writer to supersede a dead TECHNICAL
 *      terminal (output-recovery.service), gated by the fresh offer;
 *   3. the writer starts a fresh request identity, ONCE per ordinal, bounded by
 *      MAX_TERMINAL_SUPERSESSIONS, never over an active request, keeping the dead
 *      row immutable.
 *
 * This runs the REAL requestOutputRecovery, the REAL writer and the REAL offer
 * against disposable PostgreSQL. It records no family-proof credit (see the sibling
 * supersession suite's rationale); it is a behavioural gate in its own right.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MAX_TERMINAL_SUPERSESSIONS } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";

describe("updated-report terminal lockout (RGA-07, live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let writer: typeof import("@proovra/shared-runtime/reports");
  let recovery: typeof import("../src/services/reports/output-recovery.service.js");
  let organizationId: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    writer = await import("@proovra/shared-runtime/reports");
    recovery = await import("../src/services/reports/output-recovery.service.js");

    // Eligibility: the record's workspace is a paid, active TEAM so reports and
    // packages are included (the same lever the recovery suite uses).
    const team = await prisma.team.update({
      where: { id: harness.fixtures.teamA.teamId },
      data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } as never,
      select: { organizationId: true },
    });
    organizationId = team.organizationId;
    await prisma.organization.update({
      where: { id: organizationId },
      data: { status: "ACTIVE" } as never,
    });
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  const SHA = "a".repeat(64);

  /** A fresh REPORTED record with report v1 + package v1 (a complete latest pair). */
  async function seedReportedWithV1(): Promise<string> {
    const evidenceId = randomUUID();
    const { teamId, ownerUserId } = harness.fixtures.teamA;
    await prisma.evidence.create({
      data: {
        id: evidenceId,
        ownerUserId,
        teamId,
        organizationId,
        type: "DOCUMENT",
        status: "REPORTED",
        lifecycleState: "ACTIVE",
        latestReportVersion: 1,
        updatedAt: new Date(),
      } as never,
    });
    const generatedAtUtc = new Date(Date.now() - 60_000);
    await prisma.report.create({
      data: {
        evidenceId,
        version: 1,
        storageBucket: "b",
        storageKey: `reports/${evidenceId}/v1/x.pdf`,
        generatedAtUtc,
        sizeBytes: BigInt(1024),
        pdfSha256: SHA,
        s3VersionId: "v1obj",
        issueKind: "FIRST_ISSUE",
      } as never,
    });
    await prisma.verificationPackage.create({
      data: {
        evidenceId,
        version: 1,
        storageBucket: "b",
        storageKey: `verification/${evidenceId}/v1/x.zip`,
        generatedAtUtc,
        reportVersion: 1,
        reportSha256: SHA,
      } as never,
    });
    return evidenceId;
  }

  function forceKey(evidenceId: string): string {
    return `REPORT:${evidenceId}:v1:force`;
  }

  /** Seed a terminal REPORT request at a given idempotency key, as the worker would. */
  async function seedTerminal(input: {
    evidenceId: string;
    key: string;
    terminalReasonCode: string;
    state?: string;
  }) {
    return prisma.reportGenerationRequest.create({
      data: {
        teamId: harness.fixtures.teamA.teamId,
        evidenceId: input.evidenceId,
        artifactType: "REPORT",
        purpose: "updated_report",
        forceRegenerate: true,
        requestedByUserId: harness.fixtures.teamA.ownerUserId,
        expectedPolicyVersion: 0,
        idempotencyKey: input.key,
        state: input.state ?? "FAILED_TERMINAL",
        terminalReasonCode: input.terminalReasonCode,
        intent: "NEW_VERSION",
        // After report v1 so the projection treats it as a post-report attempt.
        createdAtUtc: new Date(Date.now() - 30_000),
        completedAtUtc: new Date(Date.now() - 30_000),
      } as never,
      select: { id: true, idempotencyKey: true, state: true },
    });
  }

  function newVersion(evidenceId: string, key: string) {
    return recovery.requestOutputRecovery({
      evidenceId,
      actorUserId: harness.fixtures.teamA.ownerUserId,
      intent: "NEW_VERSION",
      clientRequestKey: key,
      purpose: "updated_report",
      regenerateReason: "TSA validated and OTS anchored after report v1",
    });
  }

  async function queuedNewVersions(evidenceId: string) {
    return prisma.reportGenerationRequest.findMany({
      where: { evidenceId, state: "QUEUED", intent: "NEW_VERSION" },
      select: { id: true, idempotencyKey: true },
    });
  }

  // =========================================================================
  // Happy path — a clean updated report enqueues exactly one v2 request.
  // =========================================================================
  it("offers and enqueues a clean updated report (no prior terminal)", async () => {
    const ev = await seedReportedWithV1();
    const res = await newVersion(ev, "nv-" + randomUUID().slice(0, 8));
    expect(res.kind).toBe("accepted");
    const q = await queuedNewVersions(ev);
    expect(q).toHaveLength(1);
    expect(q[0]!.idempotencyKey).toBe(forceKey(ev));
  });

  // =========================================================================
  // RED → GREEN — the lockout.
  // =========================================================================
  it("RED: the old non-superseding writer call still collapses onto a dead technical terminal", async () => {
    const ev = await seedReportedWithV1();
    const dead = await seedTerminal({
      evidenceId: ev,
      key: forceKey(ev),
      terminalReasonCode: "REPORT_RENDER_TIMEOUT",
    });
    // Exactly the call the customer path USED to make (no supersession signal):
    const collapsed = await writer.createReportGenerationRequest(prisma as never, {
      evidenceId: ev,
      purpose: "updated_report",
      artifactType: "REPORT",
      forceRegenerate: true,
      intent: "NEW_VERSION",
      clientRequestKey: "nv-" + randomUUID().slice(0, 8),
      requestedByUserId: harness.fixtures.teamA.ownerUserId,
    });
    expect(collapsed.created).toBe(true);
    if (!collapsed.created) return;
    expect(collapsed.deduplicated).toBe(true);
    expect(collapsed.superseded).toBe(false);
    expect(collapsed.requestId).toBe(dead.id); // returned the DEAD row
    // nothing enqueued
    expect(await queuedNewVersions(ev)).toHaveLength(0);
  });

  it("GREEN: the customer NEW_VERSION path supersedes the dead technical terminal and enqueues v2", async () => {
    const ev = await seedReportedWithV1();
    const dead = await seedTerminal({
      evidenceId: ev,
      key: forceKey(ev),
      terminalReasonCode: "REPORT_RENDER_TIMEOUT",
    });
    const res = await newVersion(ev, "nv-" + randomUUID().slice(0, 8));
    expect(res.kind).toBe("accepted");
    if (res.kind !== "accepted") return;
    expect(res.outcome).toBe("SUPERSEDED");
    const minted = await prisma.reportGenerationRequest.findUnique({
      where: { id: res.requestId! },
      select: { idempotencyKey: true, state: true },
    });
    expect(minted?.idempotencyKey).toBe(`${forceKey(ev)}:s1`);
    expect(minted?.state).toBe("QUEUED");
    // The dead row is immutable history.
    const old = await prisma.reportGenerationRequest.findUnique({
      where: { id: dead.id },
      select: { state: true, terminalReasonCode: true },
    });
    expect(old?.state).toBe("FAILED_TERMINAL");
    expect(old?.terminalReasonCode).toBe("REPORT_RENDER_TIMEOUT");
  });

  // =========================================================================
  // Double-confirm / replay — one v2.
  // =========================================================================
  it("double confirm with the same client key replays to one request", async () => {
    const ev = await seedReportedWithV1();
    const key = "nv-" + randomUUID().slice(0, 8);
    const a = await newVersion(ev, key);
    const b = await newVersion(ev, key);
    expect(a.kind).toBe("accepted");
    expect(b.kind).toBe("accepted");
    if (a.kind !== "accepted" || b.kind !== "accepted") return;
    expect(b.requestId).toBe(a.requestId);
    expect(await queuedNewVersions(ev)).toHaveLength(1);
  });

  // =========================================================================
  // Concurrency — N simultaneous confirms (distinct keys) reserve one version.
  // =========================================================================
  it("concurrent confirms with distinct keys create exactly one v2 request", async () => {
    const ev = await seedReportedWithV1();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => newVersion(ev, "nv-" + randomUUID().slice(0, 8))),
    );
    expect(results.every((r) => r.kind === "accepted")).toBe(true);
    const ids = new Set(
      results.map((r) => (r.kind === "accepted" ? r.requestId : null)).filter(Boolean),
    );
    expect(ids.size).toBe(1); // one durable request
    expect(await queuedNewVersions(ev)).toHaveLength(1);
  });

  // =========================================================================
  // Bounded budget — once the chain reaches the ceiling, it stops (operator).
  // =========================================================================
  it("stops superseding after MAX_TERMINAL_SUPERSESSIONS (no endless retry loop)", async () => {
    const ev = await seedReportedWithV1();
    // Seed a full chain of dead technical terminals: base + :s1.. :s(MAX).
    await seedTerminal({ evidenceId: ev, key: forceKey(ev), terminalReasonCode: "REPORT_RENDER_TIMEOUT" });
    for (let n = 1; n <= MAX_TERMINAL_SUPERSESSIONS; n++) {
      await seedTerminal({
        evidenceId: ev,
        key: `${forceKey(ev)}:s${n}`,
        terminalReasonCode: "REPORT_RENDER_TIMEOUT",
      });
    }
    const res = await newVersion(ev, "nv-" + randomUUID().slice(0, 8));
    // Over budget → the writer collapses onto the terminal head; nothing new queues.
    expect(await queuedNewVersions(ev)).toHaveLength(0);
    if (res.kind === "accepted") {
      // If accepted, it must be the terminal replay, never a fresh QUEUED row.
      expect(res.outcome).not.toBe("ENQUEUED");
    }
  });

  // =========================================================================
  // Not technical — an INTEGRITY terminal is never customer-superseded.
  // =========================================================================
  it("does NOT supersede a non-technical (integrity) terminal", async () => {
    const ev = await seedReportedWithV1();
    await seedTerminal({
      evidenceId: ev,
      key: forceKey(ev),
      terminalReasonCode: "REPORT_INTEGRITY_MISMATCH", // classifies INTEGRITY
    });
    const res = await newVersion(ev, "nv-" + randomUUID().slice(0, 8));
    // The offer withholds the action; nothing new queues.
    expect(await queuedNewVersions(ev)).toHaveLength(0);
    expect(res.kind === "declined" || (res.kind === "accepted" && res.outcome !== "ENQUEUED" && res.outcome !== "SUPERSEDED")).toBe(true);
  });
});
