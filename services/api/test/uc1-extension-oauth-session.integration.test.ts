/**
 * UC-1 extension token — session identity, provenance, revocation, sign-in
 * redirect and the popup's real contract, against the real routes and a live
 * PostgreSQL 16.
 *
 *   UC-SEC-004 — the token is REGISTERED as an authenticated session anchored to
 *                the authorizing session's workspace, and carries that session's
 *                real authMethod, so organization policy applies to it.
 *   UC-EXT-009 — sign-out revokes the token server-side.
 *   UC-EXT-006 — a signed-out browser is sent to sign in, not shown 401 JSON.
 *   UC-EXT-001 / UC-EXT-010 — the popup's parser reads the REAL platform
 *                context, and the case list the popup needs is reachable.
 */
import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const REDIRECT = "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/oauth2";
const CLIENT = "proovra-extension";

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
function claims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
}

describe("UC-1 extension token session — live PostgreSQL 16", () => {
  let harness: IntegrationHarness;
  let app: IntegrationHarness["app"];
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let hashSessionId: (sid: string) => string;
  const envBefore = {
    allow: process.env.EXTENSION_OAUTH_REDIRECT_ALLOW,
    web: process.env.WEB_BASE_URL,
  };

  beforeAll(async () => {
    process.env.EXTENSION_OAUTH_REDIRECT_ALLOW = REDIRECT;
    process.env.WEB_BASE_URL = "http://localhost:3311";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    app = harness.app;
    ({ prisma } = await import("../src/db.js"));
    ({ hashSessionId } = await import("../src/services/identity-security/session-revocation.service.js"));
    // A real Customer Organization always has its security policy provisioned
    // (requireAuth fails CLOSED without one); the harness seeds none.
    for (const t of [harness.fixtures.teamA, harness.fixtures.teamB]) {
      const team = await prisma.team.findUniqueOrThrow({ where: { id: t.teamId }, select: { organizationId: true } });
      await prisma.organizationSecurityPolicy.upsert({
        where: { organizationId: team.organizationId! },
        create: { organizationId: team.organizationId!, teamId: t.teamId } as never,
        update: {},
      });
    }
    // The owner's web session is a registered session anchored to Team A, as a
    // real sign-in records it.
    const { recordAuthenticatedSession } = await import(
      "../src/services/access-control/session-inventory.service.js"
    );
    const c = claims(harness.fixtures.teamA.ownerToken);
    await recordAuthenticatedSession({
      userId: harness.fixtures.teamA.ownerUserId,
      teamId: harness.fixtures.teamA.teamId,
      sid: String(c.sid),
      iat: Number(c.iat),
      exp: Number(c.exp),
    });
  }, 600_000);

  afterAll(async () => {
    if (envBefore.allow === undefined) delete process.env.EXTENSION_OAUTH_REDIRECT_ALLOW;
    else process.env.EXTENSION_OAUTH_REDIRECT_ALLOW = envBefore.allow;
    if (envBefore.web === undefined) delete process.env.WEB_BASE_URL;
    else process.env.WEB_BASE_URL = envBefore.web;
    await harness?.cleanup();
  });

  const teamA = () => harness.fixtures.teamA;

  async function mint(parentToken = teamA().ownerToken): Promise<string> {
    const { verifier, challenge } = pkce();
    const authz = await app.inject({
      method: "GET",
      url:
        `/v1/oauth/extension/authorize?response_type=code&client_id=${CLIENT}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}` +
        `&code_challenge_method=S256&state=s&scope=${encodeURIComponent("capture.direct offline")}`,
      headers: { authorization: `Bearer ${parentToken}` },
    });
    expect(authz.statusCode, authz.body).toBe(302);
    const code = new URL(String(authz.headers.location)).searchParams.get("code")!;
    const tok = await app.inject({
      method: "POST",
      url: "/v1/oauth/extension/token",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: CLIENT,
        redirect_uri: REDIRECT,
      }),
    });
    expect(tok.statusCode, tok.body).toBe(200);
    expect(tok.json().scope, "offline is no longer granted (UC-EXT-008)").toBe("capture.direct");
    return tok.json().access_token as string;
  }

  const get = (url: string, token: string) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  it("UC-SEC-004: the token is a registered session anchored to the authorizing session's workspace", async () => {
    const access = await mint();
    const c = claims(access);
    const row = await prisma.authenticatedSession.findFirst({
      where: { userId: teamA().ownerUserId, sessionIdHash: hashSessionId(String(c.sid)) },
      select: { teamId: true, revokedAtUtc: true, uaPreview: true },
    });
    expect(row, "the extension token has an AuthenticatedSession row").toBeTruthy();
    expect(row!.teamId).toBe(teamA().teamId);
    expect(row!.revokedAtUtc).toBeNull();
    expect(row!.uaPreview).toMatch(/^PROOVRA browser extension/);
  });

  it("UC-SEC-004: the token carries the authorizing session's real authMethod, not a hard-coded SOCIAL_OAUTH", async () => {
    const c = claims(await mint());
    expect(c.authMethod).toBe("PASSWORD");
    expect(c.scope).toBe("capture.direct");
  });

  it("UC-SEC-004: an organization that mandates SSO refuses a password-derived extension token", async () => {
    const access = await mint();
    expect((await get("/v1/platform/context", access)).statusCode).toBe(200);
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: teamA().teamId },
      select: { organizationId: true },
    });
    const policy = await prisma.organizationSecurityPolicy.update({
      where: { organizationId: team.organizationId! },
      data: { ssoRequired: true },
    });
    try {
      const denied = await get("/v1/platform/context", access);
      expect(denied.statusCode, "org SSO policy now reaches the extension token").toBe(401);

      // The capture TARGET policy authority (for a target other than the anchor).
      const { evaluateExtensionCaptureTargetPolicy } = await import("../src/services/auth/extension-scope.js");
      const c = claims(access);
      const verdict = await evaluateExtensionCaptureTargetPolicy({
        user: { sub: String(c.sub), tokenScope: "capture.direct", authMethod: String(c.authMethod), authAt: Number(c.authAt) },
        teamId: teamA().teamId,
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("mandatory_sso_required");
      const other = await evaluateExtensionCaptureTargetPolicy({
        user: { sub: String(c.sub), tokenScope: "capture.direct", authMethod: String(c.authMethod), authAt: Number(c.authAt) },
        teamId: harness.fixtures.teamB.teamId,
      });
      expect(other.allowed).toBe(true);
    } finally {
      await prisma.organizationSecurityPolicy.update({ where: { id: policy.id }, data: { ssoRequired: false } });
    }
  });

  it("UC-EXT-009: sign-out revokes the token server-side; a copied token stops working", async () => {
    const access = await mint();
    expect((await get("/v1/platform/context", access)).statusCode).toBe(200);
    const revoke = await app.inject({
      method: "POST",
      url: "/v1/oauth/extension/revoke",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      payload: "{}",
    });
    expect(revoke.statusCode, revoke.body).toBe(200);
    expect((await get("/v1/platform/context", access)).statusCode).toBe(401);
    const open = await app.inject({
      method: "POST",
      url: "/v1/capture/direct-sessions",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      payload: JSON.stringify({ mode: "DIRECT_WEB_CAPTURE_EXTENSION", teamId: teamA().teamId, deviceId: null }),
    });
    expect(open.statusCode).toBe(401);
    const c = claims(access);
    const row = await prisma.authenticatedSession.findFirst({
      where: { userId: teamA().ownerUserId, sessionIdHash: hashSessionId(String(c.sid)) },
      select: { revokedAtUtc: true },
    });
    expect(row?.revokedAtUtc).toBeTruthy();
  });

  it("UC-EXT-009: an ordinary web token cannot call the extension revoke", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/oauth/extension/revoke",
      headers: { authorization: `Bearer ${teamA().ownerToken}`, "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(403);
  });

  it("UC-EXT-006: a signed-out browser navigation is sent to sign in with a return path to authorize", async () => {
    const { challenge } = pkce();
    const qs =
      `response_type=code&client_id=${CLIENT}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=nav-state`;
    const res = await app.inject({
      method: "GET",
      url: `/v1/oauth/extension/authorize?${qs}`,
      headers: { accept: "text/html,application/xhtml+xml", "sec-fetch-mode": "navigate" },
    });
    expect(res.statusCode).toBe(302);
    const loc = new URL(String(res.headers.location));
    expect(loc.origin + loc.pathname).toBe("http://localhost:3311/login");
    const next = loc.searchParams.get("next")!;
    expect(next.startsWith("/auth/extension/continue?"), "the web login only accepts a relative next").toBe(true);
    const back = new URLSearchParams(next.split("?")[1]);
    expect(back.get("redirect_uri")).toBe(REDIRECT);
    expect(back.get("code_challenge")).toBe(challenge);
    expect(back.get("state")).toBe("nav-state");

    // An expired / garbage cookie is treated as signed out too.
    const stale = await app.inject({
      method: "GET",
      url: `/v1/oauth/extension/authorize?${qs}`,
      headers: { accept: "text/html", cookie: "proovra_session=not-a-jwt" },
    });
    expect(stale.statusCode).toBe(302);
    expect(String(stale.headers.location)).toContain("/login?next=");
  });

  it("UC-EXT-006: an unregistered redirect is refused before any sign-in bounce", async () => {
    const { challenge } = pkce();
    const res = await app.inject({
      method: "GET",
      url:
        `/v1/oauth/extension/authorize?response_type=code&client_id=${CLIENT}` +
        `&redirect_uri=${encodeURIComponent("https://cccccccccccccccccccccccccccccccc.chromiumapp.org/x")}` +
        `&code_challenge=${challenge}&code_challenge_method=S256&state=s`,
      headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers.location).toBeUndefined();
  });

  it("UC-EXT-001: the popup's own parser finds the member's workspace in the REAL platform context", async () => {
    const access = await mint();
    const res = await get("/v1/platform/context", access);
    expect(res.statusCode).toBe(200);
    const { classifyContextResponse } = await import("../../../apps/extension/src/lib/popup-context.js");
    const parsed = classifyContextResponse(res.statusCode, res.json());
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.workspaces.map((w) => w.id)).toContain(teamA().teamId);
  });

  it("UC-EXT-010: the extension token may read the case list the popup offers", async () => {
    const access = await mint();
    const res = await get("/v1/cases", access);
    expect(res.statusCode, res.body).toBe(200);
    const { parseEligibleCases } = await import("../../../apps/extension/src/lib/popup-context.js");
    const cases = parseEligibleCases(res.json(), teamA().teamId);
    expect(cases.map((c) => c.id)).toContain(teamA().caseId);
    // Still deny-by-default: a case MUTATION is off the allowlist.
    const post = await app.inject({
      method: "POST",
      url: "/v1/cases",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      payload: JSON.stringify({ name: "x", teamId: teamA().teamId }),
    });
    expect(post.statusCode).toBe(403);
  });
});
