/**
 * Phase R8 — Saved-view trust-filter parity (finding F15).
 *
 * The evidence LIST endpoint fully supports filtering by the trust signals
 * `tsaStatus` / `otsStatus` / `verificationDisclosure` / `verificationStatus`
 * (evidence.routes.ts — parsed via inOrEq / parseEvidenceMultiEnumFilter and
 * applied to the Prisma where-clause). But `SavedViewFiltersSchema`
 * (evidence.saved-views.routes.ts) previously omitted them, so Zod SILENTLY
 * STRIPPED them on save — a saved or deep-linked view then returned
 * different results than the filters the user actually applied.
 *
 * This pins that the saved-view schema now persists every trust filter the
 * list endpoint honours, so the two can't drift back out of parity.
 *
 * (2026-10-18) The publication filter `publicVerifyState` was RETIRED with the
 * publication model; its successor is `verificationDisclosure`
 * (VERIFICATION_ONLY | CONTENT_PREVIEW), applied to the record's
 * `verificationDisclosureMode` column. Neither side may keep the old name.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
}

const savedViewsSrc = readApi("routes/evidence.saved-views.routes.ts");
const evidenceRoutesSrc = readApi("routes/evidence.routes.ts");

/** [query/saved-view filter name, the evidence column it is applied to]. */
const TRUST_FILTERS = [
  ["tsaStatus", "tsaStatus"],
  ["otsStatus", "otsStatus"],
  ["verificationDisclosure", "verificationDisclosureMode"],
  ["verificationStatus", "verificationStatus"],
] as const;

function savedViewSchema(): string {
  const start = savedViewsSrc.indexOf("const SavedViewFiltersSchema");
  expect(start).toBeGreaterThan(-1);
  return savedViewsSrc.slice(start, savedViewsSrc.indexOf("});", start));
}

describe("Phase R8 — saved-view trust-filter parity (F15)", () => {
  it("the evidence list endpoint applies each trust filter to its where-clause", () => {
    // Guard the premise: these filters are real on the list side — parsed from
    // the query and applied to the column.
    for (const [filter, column] of TRUST_FILTERS) {
      expect(evidenceRoutesSrc, `list endpoint should parse ${filter}`).toContain(`query.${filter}`);
      expect(
        new RegExp(`\\{ ${column}: \\w+ \\} satisfies Prisma\\.EvidenceWhereInput`).test(evidenceRoutesSrc),
        `list endpoint should filter ${column} by ${filter}`,
      ).toBe(true);
    }
  });

  it("SavedViewFiltersSchema declares every trust filter (no silent strip on save)", () => {
    const schema = savedViewSchema();
    for (const [filter] of TRUST_FILTERS) {
      expect(schema, `SavedViewFiltersSchema must declare ${filter}`).toMatch(
        new RegExp(`\\b${filter}:\\s*z\\.`),
      );
    }
  });

  it("the retired publication filter is gone from both sides", () => {
    expect(savedViewSchema()).not.toMatch(/\bpublicVerifyState:/);
    expect(evidenceRoutesSrc).not.toMatch(/query\.publicVerifyState|\{ publicVerifyState:/);
  });
});
