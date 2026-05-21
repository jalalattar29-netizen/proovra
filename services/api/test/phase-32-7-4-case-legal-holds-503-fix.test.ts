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

import { readFileSync } from "node:fs";
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

describe("Phase 32.7.4 — CASE_LEGAL_HOLD_SELECT narrowed", () => {
  const SRC = readApi("src/services/governance/case-legal-hold.service.ts");

  it("declares CASE_LEGAL_HOLD_SELECT as a bounded const with `as const`", () => {
    const constIdx = SRC.indexOf("const CASE_LEGAL_HOLD_SELECT");
    expect(constIdx).toBeGreaterThan(-1);
    const block = SRC.slice(constIdx, constIdx + 1500);
    expect(block).toMatch(/as const/);
  });

  it("includes ONLY the 9 columns the projection actually uses", () => {
    const constIdx = SRC.indexOf("const CASE_LEGAL_HOLD_SELECT");
    const block = SRC.slice(constIdx, constIdx + 1500);
    for (const field of [
      "id",
      "teamId",
      "caseId",
      "title",
      "status",
      "placedByUserId",
      "placedAtUtc",
      "releasedByUserId",
      "releasedAtUtc",
    ]) {
      const re = new RegExp(`${field}:\\s*true`);
      expect(block, `CASE_LEGAL_HOLD_SELECT missing ${field}: true`).toMatch(re);
    }
  });

  it("explicitly does NOT include createdAt / updatedAt (most likely missing in production)", () => {
    const constIdx = SRC.indexOf("const CASE_LEGAL_HOLD_SELECT");
    const blockEnd = SRC.indexOf("} as const", constIdx);
    const block = SRC.slice(constIdx, blockEnd);
    expect(block).not.toMatch(/createdAt:\s*true/);
    expect(block).not.toMatch(/updatedAt:\s*true/);
  });

  it("explicitly does NOT include reason / releaseNote (always internal-only by prior contract)", () => {
    const constIdx = SRC.indexOf("const CASE_LEGAL_HOLD_SELECT");
    const blockEnd = SRC.indexOf("} as const", constIdx);
    const block = SRC.slice(constIdx, blockEnd);
    expect(block).not.toMatch(/^\s*reason:\s*true/m);
    expect(block).not.toMatch(/^\s*releaseNote:\s*true/m);
  });
});

// =============================================================================
// Part 3 — projectCaseLegalHold return shape narrowed
// =============================================================================

describe("Phase 32.7.4 — projectCaseLegalHold return shape narrowed", () => {
  const SRC = readApi("src/services/governance/case-legal-hold.service.ts");
  const fnIdx = SRC.indexOf("export function projectCaseLegalHold");
  expect(fnIdx).toBeGreaterThan(-1);
  const fnEnd = SRC.indexOf("\n}\n", fnIdx);
  const fn = SRC.slice(fnIdx, fnEnd);

  it("return-type declaration no longer mentions createdAt / updatedAt", () => {
    // Capture only the return-type literal (between the `: {` after
    // the params and the `} {` that opens the body).
    const typeOpenIdx = fn.indexOf("): {");
    const typeCloseIdx = fn.indexOf("} {", typeOpenIdx);
    expect(typeOpenIdx).toBeGreaterThan(-1);
    expect(typeCloseIdx).toBeGreaterThan(typeOpenIdx);
    const typeBlock = fn.slice(typeOpenIdx, typeCloseIdx);
    expect(typeBlock).not.toMatch(/createdAt:\s*string/);
    expect(typeBlock).not.toMatch(/updatedAt:\s*string/);
  });

  it("return-body no longer assigns createdAt / updatedAt", () => {
    const returnIdx = fn.indexOf("return {");
    const returnEnd = fn.indexOf("};", returnIdx);
    expect(returnIdx).toBeGreaterThan(-1);
    expect(returnEnd).toBeGreaterThan(returnIdx);
    const returnBlock = fn.slice(returnIdx, returnEnd);
    expect(returnBlock).not.toMatch(/createdAt:\s*hold\.createdAt/);
    expect(returnBlock).not.toMatch(/updatedAt:\s*hold\.updatedAt/);
  });

  it("required projection fields (id, teamId, caseId, title, status, placed*, released*) still present", () => {
    const returnIdx = fn.indexOf("return {");
    const returnEnd = fn.indexOf("};", returnIdx);
    const returnBlock = fn.slice(returnIdx, returnEnd);
    for (const field of [
      "id",
      "teamId",
      "caseId",
      "title",
      "status",
      "placedByUserId",
      "placedAtUtc",
      "releasedByUserId",
      "releasedAtUtc",
    ]) {
      const re = new RegExp(`${field}:`);
      expect(returnBlock, `projectCaseLegalHold missing ${field}`).toMatch(re);
    }
  });
});

