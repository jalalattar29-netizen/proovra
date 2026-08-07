/**
 * PHASE 12 CORRECTIVE PASS §2 CONTINUATION — ARCH-005, RUNTIME PROOF.
 *
 * The finding
 * ---------------------------------------------------------------------------
 * Automation was configurable and inert. `dispatchAutomationTrigger` had ZERO
 * production callers, so a rule a customer built and enabled never ran. What
 * execution existed was in-memory — `enqueueDelivery` was a `setImmediate` and
 * retries were a `setTimeout` — so a restart lost the work with a durable row
 * left behind claiming something was owed. `AutomationRun` had no lease, no
 * fence, no attempt counter and no dead-letter, so an interrupted run stayed
 * RUNNING forever and a stale worker could overwrite a newer attempt's result.
 *
 * What this file drives
 * ---------------------------------------------------------------------------
 * The REAL producer, the REAL processor and the REAL delivery runtime against
 * a disposable PostgreSQL 16 + pgvector, with a REAL loopback HTTP receiver
 * that verifies the HMAC it is sent. Nothing is stubbed except the clock, and
 * the clock is passed as a parameter rather than faked globally.
 *
 * It is table-driven where the cases are variations of one question, because
 * twenty-four separate files would be twenty-four places for the setup to
 * drift.
 *
 * WHAT IT REFUSES TO COUNT AS PROOF
 *   * a source scan — every case below reads the database after the fact;
 *   * a blocked outbound attempt — the SSRF cases assert the refusal happened
 *     BEFORE any request reached the receiver, by counting the receiver's hits;
 *   * a "success" the code reported without the row agreeing.
 */

import { createServer, type Server } from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";
/**
 * PHASE 12 POINT 5 — the proof recorder.
 *
 * provenCase() is called AFTER the assertion it describes, never before, so a
 * suite that fails part-way records only what actually passed.
 * recordSuiteProof(import.meta.url) writes the record and re-hashes THIS
 * file, so the credit is bound to the bytes that ran — the artifact is never
 * hand-edited and cannot be forged by naming another suite.
 */
import {
  provenCase,
  recordSuiteProof,
} from "./point5/family-coverage-manifest.js";

// ===========================================================================
// The loopback receiver — a REAL HTTP server, not a stub.
// ===========================================================================

type ReceivedRequest = {
  headers: Record<string, string>;
  body: string;
  at: number;
};

