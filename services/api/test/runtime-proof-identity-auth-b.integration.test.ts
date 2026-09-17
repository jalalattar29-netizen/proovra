/**
 * BATCH K1 (identity-auth, part B) — runtime proof of the WORKSPACE identity
 * administration actions and the lost-factor recovery preflight.
 *
 * Organization A is an Enterprise customer (ssoScim entitled), built the way
 * the billing suites build one. Its owner answers every workspace step-up with
 * a verified authenticator app through the real
 * `/v1/identity-security/step-up/start|check` routes, bound to the exact
 * purpose + resource each mutation consumes.
 *
 * Each action: authorized success + the durable column re-read, the audit
 * record (AdminAuditLog where the service writes one, else the SecurityEvent
 * it does write), and an expected refusal (wrong role -> 403, other tenant ->
 * the family's concealed 404) with no durable effect.
 *
 * TOTP codes are single-use per 30s step (WCC-NEW-008). Independent step-ups
 * reset the factor's step ledger (`lastUsedAt = null`) first, standing in for
 * the time a real operator waits between two unrelated actions.
 *
 * Email is the recording provider; the recovery token is read from the
 * recorded message's actionable link, never from the database.
 */

import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Json = Record<string, unknown>;

describe("K1 identity-auth (B) — workspace identity administration (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let recorder: typeof import("@proovra/shared-runtime");
  let orgA: string;
  let connA: string;
  let connB: string;

  const secrets = new Map<string, Buffer>();
  const factorIds = new Map<string, string>();
  const CERT_CURRENT = "MIIC" + "A".repeat(160);
  const CERT_NEXT = "MIIC" + "B".repeat(160);
  const fp = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");

  const call = (opts: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
    token?: string;
    payload?: unknown;
    challengeId?: string;
  }) =>
    harness.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.challengeId ? { "x-proovra-step-up-challenge-id": opts.challengeId } : {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });
  const json = (res: { body: string }) => JSON.parse(res.body) as Json;
  const code = (res: { body: string }) => (json(res).error as Json | undefined)?.code;

  async function eventually<T>(label: string, read: () => Promise<T | null | undefined>): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`${label} was never written`);
      await new Promise((r) => setImmediate(r));
    }
  }

  const auditRow = (action: string, resourceId: string) =>
    eventually(`audit ${action}`, () =>
      prisma.adminAuditLog.findFirst({ where: { action, resourceId }, orderBy: { createdAt: "desc" } }),
    );

  const securityEvent = (eventType: string, teamId: string, match: Json) =>
    eventually(`security event ${eventType}`, () =>
      prisma.securityEvent.findFirst({
        where: {
          eventType,
          teamId,
          AND: Object.entries(match).map(([k, v]) => ({ details: { path: [k], equals: v as string } })),
        },
        orderBy: { createdAt: "desc" },
      }),
    );

  async function seedTotp(userId: string): Promise<string> {
    const { sealSecret } = await import("../src/services/security/mfa-secret-storage.js");
    const secret = totp.generateTotpSecretBytes();
    const sealed = sealSecret(secret);
    const now = new Date();
    const row = await prisma.mfaFactor.create({
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
      select: { id: true },
    });
    secrets.set(userId, secret);
    factorIds.set(userId, row.id);
    return row.id;
  }

  async function freshCode(userId: string): Promise<string> {
    await prisma.mfaFactor.updateMany({
      where: { userId, kind: "TOTP", status: "ACTIVE" },
      data: { lastUsedAt: null },
    });
    return totp.computeTotpCode(secrets.get(userId)!, totp.timeStep(Math.floor(Date.now() / 1000)));
  }

  /** A challenge approved by the owner's authenticator, bound to one resource. */
  async function ownerStepUp(purpose: string, resourceKind: string, resourceId: string): Promise<string> {
    const { ownerToken, ownerUserId, teamId } = harness.fixtures.teamA;
    const started = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      token: ownerToken,
      payload: { teamId, purpose, resourceKind, resourceId },
    });
    expect(started.statusCode, started.body).toBe(200);
    expect(json(started).method).toBe("TOTP");
    const challengeId = (json(started).challenge as { id: string }).id;
    const checked = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/check",
      token: ownerToken,
      payload: { teamId, challengeId, code: await freshCode(ownerUserId) },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    return challengeId;
  }

  function mailedToken(email: string): string | null {
    const alias = recorder.recipientAliasFor(email);
    const inMemory = recorder.recordedEmails().filter((m) => m.recipientAlias === alias);
    const mails = inMemory.length
      ? inMemory
      : recorder.readRecordedEmailFile().filter((m) => m.recipientAlias === alias);
    const last = mails.filter((m) => m.result === "acknowledged" && m.actionableLink).at(-1);
    return last?.actionableLink ? new URL(last.actionableLink).searchParams.get("token") : null;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    totp = await import("../src/services/security/mfa-totp.js");
    recorder = await import("@proovra/shared-runtime");

    const { teamA, teamB } = harness.fixtures;
    orgA = (
      await prisma.team.findUniqueOrThrow({ where: { id: teamA.teamId }, select: { organizationId: true } })
    ).organizationId;
    await prisma.team.update({
      where: { id: teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" },
    });
    const { upsertEnterpriseContract } = await import(
      "../src/services/organization/enterprise-contract.service.js"
    );
    await upsertEnterpriseContract(prisma as never, {
      organizationId: orgA,
      status: "ACTIVE",
      activationState: "ACTIVATED",
      seatCount: 25,
    });

    await seedTotp(teamA.ownerUserId);
    // The COLLECTION routes act in the caller's current workspace.
    for (const id of [teamA.ownerUserId, teamA.viewerUserId]) {
      await prisma.user.update({ where: { id }, data: { currentWorkspaceId: teamA.teamId } });
    }

    const saml = (teamId: string, name: string) =>
      prisma.ssoConnection.create({
        data: {
          teamId,
          provider: "GENERIC_SAML",
          displayName: name,
          createdByUserId: harness.fixtures.teamA.ownerUserId,
          allowedEmailDomains: [],
          status: "ACTIVE",
          samlEntityId: `https://idp.test.proovra.local/${randomUUID()}`,
          samlSsoUrl: "https://idp.test.proovra.local/sso",
          samlCertificate: CERT_CURRENT,
          samlCertFingerprint: fp(CERT_CURRENT),
          samlCertificateNext: CERT_NEXT,
          samlCertNextFingerprint: fp(CERT_NEXT),
        },
        select: { id: true },
      });
    connA = (await saml(teamA.teamId, "K1 Org A IdP")).id;
    connB = (await saml(teamB.teamId, "K1 Org B IdP")).id;
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      const teamIds = [harness.fixtures.teamA.teamId, harness.fixtures.teamB.teamId];
      await prisma.ssoConnection.deleteMany({ where: { teamId: { in: teamIds } } }).catch(() => undefined);
      await prisma.externalIdentityMapping.deleteMany({ where: { teamId: { in: teamIds } } }).catch(() => undefined);
      await prisma.mfaRecoveryRequest.deleteMany({ where: { teamId: { in: teamIds } } }).catch(() => undefined);
    }
    await harness?.cleanup();
  });

  // ===========================================================================
  // SAML attribute mapping + certificate rotation
  // ===========================================================================

  describe("SAML connection administration", () => {
    const privileged = {
      email: "mail",
      name: "displayName",
      externalId: null,
      groupClaim: "groups",
      defaultRole: "MEMBER",
      groupRoleMap: [{ group: "secops", role: "ADMIN" }],
    };

    it("POST /v1/saml/mapping/preview — an owner previews a privilege-granting mapping without persisting it; a member and another tenant are refused", async () => {
      const { ownerToken, ownerUserId, memberToken, teamId } = harness.fixtures.teamA;
      const payload = {
        teamId,
        connectionId: connA,
        mapping: privileged,
        sampleAttributes: { mail: "ops@test.proovra.local", displayName: "Ops", groups: "secops" },
      };
      const res = await call({ method: "POST", url: "/v1/saml/mapping/preview", token: ownerToken, payload });
      expect(res.statusCode, res.body).toBe(200);
      // The shape the mapping console reads (`r.preview.privilegeAffecting`).
      const preview = json(res).preview as Json;
      expect(Object.keys(preview).sort()).toEqual(
        ["changes", "privilegeAffecting", "sampleResolution", "warnings"],
      );
      expect(preview.privilegeAffecting).toBe(true);
      expect(preview.sampleResolution).toEqual({
        email: "ops@test.proovra.local",
        name: "Ops",
        externalId: null,
        role: "ADMIN",
        matchedGroup: "secops",
      });
      expect((preview.warnings as Json[]).map((w) => w.code)).toContain("GROUP_ROLE_INCLUDES_OWNER_OR_ADMIN");
      // A preview is read-only by design.
      expect((await prisma.ssoConnection.findUniqueOrThrow({ where: { id: connA } })).samlAttributeMapping).toBeNull();
      const event = await securityEvent("saml_mapping_previewed", teamId, {
        actorUserId: ownerUserId,
        connectionId: connA,
      });
      expect(event.severity).toBe("WARNING");

      const member = await call({ method: "POST", url: "/v1/saml/mapping/preview", token: memberToken, payload });
      expect(member.statusCode).toBe(403);
      expect(json(member)).toEqual({
        error: { code: "permission_denied", reason: "identity_ops_require_admin_role" },
      });
      const outsider = harness.fixtures.teamB.ownerToken;
      const foreign = await call({ method: "POST", url: "/v1/saml/mapping/preview", token: outsider, payload });
      const absent = await call({
        method: "POST",
        url: "/v1/saml/mapping/preview",
        token: outsider,
        payload: { ...payload, teamId: randomUUID() },
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(absent.body);
      // Another tenant's connection id under the caller's own workspace.
      const crossConn = await call({
        method: "POST",
        url: "/v1/saml/mapping/preview",
        token: ownerToken,
        payload: { ...payload, connectionId: connB },
      });
      expect(crossConn.statusCode).toBe(400);
      expect(code(crossConn)).toBe("connection_not_found");
    });

    it("PUT /v1/saml/mapping — a plain mapping saves directly, a privilege-granting one only with a bound step-up; refusals persist nothing", async () => {
      const { ownerToken, ownerUserId, viewerToken, teamId } = harness.fixtures.teamA;
      const plain = { email: "mail", name: "displayName", externalId: null, groupClaim: null, defaultRole: "MEMBER", groupRoleMap: [] };
      const saved = await call({
        method: "PUT",
        url: "/v1/saml/mapping",
        token: ownerToken,
        payload: { teamId, connectionId: connA, mapping: plain, acknowledgePrivilegeImpact: false },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(json(saved).result).toMatchObject({ ok: true, connectionId: connA, privilegeAffecting: false });
      expect((await prisma.ssoConnection.findUniqueOrThrow({ where: { id: connA } })).samlAttributeMapping).toEqual(plain);

      const body = { teamId, connectionId: connA, mapping: privileged, acknowledgePrivilegeImpact: true };
      const gated = await call({ method: "PUT", url: "/v1/saml/mapping", token: ownerToken, payload: body });
      expect(gated.statusCode).toBe(401);
      expect(code(gated)).toBe("STEP_UP_REQUIRED");
      const viewer = await call({ method: "PUT", url: "/v1/saml/mapping", token: viewerToken, payload: body });
      expect(viewer.statusCode).toBe(403);
      const foreign = await call({
        method: "PUT",
        url: "/v1/saml/mapping",
        token: harness.fixtures.teamB.ownerToken,
        payload: body,
      });
      expect(foreign.statusCode).toBe(404);
      expect(json(foreign)).toEqual({ error: { code: "not_found" } });
      expect((await prisma.ssoConnection.findUniqueOrThrow({ where: { id: connA } })).samlAttributeMapping).toEqual(plain);

      const challengeId = await ownerStepUp("SAML_MAPPING_PRIVILEGE_UPDATE", "saml_connection", connA);
      const res = await call({ method: "PUT", url: "/v1/saml/mapping", token: ownerToken, payload: body, challengeId });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).result).toMatchObject({ ok: true, privilegeAffecting: true });
      expect((await prisma.ssoConnection.findUniqueOrThrow({ where: { id: connA } })).samlAttributeMapping).toEqual(
        privileged,
      );
      expect((await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id: challengeId } })).status).toBe("CANCELLED"); // consumed
      await securityEvent("saml_mapping_updated", teamId, { actorUserId: ownerUserId, connectionId: connA });
      await securityEvent("saml_mapping_privilege_warning", teamId, { actorUserId: ownerUserId, connectionId: connA });
    });

    it("DELETE /v1/auth/saml/:connectionId/certificate-next — an owner promotes the rotation certificate; a member, another tenant and a second promotion are refused", async () => {
      const { ownerToken, ownerUserId, memberToken, teamId } = harness.fixtures.teamA;
      const url = (id: string) => `/v1/auth/saml/${id}/certificate-next`;

      const member = await call({ method: "DELETE", url: url(connA), token: memberToken });
      expect(member.statusCode).toBe(403);
      expect(json(member)).toEqual({ error: { code: "forbidden" } });
      const outsider = harness.fixtures.teamB.ownerToken;
      const foreign = await call({ method: "DELETE", url: url(connA), token: harness.fixtures.teamB.memberToken });
      const absent = await call({ method: "DELETE", url: url(randomUUID()), token: outsider });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(absent.body);
      const unchanged = await prisma.ssoConnection.findUniqueOrThrow({ where: { id: connA } });
      expect(unchanged.samlCertificate).toBe(CERT_CURRENT);
      expect(unchanged.samlCertificateNext).toBe(CERT_NEXT);

      // D10 — promotion changes which IdP certificate is trusted, so even the
      // owner is refused without a step-up bound to this connection.
      const unstepped = await call({ method: "DELETE", url: url(connA), token: ownerToken });
      expect(unstepped.statusCode).toBe(401);
      expect(code(unstepped)).toBe("STEP_UP_REQUIRED");
      expect((await prisma.ssoConnection.findUniqueOrThrow({ where: { id: connA } })).samlCertificateNext).toBe(CERT_NEXT);

      const challengeId = await ownerStepUp("EXTERNAL_IDENTITY_LINK", "sso_connection", connA);
      const res = await call({ method: "DELETE", url: url(connA), token: ownerToken, challengeId });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toEqual({ ok: true, certFingerprint: fp(CERT_NEXT) });
      const row = await prisma.ssoConnection.findUniqueOrThrow({ where: { id: connA } });
      expect(row).toMatchObject({
        samlCertificate: CERT_NEXT,
        samlCertFingerprint: fp(CERT_NEXT),
        samlCertificateNext: null,
        samlCertNextFingerprint: null,
      });
      expect(row.rotatedAtUtc).not.toBeNull();
      await securityEvent("saml_certificate_rotated", teamId, {
        actorUserId: ownerUserId,
        connectionId: connA,
        action: "next_cert_promoted",
      });

      const again = await call({
        method: "DELETE",
        url: url(connA),
        token: ownerToken,
        challengeId: await ownerStepUp("EXTERNAL_IDENTITY_LINK", "sso_connection", connA),
      });
      expect(again.statusCode).toBe(409);
      expect(code(again)).toBe("no_next_certificate");
      // Organization B's own connection is untouched by all of this.
      expect((await prisma.ssoConnection.findUniqueOrThrow({ where: { id: connB } })).samlCertificateNext).toBe(CERT_NEXT);
    });
  });

  // ===========================================================================
  // Capability grants, delegated scopes, external mappings
  // ===========================================================================

  describe("member access administration", () => {
    async function memberRowId(): Promise<string> {
      const { teamId, memberUserId } = harness.fixtures.teamA;
      return (
        await prisma.teamMember.findUniqueOrThrow({
          where: { teamId_userId: { teamId, userId: memberUserId } },
          select: { id: true },
        })
      ).id;
    }

    it("DELETE /v1/identity/capabilities/:id — the owner revokes a grant under a bound step-up; a member, another tenant and a missing step-up change nothing", async () => {
      const { ownerToken, ownerUserId, memberToken, teamId } = harness.fixtures.teamA;
      const { grantCapability } = await import("../src/services/identity/membership-provisioning.service.js");
      const grant = await grantCapability({
        teamId,
        teamMemberId: await memberRowId(),
        permission: "audit.export",
        reason: "K1 quarterly audit",
        actorUserId: ownerUserId,
      });
      const url = `/v1/identity/capabilities/${grant.id}`;

      const member = await call({ method: "DELETE", url, token: memberToken, payload: {} });
      expect(member.statusCode).toBe(403);
      expect(code(member)).toBe("permission_denied");
      const foreign = await call({ method: "DELETE", url, token: harness.fixtures.teamB.ownerToken, payload: {} });
      const absent = await call({
        method: "DELETE",
        url: `/v1/identity/capabilities/${randomUUID()}`,
        token: harness.fixtures.teamB.ownerToken,
        payload: {},
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(absent.body);
      const noStepUp = await call({ method: "DELETE", url, token: ownerToken, payload: {} });
      expect(noStepUp.statusCode).toBe(401);
      expect(code(noStepUp)).toBe("STEP_UP_REQUIRED");
      expect((await prisma.memberCapabilityGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAtUtc).toBeNull();

      const challengeId = await ownerStepUp("CAPABILITY_REVOKE", "member_capability_grant", grant.id);
      const res = await call({
        method: "DELETE",
        url,
        token: ownerToken,
        payload: { reason: "Audit complete" },
        challengeId,
      });
      expect(res.statusCode, res.body).toBe(200);
      const row = await prisma.memberCapabilityGrant.findUniqueOrThrow({ where: { id: grant.id } });
      expect(row.revokedAtUtc).not.toBeNull();
      expect(row).toMatchObject({ revokedByUserId: ownerUserId, revokedReason: "Audit complete" });
      const audit = await auditRow("identity.capability.revoke", grant.id);
      expect(audit).toMatchObject({
        userId: ownerUserId,
        workspaceId: teamId,
        resourceType: "member_capability_grant",
        outcome: "success",
      });
    });

    it("DELETE /v1/identity/delegated-admin/:id — the owner revokes a delegated scope under a bound step-up; a member and another tenant are refused", async () => {
      const { ownerToken, ownerUserId, memberToken, teamId } = harness.fixtures.teamA;
      const { grantDelegatedAdminScope } = await import(
        "../src/services/identity/membership-provisioning.service.js"
      );
      const scope = await grantDelegatedAdminScope({
        teamId,
        teamMemberId: await memberRowId(),
        scopeKind: "REVIEW_ADMIN",
        reason: "K1 review cover",
        actorUserId: ownerUserId,
      });
      const url = `/v1/identity/delegated-admin/${scope.id}`;

      const member = await call({ method: "DELETE", url, token: memberToken, payload: {} });
      expect(member.statusCode).toBe(403);
      expect(code(member)).toBe("permission_denied");
      const foreign = await call({ method: "DELETE", url, token: harness.fixtures.teamB.adminToken, payload: {} });
      expect(foreign.statusCode).toBe(404);
      expect(json(foreign)).toEqual({ error: { code: "not_found" } });
      // A declared workspace that disagrees with the target is concealed too.
      const mismatch = await call({
        method: "DELETE",
        url,
        token: ownerToken,
        payload: { teamId: harness.fixtures.teamB.teamId },
      });
      expect(mismatch.statusCode).toBe(404);
      expect((await prisma.memberDelegatedAdminScope.findUniqueOrThrow({ where: { id: scope.id } })).revokedAtUtc).toBeNull();

      const challengeId = await ownerStepUp("DELEGATED_ADMIN_REVOKE", "delegated_admin_scope", scope.id);
      const res = await call({ method: "DELETE", url, token: ownerToken, payload: {}, challengeId });
      expect(res.statusCode, res.body).toBe(200);
      const row = await prisma.memberDelegatedAdminScope.findUniqueOrThrow({ where: { id: scope.id } });
      expect(row.revokedAtUtc).not.toBeNull();
      expect(row.revokedByUserId).toBe(ownerUserId);
      const audit = await auditRow("identity.delegated_admin.revoke", scope.id);
      expect(audit).toMatchObject({ userId: ownerUserId, workspaceId: teamId, outcome: "success" });
    });

    it("POST + DELETE /v1/identity/external-mappings — the owner links a member's IdP subject and unlinks it, each under its own step-up; a viewer, a foreign subject and another tenant are refused", async () => {
      const { ownerToken, ownerUserId, memberUserId, viewerToken, teamId } = harness.fixtures.teamA;
      const subject = `okta|${randomUUID()}`;
      const body = { userId: memberUserId, provider: "OKTA", externalSubjectId: subject, displayName: null };

      const viewer = await call({ method: "POST", url: "/v1/identity/external-mappings", token: viewerToken, payload: body });
      expect(viewer.statusCode).toBe(403);
      expect(code(viewer)).toBe("permission_denied");
      // Organization B's owner has no current workspace in A: concealed.
      const outsider = await call({
        method: "POST",
        url: "/v1/identity/external-mappings",
        token: harness.fixtures.teamB.ownerToken,
        payload: { ...body, teamId },
      });
      expect(outsider.statusCode).toBe(404);
      // A subject who is not a member of A is concealed, even after step-up.
      const foreignUser = harness.fixtures.teamB.memberUserId;
      const foreignChallenge = await ownerStepUp("EXTERNAL_IDENTITY_LINK", "user", foreignUser);
      const foreignSubject = await call({
        method: "POST",
        url: "/v1/identity/external-mappings",
        token: ownerToken,
        payload: { ...body, userId: foreignUser },
        challengeId: foreignChallenge,
      });
      expect(foreignSubject.statusCode).toBe(404);
      expect(code(foreignSubject)).toBe("user_not_in_workspace");
      expect(await prisma.externalIdentityMapping.count({ where: { externalSubjectId: subject } })).toBe(0);

      const linkChallenge = await ownerStepUp("EXTERNAL_IDENTITY_LINK", "user", memberUserId);
      const linked = await call({
        method: "POST",
        url: "/v1/identity/external-mappings",
        token: ownerToken,
        payload: body,
        challengeId: linkChallenge,
      });
      expect(linked.statusCode, linked.body).toBe(200);
      const mappingId = (json(linked).mapping as { id: string }).id;
      const row = await prisma.externalIdentityMapping.findUniqueOrThrow({ where: { id: mappingId } });
      expect(row).toMatchObject({
        teamId,
        userId: memberUserId,
        provider: "OKTA",
        externalSubjectId: subject,
        unlinkedAtUtc: null,
      });
      expect(await auditRow("identity.external_mapping.link", mappingId)).toMatchObject({
        userId: ownerUserId,
        workspaceId: teamId,
        outcome: "success",
      });

      const url = `/v1/identity/external-mappings/${mappingId}`;
      const foreignDelete = await call({ method: "DELETE", url, token: harness.fixtures.teamB.ownerToken, payload: {} });
      expect(foreignDelete.statusCode).toBe(404);
      const viewerDelete = await call({ method: "DELETE", url, token: viewerToken, payload: {} });
      expect(viewerDelete.statusCode).toBe(403);
      expect((await prisma.externalIdentityMapping.findUniqueOrThrow({ where: { id: mappingId } })).unlinkedAtUtc).toBeNull();

      const unlinkChallenge = await ownerStepUp("EXTERNAL_IDENTITY_UNLINK", "external_identity_mapping", mappingId);
      const unlinked = await call({ method: "DELETE", url, token: ownerToken, payload: {}, challengeId: unlinkChallenge });
      expect(unlinked.statusCode, unlinked.body).toBe(200);
      expect((await prisma.externalIdentityMapping.findUniqueOrThrow({ where: { id: mappingId } })).unlinkedAtUtc).not.toBeNull();
      expect(await auditRow("identity.external_mapping.unlink", mappingId)).toMatchObject({
        userId: ownerUserId,
        workspaceId: teamId,
        outcome: "success",
      });
    });

    it("POST /v1/identity/mfa-admin/factors/:teamId/:userId/:factorId/revoke — the owner revokes a member's authenticator under a factor-bound step-up; a member and another tenant are concealed", async () => {
      const { ownerToken, ownerUserId, memberUserId, viewerToken, teamId } = harness.fixtures.teamA;
      const factorId = await seedTotp(memberUserId);
      const url = `/v1/identity/mfa-admin/factors/${teamId}/${memberUserId}/${factorId}/revoke`;
      const payload = { reason: "Lost device" };

      const viewer = await call({ method: "POST", url, token: viewerToken, payload });
      const outsider = await call({ method: "POST", url, token: harness.fixtures.teamB.ownerToken, payload });
      const absent = await call({
        method: "POST",
        url: `/v1/identity/mfa-admin/factors/${randomUUID()}/${memberUserId}/${factorId}/revoke`,
        token: harness.fixtures.teamB.ownerToken,
        payload,
      });
      // A workspace member without the capability is told the truth (403);
      // it already knows the workspace exists.
      expect(viewer.statusCode).toBe(403);
      expect(code(viewer)).toBe("permission_denied");
      // Another tenant is told exactly what a missing workspace is told.
      for (const res of [outsider, absent]) {
        expect(res.statusCode).toBe(404);
        expect(json(res)).toEqual({ error: { code: "not_found" } });
      }
      // A non-admin who HOLDS the capability is still not an MFA
      // administrator. D14 — they are a member, so they are told the truth
      // too: the OWNER/ADMIN narrowing answers the same 403 as above.
      const { grantCapability, revokeCapability } = await import(
        "../src/services/identity/membership-provisioning.service.js"
      );
      const viewerMember = await prisma.teamMember.findUniqueOrThrow({
        where: { teamId_userId: { teamId, userId: harness.fixtures.teamA.viewerUserId } },
        select: { id: true },
      });
      const grant = await grantCapability({
        teamId,
        teamMemberId: viewerMember.id,
        permission: "identity.access_review.action",
        actorUserId: ownerUserId,
      });
      try {
        const narrowed = await call({ method: "POST", url, token: viewerToken, payload });
        expect(narrowed.statusCode).toBe(403);
        expect(narrowed.body).toBe(viewer.body);
      } finally {
        await revokeCapability({ teamId, grantId: grant.id, actorUserId: ownerUserId });
      }
      // A challenge bound to a DIFFERENT factor does not authorize this one.
      const other = await ownerStepUp("MFA_FACTOR_REVOKE", "mfa_factor", randomUUID());
      const wrongBinding = await call({ method: "POST", url, token: ownerToken, payload, challengeId: other });
      expect(wrongBinding.statusCode).toBe(401);
      expect((await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factorId } })).status).toBe("ACTIVE");

      const challengeId = await ownerStepUp("MFA_FACTOR_REVOKE", "mfa_factor", factorId);
      const res = await call({ method: "POST", url, token: ownerToken, payload, challengeId });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toEqual({ ok: true, targetUserId: memberUserId, factorId });
      const row = await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factorId } });
      expect(row).toMatchObject({ status: "REVOKED", revokedReason: "Lost device" });
      expect(row.revokedAt).not.toBeNull();
      expect(await auditRow("mfa.admin.factor_revoked", factorId)).toMatchObject({
        userId: ownerUserId,
        workspaceId: teamId,
        outcome: "success",
      });
    });
  });

  // ===========================================================================
  // Lost-factor recovery preflight (the requester drives their own request)
  // ===========================================================================

  describe("MFA recovery request preflight", () => {
    let requestId = "";
    let firstToken = "";
    let secondToken = "";

    beforeAll(async () => {
      const { viewerToken, viewerUserId, teamId } = harness.fixtures.teamA;
      const created = await call({
        method: "POST",
        url: "/v1/identity/mfa-admin/recovery-requests",
        token: viewerToken,
        payload: { teamId, reason: "Phone was lost on a site visit" },
      });
      expect(created.statusCode, created.body).toBe(200);
      requestId = (json(created).request as { id: string }).id;
      const viewer = await prisma.user.findUniqueOrThrow({ where: { id: viewerUserId } });
      firstToken = mailedToken(viewer.email as string) as string;
      expect(firstToken).toEqual(expect.any(String));
    });

    it("POST /v1/identity/mfa/recovery-requests/:id/resend-email — the requester rotates the link; another user and an immediate repeat are refused", async () => {
      const { viewerToken, viewerUserId, memberToken, teamId } = harness.fixtures.teamA;
      const url = `/v1/identity/mfa/recovery-requests/${requestId}/resend-email`;
      const before = await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id: requestId } });

      // D11 — another user's request answers exactly like a missing one.
      const other = await call({ method: "POST", url, token: memberToken });
      expect(other.statusCode).toBe(404);
      expect(json(other)).toEqual({ error: "request_not_found" });
      const missing = await call({
        method: "POST",
        url: `/v1/identity/mfa/recovery-requests/${randomUUID()}/resend-email`,
        token: memberToken,
      });
      expect(missing.statusCode).toBe(404);
      expect((await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id: requestId } })).emailResendCount).toBe(
        before.emailResendCount,
      );

      const res = await call({ method: "POST", url, token: viewerToken });
      expect(res.statusCode, res.body).toBe(200);
      const after = await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(after.emailResendCount).toBe(before.emailResendCount + 1);
      expect(after.emailVerificationTokenHash).not.toBe(before.emailVerificationTokenHash);
      expect(after.emailResendBlockedUntil!.getTime()).toBeGreaterThan(Date.now());
      const viewer = await prisma.user.findUniqueOrThrow({ where: { id: viewerUserId } });
      secondToken = mailedToken(viewer.email as string) as string;
      expect(secondToken).not.toBe(firstToken);
      // Route writes no AdminAuditLog; its record is the SecurityEvent.
      await securityEvent("mfa_recovery_email_verification_sent", teamId, {
        actorUserId: viewerUserId,
        requestId,
      });

      const repeat = await call({ method: "POST", url, token: viewerToken });
      expect(repeat.statusCode).toBe(429);
      expect(json(repeat).error).toBe("resend_throttled");
      expect((await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id: requestId } })).emailResendCount).toBe(
        after.emailResendCount,
      );
    });

    it("POST /v1/identity/mfa/recovery-requests/:id/verify-email — the current link (no session) moves the request to admin review; the rotated-out link and another signed-in user are refused", async () => {
      const { viewerUserId, memberToken, teamId } = harness.fixtures.teamA;
      const url = `/v1/identity/mfa/recovery-requests/${requestId}/verify-email`;

      const stale = await call({ method: "POST", url, payload: { token: firstToken } });
      expect(stale.statusCode).toBe(400);
      expect(json(stale)).toEqual({ error: "token_invalid" });
      const otherUser = await call({ method: "POST", url, token: memberToken, payload: { token: secondToken } });
      // D11 — concealed as a missing request.
      expect(otherUser.statusCode).toBe(404);
      expect(json(otherUser)).toEqual({ error: "request_not_found" });
      expect((await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe(
        "EMAIL_VERIFICATION_PENDING",
      );

      const res = await call({ method: "POST", url, payload: { token: secondToken } });
      expect(res.statusCode, res.body).toBe(200);
      const row = await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(row.status).toBe("PENDING_ADMIN_REVIEW");
      expect(row.emailVerifiedAt).not.toBeNull();
      expect(row.emailVerificationTokenHash).toBeNull();
      expect(await auditRow("mfa.recovery.email_verified", requestId)).toMatchObject({
        userId: viewerUserId,
        workspaceId: teamId,
        outcome: "success",
      });

      const replay = await call({ method: "POST", url, payload: { token: secondToken } });
      expect(replay.statusCode).toBe(400);
      expect(json(replay)).toEqual({ error: "request_not_in_email_pending" });
    });

    it("POST /v1/identity/mfa/recovery-requests/:id/cancel — the requester withdraws the request; another user is refused and a second cancel is bounded", async () => {
      const { viewerToken, viewerUserId, memberToken, teamId } = harness.fixtures.teamA;
      const url = `/v1/identity/mfa/recovery-requests/${requestId}/cancel`;

      // D11 — another user's request answers exactly like a missing one.
      const other = await call({ method: "POST", url, token: memberToken });
      expect(other.statusCode).toBe(404);
      expect(json(other)).toEqual({ error: "request_not_found" });
      expect((await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe(
        "PENDING_ADMIN_REVIEW",
      );

      const res = await call({ method: "POST", url, token: viewerToken });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toEqual({ ok: true });
      const row = await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(row.status).toBe("CANCELLED");
      expect(row.cancelledAtUtc).not.toBeNull();
      expect(await auditRow("mfa.recovery.cancelled", requestId)).toMatchObject({
        userId: viewerUserId,
        workspaceId: teamId,
        outcome: "success",
      });

      const again = await call({ method: "POST", url, token: viewerToken });
      expect(again.statusCode).toBe(400);
      expect(json(again)).toEqual({ error: "request_not_pending" });
    });
  });
});
