/**
 * Vercel skips a product build only for documentation/audit-only previews.
 *
 * `scripts/vercel-ignore-build.mjs` is vercel.json's ignoreCommand (exit 0 =
 * skip). A wrong skip is an unpreviewed product change, so every case that is
 * not provably docs-only must build, and production/main must always build.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { decide } from "../../../scripts/vercel-ignore-build.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const preview = { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "audit/ledger" };

test("vercel.json runs the ignore script", () => {
  const cfg = JSON.parse(readFileSync(resolve(REPO, "vercel.json"), "utf8"));
  assert.equal(cfg.ignoreCommand, "node scripts/vercel-ignore-build.mjs");
});

test("production and main always build, even for a docs-only change", () => {
  const docs = ["docs/admin/ledger.md"];
  assert.equal(decide({ env: { VERCEL_ENV: "production" }, changedFiles: docs }).build, true);
  assert.equal(decide({ env: { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "main" }, changedFiles: docs }).build, true);
});

test("a preview whose every change is docs or audit output is skipped", () => {
  const d = decide({
    env: preview,
    changedFiles: ["docs/admin/ledger.md", "audit-output/current/report.md", ".github/workflows/ci.yml", "README.md"],
  });
  assert.equal(d.build, false, d.reason);
});

test("one product file builds, including markdown inside an app", () => {
  for (const product of [
    "apps/web/app/(app)/page.tsx",
    "packages/shared/src/security.ts",
    "apps/web/lib/runbooks/catalog.generated.ts",
    "apps/web/content/notes.md",
    "vercel.json",
  ]) {
    assert.equal(decide({ env: preview, changedFiles: ["docs/a.md", product] }).build, true, product);
  }
});

test("an unreadable or empty change set builds", () => {
  assert.equal(decide({ env: preview, changedFiles: null }).build, true);
  assert.equal(decide({ env: preview, changedFiles: [] }).build, true);
});
