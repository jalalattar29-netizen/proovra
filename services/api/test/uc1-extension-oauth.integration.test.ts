/**
 * UC-1 — first-party extension OAuth (Authorization Code + PKCE S256), against
 * the real routes and DB. Proves the REAL authentication journey the extension
 * uses: authorize (behind requireAuth) issues a PKCE-bound single-use code, the
 * token endpoint exchanges it for a short-lived AUTH_JWT that the canonical
 * requireAuth accepts — and every binding is enforced.
 */
import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const REDIRECT = "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/oauth";
const CLIENT = "proovra-extension";

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

describe("UC-1 extension OAuth (PKCE) — live PostgreSQL 16", () => {
  let harness: IntegrationHarness;
  let app: IntegrationHarness["app"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    app = harness.app;
  }, 600_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  const owner = () => harness.fixtures.teamA;

  async function authorize(params: Record<string, string>, token = owner().ownerToken) {
    const qs = new URLSearchParams(params).toString();
    return app.inject({
      method: "GET",
      url: `/v1/oauth/extension/authorize?${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function tokenExchange(body: Record<string, string>) {
    return app.inject({
      method: "POST",
      url: "/v1/oauth/extension/token",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
  }

  function codeFrom(res: { headers: Record<string, unknown> }): string {
    const loc = String(res.headers["location"] ?? "");
    return new URL(loc).searchParams.get("code") ?? "";
  }

  it("the full journey: authorize (authenticated) -> code -> token -> a usable bearer", async () => {
    const { verifier, challenge } = pkce();
    const authz = await authorize({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz-state",
      scope: "capture.direct",
    });
    expect(authz.statusCode, authz.body).toBe(302);
    const loc = new URL(String(authz.headers["location"]));
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("xyz-state");
    const code = loc.searchParams.get("code")!;
    expect(code.length).toBeGreaterThan(20);

    const tok = await tokenExchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT,
      redirect_uri: REDIRECT,
    });
    expect(tok.statusCode, tok.body).toBe(200);
    const access = tok.json().access_token as string;
    expect(tok.json().token_type).toBe("Bearer");
    expect(tok.json().expires_in).toBe(3600);

    // The minted token is a real bearer the canonical requireAuth accepts on an
    // allowlisted route (the popup reads the account context).
    const me = await app.inject({
      method: "GET",
      url: "/v1/platform/context",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(me.statusCode).not.toBe(401);
    expect(me.statusCode).not.toBe(403);
  });

  async function mintExtensionToken(): Promise<string> {
    const { verifier, challenge } = pkce();
    const authz = await authorize({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "scope-test",
      scope: "capture.direct",
    });
    const code = codeFrom(authz);
    const tok = await tokenExchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT,
      redirect_uri: REDIRECT,
    });
    return tok.json().access_token as string;
  }

  it("§4.1 — the capture-scoped token is refused on routes outside its allowlist", async () => {
    const access = await mintExtensionToken();

    // Allowed: an allowlisted capture route (session open) is NOT a scope 403.
    const openSession = await app.inject({
      method: "POST",
      url: "/v1/capture/direct-sessions",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      payload: JSON.stringify({ mode: "DIRECT_WEB_CAPTURE_EXTENSION", teamId: owner().teamId, deviceId: null }),
    });
    expect(openSession.statusCode).not.toBe(403);

    // Refused: an unrelated authenticated route is 403 for a scoped token.
    const unrelated = await app.inject({
      method: "GET",
      url: "/v1/evidence?scope=all&limit=1",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(unrelated.statusCode).toBe(403);

    // Backward compatible: an ordinary (unscoped) token reaches the same route.
    const ordinary = await app.inject({
      method: "GET",
      url: "/v1/evidence?scope=all&limit=1",
      headers: { authorization: `Bearer ${owner().ownerToken}` },
    });
    expect(ordinary.statusCode).not.toBe(403);
  });

  it("authorize requires authentication", async () => {
    const { challenge } = pkce();
    const res = await app.inject({
      method: "GET",
      url:
        `/v1/oauth/extension/authorize?response_type=code&client_id=${CLIENT}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}` +
        `&code_challenge_method=S256&state=s`,
      // no Authorization header
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses an arbitrary redirect and a non-S256 challenge method", async () => {
    const { challenge } = pkce();
    const evil = await authorize({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: "https://evil.example.com/steal",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s",
    });
    expect(evil.statusCode).toBe(400);

    const plain = await authorize({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "plain",
      state: "s",
    });
    // zod rejects a non-S256 method before the service is reached.
    expect(plain.statusCode).toBe(400);
  });

  it("token exchange enforces the PKCE verifier, single use, and client/redirect binding", async () => {
    const { verifier, challenge } = pkce();
    const mint = async () =>
      codeFrom(
        await authorize({
          response_type: "code",
          client_id: CLIENT,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "s",
        }),
      );

    // Wrong verifier.
    const wrong = await tokenExchange({
      grant_type: "authorization_code",
      code: await mint(),
      code_verifier: base64Url(randomBytes(32)),
      client_id: CLIENT,
      redirect_uri: REDIRECT,
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("PKCE_VERIFICATION_FAILED");

    // Reused code: first exchange wins, second is refused.
    const reuseCode = await mint();
    const first = await tokenExchange({
      grant_type: "authorization_code",
      code: reuseCode,
      code_verifier: verifier,
      client_id: CLIENT,
      redirect_uri: REDIRECT,
    });
    expect(first.statusCode).toBe(200);
    const second = await tokenExchange({
      grant_type: "authorization_code",
      code: reuseCode,
      code_verifier: verifier,
      client_id: CLIENT,
      redirect_uri: REDIRECT,
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe("CODE_INVALID_OR_USED");

    // Redirect mismatch at exchange.
    const mism = await tokenExchange({
      grant_type: "authorization_code",
      code: await mint(),
      code_verifier: verifier,
      client_id: CLIENT,
      redirect_uri: "https://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.chromiumapp.org/oauth",
    });
    expect(mism.statusCode).toBe(400);
    expect(mism.json().error).toBe("CLIENT_OR_REDIRECT_MISMATCH");
  });
});
