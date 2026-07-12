/**
 * Phase R8 — Saved-view trust-filter parity (finding F15).
 *
 * The evidence LIST endpoint fully supports filtering by the trust signals
 * `tsaStatus` / `otsStatus` / `publicVerifyState` / `verificationStatus`
 * (evidence.routes.ts — parsed via inOrEq / parseEvidenceMultiEnumFilter and
 * applied to the Prisma where-clause). But `SavedViewFiltersSchema`
 * (evidence.saved-views.routes.ts) previously omitted them, so Zod SILENTLY
 * STRIPPED them on save — a saved or deep-linked view then returned
 * different results than the filters the user actually applied.
 *
 * This pins that the saved-view schema now persists every trust filter the
 * list endpoint honours, so the two can't drift back out of parity.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
}

const savedViewsSrc = readApi("routes/evidence.saved-views.routes.ts");
const evidenceRoutesSrc = readApi("routes/evidence.routes.ts");

const TRUST_FILTERS = [
  "tsaStatus",
  "otsStatus",
  "publicVerifyState",
  "verificationStatus",
] as const;

describe("Phase R8 — saved-view trust-filter parity (F15)", () => {
  it("the evidence list endpoint applies each trust filter to its where-clause", () => {
    // Guard the premise: these filters are real on the list side.
    for (const f of TRUST_FILTERS) {
      expect(
        new RegExp(`${f}:\\s*${f}Filter`).test(evidenceRoutesSrc) ||
          evidenceRoutesSrc.includes(`{ ${f}:`),
        `list endpoint should filter by ${f}`,
      ).toBe(true);
    }
  });

  it("SavedViewFiltersSchema declares every trust filter (no silent strip on save)", () => {
    const start = savedViewsSrc.indexOf("const SavedViewFiltersSchema");
    expect(start).toBeGreaterThan(-1);
    const schema = savedViewsSrc.slice(start, savedViewsSrc.indexOf("});", start));
    for (const f of TRUST_FILTERS) {
      expect(schema, `SavedViewFiltersSchema must declare ${f}`).toMatch(
        new RegExp(`\\b${f}:\\s*z\\.`),
      );
    }
  });
});
