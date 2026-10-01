/**
 * THE EVIDENCE RESERVATION AUTHORITY — structural resurrection guard
 * (ET-ACQ-02 / ET-DC-05).
 *
 * The reservation window, the counted-record predicate and the release live
 * only in packages/shared-runtime/src/evidence-reservation/reservation.ts. The
 * API discard and the Worker sweep both release through it; nothing else may
 * redefine the window or hand-roll a release.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const TREES = ["services/api/src", "services/worker/src", "packages/shared-runtime/src", "packages/shared/src"];
const CANONICAL = "packages/shared-runtime/src/evidence-reservation/reservation.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const files = TREES.flatMap((t) => walk(join(ROOT, t))).map((p) => ({
  path: relative(ROOT, p).replace(/\\/g, "/"),
  source: strip(readFileSync(p, "utf8")),
}));

describe("evidence reservation has one authority", () => {
  it("the reservation window and the counted-record predicate are defined once", () => {
    const definers = files
      .filter((f) => /\b(const|function)\s+(EVIDENCE_RESERVATION_TTL_MS|countedEvidenceRecordWhere|allowanceSlotEvidenceWhere|expiredEvidenceReservationWhere)\b/.test(f.source))
      .map((f) => f.path);
    expect(definers).toEqual([CANONICAL]);
  });

  it("the allowance-slot population is the only counted predicate any caller can reach (ET-COM-02)", () => {
    // The reservation half is private to the authority: a caller that could
    // import it would have to add the lifecycle half by hand, and the defect
    // this closes was exactly a hand-written `deletedAt: null` beside it.
    const canonical = files.find((f) => f.path === CANONICAL)!;
    expect(canonical.source).not.toMatch(/export function countedEvidenceRecordWhere\b/);
    expect(canonical.source).toMatch(/export function allowanceSlotEvidenceWhere\b/);
    const outside = files
      .filter((f) => f.path !== CANONICAL && /\bcountedEvidenceRecordWhere\b/.test(f.source))
      .map((f) => f.path);
    expect(outside).toEqual([]);
    // Every consumer composes it under AND; none spreads a population beside
    // it (a spread `AND` key is overwritten — the meter that did so counted
    // every record in the database).
    const spreaders = files
      .filter((f) => /\.\.\.[A-Za-z]+Where,\s*AND:\s*\[allowanceSlotEvidenceWhere\(/.test(f.source))
      .map((f) => f.path);
    expect(spreaders).toEqual([]);
    // …and the settlement cursor is a condition inside that AND, not a spread
    // object with an AND of its own (which dropped the predicate at settlement).
    const enforcement = files.find((f) => f.path === "services/api/src/services/billing-enforcement.service.ts")!;
    expect(enforcement.source).not.toMatch(/\.\.\.createdBeforeEvidence/);
    // UC-COM-001 — the population (with the slot predicate) is ONE base
    // condition, and the settlement cursor is composed beside it inside AND.
    expect(enforcement.source).toMatch(/AND: \[\s*population,\s*allowanceSlotEvidenceWhere\(\),/);
    expect(enforcement.source).toMatch(/AND: \[base, \{ status: \{ in: UNSEALED_STATUSES \} \}, createdBeforeEvidenceCondition\(options\.settling\)\]/);
  });

  it("every releaser goes through releaseEvidenceReservationTx", () => {
    const users = files
      .filter((f) => f.path !== CANONICAL && /releaseEvidenceReservationTx\(/.test(f.source))
      .map((f) => f.path)
      .sort();
    expect(users).toEqual([
      "services/api/src/services/capture-trust/direct-capture-ingest.service.ts",
      // ET-INT-09 — the loser of a concurrent intake session claim releases
      // the record it reserved (reason INTAKE_SESSION_RACE_LOST).
      "services/api/src/services/external-intake-orchestration.service.ts",
      "services/worker/src/capture-reaper.ts",
    ]);
  });

  it("no module writes a reservation-release custody reason outside the authority", () => {
    const hand = files
      .filter((f) => f.path !== CANONICAL && /"(CAPTURE_SESSION_DISCARDED|CAPTURE_SESSION_EXPIRED|RESERVATION_EXPIRED)"/.test(f.source))
      .filter((f) => /EVIDENCE_DELETED/.test(f.source))
      .map((f) => f.path);
    expect(hand).toEqual([]);
  });
});
