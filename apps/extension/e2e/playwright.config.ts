import { defineConfig } from "@playwright/test";

/**
 * UC-1 browser acceptance config. REAL Chrome (channel "chrome") and REAL Edge
 * (channel "msedge"), driven by the same spec. The spec launches each project's
 * declared channel itself and asserts the browser identity (UC-TQ-002); the E2E
 * build is loaded from ../dist-e2e over CDP. Run through
 * scripts/uc1-acceptance-windows.mjs (see e2e/README.md).
 */
export default defineConfig({
  testDir: ".",
  testMatch: /direct-web-capture\.spec\.ts/,
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  projects: [
    { name: "chromium", use: { channel: "chrome" } },
    { name: "edge", use: { channel: "msedge" } },
  ],
});
