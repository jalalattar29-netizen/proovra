/**
 * D53 — the browser may send every header the product sends.
 *
 * A header missing from the CORS allow-list passes nothing to the server: the
 * browser refuses the real request after the preflight, and the product sees
 * an opaque network error. The portal's session header was missing, so every
 * external-reviewer call after sign-in failed in the browser while every
 * server-side test passed. This case asks the real, booted server the same
 * preflight question a browser asks.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

/** Headers the web product sets on cross-origin API calls. */
const BROWSER_HEADERS = [
  "content-type",
  "authorization",
  "x-web-client",
  "x-proovra-step-up-challenge-id",
  "x-proovra-workspace-id",
  "x-portal-session",
];

describe("D53 — CORS allows every header the product sends (booted server)", () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
  }, 180_000);
  afterAll(async () => {
    await harness?.cleanup();
  });

  it("a preflight for the portal session header is allowed", async () => {
    const res = await harness.app.inject({
      method: "OPTIONS",
      url: "/v1/portal/dashboard",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "GET",
        "access-control-request-headers": BROWSER_HEADERS.join(","),
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    const allowed = String(res.headers["access-control-allow-headers"] ?? "")
      .toLowerCase()
      .split(",")
      .map((h) => h.trim());
    for (const header of BROWSER_HEADERS) expect(allowed, header).toContain(header);
  });

  it("the portal client really sends the header this case protects", () => {
    const client = readFileSync(
      fileURLToPath(new URL("../../../apps/web/lib/external-portal/portal-client.ts", import.meta.url)),
      "utf8",
    );
    expect(client).toMatch(/headers\["x-portal-session"\]\s*=/);
  });

  // PRO-X1-11 — the installed extension's fetches are CORS-preflighted (its
  // manifest grants no host permissions) and every one names the build in
  // x-proovra-client. A header missing from the allow-list made the browser
  // refuse every extension call after the preflight.
  describe("PRO-X1-11: the extension's build header", () => {
    const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const OTHER_EXT = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
    const EXTENSION_HEADERS = ["authorization", "content-type", "x-proovra-client"];
    let previous: string | undefined;
    beforeAll(() => {
      previous = process.env.EXTENSION_ALLOWED_ORIGINS;
      process.env.EXTENSION_ALLOWED_ORIGINS = EXT;
    });
    afterAll(() => {
      if (previous === undefined) delete process.env.EXTENSION_ALLOWED_ORIGINS;
      else process.env.EXTENSION_ALLOWED_ORIGINS = previous;
    });
    const preflight = (origin: string) =>
      harness.app.inject({
        method: "OPTIONS",
        url: "/v1/capture/direct-sessions",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": EXTENSION_HEADERS.join(","),
        },
      });

    it("allowed: a preflight from the pinned extension origin admits every header the extension sends", async () => {
      const res = await preflight(EXT);
      expect(res.statusCode).toBeLessThan(300);
      expect(res.headers["access-control-allow-origin"]).toBe(EXT);
      const allowed = String(res.headers["access-control-allow-headers"] ?? "")
        .toLowerCase()
        .split(",")
        .map((h) => h.trim());
      for (const header of EXTENSION_HEADERS) expect(allowed, header).toContain(header);
    });

    it("refused: an extension origin that is not pinned gets no CORS grant", async () => {
      const res = await preflight(OTHER_EXT);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("the extension client really sends the header this case protects", () => {
      const client = readFileSync(
        fileURLToPath(new URL("../../../apps/extension/src/lib/api-client.ts", import.meta.url)),
        "utf8",
      );
      expect(client).toMatch(/CLIENT_ID_HEADER = "x-proovra-client"/);
      expect(client).toContain("[CLIENT_ID_HEADER]: clientIdHeaderValue()");
    });
  });
});
