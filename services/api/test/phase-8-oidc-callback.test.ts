/**
 * PHASE 8 §11.3 rows 8–9 (2026-07-22) — REAL OIDC callback behavioral test.
 *
 * Exercises the production `handleOidcCallback` end-to-end: a genuinely
 * jose-signed id_token is verified by the PRODUCTION `jwtVerify` (NOT
 * mocked) against a deterministic local JWKS. State, nonce, issuer,
 * audience, expiry, signature, subject-match and mapping decisions all run
 * for real. Only the external network (discovery / token / userinfo HTTP)
 * and the JWKS transport are mocked; the crypto + claim logic is real.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, type JWK } from "jose";

// ── Test IdP keypair (RS256). Public JWK is exposed via the mocked
//    createRemoteJWKSet; the private key signs id_tokens. ──────────────
const keys = await generateKeyPair("RS256", { extractable: true });
const PRIVATE_KEY = keys.privateKey;
const PUBLIC_JWK: JWK = { ...(await exportJWK(keys.publicKey)), alg: "RS256", use: "sig" };

const ISSUER = "https://idp.example.com";
const CLIENT_ID = "client-abc";
const JWKS_URI = "https://idp.example.com/jwks";
const TOKEN_ENDPOINT = "https://idp.example.com/token";
const USERINFO_ENDPOINT = "https://idp.example.com/userinfo";

// jose partial-mock: keep jwtVerify + everything REAL; override ONLY
// createRemoteJWKSet so the network JWKS fetch resolves to our local key.
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: () => async () =>
      (await actual.importJWK(PUBLIC_JWK, "RS256")) as never,
  };
});

// External HTTP boundary — discovery / token / userinfo only.
const netState = vi.hoisted(() => ({
  idToken: "",
  accessToken: "at-1",
  userinfo: { sub: "idp-sub-1", email: "user@enterprise.com" } as Record<
    string,
    unknown
  >,
}));
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (url: string | URL, init?: { method?: string }) => {
    const u = String(url);
    if (u === ISSUER || u.includes("well-known")) {
      return jsonRes({
        issuer: ISSUER,
        jwks_uri: JWKS_URI,
        token_endpoint: TOKEN_ENDPOINT,
        authorization_endpoint: `${ISSUER}/auth`,
        userinfo_endpoint: USERINFO_ENDPOINT,
      });
    }
    if (u === TOKEN_ENDPOINT && init?.method === "POST") {
      return jsonRes({ id_token: netState.idToken, access_token: netState.accessToken });
    }
    if (u === USERINFO_ENDPOINT) {
      return jsonRes(netState.userinfo);
    }
    return jsonRes({}, 404);
  }) as typeof globalThis.fetch;
});

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

// Recording prisma proxy — steers the specific lookups the callback makes.
const dbState = vi.hoisted(() => ({
  mapping: { userId: "user-1", teamId: "team-1" } as unknown,
  orgKind: "CUSTOMER" as string,
  billingPlan: "ENTERPRISE" as string,
  billingStatus: "ACTIVE" as string,
}));
const writes: string[] = [];
// The gate resolver (enterprise-gate-resolvers) uses the MODULE-GLOBAL
// prisma, so we mock db.js with the same fake to keep the real
// org/enterprise policy decision running against controllable data.
vi.mock("../src/db.js", () => ({ prisma: fakePrisma() }));
function fakePrisma() {
  return new Proxy(
    {},
    {
      get(_t, model: string) {
        if (model === "$transaction")
          return async (fn: (tx: unknown) => unknown) => fn(fakePrisma());
        return new Proxy(
          {},
          {
            get(_t2, method: string) {
              return async () => {
                if (/^(create|update|upsert|delete)/.test(method))
                  writes.push(`${model}.${method}`);
                if (model === "ssoConnection" && method === "findFirst")
                  return {
                    id: "conn-1",
                    teamId: "team-1",
                    provider: "GENERIC_OIDC",
                    status: "ACTIVE",
                    issuerUrl: ISSUER,
                    clientId: CLIENT_ID,
                    clientSecretHash: "hash",
                    allowedEmailDomains: [],
                    restrictToVerifiedDomains: false,
                    jitDefaultRole: null,
                  };
                if (model === "team" && method === "findUnique")
                  return {
                    id: "team-1",
                    ownerUserId: "user-1",
                    isPersonal: false,
                    billingPlan: dbState.billingPlan,
                    billingStatus: dbState.billingStatus,
                    organizationId: "org-1",
                    organization: { status: "ACTIVE", kind: dbState.orgKind },
                  };
                if (model === "entitlement" && method === "findFirst")
                  return { plan: dbState.billingPlan, active: true };
                if (model === "organization" && method === "findUnique")
                  return { id: "org-1", status: "ACTIVE", kind: dbState.orgKind };
                if (model === "externalIdentityMapping" && method === "findUnique")
                  return dbState.mapping;
                if (model === "user" && method === "findUnique")
                  return { id: "user-1", email: "user@enterprise.com", displayName: "U" };
                if (method === "findFirst" || method === "findUnique") return null;
                if (method === "findMany") return [];
                if (method === "count") return 0;
                // PHASE 12 POINT 4 PASS C5 — the enterprise gate now resolves
                // the effective plan through the canonical commercial envelope
                // (instead of a raw two-column read with an owner-plan
                // fallback), so this fake must answer the aggregate reads that
                // envelope performs. Every `_sum.<field>` reads as null.
                if (method === "aggregate")
                  return {
                    _sum: new Proxy({}, { get: () => null }),
                    _count: 0,
                    _avg: new Proxy({}, { get: () => null }),
                    _max: new Proxy({}, { get: () => null }),
                    _min: new Proxy({}, { get: () => null }),
                  };
                if (method === "groupBy") return [];
                if (/^(create|update|upsert)/.test(method)) return { id: "row-1" };
                return {};
              };
            },
          },
        );
      },
    },
  );
}

import {
  handleOidcCallback,
  buildOidcAuthorizationUrl,
  setClientSecretResolver,
  __resetSsoServiceStateForTests,
  SsoServiceError,
} from "../src/services/access-control/sso.service.js";

setClientSecretResolver(() => "client-secret");

async function signIdToken(
  claims: Record<string, unknown>,
  opts: { key?: unknown; expSecondsFromNow?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expSecondsFromNow ?? 300))
    .sign((opts.key ?? PRIVATE_KEY) as never);
}

// Seed a real state+nonce by driving the production authorization-url
// builder (which mints and stores the state), then read the nonce back
// from the returned URL.
async function seedState(): Promise<{ state: string; nonce: string }> {
  const { authorizationUrl, state } = await buildOidcAuthorizationUrl(
    { teamId: "team-1", connectionId: "conn-1", redirectUri: `${ISSUER}/cb` },
    fakePrisma() as never,
  );
  const nonce = new URL(authorizationUrl).searchParams.get("nonce")!;
  return { state, nonce };
}

async function callback(idToken: string, state: string) {
  netState.idToken = idToken;
  return handleOidcCallback(
    { state, code: "auth-code", redirectUri: `${ISSUER}/cb` },
    fakePrisma() as never,
  );
}

beforeEach(() => {
  __resetSsoServiceStateForTests();
  writes.length = 0;
  dbState.mapping = { userId: "user-1", teamId: "team-1" };
  dbState.orgKind = "CUSTOMER";
  dbState.billingPlan = "ENTERPRISE";
  dbState.billingStatus = "ACTIVE";
  netState.userinfo = { sub: "idp-sub-1", email: "user@enterprise.com" };
});

describe("Phase 8 §11.3 — OIDC callback POSITIVE (real jwtVerify)", () => {
  it("valid state+nonce+issuer+audience+signature+non-expired → resolves the user/tenant", async () => {
    const { state, nonce } = await seedState();
    const idToken = await signIdToken({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: "idp-sub-1",
      nonce,
    });
    const res = await callback(idToken, state);
    expect(res.teamId).toBe("team-1");
    expect(res.connectionId).toBe("conn-1");
    expect(res.user.id).toBe("user-1");
  });
});

describe("Phase 8 §11.3 — OIDC callback NEGATIVES (real verification; no side effects)", () => {
  async function expectRejected(run: () => Promise<unknown>) {
    writes.length = 0;
    await expect(run()).rejects.toBeInstanceOf(SsoServiceError);
    // No membership / session / credential / mapping write on failure.
    expect(
      writes.filter((w) =>
        /teamMember|organizationMembership|session|apiCredential|externalIdentityMapping|user\.create/.test(
          w,
        ),
      ),
    ).toEqual([]);
  }

  it("1. missing state", async () => {
    await expectRejected(() => callback("x.y.z", ""));
  });
  it("2. unknown state", async () => {
    await expectRejected(() => callback("x.y.z", "never-issued"));
  });
  it("3. reused (single-use) state", async () => {
    const { state, nonce } = await seedState();
    const idToken = await signIdToken({ iss: ISSUER, aud: CLIENT_ID, sub: "idp-sub-1", nonce });
    await callback(idToken, state); // consumes the state
    await expectRejected(() => callback(idToken, state)); // reuse → rejected
  });
  it("5/6. wrong nonce", async () => {
    const { state } = await seedState();
    const idToken = await signIdToken({ iss: ISSUER, aud: CLIENT_ID, sub: "idp-sub-1", nonce: "WRONG" });
    await expectRejected(() => callback(idToken, state));
  });
  it("7. wrong issuer", async () => {
    const { state, nonce } = await seedState();
    const idToken = await signIdToken({ iss: "https://evil.example.com", aud: CLIENT_ID, sub: "idp-sub-1", nonce });
    await expectRejected(() => callback(idToken, state));
  });
  it("8. wrong audience/client id", async () => {
    const { state, nonce } = await seedState();
    const idToken = await signIdToken({ iss: ISSUER, aud: "other-client", sub: "idp-sub-1", nonce });
    await expectRejected(() => callback(idToken, state));
  });
  it("9. expired token", async () => {
    const { state, nonce } = await seedState();
    const idToken = await signIdToken(
      { iss: ISSUER, aud: CLIENT_ID, sub: "idp-sub-1", nonce },
      { expSecondsFromNow: -120 },
    );
    await expectRejected(() => callback(idToken, state));
  });
  it("11. invalid signature (signed by a foreign key)", async () => {
    const foreign = await generateKeyPair("RS256", { extractable: true });
    const { state, nonce } = await seedState();
    const idToken = await signIdToken(
      { iss: ISSUER, aud: CLIENT_ID, sub: "idp-sub-1", nonce },
      { key: foreign.privateKey },
    );
    await expectRejected(() => callback(idToken, state));
  });
  it("16. non-enterprise workspace (commercial gate) → SSO_NOT_ENTERPRISE, no side effects", async () => {
    const { state, nonce } = await seedState();
    const idToken = await signIdToken({ iss: ISSUER, aud: CLIENT_ID, sub: "idp-sub-1", nonce });
    // Downgrade the workspace off Enterprise — the real enforceSsoLoginPolicy
    // → resolveTeamEnterpriseFeatureGate must deny before any side effect.
    dbState.billingPlan = "FREE";
    dbState.billingStatus = "INACTIVE";
    await expectRejected(() => callback(idToken, state));
  });

  it("13. userinfo subject mismatch (token-substitution) → rejected", async () => {
    const { state, nonce } = await seedState();
    const idToken = await signIdToken({ iss: ISSUER, aud: CLIENT_ID, sub: "idp-sub-1", nonce });
    netState.userinfo = { sub: "DIFFERENT-sub", email: "user@enterprise.com" };
    await expectRejected(() => callback(idToken, state));
  });
});


afterAll(() => {
  globalThis.fetch = originalFetch;
});
