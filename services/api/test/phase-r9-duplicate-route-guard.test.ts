/**
 * Phase R9 — Duplicate route registration guard.
 *
 * Production crashed at boot with FST_ERR_DUPLICATED_ROUTE:
 *   "Method 'GET' already declared for route '/v1/governance/dashboard'"
 * because the same method/path was registered in two route modules
 * (`trust-and-governance.routes.ts` and `governance-lifecycle.routes.ts`).
 * The fix collapsed both into a single canonical registration with
 * in-handler dispatch on `?teamId=` query shape; both response shapes
 * still ship.
 *
 * This regression test scans every `src/routes/*.routes.ts` file and
 * fails if any (method, path) pair appears in more than one file's
 * Fastify registration calls. Catches the exact class of bug that
 * crashed prod — at unit-test time, no Fastify bootstrap required.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROUTES_DIR = resolve(__dirname, "../src/routes");

function listRouteFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      listRouteFiles(full, acc);
    } else if (stat.isFile() && name.endsWith(".routes.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

// Capture `app.<method>("/path", ...` for every Fastify HTTP method.
// `\s*` includes newlines, so multi-line registrations like
//   app.get(
//     "/v1/governance/dashboard",
//     ...)
// are matched correctly. The path literal may use single or double
// quotes. `app.route({ url, method })` is not used by the .routes.ts
// files we ship.
const METHOD_RE =
  /\bapp\.(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["']/gim;

/**
 * Strip both `//` line-comments and `/* … *\/` block-comments from a
 * source string so we don't count `app.get(...)` patterns that appear
 * inside JSDoc / explanatory comments as real registrations.
 *
 * Conservative: removes comment payload but preserves line breaks and
 * code positions outside the comment ranges. We are NOT a TS parser,
 * but the codebase does not embed `"app.get("` inside string literals,
 * so this is sufficient to eliminate false positives in this test.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    // Block comment
    if (src[i] === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) break;
      // Preserve newlines so line numbers in error messages still align.
      for (let k = i; k < end + 2; k += 1) {
        out += src[k] === "\n" ? "\n" : " ";
      }
      i = end + 2;
      continue;
    }
    // Line comment
    if (src[i] === "/" && src[i + 1] === "/") {
      const eol = src.indexOf("\n", i);
      if (eol === -1) break;
      i = eol;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

describe("Phase R9 — duplicate route registration guard", () => {
  it("no (method, path) pair is registered in more than one route file", () => {
    const files = listRouteFiles(ROUTES_DIR);
    // Map of "METHOD path" → list of file paths that register it.
    const registrations = new Map<string, string[]>();
    for (const file of files) {
      const src = stripComments(readFileSync(file, "utf8"));
      const seenInThisFile = new Set<string>();
      let m: RegExpExecArray | null;
      // Reset lastIndex because METHOD_RE is /g and we re-use it.
      METHOD_RE.lastIndex = 0;
      while ((m = METHOD_RE.exec(src)) !== null) {
        const key = `${m[1]!.toUpperCase()} ${m[2]!}`;
        // Allow a file to register the same key only once even if the
        // regex backtracks; de-dupe at the file level.
        if (seenInThisFile.has(key)) continue;
        seenInThisFile.add(key);
        const list = registrations.get(key) ?? [];
        list.push(file);
        registrations.set(key, list);
      }
    }

    const duplicates: Array<{ key: string; files: string[] }> = [];
    for (const [key, fileList] of registrations) {
      if (fileList.length > 1) {
        duplicates.push({ key, files: fileList });
      }
    }

    const report = duplicates
      .map(
        (d) =>
          `  ${d.key}\n    registered in:\n${d.files
            .map((f) => `      - ${f}`)
            .join("\n")}`,
      )
      .join("\n");

    expect(
      duplicates,
      `Fastify routes registered in more than one .routes.ts file (would crash boot with FST_ERR_DUPLICATED_ROUTE):\n${report}`,
    ).toEqual([]);
  });

  it("GET /v1/governance/dashboard is registered exactly once", () => {
    const files = listRouteFiles(ROUTES_DIR);
    // Scan the WHOLE comment-stripped source (not per-line) so cross-
    // line registrations like:
    //   app.get(
    //     "/v1/governance/dashboard",
    //     ...
    //   )
    // are matched as a single hit. The regex spans whitespace + newlines
    // between `app.get(` and the path literal.
    const re =
      /\bapp\.get\s*\(\s*["']\/v1\/governance\/dashboard["']/g;
    const hits: string[] = [];
    for (const file of files) {
      const src = stripComments(readFileSync(file, "utf8"));
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        hits.push(file);
      }
    }
    expect(
      hits,
      `GET /v1/governance/dashboard must be registered exactly once. Hits:\n${hits
        .map((f) => `  ${f}`)
        .join("\n")}`,
    ).toHaveLength(1);
  });
});
