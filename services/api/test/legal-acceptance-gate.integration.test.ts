/**
 * A1-06 — CURRENT TERMS, ENFORCED BY THE SERVER (live PostgreSQL 16, real HTTP).
 *
 * Re-acceptance used to be opted into by thirteen route files; every other
 * authenticated write (shares, intake links, upload sessions, collaboration...)
 * ran for a person whose terms were outstanding. `requireAuth` now refuses every
 * session-authenticated write with the shared 428 `LEGAL_REACCEPT_REQUIRED`
 * unless the route is in the reviewed classification
 * (src/middleware/legal-acceptance-route-policy.ts).
 *
 *   1. ENUMERATION over the live route table: every write route is either
 *      refused for a stale user or classified (session exemption / no session),
 *      and nothing classified is refused anyway. A new write route fails here
 *      until it is enforced or classified.
 *   2. Representative writes (evidence create, upload session, case, share,
 *      checkout, workspace invite) are refused BEFORE any row is written; the
 *      same person accepts through the real route and the retry succeeds.
 *   3. A stale person can still sign in, sign out, read, export their data,
 *      close their account, cancel a subscription and revoke a share.
 *   4. A provider webhook (Stripe, signed locally — simulated) and public
 *      Verify work whatever the owner's terms say.
 *
 * The one Stripe API read the refund webhook makes is answered at the
 * stripe.service module boundary; nothing external is contacted.
 */
import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { REQUIRED_LEGAL_VERSIONS } from "../src/legal/legal-versioning.js";
import {
  SESSION_WRITE_EXEMPTIONS,
  legalAcceptanceExemptionFor,
  nonSessionWriteCategoryFor,
  normalizeLegalRouteKey,
} from "../src/middleware/legal-acceptance-route-policy.js";
import type { IntegrationHarness } from "./integration-harness.js";
import { WRITE_METHODS, liveRoutes } from "./support/write-sweep-engine.js";

const sessionsByIntent = vi.hoisted(() => new Map<string, string>());

vi.mock("../src/services/stripe.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    stripeGet: async (path: string) => {
      const m = path.match(/^\/checkout\/sessions\?payment_intent=([^&]+)/);
      if (m) {
        const id = sessionsByIntent.get(decodeURIComponent(m[1]!));
        return { data: id ? [{ id }] : [] };
      }
      throw new Error(`unexpected Stripe read in test: ${path}`);
    },
  };
});

const PASSWORD = "Correct-horse-9-battery";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CURRENT = Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
  policyKey,
  policyVersion: policyVersion as string,
}));

type Res = { statusCode: number; body: string };
const codeOf = (res: Res): string | null => {
  try {
    const b = JSON.parse(res.body) as { error?: { code?: string } | string; code?: string; denial?: string };
    return (typeof b.error === "object" ? b.error?.code : b.error) ?? b.code ?? b.denial ?? null;
  } catch {
    return null;
  }
};
const expectTermsRefusal = (res: Res) => {
  expect(res.statusCode, res.body).toBe(428);
  const body = JSON.parse(res.body) as { error: { code: string; details: { missingPolicies: string[] } } };
  expect(body.error.code).toBe("LEGAL_REACCEPT_REQUIRED");
  expect(body.error.details.missingPolicies.length).toBeGreaterThan(0);
};
const expectNotTermsRefusal = (res: Res) => {
  expect(res.statusCode, res.body).not.toBe(428);
  expect(codeOf(res)).not.toBe("LEGAL_REACCEPT_REQUIRED");
};

