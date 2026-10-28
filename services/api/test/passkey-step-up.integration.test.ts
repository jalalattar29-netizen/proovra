/**
 * PASSKEY STEP-UP — enrolment and the strongest rung of the ladder, on live
 * PostgreSQL with a SOFTWARE AUTHENTICATOR (test/helpers/soft-authenticator.ts)
 * driving the server's real WebAuthn verification.
 *
 *   ENROL     registration needs the account step-up; the passkey becomes an
 *             ACTIVE, verified MfaFactor{PASSKEY} with its credential; a ticket
 *             is single-use and bound to its user; UV is required; a duplicate
 *             credential is a typed 409; the list shows only one's own.
 *   ANSWER    a passkey answers a COLLABORATION_TEAM_ARCHIVE step-up (start ->
 *             method PASSKEY + passkeyOptions; check with the assertion ->
 *             approved, bound to the passkey's factor).
 *   DENY      wrong challenge, another person's credential, missing UV,
 *             counter regression and a replayed assertion are all refused.
 *   REVOKE    revoking the passkey after approval makes the approval
 *             unspendable (consumeApprovedChallenge throws).
 *   HANDOFF   the mobile system-browser flow approves; a reused or wrong
 *             token is refused.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { SoftAuthenticator } from "./helpers/soft-authenticator.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Person = { id: string; token: string };
type RegistrationOptions = {
  challenge: string;
  attestation?: string;
  authenticatorSelection?: { userVerification?: string };
  excludeCredentials?: Array<{ id: string }>;
};

const PASSWORD = "Passkey-Integration-Test-1!";
const PURPOSE = "COLLABORATION_TEAM_ARCHIVE";

describe("passkey step-up (live PostgreSQL, software authenticator)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let hashPassword: typeof import("../src/services/email-password-auth.service.js").hashPassword;
  let stepUp: typeof import("../src/services/identity-security/step-up.service.js");
  let legalVersions: Record<string, string>;
  let rpId: string;
  let origin: string;
  let ceremony: ReturnType<typeof createStepUpCeremony>;
  /** Each person's enrolled passkey: once held, it is the rung that answers. */
  const passkeyOf = new Map<string, SoftAuthenticator>();
  const teamId = () => h.fixtures.teamA.teamId;

  // The harness's APP_BASE_URL is an IP origin (http://127.0.0.1:…), which
  // WebAuthn cannot use as an RP id — the config refuses it, as it should.
  // The relying party is named explicitly, as an operator would.
  const savedEnv = { rp: process.env.WEBAUTHN_RP_ID, origins: process.env.WEBAUTHN_ORIGINS };

  beforeAll(async () => {
    process.env.WEBAUTHN_RP_ID = "app.proovra.test";
    process.env.WEBAUTHN_ORIGINS = "https://app.proovra.test";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
    stepUp = await import("../src/services/identity-security/step-up.service.js");
    ({ REQUIRED_LEGAL_VERSIONS: legalVersions } = (await import("../src/legal/legal-versioning.js")) as never);
    const { resolveWebauthnConfig } = await import("../src/services/identity-security/webauthn-config.js");
    const config = resolveWebauthnConfig();
    rpId = config.rpID;
    origin = config.origins[0] as string;
    ceremony = createStepUpCeremony({
      prisma: prisma as never,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
  }, 900_000);

  afterAll(async () => {
    for (const [key, value] of [["WEBAUTHN_RP_ID", savedEnv.rp], ["WEBAUTHN_ORIGINS", savedEnv.origins]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);
  const headers = (token?: string) => (token ? { authorization: `Bearer ${token}` } : {});
  const post = (url: string, payload: unknown, token?: string) =>
    h.app.inject({ method: "POST", url, payload: payload as never, headers: headers(token) });
  const json = (res: { body: string }) => JSON.parse(res.body) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- response bodies are asserted field by field
  /**
   * CLOSURE AUDIT N-2 — a passkey is bound and removed only behind the LADDER
   * step-up: the strongest rung the person already holds answers. Before their
   * first passkey that is their authenticator app (the real TOTP ceremony);
   * once they hold a passkey, only the passkey can.
   */
  async function approved(p: Person, purpose: string, resourceKind: string, resourceId: string) {
    const auth = passkeyOf.get(p.id);
    if (!auth) {
      return ceremony.approvedHeader({ token: p.token, userId: p.id, teamId: teamId(), purpose, resourceKind, resourceId });
    }
    const started = await post(
      "/v1/identity-security/step-up/start",
      { teamId: teamId(), purpose, resourceKind, resourceId },
      p.token,
    );
    expect(started.statusCode, started.body).toBe(200);
    const body = json(started);
    expect(body.method).toBe("PASSKEY");
    const checked = await post(
      "/v1/identity-security/step-up/check",
      { teamId: teamId(), challengeId: body.challenge.id, assertion: auth.assert(body.passkeyOptions) },
      p.token,
    );
    expect(checked.statusCode, checked.body).toBe(200);
    return { "x-proovra-step-up-challenge-id": body.challenge.id as string };
  }

  const withHeaders = (token: string, extra: Record<string, string>) => ({ ...headers(token), ...extra });

  async function person(): Promise<Person> {
    const email = `pk-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, provider: "EMAIL", providerUserId: email, passwordHash: hashPassword(PASSWORD) },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legalVersions).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion,
        source: "integration-harness",
      })),
    });
    await prisma.teamMember.create({ data: { teamId: teamId(), userId: user.id, role: "MEMBER", status: "ACTIVE" } });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, token };
  }

  async function registrationOptions(p: Person) {
    const header = await approved(p, "PASSKEY_REGISTER", "user", p.id);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/identity-security/passkeys/registration/options",
      headers: withHeaders(p.token, header),
      payload: { workspaceId: teamId() },
    });
    expect(res.statusCode, res.body).toBe(200);
    return json(res) as { options: RegistrationOptions; ticket: string };
  }

  async function removeWithStepUp(p: Person, factorId: string) {
    const header = await approved(p, "PASSKEY_REMOVE", "mfa_factor", factorId);
    return h.app.inject({
      method: "DELETE",
      url: `/v1/identity-security/passkeys/${factorId}`,
      headers: withHeaders(p.token, header),
      payload: { workspaceId: teamId() },
    });
  }

  async function enrol(p: Person, label = "Test key"): Promise<{ auth: SoftAuthenticator; factorId: string }> {
    const auth = new SoftAuthenticator(rpId, origin);
    const begun = await registrationOptions(p);
    const res = await post(
      "/v1/identity-security/passkeys/registration/verify",
      { ticket: begun.ticket, label, response: auth.register(begun.options) },
      p.token,
    );
    expect(res.statusCode, res.body).toBe(201);
    passkeyOf.set(p.id, auth);
    return { auth, factorId: json(res).passkey.id as string };
  }

  async function start(p: Person, extra: Record<string, unknown> = {}) {
    const res = await post(
      "/v1/identity-security/step-up/start",
      { teamId: teamId(), purpose: PURPOSE, resourceKind: "collaboration_team", resourceId: randomUUID(), ...extra },
      p.token,
    );
    expect(res.statusCode, res.body).toBe(200);
    return json(res) as {
      challenge: { id: string };
      method: string;
      passkeyOptions: { challenge: string; allowCredentials?: Array<{ id: string }> } | null;
      handoffUrl: string | null;
    };
  }

  /** The session the challenge was started in — the one that may spend it. */
  const sessionOf = async (challengeId: string) =>
    (await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id: challengeId }, select: { sessionIdHash: true } }))
      .sessionIdHash;

  const check = (p: Person, challengeId: string, assertion: unknown) =>
    post("/v1/identity-security/step-up/check", { teamId: teamId(), challengeId, assertion }, p.token);

  // ===========================================================================
  describe("ENROL", () => {
    it("registration needs the LADDER step-up: none, a password, or an approval for another purpose is refused", async () => {
      const p = await person();
      const none = await post("/v1/identity-security/passkeys/registration/options", { workspaceId: teamId() }, p.token);
      expect(none.statusCode).toBe(401);
      expect(json(none).error.code).toBe("STEP_UP_REQUIRED");
      expect(json(none).error.details.purpose).toBe("PASSKEY_REGISTER");
      // A password is not a step-up here at all (closure audit N-2).
      const password = await post(
        "/v1/identity-security/passkeys/registration/options",
        { workspaceId: teamId(), stepUp: { method: "password", currentPassword: PASSWORD } },
        p.token,
      );
      expect(password.statusCode).toBe(400);
      // An approval for another operation does not bind a passkey.
      const other = await approved(p, "CASE_DELETE", "user", p.id);
      const wrongPurpose = await h.app.inject({
        method: "POST",
        url: "/v1/identity-security/passkeys/registration/options",
        headers: withHeaders(p.token, other),
        payload: { workspaceId: teamId() },
      });
      expect(wrongPurpose.statusCode).toBe(401);
      // A workspace the person is not in is concealed.
      const foreignWs = await post(
        "/v1/identity-security/passkeys/registration/options",
        { workspaceId: h.fixtures.teamB.teamId },
        p.token,
      );
      expect(foreignWs.statusCode).toBe(404);
      const ok = await registrationOptions(p);
      expect(ok.options.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(ok.options.authenticatorSelection?.userVerification).toBe("required");
      expect(ok.options.attestation).toBe("none");
    });

    it("binds an ACTIVE verified PASSKEY factor with its credential, listed only to its owner", async () => {
      const p = await person();
      const other = await person();
      const { auth, factorId } = await enrol(p, "Work laptop");
      const factor = await prisma.mfaFactor.findUniqueOrThrow({
        where: { id: factorId },
        include: { webauthnCredential: true },
      });
      expect(factor).toMatchObject({ userId: p.id, kind: "PASSKEY", status: "ACTIVE", label: "Work laptop" });
      expect(factor.verifiedAtUtc).not.toBeNull();
      expect(factor.webauthnCredential?.credentialId).toBe(auth.id);
      expect(factor.webauthnCredential?.userId).toBe(p.id);

      const mine = await h.app.inject({ method: "GET", url: "/v1/identity-security/passkeys", headers: headers(p.token) });
      expect(mine.statusCode).toBe(200);
      expect(json(mine).passkeys.map((k: { id: string }) => k.id)).toEqual([factorId]);
      const theirs = await h.app.inject({ method: "GET", url: "/v1/identity-security/passkeys", headers: headers(other.token) });
      expect(json(theirs).passkeys).toEqual([]);

      // The second registration names the first credential in excludeCredentials.
      const again = await registrationOptions(p);
      expect(again.options.excludeCredentials?.map((c: { id: string }) => c.id)).toEqual([auth.id]);
    });

    it("refuses a response without user verification", async () => {
      const p = await person();
      const begun = await registrationOptions(p);
      const res = await post(
        "/v1/identity-security/passkeys/registration/verify",
        { ticket: begun.ticket, label: "No UV", response: new SoftAuthenticator(rpId, origin).register(begun.options, { userVerified: false }) },
        p.token,
      );
      expect(res.statusCode).toBe(400);
      expect(json(res).error.code).toBe("PASSKEY_REGISTRATION_INVALID");
      expect(await prisma.mfaFactor.count({ where: { userId: p.id, kind: "PASSKEY" } })).toBe(0);
    });

    it("a ticket is bound to its user and is single-use; a duplicate credential is a typed 409", async () => {
      const p = await person();
      const thief = await person();
      const begun = await registrationOptions(p);
      const auth = new SoftAuthenticator(rpId, origin);
      const response = auth.register(begun.options);

      const stolen = await post(
        "/v1/identity-security/passkeys/registration/verify",
        { ticket: begun.ticket, label: "Thief", response },
        thief.token,
      );
      expect(stolen.statusCode).toBe(400);

      const first = await post("/v1/identity-security/passkeys/registration/verify", { ticket: begun.ticket, label: "Mine", response }, p.token);
      expect(first.statusCode, first.body).toBe(201);

      const dup = await post("/v1/identity-security/passkeys/registration/verify", { ticket: begun.ticket, label: "Again", response }, p.token);
      expect(dup.statusCode).toBe(409);
      expect(json(dup).error.code).toBe("PASSKEY_ALREADY_REGISTERED");
      expect(typeof json(dup).error.requestId).toBe("string");

      // The spent ticket cannot bind a second, different authenticator.
      const second = await post(
        "/v1/identity-security/passkeys/registration/verify",
        { ticket: begun.ticket, label: "Second", response: new SoftAuthenticator(rpId, origin).register(begun.options) },
        p.token,
      );
      expect(second.statusCode).toBe(400);
      expect(await prisma.mfaFactor.count({ where: { userId: p.id, kind: "PASSKEY" } })).toBe(1);
    });

    it("revocation needs the ladder step-up (the passkey itself answers) and refuses another person's passkey uniformly", async () => {
      const p = await person();
      const other = await person();
      const { factorId } = await enrol(p);
      const noProof = await h.app.inject({
        method: "DELETE",
        url: `/v1/identity-security/passkeys/${factorId}`,
        headers: headers(p.token),
        payload: { workspaceId: teamId() },
      });
      expect(noProof.statusCode).toBe(401);
      expect(json(noProof).error.details.purpose).toBe("PASSKEY_REMOVE");
      // The strongest rung p holds is now the passkey: a TOTP code no longer answers.
      const totpAttempt = await post(
        "/v1/identity-security/step-up/start",
        { teamId: teamId(), purpose: "PASSKEY_REMOVE", resourceKind: "mfa_factor", resourceId: factorId, channel: "TOTP" },
        p.token,
      );
      expect(totpAttempt.statusCode).toBe(403);
      expect(json(totpAttempt).error.code).toBe("STEP_UP_ENROLLMENT_REQUIRED");
      const foreign = await removeWithStepUp(other, factorId);
      expect(foreign.statusCode).toBe(404);
      const unknown = await removeWithStepUp(other, randomUUID());
      expect(unknown.statusCode).toBe(404);
      expect(json(foreign)).toMatchObject({ error: { code: json(unknown).error.code } });
      const before = await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factorId } });
      expect(before.status).toBe("ACTIVE");
    });
  });

  // ===========================================================================
  describe("ANSWER and DENY", () => {
    it("a passkey answers a COLLABORATION_TEAM_ARCHIVE step-up", async () => {
      const p = await person();
      const { auth, factorId } = await enrol(p);
      const started = await start(p);
      expect(started.method).toBe("PASSKEY");
      expect(started.passkeyOptions?.allowCredentials?.map((c) => c.id)).toEqual([auth.id]);
      const res = await check(p, started.challenge.id, auth.assert(started.passkeyOptions!));
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).status).toBe("approved");
      const row = await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id: started.challenge.id } });
      expect(row).toMatchObject({ status: "APPROVED", method: "PASSKEY", factorId, factorGeneration: 1, webauthnChallenge: null });
      const factor = await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factorId } });
      expect(factor.lastUsedAt).not.toBeNull();
    });

    it("a different challenge is refused", async () => {
      const p = await person();
      const { auth } = await enrol(p);
      const started = await start(p);
      const res = await check(p, started.challenge.id, auth.assert(started.passkeyOptions!, { challenge: Buffer.alloc(32, 7).toString("base64url") }));
      expect(res.statusCode).toBe(400);
      expect(json(res)).toEqual({ status: "denied" });
    });

    it("another person's credential is refused", async () => {
      const p = await person();
      const other = await person();
      await enrol(p);
      const { auth: theirs } = await enrol(other);
      const started = await start(p);
      const res = await check(p, started.challenge.id, theirs.assert(started.passkeyOptions!));
      expect(res.statusCode).toBe(400);
      expect(json(res)).toEqual({ status: "denied" });
    });

    it("an assertion without user verification is refused", async () => {
      const p = await person();
      const { auth } = await enrol(p);
      const started = await start(p);
      const res = await check(p, started.challenge.id, auth.assert(started.passkeyOptions!, { userVerified: false }));
      expect(res.statusCode).toBe(400);
    });

    it("a sign counter that does not move forward is refused", async () => {
      const p = await person();
      const { auth } = await enrol(p);
      const first = await start(p);
      expect((await check(p, first.challenge.id, auth.assert(first.passkeyOptions!))).statusCode).toBe(200);
      const second = await start(p);
      const res = await check(p, second.challenge.id, auth.assert(second.passkeyOptions!, { counter: auth.counter }));
      expect(res.statusCode).toBe(400);
      const regressed = await start(p);
      const res2 = await check(p, regressed.challenge.id, auth.assert(regressed.passkeyOptions!, { counter: 0 }));
      expect(res2.statusCode).toBe(400);
    });

    it("replaying an assertion is refused — on its own challenge and on a new one", async () => {
      const p = await person();
      const { auth } = await enrol(p);
      const started = await start(p);
      const assertion = auth.assert(started.passkeyOptions!);
      expect((await check(p, started.challenge.id, assertion)).statusCode).toBe(200);
      expect((await check(p, started.challenge.id, assertion)).statusCode).toBe(400);
      const next = await start(p);
      expect((await check(p, next.challenge.id, assertion)).statusCode).toBe(400);
    });
  });

  // ===========================================================================
  describe("REVOKE", () => {
    it("revoking the passkey after approval makes the approved challenge unspendable", async () => {
      const p = await person();
      const { auth, factorId } = await enrol(p);
      const resourceId = randomUUID();
      const started = await start(p, { resourceId });
      expect((await check(p, started.challenge.id, auth.assert(started.passkeyOptions!))).statusCode).toBe(200);

      const revoke = await removeWithStepUp(p, factorId);
      expect(revoke.statusCode, revoke.body).toBe(200);
      const factor = await prisma.mfaFactor.findUniqueOrThrow({ where: { id: factorId } });
      expect(factor).toMatchObject({ status: "REVOKED", revokedReason: "user_revoked", generation: 2 });
      expect(factor.revokedAt).not.toBeNull();

      await expect(
        stepUp.consumeApprovedChallenge({
          teamId: teamId(),
          userId: p.id,
          challengeId: started.challenge.id,
          purpose: PURPOSE,
          resourceKind: "collaboration_team",
          resourceId,
          sessionIdHash: await sessionOf(started.challenge.id),
        }),
      ).rejects.toMatchObject({ code: "challenge_not_found" });

      // And it no longer answers anything: no passkey rung remains.
      const listed = await h.app.inject({ method: "GET", url: "/v1/identity-security/passkeys", headers: headers(p.token) });
      expect(json(listed).passkeys).toEqual([]);
    });

    it("positive control: the same approval IS spendable while the passkey stands", async () => {
      const p = await person();
      const { auth } = await enrol(p);
      const resourceId = randomUUID();
      const started = await start(p, { resourceId });
      expect((await check(p, started.challenge.id, auth.assert(started.passkeyOptions!))).statusCode).toBe(200);
      const consumed = await stepUp.consumeApprovedChallenge({
        teamId: teamId(),
        userId: p.id,
        challengeId: started.challenge.id,
        purpose: PURPOSE,
        resourceKind: "collaboration_team",
        resourceId,
        sessionIdHash: await sessionOf(started.challenge.id),
      });
      expect(consumed.status).toBe("CANCELLED");
    });
  });

  // ===========================================================================
  describe("HANDOFF (mobile system browser)", () => {
    function fragment(url: string) {
      const hash = new URL(url).hash.slice(1);
      const params = new URLSearchParams(hash);
      return { challengeId: params.get("challenge") as string, token: params.get("token") as string };
    }

    it("start(handoff) -> options -> assertion approves; a reused token is refused", async () => {
      const p = await person();
      const { auth } = await enrol(p);
      const started = await start(p, { handoff: true });
      expect(started.method).toBe("PASSKEY");
      expect(started.handoffUrl).toMatch(/\/step-up\/passkey#challenge=/);
      const { challengeId, token } = fragment(started.handoffUrl!);
      expect(challengeId).toBe(started.challenge.id);

      const opts = await post("/v1/identity-security/step-up/handoff/passkey/options", { challengeId, token });
      expect(opts.statusCode, opts.body).toBe(200);
      const passkeyOptions = json(opts).passkeyOptions as { challenge: string };
      expect(passkeyOptions.challenge).toBe(started.passkeyOptions!.challenge);

      const answered = await post("/v1/identity-security/step-up/handoff/passkey", {
        challengeId,
        token,
        assertion: auth.assert(passkeyOptions),
      });
      expect(answered.statusCode, answered.body).toBe(200);
      expect(json(answered).status).toBe("approved");
      const row = await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id: challengeId } });
      expect(row.status).toBe("APPROVED");

      const reusedOptions = await post("/v1/identity-security/step-up/handoff/passkey/options", { challengeId, token });
      expect(reusedOptions.statusCode).toBe(400);
      const reused = await post("/v1/identity-security/step-up/handoff/passkey", {
        challengeId,
        token,
        assertion: auth.assert(passkeyOptions),
      });
      expect(reused.statusCode).toBe(400);
    });

    it("a wrong token is refused and leaves the challenge pending", async () => {
      const p = await person();
      const { auth } = await enrol(p);
      const started = await start(p, { handoff: true });
      const { challengeId } = fragment(started.handoffUrl!);
      const wrong = Buffer.alloc(32, 9).toString("base64url");
      const opts = await post("/v1/identity-security/step-up/handoff/passkey/options", { challengeId, token: wrong });
      expect(opts.statusCode).toBe(400);
      const answered = await post("/v1/identity-security/step-up/handoff/passkey", {
        challengeId,
        token: wrong,
        assertion: auth.assert(started.passkeyOptions!),
      });
      expect(answered.statusCode).toBe(400);
      const row = await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id: challengeId } });
      expect(row.status).toBe("PENDING");
    });
  });
});
