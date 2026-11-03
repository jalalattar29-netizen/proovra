/**
 * MOBILE-010 — the association files are served as JSON. This pins the Next
 * configuration; what a live CDN answers is checked with curl against production.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

// @ts-expect-error -- plain configuration module with no declaration file.
import nextConfig from "../next.config.js";

test("both app-link association files are declared application/json", async () => {
  const rules = await (nextConfig as unknown as { headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> }).headers();
  for (const path of ["/.well-known/apple-app-site-association", "/.well-known/assetlinks.json"]) {
    const rule = rules.find((r) => r.source === path);
    assert.deepEqual(rule?.headers, [{ key: "Content-Type", value: "application/json" }]);
  }
});
