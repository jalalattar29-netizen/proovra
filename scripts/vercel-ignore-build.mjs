#!/usr/bin/env node
/**
 * VERCEL — DECIDE WHETHER A BUILD MAY RUN.
 *
 * Vercel runs `ignoreCommand` (vercel.json) before every build of a project
 * that reads this vercel.json: exit 0 SKIPS the build (the deployment is
 * cancelled and the current production deployment keeps serving), any other
 * exit code BUILDS. An uncaught exception therefore builds — so the production
 * path below catches everything and skips instead.
 *
 * PREVIEWS (any branch but main, VERCEL_ENV != production) — skipped only when
 * EVERY changed file is documentation or audit output (NON_PRODUCT_PATHS);
 * anything unreadable builds. A preview never touches the production domains.
 *
 * PRODUCTION / MAIN — FAIL CLOSED (2026-11-20 release-gate repair, B8-F-401).
 * The web ships from Vercel on every push to main while the API and worker
 * ship by hand on their own host. On 2026-11-19 four remediation pushes put a
 * web build (route epoch 2) live against API cdcb8aef8 (epoch 1): the old gate
 * built whenever the live API's epoch was UNREADABLE, and a route epoch says
 * nothing about new fields, enums or behaviour. A production build now runs
 * only when ALL of these are positively established:
 *
 *   1. the build's own contract version and route epoch are readable;
 *   2. the live API's /health answers 2xx within the timeout, with readable
 *      `x-proovra-contract` and `x-proovra-route-epoch` headers that are not
 *      lower than the build's;
 *   3. the live API states its source `revision`, that commit is present in
 *      this clone, and NOTHING the API and the web share or the API serves
 *      (API_FACING_PATHS) differs between it and the commit being built —
 *      i.e. the web is not ahead of the API in any field, enum, route,
 *      validation rule or behaviour, whatever the epoch says.
 *
 * Anything else — missing configuration, a non-https base, a timeout, a
 * Cloudflare challenge, a 5xx, an absent header, an older epoch or contract,
 * a revision this clone does not have, a failed diff, an exception — SKIPS,
 * and the log line says exactly why.
 *
 *   4. NOT OLDER THAN THE LIVE WEB. When the production web's own
 *      /api/health states a revision and this build's commit is a strict
 *      ancestor of it, the build is stale (a queued or redeployed older
 *      commit) and SKIPS, so it cannot replace a newer live release. When the
 *      live web revision cannot be read or compared, the log says so and this
 *      check alone does not stop the build: compatibility (1-3) still
 *      governs, and an unreadable web must not block every release.
 *
 * THIS GATE IS THE CONTROL (2026-11-20). The blanket vercel.json
 * `git.deploymentEnabled.main: false` hold is gone: every push to main makes a
 * production deployment, which builds exactly when 1-4 hold.
 *
 * WEB RELEASE AFTER A SERVER RELEASE. A main push whose API-facing source the
 * live API does not serve yet is SKIPPED (cancelled; production keeps serving
 * the previous web). Once the API is deployed at that commit or later,
 * .github/workflows/web-release-continuation.yml (closure 3, 2026-11-22) calls
 * the proovra-web Deploy Hook for main's newest commit, after predicting this
 * gate's verdict with this module's own `decide()`. That hook build is an
 * ordinary production build of main (VERCEL_ENV=production,
 * VERCEL_GIT_COMMIT_REF=main, VERCEL_GIT_COMMIT_SHA = the commit built), so it
 * runs every check below unchanged, for the commit it actually builds — no
 * special case exists or is needed. docs/operations/web-release-after-api.md is
 * the runbook.
 *
 * TWO PLACES (2026-11-21). The 5b9fa29e4 production build was made without the
 * gate asking the live API anything (the API logged no /health request during
 * the build). So: an environment with neither VERCEL_ENV nor
 * VERCEL_GIT_COMMIT_REF is treated as production, and vercel.json's
 * buildCommand runs this script with --enforce before `next build`. There a
 * production build the gate would skip exits 1: the build fails, nothing is
 * promoted, and the live web keeps serving. The ignore step saves the build
 * minutes; the build step is the guarantee.
 *
 * ROOT CAUSE, CONFIRMED FROM THE VERCEL BUILD LOG (d7907b1c2, 2026-11-21). The
 * project's Root Directory is apps/web, so Vercel ran `node
 * scripts/vercel-ignore-build.mjs` there: "Cannot find module
 * '/vercel/path0/apps/web/scripts/vercel-ignore-build.mjs'". The ignore step
 * then exited 1, which Vercel reads as BUILD. The gate never ran, and that is
 * how 0376721d9 went live on 2026-11-19 and 5b9fa29e4 built unchecked. Both
 * vercel.json commands now `cd` to the repo root first, and every git call here
 * runs at REPO_ROOT, because the API-facing pathspecs are repo-relative (from
 * apps/web they would match nothing and report "no difference").
 *
 * PROOVRA_WEB_IGNORE_API_EPOCH=1 (a Vercel environment variable, set by the
 * owner for one deliberate release) forces the build: break-glass.
 *
 * The runtime skew notice (apps/web/lib/contract-skew.ts) and the client's own
 * degraded states cover a tab that is open across a release.
 *
 * `docs/` is safe to list because the web app reads nothing under it at build
 * or run time: runbooks reach the product only through the committed,
 * generated `apps/web/lib/runbooks/catalog.generated.ts`, which is a product
 * path.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// git pathspecs (API_FACING_PATHS) are repo-relative; Vercel runs commands from the
// project Root Directory (apps/web), so every git call runs at the repo root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const NON_PRODUCT_PATHS = [
  /^docs\//,
  /^audit-output\//,
  /^\.github\//,
  /^[^/]+\.md$/,
];

/**
 * Source the API serves or shares with the web. A difference here between the
 * live API's revision and the web build means the web may rely on something
 * the live API does not do yet. Locale strings are web-only text.
 */
