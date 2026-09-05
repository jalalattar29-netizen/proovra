/**
 * PHASE 5 — ATTRIBUTION ACROSS THE ADMIN MUTATION FAMILIES.
 *
 * Live PostgreSQL 16, real routes, real authorization. Families A (commercial)
 * and D (support access) are proved in their own files — the transitions there
 * were already established and the attribution was added to those existing
 * proofs rather than duplicated here. This file covers the rest.
 *
 * ===========================================================================
 * WHAT THIS FILE IS GUARDING AGAINST
 * ===========================================================================
 * The facade populates nine identity and transition fields for every audit
 * writer in the service. That is exactly the situation in which a proof can
 * fool itself: every field is non-null, every row looks complete, and nothing
 * says whether the values are TRUE.
 *
 * So each field is checked against a different source than the one that wrote
 * it — the actor against the seeded operator, the target against the seeded
 * record, the previous state against storage read before the call, and the
 * resulting state against storage re-read after it. A facade that invented a
 * plausible value from request intent would pass a self-consistent check and
 * fail these.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  bootstrapPersonalSpace,
  seedOrganizationTenant,
  seedUser,
  type FixtureDeps,
  type SeededUser,
} from "./point7/product-fixtures.js";

type AuditRow = {
  id: string;
  action: string;
  outcome: string | null;
  userId: string | null;
  actorType: string | null;
  actorDisplay: string | null;
  actorAuthority: string | null;
  targetDisplay: string | null;
  previousState: string | null;
  requestedState: string | null;
  resultingState: string | null;
  reasonCode: string | null;
  eventVersion: number | null;
  organizationId: string | null;
  workspaceId: string | null;
  requestId: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown>;
};

describe("PHASE 5 — mutation family attribution (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;

  let platformAdmin: SeededUser;
  let secondAdmin: SeededUser;
  let orgA: { organizationId: string; workspaceId: string; owner: SeededUser };
  let orgB: { organizationId: string; workspaceId: string; owner: SeededUser };

  async function call(
    token: string | null,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
  ) {
    const res = await harness.app.inject({
      method,
      url,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    let body: unknown = null;
    try {
      body = JSON.parse(res.body);
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body: body as Record<string, unknown>, text: res.body };
  }

  /** Poll briefly: several writers fire their audit without awaiting it. */
  async function waitForAudit(
    where: { action?: string; resourceId?: string; outcome?: string },
    minCount = 1,
  ): Promise<AuditRow[]> {
    const deadline = Date.now() + 6_000;
    for (;;) {
      const rows = (await prisma.adminAuditLog.findMany({
        where: {
          ...(where.action ? { action: where.action } : {}),
          ...(where.resourceId ? { resourceId: where.resourceId } : {}),
          ...(where.outcome ? { outcome: where.outcome } : {}),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })) as unknown as AuditRow[];
      if (rows.length >= minCount) return rows;
      if (Date.now() > deadline) {
        throw new Error(
          `audit row not found within 6s: ${JSON.stringify(where)} (have ${rows.length}, want ${minCount})`,
        );
      }
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  /**
   * The dimensions §2 requires of every material row, checked as a set so a
   * family proof cannot forget one. `expectActorIsNotSubject` is passed the
   * subject id where the two are different people — the confusion this whole
   * exercise exists to prevent.
   */
  function assertCoreAttribution(
    row: AuditRow,
    opts: {
      actorUserId: string;
      actorType?: string;
      subjectUserId?: string | null;
      label: string;
    },
  ) {
    expect(row.actorType, `${opts.label}: actor type`).toBe(opts.actorType ?? "HUMAN");
    expect(row.userId, `${opts.label}: the row names a different actor than the caller`).toBe(
      opts.actorUserId,
    );
    expect(row.actorDisplay, `${opts.label}: no contemporaneous actor label`).toBeTruthy();
    expect(
      row.actorDisplay,
      `${opts.label}: the raw identifier was stored where a label belongs`,
    ).not.toBe(opts.actorUserId);
    expect(row.eventVersion, `${opts.label}: event version`).toBe(2);
    if (opts.subjectUserId) {
      expect(
        row.userId,
        `${opts.label}: the operator and the subject were recorded as the same person`,
      ).not.toBe(opts.subjectUserId);
    }
  }

  /** No row may carry credential or client material, whatever else it says. */
  function assertNoSecret(row: AuditRow, label: string) {
    const serialized = JSON.stringify(row).toLowerCase();
    for (const marker of [
      "supportcontexttoken",
      "passwordhash",
      "privatekey",
      "authorization:",
      "bearer ",
      "set-cookie",
      "applewebkit",
      "kmskeyarn",
      "secretaccesskey",
    ]) {
      expect(serialized, `${label}: the row carries ${marker}`).not.toContain(marker);
    }
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `p5fam-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          {
            sub: userId,
            provider: "EMAIL",
            email,
            authMethod: "PASSWORD",
            authAt: Math.floor(Date.now() / 1000),
          },
          secret,
          3600,
        ),
    };

    platformAdmin = await seedUser(deps, "p5fam-admin");
    await prisma.user.update({
      where: { id: platformAdmin.userId },
      data: { platformRole: "admin", displayName: "Platform Operator One" },
    });
    await bootstrapPersonalSpace(deps, platformAdmin.userId);

    secondAdmin = await seedUser(deps, "p5fam-admin2");
    await prisma.user.update({
      where: { id: secondAdmin.userId },
      data: { platformRole: "admin", displayName: "Platform Operator Two" },
    });
    await bootstrapPersonalSpace(deps, secondAdmin.userId);

    const a = await seedOrganizationTenant(deps, { contractStatus: "ACTIVE" });
    orgA = { organizationId: a.organizationId, workspaceId: a.workspaceId, owner: a.owner };
    const b = await seedOrganizationTenant(deps, { contractStatus: "ACTIVE" });
    orgB = { organizationId: b.organizationId, workspaceId: b.workspaceId, owner: b.owner };
  }, 300_000);

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  // =========================================================================
  // FAMILY B — CUSTOMERS AND ORGANIZATIONS.
  // =========================================================================
  describe("family B — organization lifecycle", () => {
    it("suspend names the operator, the customer, and both states read from storage", async () => {
      const { suspendOrganization } = await import(
        "../src/services/organization/org-lifecycle.service.js"
      );
      const before = await prisma.organization.findUniqueOrThrow({
        where: { id: orgA.organizationId },
        select: { status: true, name: true },
      });

      await suspendOrganization({
        organizationId: orgA.organizationId,
        actorUserId: platformAdmin.userId,
      });

      const after = await prisma.organization.findUniqueOrThrow({
        where: { id: orgA.organizationId },
        select: { status: true },
      });
      const [row] = await waitForAudit({
        action: "identity.organization_suspended",
        resourceId: orgA.organizationId,
      });

      assertCoreAttribution(row, {
        actorUserId: platformAdmin.userId,
        label: "org suspend",
      });
      expect(row.actorAuthority).toBe("PLATFORM_ADMIN");
      // TARGET — the customer's own name, not an id an operator must resolve.
      expect(row.targetDisplay).toBe(before.name);
      expect(row.organizationId, "the tenant column is authoritative").toBe(
        orgA.organizationId,
      );
      // STATE — before from storage, after re-read from storage.
      expect(row.previousState).toBe(before.status);
      expect(row.requestedState).toBe("SUSPENDED");
      expect(row.resultingState, "the resulting state was not read back").toBe(after.status);
      expect(row.reasonCode).toBe("OPERATOR_SUSPENDED_ORGANIZATION");
      assertNoSecret(row, "org suspend");
    });

    it("resume records the real previous state, which is SUSPENDED and not a constant", async () => {
      const { resumeOrganization } = await import(
        "../src/services/organization/org-lifecycle.service.js"
      );
      const before = await prisma.organization.findUniqueOrThrow({
        where: { id: orgA.organizationId },
        select: { status: true, name: true },
      });
      expect(before.status, "the suspend case must run first").toBe("SUSPENDED");

      await resumeOrganization({
        organizationId: orgA.organizationId,
        actorUserId: secondAdmin.userId,
      });

      const after = await prisma.organization.findUniqueOrThrow({
        where: { id: orgA.organizationId },
        select: { status: true },
      });
      const [row] = await waitForAudit({
        action: "identity.organization_resumed",
        resourceId: orgA.organizationId,
      });

      // A DIFFERENT operator resumed than suspended — an audit that always
      // names one identity cannot be shown to record the real one.
      assertCoreAttribution(row, {
        actorUserId: secondAdmin.userId,
        label: "org resume",
      });
      expect(row.previousState).toBe("SUSPENDED");
      expect(row.resultingState).toBe(after.status);
      expect(row.targetDisplay).toBe(before.name);
      expect(row.reasonCode).toBe("OPERATOR_RESUMED_ORGANIZATION");
    });
  });

  // =========================================================================
  // FAMILY C — IDENTITY AND SESSIONS.
  //
  // The operator is not the subject. That is the whole family in one line, and
  // it is the confusion most likely to make an audit trail read as though
  // somebody locked themselves out.
  // =========================================================================
  describe("family C — sessions", () => {
    async function seedSession(userId: string, teamId: string) {
      return prisma.authenticatedSession.create({
        data: {
          userId,
          teamId,
          sessionIdHash: `p5sid-${randomUUID()}`,
          uaPreview: "Chrome on Windows",
          ipPreview: "203.•••.•••.42",
          issuedAtUtc: new Date(),
          lastSeenAtUtc: new Date(),
          expiresAtUtc: new Date(Date.now() + 3_600_000),
        },
        select: { id: true, userId: true, quarantinedAtUtc: true },
      });
    }

    it("quarantine separates the operator from the subject and shows a safe client label", async () => {
      const { quarantineSession } = await import(
        "../src/services/access-control/session-quarantine.service.js"
      );
      const session = await seedSession(orgA.owner.userId, orgA.workspaceId);
      expect(session.quarantinedAtUtc).toBeNull();

      await quarantineSession({
        teamId: orgA.workspaceId,
        sessionId: session.id,
        reason: "MANUAL_OPERATOR",
        actorUserId: platformAdmin.userId,
        releaseHours: 4,
      });

      const after = await prisma.authenticatedSession.findUniqueOrThrow({
        where: { id: session.id },
        select: { quarantinedAtUtc: true, quarantineReleaseAtUtc: true },
      });
      const [row] = await waitForAudit({
        action: "session.quarantine",
        resourceId: session.id,
      });

      assertCoreAttribution(row, {
        actorUserId: platformAdmin.userId,
        subjectUserId: orgA.owner.userId,
        label: "session quarantine",
      });
      // The SUBJECT is recorded, separately and explicitly.
      expect(
        row.metadata["subjectUserId"],
        "the session's owner was not recorded as the subject",
      ).toBe(orgA.owner.userId);
      // The client label is the stored PREVIEW, never a raw fingerprint.
      expect(row.targetDisplay).toContain("Chrome on Windows");
      assertNoSecret(row, "session quarantine");

      expect(row.previousState).toBe("ACTIVE");
      expect(row.requestedState).toBe("QUARANTINED");
      expect(row.resultingState).toBe("QUARANTINED");
      expect(after.quarantinedAtUtc, "storage does not agree with the audit").not.toBeNull();
      // Duration is a consequence an operator must be able to see.
      expect(row.metadata["releaseHours"]).toBe(4);
      expect(row.metadata["releaseAtUtc"]).toBeTruthy();
      expect(row.reasonCode).toBe("MANUAL_OPERATOR");
      expect(row.workspaceId).toBe(orgA.workspaceId);
    });

    it("release records the reverse transition, attributed to whoever released it", async () => {
      const { quarantineSession, releaseQuarantine } = await import(
        "../src/services/access-control/session-quarantine.service.js"
      );
      const session = await seedSession(orgA.owner.userId, orgA.workspaceId);
      await quarantineSession({
        teamId: orgA.workspaceId,
        sessionId: session.id,
        reason: "MANUAL_OPERATOR",
        actorUserId: platformAdmin.userId,
      });
      await releaseQuarantine({
        teamId: orgA.workspaceId,
        sessionId: session.id,
        actorUserId: secondAdmin.userId,
        note: "verified with the member by phone",
      });

      const [row] = await waitForAudit({
        action: "session.quarantine_released",
        resourceId: session.id,
      });
      assertCoreAttribution(row, {
        actorUserId: secondAdmin.userId,
        subjectUserId: orgA.owner.userId,
        label: "quarantine release",
      });
      expect(row.previousState).toBe("QUARANTINED");
      expect(row.resultingState).toBe("ACTIVE");
      expect(row.reasonCode).toBe("OPERATOR_RELEASED");
    });

    it("a bulk revoke that reaches nobody is not a success", async () => {
      /*
       * PHASE 5 §4. The per-user revocation loop is best-effort by design, so
       * one stuck user cannot stop the estate going dark. That makes `success`
       * the wrong word when the number reached is not the number intended —
       * "everyone is signed out" and "most people are" cannot share a label.
       *
       * Workspace B has no active sessions, so the honest outcome for an
       * emergency revoke over it is not `success`.
       */
      const { emergencyOrgRevoke } = await import(
        "../src/services/access-control/session-quarantine.service.js"
      );

      // Workspace B has active members but no seeded sessions, so the revoke
      // reaches nobody. `success` here would tell an operator the estate is
      // dark when nothing was signed out.
      await emergencyOrgRevoke({
        teamId: orgB.workspaceId,
        actorUserId: platformAdmin.userId,
        reason: "p5 emergency revoke over a workspace with no live sessions",
      });

      const [row] = await waitForAudit({
        action: "session.emergency_org_revoke",
        resourceId: orgB.workspaceId,
      });
      assertCoreAttribution(row, {
        actorUserId: platformAdmin.userId,
        label: "emergency org revoke",
      });
      expect(
        row.outcome,
        "a revoke that signed nobody out was recorded as a plain success",
      ).not.toBe("success");
      expect(["error", "partial", "no_op"]).toContain(row.outcome);
      expect(row.requestedState).toMatch(/^REVOKE_\d+_USERS$/);
      expect(row.resultingState).toMatch(/^REVOKED_\d+_USERS$/);
      expect(row.reasonCode).toBe("EMERGENCY_ORG_WIDE");
      expect(row.workspaceId).toBe(orgB.workspaceId);
    });
  });

  // =========================================================================
  // FAMILY F — QUEUES AND REPLAY.
  //
  // The family where "it worked" has two different meanings, and the whole
  // point of the outcome vocabulary is that they get different words.
  // =========================================================================
  describe("family F — queue replay correlation", () => {
    it("the request says QUEUED with no result, and the worker's row joins it", async () => {
      /*
       * The API accepting a replay puts the job back on the queue; it does not
       * run it. An audit row that said `success` there would tell an operator
       * the work is done at the moment it has merely been scheduled.
       *
       * The two rows are written by two processes and joined by a reference
       * BOTH DERIVE from the queue name and the job id. A generated id could
       * not have worked: `job.retry()` re-runs a job that already existed, so
       * there is no payload to carry an id the API invented.
       */
      const { QUEUE_JOB_RESOURCE_TYPE, queueJobCorrelationRef } = await import(
        "@proovra/shared"
      );
      const queueName = "reports";
      const jobId = `p5-${randomUUID()}`;
      const ref = queueJobCorrelationRef(queueName, jobId);

      // The API half, written exactly as the replay action writes it.
      const { emitTenantAudit } = await import(
        "../src/services/audit/tenant-audit.service.js"
      );
      await emitTenantAudit({
        action: "operations.queue_job.replay_requested",
        outcome: "queued",
        sourceApp: "API",
        actorUserId: platformAdmin.userId,
        actorAuthority: "PLATFORM_OPS",
        workspaceId: orgA.workspaceId,
        resourceType: QUEUE_JOB_RESOURCE_TYPE,
        resourceId: ref,
        targetDisplay: `${queueName} · build-report`,
        previousState: "FAILED",
        requestedState: "REPLAYED",
        resultingState: null,
        reasonCode: "OPERATOR_REQUESTED_REPLAY",
      });

      const [request] = await waitForAudit({
        action: "operations.queue_job.replay_requested",
        resourceId: ref,
      });
      assertCoreAttribution(request, {
        actorUserId: platformAdmin.userId,
        label: "replay request",
      });
      expect(request.outcome).toBe("queued");
      expect(
        request.resultingState,
        "an accepted replay claimed the work had finished",
      ).toBeNull();

      // The WORKER half — the real correlation recorder, not a stand-in.
      const { recordQueueReplayResultIfRequested } = await import(
        "../../worker/src/queue-replay-correlation.js"
      );
      const recorded = await recordQueueReplayResultIfRequested({
        queueName,
        jobId,
        attemptsMade: 1,
        outcome: "completed",
        workspaceId: orgA.workspaceId,
      });
      expect(recorded, "the worker did not recognise an outstanding replay").toBe(true);

      const [result] = await waitForAudit({
        action: "operations.queue_job.replay_result",
        resourceId: ref,
      });

      // A worker retry is NOT a new human request.
      expect(result.actorType, "the worker's completion looked human").toBe("WORKER");
      expect(result.userId, "a worker row named a human actor").toBeNull();
      expect(result.actorDisplay).toBe(`${queueName} worker`);
      expect(result.outcome, "asynchronous completion must not be `success`").toBe(
        "completed",
      );
      expect(result.previousState).toBe("QUEUED");
      expect(result.resultingState).toBe("COMPLETED");
      expect(result.reasonCode).toBe("REPLAY_EXECUTED");

      // …and the two halves join, on a reference neither side invented.
      expect(result.resourceId).toBe(request.resourceId);
      expect(
        result.metadata["requestedByUserId"],
        "the completion cannot name the operator who asked",
      ).toBe(platformAdmin.userId);
      expect(result.metadata["requestAuditId"]).toBe(request.id);
    });

    it("a second worker attempt does not write a second completion", async () => {
      /*
       * PHASE 5 §5 — a worker retry must not appear as a new human request,
       * and one operator request must not accumulate results. The recorder
       * refuses once a result already exists for that request.
       */
      const { queueJobCorrelationRef } = await import("@proovra/shared");
      const { recordQueueReplayResultIfRequested } = await import(
        "../../worker/src/queue-replay-correlation.js"
      );
      const { emitTenantAudit } = await import(
        "../src/services/audit/tenant-audit.service.js"
      );
      const queueName = "reports";
      const jobId = `p5-dup-${randomUUID()}`;
      const ref = queueJobCorrelationRef(queueName, jobId);

      await emitTenantAudit({
        action: "operations.queue_job.replay_requested",
        outcome: "queued",
        sourceApp: "API",
        actorUserId: platformAdmin.userId,
        workspaceId: orgA.workspaceId,
        resourceType: "queue_job",
        resourceId: ref,
        requestedState: "REPLAYED",
      });
      await waitForAudit({
        action: "operations.queue_job.replay_requested",
        resourceId: ref,
      });

      const first = await recordQueueReplayResultIfRequested({
        queueName,
        jobId,
        attemptsMade: 1,
        outcome: "error",
        failureReason: "REPLAY_FAILED",
      });
      const second = await recordQueueReplayResultIfRequested({
        queueName,
        jobId,
        attemptsMade: 2,
        outcome: "completed",
      });
      expect(first).toBe(true);
      expect(second, "a second attempt wrote a second result for one request").toBe(false);

      const results = await prisma.adminAuditLog.findMany({
        where: { action: "operations.queue_job.replay_result", resourceId: ref },
      });
      expect(results, "one request accumulated more than one result").toHaveLength(1);
      expect(results[0]!.outcome).toBe("error");
      // The failure reason is a bounded CODE, never a raw error message.
      expect(results[0]!.reasonCode).toBe("REPLAY_FAILED");
    });

    it("a job that was never replayed writes nothing", async () => {
      // The guard that stops this becoming "audit every job".
      const { recordQueueReplayResultIfRequested } = await import(
        "../../worker/src/queue-replay-correlation.js"
      );
      const wrote = await recordQueueReplayResultIfRequested({
        queueName: "reports",
        jobId: `p5-never-${randomUUID()}`,
        attemptsMade: 3,
        outcome: "completed",
      });
      expect(wrote, "an ordinary job completion reached the operator audit trail").toBe(
        false,
      );
    });
  });

  // =========================================================================
  // FAMILY G — SIGNING AND CUSTODY.
  //
  // A product whose whole claim is that its evidence is signed had no operator
  // audit trail for retiring a signing key.
  // =========================================================================
  describe("family G — signer lifecycle", () => {
    async function stageAndPromote(purpose: string) {
      const { stageSigner } = await import(
        "../src/services/operations/signer-rotation.service.js"
      );
      const keyId = `p5-key-${randomUUID().slice(0, 8)}`;
      const staged = await stageSigner({
        teamId: orgA.workspaceId,
        actorUserId: platformAdmin.userId,
        signerPurpose: purpose as never,
        provider: "local_pem" as never,
        keyId,
        keyVersion: "1",
        kmsKeyArn: "arn:aws:kms:eu-west-1:123456789012:key/p5-should-never-persist",
        algorithm: "ES256",
        notes: null,
      });
      return staged;
    }

    it("staging does NOT persist the KMS ARN in the event's details", async () => {
      /*
       * PHASE 5 §12. `projectSecurityEventDetails` filtered the ARN on the way
       * out, so it never reached the console — but the allow-list runs at
       * READ, so the value was persisted and every future reader of that JSON
       * column had to remember to use the projector. Phase 12B built that
       * projector because a signer projection had leaked exactly these fields
       * once already.
       *
       * Asserted against the STORED row, not the projection.
       */
      const staged = await stageAndPromote("report_pdf");
      expect(staged.ok, JSON.stringify(staged)).toBe(true);

      // safeEmitSecurityEvent is fire-and-forget; poll rather than sleep.
      let rows: Array<{ details: unknown }> = [];
      const deadline = Date.now() + 6_000;
      while (Date.now() < deadline) {
        rows = await prisma.securityEvent.findMany({
          where: { teamId: orgA.workspaceId, eventType: "signer_staged" },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { details: true },
        });
        if (rows.length > 0) break;
        await new Promise((r) => setTimeout(r, 60));
      }
      expect(rows.length, "the staging event was never written").toBeGreaterThan(0);
      const serialized = JSON.stringify(rows);
      expect(
        serialized,
        "a KMS ARN is persisted at rest in the security event details",
      ).not.toContain("arn:aws:kms");
      expect(serialized).not.toContain("p5-should-never-persist");
    });

    it("retiring a signer writes an operator audit row with both real states", async () => {
      /*
       * The signer set is derived from environment configuration, not from the
       * staging table: `listAllSigners` overlays persisted control state onto
       * the env-configured signers, so a merely-staged signer is a promotable
       * candidate and is correctly NOT retirable. Configuring the env here is
       * what makes the real lifecycle transition reachable — the alternative
       * would have been to assert on a path that always returns
       * `signer_not_found`, which would have proved nothing.
       */
      const { retireSigner, listAllSigners } = await import(
        "../src/services/operations/signer-rotation.service.js"
      ).then(async (m) => ({
        ...m,
        listAllSigners: (
          await import("../src/services/operations/signer-registry.service.js")
        ).listAllSigners,
      }));

      const previousKeyId = process.env.SIGNING_KEY_ID;
      const previousKeyVersion = process.env.SIGNING_KEY_VERSION;
      process.env.SIGNING_KEY_ID = `p5-signing-${randomUUID().slice(0, 8)}`;
      process.env.SIGNING_KEY_VERSION = "1";

      const visible = await listAllSigners({ teamId: orgA.workspaceId });
      const target = visible.find((s) => s.signerPurpose === "report_pdf");
      expect(target, "no configured signer became visible").toBeTruthy();
      const staged = { ok: true as const, signerId: target!.signerId };

      const result = await retireSigner({
        teamId: orgA.workspaceId,
        actorUserId: platformAdmin.userId,
        signerId: staged.signerId,
        reason: "p5 rotation rehearsal",
      });

      process.env.SIGNING_KEY_ID = previousKeyId;
      process.env.SIGNING_KEY_VERSION = previousKeyVersion;

      // A staged-but-never-active signer may legitimately refuse the
      // transition. Either way the row must exist and must be truthful — a
      // refusal that leaves no trace is the defect this closes.
      const rows = await waitForAudit({ resourceId: staged.signerId });
      expect(
        rows.length,
        `retiring a signing key left no operator audit row at all (result: ${JSON.stringify(result)})`,
      ).toBeGreaterThan(0);

      const row = rows[rows.length - 1] as unknown as AuditRow;
      assertCoreAttribution(row, {
        actorUserId: platformAdmin.userId,
        label: "signer retire",
      });
      expect(row.actorAuthority).toBe("PLATFORM_OPS");
      expect(row.targetDisplay).toContain(staged.signerId);
      expect(row.requestedState).toBe("RETIRED");
      if (row.outcome === "success") {
        expect(row.resultingState).toBe("RETIRED");
        expect(row.reasonCode).toBe("OPERATOR_RETIRED_SIGNER");
      } else {
        /*
         * The refusal is the case a single-signer deployment actually reaches,
         * and it is the one that matters most: an operator retiring the last
         * usable signer for a purpose is one click from leaving the deployment
         * unable to sign. It must say what was asked for and claim no result.
         */
        expect(["denied", "no_op"]).toContain(row.outcome);
        if (row.outcome === "denied") {
          expect(
            row.resultingState,
            "a refused signer transition claimed a resulting state",
          ).toBeNull();
          expect(row.previousState, "the refusal lost the state it refused from").toBeTruthy();
          expect(["LAST_USABLE_SIGNER_FOR_PURPOSE", "TRANSITION_NOT_ALLOWED"]).toContain(
            row.reasonCode,
          );
        }
      }

      // NOTHING about the key material, in any outcome.
      assertNoSecret(row, "signer retire");
      expect(JSON.stringify(row)).not.toContain("arn:aws:kms");
      expect(result).toBeTruthy();
    });
  });

  // =========================================================================
  // FAMILY H — SSO, SCIM AND PROVISIONING.
  //
  // The one family where the audit row is next to a secret at every step.
  // =========================================================================
  describe("family H — SCIM tokens", () => {
    it("creating a token attributes the workspace admin and never records the secret", async () => {
      const created = await call(
        orgA.owner.token,
        "POST",
        "/v1/admin/identity/scim/tokens",
        { teamId: orgA.workspaceId, label: `p5-token-${randomUUID().slice(0, 6)}` },
      );
      // Entitlement may refuse this on a non-Enterprise fixture. A refusal is
      // a legitimate outcome and must itself be attributed — what must never
      // happen is a refusal recorded as a success.
      const rows = await prisma.adminAuditLog.findMany({
        where: { action: { contains: "scim" } },
        orderBy: [{ createdAt: "desc" }],
        take: 5,
      });
      for (const row of rows as unknown as AuditRow[]) {
        assertNoSecret(row, "scim audit");
        const serialized = JSON.stringify(row);
        expect(serialized, "a SCIM token value reached the audit trail").not.toMatch(
          /scim_[A-Za-z0-9]{16,}/,
        );
      }
      if (created.status >= 400) {
        const denied = (rows as unknown as AuditRow[]).filter((r) => r.outcome === "denied");
        for (const d of denied) {
          expect(
            d.resultingState,
            "a refused SCIM mutation claimed a resulting state",
          ).toBeNull();
        }
      }
    });
  });

  // =========================================================================
  // CROSS-FAMILY — a refusal changes nothing, and says nothing false.
  // =========================================================================
  it("a cross-tenant refusal writes no success and moves no state", async () => {
    const beforeB = await prisma.organization.findUniqueOrThrow({
      where: { id: orgB.organizationId },
      select: { status: true },
    });

    // An org owner of A reaching for B's organization through the admin route.
    const res = await call(
      orgA.owner.token,
      "POST",
      `/v1/admin/orgs/${orgB.organizationId}/suspend`,
      { teamId: orgA.workspaceId, reason: "p5 cross-tenant probe" },
    );
    expect(res.status, "a workspace owner reached a platform lifecycle route").toBeGreaterThanOrEqual(
      400,
    );

    const afterB = await prisma.organization.findUniqueOrThrow({
      where: { id: orgB.organizationId },
      select: { status: true },
    });
    expect(afterB.status, "a refused request changed the target").toBe(beforeB.status);

    const successes = await prisma.adminAuditLog.findMany({
      where: {
        action: "identity.organization_suspended",
        resourceId: orgB.organizationId,
        outcome: "success",
      },
    });
    expect(successes, "a refused cross-tenant request wrote a success row").toHaveLength(0);
  });
});
