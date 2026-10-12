import { defineConfig } from "vitest/config";

import { preferTsSource } from "../../scripts/vitest-prefer-ts-source.mjs";

/**
 * PHASE 12 — POINT 7: the same canonical bootstrap as the API projects.
 *
 * The worker graph reaches Redis, Prisma, the Sentry SDK and the OTLP exporter
 * at module scope, so its test processes need the preload for exactly the same
 * reason the API ones do.
 */
const POINT7_BOOTSTRAP = new URL(
  "../api/test/setup/test-bootstrap.mjs",
  import.meta.url,
).href;
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import ${POINT7_BOOTSTRAP}`]
  .filter(Boolean)
  .join(" ");


export default defineConfig({
  // Tests execute the TypeScript source, never a stale compiled sibling.
  plugins: [preferTsSource()],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
