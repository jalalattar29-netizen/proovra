/**
 * UC-SEC-002 / UC-SEC-003 / UC-SEC-005 — the booted API server's CORS decision
 * and request log, asked the way a browser and a log sink see them.
 *
 *  - SEC-003: every token-bearing path segment / query value is absent from
 *    every line the request log writes (intake, external review, org invite,
 *    team invite, verify share token, extension OAuth code).
 *  - SEC-005: in production no `*.vercel.app` origin and no localhost origin is
 *    a credentialed CORS origin; the Proovra origins still are.
 *  - SEC-002: a pinned extension origin passes the preflight (with the headers
 *    the extension sends) in production; an unpinned one is refused; with no
 *    extension configuration every extension origin is refused.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import type { IntegrationHarness } from "./integration-harness.js";

const PINNED_ID = "abcdefghijklmnopabcdefghijklmnop"; // 32 chars of [a-p]
const OTHER_ID = "ponmlkjihgfedcbaponmlkjihgfedcba";

describe("booted server: CORS origin policy + request-log redaction", () => {
  let harness: IntegrationHarness;
  let app: FastifyInstance;
  const lines: string[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    const { buildServer } = await import("../src/server.js");
    app = await buildServer({ logStream: { write: (m: string) => void lines.push(m) } });
    await app.ready();
  }, 180_000);
  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await harness?.cleanup();
  });

  function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
      saved[k] = process.env[k];
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    return fn().finally(() => {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
  }

  async function preflight(origin: string, headers = "authorization,content-type") {
    return app.inject({
      method: "OPTIONS",
      url: "/v1/capture/direct-sessions",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": headers,
      },
    });
  }

  it("SEC-003: no token-bearing path or query value reaches the request log", async () => {
    const tok = () => randomBytes(24).toString("base64url");
    const secrets = {
      intake: tok(),
      intakeParts: tok(),
      review: tok(),
      orgInvite: tok(),
      teamInvite: tok(),
      share: `pvs_${randomBytes(32).toString("base64url")}`,
      code: tok(),
      unmatched: tok(),
    };
    const requests: Array<{ method: "GET" | "POST"; url: string }> = [
      { method: "GET", url: `/v1/external-intake/${secrets.intake}` },
      { method: "POST", url: `/v1/external-intake/${secrets.intakeParts}/sessions/s1/parts` },
      { method: "GET", url: `/v1/external-review/access/${secrets.review}` },
      { method: "POST", url: `/v1/org-invites/${secrets.orgInvite}/accept` },
      { method: "POST", url: `/v1/teams/invites/${secrets.teamInvite}/accept` },
      { method: "GET", url: `/public/verify/${secrets.share}` },
      { method: "GET", url: `/v1/auth/extension/authorize?client_id=x&code=${secrets.code}` },
      { method: "GET", url: `/v1/external-intake/${secrets.unmatched}/not-a-route` },
    ];
    lines.length = 0;
    for (const r of requests) {
      await app.inject({ method: r.method, url: r.url, payload: r.method === "POST" ? {} : undefined });
    }
    const log = lines.join("\n");
    const completed = lines.filter((l) => l.includes("request.completed"));
    expect(completed.length).toBeGreaterThanOrEqual(requests.length);
    for (const [name, value] of Object.entries(secrets)) {
      expect(log.includes(value), `${name} token leaked into the request log`).toBe(false);
    }
    // The path shape stays legible for operators.
    expect(log).toContain("/v1/external-intake/[redacted]");
    expect(log).toContain("/public/verify/[redacted]");
  });

  it("SEC-005: production refuses *.vercel.app and localhost; keeps the Proovra origins", async () => {
    await withEnv({ NODE_ENV: "production", CORS_ORIGINS: "" }, async () => {
      for (const origin of ["https://evil.vercel.app", "http://localhost:3000", "https://proovra.com.evil.example"]) {
        const res = await preflight(origin);
        expect(res.headers["access-control-allow-origin"], origin).toBeUndefined();
      }
      for (const origin of ["https://app.proovra.com", "https://www.proovra.com", "https://staging.proovra.com"]) {
        const res = await preflight(origin);
        expect(res.headers["access-control-allow-origin"], origin).toBe(origin);
      }
    });
    await withEnv({ NODE_ENV: "production", CORS_ORIGINS: "https://proovra-preview.vercel.app" }, async () => {
      const res = await preflight("https://proovra-preview.vercel.app");
      expect(res.headers["access-control-allow-origin"]).toBe("https://proovra-preview.vercel.app");
    });
  });

  it("SEC-002: a pinned extension origin is admitted in production; unpinned / unconfigured are refused", async () => {
    await withEnv(
      {
        NODE_ENV: "production",
        EXTENSION_OAUTH_REDIRECT_ALLOW: `https://${PINNED_ID}.chromiumapp.org/`,
        EXTENSION_ALLOWED_ORIGINS: undefined,
      },
      async () => {
        const ok = await preflight(`chrome-extension://${PINNED_ID}`, "authorization,content-type,x-proovra-workspace-id");
        expect(ok.statusCode).toBeLessThan(300);
        expect(ok.headers["access-control-allow-origin"]).toBe(`chrome-extension://${PINNED_ID}`);
        const allowed = String(ok.headers["access-control-allow-headers"] ?? "").toLowerCase();
        expect(allowed).toContain("authorization");
        expect(allowed).toContain("content-type");
        const bad = await preflight(`chrome-extension://${OTHER_ID}`);
        expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
      },
    );
    await withEnv(
      { NODE_ENV: "production", EXTENSION_OAUTH_REDIRECT_ALLOW: undefined, EXTENSION_ALLOWED_ORIGINS: `chrome-extension://${OTHER_ID}` },
      async () => {
        const res = await preflight(`chrome-extension://${OTHER_ID}`);
        expect(res.headers["access-control-allow-origin"]).toBe(`chrome-extension://${OTHER_ID}`);
      },
    );
    // Unset: every extension origin refused — in production AND in development.
    for (const NODE_ENV of ["production", "test"]) {
      await withEnv({ NODE_ENV, EXTENSION_OAUTH_REDIRECT_ALLOW: undefined, EXTENSION_ALLOWED_ORIGINS: undefined }, async () => {
        const res = await preflight(`chrome-extension://${PINNED_ID}`);
        expect(res.headers["access-control-allow-origin"], NODE_ENV).toBeUndefined();
      });
    }
  });
});
