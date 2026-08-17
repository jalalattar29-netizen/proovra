/**
 * AUDIT-002 / AUDIT-003 (2026-08-15) — the API origin is ONE authority, and no
 * browser call may address the API with a relative path.
 *
 * ROOT CAUSE this pins: three call sites issued `fetch("/v1/...")`. In a
 * browser a relative URL resolves against the WEB origin, and `next.config`
 * declares no `/v1` rewrite, so those requests 404'd against Next and never
 * reached the API. Two were the citizen capture flow (session open + capture
 * upload); the third was the SIU export download, which additionally carried no
 * Authorization header. None could ever have succeeded — yet a static consumer
 * scan still counted them as "wired", because the route string was present.
 *
 * AUDIT-003 is the sibling: three further call sites re-derived the API origin
 * inline, each with its own copy of the production default.
 *
 * This guard is deliberately small — it greps the shipped web sources for the
 * two defect SHAPES rather than re-testing the flows, because what regressed
 * was a URL, not a behaviour.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEARCH_DIRS = ["app", "components", "lib", "hooks"];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
  };
  for (const d of SEARCH_DIRS) walk(join(WEB_ROOT, d));
  return out;
}

/**
 * Comments are stripped before matching. The authority module documents the
 * forbidden shape in prose, and a guard that cannot tell an example from a call
 * site reports its own documentation as the defect — which is exactly what this
 * one did on its first run.
 */
function executableSource(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "");
}

const rel = (file: string) => file.slice(WEB_ROOT.length + 1).split("\\").join("/");

test("AUDIT-002 — no source file calls fetch() on a relative /v1 path", () => {
  // Matches fetch("/v1/…"), fetch('/v1/…') and fetch(`/v1/…`), including the
  // form where the URL sits on the following line.
  const relativeV1 = /fetch\(\s*[`"']\/v1\//;
  const offenders = sourceFiles()
    .filter((f) => relativeV1.test(executableSource(f)))
    .map(rel);

  assert.deepEqual(
    offenders,
    [],
    `a relative /v1 fetch resolves against the WEB origin and 404s — use apiFetch or apiBaseUrl(): ${offenders.join(", ")}`,
  );
});

test("AUDIT-003 — only lib/api.ts derives the API base from the environment", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const r = rel(file);
    if (r === "lib/api.ts") continue;
    const src = executableSource(file);
    // Re-deriving the base means reading the env var AND supplying its own
    // fallback origin — that is the duplication, not merely mentioning it.
    if (/NEXT_PUBLIC_API_BASE/.test(src) && /https?:\/\//.test(src)) {
      const line = src
        .split("\n")
        .find((l) => l.includes("NEXT_PUBLIC_API_BASE") && /https?:\/\//.test(l));
      if (line) offenders.push(r);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `read the origin from apiBaseUrl() in lib/api.ts instead of re-deriving it: ${offenders.join(", ")}`,
  );
});
