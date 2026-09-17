import { defineConfig } from "@playwright/test";

/**
 * UC-1 browser acceptance config. Chrome-stable and Edge-stable, driven by the
 * same spec. The extension is loaded unpacked from ../dist (build it first).
 * Run on a machine with Chrome + Edge installed (see e2e/README.md).
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
