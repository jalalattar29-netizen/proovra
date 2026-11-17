#!/usr/bin/env node
/**
 * VERCEL — SKIP A PRODUCT BUILD ONLY WHEN NOTHING THE PRODUCT IS BUILT FROM
 * CHANGED.
 *
 * Vercel runs `ignoreCommand` (vercel.json) before every build: exit 0 skips
 * the build, exit 1 builds. Audit and documentation branches — a ledger, a
 * report, a regenerated audit artifact — were each triggering a full product
 * build and preview deployment of an unchanged application.
 *
 * The rule is deliberately narrow, because a skipped build that should have
 * run is a product change nobody previewed:
 *
 *   - Production and `main` ALWAYS build. Production deploys only from main,
 *     and main is never skipped, whatever changed.
 *   - A preview is skipped only when EVERY changed file is documentation or
 *     audit output (NON_PRODUCT_PATHS). One product file builds.
 *   - Anything unreadable builds: no previous SHA in the clone, a failed diff,
 *     an empty change set. Uncertainty is never a reason to skip.
 *
 * B8-F-401 (Free audit 0ea0, residual pass 2026-11-17) — the one exception to
 * "main always builds". The web ships on every push while the API and worker
 * ship by hand later, so a main build whose route table is AHEAD of the live
 * API (this build's PRESENTATION_CONTRACT_ROUTE_EPOCH > the live API's
 * `x-proovra-route-epoch`) would call routes the API does not serve yet. Such
 * a production build is skipped and the current deployment keeps serving; after
 * the API is deployed, redeploy the web (push or Vercel "Redeploy"). The gate
 * skips ONLY on a readable lower epoch: an unreachable API, an absent or
 * malformed header, or an unreadable own epoch all build, and the web's own
 * skew notice (OPS-015 / B8-F-402) covers that case at run time.
 * PROOVRA_WEB_IGNORE_API_EPOCH=1 forces the build (break-glass).
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

export const NON_PRODUCT_PATHS = [
  /^docs\//,
  /^audit-output\//,
  /^\.github\//,
  /^[^/]+\.md$/,
];

/**
 * The decision, from the environment, the list of changed paths (null =
 * unreadable) and, for production/main, the build's own route epoch and the
 * live API's (null = unknown).
 */
export function decide({ env, changedFiles, ownRouteEpoch = null, liveApiRouteEpoch = null }) {
  if (env.VERCEL_ENV === "production" || env.VERCEL_GIT_COMMIT_REF === "main") {
    if (
      env.PROOVRA_WEB_IGNORE_API_EPOCH !== "1" &&
      isEpoch(ownRouteEpoch) &&
      isEpoch(liveApiRouteEpoch) &&
      liveApiRouteEpoch < ownRouteEpoch
    ) {
      return {
        build: false,
        reason: `the live API serves route epoch ${liveApiRouteEpoch} and this build needs ${ownRouteEpoch} — deploy the API first, then redeploy the web`,
      };
    }
    return { build: true, reason: "production and main always build" };
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

function isEpoch(n) {
  return Number.isInteger(n) && n >= 1;
}

/** This checkout's route epoch, read from source (the gate runs before install). */
export function readOwnRouteEpoch(source) {
  const m = /export const PRESENTATION_CONTRACT_ROUTE_EPOCH = (\d+);/.exec(source ?? "");
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

/** The live API's route epoch from its /health response header, or null. */
export async function readLiveApiRouteEpoch(env, fetchImpl = globalThis.fetch, fallbackBase = null) {
  const configured = String(env.NEXT_PUBLIC_API_BASE ?? "").trim();
  const base = (configured || String(fallbackBase ?? "").trim()).replace(/\/+$/, "");
  if (!/^https:\/\//.test(base) || typeof fetchImpl !== "function") return null;
  try {
    const res = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
    const raw = res.headers.get("x-proovra-route-epoch");
    const n = raw === null ? NaN : Number(String(raw).trim());
    return isEpoch(n) ? n : null;
  } catch {
    return null;
  }
}

function readChangedFiles(env) {
  // VERCEL_GIT_PREVIOUS_SHA is the last successful deployment of this branch.
  const base = env.VERCEL_GIT_PREVIOUS_SHA || "HEAD^";
  try {
    return execFileSync("git", ["diff", "--name-only", base, "HEAD"], { encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const productionBuild = env.VERCEL_ENV === "production" || env.VERCEL_GIT_COMMIT_REF === "main";
  let ownRouteEpoch = null;
  let liveApiRouteEpoch = null;
  if (productionBuild) {
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      ownRouteEpoch = readOwnRouteEpoch(
        readFileSync(resolve(here, "..", "packages", "shared", "src", "release-contract.ts"), "utf8"),
      );
    } catch {
      ownRouteEpoch = null;
    }
    let fallbackBase = null;
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      fallbackBase = readWebDefaultApiBase(
        readFileSync(resolve(here, "..", "apps", "web", "lib", "api.ts"), "utf8"),
      );
    } catch {
      fallbackBase = null;
    }
    liveApiRouteEpoch = await readLiveApiRouteEpoch(env, globalThis.fetch, fallbackBase);
    // Written to the Vercel build log, so each deploy records what it compared.
    console.log(
      `vercel-ignore-build: route epoch — build ${ownRouteEpoch ?? "unknown"}, live API ${liveApiRouteEpoch ?? "unknown"}`,
    );
  }
  const d = decide({ env, changedFiles: readChangedFiles(env), ownRouteEpoch, liveApiRouteEpoch });
  console.log(`vercel-ignore-build: ${d.build ? "BUILD" : "SKIP"} — ${d.reason}`);
  process.exit(d.build ? 1 : 0);
}
