/**
 * AN ORDINARY TEST RUN LEAVES THE TRACKED TREE EXACTLY AS IT FOUND IT.
 *
 * The integration project used to write its Point-5 proof records straight
 * into `docs/architecture/point5-family-proven-cases.json`. Every run rewrote a
 * tracked file that the unit project's proof gate and the audit engine READ —
 * so a unit run or `audit:architecture --engine-check` running beside an
 * integration run saw a half-written artifact with mixed run ids, and every
 * ordinary run left the checkout dirty.
 *
 * Generated output now goes to a run-scoped path under the git-ignored
 * `.p7tmp/`, and only an explicit regeneration names a tracked path (see
 * `scripts/point5-record-proof.mjs`). This guard is what keeps it that way:
 * it fingerprints every tracked change present when the run starts and FAILS
 * the run if the run itself created or altered one — except the single path an
 * explicit regeneration named in `POINT5_PROOF_OUT`.
 *
 * Registered as a vitest `globalSetup`, so it brackets the whole run in the
 * main process, after every worker has exited.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = resolve(API_ROOT, "../..");

/** Tracked paths that differ from HEAD, each with a fingerprint of its bytes. */
export function trackedChanges(repo = REPO) {
  const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=no", "-z"], {
    cwd: repo,
    encoding: "utf8",
  });
  const changes = new Map();
  for (const entry of out.split("\0").filter(Boolean)) {
    const path = entry.slice(3);
    const abs = resolve(repo, path);
    const digest = existsSync(abs) ? createHash("sha256").update(readFileSync(abs)).digest("hex") : "deleted";
    changes.set(path, `${entry.slice(0, 2)}:${digest}`);
  }
  return changes;
}

/** The changes a run made: new tracked changes, or further edits to ones already present. */
export function changesMadeByRun(before, after, permitted = new Set()) {
  const made = [];
  for (const [path, state] of after) {
    if (permitted.has(path)) continue;
    if (before.get(path) !== state) made.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path) && !permitted.has(path)) made.push(path);
  }
  return made.sort();
}

/** The one tracked path an explicit regeneration may write, repo-relative. */
export function permittedRegenerationPaths(env = process.env) {
  const out = (env.POINT5_PROOF_OUT ?? "").trim();
  if (!out) return new Set();
  return new Set([relative(REPO, resolve(API_ROOT, out)).split("\\").join("/")]);
}

export default function setup() {
  const before = trackedChanges();
  return function teardown() {
    const made = changesMadeByRun(before, trackedChanges(), permittedRegenerationPaths());
    if (made.length > 0) {
      throw new Error(
        `The test run modified tracked files: ${made.join(", ")}. Tests write generated output under ` +
          ".p7tmp/ (git-ignored); a tracked artifact is regenerated only by its explicit command.",
      );
    }
  };
}