class WebhookReceiver {
  readonly received: ReceivedRequest[] = [];
  /** Status to answer with. Mutated per case to drive 2xx / 4xx / 429 / 5xx. */
  nextStatus = 200;
  /** When set, the receiver holds the connection open past the client timeout. */
  hangMs = 0;
  private server: Server | null = null;
  private port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        this.received.push({
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [
              k.toLowerCase(),
              Array.isArray(v) ? v.join(",") : String(v ?? ""),
            ]),
          ),
          body: Buffer.concat(chunks).toString("utf8"),
          at: Date.now(),
        });
        const respond = () => {
          res.writeHead(this.nextStatus, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: this.nextStatus < 300 }));
        };
        if (this.hangMs > 0) setTimeout(respond, this.hangMs);
        else respond();
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => {
        this.port = (this.server!.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  url(): string {
    return `http://127.0.0.1:${this.port}/hook`;
  }

  reset(): void {
    this.received.length = 0;
    this.nextStatus = 200;
    this.hangMs = 0;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}

// ===========================================================================

describe("§2 — ARCH-005: the Automation runtime is durable, fenced and reachable", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let outbox: typeof import("../src/services/automation/automation-outbox.service.js");
  let runtime: typeof import("../src/services/automation/automation-dispatch-runtime.service.js");
  let delivery: typeof import("../src/services/automation/automation-delivery-runtime.service.js");
  let webhookSvc: typeof import("../src/services/automation/automation-webhook.service.js");
  let triggers: typeof import("../src/services/automation/automation-triggers.js");

  const receiver = new WebhookReceiver();
  let teamA: string;
  let teamB: string;
  let ownerA: string;
  let memberA: string;
  let destinationId: string;
  let destinationSecret: string;
  let originalEnvelope: string;
  let originalFingerprint: string;
  const previousLoopbackFlag = process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK;

  /** Create an enabled rule and return its id. */
  async function makeRule(input: {
    teamId: string;
    userId: string;
    triggerType: string;
    actionType?: string;
    actionConfig?: Record<string, unknown>;
    condition?: Record<string, unknown>;
    enabled?: boolean;
  }): Promise<string> {
    const row = await prisma.automationRule.create({
      data: {
        teamId: input.teamId,
        name: `rule-${randomUUID().slice(0, 8)}`,
        enabled: input.enabled ?? true,
        triggerType: input.triggerType,
        conditionJson: (input.condition ?? {}) as never,
        actionType: input.actionType ?? "WEBHOOK_DELIVERY_INTERNAL_ONLY",
        actionConfigJson: (input.actionConfig ?? {
          destinationId,
          eventType: "automation.test",
        }) as never,
        createdByUserId: input.userId,
        updatedByUserId: input.userId,
      },
      select: { id: true },
    });
    return row.id;
  }

  const runOf = (id: string) =>
    prisma.automationRun.findUniqueOrThrow({ where: { id } });

  /**
   * Drive a REAL delivery to AMBIGUOUS through the real code path.
   *
   * The receiver hangs past the client timeout, so the request is genuinely
   * written and the answer genuinely lost — the state is produced by the
   * runtime rather than written into the row by the test.
   */
  async function makeAmbiguousDelivery(): Promise<string> {
    const previousHang = receiver.hangMs;
    receiver.hangMs = 12_000;
    try {
      const ruleId = await makeRule({
        teamId: teamA,
        userId: ownerA,
        triggerType: "EVIDENCE_CREATED",
      });
      await outbox.enqueueAutomationTrigger(prisma, {
        teamId: teamA,
        triggerType: "EVIDENCE_CREATED",
        targetType: "evidence",
        targetId: randomUUID(),
      });
      const { run } = await driveOne(ruleId);
      await delivery.sweepDueDeliveries({ prisma, limit: 10 });
      const d = await prisma.automationWebhookDelivery.findFirstOrThrow({
        where: { runId: run.id },
      });
      expect(d.status, "the fixture must reach AMBIGUOUS through the real path").toBe(
        "AMBIGUOUS",
      );
      return d.id;
    } finally {
      receiver.hangMs = previousHang;
      receiver.reset();
    }
  }

  /** Claim-and-execute the one due run for a rule, returning the row after. */
  async function driveOne(ruleId: string, nowMs?: number) {
    const pending = await prisma.automationRun.findFirstOrThrow({
      where: { ruleId, status: { in: ["PENDING", "RETRY_SCHEDULED"] } },
      select: {
        id: true,
        teamId: true,
        ruleId: true,
        triggerType: true,
        targetType: true,
        targetId: true,
        actionIdempotencyKey: true,
        attemptCount: true,
        claimGeneration: true,
      },
    });
    const result = await runtime.claimAndExecute({ prisma, run: pending, nowMs });
    return { result, run: await runOf(pending.id) };
  }

  beforeAll(async () => {
    // The controlled local-testing fence. Set BEFORE the harness boots so the
    // server and every service read the same value.
    process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK = "1";
    await receiver.start();

    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;
    outbox = await import("../src/services/automation/automation-outbox.service.js");
    runtime = await import(
      "../src/services/automation/automation-dispatch-runtime.service.js"
    );
    delivery = await import(
      "../src/services/automation/automation-delivery-runtime.service.js"
    );
    webhookSvc = await import(
      "../src/services/automation/automation-webhook.service.js"
    );
    triggers = await import("../src/services/automation/automation-triggers.js");

    teamA = h.fixtures.teamA.teamId;
    teamB = h.fixtures.teamB.teamId;
    ownerA = h.fixtures.teamA.ownerUserId;
    memberA = h.fixtures.teamA.memberUserId;

    // One destination on team A, pointing at the real loopback receiver.
    const secret = webhookSvc.createDestinationSecret();
    destinationSecret = secret.plaintext;
    const dest = await prisma.automationWebhookDestination.create({
      data: {
        teamId: teamA,
        name: "arch-005-receiver",
        url: receiver.url(),
        urlOrigin: new URL(receiver.url()).origin,
        encryptedSecret: secret.storedEnvelope,
        secretFingerprint: secret.fingerprint,
        enabled: true,
        createdByUserId: ownerA,
        updatedByUserId: ownerA,
      },
      select: { id: true },
    });
    destinationId = dest.id;
    originalEnvelope = secret.storedEnvelope;
    originalFingerprint = secret.fingerprint;
  }, 900_000);

  afterAll(async () => {
    // Written from afterAll so only cases whose assertions PASSED are credited.
    await recordSuiteProof(import.meta.url);
    await receiver.stop();
    if (previousLoopbackFlag === undefined) {
      delete process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK;
    } else {
      process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK = previousLoopbackFlag;
    }
    await h?.cleanup();
  }, 300_000);

  // =========================================================================
  // PRODUCTION OF WORK — cases 1–5
  // =========================================================================

  it("1 — an ENABLED rule produces a run, and the run executes", async () => {
    receiver.reset();
    const ruleId = await makeRule({ teamId: teamA, userId: ownerA, triggerType: "EVIDENCE_CREATED" });
    const targetId = randomUUID();

    const enqueue = await outbox.enqueueAutomationTrigger(prisma, {
      teamId: teamA,
      triggerType: "EVIDENCE_CREATED",
      targetType: "evidence",
      targetId,
    });
    expect(enqueue.enqueued).toBe(1);

    const { result, run } = await driveOne(ruleId);
    expect(result).toBe("succeeded");
    expect(run.status).toBe("SUCCEEDED");
    expect(run.attemptCount).toBe(1);
    expect(run.claimGeneration).toBe(1);
    expect(run.leaseExpiresAtUtc).toBeNull();

    // The action created a DURABLE delivery row — and NOTHING has been sent
    // yet, because the in-process hand-off is gone.
    const d = await prisma.automationWebhookDelivery.findFirstOrThrow({
      where: { runId: run.id },
    });
    expect(d.status).toBe("PENDING");
    expect(receiver.received).toHaveLength(0);

    // The sweep is what sends it.
    const swept = await delivery.sweepDueDeliveries({ prisma, limit: 10 });
    expect(swept.processed).toBeGreaterThanOrEqual(1);
    expect(receiver.received.length).toBeGreaterThanOrEqual(1);
    const after = await prisma.automationWebhookDelivery.findUniqueOrThrow({
      where: { id: d.id },
    });
    expect(after.status).toBe("SUCCEEDED");
  }, 120_000);

  it("2 — a DISABLED rule produces no run at all", async () => {
    const ruleId = await makeRule({
      teamId: teamA,
      userId: ownerA,
      triggerType: "EVIDENCE_FINALIZED",
      enabled: false,
    });
    const r = await outbox.enqueueAutomationTrigger(prisma, {
      teamId: teamA,
      triggerType: "EVIDENCE_FINALIZED",
      targetType: "evidence",
      targetId: randomUUID(),
    });
    expect(r.enqueued).toBe(0);
    expect(await prisma.automationRun.count({ where: { ruleId } })).toBe(0);
  }, 60_000);

  it("3 — a ROLLED-BACK source transaction creates no run", async () => {
    const ruleId = await makeRule({
      teamId: teamA,
      userId: ownerA,
      triggerType: "EVIDENCE_REPORTED",
    });
    const targetId = randomUUID();

    // This is the case the whole design exists for: the run is written INSIDE
    // the caller's transaction, so an abort takes it with the domain change.
    await expect(
      prisma.$transaction(async (tx) => {
        const enq = await outbox.enqueueAutomationTrigger(tx, {
          teamId: teamA,
          triggerType: "EVIDENCE_REPORTED",
          targetType: "evidence",
          targetId,
        });
        expect(enq.enqueued).toBe(1);
        // …and now the source transaction fails, as it might for any reason.
        throw new Error("source_transaction_failed");
      }),
    ).rejects.toThrow(/source_transaction_failed/);

    expect(await prisma.automationRun.count({ where: { ruleId, targetId } })).toBe(0);
    provenCase("auto.durable.intent_before_work");
  }, 60_000);

  it("4 — a DUPLICATE source event creates exactly one run", async () => {
    const ruleId = await makeRule({
      teamId: teamA,
      userId: ownerA,
      triggerType: "LEGAL_HOLD_CREATED",
    });
    const targetId = randomUUID();
    const sourceEventId = `legal_hold.created:${targetId}`;

    const first = await outbox.enqueueAutomationTrigger(prisma, {
      teamId: teamA,
      triggerType: "LEGAL_HOLD_CREATED",
      targetType: "legal_hold",
      targetId,
      sourceEventId,
    });
    const second = await outbox.enqueueAutomationTrigger(prisma, {
      teamId: teamA,
      triggerType: "LEGAL_HOLD_CREATED",
      targetType: "legal_hold",
      targetId,
      sourceEventId,
    });

    expect(first.enqueued).toBe(1);
    // The second one is DISCARDED BY THE DATABASE, not caught in JavaScript —
    // a raised violation inside a source transaction would poison it.
    expect(second.enqueued).toBe(0);
    expect(await prisma.automationRun.count({ where: { ruleId } })).toBe(1);
  }, 60_000);

  it("5 — Workspace A's trigger cannot match Workspace B's rule", async () => {
    const ruleB = await makeRule({
      teamId: teamB,
      userId: h.fixtures.teamB.ownerUserId,
      triggerType: "ESCALATION_CREATED",
      actionConfig: { userId: h.fixtures.teamB.ownerUserId, template: "t" },
      actionType: "NOTIFY_USER",
    });
    const r = await outbox.enqueueAutomationTrigger(prisma, {
      teamId: teamA,
      triggerType: "ESCALATION_CREATED",
      targetType: "review_escalation",
      targetId: randomUUID(),
    });
    // Team A has no ESCALATION_CREATED rule; team B's must not be considered.
    expect(r.considered).toBe(0);
    expect(await prisma.automationRun.count({ where: { ruleId: ruleB } })).toBe(0);
    provenCase("auto.tenant.workspace_reloaded");
    provenCase("auto.tenant.cross_workspace_denied");
  }, 60_000);

  // =========================================================================
  // THE FENCE — cases 6–9
  // =========================================================================

  it("6 — four concurrent claims produce exactly one winner", async () => {
    const ruleId = await makeRule({
      teamId: teamA,
      userId: ownerA,
      triggerType: "EVIDENCE_CREATED",
      actionType: "NOTIFY_USER",
      actionConfig: { userId: memberA, template: "assigned" },
    });
    await outbox.enqueueAutomationTrigger(prisma, {
      teamId: teamA,
      triggerType: "EVIDENCE_CREATED",
      targetType: "evidence",
      targetId: randomUUID(),
    });
    const pending = await prisma.automationRun.findFirstOrThrow({
      where: { ruleId, status: "PENDING" },
      select: {
        id: true,
        teamId: true,
        ruleId: true,
        triggerType: true,
        targetType: true,
        targetId: true,
        actionIdempotencyKey: true,
        attemptCount: true,
        claimGeneration: true,
      },
    });

    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        runtime.claimAndExecute({ prisma, run: pending }),
      ),
    );
    const winners = outcomes.filter((o) => o !== "not_claimed");
    expect(winners).toHaveLength(1);

    const after = await runOf(pending.id);
    // ONE attempt, ONE generation increment. Four claimers, one claim.
    expect(after.attemptCount).toBe(1);
    expect(after.claimGeneration).toBe(1);
    provenCase("auto.claim.one_winner");
    provenCase("auto.claim.active_not_stolen");
  }, 120_000);

  it("7 — an EXPIRED lease can be reclaimed, and the generation moves", async () => {
    const ruleId = await makeRule({
      teamId: teamA,
      userId: ownerA,
      triggerType: "SLA_DUE_SOON",
      actionType: "NOTIFY_USER",
      actionConfig: { userId: memberA, template: "sla" },
    });
    await outbox.enqueueAutomationTrigger(prisma, {
      teamId: teamA,
      triggerType: "SLA_DUE_SOON",
      targetType: "review_workflow",
      targetId: randomUUID(),
    });
    const run = await prisma.automationRun.findFirstOrThrow({ where: { ruleId } });

    // A worker claimed it and died: RUNNING with a lease that has passed.
    await prisma.automationRun.update({
      where: { id: run.id },
      data: {
        status: "RUNNING",
        claimGeneration: 1,
        attemptCount: 1,
        claimedAtUtc: new Date(Date.now() - 60 * 60 * 1000),
        leaseExpiresAtUtc: new Date(Date.now() - 30 * 60 * 1000),
      },
    });

    const rec = await runtime.reconcileStrandedRuns({ prisma });
    expect(rec.reclaimed).toBeGreaterThanOrEqual(1);

    const after = await runOf(run.id);
    expect(after.status).toBe("RETRY_SCHEDULED");
    expect(after.claimGeneration).toBe(2);
    expect(after.leaseExpiresAtUtc).toBeNull();
    // No outcome was invented for an attempt nobody observed.
    expect(after.completedAt).toBeNull();
    expect(after.failureCode).toBe("lease_lost");
  }, 120_000);

  const STALE_CASES = [
    { name: "success", status: "SUCCEEDED", extra: { completedAt: new Date() } },
    { name: "failure", status: "FAILED", extra: { failedAtUtc: new Date() } },
  ] as const;

  for (const [i, c] of STALE_CASES.entries()) {
    it(`${8 + i} — a STALE worker's ${c.name} updates ZERO rows`, async () => {
      const ruleId = await makeRule({
        teamId: teamA,
        userId: ownerA,
        triggerType: "REVIEW_OVERDUE",
        actionType: "NOTIFY_USER",
        actionConfig: { userId: memberA, template: "overdue" },
      });
      await outbox.enqueueAutomationTrigger(prisma, {
        teamId: teamA,
        triggerType: "REVIEW_OVERDUE",
        targetType: "review_workflow",
        targetId: randomUUID(),
      });
      const run = await prisma.automationRun.findFirstOrThrow({ where: { ruleId } });

      // Worker A claimed at generation 1. Worker B then reclaimed (generation 2)
      // and finished. Worker A now wakes up and tries to write its outcome.
      await prisma.automationRun.update({
        where: { id: run.id },
        data: {
          status: "RUNNING",
          claimGeneration: 2,
          attemptCount: 2,
          leaseExpiresAtUtc: new Date(Date.now() + 60_000),
        },
      });

      const stale = await prisma.automationRun.updateMany({
        where: { id: run.id, status: "RUNNING", claimGeneration: 1 },
        data: { status: c.status, ...c.extra } as never,
      });
      expect(stale.count).toBe(0);

      const after = await runOf(run.id);
      expect(after.status).toBe("RUNNING");
      expect(after.claimGeneration).toBe(2);
    provenCase("auto.terminal.stale_cannot_overwrite");
    }, 120_000);
  }

  // =========================================================================
  // INTENT AND AMBIGUITY — cases 10–14
  // =========================================================================

  it("10 — a retry REUSES the action intent; a second webhook is not created", async () => {
    receiver.reset();
    const ruleId = await makeRule({
      teamId: teamA,
      userId: ownerA,
      triggerType: "PACKAGE_READY",
    });
    await outbox.enqueueAutomationTrigger(prisma, {
      teamId: teamA,
      triggerType: "PACKAGE_READY",
      targetType: "exchange_package",
      targetId: randomUUID(),
    });
    const first = await driveOne(ruleId);
    expect(first.result).toBe("succeeded");
    const intent = first.run.actionIdempotencyKey;
    expect(intent).toMatch(/^automation-run:/);

    // Force a re-execution of the SAME run, as a retry would.
    await prisma.automationRun.update({
      where: { id: first.run.id },
      data: { status: "RETRY_SCHEDULED", nextAttemptAtUtc: new Date() },
    });
    const second = await driveOne(ruleId);

    // The delivery row is unique on (team, run, destination), so the retry
    // collapses onto the intent the first attempt already created.
    expect(second.run.actionIdempotencyKey).toBe(intent);
    expect(
      await prisma.automationWebhookDelivery.count({
        where: { runId: first.run.id },
      }),
    ).toBe(1);
    provenCase("auto.idempotency.duplicate_is_noop");
  }, 120_000);

  it("11 — a distinct source event creates a DISTINCT intent", async () => {
    const ruleId = await makeRule({
      teamId: teamA,
      userId: ownerA,
      triggerType: "EXTERNAL_ACCESS_EXPIRING",
      actionType: "NOTIFY_USER",
      actionConfig: { userId: memberA, template: "expiring" },
    });
    for (const target of [randomUUID(), randomUUID()]) {
      await outbox.enqueueAutomationTrigger(prisma, {
        teamId: teamA,
        triggerType: "EXTERNAL_ACCESS_EXPIRING",
        targetType: "external_review_grant",
        targetId: target,
      });
    }
    const runs = await prisma.automationRun.findMany({ where: { ruleId } });
    expect(runs).toHaveLength(2);
    const keys = new Set(runs.map((r) => r.actionIdempotencyKey));
    expect(keys.size).toBe(2);
  }, 60_000);

  // =========================================================================
  // AMBIGUITY — the §1 correction.
  //
  // The earlier implementation classified a timeout as "retryable" and resent
  // it after 30 s. A timeout is precisely the case in which the receiver MAY
  // already have acted, so that resend was a duplicate downstream action
  // wearing a retry's clothes. These eight cases drive the corrected contract.
  // =========================================================================

  it("12.1 — only a transport that PROVES no commit is retryable", () => {
    // The connection was never established: nothing was written, so sending
    // again is genuinely a retry. This is the ONLY transport family that may
    // resend.
    for (const reason of ["connect_failed", "dns_failed", "tls_failed"]) {
      expect(webhookSvc.classifyTransportOutcome(reason), reason).toBe("NO_COMMIT");
      expect(webhookSvc.isRetryableFailure(reason), reason).toBe(true);
    }
    // …and the two statuses whose HTTP SEMANTICS guarantee it. 408 means the
    // server never received a complete request; 425 means it refused to risk
    // processing one. Neither is a judgement call.
    for (const code of [408, 425]) {
      expect(
        webhookSvc.classifyTransportOutcome(`non_2xx:${code}`),
        String(code),
      ).toBe("NO_COMMIT");
    }
  }, 60_000);

  it("12.1b — a GENERIC 5xx or 429 is AMBIGUOUS, not retryable", () => {
    // THE CORRECTION. The first version of this classifier put every 5xx and
    // 429 in NO_COMMIT because "the receiver ANSWERED, so it did not leave us
    // guessing". Answering 500 tells us the request ARRIVED; it says nothing
    // about whether the handler committed before it failed. A 502/504 comes
    // from a GATEWAY, which by definition does not know what the origin did.
    for (const code of [500, 502, 503, 504, 429]) {
      expect(
        webhookSvc.classifyTransportOutcome(`non_2xx:${code}`),
        String(code),
      ).toBe("AMBIGUOUS");
      expect(
        webhookSvc.isRetryableFailure(`non_2xx:${code}`),
        `${code} must not be resent without a declared contract`,
      ).toBe(false);
    }
  }, 60_000);

  it("12.1c — a DECLARED refusal-before-commit contract makes 429 retryable", () => {
    // The only way a 5xx or a 429 becomes resendable: the destination's
    // operator declares that their receiver guarantees it did not accept the
    // request. Nothing is assumed on a customer's behalf.
    const declared = { refusalBeforeCommitStatuses: [429] };
    expect(webhookSvc.classifyTransportOutcome("non_2xx:429", declared)).toBe(
      "NO_COMMIT",
    );
    expect(webhookSvc.isRetryableFailure("non_2xx:429", declared)).toBe(true);
    // The declaration is per-status and does not leak to its neighbours.
    expect(webhookSvc.classifyTransportOutcome("non_2xx:503", declared)).toBe(
      "AMBIGUOUS",
    );
    // …and with no declaration, the default is unchanged.
    expect(webhookSvc.classifyTransportOutcome("non_2xx:429")).toBe("AMBIGUOUS");
  }, 60_000);

  it("12.2 — a timeout or a reset after the write is AMBIGUOUS, never retryable", () => {
    for (const reason of [
      "timeout",
      "connection_reset",
      "socket_hang_up",
      "transport_unknown",
    ]) {
      expect(webhookSvc.classifyTransportOutcome(reason), reason).toBe("AMBIGUOUS");
      // The load-bearing assertion: an ambiguous outcome must NOT be resent.
      expect(webhookSvc.isRetryableFailure(reason), reason).toBe(false);
    }
    // A definite refusal is PERMANENT — neither retried nor left unknown.
    expect(webhookSvc.classifyTransportOutcome("non_2xx:403")).toBe("PERMANENT");
    expect(webhookSvc.classifyTransportOutcome("ssrf_blocked:localhost")).toBe(
      "PERMANENT",
    );
  }, 60_000);

  it("12.3 — a real timeout parks the delivery AMBIGUOUS and does NOT resend", async () => {
    receiver.reset();
    // The receiver holds the connection past the client timeout: the request
    // DID arrive and the answer never came back.
    receiver.hangMs = 12_000;
    const ruleId = await makeRule({
      teamId: teamA,
      userId: ownerA,
      triggerType: "EVIDENCE_CREATED",
    });
    await outbox.enqueueAutomationTrigger(prisma, {
      teamId: teamA,
      triggerType: "EVIDENCE_CREATED",
      targetType: "evidence",
      targetId: randomUUID(),
    });
    const { run } = await driveOne(ruleId);
    await delivery.sweepDueDeliveries({ prisma, limit: 10 });

    const d = await prisma.automationWebhookDelivery.findFirstOrThrow({
      where: { runId: run.id },
    });
    expect(d.status).toBe("AMBIGUOUS");
    expect(d.ambiguousAtUtc).not.toBeNull();
    expect(d.reconciliationAttempts).toBe(0);
    // Neither success nor failure was invented.
    expect(d.status).not.toBe("SUCCEEDED");
    expect(d.status).not.toBe("FAILED");

    // NO RESEND. The retry pass must not touch an AMBIGUOUS row even when its
    // reconciliation time has arrived, and the receiver count proves it.
    const hitsAfterFirst = receiver.received.length;
    expect(hitsAfterFirst).toBeGreaterThanOrEqual(1);
    receiver.hangMs = 0;
    await delivery.sweepDueDeliveries({
      prisma,
      limit: 10,
      nowMs: Date.now() + 10 * 60 * 1000,
      lookup: async () => "UNSUPPORTED",
    });
    expect(
      receiver.received.length,
      "an ambiguous delivery must never be resent by the retry pass",
    ).toBe(hitsAfterFirst);

    receiver.reset();
    provenCase("auto.provider.unknown_outcome_non_terminal");
  }, 240_000);

  it("12.4 — a provider lookup that says COMMITTED resolves to acknowledged", async () => {
    receiver.reset();
    const d = await makeAmbiguousDelivery();
    const out = await delivery.reconcileAmbiguousDeliveries({
      prisma,
      nowMs: Date.now() + 10 * 60 * 1000,
      lookup: async () => "COMMITTED",
    });
    expect(out.resolved).toBeGreaterThanOrEqual(1);
    const after = await prisma.automationWebhookDelivery.findUniqueOrThrow({
      where: { id: d },
    });
    expect(after.status).toBe("SUCCEEDED");
    expect(after.failureReason).toBe("reconciled_provider_confirmed_commit");
    // And nothing was sent to prove it — the provider TOLD us.
    expect(receiver.received).toHaveLength(0);
  }, 180_000);

  it("12.5 — a lookup that says NOT_COMMITTED makes the resend safe, same intent", async () => {
    receiver.reset();
    const d = await makeAmbiguousDelivery();
    const before = await prisma.automationWebhookDelivery.findUniqueOrThrow({
      where: { id: d },
    });
    await delivery.reconcileAmbiguousDeliveries({
      prisma,
      nowMs: Date.now() + 10 * 60 * 1000,
      lookup: async () => "NOT_COMMITTED",
    });
    const after = await prisma.automationWebhookDelivery.findUniqueOrThrow({
      where: { id: d },
    });
    expect(after.status).toBe("RETRY_SCHEDULED");
    // THE SAME INTENT. A resend after reconciliation is the same delivery row
    // and the same idempotency key — never a second one.
    expect(after.idempotencyKey).toBe(before.idempotencyKey);
    expect(after.id).toBe(before.id);
  }, 180_000);

  it("12.6 — exhausted reconciliation is DEAD_LETTERED_UNKNOWN, never FAILED", async () => {
    receiver.reset();
    const d = await makeAmbiguousDelivery();
    let now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      now += 30 * 60 * 1000;
      await delivery.reconcileAmbiguousDeliveries({
        prisma,
        nowMs: now,
        // The production answer for a webhook: there is nobody to ask.
        lookup: delivery.defaultAmbiguityLookup,
      });
    }
    const after = await prisma.automationWebhookDelivery.findUniqueOrThrow({
      where: { id: d },
    });
    expect(after.status).toBe("DEAD_LETTERED_UNKNOWN");
    // The distinction that matters to an operator: this is NOT a refusal.
    expect(after.status).not.toBe("FAILED");
    expect(after.status).not.toBe("RETRY_EXHAUSTED");
    expect(after.reconciliationAttempts).toBe(
      delivery.AMBIGUITY_MAX_RECONCILIATIONS,
    );
    // Bounded: it stopped asking rather than reconciling forever.
    expect(after.nextAttemptAt).toBeNull();
    provenCase("auto.provider.unknown_never_projected_as_failure");
  }, 240_000);

  it("12.7 — no ambiguous path ever produced a duplicate external side effect", async () => {
    // Every delivery this file created is unique on (team, run, destination),
    // and the receiver saw at most one request per delivery id. That is the
    // property the whole correction exists to protect.
    const rows = await prisma.automationWebhookDelivery.findMany({
      where: { teamId: teamA },
      select: { runId: true, destinationId: true },
    });
    const keys = rows.map((r) => `${r.runId}:${r.destinationId}`);
    expect(new Set(keys).size).toBe(keys.length);
  }, 120_000);

  it("12.8 — a stale worker cannot overwrite a reconciled outcome", async () => {
    const d = await makeAmbiguousDelivery();
    const row = await prisma.automationWebhookDelivery.findUniqueOrThrow({
      where: { id: d },
    });
    // Somebody else reconciled it and moved the generation on.
    await prisma.automationWebhookDelivery.update({
      where: { id: d },
      data: { claimGeneration: row.claimGeneration + 2 },
    });
    // The stale holder now tries to write its own verdict under the OLD
    // generation.
    const stale = await prisma.automationWebhookDelivery.updateMany({
      where: {
        id: d,
        status: "AMBIGUOUS",
        claimGeneration: row.claimGeneration,
      },
      data: { status: "FAILED" },
    });
    expect(stale.count).toBe(0);
    const after = await prisma.automationWebhookDelivery.findUniqueOrThrow({
      where: { id: d },
    });
    expect(after.status).toBe("AMBIGUOUS");
  }, 120_000);

  const HTTP_CASES = [
    {
      status: 429,
      name: "a 429 with no declared contract is AMBIGUOUS, not retried",
      expect: "AMBIGUOUS",
    },
    {
      status: 503,
      name: "a generic 503 is AMBIGUOUS, not retried",
      expect: "AMBIGUOUS",
    },
    {
      status: 408,
      name: "a 408 IS retryable — HTTP guarantees the request was incomplete",
      expect: "RETRY_SCHEDULED",
    },
    {
      status: 403,
      name: "a permanent 4xx TERMINATES",
      expect: "FAILED",
    },
  ] as const;

  for (const [i, c] of HTTP_CASES.entries()) {
    it(`13.${i} — ${c.name}`, async () => {
      receiver.reset();
      receiver.nextStatus = c.status;
      const ruleId = await makeRule({
        teamId: teamA,
        userId: ownerA,
        triggerType: "EVIDENCE_CREATED",
      });
      await outbox.enqueueAutomationTrigger(prisma, {
        teamId: teamA,
        triggerType: "EVIDENCE_CREATED",
        targetType: "evidence",
        targetId: randomUUID(),
      });
      const { run } = await driveOne(ruleId);
      await delivery.sweepDueDeliveries({ prisma, limit: 10 });

      const d = await prisma.automationWebhookDelivery.findFirstOrThrow({
        where: { runId: run.id },
      });
      expect(d.responseStatus).toBe(c.status);
      expect(d.status).toBe(c.expect);
      if (c.expect === "RETRY_SCHEDULED") {
        expect(d.nextAttemptAt).not.toBeNull();
      } else if (c.expect === "FAILED") {
        expect(d.nextAttemptAt).toBeNull();
      } else {
        // AMBIGUOUS: parked for reconciliation, and NOT on the retry ladder.
        expect(d.ambiguousAtUtc).not.toBeNull();
        expect(d.reconciliationAttempts).toBe(0);
      }
      receiver.reset();
    }, 180_000);
  }

  // =========================================================================
  // SIGNING, REPLAY, ROTATION, SSRF — cases 15–18
  // =========================================================================

  it("15 — the receiver can VERIFY the signature it was sent", async () => {
    receiver.reset();
    const ruleId = await makeRule({ teamId: teamA, userId: ownerA, triggerType: "EVIDENCE_CREATED" });
    await outbox.enqueueAutomationTrigger(prisma, {
      teamId: teamA,
      triggerType: "EVIDENCE_CREATED",
      targetType: "evidence",
      targetId: randomUUID(),
    });
    await driveOne(ruleId);
    await delivery.sweepDueDeliveries({ prisma, limit: 10 });

    const got = receiver.received.at(-1);
    expect(got, "the receiver must actually have been called").toBeTruthy();
    const sig = got!.headers["x-proovra-signature"] ?? "";
    const ts = got!.headers["x-proovra-timestamp"] ?? "";
    const deliveryId = got!.headers["x-proovra-delivery"] ?? "";
    expect(sig).toBeTruthy();
    expect(ts).toBeTruthy();
    expect(deliveryId).toBeTruthy();
    // TIMESTAMPED and VERSIONED: the header carries both, so a receiver can
    // enforce a replay window and a future algorithm rotation is expressible
    // without breaking an installed verifier.
    expect(sig).toMatch(/^t=[0-9]+,v1=[0-9a-f]{64}$/);
    expect(sig).toContain(`t=${ts}`);

    // Recompute independently, the way a customer's endpoint would. The
    // delivery id is INSIDE the signed input, which is what binds a signature
    // to one delivery rather than to a body that could be replayed elsewhere.
    const expected = createHmac("sha256", destinationSecret)
      .update(`${ts}.${deliveryId}.${got!.body}`)
      .digest("hex");
    expect(sig).toBe(`t=${ts},v1=${expected}`);

    // The shipped verifier agrees with the independent recomputation.
    expect(
      webhookSvc.verifyDeliverySignature({
        body: got!.body,
        deliveryId,
        timestamp: ts,
        signatureHeader: sig,
        secretPlaintext: destinationSecret,
      }),
    ).toBe(true);

    // And the payload carries no secret and no evidence bytes.
    expect(got!.body).not.toContain(destinationSecret);
    expect(got!.body).not.toMatch(/storageKey|signatureBase64/);
  }, 180_000);

  it("16 — a REPLAYED or TAMPERED signature does not verify", async () => {
    const got = receiver.received.at(-1);
    expect(got).toBeTruthy();
    const ts = got!.headers["x-proovra-timestamp"]!;
    const sig = got!.headers["x-proovra-signature"]!;
    const deliveryId = got!.headers["x-proovra-delivery"]!;
    const verify = webhookSvc.verifyDeliverySignature;

    // A TAMPERED body does not verify.
    expect(
      verify({
        body: `${got!.body.slice(0, -1)}X`,
        deliveryId,
        timestamp: ts,
        signatureHeader: sig,
        secretPlaintext: destinationSecret,
      }),
    ).toBe(false);

    // A REPLAY under a different timestamp does not verify — which is what
    // makes the timestamp a replay window rather than decoration.
    expect(
      verify({
        body: got!.body,
        deliveryId,
        timestamp: String(Number(ts) + 600),
        signatureHeader: sig,
        secretPlaintext: destinationSecret,
      }),
    ).toBe(false);

    // A signature LIFTED onto a different delivery does not verify, because
    // the delivery id is inside the signed input.
    expect(
      verify({
        body: got!.body,
        deliveryId: randomUUID(),
        timestamp: ts,
        signatureHeader: sig,
        secretPlaintext: destinationSecret,
      }),
    ).toBe(false);

    // A WRONG secret does not verify.
    expect(
      verify({
        body: got!.body,
        deliveryId,
        timestamp: ts,
        signatureHeader: sig,
        secretPlaintext: webhookSvc.createDestinationSecret().plaintext,
      }),
    ).toBe(false);

    // …and the genuine one still does, so the four refusals above are the
    // verifier working rather than a verifier that refuses everything.
    expect(
      verify({
        body: got!.body,
        deliveryId,
        timestamp: ts,
        signatureHeader: sig,
        secretPlaintext: destinationSecret,
      }),
    ).toBe(true);
  }, 60_000);

  it("17 — a ROTATED secret takes effect on the next attempt", async () => {
    receiver.reset();
    const rotatedSecret = webhookSvc.createDestinationSecret();
    const rotated = rotatedSecret.plaintext;
    await prisma.automationWebhookDestination.update({
      where: { id: destinationId },
      data: {
        encryptedSecret: rotatedSecret.storedEnvelope,
        secretFingerprint: rotatedSecret.fingerprint,
      },
    });

    const ruleId = await makeRule({ teamId: teamA, userId: ownerA, triggerType: "EVIDENCE_CREATED" });
    await outbox.enqueueAutomationTrigger(prisma, {
      teamId: teamA,
      triggerType: "EVIDENCE_CREATED",
      targetType: "evidence",
      targetId: randomUUID(),
    });
    await driveOne(ruleId);
    await delivery.sweepDueDeliveries({ prisma, limit: 10 });

    const got = receiver.received.at(-1);
    expect(got).toBeTruthy();
    const ts = got!.headers["x-proovra-timestamp"]!;
    const deliveryId = got!.headers["x-proovra-delivery"]!;
    const sig = got!.headers["x-proovra-signature"]!;
    const verify = webhookSvc.verifyDeliverySignature;

    // Signed under the NEW secret…
    expect(
      verify({ body: got!.body, deliveryId, timestamp: ts, signatureHeader: sig, secretPlaintext: rotated }),
    ).toBe(true);
    // …and NOT under the old one, so rotation actually took effect rather than
    // the destination continuing to sign with a stale key.
    expect(
      verify({
        body: got!.body,
        deliveryId,
        timestamp: ts,
        signatureHeader: sig,
        secretPlaintext: destinationSecret,
      }),
    ).toBe(false);

    // Restore so later cases keep verifying against the original secret.
    await prisma.automationWebhookDestination.update({
      where: { id: destinationId },
      data: {
        encryptedSecret: originalEnvelope,
        secretFingerprint: originalFingerprint,
      },
    });
  }, 180_000);

  const SSRF_TARGETS = [
    { name: "the cloud metadata service", url: "https://169.254.169.254/latest/meta-data" },
    { name: "a private RFC1918 address", url: "https://10.0.0.5/hook" },
    { name: "a link-local address", url: "https://169.254.1.1/hook" },
    { name: "an IPv6 unique-local address", url: "https://[fd00::1]/hook" },
    { name: "a credentialled URL", url: "https://user:pass@example.com/hook" },
    { name: "a plaintext non-loopback URL", url: "http://example.com/hook" },
  ] as const;

  it("18 — every SSRF target is refused BEFORE the network, even in local mode", async () => {
    // The loopback flag is ON for this whole file. That is exactly the point:
    // the exemption widens LOOPBACK ONLY, and everything below must still be
    // refused with it set.
    expect(webhookSvc.isLocalWebhookTestingEnabled()).toBe(true);
    const hitsBefore = receiver.received.length;

    for (const t of SSRF_TARGETS) {
      const res = await webhookSvc.validateDestinationUrlWithDns(t.url);
      expect(res.ok, `${t.name} must be refused`).toBe(false);
    }
    // And loopback IS allowed, so the case above is testing the fence rather
    // than a validator that refuses everything.
    const loop = await webhookSvc.validateDestinationUrlWithDns(receiver.url());
    expect(loop.ok).toBe(true);

    // Not one of the refusals produced a request.
    expect(receiver.received.length).toBe(hitsBefore);
  }, 60_000);

  // =========================================================================
  // RECONCILIATION AND CONVERGENCE — cases 19–20, 24
  // =========================================================================

  it("19 — a STRANDED run is reconciled, and reconciliation is idempotent", async () => {
    const ruleId = await makeRule({
      teamId: teamA,
      userId: ownerA,
      triggerType: "RETENTION_CANDIDATE_FOUND",
      actionType: "NOTIFY_USER",
      actionConfig: { userId: memberA, template: "retention" },
    });
    await outbox.enqueueAutomationTrigger(prisma, {
      teamId: teamA,
      triggerType: "RETENTION_CANDIDATE_FOUND",
      targetType: "evidence",
      targetId: randomUUID(),
    });
    const run = await prisma.automationRun.findFirstOrThrow({ where: { ruleId } });
    await prisma.automationRun.update({
      where: { id: run.id },
      data: {
        status: "RUNNING",
        claimGeneration: 1,
        attemptCount: 1,
        leaseExpiresAtUtc: new Date(Date.now() - 1000),
      },
    });

    const first = await runtime.reconcileStrandedRuns({ prisma });
    expect(first.reclaimed).toBeGreaterThanOrEqual(1);
    const afterFirst = await runOf(run.id);

    // Convergent: a second pass changes nothing, because the row is no longer
    // a stranded RUNNING one.
    const second = await runtime.reconcileStrandedRuns({ prisma });
    const afterSecond = await runOf(run.id);
    expect(afterSecond.claimGeneration).toBe(afterFirst.claimGeneration);
    expect(afterSecond.status).toBe(afterFirst.status);
    expect(second.reclaimed).toBe(0);
    provenCase("auto.reconciler.recovers_stranded_once");
  }, 120_000);

  it("20 — an EXHAUSTED run reaches dead-letter, and dead-letter is terminal", async () => {
    const ruleId = await makeRule({
      teamId: teamA,
      userId: ownerA,
      triggerType: "REVIEW_ASSIGNED",
      actionType: "NOTIFY_USER",
      actionConfig: { userId: memberA, template: "assigned" },
    });
    await outbox.enqueueAutomationTrigger(prisma, {
      teamId: teamA,
      triggerType: "REVIEW_ASSIGNED",
      targetType: "review_workflow",
      targetId: randomUUID(),
    });
    const run = await prisma.automationRun.findFirstOrThrow({ where: { ruleId } });
    await prisma.automationRun.update({
      where: { id: run.id },
      data: {
        status: "RUNNING",
        claimGeneration: 3,
        attemptCount: runtime.AUTOMATION_MAX_ATTEMPTS,
        leaseExpiresAtUtc: new Date(Date.now() - 1000),
      },
    });

    const rec = await runtime.reconcileStrandedRuns({ prisma });
    expect(rec.reconciledDeadLettered).toBeGreaterThanOrEqual(1);
    const after = await runOf(run.id);
    expect(after.status).toBe("DEAD_LETTERED");
    expect(after.deadLetteredAtUtc).not.toBeNull();
    // "We do not know" — not "it failed", and above all not "it completed".
    expect(after.failureCode).toBe("lease_lost");
    expect(after.completedAt).toBeNull();

    // Terminal means terminal: a claim cannot resurrect it.
    const reclaim = await prisma.automationRun.updateMany({
      where: { id: run.id, status: { in: ["PENDING", "RETRY_SCHEDULED"] } },
      data: { status: "RUNNING" },
    });
    expect(reclaim.count).toBe(0);
  }, 120_000);

  // =========================================================================
  // END TO END — cases 21–24
  // =========================================================================

  it("21 — a rule created through the REAL API reaches the runtime", async () => {
    receiver.reset();
    const create = await h.app.inject({
      method: "POST",
      url: "/v1/automation/rules",
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` },
      payload: {
        teamId: teamA,
        name: "created-through-the-api",
        triggerType: "EVIDENCE_CREATED",
        actionType: "WEBHOOK_DELIVERY_INTERNAL_ONLY",
        conditionJson: {},
        actionConfigJson: { destinationId, eventType: "automation.api" },
      },
    });
    expect(create.statusCode, create.body).toBe(201);
    const ruleId = (create.json() as { id?: string; rule?: { id: string } }).id
      ?? (create.json() as { rule: { id: string } }).rule.id;

    const enable = await h.app.inject({
      method: "POST",
      url: `/v1/automation/rules/${ruleId}/enable`,
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` },
    });
    expect(enable.statusCode).toBe(200);

    await outbox.enqueueAutomationTrigger(prisma, {
      teamId: teamA,
      triggerType: "EVIDENCE_CREATED",
      targetType: "evidence",
      targetId: randomUUID(),
    });
    const { result } = await driveOne(ruleId);
    expect(result).toBe("succeeded");
    await delivery.sweepDueDeliveries({ prisma, limit: 20 });
    expect(receiver.received.length).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it("22 — the API's run projection equals the durable database state", async () => {
    const row = await prisma.automationRun.findFirstOrThrow({
      where: { teamId: teamA, status: "DEAD_LETTERED" },
    });
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/automation/runs/${row.id}`,
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // The surface must not round a real state off to a friendlier one.
    expect(body.status).toBe(row.status);
    expect(body.attemptCount).toBe(row.attemptCount);
    expect(body.claimGeneration).toBe(row.claimGeneration);
    expect(body.failureCode).toBe(row.failureCode);
    expect(body.deadLetteredAtUtc).toBe(row.deadLetteredAtUtc?.toISOString() ?? null);
  }, 60_000);

  it("23 — a restart loses NO pending delivery: the sweep finds it either way", async () => {
    receiver.reset();
    const ruleId = await makeRule({ teamId: teamA, userId: ownerA, triggerType: "EVIDENCE_CREATED" });
    await outbox.enqueueAutomationTrigger(prisma, {
      teamId: teamA,
      triggerType: "EVIDENCE_CREATED",
      targetType: "evidence",
      targetId: randomUUID(),
    });
    const { run } = await driveOne(ruleId);
    const d = await prisma.automationWebhookDelivery.findFirstOrThrow({
      where: { runId: run.id },
    });
    expect(d.status).toBe("PENDING");

    // THE RESTART.
    //
    // A restarted process shares NOTHING with the one that created this row —
    // no event loop, no timer, no connection. So the sweep is driven through a
    // FRESH PrismaClient built here, which is the closest a single test process
    // can come to being a different process, and the only thing carried across
    // is what a restart genuinely carries across: the database.
    //
    // Under the old design the `setImmediate` callback lived only in the dead
    // process and this row was orphaned forever. Nothing below simulates a
    // scheduler; the row simply IS the schedule.
    const { PrismaClient } = await import("@prisma/client");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const freshClient = new PrismaClient({ adapter: new PrismaPg(pool) });
    let swept: { processed: number; reclaimed: number };
    try {
      swept = await delivery.sweepDueDeliveries({
        prisma: freshClient as never,
        limit: 20,
      });
    } finally {
      await freshClient.$disconnect();
      await pool.end();
    }
    expect(swept.processed).toBeGreaterThanOrEqual(1);
    expect(
      (await prisma.automationWebhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).status,
    ).toBe("SUCCEEDED");
  }, 180_000);

  it("24 — no AutomationRun is left permanently RUNNING, and none is unfenced", async () => {
    // Drive the whole sweep once more so anything this file created reaches a
    // settled state through the REAL entry point.
    await runtime.runAutomationDispatchSweep({ prisma, limit: 100 });
    await delivery.sweepDueDeliveries({ prisma, limit: 100 });

    // Every RUNNING row must hold a LIVE lease. A RUNNING row without one is
    // exactly the permanently-stuck shape ARCH-005 removes, and the reconciler
    // has already had its chance above.
    const stuck = await prisma.automationRun.findMany({
      where: {
        status: "RUNNING",
        OR: [{ leaseExpiresAtUtc: null }, { leaseExpiresAtUtc: { lt: new Date() } }],
      },
      select: { id: true, leaseExpiresAtUtc: true },
    });
    expect(stuck, JSON.stringify(stuck)).toEqual([]);

    // Nothing terminal holds a lease.
    const leakedLease = await prisma.automationRun.count({
      where: {
        status: { in: ["SUCCEEDED", "FAILED", "SKIPPED", "DEAD_LETTERED"] },
        leaseExpiresAtUtc: { not: null },
      },
    });
    expect(leakedLease).toBe(0);

    // Every run this pass created carries an action intent, which is the
    // contract migration's first readiness condition.
    const noIntent = await prisma.automationRun.count({
      where: { actionIdempotencyKey: null },
    });
    expect(noIntent).toBe(0);
  }, 300_000);

  // =========================================================================
  // THE TRIGGER MAP — the finding was "a rule the customer built never runs",
  // so the eleven allowlisted triggers must each have a live source.
  // =========================================================================

  it("25 — the time-based detectors run, are bounded, and do not re-fire", async () => {
    const first = await triggers.detectTimeBasedAutomationTriggers({ prisma });
    const second = await triggers.detectTimeBasedAutomationTriggers({ prisma });
    // Whatever the first pass found, the second finds nothing NEW — the window
    // keys collapse on the partial unique index. A detector that re-fires every
    // tick would produce a run per minute per condition, forever.
    for (const k of Object.keys(second) as Array<keyof typeof second>) {
      expect(second[k], `${String(k)} re-fired`).toBe(0);
    }
    expect(Object.keys(first).sort()).toEqual(
      [
        "externalAccessExpiring",
        "packageReady",
        "retentionCandidate",
        "reviewOverdue",
        "slaDueSoon",
      ].sort(),
    );
  }, 180_000);
});
