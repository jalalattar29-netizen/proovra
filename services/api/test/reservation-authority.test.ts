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
      .filter((f) => /\b(const|function)\s+(EVIDENCE_RESERVATION_TTL_MS|countedEvidenceRecordWhere|expiredEvidenceReservationWhere)\b/.test(f.source))
      .map((f) => f.path);
    expect(definers).toEqual([CANONICAL]);
  });

  it("both releasers go through releaseEvidenceReservationTx", () => {
    const users = files
      .filter((f) => f.path !== CANONICAL && /releaseEvidenceReservationTx\(/.test(f.source))
      .map((f) => f.path)
      .sort();
    expect(users).toEqual([
      "services/api/src/services/capture-trust/direct-capture-ingest.service.ts",
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
