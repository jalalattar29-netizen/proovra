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
  // On GitHub Actions also: `github` (each failure becomes an annotation — run
  // logs need a signed-in viewer) and a per-project JSON result, which the
  // workflow COUNTS so a run that executed nothing cannot pass.
  reporter:
    process.env.GITHUB_ACTIONS === "true"
      ? [
          ["list"],
          ["github"],
          ["json", { outputFile: `results/${process.env.UC1_PROJECT ?? "all"}.json` }],
        ]
      : [["list"]],
  projects: [
    { name: "chromium", use: { channel: "chrome" } },
    { name: "edge", use: { channel: "msedge" } },
  ],
});
