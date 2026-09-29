/**
 * THE ONE CUSTODY SERIALIZATION AUTHORITY — structural resurrection guard.
 *
 * Until 2026-09-29 the custody append (lock, head read, hash, insert) lived in
 * the API, the Worker and the destruction executor. It now lives only in
 * packages/shared-runtime/src/custody/custody-chain.ts; both hosts delegate.
 * This fails, by file, if a second writer appears.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const TREES = ["services/api/src", "services/worker/src", "packages/shared-runtime/src", "packages/shared/src"];
const CANONICAL = "packages/shared-runtime/src/custody/custody-chain.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

export function custodyWriters(files: Array<{ path: string; source: string }>): string[] {
  return files
    .filter((f) => /\bcustodyEvent\.(create|createMany|upsert)\s*\(/.test(strip(f.source)))
    .map((f) => f.path);
}

describe("custody serialization has one authority", () => {
  const files = TREES.flatMap((t) => walk(join(ROOT, t))).map((p) => ({
    path: relative(ROOT, p).replace(/\\/g, "/"),
    source: readFileSync(p, "utf8"),
  }));

  it("exactly one module inserts custody events", () => {
    expect(custodyWriters(files)).toEqual([CANONICAL]);
  });

  it("no module outside the authority computes a custody event hash to insert", () => {
    const hashers = files
      .filter((f) => f.path !== CANONICAL && /buildCustodyEventHash\(\{/.test(strip(f.source)))
      .map((f) => f.path);
    // Readers that RECOMPUTE for display/verification are allowed only through
    // evaluateCustodyChain; nothing else calls the builder.
    expect(hashers).toEqual([]);
  });

  it("negative control: the detector finds a planted second writer", () => {
    expect(
      custodyWriters([
        { path: "x.ts", source: "await tx.custodyEvent.create({ data })" },
        { path: "y.ts", source: "// tx.custodyEvent.create( in a comment\nconst a = 1;" },
      ]),
    ).toEqual(["x.ts"]);
  });
});

describe("the platform audit chain has one append (ET-CUS-05)", () => {
  const files = TREES.flatMap((t) => walk(join(ROOT, t))).map((p) => ({
    path: relative(ROOT, p).replace(/\\/g, "/"),
    source: readFileSync(p, "utf8"),
  }));

  it("exactly one module inserts platform audit rows, and no copy of the chain library exists", () => {
    const writers = files
      .filter((f) => /\badminAuditLog\.(create|createMany|upsert)\s*\(/.test(strip(f.source)))
      .map((f) => f.path);
    expect(writers).toEqual(["packages/shared-runtime/src/audit/admin-audit-chain.ts"]);
    const copies = files.filter((f) => /admin-audit-chain\.ts$/.test(f.path)).map((f) => f.path);
    expect(copies).toEqual(["packages/shared-runtime/src/audit/admin-audit-chain.ts"]);
  });
});
