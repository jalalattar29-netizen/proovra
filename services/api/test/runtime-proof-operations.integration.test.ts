/**
 * BATCH K8 (operations) — runtime proof of the platform-operations and
 * workspace-operations mutations the UI sweep could not drive to success.
 *
 * Every action is proven against a disposable PostgreSQL 16 (and the
 * disposable Redis index this suite owns) through `harness.app.inject` only:
 *
 *   1. the authorized SUCCESS branch, with the payload the real web consumer
 *      sends (`apps/web/app/(app)/admin/platform/*`, `app/(app)/operations`,
 *      `components/command-center/_sections/WorkflowOperationsSection.tsx`,
 *      `lib/uploads/telemetry.ts`) and the durable state the action exists to
 *      change, re-read;
 *   2. the audit record the route writes;
 *   3. an expected refusal with its bounded status/code and no durable effect.
 *
 * PERSONAS
 *   - platform operator: team A's OWNER with `User.platformRole = "admin"` (the
 *     database column `resolvePlatformAdmin` reads) and a verified authenticator
 *     app, so the `/v1/operations/*` step-up gates are satisfied through the
 *     real `/v1/identity-security/step-up/start|check` routes.
 *   - team A's ADMIN: a workspace administrator who is NOT a platform operator.
 *
 * QUEUES
 *   Jobs are placed in the suite's own Redis index with BullMQ directly (a
 *   manual-fetch Worker moves them to `failed`); no worker process runs, so a
 *   retried job stays observable in `waiting`.
 *
 * TOTP codes are single-use per 30s step; each step-up resets the factor's
 * step ledger (`lastUsedAt = null`), standing in for the time a real operator
 * waits between two unrelated actions.
 *
 * Security events written with `safeEmitSecurityEvent` (fire-and-forget in the
 * product) that are SUPPLEMENTARY to a durable effect are awaited with a
 * bounded poll of the real row, never a sleep.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Json = Record<string, unknown>;

describe("K8 operations — platform and workspace operations mutations (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let bullmq: typeof import("bullmq");
  let redis: import("ioredis").default;

  let A: IntegrationHarness["fixtures"]["teamA"];
  let B: IntegrationHarness["fixtures"]["teamB"];
  let operatorId: string;
  let operatorToken: string;
  const secrets = new Map<string, Buffer>();

  const call = (opts: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    token: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) =>
    harness.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });
  const json = (res: { body: string }) => JSON.parse(res.body) as Json;

  /** Bounded wait for a row the product writes fire-and-forget. */
  async function eventually<T>(label: string, read: () => Promise<T | null | undefined>): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`${label} was never written`);
      await new Promise((r) => setImmediate(r));
    }
  }

  async function seedTotp(userId: string): Promise<void> {
    const { sealSecret } = await import("../src/services/security/mfa-secret-storage.js");
    const secret = totp.generateTotpSecretBytes();
    const sealed = sealSecret(secret);
    const now = new Date();
    await prisma.mfaFactor.create({
      data: {
        userId,
        kind: "TOTP",
        status: "ACTIVE",
        label: "Authenticator",
        secretCiphertext: Buffer.from(sealed.ciphertext),
        secretIv: Buffer.from(sealed.iv),
        secretAuthTag: Buffer.from(sealed.authTag),
        secretKekId: sealed.kekId,
        verifiedAtUtc: now,
        enrolledAt: now,
      },
    });
    secrets.set(userId, secret);
  }

  /**
   * The StepUpModal flow: start a challenge bound to exactly the
   * purpose/resource the gate named, answer it with the authenticator code,
   * and return the approved challenge id for the retried request's header.
   */
  async function stepUp(purpose: string, resourceKind: string, resourceId: string): Promise<string> {
    await prisma.mfaFactor.updateMany({
      where: { userId: operatorId, kind: "TOTP", status: "ACTIVE" },
      data: { lastUsedAt: null },
    });
    const started = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      token: operatorToken,
      payload: { teamId: A.teamId, purpose, resourceKind, resourceId },
    });
    expect(started.statusCode, started.body).toBe(200);
    expect(json(started).method).toBe("TOTP");
    const challengeId = (json(started).challenge as { id: string }).id;
    const code = totp.computeTotpCode(
      secrets.get(operatorId)!,
      totp.timeStep(Math.floor(Date.now() / 1000)),
    );
    const checked = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/check",
      token: operatorToken,
      payload: { teamId: A.teamId, challengeId, code },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    return challengeId;
  }
  const stepUpHeader = (id: string) => ({ "x-proovra-step-up-challenge-id": id });

  const PLATFORM_DENIAL = {
    error: { code: "permission_denied", reason: "platform_operations_authority_required" },
  };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    totp = await import("../src/services/security/mfa-totp.js");
    bullmq = await import("bullmq");
    const { default: IORedis } = await import("ioredis");
    redis = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

    A = harness.fixtures.teamA;
    B = harness.fixtures.teamB;
    operatorId = A.ownerUserId;
    operatorToken = A.ownerToken;
    await prisma.user.update({ where: { id: operatorId }, data: { platformRole: "admin" } });
    await seedTotp(operatorId);
  }, 180_000);

  afterAll(async () => {
    if (redis) redis.disconnect();
    if (prisma && operatorId) {
      await prisma.mfaFactor.deleteMany({ where: { userId: operatorId } }).catch(() => null);
    }
    await harness?.cleanup();
  });

  // ===========================================================================
  // /v1/operations/queues/:queueName/jobs/:jobId/{retry,replay,cancel}
  // ===========================================================================

  describe("queue job operations (platform operator)", () => {
    const queues = new Map<string, import("bullmq").Queue>();
    const queue = (name: string) => {
      let q = queues.get(name);
      if (!q) {
        q = new bullmq.Queue(name, { connection: redis });
        queues.set(name, q);
      }
      return q;
    };

    /** A job that really FAILED — fetched by a manual worker and moved to failed. */
    async function failedJob(queueName: string, jobName: string): Promise<string> {
      const q = queue(queueName);
      await q.obliterate({ force: true });
      const added = await q.add(jobName, { teamId: A.teamId }, { attempts: 1, jobId: `k8-${randomUUID()}` });
      const worker = new bullmq.Worker(queueName, null, {
        connection: redis.duplicate(),
        autorun: false,
      });
      try {
        const token = randomUUID();
        const job = await worker.getNextJob(token, { block: false });
        expect(job?.id).toBe(added.id);
        await job!.moveToFailed(new Error("k8 induced failure"), token, false);
      } finally {
        await worker.close();
      }
      expect(await (await q.getJob(added.id!))!.getState()).toBe("failed");
      return added.id!;
    }

    afterAll(async () => {
      for (const q of queues.values()) {
        await q.obliterate({ force: true }).catch(() => null);
        await q.close();
      }
    });

    it("retry: a platform operator re-enqueues a failed SAFE job — job state and the queued audit row re-read", async () => {
      const jobId = await failedJob("search-indexing", "RebuildSearchDocument");
      const url = `/v1/operations/queues/search-indexing/jobs/${jobId}/retry`;
      // The admin queues page body: { teamId, reason, expectedJobName }.
      const payload = { teamId: A.teamId, reason: "k8 index rebuild after outage", expectedJobName: "RebuildSearchDocument" };

      // Refusal first: a workspace ADMIN who is not a platform operator.
      const refused = await call({ method: "POST", url, token: A.adminToken, payload });
      expect(refused.statusCode).toBe(403);
      expect(json(refused)).toEqual(PLATFORM_DENIAL);
      // A platform operator naming a workspace they are not in: concealed.
      const foreign = await call({ method: "POST", url, token: operatorToken, payload: { ...payload, teamId: B.teamId } });
      expect(foreign.statusCode).toBe(404);
      expect(json(foreign)).toEqual({ error: { code: "not_found" } });
      expect(await (await queue("search-indexing").getJob(jobId))!.getState()).toBe("failed");

      const res = await call({ method: "POST", url, token: operatorToken, payload });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).result).toMatchObject({ ok: true, action: "retry", queueName: "search-indexing", jobId });
      expect(await (await queue("search-indexing").getJob(jobId))!.getState()).toBe("waiting");

      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "operations.queue_job.replay_requested", resourceId: `search-indexing:${jobId}` },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).toMatchObject({
        userId: operatorId,
        workspaceId: A.teamId,
        resourceType: "queue_job",
        outcome: "queued",
      });
      expect(audit.metadata).toMatchObject({ action: "retry", category: "safe", reason: payload.reason });
    });

    it("retry of a STEP-UP job without a challenge is refused 401 and leaves the job failed", async () => {
      const jobId = await failedJob("report", "GenerateReport");
      const res = await call({
        method: "POST",
        url: `/v1/operations/queues/report/jobs/${jobId}/retry`,
        token: operatorToken,
        payload: { teamId: A.teamId, reason: "k8 retry without step-up", expectedJobName: "GenerateReport" },
      });
      expect(res.statusCode).toBe(401);
      expect((json(res).error as Json).code).toBe("STEP_UP_REQUIRED");
      expect((json(res).error as Json).purpose).toBe("QUEUE_JOB_REPLAY");
      expect(await (await queue("report").getJob(jobId))!.getState()).toBe("failed");
    });

    it("replay: a step-up job is replayed after an authenticator step-up bound to the job", async () => {
      const jobId = await failedJob("report", "GenerateReport");
      const url = `/v1/operations/queues/report/jobs/${jobId}/replay`;
      const payload = { teamId: A.teamId, reason: "k8 signer outage fixed", expectedJobName: "GenerateReport" };

      const refused = await call({ method: "POST", url, token: A.adminToken, payload });
      expect(refused.statusCode).toBe(403);
      expect(json(refused)).toEqual(PLATFORM_DENIAL);

      // The first attempt names the gate exactly as the StepUpModal reads it.
      const gated = await call({ method: "POST", url, token: operatorToken, payload });
      expect(gated.statusCode).toBe(401);
      const details = (json(gated).error as { details: Json }).details;
      expect(details).toEqual({
        purpose: "QUEUE_JOB_REPLAY",
        resourceKind: "queue_job",
        resourceId: `report:${jobId}`,
      });
      expect(await (await queue("report").getJob(jobId))!.getState()).toBe("failed");

      const challengeId = await stepUp("QUEUE_JOB_REPLAY", "queue_job", `report:${jobId}`);
      const res = await call({ method: "POST", url, token: operatorToken, payload, headers: stepUpHeader(challengeId) });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).result).toMatchObject({ ok: true, action: "replay", queueName: "report", jobId });
      expect(await (await queue("report").getJob(jobId))!.getState()).toBe("waiting");
      expect(
        (await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id: challengeId } })).status,
      ).toBe("CANCELLED"); // a spent approval is marked CANCELLED (single-use)

      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "operations.queue_job.replay_requested", resourceId: `report:${jobId}` },
      });
      expect(audit).toMatchObject({ userId: operatorId, workspaceId: A.teamId, outcome: "queued" });
      expect(audit.metadata).toMatchObject({ action: "replay", category: "requires_step_up", jobName: "GenerateReport" });
    });

    it("replay of a FORBIDDEN job kind is refused 403 replay_forbidden and the job stays failed", async () => {
      const jobId = await failedJob("evidence-purge", "PurgeDeletedEvidenceJob");
      const res = await call({
        method: "POST",
        url: `/v1/operations/queues/evidence-purge/jobs/${jobId}/replay`,
        token: operatorToken,
        payload: { teamId: A.teamId, reason: "k8 forbidden replay", expectedJobName: "PurgeDeletedEvidenceJob" },
      });
      expect(res.statusCode).toBe(403);
      expect((json(res).error as Json).code).toBe("replay_forbidden");
      expect(await (await queue("evidence-purge").getJob(jobId))!.getState()).toBe("failed");
      expect(
        await prisma.adminAuditLog.count({ where: { resourceId: `evidence-purge:${jobId}` } }),
      ).toBe(0);
    });

    it("cancel: a platform operator removes a pending job — the job is gone and the security event records it", async () => {
      const q = queue("mi-exif");
      await q.obliterate({ force: true });
      const added = await q.add("ExifExtraction", { teamId: A.teamId }, { jobId: `k8-${randomUUID()}` });
      const jobId = added.id!;
      const url = `/v1/operations/queues/mi-exif/jobs/${jobId}/cancel`;
      // No web consumer sends cancel; the body is the route's zod schema.
      const payload = { teamId: A.teamId, reason: "k8 duplicate extraction" };

      const refused = await call({ method: "POST", url, token: A.adminToken, payload });
      expect(refused.statusCode).toBe(403);
      expect(json(refused)).toEqual(PLATFORM_DENIAL);
      const missingReason = await call({ method: "POST", url, token: operatorToken, payload: { teamId: A.teamId } });
      expect(missingReason.statusCode).toBe(400);
      expect(await q.getJob(jobId)).toBeTruthy();

      const res = await call({ method: "POST", url, token: operatorToken, payload });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).result).toMatchObject({ ok: true, action: "cancel", queueName: "mi-exif", jobId });
      expect(await q.getJob(jobId)).toBeUndefined();

      const event = await eventually("queue cancel security event", () =>
        prisma.securityEvent.findFirst({
          where: {
            teamId: A.teamId,
            eventType: "queue_job_cancelled",
            details: { path: ["jobId"], equals: jobId },
          },
        }),
      );
      expect(event.details).toMatchObject({
        actorUserId: operatorId,
        action: "cancel",
        queueName: "mi-exif",
        reason: payload.reason,
      });
      // D26 — the cancel is in the canonical audit trail, attributed.
      const audit = await prisma.adminAuditLog.findFirst({
        where: { action: "operations.queue_job.cancelled", resourceId: { contains: jobId } },
      });
      expect(audit).toMatchObject({ userId: operatorId, workspaceId: A.teamId, outcome: "success" });
      expect(
        await prisma.securityEvent.count({
          where: { eventType: "queue_job_replay_succeeded", details: { path: ["jobId"], equals: jobId } },
        }),
      ).toBe(0);

      const again = await call({ method: "POST", url, token: operatorToken, payload });
      expect(again.statusCode).toBe(404);
      expect((json(again).error as Json).code).toBe("job_not_found");
    });
  });

  // ===========================================================================
  // /v1/operations/recovery/validate-restore
  // ===========================================================================

  describe("restore validation (platform operator, step-up)", () => {
    it("runs after step-up; the report is persisted and readable by id before the 200 returns", async () => {
      const url = "/v1/operations/recovery/validate-restore";
      const payload = { teamId: A.teamId };
      const before = await prisma.securityEvent.count({
        where: { teamId: A.teamId, eventType: "recovery_report_generated" },
      });

      const refused = await call({ method: "POST", url, token: A.adminToken, payload });
      expect(refused.statusCode).toBe(403);
      expect(json(refused)).toEqual(PLATFORM_DENIAL);
      const gated = await call({ method: "POST", url, token: operatorToken, payload });
      expect(gated.statusCode).toBe(401);
      expect((json(gated).error as { details: Json }).details).toEqual({
        purpose: "RESTORE_VALIDATION_EXECUTE",
        resourceKind: "recovery_validation",
        resourceId: "restore",
      });
      expect(
        await prisma.securityEvent.count({ where: { teamId: A.teamId, eventType: "recovery_report_generated" } }),
      ).toBe(before);

      const challengeId = await stepUp("RESTORE_VALIDATION_EXECUTE", "recovery_validation", "restore");
      const res = await call({ method: "POST", url, token: operatorToken, payload, headers: stepUpHeader(challengeId) });
      expect(res.statusCode, res.body).toBe(200);
      const report = json(res).report as Json;
      expect(report).toMatchObject({ kind: "restore_validation_report", teamId: A.teamId });
      expect(["passed", "warning", "failed", "unsupported"]).toContain(report.overallOutcome);

      // Read IMMEDIATELY: the page reloads its history right after the 200.
      const listed = await prisma.securityEvent.findFirst({
        where: {
          teamId: A.teamId,
          eventType: "recovery_report_generated",
          details: { path: ["reportId"], equals: report.reportId as string },
        },
      });
      expect(listed, "the 200 returned before the report was recorded").not.toBeNull();
      expect(listed!.details).toMatchObject({ actorUserId: operatorId, kind: "restore_validation_report" });
      const completed = await prisma.securityEvent.findFirst({
        where: {
          teamId: A.teamId,
          eventType: "restore_validation_completed",
          details: { path: ["report", "reportId"], equals: report.reportId as string },
        },
      });
      expect(completed, "the report body was not recorded before the 200").not.toBeNull();
      expect((completed!.details as Json).actorUserId).toBe(operatorId);

      const byId = await call({
        method: "GET",
        url: `/v1/operations/recovery/reports/${report.reportId as string}?teamId=${A.teamId}`,
        token: operatorToken,
      });
      expect(byId.statusCode).toBe(200);
      expect((json(byId).report as Json).reportId).toBe(report.reportId);
    });
  });

  // ===========================================================================
  // /v1/operations/signers/:id/{promote,retire,revoke}
  // ===========================================================================

  describe("signer lifecycle (platform operator, step-up)", () => {
    /** A staged signer, recorded exactly as `stageSigner` records one. */
    async function stagedSigner(): Promise<string> {
      const keyId = `k8-key-${randomUUID().slice(0, 8)}`;
      const signerId = `report_pdf:local_pem:${keyId}:1`;
      await prisma.securityEvent.create({
        data: {
          teamId: A.teamId,
          eventType: "signer_staged",
          severity: "INFO",
          details: {
            actorUserId: operatorId,
            signerId,
            signerPurpose: "report_pdf",
            provider: "local_pem",
            keyId,
            keyVersion: "1",
            algorithm: "ED25519",
            notes: null,
          },
        },
      });
      return signerId;
    }
    const readSigner = async (signerId: string) => {
      const res = await call({
        method: "GET",
        url: `/v1/operations/signers/${encodeURIComponent(signerId)}?teamId=${A.teamId}`,
        token: operatorToken,
      });
      expect(res.statusCode, res.body).toBe(200);
      return json(res).signer as Json;
    };
    const lifecycle = (action: string, signerId: string, token: string, headers?: Record<string, string>) =>
      call({
        method: "POST",
        url: `/v1/operations/signers/${encodeURIComponent(signerId)}/${action}`,
        token,
        // The signer detail panel body: { teamId, reason }.
        payload: { teamId: A.teamId, reason: `k8 ${action} rehearsal` },
        headers,
      });

    it("promote: a staged signer is promoted after step-up and the promotion is recorded before the 200", async () => {
      const signerId = await stagedSigner();
      expect((await readSigner(signerId)).status).toBe("staged");

      const refused = await lifecycle("promote", signerId, A.adminToken);
      expect(refused.statusCode).toBe(403);
      expect(json(refused)).toEqual(PLATFORM_DENIAL);
      const gated = await lifecycle("promote", signerId, operatorToken);
      expect(gated.statusCode).toBe(401);
      expect((json(gated).error as Json).purpose).toBe("SIGNER_PROMOTE");
      expect(
        await prisma.securityEvent.count({
          where: { eventType: "signer_promoted", details: { path: ["signerId"], equals: signerId } },
        }),
      ).toBe(0);

      const challengeId = await stepUp("SIGNER_PROMOTE", "signer", signerId);
      const res = await lifecycle("promote", signerId, operatorToken, stepUpHeader(challengeId));
      expect(res.statusCode, res.body).toBe(200);
      expect((json(res).result as Json).ok).toBe(true);

      // Read IMMEDIATELY: the promotion event IS the durable record.
      const promoted = await prisma.securityEvent.findFirst({
        where: {
          teamId: A.teamId,
          eventType: "signer_promoted",
          details: { path: ["signerId"], equals: signerId },
        },
      });
      expect(promoted, "the 200 returned before the promotion was recorded").not.toBeNull();
      expect(promoted!.details).toMatchObject({
        actorUserId: operatorId,
        signerPurpose: "report_pdf",
        reason: "k8 promote rehearsal",
      });
      expect((await readSigner(signerId)).status).toBe("retiring");
      const timeline = await call({
        method: "GET",
        url: `/v1/operations/signers/${encodeURIComponent(signerId)}/audit?teamId=${A.teamId}`,
        token: operatorToken,
      });
      expect((json(timeline).events as Json[]).map((e) => e.eventType)).toContain("signer_promoted");

      // A signer that was never staged is not promotable.
      const missingId = `report_pdf:local_pem:k8-absent-${randomUUID().slice(0, 6)}:1`;
      const missingChallenge = await stepUp("SIGNER_PROMOTE", "signer", missingId);
      const missing = await lifecycle("promote", missingId, operatorToken, stepUpHeader(missingChallenge));
      expect(missing.statusCode).toBe(404);
      expect((json(missing).error as Json).code).toBe("staged_not_found");
    });

    it("retire: a listed staged signer is retired — persisted control state and the operator audit row", async () => {
      const signerId = await stagedSigner();
      const refused = await lifecycle("retire", signerId, A.adminToken);
      expect(refused.statusCode).toBe(403);
      expect(json(refused)).toEqual(PLATFORM_DENIAL);

      const challengeId = await stepUp("SIGNER_RETIRE", "signer", signerId);
      const res = await lifecycle("retire", signerId, operatorToken, stepUpHeader(challengeId));
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).result).toMatchObject({ ok: true, state: "changed", status: "RETIRED" });

      const row = await prisma.signerControlState.findUniqueOrThrow({ where: { signerId } });
      expect(row).toMatchObject({
        status: "RETIRED",
        actorUserId: operatorId,
        reason: "k8 retire rehearsal",
        transitionSource: "admin_console",
      });
      expect((await readSigner(signerId)).status).toBe("retired");
      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "operations.signer.retired", resourceId: signerId },
      });
      expect(audit).toMatchObject({
        userId: operatorId,
        workspaceId: A.teamId,
        resourceType: "signer",
        outcome: "success",
        previousState: "ACTIVE",
        requestedState: "RETIRED",
        resultingState: "RETIRED",
      });

      // Retiring the LAST usable env signer for a purpose is refused 409.
      const envSigner = ((await call({
        method: "GET",
        url: `/v1/operations/signers?teamId=${A.teamId}`,
        token: operatorToken,
      }).then(json)).signers as Json[]).find(
        (s) => s.signerPurpose === "export_manifest" && s.teamId === null,
      )!;
      const lastId = envSigner.signerId as string;
      const lastChallenge = await stepUp("SIGNER_RETIRE", "signer", lastId);
      const last = await lifecycle("retire", lastId, operatorToken, stepUpHeader(lastChallenge));
      expect(last.statusCode).toBe(409);
      expect((json(last).error as Json).code).toBe("last_active_signer");
      expect((await prisma.signerControlState.findUniqueOrThrow({ where: { signerId: lastId } })).status).toBe("ACTIVE");
    });

    it("revoke: a listed staged signer is revoked; a repeat is a no-op and retiring it is refused", async () => {
      const signerId = await stagedSigner();
      const refused = await lifecycle("revoke", signerId, A.adminToken);
      expect(refused.statusCode).toBe(403);
      expect(json(refused)).toEqual(PLATFORM_DENIAL);

      const challengeId = await stepUp("SIGNER_REVOKE", "signer", signerId);
      const res = await lifecycle("revoke", signerId, operatorToken, stepUpHeader(challengeId));
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).result).toMatchObject({ ok: true, state: "changed", status: "REVOKED" });
      const row = await prisma.signerControlState.findUniqueOrThrow({ where: { signerId } });
      expect(row).toMatchObject({ status: "REVOKED", actorUserId: operatorId, reason: "k8 revoke rehearsal" });
      expect((await readSigner(signerId)).status).toBe("revoked");
      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "operations.signer.revoked", resourceId: signerId, outcome: "success" },
      });
      expect(audit).toMatchObject({
        userId: operatorId,
        workspaceId: A.teamId,
        previousState: "ACTIVE",
        resultingState: "REVOKED",
      });

      const retireChallenge = await stepUp("SIGNER_RETIRE", "signer", signerId);
      const retire = await lifecycle("retire", signerId, operatorToken, stepUpHeader(retireChallenge));
      expect(retire.statusCode).toBe(409);
      expect((json(retire).error as Json).code).toBe("transition_not_allowed");
      expect((await prisma.signerControlState.findUniqueOrThrow({ where: { signerId } })).stateVersion).toBe(
        row.stateVersion,
      );
    });
  });

  // ===========================================================================
  // /v1/operations/custody-attestations/backfill
  // ===========================================================================

  describe("custody attestation backfill (platform operator, step-up)", () => {
    it("signs every unattested custody event of the workspace, records each before the 200, and never signs twice", async () => {
      const seeded = [];
      for (const sequence of [1, 2]) {
        seeded.push(
          await prisma.custodyEvent.create({
            data: {
              evidenceId: A.evidenceId,
              eventType: "EVIDENCE_CREATED",
              atUtc: new Date(Date.now() - sequence * 1000),
              sequence,
              eventHash: `${"a".repeat(63)}${sequence}`,
            },
            select: { id: true },
          }),
        );
      }
      const ids = seeded.map((s) => s.id);
      const attestationsFor = () =>
        prisma.securityEvent.findMany({
          where: { teamId: A.teamId, eventType: "custody_attestation_signed" },
          select: { details: true },
        }).then((rows) =>
          rows.filter((r) => ids.includes((r.details as Json).custodyEventId as string)),
        );
      const url = "/v1/operations/custody-attestations/backfill";
      // The signers page body: { teamId, batchSize: 50 }.
      const payload = { teamId: A.teamId, batchSize: 50 };

      const refused = await call({ method: "POST", url, token: A.adminToken, payload });
      expect(refused.statusCode).toBe(403);
      expect(json(refused)).toEqual(PLATFORM_DENIAL);
      const gated = await call({ method: "POST", url, token: operatorToken, payload });
      expect(gated.statusCode).toBe(401);
      expect((json(gated).error as Json).purpose).toBe("CUSTODY_ATTESTATION_BACKFILL");
      expect(await attestationsFor()).toHaveLength(0);

      const challengeId = await stepUp("CUSTODY_ATTESTATION_BACKFILL", "custody_attestation_backfill", "batch");
      const res = await call({ method: "POST", url, token: operatorToken, payload, headers: stepUpHeader(challengeId) });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).result).toMatchObject({ scanned: 2, signed: 2, skipped: 0, failed: 0 });

      // Read IMMEDIATELY: "signed: 2" must mean two recorded attestations.
      const recorded = await attestationsFor();
      expect(recorded, "the 200 counted attestations that were not recorded").toHaveLength(2);
      for (const r of recorded) {
        const d = r.details as Json;
        expect(d.actorUserId).toBe(operatorId);
        expect(d.signerId).toBe("custody_event:local_pem:point7_test_ed25519:1");
        expect(d.canonicalPayloadHash).toMatch(/^[a-f0-9]{64}$/);
        expect((d.attestation as Json).signature).toEqual(expect.any(String));
      }
      const completed = await prisma.securityEvent.findFirst({
        where: { teamId: A.teamId, eventType: "custody_attestation_backfill_completed" },
        orderBy: { createdAt: "desc" },
      });
      expect(completed?.details).toMatchObject({ actorUserId: operatorId, scanned: 2, signed: 2 });

      // A second batch finds both already attested and signs nothing.
      const secondChallenge = await stepUp("CUSTODY_ATTESTATION_BACKFILL", "custody_attestation_backfill", "batch");
      const second = await call({ method: "POST", url, token: operatorToken, payload, headers: stepUpHeader(secondChallenge) });
      expect(second.statusCode).toBe(200);
      expect(json(second).result).toMatchObject({ scanned: 2, signed: 0, skipped: 2, failed: 0 });
      expect(await attestationsFor()).toHaveLength(2);
    });
  });

  // ===========================================================================
  // /v1/ops/incidents/:id/remediate
  // ===========================================================================

  describe("incident remediation (workspace operator)", () => {
    it("an ADMIN resumes OTS anchoring: work queued in Redis, the incident timeline and audit written, the incident stays OPEN", async () => {
      const incident = await prisma.operationalIncident.create({
        data: {
          teamId: A.teamId,
          scope: "WORKSPACE",
          sourceId: "evidence_integrity.ots_failed",
          category: "EVIDENCE_INTEGRITY",
          severity: "HIGH",
          status: "OPEN",
          fingerprint: `ots_failure:${A.evidenceId}`,
          title: "Anchoring failed",
          safeSummary: "The OpenTimestamps upgrade failed.",
          relatedEvidenceId: A.evidenceId,
        } as never,
        select: { id: true },
      });
      const url = `/v1/ops/incidents/${incident.id}/remediate`;
      // The operations page body: { teamId, actionId }.
      const payload = { teamId: A.teamId, actionId: "ots.resume_anchoring" };
      const otsQueue = new bullmq.Queue("ots-upgrade", { connection: redis });
      try {
        await otsQueue.obliterate({ force: true });

        // VIEWER holds operations.view but not evidence.publish_verify.
        const viewer = await call({ method: "POST", url, token: A.viewerToken, payload });
        expect(viewer.statusCode).toBe(403);
        expect(json(viewer)).toEqual({ error: { code: "remediation_not_permitted" } });
        // Another tenant's owner naming this workspace: concealed.
        const foreign = await call({ method: "POST", url, token: B.ownerToken, payload });
        expect(foreign.statusCode).toBe(404);
        expect(json(foreign)).toEqual({ error: { code: "not_found" } });
        // …and naming their own workspace: this incident is not theirs to act on.
        const crossed = await call({ method: "POST", url, token: B.ownerToken, payload: { ...payload, teamId: B.teamId } });
        expect(crossed.statusCode).toBe(403);
        expect((json(crossed).remediation as Json).result).toBe("REFUSED");
        const unknown = await call({ method: "POST", url, token: A.adminToken, payload: { ...payload, actionId: "tsa.retry" } });
        expect(unknown.statusCode).toBe(400);
        expect(await otsQueue.getJobCounts()).toMatchObject({ waiting: 0, delayed: 0 });
        expect(
          await prisma.operationalIncidentEvent.count({ where: { incidentId: incident.id, eventType: "remediation_queued" } }),
        ).toBe(0);

        const res = await call({ method: "POST", url, token: A.adminToken, payload });
        expect(res.statusCode, res.body).toBe(202);
        const remediation = json(res).remediation as Json;
        expect(remediation.result).toBe("QUEUED");
        const jobId = remediation.reference as string;
        expect(jobId).toContain(A.evidenceId);

        const job = await otsQueue.getJob(jobId);
        expect(job?.name).toBe("UpgradeOts");
        expect(["waiting", "delayed"]).toContain(await job!.getState());
        const timeline = await prisma.operationalIncidentEvent.findFirstOrThrow({
          where: { incidentId: incident.id, eventType: "remediation_queued" },
        });
        expect(timeline.safeMessage).toContain("Resume OTS anchoring");
        const row = await prisma.operationalIncident.findUniqueOrThrow({ where: { id: incident.id } });
        expect(row.status).toBe("OPEN");
        expect(row.resolvedAtUtc).toBeNull();

        const audits = await prisma.adminAuditLog.findMany({
          where: { action: "operations.remediation.ots.resume_anchoring", resourceId: incident.id },
          orderBy: { createdAt: "asc" },
        });
        const success = audits.find((a) => a.outcome === "success");
        expect(success).toMatchObject({
          userId: A.adminUserId,
          workspaceId: A.teamId,
          resourceType: "operational_incident",
        });
        expect(success!.metadata).toMatchObject({ result: "QUEUED", evidenceId: A.evidenceId, reference: jobId });
        // The cross-tenant attempt never reached the executor under team A.
        expect(audits.filter((a) => a.workspaceId === A.teamId)).toHaveLength(1);
      } finally {
        await otsQueue.obliterate({ force: true }).catch(() => null);
        await otsQueue.close();
      }
    });
  });

  // ===========================================================================
  // /v1/ops/workflows/:id/schedule-retry
  // ===========================================================================

  describe("workflow schedule-retry (workspace operator)", () => {
    it("an ADMIN schedules a retry — nextRetryAtUtc/retryCount, the workflow event and the audit row re-read", async () => {
      const workflow = await prisma.operationalWorkflow.create({
        data: {
          teamId: A.teamId,
          workflowKey: `k8-report-retry-${randomUUID()}`,
          workflowType: "REPORT_RETRY",
          title: "Report generation failed",
          safeSummary: "A report job failed and needs another attempt.",
          evidenceId: A.evidenceId,
        },
      });
      const url = `/v1/ops/workflows/${workflow.id}/schedule-retry`;
      const at = new Date(Date.now() + 60 * 60_000).toISOString();
      // The Command Center row action body.
      const payload = {
        teamId: A.teamId,
        expectedVersion: workflow.updatedAt.toISOString(),
        idempotencyKey: `k8-${randomUUID()}`,
        nextRetryAtUtc: at,
      };

      const viewer = await call({ method: "POST", url, token: A.viewerToken, payload });
      expect(viewer.statusCode).toBe(403);
      expect(json(viewer).error).toMatchObject({
        code: "permission_denied",
        requiredPermission: "operations.acknowledge",
      });
      // Another tenant's owner — whichever workspace they name — learns nothing.
      for (const teamId of [A.teamId, B.teamId]) {
        const foreign = await call({ method: "POST", url, token: B.ownerToken, payload: { ...payload, teamId } });
        expect(foreign.statusCode).toBe(404);
      }
      const stale = await call({
        method: "POST",
        url,
        token: A.adminToken,
        payload: { ...payload, expectedVersion: new Date(0).toISOString() },
      });
      expect(stale.statusCode).toBe(409);
      expect((json(stale).error as Json).code).toBe("stale_workflow_state");
      const untouched = await prisma.operationalWorkflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(untouched.retryCount).toBe(0);
      expect(untouched.nextRetryAtUtc).toBeNull();

      const res = await call({ method: "POST", url, token: A.adminToken, payload });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toMatchObject({ applied: true, idempotentReplay: false });

      const after = await prisma.operationalWorkflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(after.nextRetryAtUtc?.toISOString()).toBe(at);
      expect(after.retryCount).toBe(1);
      expect(after.lastAttemptAtUtc).not.toBeNull();
      const event = await prisma.operationalWorkflowEvent.findFirstOrThrow({
        where: { workflowId: workflow.id, eventType: "RETRY_SCHEDULED" },
      });
      expect(event.actorUserId).toBe(A.adminUserId);
      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "observability.workflow.retry_scheduled", resourceId: workflow.id },
      });
      expect(audit).toMatchObject({
        userId: A.adminUserId,
        workspaceId: A.teamId,
        resourceType: "operational_workflow",
        outcome: "success",
      });

      // The same idempotency key replays instead of scheduling a second retry.
      const replay = await call({
        method: "POST",
        url,
        token: A.adminToken,
        payload: { ...payload, expectedVersion: after.updatedAt.toISOString() },
      });
      expect(replay.statusCode).toBe(200);
      expect(json(replay)).toMatchObject({ applied: false, idempotentReplay: true });
      expect((await prisma.operationalWorkflow.findUniqueOrThrow({ where: { id: workflow.id } })).retryCount).toBe(1);
    });
  });

  // ===========================================================================
  // /v1/ops/saved-views (POST, PATCH, DELETE)
  // ===========================================================================

  describe("operations saved views", () => {
    it("POST: an ADMIN saves a shared view — row and audit re-read; a MEMBER is refused a shared one", async () => {
      const name = `k8-open-high-${randomUUID().slice(0, 8)}`;
      // The operations page body: { teamId, name, visibility, filter: { teamId, ...set filters } }.
      const payload = {
        teamId: A.teamId,
        name,
        visibility: "TEAM",
        filter: { teamId: A.teamId, status: "OPEN", severity: "HIGH" },
      };
      const member = await call({ method: "POST", url: "/v1/ops/saved-views", token: A.memberToken, payload });
      expect(member.statusCode).toBe(403);
      expect(json(member)).toEqual({ error: { code: "not_permitted" } });
      const foreign = await call({ method: "POST", url: "/v1/ops/saved-views", token: B.ownerToken, payload });
      expect(foreign.statusCode).toBe(404);
      expect(await prisma.savedSearchView.count({ where: { teamId: A.teamId, name } })).toBe(0);

      const res = await call({ method: "POST", url: "/v1/ops/saved-views", token: A.adminToken, payload });
      expect(res.statusCode, res.body).toBe(201);
      const view = json(res).view as Json;
      const row = await prisma.savedSearchView.findUniqueOrThrow({ where: { id: view.id as string } });
      expect(row).toMatchObject({ teamId: A.teamId, createdByUserId: A.adminUserId, name, visibility: "TEAM" });
      expect(row.queryJson).toMatchObject({ teamId: A.teamId, status: "OPEN", severity: "HIGH" });
      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "operations.saved_view.created", resourceId: row.id },
      });
      expect(audit).toMatchObject({
        userId: A.adminUserId,
        workspaceId: A.teamId,
        resourceType: "operations_saved_view",
        outcome: "success",
      });
    });

    async function sharedView(): Promise<{ id: string; updatedAt: string }> {
      const res = await call({
        method: "POST",
        url: "/v1/ops/saved-views",
        token: A.adminToken,
        payload: {
          teamId: A.teamId,
          name: `k8-view-${randomUUID().slice(0, 8)}`,
          visibility: "TEAM",
          filter: { teamId: A.teamId, status: "OPEN" },
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return json(res).view as { id: string; updatedAt: string };
    }

    it("PATCH: the ADMIN renames a shared view — name re-read and a renamed audit row; a VIEWER and a stale token are refused", async () => {
      const view = await sharedView();
      const url = `/v1/ops/saved-views/${view.id}`;
      const newName = `k8-renamed-${randomUUID().slice(0, 8)}`;
      // The operations page body: { teamId, expectedUpdatedAt, name }.
      const payload = { teamId: A.teamId, expectedUpdatedAt: view.updatedAt, name: newName };

      const viewer = await call({ method: "PATCH", url, token: A.viewerToken, payload });
      expect(viewer.statusCode).toBe(403);
      expect(json(viewer)).toEqual({ error: { code: "not_permitted" } });
      const foreign = await call({ method: "PATCH", url, token: B.ownerToken, payload: { ...payload, teamId: B.teamId } });
      expect(foreign.statusCode).toBe(404);
      const stale = await call({
        method: "PATCH",
        url,
        token: A.adminToken,
        payload: { ...payload, expectedUpdatedAt: new Date(0).toISOString() },
      });
      expect(stale.statusCode).toBe(409);
      expect((await prisma.savedSearchView.findUniqueOrThrow({ where: { id: view.id } })).name).not.toBe(newName);

      const res = await call({ method: "PATCH", url, token: A.adminToken, payload });
      expect(res.statusCode, res.body).toBe(200);
      expect((await prisma.savedSearchView.findUniqueOrThrow({ where: { id: view.id } })).name).toBe(newName);
      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "operations.saved_view.renamed", resourceId: view.id },
      });
      expect(audit).toMatchObject({ userId: A.adminUserId, workspaceId: A.teamId, outcome: "success" });
      expect(audit.metadata).toMatchObject({ changedFields: ["name"], newVisibility: "TEAM" });
    });

    it("DELETE: the ADMIN deletes a shared view — row gone and a deleted audit row; a VIEWER and another tenant are refused", async () => {
      const view = await sharedView();
      const url = (teamId: string) => `/v1/ops/saved-views/${view.id}?teamId=${teamId}`;

      const viewer = await call({ method: "DELETE", url: url(A.teamId), token: A.viewerToken });
      expect(viewer.statusCode).toBe(403);
      expect(json(viewer)).toEqual({ error: { code: "not_permitted" } });
      const foreign = await call({ method: "DELETE", url: url(B.teamId), token: B.ownerToken });
      expect(foreign.statusCode).toBe(404);
      expect(json(foreign)).toEqual({ error: { code: "saved_view_not_found" } });
      expect(await prisma.savedSearchView.findUnique({ where: { id: view.id } })).not.toBeNull();

      const res = await call({ method: "DELETE", url: url(A.teamId), token: A.adminToken });
      expect(res.statusCode, res.body).toBe(204);
      expect(await prisma.savedSearchView.findUnique({ where: { id: view.id } })).toBeNull();
      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "operations.saved_view.deleted", resourceId: view.id },
      });
      expect(audit).toMatchObject({ userId: A.adminUserId, workspaceId: A.teamId, outcome: "success" });
      expect(audit.metadata).toMatchObject({ creatorUserId: A.adminUserId, previousVisibility: "TEAM" });
    });
  });

  // ===========================================================================
  // /v1/ops/upload-telemetry
  // ===========================================================================

  describe("upload telemetry", () => {
    it("a workspace MEMBER's batch is accepted and counted; a non-member and an unknown type are refused without counting", async () => {
      const { readCounter } = await import("../src/services/ops/metrics.service.js");
      const before = {
        resume: readCounter("upload_resume_total"),
        drafts: readCounter("offline_draft_created_total"),
      };
      // The capture page emitter body: { teamId, events: [{ type, count }] }.
      const payload = {
        teamId: A.teamId,
        events: [
          { type: "upload_resume_total", count: 3 },
          { type: "offline_draft_created_total", count: 1 },
        ],
      };

      const foreign = await call({ method: "POST", url: "/v1/ops/upload-telemetry", token: B.memberToken, payload });
      expect(foreign.statusCode).toBe(404);
      expect(json(foreign)).toEqual({ error: { code: "not_found" } });
      const unknown = await call({
        method: "POST",
        url: "/v1/ops/upload-telemetry",
        token: A.memberToken,
        payload: { teamId: A.teamId, events: [{ type: "evidence_deleted_total", count: 1 }] },
      });
      expect(unknown.statusCode).toBe(400);
      expect(json(unknown)).toEqual({ error: { code: "invalid_payload" } });
      expect(readCounter("upload_resume_total")).toBe(before.resume);

      const res = await call({ method: "POST", url: "/v1/ops/upload-telemetry", token: A.memberToken, payload });
      expect(res.statusCode, res.body).toBe(202);
      expect(json(res)).toEqual({ accepted: 2 });
      expect(readCounter("upload_resume_total")).toBe(before.resume + 3);
      expect(readCounter("offline_draft_created_total")).toBe(before.drafts + 1);
      // No PII-bearing audit is written for advisory counters.
      expect(
        await prisma.adminAuditLog.count({ where: { action: { contains: "upload_telemetry" } } }),
      ).toBe(0);
    });
  });
});
