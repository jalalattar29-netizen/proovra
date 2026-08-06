/**
 * Phase 32.7.4 — `/v1/governance/case-legal-holds` 503 isolated fix.
 *
 * Production state going into this phase:
 *   - Runtime HEALTHY
 *   - /v1/governance/legal-holds → 200
 *   - /v1/governance/policy → 200
 *   - /v1/governance/retention-candidates → 200
 *   - /v1/governance/case-legal-holds → 503 governance_schema_unavailable
 *
 * Root-cause hypothesis (high confidence): the
 * `CASE_LEGAL_HOLD_SELECT` constant in
 * `services/api/src/services/governance/case-legal-hold.service.ts`
 * was the ONLY governance select clause that included `createdAt`
 * and `updatedAt`. The sibling `LEGAL_HOLD_SELECT` constant (used
 * by the working /v1/governance/legal-holds endpoint) does NOT.
 * The user's column inspection of `case_legal_holds` ended with
 * "...released_at_utc, etc." without confirming whether
 * `created_at` / `updated_at` exist in production.
 *
 * Fix (zero SQL, zero schema change):
 *   1. Remove `createdAt: true` / `updatedAt: true` from
 *      `CASE_LEGAL_HOLD_SELECT`.
 *   2. Remove the matching fields from `projectCaseLegalHold`
 *      return type + body. The canonical frontend consumer in
 *      apps/web/app/(app)/governance/page.tsx does NOT use either
 *      field, so the projection narrowing is a no-op there.
 *   3. Add bounded structured server-side logging in
 *      `runGovernanceHandler` so the next 503 (if any) surfaces
 *      the exact Prisma code + missing column/table in server
 *      logs — operators don't have to enable verbose Prisma
 *      tracing to triage.
 *
 * If after deploy the route STILL 503s, the new bounded log line
 * will name the exact missing column from `err.meta.column` /
 * `err.meta.table`. That points operators at a specific Phase
 * 32.7.5 fix.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

// =============================================================================
// Part 1 — runGovernanceHandler structured server-side diagnostic logging
// =============================================================================

describe("Phase 32.7.4 — runGovernanceHandler bounded server-side diagnostic", () => {
  const SRC = readApi("src/routes/_governance-error-bound.ts");

  it("declares the bounded `extractPrismaDiagnostic` helper", () => {
    expect(SRC).toMatch(/function extractPrismaDiagnostic\(err: unknown\)/);
  });

  it("extracts Prisma meta.column / meta.table / meta.modelName via bounded reader", () => {
    // The reader keys are typed via a discriminated union of
    // "column" | "table" | "modelName" literals — confirm all three
    // are referenced.
    expect(SRC).toMatch(/"column"\s*\|\s*"table"\s*\|\s*"modelName"/);
    expect(SRC).toMatch(/readMetaString\(\s*"column"\s*\)/);
    expect(SRC).toMatch(/readMetaString\(\s*"table"\s*\)/);
    expect(SRC).toMatch(/readMetaString\(\s*"modelName"\s*\)/);
    // And meta values are bounded to 120 chars.
    expect(SRC).toMatch(/slice\(0,\s*120\)/);
  });

  it("logs a bounded WARN line with reply.log before sending the 503", () => {
    const catchIdx = SRC.indexOf("if (isPrismaSchemaDriftError(err))");
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBlock = SRC.slice(catchIdx, catchIdx + 4000);
    expect(catchBlock).toMatch(/reply\.log\.warn\(/);
    // WARN happens BEFORE the reply.code(503).send(...) — operators
    // see the diagnostic even if the client closes the connection.
    const warnIdx = catchBlock.indexOf("reply.log.warn(");
    const sendIdx = catchBlock.indexOf("reply.code(503)");
    expect(warnIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(warnIdx);
  });

  it("structured log includes the exact bounded triage fields", () => {
    const warnIdx = SRC.indexOf("reply.log.warn(");
    expect(warnIdx).toBeGreaterThan(-1);
    const logBlock = SRC.slice(warnIdx, warnIdx + 2000);
    for (const field of [
      "event",
      "requestId",
      "method",
      "url",
      "prismaName",
      "prismaCode",
      "missingColumn",
      "missingTable",
      "modelName",
      "message",
    ]) {
      const re = new RegExp(`${field}:`);
      expect(logBlock, `governance.schema_unavailable log missing ${field}`).toMatch(re);
    }
  });

  it("client response body still excludes raw Prisma error (anti-leak preserved)", () => {
    const sendIdx = SRC.indexOf("reply.code(503).send");
    expect(sendIdx).toBeGreaterThan(-1);
    const sendBlock = SRC.slice(sendIdx, sendIdx + 1000);
    // The client-visible body must contain ONLY the bounded
    // canonical code + a generic operator-safe message.
    expect(sendBlock).toMatch(/code:\s*"governance_schema_unavailable"/);
    expect(sendBlock).toMatch(/Governance subsystem is currently degraded/);
    // It must NOT expose any of the diagnostic-only fields.
    expect(sendBlock).not.toMatch(/prismaCode/);
    expect(sendBlock).not.toMatch(/missingColumn/);
    expect(sendBlock).not.toMatch(/missingTable/);
  });

  it("non-schema-drift errors still re-thrown (no regression on fail-closed contract)", () => {
    expect(SRC).toMatch(/throw err/);
  });
});

// =============================================================================
// Part 2 — CASE_LEGAL_HOLD_SELECT no longer requests createdAt/updatedAt
// =============================================================================

// PHASE 12 POINT 3 — Parts 2 and 3 of this file pinned the internals of
// `governance/case-legal-hold.service.ts`: a narrowed CASE_LEGAL_HOLD_SELECT
// and the return shape of `projectCaseLegalHold`. Both existed to work around
// a suspected missing `created_at`/`updated_at` on the `case_legal_holds`
// table. That table is DROPped by 20271108000000_legal_hold_legacy_removal and
// the module is deleted, so the workaround has no subject left to pin. The
// coverage is inverted into a stays-removed guard so neither the module nor
// the table mapping can return unnoticed.
describe("Phase 12 Point 3 — the case-only legal-hold service stays REMOVED", () => {
  it("governance/case-legal-hold.service.ts does not exist", () => {
    expect(
      existsSync(
        fileURLToPath(
          new URL(
            "../src/services/governance/case-legal-hold.service.ts",
            import.meta.url,
          ),
        ),
      ),
    ).toBe(false);
  });

  it("no module re-declares a CASE_LEGAL_HOLD_SELECT or projectCaseLegalHold", () => {
    const canonical = readApi("src/services/governance/legal-hold.service.ts");
    expect(canonical).not.toMatch(/CASE_LEGAL_HOLD_SELECT/);
    expect(canonical).not.toMatch(/projectCaseLegalHold/);
  });

  it("the CASE-scoped response shape still withholds reason / releaseNote", () => {
    const canonical = readApi("src/services/governance/legal-hold.service.ts");
    const idx = canonical.indexOf(
      "export type CaseScopedLegalHoldLegacyShape = {",
    );
    expect(idx).toBeGreaterThan(-1);
    const shape = canonical.slice(idx, canonical.indexOf("};", idx) + 2);
    expect(shape).not.toMatch(/^\s+reason:/m);
    expect(shape).not.toMatch(/releaseNote:/);
  });
});

// =============================================================================
// Part 4 — Symmetry with the working legal-holds endpoint
// =============================================================================

describe("Phase 32.7.4 — case-legal-holds select now mirrors the working legal-holds shape", () => {
  const LEGAL_HOLD_SRC = readApi("src/services/governance.service.ts");

  it("LEGAL_HOLD_SELECT (the working sibling) also omits createdAt / updatedAt", () => {
    const constIdx = LEGAL_HOLD_SRC.indexOf("const LEGAL_HOLD_SELECT");
    const blockEnd = LEGAL_HOLD_SRC.indexOf("} as const", constIdx);
    const block = LEGAL_HOLD_SRC.slice(constIdx, blockEnd);
    expect(block).not.toMatch(/createdAt:\s*true/);
    expect(block).not.toMatch(/updatedAt:\s*true/);
  });

});

// =============================================================================
// Part 5 — Unrelated governance endpoints + fail-closed contract preserved
// =============================================================================

describe("Phase 32.7.4 — unrelated governance endpoints preserved", () => {
  const ROUTES_SRC = readApi("src/routes/governance.routes.ts");
  const POLICY_SVC = readApi("src/services/governance.service.ts");

  it("legal-holds (working) handler keeps its bounded schema-drift wrapper and reads from ONE authority", () => {
    const routeIdx = ROUTES_SRC.indexOf('"/v1/governance/legal-holds"');
    expect(routeIdx).toBeGreaterThan(-1);
    const routeBody = ROUTES_SRC.slice(routeIdx, routeIdx + 2000);
    // The 32.7.4 invariant is the bounded schema-drift wrapper — that a
    // governance schema gap becomes a bounded 503, not a raw Prisma error.
    expect(routeBody).toMatch(/runGovernanceHandler\(reply,/);
    // PHASE 12 POINT 1 / C2 (2026-07-31) — the reader is now the canonical
    // Legal-Hold authority's legacy-shape projection rather than the second
    // `listLegalHoldsForTeam` implementation this pin used to name. Same rows,
    // same response shape, ONE authority. Pinning the reader by name still
    // catches a re-divergence; it just names the surviving one.
    expect(routeBody).toMatch(/listEvidenceScopedLegalHoldsLegacyShape/);
    expect(routeBody).not.toMatch(/listLegalHoldsForTeam/);
  });

  it("LegalHold projection still includes reason + releaseNote (unchanged from 32.7.3)", () => {
    const fnIdx = POLICY_SVC.indexOf("export function projectLegalHold");
    expect(fnIdx).toBeGreaterThan(-1);
    const fn = POLICY_SVC.slice(fnIdx, fnIdx + 1500);
    expect(fn).toMatch(/reason:\s*hold\.reason/);
    expect(fn).toMatch(/releaseNote:\s*hold\.releaseNote/);
  });

  it("case-legal-holds POST place + POST release still exist, now canonical", () => {
    // PHASE 12B CLUSTER 8 — both routes remain REGISTERED but are thin
    // adapters over the ONE canonical Legal-Hold authority, which writes
    // CASE-scoped rows into the canonical table. The response shape is
    // unchanged; only the writer moved.
    expect(ROUTES_SRC).toMatch(/"\/v1\/governance\/case-legal-holds"/);
    expect(ROUTES_SRC).toMatch(/"\/v1\/governance\/case-legal-holds\/:id\/release"/);
    expect(ROUTES_SRC).toMatch(/placeCanonicalLegalHold\(\{[\s\S]{0,200}scope: "CASE"/);
    expect(ROUTES_SRC).toMatch(/releaseLegalHoldAnyStore\(\{/);
    expect(ROUTES_SRC).toMatch(/caseLegalHold:\s*\{/);
  });
});

// =============================================================================
// Part 6 — Schema drift still maps to 503 (not weakened)
// =============================================================================

describe("Phase 32.7.4 — schema drift still maps to 503 (fail-closed preserved)", () => {
  const SRC = readApi("src/routes/_governance-error-bound.ts");

  it("PRISMA_SCHEMA_DRIFT_CODES still catches P2022 / P2021 / P2025", () => {
    expect(SRC).toMatch(/PRISMA_SCHEMA_DRIFT_CODES.*P2022.*P2021.*P2025/s);
  });

  it("isPrismaSchemaDriftError still returns false for non-Prisma errors", () => {
    // The helper only matches when err.code is a string IN the set.
    expect(SRC).toMatch(/if\s*\(\s*typeof code !== "string"\s*\)\s*return\s+false/);
  });
});
