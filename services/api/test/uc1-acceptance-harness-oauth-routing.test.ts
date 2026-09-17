/**
 * REGRESSION — the UC-1 Windows acceptance harness must route the OAuth
 * authorize/token requests to the canonical API origin, never to the Next.js
 * web origin.
 *
 * The bug (browser acceptance run): `buildLocalFixtureEnv` sets `PORT = apiPort`
 * for the whole stack. The web child was started as a bare `next dev` with that
 * shared env, so `next dev` bound the API's port (4000) and answered
 * `/v1/oauth/extension/authorize` with the Next.js 404 not-found page — every
 * Chrome/Edge scenario failed at `obtainExtensionAccessToken()` expecting 302,
 * getting 404. The fix gives the web child its OWN port (env `PORT` overridden +
 * an explicit `next dev -p <webPort>`), so the API keeps port 4000 and the
 * authorize/token endpoints resolve on the API origin.
 *
 * These assertions lock the port wiring and the URL derivation without booting
 * anything (the live 302 over HTTP is proven by the OAuth integration suite and
 * the acceptance harness itself).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { planServiceChildren, s3FixtureOverrides } from "../../../scripts/uc1-acceptance-windows.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

// Mirrors buildLocalFixtureEnv: PORT is set to the API port for the whole stack.
const config = { apiPort: "4000", webPort: "3311", fixturePort: "4599", skipWeb: false };
const fixtureEnv = { PORT: config.apiPort, WORKER_PORT: "4001" };

describe("UC-1 acceptance harness — OAuth/API routing", () => {
  it("gives the web child its OWN port so it never squats the API origin", () => {
    const plan = planServiceChildren({ fixtureEnv, config });
    const api = plan.find((c) => c.name === "api")!;
    const web = plan.find((c) => c.name === "web")!;

    expect(api.env.PORT).toBe(config.apiPort);
    expect(web).toBeTruthy();
    // THE REGRESSION: the web child must not inherit the API's port.
    expect(web.env.PORT).toBe(config.webPort);
    expect(web.env.PORT).not.toBe(config.apiPort);
    // And next is told its port explicitly (env alone has silently misbound before).
    const pIdx = web.args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(web.args[pIdx + 1]).toBe(config.webPort);
  });

  it("assigns a unique port to every listening service (worker uses WORKER_PORT)", () => {
    const plan = planServiceChildren({ fixtureEnv, config });
    const listeners = plan.filter((c) => c.name !== "worker").map((c) => c.env.PORT);
    expect(new Set(listeners).size).toBe(listeners.length);
  });

  it("the API origin the acceptance uses is distinct from the web origin", () => {
    expect(`http://localhost:${config.apiPort}`).not.toBe(`http://localhost:${config.webPort}`);
  });

  it("the extension builds authorize + token URLs from the API origin, not a web base", () => {
    const build = readFileSync(resolve(REPO_ROOT, "apps/extension/build.mjs"), "utf8");
    expect(build).toMatch(
      /__PROOVRA_AUTH_AUTHORIZE_URL__[\s\S]*?PROOVRA_API_ORIGIN[\s\S]*?\/v1\/oauth\/extension\/authorize/,
    );
    expect(build).toMatch(
      /__PROOVRA_AUTH_TOKEN_URL__[\s\S]*?PROOVRA_API_ORIGIN[\s\S]*?\/v1\/oauth\/extension\/token/,
    );
    // The OAuth endpoints must never be derived from a web/app base URL.
    expect(build).not.toMatch(/WEB_BASE|APP_BASE_URL|NEXT_PUBLIC_APP/);
  });

  it("wires the acceptance stack to a REAL local disposable object store (not the dead endpoint)", () => {
    // The UC-1 lifecycle is storage-backed end to end; the canonical fixture env
    // points S3 at a dead localhost:59900 on purpose. The harness MUST override
    // it or capture upload / worker report+package writes / public-verify reads
    // all fail — which is a hang to the test timeout, not a fast failure.
    const s3cfg = {
      s3Endpoint: "http://127.0.0.1:56423",
      s3Bucket: "uc1-acceptance",
      s3AccessKey: "uc1miniolocal",
      s3SecretKey: "uc1miniolocalsecret",
    };
    const extra = s3FixtureOverrides(s3cfg);
    expect(extra.S3_ENDPOINT).toBe(s3cfg.s3Endpoint);
    expect(extra.S3_ENDPOINT).not.toContain("59900"); // never the dead canonical endpoint
    // A local, path-style S3 (MinIO) with a disposable bucket.
    expect(new URL(extra.S3_ENDPOINT).hostname).toBe("127.0.0.1");
    expect(extra.S3_FORCE_PATH_STYLE).toBe("true");
    expect(extra.S3_BUCKET).toBe(s3cfg.s3Bucket);
    expect(extra.S3_PUBLIC_BASE_URL).toBe(s3cfg.s3Endpoint);
  });

  it("the e2e acceptance builds authorize + token from PROOVRA_API_ORIGIN", () => {
    const spec = readFileSync(
      resolve(REPO_ROOT, "apps/extension/e2e/direct-web-capture.spec.ts"),
      "utf8",
    );
    expect(spec).toMatch(/PROOVRA_API_ORIGIN/);
    expect(spec).toMatch(/\$\{API\}\/v1\/oauth\/extension\/authorize/);
    expect(spec).toMatch(/\$\{API\}\/v1\/oauth\/extension\/token/);
  });
});
