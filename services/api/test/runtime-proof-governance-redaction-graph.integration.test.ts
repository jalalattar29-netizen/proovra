/**
 * BATCH K6 — runtime proof, governance / redaction / graph / automation cluster.
 *
 * Every action below is driven through the REAL route with the payload its
 * product consumer builds (or, where no consumer exists yet, the route's own
 * zod schema), against a disposable PostgreSQL + Redis:
 *
 *   1. the authorized SUCCESS branch, re-reading the durable column the action
 *      exists to change;
 *   2. the audit / activity / custody record the route writes;
 *   3. an expected refusal — wrong role, other tenant — with a bounded status
 *      and no durable effect.
 *
 * Step-up is satisfied exactly as a real operator does: a verified
 * authenticator factor, POST /v1/identity-security/step-up/start, then
 * /check with the current code. No provider is contacted.
 *
 * The one boundary seeded directly is the redaction DERIVATIVE render (a
 * worker job): publish requires a READY derivative, so the row the worker
 * writes is written here. Detection rows and video tracks are likewise the
 * output of provider/worker pipelines and are seeded in the shape those
 * pipelines persist.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Batch K6 — governance, redaction, graph and automation (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let totp: typeof import("../src/services/security/mfa-totp.js");
  const secrets = new Map<string, Buffer>();
  const STEP = "x-proovra-step-up-challenge-id";

  const call = (opts: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
    token: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) =>
    h.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });

  const tag = () => randomUUID().slice(0, 8);

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
   * One real step-up round trip. WCC-NEW-008 accepts each authenticator time
   * step once (factor.lastUsedAt); this suite performs more step-ups per actor
   * than one 30-second window holds, so the factor is returned to "the last
   * accepted code was an earlier window" before each round. The replay guard
   * itself is untouched.
   */
  async function stepUp(input: {
    token: string;
    userId: string;
    teamId: string;
    purpose: string;
    resourceKind: string;
    resourceId: string;
  }): Promise<string> {
    const started = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      token: input.token,
      payload: {
        teamId: input.teamId,
        purpose: input.purpose,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    const challengeId = (started.json() as { challenge: { id: string } }).challenge.id;
    await prisma.mfaFactor.updateMany({
      where: { userId: input.userId, kind: "TOTP" },
      data: { lastUsedAt: null },
    });
    const code = totp.computeTotpCode(
      secrets.get(input.userId)!,
      totp.timeStep(Math.floor(Date.now() / 1000)),
    );
    const checked = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/check",
      token: input.token,
      payload: { teamId: input.teamId, challengeId, code },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    return challengeId;
  }

  async function createEvidence(teamId: string, ownerUserId: string, type: "PHOTO" | "VIDEO", extra: Record<string, unknown> = {}) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return prisma.evidence.create({
      data: {
        title: `K6 ${type} ${tag()}`,
        type,
        status: "CREATED",
        teamId,
        organizationId: team.organizationId,
        ownerUserId,
        ...extra,
      } as never,
      select: { id: true },
    });
  }

  function auditRow(where: Record<string, unknown>) {
    return prisma.adminAuditLog.findFirst({ where: where as never, orderBy: { createdAt: "desc" } });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    // The graph write side lives in @proovra/shared-runtime and uses the host's
    // registered client; src/index.ts registers it at process start, the
    // harness (buildServer only) does not.
    await import("../src/register-shared-runtime.js");
    totp = await import("../src/services/security/mfa-totp.js");
    const { teamA, teamB } = h.fixtures;
    // The redaction + governance-policy routes resolve their workspace from the
    // persisted switcher rail, exactly as the product does.
    for (const userId of [teamA.ownerUserId, teamA.adminUserId, teamA.memberUserId, teamA.viewerUserId]) {
      await prisma.user.update({ where: { id: userId }, data: { currentWorkspaceId: teamA.teamId } });
    }
    for (const userId of [teamB.ownerUserId, teamB.adminUserId]) {
      await prisma.user.update({ where: { id: userId }, data: { currentWorkspaceId: teamB.teamId } });
    }
    await seedTotp(teamA.ownerUserId);
    await seedTotp(teamA.adminUserId);
    await seedTotp(teamB.ownerUserId);
  }, 180_000);

  afterAll(async () => {
    if (prisma && h) {
      const teamIds = [h.fixtures.teamA.teamId, h.fixtures.teamB.teamId];
      const where = { teamId: { in: teamIds } };
      await prisma.automationWebhookDestination.deleteMany({ where }).catch(() => undefined);
      await prisma.automationRule.deleteMany({ where }).catch(() => undefined);
      await prisma.redactionProject.deleteMany({ where }).catch(() => undefined);
      await prisma.redactionPolicy.deleteMany({ where }).catch(() => undefined);
      await prisma.videoTimelineEvent.deleteMany({ where }).catch(() => undefined);
      await prisma.videoTrack.deleteMany({ where }).catch(() => undefined);
      await prisma.manualRelationship.deleteMany({ where }).catch(() => undefined);
      await prisma.investigationGraphEdge.deleteMany({ where }).catch(() => undefined);
      await prisma.investigationGraphNode.deleteMany({ where }).catch(() => undefined);
      await prisma.workspaceGovernancePolicy.deleteMany({ where }).catch(() => undefined);
      await prisma.stepUpChallenge.deleteMany({ where }).catch(() => undefined);
    }
    await h?.cleanup();
  });

  // ===========================================================================
  // Automation
  // ===========================================================================

  describe("automation", () => {
    it("POST /v1/automation/webhooks — creates a disabled destination, reveals the secret once, emits the security event; refuses a reviewer and another tenant", async () => {
      const { teamA: a, teamB: b } = h.fixtures;
      const payload = { teamId: a.teamId, name: "Case intake receiver", url: "https://hooks.example.com/proovra/intake" };

      const reviewer = await call({ method: "POST", url: "/v1/automation/webhooks", token: a.memberToken, payload });
      expect(reviewer.statusCode, reviewer.body).toBe(403);
      const foreign = await call({ method: "POST", url: "/v1/automation/webhooks", token: b.ownerToken, payload });
      expect(foreign.statusCode, foreign.body).toBe(404);
      expect(foreign.json()).toEqual({ error: { code: "not_found" } });
      const plainHttp = await call({ method: "POST", url: "/v1/automation/webhooks", token: a.ownerToken, payload: { ...payload, url: "http://hooks.example.com/x" } });
      expect(plainHttp.statusCode).toBe(400);
      expect(plainHttp.json().error).toEqual({ code: "url_rejected", reason: "non_https_scheme" });
      expect(await prisma.automationWebhookDestination.count({ where: { teamId: a.teamId } })).toBe(0);

      const created = await call({ method: "POST", url: "/v1/automation/webhooks", token: a.ownerToken, payload });
      expect(created.statusCode, created.body).toBe(201);
      const body = created.json();
      expect(body.enabled).toBe(false);
      expect(typeof body.revealedSecret).toBe("string");
      expect(body.revealedSecret.length).toBeGreaterThan(16);

      const row = await prisma.automationWebhookDestination.findUniqueOrThrow({ where: { id: body.id } });
      expect(row).toMatchObject({
        teamId: a.teamId,
        name: payload.name,
        url: payload.url,
        urlOrigin: "https://hooks.example.com",
        enabled: false,
        createdByUserId: a.ownerUserId,
        updatedByUserId: a.ownerUserId,
        secretFingerprint: body.secretFingerprint,
      });
      // The stored envelope is never the plaintext.
      expect(JSON.stringify(row.encryptedSecret)).not.toContain(body.revealedSecret);
      // The list projection never re-reveals it.
      const list = await call({ method: "GET", url: `/v1/automation/webhooks?teamId=${a.teamId}`, token: a.ownerToken });
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain(body.revealedSecret);

      await expect
        .poll(() =>
          prisma.securityEvent.findFirst({
            where: {
              teamId: a.teamId,
              eventType: "automation_webhook_destination_created",
              details: { path: ["destinationId"], equals: body.id },
            },
            select: { details: true, severity: true },
          }),
        )
        .toMatchObject({ severity: "INFO", details: { actorUserId: a.ownerUserId, urlOrigin: "https://hooks.example.com" } });
    });

    it("POST /v1/automation/rules — persists the rule disabled with the validated config; refuses a viewer and another tenant", async () => {
      const { teamA: a, teamB: b } = h.fixtures;
      // Exactly the body AutomationRuleForm builds on create.
      const payload = {
        teamId: a.teamId,
        name: "Label new photos",
        description: "Flag new photo records for review",
        triggerType: "EVIDENCE_CREATED",
        conditionJson: { field: "evidenceType", op: "equals", value: "PHOTO" },
        actionType: "APPLY_LABEL",
        actionConfigJson: { label: "needs-review" },
      };
      const viewer = await call({ method: "POST", url: "/v1/automation/rules", token: a.viewerToken, payload });
      expect(viewer.statusCode, viewer.body).toBe(403);
      const foreign = await call({ method: "POST", url: "/v1/automation/rules", token: b.ownerToken, payload });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ error: { code: "not_found" } });
      const badConfig = await call({ method: "POST", url: "/v1/automation/rules", token: a.ownerToken, payload: { ...payload, actionConfigJson: { label: "x", url: "https://evil.example" } } });
      expect(badConfig.statusCode).toBe(400);
      expect(badConfig.json().message).toBe("Invalid action config");
      expect(await prisma.automationRule.count({ where: { teamId: a.teamId } })).toBe(0);

      const created = await call({ method: "POST", url: "/v1/automation/rules", token: a.ownerToken, payload });
      expect(created.statusCode, created.body).toBe(201);
      const row = await prisma.automationRule.findUniqueOrThrow({ where: { id: created.json().id } });
      expect(row).toMatchObject({
        teamId: a.teamId,
        name: payload.name,
        description: payload.description,
        enabled: false,
        triggerType: "EVIDENCE_CREATED",
        actionType: "APPLY_LABEL",
        actionConfigJson: { label: "needs-review" },
        conditionJson: payload.conditionJson,
        createdByUserId: a.ownerUserId,
        version: 1,
      });
      // The route documents that rule mutations emit no audit (automation.routes.ts header).
      expect(await auditRow({ resourceId: row.id })).toBeNull();
    });
  });

  // ===========================================================================
  // Governance
  // ===========================================================================

  describe("governance", () => {
    it("PUT /v1/governance/policy — step-up + expectedVersion write the server-derived workspace policy and audit the change", async () => {
      const { teamA: a, teamB: b } = h.fixtures;
      const read = await call({ method: "GET", url: "/v1/governance/policy", token: a.ownerToken });
      expect(read.statusCode, read.body).toBe(200);
      const version = read.json().version as number;
      const patch = { requireReviewBeforeReport: true, defaultRetentionDays: 400 };

      // Wrong role: a read-only viewer.
      const viewer = await call({ method: "PUT", url: "/v1/governance/policy", token: a.viewerToken, payload: { expectedVersion: version, ...patch } });
      expect(viewer.statusCode, viewer.body).toBe(403);
      // Another tenant's user whose workspace pointer names A authorizes nothing.
      await prisma.user.update({ where: { id: b.viewerUserId }, data: { currentWorkspaceId: a.teamId } });
      const foreign = await call({ method: "PUT", url: "/v1/governance/policy", token: b.viewerToken, payload: { expectedVersion: version, ...patch } });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ error: { code: "not_found" } });
      // A subject smuggled in the body is refused by the strict schema.
      const smuggled = await call({ method: "PUT", url: "/v1/governance/policy", token: a.ownerToken, payload: { expectedVersion: version, teamId: b.teamId, ...patch } });
      expect(smuggled.statusCode).toBe(400);
      // No step-up, no write.
      const noStepUp = await call({ method: "PUT", url: "/v1/governance/policy", token: a.ownerToken, payload: { expectedVersion: version, ...patch } });
      expect(noStepUp.statusCode).toBe(401);
      expect(noStepUp.json().error.code).toBe("STEP_UP_REQUIRED");
      expect(await prisma.workspaceGovernancePolicy.findUnique({ where: { teamId: a.teamId } })).toBeNull();

      const challengeId = await stepUp({
        token: a.ownerToken, userId: a.ownerUserId, teamId: a.teamId,
        purpose: "GOVERNANCE_POLICY_UPDATE", resourceKind: "workspace_governance_policy", resourceId: a.teamId,
      });
      const written = await call({
        method: "PUT", url: "/v1/governance/policy", token: a.ownerToken,
        payload: { expectedVersion: version, ...patch }, headers: { [STEP]: challengeId },
      });
      expect(written.statusCode, written.body).toBe(200);
      expect(written.json()).toMatchObject({ teamId: a.teamId, version: version + 1 });

      const row = await prisma.workspaceGovernancePolicy.findUniqueOrThrow({ where: { teamId: a.teamId } });
      expect(row.requireReviewBeforeReport).toBe(true);
      expect(row.defaultRetentionDays).toBe(400);
      expect(row.allowPublicVerify).toBe(true);

      const audit = await auditRow({ action: "governance.workspace_policy_updated", resourceId: row.id });
      expect(audit).toMatchObject({ userId: a.ownerUserId, workspaceId: a.teamId, outcome: "success", resourceType: "workspace_governance_policy" });
      expect(audit?.metadata).toMatchObject({ previousVersion: version, newVersion: version + 1 });
      expect(JSON.stringify(audit?.metadata)).toContain("defaultRetentionDays");

      // The stale version is a 409 with zero mutation.
      const again = await stepUp({
        token: a.ownerToken, userId: a.ownerUserId, teamId: a.teamId,
        purpose: "GOVERNANCE_POLICY_UPDATE", resourceKind: "workspace_governance_policy", resourceId: a.teamId,
      });
      const stale = await call({
        method: "PUT", url: "/v1/governance/policy", token: a.ownerToken,
        payload: { expectedVersion: version, defaultRetentionDays: 10 }, headers: { [STEP]: again },
      });
      expect(stale.statusCode).toBe(409);
      expect((await prisma.workspaceGovernancePolicy.findUniqueOrThrow({ where: { teamId: a.teamId } })).defaultRetentionDays).toBe(400);
    });

    it("POST /v1/governance/evidence/:id/publish and /suspend — step-up moves the publication state and appends custody; refusals leave it unchanged", async () => {
      const { teamA: a, teamB: b } = h.fixtures;
      const evidence = await createEvidence(a.teamId, a.ownerUserId, "PHOTO", { publicVerifyState: "NOT_PUBLISHED" });
      const id = evidence.id;
      const publishUrl = `/v1/governance/evidence/${id}/publish`;
      const suspendUrl = `/v1/governance/evidence/${id}/suspend`;
      // The PublicVerifyPublicationPanel body.
      const publishBody = { teamId: a.teamId, reason: "Cleared for public verification" };

      const viewer = await call({ method: "POST", url: publishUrl, token: a.viewerToken, payload: publishBody });
      expect(viewer.statusCode, viewer.body).toBe(403);
      const foreign = await call({ method: "POST", url: publishUrl, token: b.ownerToken, payload: publishBody });
      expect(foreign.statusCode).toBe(404);
      const noStepUp = await call({ method: "POST", url: publishUrl, token: a.ownerToken, payload: publishBody });
      expect(noStepUp.statusCode).toBe(401);
      // Another tenant with a valid step-up in ITS workspace cannot reach A's record.
      const bChallenge = await stepUp({
        token: b.ownerToken, userId: b.ownerUserId, teamId: b.teamId,
        purpose: "PUBLIC_VERIFY_PUBLISH", resourceKind: "evidence", resourceId: id,
      });
      const crossTenant = await call({ method: "POST", url: publishUrl, token: b.ownerToken, payload: { teamId: b.teamId }, headers: { [STEP]: bChallenge } });
      expect(crossTenant.statusCode).toBe(404);
      expect(crossTenant.json()).toEqual({ error: { code: "evidence_not_in_workspace" } });
      expect((await prisma.evidence.findUniqueOrThrow({ where: { id } })).publicVerifyState).toBe("NOT_PUBLISHED");

      const publishChallenge = await stepUp({
        token: a.ownerToken, userId: a.ownerUserId, teamId: a.teamId,
        purpose: "PUBLIC_VERIFY_PUBLISH", resourceKind: "evidence", resourceId: id,
      });
      const published = await call({ method: "POST", url: publishUrl, token: a.ownerToken, payload: publishBody, headers: { [STEP]: publishChallenge } });
      expect(published.statusCode, published.body).toBe(200);
      expect(published.json().publication).toMatchObject({ state: "PUBLISHED", publishedByUserId: a.ownerUserId });
      const afterPublish = await prisma.evidence.findUniqueOrThrow({ where: { id } });
      expect(afterPublish.publicVerifyState).toBe("PUBLISHED");
      expect(afterPublish.publicVerifyPublishedByUserId).toBe(a.ownerUserId);
      expect(afterPublish.publicVerifyPublishedAtUtc).toBeInstanceOf(Date);
      const publishCustody = await prisma.custodyEvent.findFirst({ where: { evidenceId: id, eventType: "PUBLIC_VERIFY_PUBLISHED" } });
      expect(publishCustody?.payload).toMatchObject({ previousState: "NOT_PUBLISHED", actorUserId: a.ownerUserId });
      expect(publishCustody?.eventHash).toMatch(/^[a-f0-9]{64}$/);

      // Publishing an already-PUBLISHED record is the bounded 409 the audit hit.
      const republishChallenge = await stepUp({
        token: a.ownerToken, userId: a.ownerUserId, teamId: a.teamId,
        purpose: "PUBLIC_VERIFY_PUBLISH", resourceKind: "evidence", resourceId: id,
      });
      const republish = await call({ method: "POST", url: publishUrl, token: a.ownerToken, payload: publishBody, headers: { [STEP]: republishChallenge } });
      expect(republish.statusCode).toBe(409);
      expect(republish.json()).toEqual({ error: { code: "invalid_state_transition" } });

      // --- suspend ---
      const suspendBody = { teamId: a.teamId, reason: "Under internal review" };
      expect((await call({ method: "POST", url: suspendUrl, token: a.viewerToken, payload: suspendBody })).statusCode).toBe(403);
      expect((await call({ method: "POST", url: suspendUrl, token: b.ownerToken, payload: suspendBody })).statusCode).toBe(404);
      const noReason = await call({ method: "POST", url: suspendUrl, token: a.ownerToken, payload: { teamId: a.teamId } });
      expect(noReason.statusCode).toBe(400);
      expect((await prisma.evidence.findUniqueOrThrow({ where: { id } })).publicVerifyState).toBe("PUBLISHED");

      const suspendChallenge = await stepUp({
        token: a.ownerToken, userId: a.ownerUserId, teamId: a.teamId,
        purpose: "PUBLIC_VERIFY_SUSPEND", resourceKind: "evidence", resourceId: id,
      });
      const suspended = await call({ method: "POST", url: suspendUrl, token: a.ownerToken, payload: suspendBody, headers: { [STEP]: suspendChallenge } });
      expect(suspended.statusCode, suspended.body).toBe(200);
      expect(suspended.json().publication).toMatchObject({ state: "SUSPENDED", suspendedByUserId: a.ownerUserId });
      // The internal reason is never projected.
      expect(suspended.body).not.toContain("Under internal review");
      const afterSuspend = await prisma.evidence.findUniqueOrThrow({ where: { id } });
      expect(afterSuspend.publicVerifyState).toBe("SUSPENDED");
      expect(afterSuspend.publicVerifySuspendedByUserId).toBe(a.ownerUserId);
      expect(afterSuspend.publicVerifySuspensionReason).toBe("Under internal review");
      const suspendCustody = await prisma.custodyEvent.findFirst({ where: { evidenceId: id, eventType: "PUBLIC_VERIFY_SUSPENDED" } });
      expect(suspendCustody?.payload).toMatchObject({ previousState: "PUBLISHED", actorUserId: a.ownerUserId, reasonInternal: "Under internal review" });
      expect(suspendCustody?.sequence).toBeGreaterThan(publishCustody!.sequence);
    });
  });

  // ===========================================================================
  // Investigation graph
  // ===========================================================================

  describe("investigation graph", () => {
    async function node(teamId: string, externalId: string) {
      return prisma.investigationGraphNode.create({
        data: { teamId, nodeKind: "EVIDENCE", externalId, safeLabel: "Evidence record" },
        select: { id: true },
      });
    }

    it("POST + DELETE /v1/graph/relationships/manual — asserts and retracts a link with provenance and audit; refuses a viewer and another tenant", async () => {
      const { teamA: a, teamB: b } = h.fixtures;
      const second = await createEvidence(a.teamId, a.ownerUserId, "PHOTO");
      const src = await node(a.teamId, a.evidenceId);
      const tgt = await node(a.teamId, second.id);
      const foreignNode = await node(b.teamId, b.evidenceId);
      // GraphCurationPanel body.
      const payload = { teamId: a.teamId, sourceNodeId: src.id, targetNodeId: tgt.id, edgeType: "MANUALLY_LINKED_TO", safeNote: "Same incident per call log" };
      const url = "/v1/graph/relationships/manual";

      expect((await call({ method: "POST", url, token: a.viewerToken, payload })).statusCode).toBe(403);
      const foreignTeam = await call({ method: "POST", url, token: b.ownerToken, payload });
      expect(foreignTeam.statusCode).toBe(404);
      // B's own workspace, naming A's nodes: indistinguishable from missing nodes.
      const foreignNodes = await call({ method: "POST", url, token: b.ownerToken, payload: { ...payload, teamId: b.teamId, targetNodeId: foreignNode.id } });
      expect(foreignNodes.statusCode).toBe(404);
      expect(foreignNodes.json()).toEqual({ error: { code: "not_found" } });
      expect(await prisma.manualRelationship.count({ where: { teamId: { in: [a.teamId, b.teamId] } } })).toBe(0);

      const created = await call({ method: "POST", url, token: a.ownerToken, payload });
      expect(created.statusCode, created.body).toBe(201);
      const { manualRelationshipId, edgeId, idempotent } = created.json();
      expect(idempotent).toBe(false);
      const rel = await prisma.manualRelationship.findUniqueOrThrow({ where: { id: manualRelationshipId } });
      expect(rel).toMatchObject({ teamId: a.teamId, sourceNodeId: src.id, targetNodeId: tgt.id, edgeType: "MANUALLY_LINKED_TO", status: "ACTIVE", createdByUserId: a.ownerUserId, safeNote: payload.safeNote });
      const edge = await prisma.investigationGraphEdge.findUniqueOrThrow({ where: { id: edgeId } });
      expect(edge).toMatchObject({ sourceKind: "MANUAL", staleAtUtc: null, createdByUserId: a.ownerUserId });
      const createAudit = await auditRow({ action: "GRAPH_MANUAL_RELATIONSHIP_CREATED", resourceId: edgeId });
      expect(createAudit).toMatchObject({ userId: a.ownerUserId, workspaceId: a.teamId, outcome: "success", resourceType: "graph_edge" });
      expect(createAudit?.metadata).toMatchObject({ manualRelationshipId });

      // --- retract ---
      const del = `${url}/${manualRelationshipId}`;
      const retractBody = { teamId: a.teamId, reason: "operator_retraction" };
      expect((await call({ method: "DELETE", url: del, token: a.viewerToken, payload: retractBody })).statusCode).toBe(403);
      expect((await call({ method: "DELETE", url: del, token: b.ownerToken, payload: retractBody })).statusCode).toBe(404);
      expect((await prisma.manualRelationship.findUniqueOrThrow({ where: { id: manualRelationshipId } })).status).toBe("ACTIVE");

      const retracted = await call({ method: "DELETE", url: del, token: a.ownerToken, payload: retractBody });
      expect(retracted.statusCode, retracted.body).toBe(200);
      expect(retracted.json()).toEqual({ manualRelationshipId, retracted: true });
      const after = await prisma.manualRelationship.findUniqueOrThrow({ where: { id: manualRelationshipId } });
      expect(after).toMatchObject({ status: "RETRACTED", retractedByUserId: a.ownerUserId, retractionReason: "operator_retraction" });
      expect(after.retractedAtUtc).toBeInstanceOf(Date);
      expect((await prisma.investigationGraphEdge.findUniqueOrThrow({ where: { id: edgeId } })).staleAtUtc).toBeInstanceOf(Date);
      const retractAudit = await auditRow({ action: "GRAPH_MANUAL_RELATIONSHIP_RETRACTED", resourceId: manualRelationshipId });
      expect(retractAudit).toMatchObject({ userId: a.ownerUserId, workspaceId: a.teamId, outcome: "success" });
    });

    it("POST /v1/graph/reconcile — enqueues the workspace reconcile job and audits it; refuses a read-only viewer and another tenant", async () => {
      const { teamA: a, teamB: b } = h.fixtures;
      const { JOB_NAMES, QUEUE_NAMES } = await import("@proovra/shared");
      const { getReadOnlyQueueHandle } = await import("../src/queue/canonical-queue-client.js");
      const queue = getReadOnlyQueueHandle(QUEUE_NAMES.GRAPH_RECONCILE, JOB_NAMES.RECONCILE_TEAM_GRAPH);
      expect(queue).not.toBeNull();
      const url = `/v1/graph/reconcile?teamId=${a.teamId}`;
      const payload = { reason: "operator_refresh" };
      const jobId = `graph-reconcile-${a.teamId}`;
      await (await queue!.getJob(jobId))?.remove();

      // VIEWER "may look and may not act" — a reconcile is an operator action.
      const viewer = await call({ method: "POST", url, token: a.viewerToken, payload });
      expect(viewer.statusCode, viewer.body).toBe(403);
      expect(viewer.json().error.code).toBe("permission_denied");
      const foreign = await call({ method: "POST", url, token: b.ownerToken, payload });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ error: { code: "not_found" } });
      expect(await queue!.getJob(jobId)).toBeUndefined();
      expect(await auditRow({ action: "GRAPH_MANUAL_RECONCILE_REQUESTED", workspaceId: a.teamId })).toBeNull();

      const queued = await call({ method: "POST", url, token: a.adminToken, payload });
      expect(queued.statusCode, queued.body).toBe(202);
      expect(queued.json().jobId).toBe(jobId);
      const job = await queue!.getJob(jobId);
      expect(job).toBeDefined();
      expect(JSON.stringify(job!.data)).toContain(a.teamId);
      const audit = await auditRow({ action: "GRAPH_MANUAL_RECONCILE_REQUESTED", workspaceId: a.teamId });
      expect(audit).toMatchObject({ userId: a.adminUserId, resourceId: a.teamId, outcome: "success" });
      expect(audit?.metadata).toMatchObject({ jobId, queued: true, requestedReason: "operator_refresh" });
      await job!.remove();
    });
  });

  // ===========================================================================
  // Redaction
  // ===========================================================================

  describe("redaction", () => {
    let projectId: string;
    let versionId: string;
    let evidenceId: string;

    const REGION = { kind: "BBOX_NORMALIZED", method: "BLUR", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } };

    beforeAll(async () => {
      const { teamA: a } = h.fixtures;
      evidenceId = (await createEvidence(a.teamId, a.ownerUserId, "PHOTO")).id;
      // Opening the project is not in this cluster and is entitlement-gated;
      // the row is the one openRedactionProject writes.
      projectId = (await prisma.redactionProject.create({
        data: { teamId: a.teamId, evidenceId, artifactKind: "IMAGE", createdByUserId: a.ownerUserId },
        select: { id: true },
      })).id;
      const v = await call({ method: "POST", url: `/v1/redaction/projects/${projectId}/versions`, token: a.ownerToken, payload: { rationale: "First pass" } });
      expect(v.statusCode, v.body).toBe(201);
      versionId = v.json().versionId;
    });

    const activity = (code: string, extra: Record<string, unknown> = {}) =>
      prisma.redactionActivity.findFirst({ where: { projectId, code, ...extra }, orderBy: { occurredAtUtc: "desc" } });

    it("POST /v1/redaction/versions/:id/regions + DELETE /v1/redaction/regions/:id — author and remove a region with activity; refuse a member and another tenant", async () => {
      const { teamA: a, teamB: b } = h.fixtures;
      const url = `/v1/redaction/versions/${versionId}/regions`;
      const member = await call({ method: "POST", url, token: a.memberToken, payload: REGION });
      expect(member.statusCode).toBe(403);
      expect(member.json()).toEqual({ denial: "NOT_PERMITTED" });
      const foreign = await call({ method: "POST", url, token: b.ownerToken, payload: REGION });
      expect(foreign.statusCode).toBe(409);
      expect(foreign.json()).toEqual({ denial: "VERSION_NOT_FOUND" });
      const outOfBounds = await call({ method: "POST", url, token: a.ownerToken, payload: { ...REGION, geometry: { x: 0.9, y: 0.1, width: 0.5, height: 0.2 } } });
      expect(outOfBounds.statusCode).toBe(409);
      expect(outOfBounds.json()).toEqual({ denial: "REGION_OUT_OF_BOUNDS" });
      expect(await prisma.redactionRegion.count({ where: { versionId } })).toBe(0);

      const added = await call({ method: "POST", url, token: a.ownerToken, payload: REGION });
      expect(added.statusCode, added.body).toBe(201);
      const regionId = added.json().regionId as string;
      const region = await prisma.redactionRegion.findUniqueOrThrow({ where: { id: regionId } });
      expect(region).toMatchObject({ teamId: a.teamId, versionId, kind: "BBOX_NORMALIZED", method: "BLUR", geometry: REGION.geometry, authoredByUserId: a.ownerUserId });
      expect(await activity("REGION_ADDED", { actorUserId: a.ownerUserId })).toMatchObject({ versionId, payload: expect.objectContaining({ regionId }) });

      const del = `/v1/redaction/regions/${regionId}`;
      expect((await call({ method: "DELETE", url: del, token: a.memberToken })).statusCode).toBe(403);
      const foreignDel = await call({ method: "DELETE", url: del, token: b.ownerToken });
      expect(foreignDel.statusCode).toBe(409);
      expect(foreignDel.json()).toEqual({ denial: "REGION_INVALID" });
      expect(await prisma.redactionRegion.findUnique({ where: { id: regionId } })).not.toBeNull();

      const removed = await call({ method: "DELETE", url: del, token: a.ownerToken });
      expect(removed.statusCode, removed.body).toBe(200);
      expect(await prisma.redactionRegion.findUnique({ where: { id: regionId } })).toBeNull();
      expect(await activity("REGION_REMOVED")).toMatchObject({ actorUserId: a.ownerUserId, payload: expect.objectContaining({ regionId }) });
    });

    it("POST /v1/redaction/versions/:id/decisions/bulk — records per-row decisions, promotes the accepted one to a region; foreign rows answer NOT_FOUND", async () => {
      const { teamA: a, teamB: b } = h.fixtures;
      const detection = () =>
        prisma.redactionDetection.create({
          data: {
            teamId: a.teamId, versionId, kind: "FACE", provider: "MANUAL",
            rawConfidence: 0.91, confidenceBand: "HIGH",
            suggestedRegionKind: "BBOX_NORMALIZED",
            suggestedRegionGeometry: { x: 0.3, y: 0.3, width: 0.1, height: 0.1 },
            suggestedMethod: "BLUR", decisionState: "SUGGESTED",
          },
          select: { id: true },
        });
      const d1 = await detection();
      const d2 = await detection();
      const url = `/v1/redaction/versions/${versionId}/decisions/bulk`;
      // DetectionReviewPanel body.
      const payload = { rows: [{ detectionId: d1.id, decisionState: "ACCEPTED" }, { detectionId: d2.id, decisionState: "REJECTED" }] };

      expect((await call({ method: "POST", url, token: a.memberToken, payload })).statusCode).toBe(403);
      const foreign = await call({ method: "POST", url, token: b.ownerToken, payload });
      expect(foreign.statusCode).toBe(200);
      const missing = await call({ method: "POST", url, token: b.ownerToken, payload: { rows: [{ detectionId: randomUUID(), decisionState: "ACCEPTED" }] } });
      // Another tenant's rows are answered exactly like rows that do not exist.
      for (const o of foreign.json().outcomes) {
        expect(o).toMatchObject({ outcome: "NOT_FOUND", denial: "DETECTION_NOT_FOUND", promotedRegionId: null });
      }
      expect(missing.json().outcomes[0]).toMatchObject({ outcome: "NOT_FOUND", denial: "DETECTION_NOT_FOUND" });
      expect(await prisma.redactionDecision.count({ where: { versionId } })).toBe(0);

      const decided = await call({ method: "POST", url, token: a.ownerToken, payload });
      expect(decided.statusCode, decided.body).toBe(200);
      const [o1, o2] = decided.json().outcomes;
      expect(o1).toMatchObject({ detectionId: d1.id, outcome: "ACCEPTED", denial: null });
      expect(o2).toMatchObject({ detectionId: d2.id, outcome: "REJECTED", promotedRegionId: null });
      expect((await prisma.redactionDetection.findUniqueOrThrow({ where: { id: d1.id } })).decisionState).toBe("ACCEPTED");
      expect((await prisma.redactionDetection.findUniqueOrThrow({ where: { id: d2.id } })).decisionState).toBe("REJECTED");
      const decisions = await prisma.redactionDecision.findMany({ where: { versionId }, orderBy: { decidedAtUtc: "asc" } });
      expect(decisions.map((d) => [d.detectionId, d.decisionState, d.decidedByUserId])).toEqual([
        [d1.id, "ACCEPTED", a.ownerUserId],
        [d2.id, "REJECTED", a.ownerUserId],
      ]);
      const promoted = await prisma.redactionRegion.findUniqueOrThrow({ where: { id: o1.promotedRegionId } });
      expect(promoted).toMatchObject({ versionId, sourceDetectionId: d1.id, sourceProvider: "MANUAL" });
      expect(await activity("DETECTION_ACCEPTED")).toMatchObject({ actorUserId: a.ownerUserId, payload: expect.objectContaining({ detectionId: d1.id }) });
      expect(await activity("DETECTION_REJECTED")).toMatchObject({ actorUserId: a.ownerUserId, payload: expect.objectContaining({ detectionId: d2.id }) });
    });

    it("POST /v1/redaction/versions/:id/publish — an approved version with a READY derivative publishes after step-up; refusals leave it APPROVED", async () => {
      const { teamA: a, teamB: b } = h.fixtures;
      const submit = await call({ method: "POST", url: `/v1/redaction/versions/${versionId}/submit`, token: a.ownerToken, payload: { rationale: "Ready" } });
      expect(submit.statusCode, submit.body).toBe(200);
      // Separation of duties: the admin approves the owner's version.
      const approve = await call({ method: "POST", url: `/v1/redaction/versions/${versionId}/approve`, token: a.adminToken, payload: { verdict: "APPROVE", rationale: "Looks right" } });
      expect(approve.statusCode, approve.body).toBe(200);

      const url = `/v1/redaction/versions/${versionId}/publish`;
      const payload = { rationale: "Disclose" };
      // Derivative render is a worker boundary; without it the route refuses.
      const noDerivativeChallenge = await stepUp({
        token: a.adminToken, userId: a.adminUserId, teamId: a.teamId,
        purpose: "REDACTION_PUBLISH", resourceKind: "redaction_derivative", resourceId: versionId,
      });
      const notReady = await call({ method: "POST", url, token: a.adminToken, payload, headers: { [STEP]: noDerivativeChallenge } });
      expect(notReady.statusCode).toBe(409);
      expect(notReady.json()).toEqual({ denial: "DERIVATIVE_NOT_READY" });
      await prisma.redactionDerivative.create({
        data: {
          versionId, teamId: a.teamId, state: "READY", kind: "IMAGE",
          storageKey: `redaction/${a.teamId}/${versionId}.png`, fileSha256: "a".repeat(64),
          generatedAtUtc: new Date(), renderedAtUtc: new Date(), contentType: "image/png", byteSize: BigInt(1024),
        },
      });

      expect((await call({ method: "POST", url, token: a.memberToken, payload })).statusCode).toBe(403);
      const noStepUp = await call({ method: "POST", url, token: a.adminToken, payload });
      expect(noStepUp.statusCode).toBe(401);
      expect(noStepUp.json().error.code).toBe("STEP_UP_REQUIRED");
      const bChallenge = await stepUp({
        token: b.ownerToken, userId: b.ownerUserId, teamId: b.teamId,
        purpose: "REDACTION_PUBLISH", resourceKind: "redaction_derivative", resourceId: versionId,
      });
      const foreign = await call({ method: "POST", url, token: b.ownerToken, payload, headers: { [STEP]: bChallenge } });
      expect(foreign.statusCode).toBe(409);
      expect(foreign.json()).toEqual({ denial: "DERIVATIVE_NOT_READY" });
      expect((await prisma.redactionVersion.findUniqueOrThrow({ where: { id: versionId } })).state).toBe("APPROVED");

      const challengeId = await stepUp({
        token: a.adminToken, userId: a.adminUserId, teamId: a.teamId,
        purpose: "REDACTION_PUBLISH", resourceKind: "redaction_derivative", resourceId: versionId,
      });
      const published = await call({ method: "POST", url, token: a.adminToken, payload, headers: { [STEP]: challengeId } });
      expect(published.statusCode, published.body).toBe(200);
      const version = await prisma.redactionVersion.findUniqueOrThrow({ where: { id: versionId } });
      expect(version.state).toBe("PUBLISHED");
      expect(version.publishedAtUtc).toBeInstanceOf(Date);
      expect((await prisma.redactionProject.findUniqueOrThrow({ where: { id: projectId } })).state).toBe("PUBLISHED");
      expect(await activity("VERSION_PUBLISHED")).toMatchObject({
        actorUserId: a.adminUserId,
        versionId,
        payload: expect.objectContaining({ from: "APPROVED", to: "PUBLISHED", stepUpVerified: true, stepUpChallengeId: challengeId, stepUpPurpose: "REDACTION_PUBLISH" }),
      });
      // The consumed challenge cannot publish again.
      const replay = await call({ method: "POST", url, token: a.adminToken, payload, headers: { [STEP]: challengeId } });
      expect(replay.statusCode).toBe(401);
    });

    it("DELETE /v1/redaction/policies/:id — archives the policy with a policy-audit row; refuses a member and another tenant", async () => {
      const { teamA: a, teamB: b } = h.fixtures;
      const created = await call({ method: "POST", url: "/v1/redaction/policies", token: a.ownerToken, payload: { name: `Archive me ${tag()}` } });
      expect(created.statusCode, created.body).toBe(201);
      const policyId = created.json().policyId as string;
      const url = `/v1/redaction/policies/${policyId}`;

      expect((await call({ method: "DELETE", url, token: a.memberToken })).statusCode).toBe(403);
      const foreign = await call({ method: "DELETE", url, token: b.ownerToken });
      expect(foreign.statusCode).toBe(409);
      expect(foreign.json()).toEqual({ denial: "PROJECT_NOT_FOUND" });
      expect((await prisma.redactionPolicy.findUniqueOrThrow({ where: { id: policyId } })).archivedAt).toBeNull();

      const archived = await call({ method: "DELETE", url, token: a.ownerToken });
      expect(archived.statusCode, archived.body).toBe(200);
      expect((await prisma.redactionPolicy.findUniqueOrThrow({ where: { id: policyId } })).archivedAt).toBeInstanceOf(Date);
      const audit = await prisma.redactionPolicyAudit.findFirst({ where: { policyId, code: "POLICY_ARCHIVED" } });
      expect(audit).toMatchObject({ teamId: a.teamId, actorUserId: a.ownerUserId });
      // Archived is terminal for this call: a second archive is a bounded refusal.
      expect((await call({ method: "DELETE", url, token: a.ownerToken })).statusCode).toBe(409);
    });

    it("POST /v1/redaction/policies/:id/versions + DELETE /v1/redaction/policy-assignments/:id — draft a version, publish + assign it, then revoke under step-up", async () => {
      const { teamA: a, teamB: b } = h.fixtures;
      const created = await call({ method: "POST", url: "/v1/redaction/policies", token: a.ownerToken, payload: { name: `Workspace policy ${tag()}` } });
      expect(created.statusCode).toBe(201);
      const policyId = created.json().policyId as string;
      const versionsUrl = `/v1/redaction/policies/${policyId}/versions`;
      // The Policy console "new draft" body, with a real rule set.
      const payload = {
        rationale: "New draft",
        document: {
          schemaVersion: "PROOVRA_REDACTION_POLICY_V1",
          providers: { AWS_REKOGNITION_FACES: false },
          kinds: {},
          ruleActions: {},
          customRules: [],
        },
      };
      expect((await call({ method: "POST", url: versionsUrl, token: a.memberToken, payload })).statusCode).toBe(403);
      const foreign = await call({ method: "POST", url: versionsUrl, token: b.ownerToken, payload });
      expect(foreign.statusCode).toBe(409);
      expect(foreign.json()).toEqual({ denial: "PROJECT_NOT_FOUND" });
      const wrongSchema = await call({ method: "POST", url: versionsUrl, token: a.ownerToken, payload: { ...payload, document: { ...payload.document, schemaVersion: "V0" } } });
      expect(wrongSchema.statusCode).toBe(400);
      expect(await prisma.redactionPolicyVersion.count({ where: { policyId } })).toBe(0);

      const drafted = await call({ method: "POST", url: versionsUrl, token: a.ownerToken, payload });
      expect(drafted.statusCode, drafted.body).toBe(201);
      expect(drafted.json().versionOrdinal).toBe(1);
      const policyVersionId = drafted.json().policyVersionId as string;
      const pv = await prisma.redactionPolicyVersion.findUniqueOrThrow({ where: { id: policyVersionId } });
      expect(pv).toMatchObject({ policyId, teamId: a.teamId, state: "DRAFT", versionOrdinal: 1, authoredByUserId: a.ownerUserId, rationale: "New draft", providers: { AWS_REKOGNITION_FACES: false } });
      expect(await prisma.redactionPolicyAudit.findFirst({ where: { policyVersionId, code: "POLICY_VERSION_CREATED" } })).toMatchObject({ actorUserId: a.ownerUserId });

      // Lifecycle to an assignable version: author submits, a second admin approves + publishes.
      const transition = (token: string, toState: string) =>
        call({ method: "POST", url: `/v1/redaction/policy-versions/${policyVersionId}/transition`, token, payload: { toState } });
      expect((await transition(a.ownerToken, "IN_REVIEW")).statusCode).toBe(200);
      expect((await transition(a.adminToken, "APPROVED")).statusCode).toBe(200);
      expect((await transition(a.adminToken, "PUBLISHED")).statusCode).toBe(200);
      const assigned = await call({
        method: "POST", url: `/v1/redaction/policies/${policyId}/assignments`, token: a.adminToken,
        payload: { policyVersionId, scope: "WORKSPACE", scopeTargetId: a.teamId },
      });
      expect(assigned.statusCode, assigned.body).toBe(201);
      const assignmentId = assigned.json().assignmentId as string;

      // --- revoke (PolicyScopePanel: DELETE ?expectedPolicyVersionId=) ---
      const revokeUrl = `/v1/redaction/policy-assignments/${assignmentId}?expectedPolicyVersionId=${policyVersionId}`;
      const revokeStepUp = (token: string, userId: string, teamId: string) =>
        stepUp({ token, userId, teamId, purpose: "REDACTION_POLICY_ASSIGNMENT_REVOKE", resourceKind: "redaction_policy_assignment", resourceId: assignmentId });
      expect((await call({ method: "DELETE", url: revokeUrl, token: a.memberToken })).statusCode).toBe(403);
      const noStepUp = await call({ method: "DELETE", url: revokeUrl, token: a.adminToken });
      expect(noStepUp.statusCode).toBe(401);
      const bChallenge = await revokeStepUp(b.ownerToken, b.ownerUserId, b.teamId);
      const foreignRevoke = await call({ method: "DELETE", url: revokeUrl, token: b.ownerToken, headers: { [STEP]: bChallenge } });
      expect(foreignRevoke.statusCode).toBe(409);
      expect(foreignRevoke.json()).toEqual({ denial: "PROJECT_NOT_FOUND" });
      const staleChallenge = await revokeStepUp(a.adminToken, a.adminUserId, a.teamId);
      const stale = await call({
        method: "DELETE",
        url: `/v1/redaction/policy-assignments/${assignmentId}?expectedPolicyVersionId=${randomUUID()}`,
        token: a.adminToken,
        headers: { [STEP]: staleChallenge },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toEqual({ denial: "INVALID_TRANSITION" });
      expect((await prisma.redactionPolicyAssignment.findUniqueOrThrow({ where: { id: assignmentId } })).revokedAtUtc).toBeNull();

      const challengeId = await revokeStepUp(a.adminToken, a.adminUserId, a.teamId);
      const revoked = await call({ method: "DELETE", url: revokeUrl, token: a.adminToken, headers: { [STEP]: challengeId } });
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect((await prisma.redactionPolicyAssignment.findUniqueOrThrow({ where: { id: assignmentId } })).revokedAtUtc).toBeInstanceOf(Date);
      const audit = await prisma.redactionPolicyAudit.findFirst({ where: { policyId, code: "POLICY_ASSIGNMENT_REVOKED" } });
      expect(audit).toMatchObject({ teamId: a.teamId, actorUserId: a.adminUserId, policyVersionId, payload: { assignmentId } });
    });

    it("POST /v1/redaction/video-tracks/merge — merges same-evidence tracks into one span and records the timeline event; refuses a member and another tenant", async () => {
      const { teamA: a, teamB: b } = h.fixtures;
      const video = await createEvidence(a.teamId, a.ownerUserId, "VIDEO");
      const track = (startFrame: number, endFrame: number, confidenceBand: string) =>
        prisma.videoTrack.create({
          data: { teamId: a.teamId, evidenceId: video.id, kind: "FACE", label: "Face 1", startFrame, endFrame, confidenceBand },
          select: { id: true },
        });
      const t1 = await track(0, 40, "MEDIUM");
      const t2 = await track(60, 120, "HIGH");
      const url = "/v1/redaction/video-tracks/merge";
      // VideoReviewWorkspace body.
      const payload = { trackIds: [t1.id, t2.id] };

      expect((await call({ method: "POST", url, token: a.memberToken, payload })).statusCode).toBe(403);
      const foreign = await call({ method: "POST", url, token: b.ownerToken, payload });
      expect(foreign.statusCode).toBe(409);
      expect(foreign.json()).toEqual({ denial: "VERSION_NOT_FOUND" });
      expect((await prisma.videoTrack.findMany({ where: { id: { in: payload.trackIds } } })).map((t) => t.state)).toEqual(["SUGGESTED", "SUGGESTED"]);

      const merged = await call({ method: "POST", url, token: a.ownerToken, payload });
      expect(merged.statusCode, merged.body).toBe(200);
      const { mergedTrackId, mergedSourceIds } = merged.json();
      expect(mergedSourceIds).toEqual(payload.trackIds);
      const m = await prisma.videoTrack.findUniqueOrThrow({ where: { id: mergedTrackId } });
      expect(m).toMatchObject({ teamId: a.teamId, evidenceId: video.id, kind: "FACE", startFrame: 0, endFrame: 120, state: "SUGGESTED", confidenceBand: "HIGH", authoredByUserId: a.ownerUserId });
      const sources = await prisma.videoTrack.findMany({ where: { id: { in: payload.trackIds } } });
      expect(sources.map((t) => t.state)).toEqual(["MERGED", "MERGED"]);
      const event = await prisma.videoTimelineEvent.findFirst({ where: { trackId: mergedTrackId, code: "TRACK_MERGED" } });
      expect(event).toMatchObject({ teamId: a.teamId, evidenceId: video.id, layer: "TRACKING", actorUserId: a.ownerUserId, startFrame: 0, endFrame: 120 });
    });
  });
});
