/**
 * Playwright E2E config — Phase 1 trust surface hardening.
 *
 * These tests run against a fully-running stack (API + worker + web +
 * Postgres + Redis + MinIO). They are NOT mocks. They are the
 * regression gate for:
 *
 *   * critical evidence flows (create → upload → sign)
 *   * public verify privacy posture (no PII leakage)
 *   * rate-limit semantics (429 + Retry-After)
 *   * auth surface (guest, login, expired session)
 *   * landing-page reachability (browser-visible 200)
 *
 * Treat any failure here as a release blocker.
 *
 * Environment expected:
 *   - WEB_BASE=http://localhost:3000
 *   - API_BASE=http://localhost:8081
 *   - The CI workflow `playwright-e2e.yml` provisions these.
 */
import { defineConfig, devices } from "@playwright/test";

const WEB_BASE = process.env.WEB_BASE ?? "http://localhost:3000";

/** The structural-layout project serves its own production build here. */
const SEARCH_LAYOUT_PORT = 3011;
const SEARCH_LAYOUT_BASE = `http://127.0.0.1:${SEARCH_LAYOUT_PORT}`;

/**
 * The Intake Links structural + presentation gate serves its own production
 * build here. Its OWN port, so it can run beside the search gate without the
 * two sharing a server whose lifetime neither of them owns.
 */
const INTAKE_LAYOUT_PORT = 3012;
const INTAKE_LAYOUT_BASE = `http://127.0.0.1:${INTAKE_LAYOUT_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Phase 1 tests are deliberately small and serial — they share an
  // empty audit DB and we want deterministic ordering for the
  // public-verify privacy spec. CI parallelism can come later when
  // each spec stops creating evidence in the same workspace.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["html", { outputFolder: "playwright-report" }]]
    : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: WEB_BASE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testDir: "./e2e",
      testIgnore: ["point7/**", "search-layout/**"],
      use: { ...devices["Desktop Chrome"] },
    },
    /**
     * PHASE 12 — POINT 7: the product-behaviour browser matrix.
     *
     * Its own project because it needs its own stack (a disposable
     * PostgreSQL 16 + Redis + MinIO on dedicated ports, addressed through
     * `P7_DATABASE_URL`, `WEB_BASE` and `API_BASE`) and its own run
     * identifier — see `e2e/point7/_global-setup.ts`. Kept out of the Phase-1
     * project above via `testIgnore` so the two never share a database.
     *
     * Serial for the same reason the Phase-1 project is: the specs seed
     * overlapping tenant namespaces in one database, and cross-tenant
     * assertions must not race another spec's fixtures.
     */
    {
      name: "point7",
      testDir: "./e2e/point7",
      use: { ...devices["Desktop Chrome"] },
    },
    /**
     * REDESIGN/SEARCH — the STRUCTURAL responsive / RTL gate.
     *
     * Its own project because it needs neither a database nor a worker: every
     * property it measures is a layout property, so the API is intercepted and
     * only the WEB tier is real. What it does need is a real layout engine and
     * the real production bundle — which is why it is a browser project rather
     * than another jsdom render suite. jsdom answers 0 to every geometry
     * question, so a jsdom proof of containment, overflow or stacking is a
     * proof of nothing.
     *
     * Serves the PRODUCTION build (see `webServer` below), because the
     * stylesheet order, the cascade and the class hashing all differ under
     * `next dev`.
     */
    {
      name: "search-layout",
      testDir: "./e2e/search-layout",
      use: {
        ...devices["Desktop Chrome"],
        // Its OWN origin: this project brings its own `next start` on 3011 and
        // must not inherit the Phase-1 stack's WEB_BASE, which points at a
        // server this project never starts.
        baseURL: SEARCH_LAYOUT_BASE,
      },
    },
    /**
     * REDESIGN/INTAKE-LINKS — the STRUCTURAL + PRESENTATION gate.
     *
     * Same reasoning as the search-layout project above: every property it
     * measures is a layout or a COMPUTED-STYLE property, so the API is
     * intercepted and only the WEB tier is real. jsdom answers 0 to every
     * geometry question and resolves no cascade, so a jsdom proof that the
     * redesigned presentation is the one actually painting is a proof of
     * nothing — this project resolves real CSS variables through the real
     * stylesheet order of the production bundle.
     *
     * Deliberately screenshot-free: it answers "is anything broken", never
     * "does it look right".
     */
    {
      name: "intake-links-layout",
      testDir: "./e2e/intake-links-layout",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: INTAKE_LAYOUT_BASE,
      },
    },
  ],
  /**
   * Started only for the two opt-in layout projects, each on its own port.
   *
   * `next start` rather than `next dev`: these gates measure the bundle the
   * product ships. Opt-in via `SEARCH_LAYOUT=1` / `INTAKE_LAYOUT=1` so the
   * Phase-1 and Point-7 projects, which bring their own stacks, never start a
   * second web server on top of the one they already run.
   */
  webServer: [
    ...(process.env.SEARCH_LAYOUT
      ? [
          {
            command: `pnpm --filter proovra-web exec next start -p ${SEARCH_LAYOUT_PORT} -H 127.0.0.1`,
            url: `${SEARCH_LAYOUT_BASE}/login`,
            reuseExistingServer: true,
            timeout: 180_000,
            env: { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
          },
        ]
      : []),
    ...(process.env.INTAKE_LAYOUT
      ? [
          {
            command: `pnpm --filter proovra-web exec next start -p ${INTAKE_LAYOUT_PORT} -H 127.0.0.1`,
            url: `${INTAKE_LAYOUT_BASE}/login`,
            reuseExistingServer: true,
            timeout: 180_000,
            env: { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
          },
        ]
      : []),
  ],
  globalSetup: process.env.POINT7 ? "./e2e/point7/_global-setup.ts" : undefined,
  globalTeardown: process.env.POINT7
    ? "./e2e/point7/_global-teardown.ts"
    : undefined,
});
