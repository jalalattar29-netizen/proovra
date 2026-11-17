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

// B8-F-401 (Free audit 0ea0, residual pass) — a production web build whose
// route table is ahead of the LIVE API waits for the API.
import { readLiveApiRouteEpoch, readOwnRouteEpoch } from "../../../scripts/vercel-ignore-build.mjs";

const prod = { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" };

test("B8-F-401: production skips only when the live API states a LOWER route epoch", () => {
  const files = ["apps/web/app/page.tsx"];
  const skipped = decide({ env: prod, changedFiles: files, ownRouteEpoch: 2, liveApiRouteEpoch: 1 });
  assert.equal(skipped.build, false, skipped.reason);
  assert.match(skipped.reason, /deploy the API first/);
  assert.equal(decide({ env: prod, changedFiles: files, ownRouteEpoch: 2, liveApiRouteEpoch: 2 }).build, true);
  assert.equal(decide({ env: prod, changedFiles: files, ownRouteEpoch: 2, liveApiRouteEpoch: 3 }).build, true);
  // Unknown on either side builds: uncertainty is never a reason to skip.
  assert.equal(decide({ env: prod, changedFiles: files, ownRouteEpoch: 2, liveApiRouteEpoch: null }).build, true);
  assert.equal(decide({ env: prod, changedFiles: files, ownRouteEpoch: null, liveApiRouteEpoch: 1 }).build, true);
  // Break-glass.
  const forced = { ...prod, PROOVRA_WEB_IGNORE_API_EPOCH: "1" };
  assert.equal(decide({ env: forced, changedFiles: files, ownRouteEpoch: 2, liveApiRouteEpoch: 1 }).build, true);
  // A preview is never gated on the live API.
  assert.equal(decide({ env: preview, changedFiles: files, ownRouteEpoch: 2, liveApiRouteEpoch: 1 }).build, true);
});

test("B8-F-401: the own epoch is read from the committed release contract", () => {
  const src = readFileSync(resolve(REPO, "packages/shared/src/release-contract.ts"), "utf8");
  const own = readOwnRouteEpoch(src);
  assert.ok(Number.isInteger(own) && own >= 1, String(own));
  assert.equal(readOwnRouteEpoch("export const SOMETHING_ELSE = 4;"), null);
});

test("B8-F-401: the live epoch comes from the API's /health header; anything unreadable is null", async () => {
  const seen = [];
  const fake = (epoch) => async (url) => {
    seen.push(url);
    return { headers: new Headers(epoch === undefined ? {} : { "x-proovra-route-epoch": epoch }) };
  };
  const env = { NEXT_PUBLIC_API_BASE: "https://api.example.test/" };
  assert.equal(await readLiveApiRouteEpoch(env, fake("3")), 3);
  assert.equal(seen[0], "https://api.example.test/health");
  assert.equal(await readLiveApiRouteEpoch(env, fake(undefined)), null);
  assert.equal(await readLiveApiRouteEpoch(env, fake("abc")), null);
  assert.equal(await readLiveApiRouteEpoch(env, async () => { throw new Error("offline"); }), null);
  assert.equal(await readLiveApiRouteEpoch({ NEXT_PUBLIC_API_BASE: "http://insecure.test" }, fake("1")), null);
  assert.equal(await readLiveApiRouteEpoch({}, fake("1")), null);
});

test("B8-F-401: without NEXT_PUBLIC_API_BASE the gate asks the web's own default API origin", async () => {
  const { readWebDefaultApiBase } = await import("../../../scripts/vercel-ignore-build.mjs");
  const src = readFileSync(resolve(REPO, "apps/web/lib/api.ts"), "utf8");
  const fallback = readWebDefaultApiBase(src);
  assert.match(String(fallback), /^https:\/\//);
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return { headers: new Headers({ "x-proovra-route-epoch": "1" }) };
  };
  assert.equal(await readLiveApiRouteEpoch({}, fetchImpl, fallback), 1);
  assert.equal(seen[0], `${fallback.replace(/\/+$/, "")}/health`);
  // An explicit configuration wins over the fallback.
  assert.equal(await readLiveApiRouteEpoch({ NEXT_PUBLIC_API_BASE: "https://api.example.test" }, fetchImpl, fallback), 1);
  assert.equal(seen[1], "https://api.example.test/health");
});
