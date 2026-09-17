/**
 * WHAT THE AUDIT ENGINE IS ALLOWED TO SEE: THE FILES GIT TRACKS.
 *
 * The engine walked its candidate roots on disk, so an untracked file —
 * a scratch JSON dropped into `audit-output/current/`, a test file not yet
 * added — became part of the inventory it wrote. Generated locally, the
 * committed artifact then described a tree CI never checks out: local PASS,
 * CI STALE, with nothing in the diff explaining why.
 *
 * Two rules, both here so every reader applies the same ones:
 *
 *   1. The inventory and the freshness hashes read only files in git's index
 *      (tracked or staged). What CI checks out is exactly that set, so the
 *      working tree, a clean tracked-files-only clone and a CI checkout
 *      produce the same output.
 *   2. An untracked file inside an AUTHORITATIVE directory is refused
 *      outright. Those directories hold the facts other gates trust; a file
 *      there that git does not know about is either a forgotten `git add` or
 *      a stray, and in both cases the right answer is to stop, not to guess.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..", "..", "..");

/** Directories whose contents other gates treat as authoritative facts. */
export const AUTHORITATIVE_DIRS = ["audit-output/current", "docs/architecture"];

function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 });
}

let trackedCache = null;

/** Repo-relative, forward-slash paths of every file in git's index. */
export function trackedFileSet() {
  if (trackedCache) return trackedCache;
  const out = git(["ls-files", "-z", "--cached"]);
  trackedCache = new Set(out.split("\0").filter(Boolean));
  return trackedCache;
}

/** Untracked, non-ignored files under the given repo-relative directories. */
export function untrackedUnder(dirs) {
  const out = git(["ls-files", "-z", "--others", "--exclude-standard", "--", ...dirs]);
  return out.split("\0").filter(Boolean).sort();
}

/**
 * Throws when an authoritative directory holds a file git does not track.
 * The message names every file, so the fix is one `git add` or one delete.
 */
export function assertNoUntrackedAuthoritative(dirs = AUTHORITATIVE_DIRS) {
  const strays = untrackedUnder(dirs);
  if (strays.length === 0) return;
  throw new Error(
    `untracked file(s) in an authoritative audit directory (${dirs.join(", ")}):\n` +
      strays.map((f) => `  ${f}`).join("\n") +
      "\nThe audit reads only what git tracks and what CI checks out. " +
      "Add the file(s) if they belong to the release, or remove them.",
  );
}
