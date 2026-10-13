/**
 * EVERY PRODUCTION CONDITION WRITER RECORDS A MESSAGE CODE.
 *
 * `recordIncident` (API) and `recordWorkerIncident` (worker) accept literal
 * `title` / `safeSummary` only so tests and legacy fixtures keep working. A
 * production call that passed literal English would store a row no client can
 * localize — so this gate reads every call site in both hosts and requires a
 * `message` (a shared-catalogue code) and no literal title or summary.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const HOSTS = ["services/api/src", "services/worker/src"];
const CALL = /\b(recordIncident|recordWorkerIncident)\s*\(/g;

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sourceFiles(p);
    else if (/\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name)) yield p;
  }
}

/** The text between a call's parentheses (string- and template-aware enough for these sites). */
function callArguments(src: string, openParen: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParen; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return src.slice(openParen + 1, i);
  }
  return src.slice(openParen + 1);
}

type Site = { file: string; line: number; args: string };

function productionCallSites(): Site[] {
  const sites: Site[] = [];
  for (const host of HOSTS) {
    for (const file of sourceFiles(join(ROOT, host))) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(CALL)) {
        const at = m.index!;
        const before = src.slice(Math.max(0, at - 40), at);
        const lineStart = src.lastIndexOf("\n", at) + 1;
        // The definitions themselves, and comment lines that mention the name.
        if (/function\s+$/.test(before) || /^\s*(\*|\/\/|\/\*)/.test(src.slice(lineStart, at))) continue;
        const args = callArguments(src, at + m[0].length - 1);
        // The worker's own compare-and-set retry re-sends its input unchanged.
        if (/__casRetry/.test(args)) continue;
        sites.push({ file: relative(ROOT, file).replace(/\\/g, "/"), line: src.slice(0, at).split("\n").length, args });
      }
    }
  }
  return sites;
}

describe("every production condition writer records a semantic message code", () => {
  const sites = productionCallSites();

  it("finds the writers in both hosts (the scan is not vacuous)", () => {
    expect(sites.filter((s) => s.file.startsWith("services/api/")).length).toBeGreaterThanOrEqual(15);
    expect(sites.filter((s) => s.file.startsWith("services/worker/")).length).toBeGreaterThanOrEqual(7);
  });

  it("each passes `message` and no literal title or summary", () => {
    const offenders = sites
      .filter((s) => !/\bmessage\b/.test(s.args) || /^\s*(title|safeSummary)\s*:/m.test(s.args))
      .map((s) => `${s.file}:${s.line}`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("every code a writer names exists in the catalogue", async () => {
    const { isConditionMessageCode } = await import("@proovra/shared");
    const named = new Set<string>();
    for (const host of HOSTS) {
      for (const file of sourceFiles(join(ROOT, host))) {
        for (const m of readFileSync(file, "utf8").matchAll(/code:\s*"(ops\.[a-z0-9_.]+)"/g)) named.add(m[1]!);
      }
    }
    expect(named.size).toBeGreaterThan(20);
    expect([...named].filter((c) => !isConditionMessageCode(c))).toEqual([]);
  });
});
