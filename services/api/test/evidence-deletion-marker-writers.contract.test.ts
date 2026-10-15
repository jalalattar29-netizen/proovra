/**
 * LEGACY LIFECYCLE RECONCILIATION (2026-10-15) — the canonical transition
 * guard for evidence deletion markers.
 *
 * Production held completed records still ACTIVE while carrying a deletion
 * marker: a delete path that set `deleted_at` without moving the record to
 * Trash. The remedy for the rows is the owner-run reconciliation; the remedy
 * for the CAUSE is that only canonical transitions may write a NON-NULL
 * `Evidence.deletedAt` / `Evidence.deletedAtUtc`:
 *
 *   - the lifecycle service's TRASH patch (writes TRASHED and both markers
 *     together);
 *   - the reservation release (unsealed uploads only — a released
 *     reservation is exactly a deleted, unsealed row);
 *   - the reconciliation tool (moves a legacy row to TRASHED, both markers).
 *
 * A new writer fails here until it is one of those, or is reviewed and added
 * with its reason. (A database trigger was considered and not shipped: the
 * image Production runs today cannot be inspected, so a trigger could not be
 * proven rollout-compatible.)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const ROOTS = ["services/api/src", "services/worker/src", "packages/shared-runtime/src"];

const ALLOWED: Record<string, string> = {
  "services/api/src/services/evidence/evidence-lifecycle.service.ts": "the TRASH patch: TRASHED + both markers, together",
  "packages/shared-runtime/src/evidence-reservation/reservation.ts": "releases UNSEALED reservations only",
  "services/api/src/scripts/three-decisions-backfill.ts": "the owner-run reconciliation: TRASHED + both markers",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mts|mjs|js)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** The argument text of every `<x>.evidence.<write>(` call, by paren matching. */
function evidenceWriteCalls(src: string): string[] {
  const calls: string[] = [];
  const re = /\.evidence\.(update|updateMany|upsert|create|createMany)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    calls.push(src.slice(m.index, i));
  }
  return calls;
}

// A VALUE written (a filter such as `{ not: null }` is not a write).
const NON_NULL_MARKER = /\bdeletedAt(Utc)?\s*:\s*(?!null\b|\{)[^,}\s]/;
const RAW_SQL_MARKER = /UPDATE\s+"?evidence"?\s+SET[^;]*\bdeleted_at(_utc)?"?\s*=\s*(?!NULL\b)/i;

describe("only canonical transitions write an evidence deletion marker", () => {
  it("every non-null deletedAt / deletedAtUtc write on Evidence is a canonical writer", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(join(REPO, root))) {
        const rel = relative(REPO, file).replace(/\\/g, "/");
        const src = readFileSync(file, "utf8");
        const writes = evidenceWriteCalls(src).some((c) => NON_NULL_MARKER.test(c)) || RAW_SQL_MARKER.test(src);
        if (writes && !(rel in ALLOWED)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the allowed writers still exist and still write what they are allowed for", () => {
    for (const rel of Object.keys(ALLOWED)) {
      const src = readFileSync(join(REPO, rel), "utf8");
      expect(src, rel).toMatch(/deletedAt/);
    }
    const lifecycle = readFileSync(join(REPO, "services/api/src/services/evidence/evidence-lifecycle.service.ts"), "utf8");
    // The TRASH patch writes the lifecycle state and BOTH markers together.
    expect(lifecycle).toMatch(/lifecycleState:\s*"TRASHED",\s*deletedAt:\s*now,\s*deletedAtUtc:\s*now,/);
    const reservation = readFileSync(join(REPO, "packages/shared-runtime/src/evidence-reservation/reservation.ts"), "utf8");
    // The release only claims a still-UNSEALED row.
    expect(reservation).toMatch(/where:\s*\{\s*id:\s*evidence\.id,\s*deletedAt:\s*null,\s*status:\s*\{\s*in:\s*UNSEALED\s*\}\s*\}/);
  });
});
