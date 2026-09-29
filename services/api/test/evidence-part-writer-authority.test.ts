/**
 * ET-UPL-01 structural guard — ONE EvidencePart writer.
 *
 * The audit found three `evidencePart.create` call sites with three guard sets;
 * the unguarded one (the resumable-upload bridge) let a same-team member append
 * bytes to another member's SIGNED record. Every production insert now goes
 * through services/evidence/evidence-part-writer.service.ts. This test fails if
 * any other production source file inserts into evidence_parts, by Prisma or by
 * raw SQL, in the API, the worker or a shared package.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const ROOTS = ["services/api/src", "services/worker/src", "packages/shared/src", "packages/shared-runtime/src"];
const CANONICAL = "services/api/src/services/evidence/evidence-part-writer.service.ts";
const WRITE = /\bevidencePart\s*\.\s*(create|createMany|createManyAndReturn|upsert)\s*\(|INSERT\s+INTO\s+"?evidence_parts"?/i;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.(test|spec)\./.test(name)) yield p;
  }
}

describe("ET-UPL-01 — EvidencePart has exactly one production writer", () => {
  it("no production file other than the canonical writer inserts into evidence_parts", () => {
    const offenders: string[] = [];
    let canonicalWrites = 0;
    for (const root of ROOTS) {
      for (const file of walk(path.join(repo, root))) {
        const rel = path.relative(repo, file).split(path.sep).join("/");
        const src = readFileSync(file, "utf8");
        const hits = src.split("\n").filter((l) => WRITE.test(l) && !/^\s*(\/\/|\*)/.test(l));
        if (rel === CANONICAL) canonicalWrites += hits.length;
        else if (hits.length) offenders.push(`${rel}: ${hits[0]!.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(canonicalWrites).toBe(1);
  });

  it("every former writer now delegates to the canonical authority", () => {
    for (const rel of [
      "services/api/src/routes/evidence.routes.ts",
      "services/api/src/services/external-intake-orchestration.service.ts",
      "services/api/src/services/uploads/upload-session.service.ts",
    ]) {
      expect(readFileSync(path.join(repo, rel), "utf8"), rel).toMatch(/writeEvidencePart\(/);
    }
  });
});