export const API_FACING_PATHS = [
  "services/api/src",
  "services/api/prisma",
  "services/worker/src",
  "packages/shared/src",
  ":(exclude)packages/shared/src/i18n*",
];

export const LIVE_API_TIMEOUT_MS = 10_000;

function isEpoch(n) {
  return Number.isInteger(n) && n >= 1;
}

function isProduction(env) {
  // 2026-11-21: with neither variable visible the environment is unknown, and an
  // unknown environment is production (fail closed). The 5b9fa29e4 production
  // build made no request to the live API, which only the preview path skips.
  if (!env.VERCEL_ENV && !env.VERCEL_GIT_COMMIT_REF) return true;
  return env.VERCEL_ENV === "production" || env.VERCEL_GIT_COMMIT_REF === "main";
}

export { isProduction };

/**
 * The decision.
 *  - changedFiles: preview change set (null = unreadable).
 *  - own: { contract, routeEpoch } of this build (null fields = unreadable).
 *  - live: { ok, status, contract, routeEpoch, revision, error } from the live
 *    API, or null when it was not asked.
 *  - apiFacingDiff: list of API-facing paths that differ between the live API
 *    revision and this build; null = could not be established.
 */
export function decide({ env, changedFiles, own = null, live = null, apiFacingDiff = null, staleness = null }) {
  if (isProduction(env)) {
    if (env.PROOVRA_WEB_IGNORE_API_EPOCH === "1") {
      return { build: true, reason: "BREAK-GLASS PROOVRA_WEB_IGNORE_API_EPOCH=1: building without the live-API compatibility check" };
    }
    const skip = (why) => ({ build: false, reason: `${why} — deploy the compatible API first, then redeploy the web` });
    if (!own || !isEpoch(own.contract) || !isEpoch(own.routeEpoch)) {
      return skip("this build's own contract version / route epoch could not be read");
    }
    if (!live) return skip("the live API was not asked");
    if (live.error) return skip(`the live API could not be read (${live.error})`);
    if (!live.ok) return skip(`the live API /health answered HTTP ${live.status}`);
    if (!isEpoch(live.contract)) return skip("the live API sent no readable x-proovra-contract header");
    if (!isEpoch(live.routeEpoch)) return skip("the live API sent no readable x-proovra-route-epoch header");
    if (live.contract < own.contract) {
      return skip(`the live API serves contract ${live.contract} and this build needs ${own.contract}`);
    }
    if (live.routeEpoch < own.routeEpoch) {
      return skip(`the live API serves route epoch ${live.routeEpoch} and this build needs ${own.routeEpoch}`);
    }
    if (!/^[0-9a-f]{7,40}$/.test(String(live.revision ?? ""))) {
      return skip("the live API did not state its source revision");
    }
    if (!Array.isArray(apiFacingDiff)) {
      return skip(`the API-facing source of live revision ${live.revision} could not be compared with this build (commit absent from the clone or diff failed)`);
    }
    if (apiFacingDiff.length > 0) {
      return skip(
        `${apiFacingDiff.length} API-facing file(s) differ between the live API (${String(live.revision).slice(0, 9)}) and this build, e.g. ${apiFacingDiff[0]}`,
      );
    }
    if (staleness?.state === "older") {
      return {
        build: false,
        reason: `this build is older than the live web (${String(staleness.liveWebRevision).slice(0, 9)}); a stale deployment must not replace a newer release`,
      };
    }
    const webNote =
      staleness?.state === "current"
        ? `not older than the live web (${String(staleness.liveWebRevision).slice(0, 9)})`
        : `live web revision not compared (${staleness?.why ?? "not asked"})`;
    return {
      build: true,
      reason: `the live API (${String(live.revision).slice(0, 9)}, contract ${live.contract}, epoch ${live.routeEpoch}) serves everything this build relies on; ${webNote}`,
    };
  }
  if (!Array.isArray(changedFiles)) {
    return { build: true, reason: "the change set could not be read" };
  }
  if (changedFiles.length === 0) {
    return { build: true, reason: "no changed files were reported" };
  }
  const product = changedFiles.filter((f) => !NON_PRODUCT_PATHS.some((re) => re.test(f)));
  if (product.length > 0) {
    return { build: true, reason: `${product.length} product file(s) changed, e.g. ${product[0]}` };
  }
  return {
    build: false,
    reason: `${changedFiles.length} changed file(s), all documentation or audit output`,
  };
}