// =============================================================================
// Part 4 — Symmetry with the working legal-holds endpoint
// =============================================================================

describe("Phase 32.7.4 — case-legal-holds select now mirrors the working legal-holds shape", () => {
  const LEGAL_HOLD_SRC = readApi("src/services/governance.service.ts");
  const CASE_LEGAL_HOLD_SRC = readApi(
    "src/services/governance/case-legal-hold.service.ts",
  );

  it("LEGAL_HOLD_SELECT (the working sibling) also omits createdAt / updatedAt", () => {
    const constIdx = LEGAL_HOLD_SRC.indexOf("const LEGAL_HOLD_SELECT");
    const blockEnd = LEGAL_HOLD_SRC.indexOf("} as const", constIdx);
    const block = LEGAL_HOLD_SRC.slice(constIdx, blockEnd);
    expect(block).not.toMatch(/createdAt:\s*true/);
    expect(block).not.toMatch(/updatedAt:\s*true/);
  });

  it("Both selects now omit the same problem-prone columns (consistent narrowing)", () => {
    const caseConstIdx = CASE_LEGAL_HOLD_SRC.indexOf(
      "const CASE_LEGAL_HOLD_SELECT",
    );
    const caseBlockEnd = CASE_LEGAL_HOLD_SRC.indexOf("} as const", caseConstIdx);
    const caseBlock = CASE_LEGAL_HOLD_SRC.slice(caseConstIdx, caseBlockEnd);
    expect(caseBlock).not.toMatch(/createdAt:\s*true/);
    expect(caseBlock).not.toMatch(/updatedAt:\s*true/);
  });
});

// =============================================================================
// Part 5 — Unrelated governance endpoints + fail-closed contract preserved
// =============================================================================

describe("Phase 32.7.4 — unrelated governance endpoints preserved", () => {
  const ROUTES_SRC = readApi("src/routes/governance.routes.ts");
  const POLICY_SVC = readApi("src/services/governance.service.ts");

  it("legal-holds (working) handler unchanged: still inside runGovernanceHandler with listLegalHoldsForTeam", () => {
    const routeIdx = ROUTES_SRC.indexOf('"/v1/governance/legal-holds"');
    expect(routeIdx).toBeGreaterThan(-1);
    const routeBody = ROUTES_SRC.slice(routeIdx, routeIdx + 2000);
    expect(routeBody).toMatch(/runGovernanceHandler\(reply,/);
    expect(routeBody).toMatch(/listLegalHoldsForTeam/);
  });

  it("LegalHold projection still includes reason + releaseNote (unchanged from 32.7.3)", () => {
    const fnIdx = POLICY_SVC.indexOf("export function projectLegalHold");
    expect(fnIdx).toBeGreaterThan(-1);
    const fn = POLICY_SVC.slice(fnIdx, fnIdx + 1500);
    expect(fn).toMatch(/reason:\s*hold\.reason/);
    expect(fn).toMatch(/releaseNote:\s*hold\.releaseNote/);
  });

  it("case-legal-holds POST place + POST release routes unchanged", () => {
    expect(ROUTES_SRC).toMatch(/placeCaseLegalHold/);
    expect(ROUTES_SRC).toMatch(/releaseCaseLegalHold/);
    // Both still project via projectCaseLegalHold (now with narrower
    // return shape; the call site doesn't care).
    expect(ROUTES_SRC).toMatch(
      /placeCaseLegalHold[\s\S]{0,2000}projectCaseLegalHold/,
    );
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
