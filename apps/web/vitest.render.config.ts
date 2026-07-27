import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * PHASE 7 (2026-07-22) — render-level behavioral test harness.
 *
 * SEPARATE from the existing `node:test` suite (scripts/run-tests.mjs,
 * 1800+ source/unit tests) — this config runs ONLY `*.render.test.tsx`
 * files under a jsdom environment so React components + hooks get real
 * render-level behavioral coverage (dirty-switch, stale-response, tenant
 * storage, banner, route healing). No browser, no network.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // PHASE 7 — match Next.js resolution: prefer TS source over the stale
    // compiled `.jsx`/`.js` twins (Phase-12 residue). vite's DEFAULT order
    // resolves `.js`/`.jsx` BEFORE `.ts`/`.tsx`, which would load a stale
    // twin (e.g. PlatformContextProvider.jsx lacks activeWorkspaceId) and
    // silently test dead code. Production (Next) never loads the twins.
    extensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".mts", ".json"],
  },
  test: {
    include: ["__tests__/render/**/*.render.test.tsx"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["__tests__/render/setup.ts"],
    css: false,
  },
});
