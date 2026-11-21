/**
 * Closure evidence (WS-AUTH rows) — behavioural proofs through the real routes
 * and services against a disposable PostgreSQL (harness.app.inject):
 *
 *   PRO-A1-07   re-accepting a policy keeps the earlier acceptance in the audit
 *               chain; the same version again changes nothing
 *   PRO-A1-11   every ACTIVE authenticator answers the sign-in second factor;
 *               activating a new authenticator retires earlier recovery batches
 *   PRO-A1-13   session-light answers "not signed in" for restricted-scope tokens
 *   PRO-A1Z-04  binding a phone factor ends outstanding step-up approvals
 *   PRO-P3AZ-02 the deprecated MFA policy PUT honours the version the client loaded
 *
 * Only the messaging transport is the recording provider; nothing external is
 * contacted.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { makeEnterpriseOrganizationWorkspace } from "./support/enterprise-organization.js";
import type { FixtureDeps } from "./point7/product-fixtures.js";

// PRO-A1-07 — an audit-append fault switch for the legal-acceptance history row only.
const faults = vi.hoisted(() => ({ legalAudit: false }));
vi.mock("../src/services/audit/tenant-audit.service.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/audit/tenant-audit.service.js")>();
  return {
    ...real,
    emitTenantAudit: async (...args: Parameters<typeof real.emitTenantAudit>) => {
      if (faults.legalAudit && (args[0] as { action?: string }).action === "identity.legal_accepted") {
        throw new Error("simulated audit append failure");
      }
      return real.emitTenantAudit(...args);
    },
  };
});

type Json = Record<string, unknown>;
type Res = { statusCode: number; body: string; headers: Record<string, unknown> };

describe("closure evidence — WS-AUTH rows (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let auth: typeof import("../src/services/email-password-auth.service.js");
  let jwt: typeof import("../src/services/jwt.js");
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let mfa: typeof import("../src/services/security/mfa.service.js");
  let seal: typeof import("../src/services/security/mfa-secret-storage.js");
  let legalVersions: typeof import("../src/legal/legal-versioning.js");
  let recording: typeof import("../src/services/communications/recording-provider.js");
  let fx: typeof import("./point7/product-fixtures.js");
  let ceremony: ReturnType<(typeof import("./support/step-up-ceremony.js"))["createStepUpCeremony"]>;
  let resetLimits: () => Promise<void>;
  let clearRates: () => Promise<unknown>;
  let deps: FixtureDeps;
  const password = "Str0ng-evid-closure-passphrase!";
  let ip = 1;

  const call = (method: string, url: string, token: string | null, payload?: unknown, extra: Record<string, string> = {}): Promise<Res> =>
    h.app.inject({
      method: method as never,
      url,
      remoteAddress: `198.18.0.${(ip++ % 250) + 1}`,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    }) as unknown as Promise<Res>;
  const json = (r: Res) => JSON.parse(r.body) as Json;
  const errorCode = (r: Res) => ((json(r).error ?? {}) as { code?: string }).code;

  async function acceptAll(userId: string) {
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legalVersions.REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId,
        policyKey,
        policyVersion: policyVersion as string,
        source: "evid-fixture",
      })),
    });
  }

  async function passwordAccount(label: string) {
    const email = `evid-${label}-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const u = await prisma.user.create({
      data: {
        email,
        provider: "EMAIL",
        providerUserId: email,
        passwordHash: await auth.hashPassword(password),
        emailVerifiedAt: new Date(),
      },
    });
    await acceptAll(u.id);
    await fx.bootstrapPersonalSpace(deps, u.id);
    return { id: u.id, email };
  }

  async function activeTotp(userId: string, label: string, createdAt: Date): Promise<Buffer> {
    const secret = totp.generateTotpSecretBytes();
    const sealed = seal.sealSecret(secret);
    await prisma.mfaFactor.create({
      data: {
        userId,
        kind: "TOTP",
        status: "ACTIVE",
        label,
        secretCiphertext: Buffer.from(sealed.ciphertext),
        secretIv: Buffer.from(sealed.iv),
        secretAuthTag: Buffer.from(sealed.authTag),
        secretKekId: sealed.kekId,
        verifiedAtUtc: createdAt,
        enrolledAt: createdAt,
        createdAt,
      },
    });
    return secret;
  }
  const codeOf = (secret: Buffer) => totp.computeTotpCode(secret, totp.timeStep(Math.floor(Date.now() / 1000)));
  const notCodeOf = (...secrets: Buffer[]) => {
    for (const c of ["000000", "111111", "222222", "333333"]) {
      if (!secrets.some((s) => codeOf(s) === c)) return c;
    }
    throw new Error("unreachable");
  };

  const login = (email: string) => call("POST", "/v1/auth/email/login", null, { email, password });
  const verifyMfa = (pending: string, code: string) => call("POST", "/v1/auth/mfa/verify", null, { mfaPendingToken: pending, code });

  const lastCodeTo = (phone: string): string | undefined =>
    recording
      .recordedMessages()
      .filter((m) => m.recipientAlias === recording.recipientAliasForPhone(phone) && m.code)
      .at(-1)?.code ?? undefined;
  const randomPhone = () => `+1415556${String(1000 + Math.floor(Math.random() * 8999))}`;

  beforeAll(async () => {
    process.env.MESSAGING_TRANSPORT = "recording";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    auth = await import("../src/services/email-password-auth.service.js");
    jwt = await import("../src/services/jwt.js");
    totp = await import("../src/services/security/mfa-totp.js");
    mfa = await import("../src/services/security/mfa.service.js");
    seal = await import("../src/services/security/mfa-secret-storage.js");
    legalVersions = await import("../src/legal/legal-versioning.js");
    recording = await import("../src/services/communications/recording-provider.js");
    fx = await import("./point7/product-fixtures.js");
    ({ __resetLoginMfaRateLimiterForTests: resetLimits } = await import("../src/routes/auth.routes.js"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    const { createStepUpCeremony } = await import("./support/step-up-ceremony.js");
    ceremony = createStepUpCeremony({ prisma: prisma as never, inject: (o) => h.app.inject(o as never) as never });
    deps = {
      prisma: prisma as never,
      tag: `evid-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        jwt.signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
  }, 300_000);

  beforeEach(async () => {
    await resetLimits();
    await clearRates();
  });

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // PRO-A1-07
  // ===========================================================================
  describe("PRO-A1-07: legal re-acceptance keeps the earlier acceptance", () => {
    const history = (userId: string) =>
      prisma.adminAuditLog.findMany({
        where: { userId, action: "identity.legal_accepted" },
        orderBy: { createdAt: "asc" },
        select: { resourceId: true, metadata: true },
      });

    it("allowed: accepting the new Terms version records the replaced version, its moment and source in the audit chain", async () => {
      const a = await passwordAccount("a107");
      const token = deps.mintToken(a.id, a.email);
      const key = Object.keys(legalVersions.REQUIRED_LEGAL_VERSIONS)[0]!;
      const current = (legalVersions.REQUIRED_LEGAL_VERSIONS as Record<string, string>)[key]!;
      const earlierAt = new Date("2025-01-02T03:04:05.000Z");
      await prisma.userLegalAcceptance.update({
        where: { userId_policyKey: { userId: a.id, policyKey: key } },
        data: { policyVersion: "2000-01-01", acceptedAt: earlierAt, source: "mobile" },
      });

      const r = await call("POST", "/v1/users/legal-acceptance", token, {
        acceptances: [{ policyKey: key, policyVersion: current }],
        source: "web",
      });
      expect(r.statusCode, r.body).toBe(200);
      const row = await prisma.userLegalAcceptance.findUniqueOrThrow({
        where: { userId_policyKey: { userId: a.id, policyKey: key } },
      });
      expect(row.policyVersion).toBe(current);
      const events = await history(a.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.resourceId).toBe(key);
      expect(events[0]!.metadata).toMatchObject({
        policyKey: key,
        acceptedVersion: current,
        previousVersion: "2000-01-01",
        previousAcceptedAt: earlierAt.toISOString(),
        previousSource: "mobile",
      });
    });

    it("refused: re-accepting the SAME version neither moves the original moment nor writes a second event", async () => {
      const a = await passwordAccount("a107same");
      const token = deps.mintToken(a.id, a.email);
      const key = Object.keys(legalVersions.REQUIRED_LEGAL_VERSIONS)[0]!;
      const current = (legalVersions.REQUIRED_LEGAL_VERSIONS as Record<string, string>)[key]!;
      const originalAt = new Date("2025-06-07T08:09:10.000Z");
      await prisma.userLegalAcceptance.update({
        where: { userId_policyKey: { userId: a.id, policyKey: key } },
        data: { acceptedAt: originalAt, source: "register" },
      });
      const r = await call("POST", "/v1/users/legal-acceptance", token, {
        acceptances: [{ policyKey: key, policyVersion: current }],
        source: "web",
      });
      expect(r.statusCode, r.body).toBe(200);
      const row = await prisma.userLegalAcceptance.findUniqueOrThrow({
        where: { userId_policyKey: { userId: a.id, policyKey: key } },
      });
      expect(row.acceptedAt.toISOString()).toBe(originalAt.toISOString());
      expect(row.source).toBe("register");
      expect(await history(a.id)).toHaveLength(0);
    });

    it("refused: when the history row cannot be written the change fails and the earlier acceptance is kept", async () => {
      const a = await passwordAccount("a107fault");
      const token = deps.mintToken(a.id, a.email);
      const key = Object.keys(legalVersions.REQUIRED_LEGAL_VERSIONS)[0]!;
      const current = (legalVersions.REQUIRED_LEGAL_VERSIONS as Record<string, string>)[key]!;
      const earlierAt = new Date("2025-03-04T05:06:07.000Z");
      await prisma.userLegalAcceptance.update({
        where: { userId_policyKey: { userId: a.id, policyKey: key } },
        data: { policyVersion: "2000-01-01", acceptedAt: earlierAt, source: "mobile" },
      });
      faults.legalAudit = true;
      let r;
      try {
        r = await call("POST", "/v1/users/legal-acceptance", token, { acceptances: [{ policyKey: key, policyVersion: current }], source: "web" });
      } finally {
        faults.legalAudit = false;
      }
      expect(r.statusCode, r.body).toBeGreaterThanOrEqual(500);
      const row = await prisma.userLegalAcceptance.findUniqueOrThrow({
        where: { userId_policyKey: { userId: a.id, policyKey: key } },
      });
      expect(row.policyVersion).toBe("2000-01-01");
      expect(row.acceptedAt.toISOString()).toBe(earlierAt.toISOString());
      expect(row.source).toBe("mobile");
      expect(await history(a.id)).toHaveLength(0);

      // A retry once the audit works records the acceptance AND its history.
      const retry = await call("POST", "/v1/users/legal-acceptance", token, { acceptances: [{ policyKey: key, policyVersion: current }], source: "web" });
      expect(retry.statusCode, retry.body).toBe(200);
      expect(await history(a.id)).toHaveLength(1);
    });

    it("refused: a version that is not the current one is answered 400 and nothing is recorded", async () => {
      const a = await passwordAccount("a107old");
      const token = deps.mintToken(a.id, a.email);
      const key = Object.keys(legalVersions.REQUIRED_LEGAL_VERSIONS)[0]!;
      const r = await call("POST", "/v1/users/legal-acceptance", token, {
        acceptances: [{ policyKey: key, policyVersion: "1999-12-31" }],
      });
      expect(r.statusCode, r.body).toBe(400);
      expect(errorCode(r)).toBe("LEGAL_POLICY_VERSION_NOT_CURRENT");
      expect(await history(a.id)).toHaveLength(0);
    });
  });

  // ===========================================================================
  // PRO-A1-11
  // ===========================================================================
  describe("PRO-A1-11: several authenticator apps", () => {
    it("allowed: a sign-in completes with the code of either ACTIVE authenticator (old and new phone)", async () => {
      for (const which of ["older", "newer"] as const) {
        await resetLimits();
        const a = await passwordAccount(`a111-${which}`);
        const older = await activeTotp(a.id, "Old phone", new Date(Date.now() - 3600_000));
        const newer = await activeTotp(a.id, "New phone", new Date());
        const pending = json(await login(a.email)).mfaPendingToken as string;
        expect(typeof pending).toBe("string");
        const ok = await verifyMfa(pending, codeOf(which === "older" ? older : newer));
        expect(ok.statusCode, `${which}: ${ok.body}`).toBe(200);
        expect(typeof json(ok).token).toBe("string");
      }
    });

    it("refused: a code from neither authenticator signs nobody in", async () => {
      const a = await passwordAccount("a111-none");
      const older = await activeTotp(a.id, "Old phone", new Date(Date.now() - 3600_000));
      const newer = await activeTotp(a.id, "New phone", new Date());
      const pending = json(await login(a.email)).mfaPendingToken as string;
      const r = await verifyMfa(pending, notCodeOf(older, newer));
      expect(r.statusCode, r.body).toBe(401);
      expect(json(r).token).toBeUndefined();
    });

    it("activating another authenticator retires the earlier recovery batch: old codes no longer sign in, the new batch does", async () => {
      const a = await passwordAccount("a111-batch");
      const first = await mfa.beginTotpEnrollment({ userId: a.id, accountName: a.email });
      const activate = async (factorId: string) => {
        const row = await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factorId } });
        const secret = seal.openSecret(mfa.requireTotpSecret(row as never));
        const done = await mfa.verifyAndActivateEnrollment({ userId: a.id, factorId, code: codeOf(secret) });
        if (!done.ok) throw new Error(`activation failed: ${done.reason}`);
        return done.recoveryCodes;
      };
      const oldCodes = await activate(first.factorId);
      const second = await mfa.beginTotpEnrollment({ userId: a.id, accountName: a.email, label: "Second" });
      const newCodes = await activate(second.factorId);

      const live = await prisma.mfaRecoveryCode.count({ where: { userId: a.id, usedAt: null, batchInvalidatedAt: null } });
      expect(live).toBe(newCodes.length);
      expect((await mfa.consumeRecoveryCode({ userId: a.id, code: oldCodes[0]! })).ok).toBe(false);
      expect((await mfa.consumeRecoveryCode({ userId: a.id, code: newCodes[0]! })).ok).toBe(true);
    });
  });

  // ===========================================================================
  // PRO-A1-13
  // ===========================================================================
  describe("PRO-A1-13: session-light and restricted-scope tokens", () => {
    const probe = async (token: string) => json(await call("GET", "/v1/auth/session-light", token)).authenticated;
    const claims = (a: { id: string; email: string }) => ({
      sub: a.id,
      provider: "EMAIL",
      email: a.email,
      authMethod: "PASSWORD",
      authAt: Math.floor(Date.now() / 1000),
    });

    for (const scope of ["mfa.enroll", "capture.direct"]) {
      it(`refused: a ${scope} token reads as not signed in, as /v1/auth/me refuses it (403)`, async () => {
        const a = await passwordAccount(`a113-${scope.replace(".", "-")}`);
        const restricted = jwt.signJwt({ ...claims(a), scope } as never, process.env.AUTH_JWT_SECRET!, 600);
        expect((await call("GET", "/v1/auth/me", restricted)).statusCode).toBe(403);
        expect(await probe(restricted)).toBe(false);
      });
    }

    it("control: the same claims without a restricted scope read as signed in", async () => {
      const a = await passwordAccount("a113-control");
      const plain = jwt.signJwt(claims(a) as never, process.env.AUTH_JWT_SECRET!, 600);
      expect(await probe(plain)).toBe(true);
    });
  });

  // ===========================================================================
  // PRO-A1Z-04
  // ===========================================================================
  describe("PRO-A1Z-04: binding a phone factor ends outstanding step-up approvals", () => {
    async function approvedChallenge(o: { workspaceId: string; owner: { userId: string; token: string } }) {
      const header = await ceremony.approvedHeader({
        token: o.owner.token,
        userId: o.owner.userId,
        teamId: o.workspaceId,
        purpose: "MFA_POLICY_UPDATE",
        resourceKind: "organization_security_policy",
        resourceId: o.workspaceId,
      });
      return header["x-proovra-step-up-challenge-id"]!;
    }
    const statusOf = async (id: string) => (await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id } })).status;

    async function startPhone(o: { workspaceId: string; owner: { userId: string; token: string } }, phone: string) {
      const started = await call("POST", "/v1/identity-security/contact-factors/enroll/start", o.owner.token, {
        teamId: o.workspaceId,
        channel: "SMS",
        destination: phone,
        stepUp: { method: "mfa", code: await ceremony.freshCode(o.owner.userId) },
      });
      expect(started.statusCode, started.body).toBe(200);
      const j = json(started) as { factor: { factorId: string }; verificationAttemptId: string };
      return { factorId: j.factor.factorId, verificationAttemptId: j.verificationAttemptId, code: lastCodeTo(phone)! };
    }
    const bind = (o: { workspaceId: string; owner: { token: string } }, e: { factorId: string; verificationAttemptId: string }, code: string) =>
      call("POST", "/v1/identity-security/contact-factors/enroll/verify", o.owner.token, {
        teamId: o.workspaceId,
        factorId: e.factorId,
        verificationAttemptId: e.verificationAttemptId,
        code,
      });

    it("allowed bind: an APPROVED, unspent step-up is CANCELLED once the phone is bound, and can no longer authorise the action", async () => {
      const o = await fx.seedOrganizationTenant(deps, { memberCount: 0 });
      await makeEnterpriseOrganizationWorkspace(prisma, o.workspaceId);
      await ceremony.enroll(o.owner.userId);
      const phone = randomPhone();
      const pending = await startPhone(o, phone);
      const challengeId = await approvedChallenge(o);
      expect(await statusOf(challengeId)).toBe("APPROVED");

      const bound = await bind(o, pending, pending.code);
      expect(bound.statusCode, bound.body).toBe(200);
      expect(await statusOf(challengeId)).toBe("CANCELLED");

      const spend = await call(
        "PUT",
        "/v1/identity-security/mfa-policy",
        o.owner.token,
        { teamId: o.workspaceId, level: "HIGH_RISK_ONLY" },
        { "x-proovra-step-up-challenge-id": challengeId },
      );
      expect(spend.statusCode, spend.body).not.toBe(200);
    });

    it("refused bind (wrong code): nothing is bound and the approval stands", async () => {
      const o = await fx.seedOrganizationTenant(deps, { memberCount: 0 });
      await makeEnterpriseOrganizationWorkspace(prisma, o.workspaceId);
      await ceremony.enroll(o.owner.userId);
      const phone = randomPhone();
      const pending = await startPhone(o, phone);
      const challengeId = await approvedChallenge(o);
      const wrong = pending.code === "000000" ? "111111" : "000000";
      const refused = await bind(o, pending, wrong);
      expect(refused.statusCode, refused.body).toBe(400);
      expect(await statusOf(challengeId)).toBe("APPROVED");
    });
  });

  // ===========================================================================
  // PRO-P3AZ-02
  // ===========================================================================
  describe("PRO-P3AZ-02: deprecated PUT /v1/identity-security/mfa-policy is versioned by the client", () => {
    async function put(o: { workspaceId: string; owner: { userId: string; token: string } }, body: Json) {
      const stepUp = await ceremony.approvedHeader({
        token: o.owner.token,
        userId: o.owner.userId,
        teamId: o.workspaceId,
        purpose: "MFA_POLICY_UPDATE",
        resourceKind: "organization_security_policy",
        resourceId: o.workspaceId,
      });
      return call("PUT", "/v1/identity-security/mfa-policy", o.owner.token, { teamId: o.workspaceId, ...body }, stepUp);
    }
    const read = async (o: { workspaceId: string; owner: { token: string } }) => {
      const r = await call("GET", `/v1/identity-security/mfa-policy?teamId=${o.workspaceId}`, o.owner.token);
      expect(r.statusCode, r.body).toBe(200);
      return json(r).policy as { level: string; policyVersion: number };
    };

    it("refused: a save carrying the version loaded before a concurrent edit is answered 409 and the other edit stands", async () => {
      const o = await fx.seedOrganizationTenant(deps, { memberCount: 0 });
      await makeEnterpriseOrganizationWorkspace(prisma, o.workspaceId);
      const loaded = await read(o);
      // Admin tab 1 saves first.
      const first = await put(o, { level: "HIGH_RISK_ONLY", policyVersion: loaded.policyVersion });
      expect(first.statusCode, first.body).toBe(200);
      // Admin tab 2 still holds the version it loaded.
      const stale = await put(o, { level: "OFF", policyVersion: loaded.policyVersion });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(errorCode(stale)).toBe("MFA_POLICY_VERSION_CONFLICT");
      expect((await read(o)).level).toBe("HIGH_RISK_ONLY");
    });

    it("allowed: a save carrying the current version is applied", async () => {
      const o = await fx.seedOrganizationTenant(deps, { memberCount: 0 });
      await makeEnterpriseOrganizationWorkspace(prisma, o.workspaceId);
      const loaded = await read(o);
      const ok = await put(o, { level: "HIGH_RISK_ONLY", policyVersion: loaded.policyVersion });
      expect(ok.statusCode, ok.body).toBe(200);
      const after = await read(o);
      expect(after.level).toBe("HIGH_RISK_ONLY");
      expect(after.policyVersion).toBeGreaterThan(loaded.policyVersion);
    });
  });
});
