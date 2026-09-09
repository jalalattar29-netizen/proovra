/**
 * Playwright config for the admin control-plane verification matrix.
 *
 * Separate from apps/web/playwright.config.ts on purpose: that one targets the
 * Home acceptance suite on different ports with different prerequisites, and
 * merging them would make each suite's failure look like the other's.
 *
 * The API is NOT started here. It needs a migrated database and a seeded
 * fixture, and a config that silently starts a half-configured server produces
 * a suite that fails for reasons that have nothing to do with the pages:
 *
 *   node services/api/scripts/dev-admin-fixture-api.mjs
 *
 * =============================================================================
 * THE WEB TIER IS A PRODUCTION BUILD, AND PLAYWRIGHT OWNS ITS LIFETIME
 * =============================================================================
 * ADM-P2-004. This suite ran against `next dev` and could not be asserted
 * green. Across five runs the failure moved between four unrelated routes,
 * every failing route passed when re-run alone, and the fixture server answered
 * each stalled route in tens of milliseconds — while logging 3,363 on-demand
 * compiles for 47 routes, individual compiles reaching 23.3s. A navigation's
 * chunk requests queue behind an unrelated route's compilation and the
 * `domcontentloaded` budget goes. That is a property of compiling on demand.
 *
 * Raising the budget or retrying would have produced a green line without
 * producing a result, so the runner changed instead: the bundle is built once,
 * before the suite, and served by `next start`. This is the pattern the eight
 * layout projects in `apps/web/../../playwright.config.ts` already use, for the
 * neighbouring reason that `next dev` differs from the shipped bundle in
 * stylesheet order, cascade and class hashing.
 *
 * `webServer` rather than a hand-started process: Playwright starts exactly one
 * server, waits on an explicit readiness URL rather than a sleep, and tears it
 * down when the run ends — including when a test fails, which a backgrounded
 * `nohup` does not.
 *
 * The command goes through the fixture launcher, never a bare `next start`,
 * because the launcher builds the child environment from the
 * `scripts/local-fixture-env` allowlist. A bare `next start` would inherit the
 * shell — and `services/api/.env` holds live production credentials.
 *
 * Build first, exactly once:
 *   pnpm test:e2e:admin:build
 */
import { defineConfig } from "@playwright/test";

const WEB_PORT = Number(process.env.PROOVRA_FIXTURE_WEB_PORT ?? 3311);
const WEB_BASE =
  process.env.PROOVRA_FIXTURE_WEB_BASE ?? `http://localhost:${WEB_PORT}`;
const API_BASE = process.env.PROOVRA_FIXTURE_API_BASE ?? "http://localhost:8291";

export default defineConfig({
  testDir: ".",
  // The matrix walks 47 routes inside a single test body, so the per-test
  // budget is large by construction. The body sets its own timeout too.
  timeout: 30 * 60_000,
  expect: { timeout: 15_000 },
  /*
   * STILL SERIAL, AND NOT BECAUSE OF THE DEV SERVER.
   *
   * The original reason was that parallel workers made one `next dev` compile
   * several routes at once. That reason is gone with the production build, and
   * the setting stays anyway: these specs share one seeded fixture database and
   * mutate it — admin-mutations drives contact-sales status transitions end to
   * end — so two workers would race the same rows. Raising this needs the
   * fixtures proven isolated per worker first, which they are not.
   */
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  // Four levels up: this file sits in apps/web/e2e/admin-control-plane, so
  // three landed in apps/ and scattered artifacts into the wrong tree.
  outputDir: "../../../../artifacts/admin-matrix/playwright",
  use: {
    baseURL: WEB_BASE,
    trace: "off",
    video: "off",
    screenshot: "off",
    actionTimeout: 30_000,
    // UNCHANGED. The production build is meant to make this budget comfortable,
    // not to need a larger one — raising it would hide the very thing the
    // change is supposed to fix.
    navigationTimeout: 90_000,
  },
  webServer: {
    command:
      `node apps/web/scripts/dev-admin-fixture.mjs --mode=production ` +
      `--port=${WEB_PORT} --api=${API_BASE}`,
    cwd: "../../../..",
    // The EXPLICIT readiness condition: a real page served over HTTP, not a
    // port that happens to accept a socket and not a fixed sleep.
    url: `${WEB_BASE}/login`,
    // `false` on purpose. Reusing whatever is already on this port is how a
    // suite ends up measuring a server someone else started from a different
    // tree — which is exactly the class of defect this change closes.
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
