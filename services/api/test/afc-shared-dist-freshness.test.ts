/**
 * F-14 closure (2026-10-22) — the stale-shared-build guard
 * (scripts/shared-dist-freshness.mjs) catches every way a test run could import
 * compiled shared code that is older than its source, and every test project
 * that imports the shared packages registers it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertSharedDistFresh, staleDistFiles } from "../../../scripts/shared-dist-freshness.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function pkg(files: { src: Record<string, number>; dist?: Record<string, number> }) {
  const root = mkdtempSync(join(tmpdir(), "afc-dist-"));
  dirs.push(root);
  const write = (path: string, mtimeSeconds: number) => {
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, "export {};\n");
    utimesSync(path, mtimeSeconds, mtimeSeconds);
  };
  for (const [name, t] of Object.entries(files.src)) write(join(root, "src", name), t);
  if (files.dist) for (const [name, t] of Object.entries(files.dist)) write(join(root, "dist", name), t);
  return root;
}

describe("the stale shared-build guard", () => {
  it("accepts a build newer than (or as new as) every source", () => {
    expect(staleDistFiles(pkg({ src: { "a.ts": 1000, "sub/b.ts": 1000, "types.d.ts": 5000 }, dist: { "a.js": 1100, "sub/b.js": 1000 } }))).toEqual([]);
  });

  it("refuses a source edited after the last build", () => {
    const out = staleDistFiles(pkg({ src: { "a.ts": 2000 }, dist: { "a.js": 1000 } }));
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toBe("edited after the last build");
  });

  it("refuses a source with no compiled counterpart, and a package never built", () => {
    expect(staleDistFiles(pkg({ src: { "a.ts": 1000, "new.ts": 1000 }, dist: { "a.js": 1100 } }))[0]!.reason).toBe("no compiled counterpart in dist/");
    expect(staleDistFiles(pkg({ src: { "a.ts": 1000 } }))[0]!.reason).toMatch(/dist\/ is missing/);
  });

  it("fails the run with an actionable message", () => {
    const root = mkdtempSync(join(tmpdir(), "afc-dist-root-"));
    dirs.push(root);
    const stalePkg = pkg({ src: { "x.ts": 3000 }, dist: { "x.js": 1000 } });
    expect(() => assertSharedDistFresh(resolve(stalePkg, ".."), [stalePkg.split(/[\\/]/).pop()!])).toThrow(/STALE_SHARED_DIST[\s\S]*pnpm run build:shared/);
  });

  it("is registered by every test project that imports the shared packages", () => {
    for (const config of ["vitest.config.ts", "vitest.integration.config.ts", "../worker/vitest.config.ts"]) {
      expect(readFileSync(resolve(__dirname, "..", config), "utf8"), config).toContain('"../../scripts/shared-dist-freshness.mjs"');
    }
  });
});
