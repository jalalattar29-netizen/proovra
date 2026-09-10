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
 * `docs/` is safe to list because the web app reads nothing under it at build
 * or run time: runbooks reach the product only through the committed,
 * generated `apps/web/lib/runbooks/catalog.generated.ts`, which is a product
 * path.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NON_PRODUCT_PATHS = [
  /^docs\//,
  /^audit-output\//,
  /^\.github\//,
  /^[^/]+\.md$/,
];

/** The decision, from the environment and the list of changed paths (null = unreadable). */
export function decide({ env, changedFiles }) {
  if (env.VERCEL_ENV === "production" || env.VERCEL_GIT_COMMIT_REF === "main") {
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
  const d = decide({ env: process.env, changedFiles: readChangedFiles(process.env) });
  console.log(`vercel-ignore-build: ${d.build ? "BUILD" : "SKIP"} — ${d.reason}`);
  process.exit(d.build ? 1 : 0);
}