describe("A1-06 — current terms, enforced by the server (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let hashPassword: (p: string) => Promise<string>;
  let generateVerificationRef: () => string;
  let clearRates: () => Promise<unknown>;
  let billing: typeof import("../src/services/billing.service.js");
  let credits: typeof import("../src/services/billing/evidence-credits.service.js");
  const keyId = `a106-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  let webhookSecret: string;
  const secretBefore = process.env.STRIPE_WEBHOOK_SECRET;

  const call = (method: string, url: string, token: string | null, payload?: unknown) =>
    h.app.inject({
      method: method as never,
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  /** Make `userId`'s recorded acceptances an OLD revision of every required policy. */
  async function makeStale(userId: string) {
    await prisma.userLegalAcceptance.deleteMany({ where: { userId } });
    await prisma.userLegalAcceptance.createMany({
      data: CURRENT.map((c) => ({ userId, policyKey: c.policyKey, policyVersion: "2000-01-01", source: "a1-06-test" })),
    });
  }
  /** Accept through the real route, as the web step and the native screen do. */
  async function accept(token: string) {
    const res = await call("POST", "/v1/users/legal-acceptance", token, { source: "post_sign_in", acceptances: CURRENT });
    expect(res.statusCode, res.body).toBe(200);
  }

  /** A fresh person (with a password) whose terms are outstanding. */
  async function staleUser(withPassword = false): Promise<{ id: string; email: string; token: string }> {
    const email = `a106-${randomUUID()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: {
        email,
        firstName: "Stale",
        lastName: "Terms",
        provider: "EMAIL",
        providerUserId: email,
        ...(withPassword ? { passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date() } : {}),
      } as never,
      select: { id: true },
    });
    await makeStale(user.id);
    return { id: user.id, email, token: await h.mintSessionToken(user.id, email) };
  }

  /** A signed, verifiable record in teamA (verification-share-links.integration.test.ts). */
  async function signedRecord(): Promise<string> {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const row = await prisma.evidence.create({
      data: {
        title: "A1-06 record",
        type: "PHOTO",
        status: "SIGNED",
        teamId: A.teamId,
        organizationId: team.organizationId,
        ownerUserId: A.ownerUserId,
        signedAtUtc: new Date(),
      } as never,
      select: { id: true },
    });
    const fileSha256 = sha(randomUUID());
    const canonical = JSON.stringify({ v: 1, evidenceId: row.id, sha256: fileSha256 });
    const fingerprintHash = sha(canonical);
    await prisma.evidence.update({
      where: { id: row.id },
      data: {
        fileSha256,
        fingerprintCanonicalJson: canonical,
        fingerprintHash,
        signatureBase64: sign(null, Buffer.from(fingerprintHash, "hex"), privateKey).toString("base64"),
        signingKeyId: keyId,
        signingKeyVersion: 1,
        verificationRef: generateVerificationRef(),
        verificationRefIssuedAtUtc: new Date(),
      } as never,
    });
    return row.id;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
    ({ generateVerificationRef } = await import("@proovra/shared-runtime"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    billing = await import("../src/services/billing.service.js");
    credits = await import("../src/services/billing/evidence-credits.service.js");
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim() },
    });
    await prisma.team.update({
      where: { id: h.fixtures.teamA.teamId },
      data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } as never,
    });
    webhookSecret = `whsec_local_${randomUUID().replace(/-/g, "")}`;
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
  }, 300_000);

  afterAll(async () => {
    if (secretBefore === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = secretBefore;
    await h?.cleanup();
  }, 300_000);

  it("every live write route is refused for a stale user or explicitly classified — and nothing classified is refused", async () => {
    const routes = liveRoutes(h.app.printRoutes({ commonPrefix: false })).filter((r) => WRITE_METHODS.has(r.method));
    expect(routes.length).toBeGreaterThan(690);

    const unclassified: string[] = [];
    const classifiedButRefused: string[] = [];
    const liveKeys = new Set<string>();
    let enforced = 0;
    for (const r of routes) {
      // printRoutes writes the `/v1/api-keys/*` wildcard as `/v1/api-keys*`.
      const pattern = r.url.replace(/([^/])\*$/, "$1/*");
      const key = normalizeLegalRouteKey(r.method, pattern);
      liveKeys.add(key);
      const url = pattern.replace(/:[A-Za-z0-9_]+(\([^)]*\))?(\|:[A-Za-z0-9_]+)*/g, () => randomUUID()).replace(/\*$/, "x");
      // A fresh person per route: an exempt route may sign them out or close the account.
      const { token } = await staleUser();
      const res = await call(r.method, url, token);
      const exempt = legalAcceptanceExemptionFor(r.method, pattern);
      const nonSession = nonSessionWriteCategoryFor(r.method, pattern);
      if (res.statusCode === 428 && codeOf(res) === "LEGAL_REACCEPT_REQUIRED") {
        enforced += 1;
        if (exempt || nonSession) classifiedButRefused.push(`${key} (${exempt?.category ?? nonSession})`);
      } else if (!exempt && !nonSession) {
        unclassified.push(`${key} -> ${res.statusCode} ${codeOf(res)}`);
      }
    }
    expect(unclassified, "write routes neither refused for outstanding terms nor classified").toEqual([]);
    expect(classifiedButRefused, "classified routes that still refuse for outstanding terms").toEqual([]);
    expect(enforced).toBeGreaterThan(480);

    // No exemption names a route that does not exist (a stale row would hide a rename).
    const stale = Object.values(SESSION_WRITE_EXEMPTIONS)
      .flat()
      .filter((key) => !liveKeys.has(key));
    expect(stale).toEqual([]);

    // The `/v1/workspaces` alias is rewritten before routing: same gate.
    expectTermsRefusal(await call("POST", "/v1/workspaces", (await staleUser()).token, { name: "Alias" }));
  }, 1_800_000);

  it("representative writes are refused before any row is written; after accepting, the retry succeeds", async () => {
    await clearRates();
    const A = h.fixtures.teamA;
    const P = h.fixtures.personal;
    const record = await signedRecord();
    const inviteEmail = `a106-invite-${randomUUID().slice(0, 8)}@invitee.test`;
    await makeStale(A.ownerUserId);
    await makeStale(P.userId);
    try {
      const counts = async () => ({
        cases: await prisma.case.count({ where: { teamId: A.teamId } }),
        shares: await prisma.verificationShareToken.count({ where: { evidenceId: record } }),
        invites: await prisma.teamInvite.count({ where: { email: inviteEmail } }),
        evidence: await prisma.evidence.count({ where: { ownerUserId: P.userId } }),
        checkouts: await prisma.billingCheckoutAttempt.count({ where: { userId: P.userId } }),
      });
      const before = await counts();

      const caseBody = { name: "A1-06 case", teamId: A.teamId };
      const shareBody = { audience: "Opposing counsel", expiresInDays: 30 };
      const inviteBody = { email: inviteEmail, role: "MEMBER" };
      expectTermsRefusal(await call("POST", "/v1/cases", A.ownerToken, caseBody));
      expectTermsRefusal(await call("POST", `/v1/evidence/${record}/verify-links`, A.ownerToken, shareBody));
      expectTermsRefusal(await call("POST", `/v1/teams/${A.teamId}/invites`, A.ownerToken, inviteBody));
      expectTermsRefusal(await call("POST", "/v1/evidence", P.token, { type: "PHOTO", mimeType: "image/png" }));
      expectTermsRefusal(
        await call("POST", "/v1/uploads/sessions", P.token, { type: "PHOTO", mimeType: "image/png", sizeBytes: 1024 }),
      );
      expectTermsRefusal(await call("POST", "/v1/billing/checkout/stripe", P.token, { plan: "PRO" }));
      await h.handlersSettled();
      expect(await counts()).toEqual(before);

      // The same people accept through the real route, and retry.
      await accept(A.ownerToken);
      await accept(P.token);
      const createdCase = await call("POST", "/v1/cases", A.ownerToken, caseBody);
      expect(createdCase.statusCode, createdCase.body).toBe(201);
      const share = await call("POST", `/v1/evidence/${record}/verify-links`, A.ownerToken, shareBody);
      expect(share.statusCode, share.body).toBe(201);
      const invite = await call("POST", `/v1/teams/${A.teamId}/invites`, A.ownerToken, inviteBody);
      expect(invite.statusCode, invite.body).toBeLessThan(300);
      const evidence = await call("POST", "/v1/evidence", P.token, { type: "PHOTO", mimeType: "image/png" });
      expect(evidence.statusCode, evidence.body).toBe(201);
      const after = await counts();
      expect(after.cases).toBe(before.cases + 1);
      expect(after.shares).toBe(before.shares + 1);
      expect(after.invites).toBe(before.invites + 1);
      expect(after.evidence).toBe(before.evidence + 1);
    } finally {
      await accept(A.ownerToken).catch(() => undefined);
      await accept(P.token).catch(() => undefined);
    }
  });

  it("a stale person signs in, is refused with the shared answer, accepts, retries — and can sign out", async () => {
    await clearRates();
    const u = await staleUser(true);
    const login = await call("POST", "/v1/auth/email/login", null, { email: u.email, password: PASSWORD });
    expect(login.statusCode, login.body).toBe(200);
    const token = (login.json() as { token: string }).token;

    // Reads are never refused for terms, the acceptance status among them.
    const status = await call("GET", "/v1/users/legal-status", token);
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toMatchObject({ requiresReacceptance: true });

    const write = () => call("POST", "/v1/evidence", token, { type: "PHOTO", mimeType: "image/png" });
    expectTermsRefusal(await write());
    await accept(token);
    expect((await call("GET", "/v1/users/legal-status", token)).json()).toMatchObject({ requiresReacceptance: false });
    const retried = await write();
    expect(retried.statusCode, retried.body).toBe(201);

    const logout = await call("POST", "/v1/auth/logout", token, {});
    expect(logout.statusCode, logout.body).toBe(200);
    expect((await call("GET", "/v1/users/legal-status", token)).statusCode).toBe(401);
  });

  it("a stale person keeps reads, data export, account closure, subscription cancel and share revocation", async () => {
    await clearRates();
    const u = await staleUser(true);
    const stepUp = { method: "password", currentPassword: PASSWORD };

    const exported = await call("POST", "/v1/identity/data-export", u.token, { stepUp });
    expect(exported.statusCode, exported.body).toBeLessThan(300);
    expect(await prisma.accountDataExportRequest.count({ where: { userId: u.id } })).toBe(1);

    const closure = await call("POST", "/v1/identity/account-closure", u.token, { confirmation: "close my account", stepUp });
    expect(closure.statusCode, closure.body).toBeLessThan(300);
    expect(await prisma.accountClosureRequest.count({ where: { userId: u.id } })).toBe(1);

    // Billing reads and the cancel route answer their own decision, not the terms gate.
    const P = h.fixtures.personal;
    await makeStale(P.userId);
    try {
      const accounts = await call("GET", "/v1/billing/accounts", P.token);
      expect(accounts.statusCode, accounts.body).toBe(200);
      expectNotTermsRefusal(await call("POST", "/v1/billing/subscription/cancel", P.token, {}));
      expectNotTermsRefusal(await call("POST", "/v1/billing/storage-addons/cancel", P.token, {}));
    } finally {
      await accept(P.token);
    }

    // A share made while current is revoked while stale.
    const A = h.fixtures.teamA;
    const record = await signedRecord();
    const created = await call("POST", `/v1/evidence/${record}/verify-links`, A.ownerToken, {
      audience: "Reviewer",
      expiresInDays: 30,
    });
    expect(created.statusCode, created.body).toBe(201);
    const linkId = (created.json() as { link: { id: string } }).link.id;
    await makeStale(A.ownerUserId);
    try {
      const revoked = await call("POST", `/v1/evidence/${record}/verify-links/${linkId}/revoke`, A.ownerToken, {});
      expect(revoked.statusCode, revoked.body).toBeLessThan(300);
      const row = await prisma.verificationShareToken.findUniqueOrThrow({ where: { id: linkId }, select: { revokedAtUtc: true } });
      expect(row.revokedAtUtc).not.toBeNull();
    } finally {
      await accept(A.ownerToken);
    }
  });

  it("public Verify and a provider webhook (simulated Stripe) work whatever the owner's terms say; an in-flight return is not refused", async () => {
    await clearRates();
    const A = h.fixtures.teamA;
    const record = await signedRecord();
    const created = await call("POST", `/v1/evidence/${record}/verify-links`, A.ownerToken, {
      audience: "Opposing counsel",
      expiresInDays: 30,
    });
    expect(created.statusCode, created.body).toBe(201);
    const { token: shareToken } = created.json() as { token: string };

    const P = h.fixtures.personal;
    await makeStale(A.ownerUserId);
    await makeStale(P.userId);
    try {
      // Public Verify: anonymous, owner stale.
      const verified = await h.app.inject({ method: "GET", url: `/public/verify/${shareToken}`, remoteAddress: "198.51.100.77" });
      expect(verified.statusCode, verified.body).toBe(200);

      // A provider callback for the stale person's earlier purchase settles (refund reversal).
      const sessionId = `cs_test_${randomUUID().replace(/-/g, "")}`;
      const paymentIntent = `pi_${randomUUID().replace(/-/g, "")}`;
      sessionsByIntent.set(paymentIntent, sessionId);
      await billing.ensureEntitlement(P.userId);
      await billing.recordPayment({
        userId: P.userId,
        provider: "STRIPE",
        providerPaymentId: sessionId,
        amountCents: 500,
        currency: "USD",
        status: "SUCCEEDED",
        teamId: null,
        product: "EVIDENCE_CREDIT",
        providerResourceId: sessionId,
      } as never);
      await credits.grantEvidenceCredits({ userId: P.userId, credits: 3, provider: "STRIPE", providerRef: sessionId });
      const raw = JSON.stringify({
        id: `evt_${randomUUID().replace(/-/g, "")}`,
        type: "charge.refunded",
        data: { object: { id: `ch_${randomUUID().slice(0, 8)}`, payment_intent: paymentIntent, amount: 500, amount_refunded: 500, refunded: true } },
      });
      const t = Math.floor(Date.now() / 1000);
      const v1 = createHmac("sha256", webhookSecret).update(`${t}.${raw}`).digest("hex");
      const hook = await h.app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}` },
        payload: raw,
      });
      expect(hook.statusCode, hook.body).toBe(200);
      expect(
        await prisma.evidenceCreditLedgerEntry.count({ where: { entryType: "REVERSAL", provider: "STRIPE", providerRef: sessionId } }),
      ).toBe(1);

      // The PayPal return for a checkout the person started earlier is not refused for terms.
      expectNotTermsRefusal(await call("POST", "/v1/billing/checkout/paypal/returns/canceled", P.token, { token: "EC-A106" }));
    } finally {
      await accept(A.ownerToken);
      await accept(P.token);
    }
  });
});