/** This checkout's route epoch, read from source (the gate runs before install). */
export function readOwnRouteEpoch(source) {
  const m = /export const PRESENTATION_CONTRACT_ROUTE_EPOCH = (\d+);/.exec(source ?? "");
  return m ? Number(m[1]) : null;
}

/** This checkout's presentation contract version, read from source. */
export function readOwnContractVersion(source) {
  const m = /export const PRESENTATION_CONTRACT_VERSION = (\d+);/.exec(source ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * The web build's own fallback API origin (apps/web/lib/api.ts
 * DEFAULT_API_BASE), read from source: when NEXT_PUBLIC_API_BASE is not
 * visible to the ignore step, the gate still asks the API the built web calls.
 */
export function readWebDefaultApiBase(source) {
  const m = /const DEFAULT_API_BASE = "([^"]+)";/.exec(source ?? "");
  return m ? m[1] : null;
}

/** AbortSignal.timeout where available (Node >= 17.3), otherwise a controller. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(Object.assign(new Error(`timeout after ${ms} ms`), { name: "TimeoutError" })), ms).unref?.();
  return c.signal;
}

function headerInt(res, name) {
  const raw = res.headers?.get?.(name);
  if (raw === null || raw === undefined) return null;
  const n = Number(String(raw).trim());
  return isEpoch(n) ? n : null;
}

/**
 * What the live API states about itself. Never throws: every failure is
 * returned in `error` (and fails the production gate closed).
 */
