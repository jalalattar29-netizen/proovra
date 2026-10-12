/**
 * A test executes the CURRENT TypeScript source even when a stale compiled
 * `.js` sibling sits beside it — and the repository gate names that sibling.
 *
 * Each fixture lives in the OS temp directory: an importer that uses the
 * NodeNext specifier `./dep.js`, its TypeScript dependency, and a stale
 * `dep.js` that answers differently. Without the resolver the stale file wins.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

import { findCompiledSiblings } from "../../../scripts/check-compiled-source-siblings.mjs";
import { tsSourceFor } from "../../../scripts/vitest-prefer-ts-source.mjs";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fresh fixture: importer.ts -> "./dep.js", the given dep.ts, and a stale dep.js. */
function fixture(tsValue: string | null): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prefer-ts-source-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "importer.ts"), `export { value } from "./dep.js";\n`);
  writeFileSync(path.join(dir, "dep.js"), `export const value = "stale-compiled-js";\n`);
  if (tsValue !== null) writeFileSync(path.join(dir, "dep.ts"), `export const value = "${tsValue}";\n`);
  return dir;
}

async function load(dir: string): Promise<string> {
  vi.resetModules();
  const mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(dir, "importer.ts")).href)) as {
    value: string;
  };
  return mod.value;
}

describe("tests run the TypeScript source, not a compiled sibling", () => {
  it("a .js specifier from a TypeScript importer resolves to the .ts sibling when one exists", () => {
    const dir = fixture("ts-v1");
    expect(tsSourceFor("./dep.js", path.join(dir, "importer.ts"))).toBe(path.join(dir, "dep.ts"));
    // A real JavaScript module with no TypeScript sibling is left alone.
    expect(tsSourceFor("./only.js", path.join(dir, "importer.ts"))).toBeNull();
    // A bare package specifier is never rewritten.
    expect(tsSourceFor("@proovra/shared", path.join(dir, "importer.ts"))).toBeNull();
  });

  it("the executed code is the current TypeScript source, never the stale compiled sibling", async () => {
    expect(await load(fixture("ts-v1"))).toBe("ts-v1");
    expect(await load(fixture("ts-v2"))).toBe("ts-v2");
    // With no TypeScript source the real JavaScript module is what runs.
    expect(await load(fixture(null))).toBe("stale-compiled-js");
  });

  it("the repository gate reports a compiled sibling in a source directory", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "compiled-siblings-"));
    try {
      const src = path.join(root, "services", "worker", "src", "nested");
      mkdirSync(src, { recursive: true });
      writeFileSync(path.join(src, "a.ts"), "export {};\n");
      writeFileSync(path.join(src, "a.js"), "export {};\n");
      writeFileSync(path.join(src, "plain.js"), "export {};\n");
      // Outside a git checkout only siblings are detectable.
      expect(findCompiledSiblings(root, ["services/worker/src"], null)).toEqual([
        path.join("services", "worker", "src", "nested", "a.js"),
      ]);
      // In a checkout, an UNTRACKED .js with no TypeScript source is an old
      // build's orphan; a tracked one is authored code.
      const plain = path.join("services", "worker", "src", "nested", "plain.js");
      expect(findCompiledSiblings(root, ["services/worker/src"], new Set())).toEqual([
        path.join("services", "worker", "src", "nested", "a.js"),
        plain,
      ]);
      expect(findCompiledSiblings(root, ["services/worker/src"], new Set([plain]))).toEqual([
        path.join("services", "worker", "src", "nested", "a.js"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
