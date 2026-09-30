/**
 * UC-TQ-007 — the UC-1 acceptance stack carries the extension OAuth redirect
 * allow-list, as a TYPED redirect setting the fixture-environment scanner
 * shape-checks instead of refusing.
 *
 * ET-DC-04 made the API refuse every extension redirect unless
 * EXTENSION_OAUTH_REDIRECT_ALLOW names it. The harness never set it (every run
 * failed AUTH: 400 INVALID_CLIENT_OR_REDIRECT), and supplying it through the
 * fixture env's `extra` was refused as "reaches off this machine", because a
 * chromiumapp.org URL is not a local host — although nothing ever dials it.
 */
import { describe, expect, it } from "vitest";

import {
  buildLocalFixtureEnv,
  findEnvironmentLeaks,
  redirectAllowListProblems,
} from "../../../scripts/local-fixture-env/index.mjs";
import {
  acceptanceFixtureEnvOptions,
  acceptancePorts,
} from "../../../scripts/uc1-acceptance-windows.mjs";
import {
  E2E_EXTENSION_ID,
  E2E_OAUTH_REDIRECT,
} from "../../../apps/extension/scripts/manifest-plan.mjs";
import {
  extensionAllowedOrigins,
  isAllowedExtensionRedirect,
} from "../src/services/auth/extension-oauth.service.js";

const config = {
  apiPort: "4000",
  webPort: "3311",
  fixturePort: "4599",
  skipWeb: false,
  dbUrl: "postgresql://proovra:x@127.0.0.1:56421/uc1_acceptance_test",
  redisUrl: "redis://127.0.0.1:56422/0",
  s3Endpoint: "http://127.0.0.1:56423",
  s3Bucket: "uc1-acceptance",
  s3AccessKey: "uc1miniolocal",
  s3SecretKey: "uc1miniolocalsecret",
};

describe("UC-1 acceptance harness — extension OAuth redirect allow-list", () => {
  it("the acceptance stack's API env allow-lists the E2E build's real redirect", () => {
    const env = buildLocalFixtureEnv(acceptanceFixtureEnvOptions(config, { chromiumPath: "C:/chrome/chrome.exe" }));
    expect(env.EXTENSION_OAUTH_REDIRECT_ALLOW).toBe(E2E_OAUTH_REDIRECT);
    // …and the API accepts exactly that redirect with it.
    const before = process.env.EXTENSION_OAUTH_REDIRECT_ALLOW;
    process.env.EXTENSION_OAUTH_REDIRECT_ALLOW = env.EXTENSION_OAUTH_REDIRECT_ALLOW;
    try {
      expect(isAllowedExtensionRedirect("proovra-extension", E2E_OAUTH_REDIRECT)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.EXTENSION_OAUTH_REDIRECT_ALLOW;
      else process.env.EXTENSION_OAUTH_REDIRECT_ALLOW = before;
    }
    // UC-SEC-002 — the same pinned id yields the CORS-admissible extension origin.
    expect(extensionAllowedOrigins(env)).toEqual([`chrome-extension://${E2E_EXTENSION_ID}`]);
  });

  it("the typed setting is shape-checked: an off-shape entry is refused", () => {
    expect(() =>
      buildLocalFixtureEnv({ redirectAllowLists: { EXTENSION_OAUTH_REDIRECT_ALLOW: ["https://evil.example.com/steal"] } }),
    ).toThrow(/reaches off this machine/);
    expect(redirectAllowListProblems("EXTENSION_OAUTH_REDIRECT_ALLOW", [E2E_OAUTH_REDIRECT])).toEqual([]);
    expect(redirectAllowListProblems("SOME_OTHER_URL", ["https://x.example"])).toHaveLength(1);
  });

  it("the outbound scan is NOT weakened: the same URL under any other name, or smuggled via extra, is refused", () => {
    expect(() =>
      buildLocalFixtureEnv({ extra: { EXTENSION_OAUTH_REDIRECT_ALLOW: E2E_OAUTH_REDIRECT } }),
    ).toThrow(/redirectAllowLists/);
    expect(() => buildLocalFixtureEnv({ extra: { SOME_CALLBACK_URL: E2E_OAUTH_REDIRECT } })).toThrow(
      /reaches off this machine/,
    );
    expect(findEnvironmentLeaks({ EXTENSION_OAUTH_REDIRECT_ALLOW: E2E_OAUTH_REDIRECT }).length).toBeGreaterThan(0);
  });

  it("every stack port is known, so teardown can prove they are free again", () => {
    expect(acceptancePorts(config)).toEqual([4000, 4001, 3311, 4599]);
  });
});
