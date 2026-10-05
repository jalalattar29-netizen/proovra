import { defineConfig } from "@playwright/test";
import { rawReportPath } from "./uc1-results.mjs";

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
  // A per-project JSON report, locally AND on GitHub Actions, at the ONE
  // repository-root-relative path uc1-results.mjs owns. It is RAW input: the
  // harness turns it into the terminal result (results/<project>.json) that the
  // workflow gates on, so a run that executed nothing cannot pass. On GitHub
  // Actions also `github` (each failure becomes an annotation — run logs need a
  // signed-in viewer).
  reporter: [
    ["list"],
    ...(process.env.GITHUB_ACTIONS === "true" ? ([["github"]] as const) : []),
    ["json", { outputFile: rawReportPath(process.env.UC1_PROJECT ?? "all") }],
  ],
  projects: [
    { name: "chromium", use: { channel: "chrome" } },
    { name: "edge", use: { channel: "msedge" } },
  ],
});