export async function readLiveApi(env, fetchImpl = globalThis.fetch, fallbackBase = null) {
  const configured = String(env.NEXT_PUBLIC_API_BASE ?? "").trim();
  const base = (configured || String(fallbackBase ?? "").trim()).replace(/\/+$/, "");
  if (!base) return { error: "no API base: NEXT_PUBLIC_API_BASE is unset and no default was found" };
  if (!/^https:\/\//.test(base)) return { error: `API base ${base} is not https` };
  if (typeof fetchImpl !== "function") return { error: "fetch is unavailable in this Node runtime" };
  const url = `${base}/health`;
  try {
    const res = await fetchImpl(url, {
      signal: timeoutSignal(LIVE_API_TIMEOUT_MS),
      headers: { accept: "application/json", "user-agent": "proovra-vercel-ignore-build" },
    });
    const status = Number(res.status ?? 0);
    const ok = status >= 200 && status < 300;
    let revision = null;
    if (ok && typeof res.json === "function") {
      try {
        const body = await res.json();
        revision = typeof body?.revision === "string" ? body.revision.trim() : null;
      } catch {
        revision = null;
      }
    }
    return {
      url,
      ok,
      status,
      contract: headerInt(res, "x-proovra-contract"),
      routeEpoch: headerInt(res, "x-proovra-route-epoch"),
      revision,
    };
  } catch (e) {
    const name = e && typeof e === "object" && "name" in e ? String(e.name) : "Error";
    return { url, error: name === "TimeoutError" ? `timeout after ${LIVE_API_TIMEOUT_MS} ms` : `${name}: ${String(e?.message ?? e)}` };
  }
}

/** Back-compatible reader for the epoch alone (null = unknown). */
export async function readLiveApiRouteEpoch(env, fetchImpl = globalThis.fetch, fallbackBase = null) {
  const live = await readLiveApi(env, fetchImpl, fallbackBase);
  return live.error || !live.ok ? null : live.routeEpoch;
}

/**
 * API-facing paths that differ between `revision` and HEAD, or null when that
 * cannot be established (the commit is not in this clone, git failed).
 */
export function readApiFacingDiff(
  revision,
  run = (args) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }),
) {
  if (!/^[0-9a-f]{7,40}$/.test(String(revision ?? ""))) return null;
  try {
    run(["cat-file", "-e", `${revision}^{commit}`]);
  } catch {
    try {
      // Vercel clones shallowly; ask for the one commit before giving up.
      run(["fetch", "--quiet", "--depth=1", "origin", revision]);
      run(["cat-file", "-e", `${revision}^{commit}`]);
    } catch {
      return null;
    }
  }
  try {
    return run(["diff", "--name-only", revision, "HEAD", "--", ...API_FACING_PATHS])
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * The production web's own revision, from its /api/health on the project's
 * production domain (Vercel's VERCEL_PROJECT_PRODUCTION_URL). Never throws.
 */
export async function readLiveWebRevision(env, fetchImpl = globalThis.fetch) {
  const host = String(env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!host) return { error: "VERCEL_PROJECT_PRODUCTION_URL is unset" };
  if (typeof fetchImpl !== "function") return { error: "fetch is unavailable in this Node runtime" };
  const url = `https://${host}/api/health`;
  try {
    const res = await fetchImpl(url, {
      signal: timeoutSignal(LIVE_API_TIMEOUT_MS),
      headers: { accept: "application/json", "user-agent": "proovra-vercel-ignore-build" },
    });
    const status = Number(res.status ?? 0);
    if (status < 200 || status >= 300) return { url, error: `HTTP ${status}` };
    const body = await res.json();
    const revision = typeof body?.revision === "string" ? body.revision.trim() : "";
    return /^[0-9a-f]{7,40}$/.test(revision) ? { url, revision } : { url, error: "no revision stated" };
  } catch (e) {
    return { url, error: `${e?.name ?? "Error"}: ${String(e?.message ?? e)}` };
  }
}

/**
 * Whether HEAD is OLDER than the live web: "older" when HEAD is a strict
 * ancestor of the live revision, "current" when it is that revision or not
 * behind it, "unknown" (with why) when that cannot be established.
 */
export function readStaleness(
  liveWeb,
  run = (args) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }),
) {
  if (!liveWeb || liveWeb.error || !liveWeb.revision) {
    return { state: "unknown", why: `live web revision unreadable: ${liveWeb?.error ?? "not asked"}` };
  }
  const rev = liveWeb.revision;
  try {
    const head = run(["rev-parse", "HEAD"]).trim();
    if (head.startsWith(rev) || rev.startsWith(head)) return { state: "current", liveWebRevision: rev };
    try {
      run(["cat-file", "-e", `${rev}^{commit}`]);
    } catch {
      try {
        run(["fetch", "--quiet", "--depth=50", "origin", rev]);
        run(["cat-file", "-e", `${rev}^{commit}`]);
      } catch {
        return { state: "unknown", why: `live web revision ${rev.slice(0, 9)} is not in this clone` };
      }
    }
    try {
      run(["merge-base", "--is-ancestor", "HEAD", rev]);
      return { state: "older", liveWebRevision: rev };
    } catch (e) {
      // Exit 1 is git's "not an ancestor"; anything else (a shallow history) is unknown.
      if (e?.status === 1) return { state: "current", liveWebRevision: rev };
      return { state: "unknown", why: `ancestry of ${rev.slice(0, 9)} could not be established` };
    }
  } catch (e) {
    return { state: "unknown", why: `git failed: ${String(e?.message ?? e).slice(0, 120)}` };
  }
}

function readChangedFiles(env) {
  // VERCEL_GIT_PREVIOUS_SHA is the last successful deployment of this branch.
  const base = env.VERCEL_GIT_PREVIOUS_SHA || "HEAD^";
  try {
    return execFileSync("git", ["diff", "--name-only", base, "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function readRepoFile(...parts) {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(resolve(here, "..", ...parts), "utf8");
  } catch {
    return null;
  }
}

export async function main(env = process.env) {
  if (!isProduction(env)) {
    return decide({ env, changedFiles: readChangedFiles(env) });
  }
  const contractSrc = readRepoFile("packages", "shared", "src", "release-contract.ts");
  const own = { contract: readOwnContractVersion(contractSrc), routeEpoch: readOwnRouteEpoch(contractSrc) };
  const live = await readLiveApi(env, globalThis.fetch, readWebDefaultApiBase(readRepoFile("apps", "web", "lib", "api.ts")));
  const apiFacingDiff = live && !live.error && live.ok && live.revision ? readApiFacingDiff(live.revision) : null;
  const liveWeb = await readLiveWebRevision(env);
  const staleness = readStaleness(liveWeb);
  // Written to the Vercel build log, so each deploy records what it compared.
  console.log(
    `vercel-ignore-build: node ${process.version} VERCEL_ENV=${env.VERCEL_ENV ?? "-"} NEXT_PUBLIC_API_BASE=${env.NEXT_PUBLIC_API_BASE ? "set" : "unset"} ref=${env.VERCEL_GIT_COMMIT_REF ?? "-"} sha=${String(env.VERCEL_GIT_COMMIT_SHA ?? "-").slice(0, 9)} ` +
      `build contract ${own.contract ?? "unknown"} epoch ${own.routeEpoch ?? "unknown"}; ` +
      `live API ${live.url ?? "-"} ${live.error ? `error ${live.error}` : `HTTP ${live.status} contract ${live.contract ?? "unknown"} epoch ${live.routeEpoch ?? "unknown"} revision ${live.revision ?? "unknown"}`}; ` +
      `API-facing diff ${Array.isArray(apiFacingDiff) ? apiFacingDiff.length : "unknown"}; ` +
      `live web ${liveWeb.url ?? "-"} ${liveWeb.error ? `error ${liveWeb.error}` : `revision ${liveWeb.revision}`} -> ${staleness.state}${staleness.why ? ` (${staleness.why})` : ""}`,
  );
  return decide({ env, changedFiles: null, own, live, apiFacingDiff, staleness });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let d;
  try {
    d = await main(process.env);
  } catch (e) {
    // An uncaught error would exit non-zero, which Vercel reads as BUILD.
    d = isProduction(process.env)
      ? { build: false, reason: `the gate failed (${String(e?.message ?? e)}); production fails closed` }
      : { build: true, reason: `the gate failed (${String(e?.message ?? e)}); previews build` };
  }
  if (process.argv.includes("--enforce")) {
    // Build-command mode (vercel.json buildCommand): runs whether or not Vercel
    // ran the ignore step. A production build the gate would skip FAILS here,
    // so it is never promoted and the live web keeps serving. Previews proceed.
    const refuse = isProduction(process.env) && !d.build;
    console.log(`vercel-ignore-build --enforce: ${refuse ? "REFUSED (build fails, nothing is promoted)" : "OK"} — ${d.reason}`);
    process.exit(refuse ? 1 : 0);
  }
  console.log(`vercel-ignore-build: ${d.build ? "BUILD" : "SKIP"} — ${d.reason}`);
  process.exit(d.build ? 1 : 0);
}
