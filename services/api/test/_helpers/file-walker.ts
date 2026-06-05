/**
 * Shared filesystem walker for source-contract audit tests.
 *
 * Audit tests recursively walk apps/web/, services/api/src/, etc. to grep for
 * forbidden patterns. Walking heavy generated/vendor directories
 * (node_modules, .next, .turbo, dist, …) blows past the default 5 s Vitest
 * timeout. This helper applies a consistent skip-list so every audit test
 * runs in well under the budget WITHOUT weakening any allow-list or
 * forbidding rule.
 *
 * Directories below are NEVER expected to contain source-contract evidence
 * — they are build outputs, package caches, version-control plumbing, or
 * test artifacts. Skipping them changes the cost of the walk, not the
 * truth of any assertion.
 */

import { readdirSync, statSync } from "node:fs";

/**
 * Directory names skipped during recursive walks.
 *
 * Exported so tests with non-standard requirements can extend the list
 * locally (e.g. `[...SKIP_DIRS, "fixtures"]`) without re-deriving it.
 */
export const SKIP_DIRS: ReadonlyArray<string> = Object.freeze([
  // Package managers & vendor trees
  "node_modules",
  // Next.js
  ".next",
  // Turbo / Nx caches
  ".turbo",
  // Vercel build cache
  ".vercel",
  // Vite cache
  ".vite",
  // Generic JS build outputs
  "dist",
  "build",
  "out",
  // Coverage reports
  "coverage",
  // VCS metadata
  ".git",
  // Misc tool caches
  ".cache",
  // Playwright / e2e artifacts
  "playwright-report",
  "test-results",
]);

const SKIP_SET = new Set(SKIP_DIRS);

export interface ListFilesOptions {
  /**
   * Extensions to include (with leading dot). Defaults to [".ts", ".tsx"].
   * Pass [".tsx"] to restrict to React components only.
   */
  readonly extensions?: ReadonlyArray<string>;

  /**
   * Additional directory names to skip on top of the canonical SKIP_DIRS.
   * Use sparingly — the canonical list already covers every common
   * generated/vendor location.
   */
  readonly extraSkipDirs?: ReadonlyArray<string>;
}

/**
 * Recursive walk that returns every source file under `rootAbs` matching
 * the requested extensions, skipping known heavy directories.
 *
 * - Errors from readdir/stat are swallowed at the per-entry level (matches
 *   the behavior of the previous inline helpers, which used a `try/catch`
 *   block per entry and continued).
 * - Iterative (stack-based) so deep trees do not blow the call stack.
 */
export function listAllFiles(
  rootAbs: string,
  options: ListFilesOptions = {},
): string[] {
  const extensions = options.extensions ?? [".ts", ".tsx"];
  const extra =
    options.extraSkipDirs && options.extraSkipDirs.length > 0
      ? new Set([...SKIP_DIRS, ...options.extraSkipDirs])
      : SKIP_SET;

  const out: string[] = [];
  const stack: string[] = [rootAbs];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      // Skip well-known heavy / generated directories before stat'ing.
      if (extra.has(name)) continue;

      const full = `${dir}/${name}`;
      try {
        const stat = statSync(full);
        if (stat.isFile()) {
          for (const ext of extensions) {
            if (name.endsWith(ext)) {
              out.push(full);
              break;
            }
          }
        } else if (stat.isDirectory()) {
          stack.push(full);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

/**
 * Convenience: list every .ts/.tsx file under `rootAbs`. Equivalent to
 * `listAllFiles(rootAbs)` with the default extension set.
 */
export function listAllTsxFiles(rootAbs: string): string[] {
  return listAllFiles(rootAbs);
}

/**
 * Convenience: list every file under `rootAbs` whose basename matches the
 * provided regex (e.g. `/\.tsx$/`). Preserves the signature of the
 * `phase-cr0-5-recovery-readiness.test.ts` helper.
 */
export function listAllFilesByRegex(
  rootAbs: string,
  extRegex: RegExp,
): string[] {
  const out: string[] = [];
  const stack: string[] = [rootAbs];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (SKIP_SET.has(name)) continue;
      const full = `${dir}/${name}`;
      try {
        const stat = statSync(full);
        if (stat.isFile() && extRegex.test(name)) out.push(full);
        else if (stat.isDirectory()) stack.push(full);
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}
