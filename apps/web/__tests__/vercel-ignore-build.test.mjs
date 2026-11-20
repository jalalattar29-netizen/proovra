/**
 * The Vercel ignore gate (scripts/vercel-ignore-build.mjs; exit 0 = SKIP).
 *
 * Previews: skipped only for documentation/audit-only change sets.
 * Production/main: FAIL CLOSED — builds only when the live API positively
 * serves everything the build relies on (2026-11-20 release-gate repair after
 * web 0376721d9 went live against API cdcb8aef8 because an unreadable live
 * epoch used to build).
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  API_FACING_PATHS,
  decide,
  readApiFacingDiff,
  readLiveApi,
  readLiveApiRouteEpoch,
  readOwnContractVersion,
  readOwnRouteEpoch,
  readWebDefaultApiBase,
} from "../../../scripts/vercel-ignore-build.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = resolve(REPO, "scripts", "vercel-ignore-build.mjs");
const preview = { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "audit/ledger" };
const prod = { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" };
const own = { contract: 1, routeEpoch: 2 };
const REV = "0376721d99d2b4083989d658d92c64f6a530edbe";
const liveOk = { ok: true, status: 200, contract: 1, routeEpoch: 2, revision: REV };

test("vercel.json runs the ignore script and holds main deployments", () => {
  const cfg = JSON.parse(readFileSync(resolve(REPO, "vercel.json"), "utf8"));
  assert.equal(cfg.ignoreCommand, "node scripts/vercel-ignore-build.mjs");
  // While a server release is pending, Vercel creates no deployment from main.
  // Lifting this hold is the owner's web-release step (see the rollout handoff).
  assert.equal(cfg.git?.deploymentEnabled?.main, false);
});

test("previews: a docs/audit-only change set is skipped", () => {
  const d = decide({
    env: preview,
    changedFiles: ["docs/admin/ledger.md", "audit-output/current/report.md", ".github/workflows/ci.yml", "README.md"],
  });
  assert.equal(d.build, false, d.reason);
});

test("previews: one product file builds; an unreadable or empty change set builds", () => {
  for (const product of [
    "apps/web/app/(app)/page.tsx",
    "packages/shared/src/security.ts",
    "apps/web/lib/runbooks/catalog.generated.ts",
    "apps/web/content/notes.md",
    "vercel.json",
  ]) {
    assert.equal(decide({ env: preview, changedFiles: ["docs/a.md", product] }).build, true, product);
  }
  assert.equal(decide({ env: preview, changedFiles: null }).build, true);
  assert.equal(decide({ env: preview, changedFiles: [] }).build, true);
  // A preview is never gated on the live API.
  assert.equal(decide({ env: preview, changedFiles: ["apps/web/a.tsx"], own, live: { error: "x" } }).build, true);
});

test("production builds only when the live API serves everything the build relies on", () => {
  const d = decide({ env: prod, changedFiles: null, own, live: liveOk, apiFacingDiff: [] });
  assert.equal(d.build, true, d.reason);
  // main pushed as a preview ref is treated as production too.
  const m = decide({ env: { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "main" }, own, live: { ...liveOk, ok: false, status: 403 }, apiFacingDiff: [] });
  assert.equal(m.build, false, m.reason);
});

test("production FAILS CLOSED on every unknown (the 2026-11-19 failure mode)", () => {
  const cases = {
    "own unreadable": { own: { contract: null, routeEpoch: 2 }, live: liveOk, apiFacingDiff: [] },
    "own epoch unreadable": { own: { contract: 1, routeEpoch: null }, live: liveOk, apiFacingDiff: [] },
    "API not asked": { own, live: null, apiFacingDiff: [] },
    "fetch error / timeout / no config": { own, live: { error: "timeout after 10000 ms" }, apiFacingDiff: [] },
    "Cloudflare 403": { own, live: { ok: false, status: 403, contract: null, routeEpoch: null }, apiFacingDiff: [] },
    "5xx": { own, live: { ok: false, status: 503, contract: 1, routeEpoch: 2, revision: REV }, apiFacingDiff: [] },
    "no contract header": { own, live: { ...liveOk, contract: null }, apiFacingDiff: [] },
    "no epoch header": { own, live: { ...liveOk, routeEpoch: null }, apiFacingDiff: [] },
    "older epoch (cdcb8aef8 vs 0376721d9)": { own, live: { ...liveOk, routeEpoch: 1, revision: "cdcb8aef895736fd57c833ccf71491d456ad9ee3" }, apiFacingDiff: [] },
    "older contract": { own: { contract: 2, routeEpoch: 2 }, live: liveOk, apiFacingDiff: [] },
    "no revision": { own, live: { ...liveOk, revision: null }, apiFacingDiff: [] },
    "revision not comparable": { own, live: liveOk, apiFacingDiff: null },
    "same epoch but API-facing source differs (fields/enums/behaviour)": { own, live: liveOk, apiFacingDiff: ["packages/shared/src/evidence-record-status.ts"] },
  };
  for (const [name, c] of Object.entries(cases)) {
    const d = decide({ env: prod, changedFiles: ["docs/x.md"], ...c });
    assert.equal(d.build, false, `${name}: ${d.reason}`);
    assert.match(d.reason, /deploy the compatible API first/, name);
  }
});

test("production break-glass is explicit", () => {
  const d = decide({ env: { ...prod, PROOVRA_WEB_IGNORE_API_EPOCH: "1" }, own, live: { error: "offline" } });
  assert.equal(d.build, true);
  assert.match(d.reason, /BREAK-GLASS/);
  assert.equal(decide({ env: { ...prod, PROOVRA_WEB_IGNORE_API_EPOCH: "true" }, own, live: { error: "offline" } }).build, false);
});

test("own contract and epoch are read from the committed release contract", () => {
  const src = readFileSync(resolve(REPO, "packages/shared/src/release-contract.ts"), "utf8");
  assert.ok(Number.isInteger(readOwnRouteEpoch(src)) && readOwnRouteEpoch(src) >= 1);
  assert.ok(Number.isInteger(readOwnContractVersion(src)) && readOwnContractVersion(src) >= 1);
  assert.equal(readOwnRouteEpoch("export const SOMETHING_ELSE = 4;"), null);
  assert.equal(readOwnContractVersion(""), null);
});

test("the live API is read from /health: status, both headers, revision; failures carry a reason", async () => {
  const seen = [];
  const fake = ({ status = 200, headers = {}, body = { revision: REV } } = {}) => async (url, init) => {
    seen.push({ url, init });
    return { status, headers: new Headers(headers), json: async () => body };
  };
  const env = { NEXT_PUBLIC_API_BASE: "https://api.example.test/" };
  const ok = await readLiveApi(env, fake({ headers: { "x-proovra-contract": "1", "x-proovra-route-epoch": "2" } }));
  assert.deepEqual({ ok: ok.ok, status: ok.status, contract: ok.contract, routeEpoch: ok.routeEpoch, revision: ok.revision }, { ok: true, status: 200, contract: 1, routeEpoch: 2, revision: REV });
  assert.equal(seen[0].url, "https://api.example.test/health");
  assert.ok(seen[0].init.signal, "a timeout signal is passed");

  const cf = await readLiveApi(env, fake({ status: 403, headers: {}, body: null }));
  assert.equal(cf.ok, false);
  assert.equal(cf.status, 403);
  const malformed = await readLiveApi(env, fake({ headers: { "x-proovra-route-epoch": "abc" } }));
  assert.equal(malformed.routeEpoch, null);
  const thrown = await readLiveApi(env, async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); });
  assert.match(thrown.error, /timeout/);
  assert.match((await readLiveApi({ NEXT_PUBLIC_API_BASE: "http://insecure.test" }, fake())).error, /not https/);
  assert.match((await readLiveApi({}, fake())).error, /no API base/);
  // Back-compatible epoch reader.
  assert.equal(await readLiveApiRouteEpoch(env, fake({ headers: { "x-proovra-route-epoch": "3" } })), 3);
  assert.equal(await readLiveApiRouteEpoch(env, fake({ status: 403, headers: { "x-proovra-route-epoch": "3" } })), null);
});

test("without NEXT_PUBLIC_API_BASE the gate asks the web's own default API origin", async () => {
  const fallback = readWebDefaultApiBase(readFileSync(resolve(REPO, "apps/web/lib/api.ts"), "utf8"));
  assert.match(String(fallback), /^https:\/\//);
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return { status: 200, headers: new Headers({ "x-proovra-route-epoch": "1" }), json: async () => ({}) };
  };
  await readLiveApi({}, fetchImpl, fallback);
  assert.equal(seen[0], `${fallback.replace(/\/+$/, "")}/health`);
  await readLiveApi({ NEXT_PUBLIC_API_BASE: "https://api.example.test" }, fetchImpl, fallback);
  assert.equal(seen[1], "https://api.example.test/health");
});

test("API-facing diff: absent commit or git failure is unknown (null); a listed diff is returned", () => {
  const calls = [];
  const okRun = (args) => { calls.push(args); return args[0] === "diff" ? "packages/shared/src/a.ts\n\n" : ""; };
  assert.deepEqual(readApiFacingDiff(REV, okRun), ["packages/shared/src/a.ts"]);
  const diffCall = calls.find((a) => a[0] === "diff");
  assert.deepEqual(diffCall.slice(0, 4), ["diff", "--name-only", REV, "HEAD"]);
  assert.deepEqual(diffCall.slice(5), API_FACING_PATHS);
  const missing = (args) => { throw new Error(`git ${args[0]} failed`); };
  assert.equal(readApiFacingDiff(REV, missing), null);
  assert.equal(readApiFacingDiff("not-a-sha", okRun), null);
  assert.equal(readApiFacingDiff(null, okRun), null);
});

test("API-facing diff on this repository: the remediation is ahead of cdcb8aef8 in API-facing source", (t) => {
  const has = spawnSync("git", ["cat-file", "-e", "cdcb8aef8^{commit}"], { cwd: REPO });
  if (has.status !== 0) {
    t.skip("cdcb8aef8 is not in this clone (shallow CI checkout)");
    return;
  }
  const run = (args) => {
    const r = spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  const diff = readApiFacingDiff("cdcb8aef8", run);
  assert.ok(Array.isArray(diff) && diff.length > 0);
  assert.ok(!diff.some((f) => /^packages\/shared\/src\/i18n/.test(f)), "locale text is not API-facing");
});

test("the script process: production with an unreachable API exits 0 (SKIP)", () => {
  const run = (env) =>
    spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO,
      encoding: "utf8",
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
      timeout: 60_000,
    });
  // https://127.0.0.1:1 refuses at once: the live API is unreadable.
  const p = run({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main", NEXT_PUBLIC_API_BASE: "https://127.0.0.1:1" });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.match(p.stdout, /SKIP — the live API could not be read/);
  assert.match(p.stdout, /build contract \d+ epoch \d+/);
});
