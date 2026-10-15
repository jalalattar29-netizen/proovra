/**
 * AUD-021 — cookie-authenticated mutations require a trusted web origin, asked
 * of the booted API server the way a browser reaches it.
 *
 * The session cookie is SameSite=lax on .proovra.com, so every sibling
 * subdomain is same-site with the API and the browser attaches the cookie to a
 * form or fetch sent from it. Before this guard a cookie-authenticated POST was
 * accepted from anywhere the cookie travelled. Development additionally
 * reflected EVERY origin with credentials.
 *
 * The mutation used is `POST /v1/auth/logout` with a real session: its effect
 * (the session is revoked) is observable, so a refusal is proven to have
 * stopped the handler, not just to have changed a status code.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const CONFIGURED_WEB = "http://127.0.0.1:3007"; // CORS_ORIGINS in the test bootstrap

describe("AUD-021 — cookie mutation origin guard (booted server, live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let signJwt: (typeof import("../src/services/jwt.js"))["signJwt"];
  let recordAuthenticatedSession: (typeof import("../src/services/access-control/session-inventory.service.js"))["recordAuthenticatedSession"];
  let prisma: (typeof import("../src/db.js"))["prisma"];

  /** A fresh, recorded session for the personal fixture user. */
  async function session(): Promise<string> {
    const { userId } = harness.fixtures.personal;
    const token = signJwt(
      { sub: userId, provider: "EMAIL", email: null, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET!,
      3600,
    );
    const p = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as {
      sid: string;
      iat: number;
      exp: number;
    };
    await recordAuthenticatedSession({ userId, teamId: null, sid: p.sid, iat: p.iat, exp: p.exp });
    return token;
  }

  const logout = (headers: Record<string, string>) =>
    harness.app.inject({ method: "POST", url: "/v1/auth/logout", headers });
  const alive = async (token: string) =>
    (await harness.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    })).statusCode === 200;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ signJwt } = await import("../src/services/jwt.js"));
    ({ recordAuthenticatedSession } = await import(
      "../src/services/access-control/session-inventory.service.js"
    ));
    ({ prisma } = await import("../src/db.js"));
  });
  afterAll(async () => {
    await prisma?.revokedSession.deleteMany({ where: { userId: harness?.fixtures.personal.userId } });
    await harness?.cleanup();
  });

  it("an allowed web origin may mutate with the cookie (and the mutation takes effect)", async () => {
    const token = await session();
    const res = await logout({ cookie: `proovra_session=${token}`, origin: CONFIGURED_WEB });
    expect(res.statusCode, res.body).toBe(200);
    expect(await alive(token)).toBe(false);
  });

  it("refuses sibling subdomains, look-alike suffixes and a null origin — the handler never runs", async () => {
    for (const origin of [
      "https://status.proovra.com",
      "https://evil.app.proovra.com",
      "https://proovra.com.evil.com",
      "https://evilproovra.com",
      "http://proovra.com",
      "null",
    ]) {
      const token = await session();
      const res = await logout({ cookie: `proovra_session=${token}`, origin });
      expect(res.statusCode, origin).toBe(403);
      expect(JSON.parse(res.body).error.code, origin).toBe("FORBIDDEN");
      expect(await alive(token), `${origin} must not have reached the handler`).toBe(true);
    }
  });

  it("a cookie mutation with neither Origin nor Referer is refused", async () => {
    const token = await session();
    const res = await logout({ cookie: `proovra_session=${token}` });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.details.reason).toBe("origin_missing");
    expect(await alive(token)).toBe(true);
  });

  it("Referer stands in for a missing Origin — exact origin, not prefix", async () => {
    const ok = await session();
    expect((await logout({ cookie: `proovra_session=${ok}`, referer: `${CONFIGURED_WEB}/settings/security` })).statusCode).toBe(200);
    expect(await alive(ok)).toBe(false);

    const bad = await session();
    const res = await logout({
      cookie: `proovra_session=${bad}`,
      referer: `${CONFIGURED_WEB}.evil.example/settings`,
    });
    expect(res.statusCode).toBe(403);
    expect(await alive(bad)).toBe(true);
  });

  it("Sec-Fetch-Site: cross-site is refused even with an allowed Origin", async () => {
    const token = await session();
    const res = await logout({
      cookie: `proovra_session=${token}`,
      origin: CONFIGURED_WEB,
      "sec-fetch-site": "cross-site",
    });
    expect(res.statusCode).toBe(403);
    expect(await alive(token)).toBe(true);
  });

  it("bearer clients (mobile, extension, API) are unaffected: no Origin needed", async () => {
    const token = await session();
    const res = await logout({ authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(200);
    expect(await alive(token)).toBe(false);
  });

  it("safe methods with the cookie need no Origin", async () => {
    const token = await session();
    const res = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: `proovra_session=${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("CORS preflight: an allowed origin is admitted with credentials; sibling / look-alike / arbitrary origins are not reflected", async () => {
    const preflight = (origin: string) =>
      harness.app.inject({
        method: "OPTIONS",
        url: "/v1/auth/logout",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });
    const ok = await preflight(CONFIGURED_WEB);
    expect(ok.headers["access-control-allow-origin"]).toBe(CONFIGURED_WEB);
    expect(ok.headers["access-control-allow-credentials"]).toBe("true");
    // NODE_ENV=test here: development no longer reflects arbitrary origins.
    for (const origin of [
      "https://attacker.example",
      "https://status.proovra.com",
      "https://proovra.com.evil.com",
      "https://evilproovra.com",
    ]) {
      const res = await preflight(origin);
      expect(res.headers["access-control-allow-origin"], origin).toBeUndefined();
    }
    // Loopback development origins remain usable outside production.
    expect((await preflight("http://localhost:3000")).headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000",
    );
  });
});
