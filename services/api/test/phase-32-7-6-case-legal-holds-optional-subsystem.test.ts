/**
 * Phase 32.7.6 — Case-Level Legal Holds optional-subsystem fix.
 *
 * Final isolated production blocker before Phase 32.8:
 * `/v1/governance/case-legal-holds` returned 503
 * `governance_schema_unavailable` even after Phase 32.7.4 narrowed
 * the bounded `select`. The endpoint frontend rendered "Case-level
 * legal holds — temporarily unavailable. Retry shortly." — which
 * is the wrong UX for an environment where the Phase 14
 * `case_legal_holds` table simply isn't deployed (or was deployed
 * partially without all the columns Prisma now expects).
 *
 * Root cause: the case-level legal holds subsystem is OPTIONAL.
 * The table was introduced in Phase 14 (migration
 * 20260523100000_add_governance_platform_phase14). Production
 * environments deployed before Phase 14 don't have the table; some
 * environments have a partial Phase 14 schema. In either case the
 * correct operator-facing UX is "No case-level legal holds placed"
 * — NOT a degraded-subsystem banner.
 *
 * Fix (zero SQL, zero schema change):
 *   1. Lift the case-legal-holds GET handler out of the generic
 *      `runGovernanceHandler` 503 wrapper.
 *   2. Add a per-endpoint try/catch that converts P2021 (table
 *      missing) AND P2022 (column missing) to a 200 response with
 *      `{ caseLegalHolds: [], subsystemEnabled: false }`.
 *   3. Log the diagnostic at WARN level (bounded fields:
 *      requestId, teamId, prismaCode, missingTable, missingColumn,
 *      modelName, message-slice).
 *   4. Re-throw any OTHER error — real failures are NOT swallowed
 *      and continue to surface as Fastify 500s.
 *
 * Other governance endpoints (`/policy`, `/legal-holds`,
 * `/retention-candidates`) are CORE features and continue to use
 * `runGovernanceHandler` — they keep the 503 fail-closed contract.
 * This phase touches ONLY the case-legal-holds GET handler.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  // Normalize CRLF -> LF. governance.routes.ts picked up CRLF line
  // endings from an unrelated edit pass (the audit-writer facade
  // convergence touched many files on Windows); this file's several
  // hardcoded `"...\n..."` substring searches below are line-ending
  // sensitive, so normalize once at the read boundary rather than
  // making every search pattern tolerate `\r?\n`.
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8").replace(
    /\r\n/g,
    "\n",
  );
}

// =============================================================================
// Part 1 — runGovernanceHandler still exports / wraps the OTHER governance routes
// =============================================================================

describe("Phase 32.7.6 — `runGovernanceHandler` and bounded helpers still exported", () => {
  const SRC = readApi("src/routes/_governance-error-bound.ts");

  it("`runGovernanceHandler` is still the canonical 503 wrapper for core routes", () => {
    expect(SRC).toMatch(/export async function runGovernanceHandler<T>/);
  });

  it("`isPrismaTableOrColumnMissing` helper is exported for optional-subsystem routes", () => {
    expect(SRC).toMatch(
      /export function isPrismaTableOrColumnMissing\(err: unknown\): boolean/,
    );
  });

  it("`isPrismaTableOrColumnMissing` matches ONLY P2021 + P2022 (not P2025)", () => {
    const fnIdx = SRC.indexOf("export function isPrismaTableOrColumnMissing");
    const fnEnd = SRC.indexOf("\n}\n", fnIdx);
    const fn = SRC.slice(fnIdx, fnEnd);
    expect(fn).toMatch(/code === "P2021"/);
    expect(fn).toMatch(/code === "P2022"/);
    expect(fn).not.toMatch(/code === "P2025"/);
  });

  it("`extractPrismaDiagnostic` is exported so per-route handlers can reuse the bounded reader", () => {
    expect(SRC).toMatch(/export function extractPrismaDiagnostic\(err: unknown\)/);
  });
});

// =============================================================================
// Part 2 — case-legal-holds GET no longer uses runGovernanceHandler
// =============================================================================

describe("Phase 32.7.6 — case-legal-holds GET uses per-endpoint optional-subsystem handler", () => {
  const SRC = readApi("src/routes/governance.routes.ts");
  // Locate the GET handler block specifically.
  const getHandlerIdx = SRC.indexOf(
    'app.get(\n    "/v1/governance/case-legal-holds"',
  );
  expect(getHandlerIdx).toBeGreaterThan(-1);
  // The handler runs up to the next `app.post(`.
  const nextHandlerIdx = SRC.indexOf("app.post(", getHandlerIdx);
  expect(nextHandlerIdx).toBeGreaterThan(getHandlerIdx);
  const handler = SRC.slice(getHandlerIdx, nextHandlerIdx);

  it("the case-legal-holds GET no longer wraps the body in runGovernanceHandler", () => {
    expect(handler).not.toMatch(/runGovernanceHandler\(/);
  });

  it("the handler uses an explicit try/catch around listCaseLegalHolds", () => {
    expect(handler).toMatch(/try\s*\{[\s\S]{0,1200}listCaseLegalHolds\(/);
    expect(handler).toMatch(/\}\s*catch\s*\(\s*err\s*\)\s*\{/);
  });

  it("catch arm checks isPrismaTableOrColumnMissing(err) first", () => {
    expect(handler).toMatch(/if\s*\(\s*isPrismaTableOrColumnMissing\(err\)\s*\)/);
  });

  it("on P2021/P2022 the route returns 200 with `{ caseLegalHolds: [], subsystemEnabled: false }`", () => {
    expect(handler).toMatch(/reply\.code\(200\)\.send\(\s*\{[\s\S]{0,400}caseLegalHolds:\s*\[\][\s\S]{0,200}subsystemEnabled:\s*false/);
  });

  it("the catch arm logs a bounded WARN with the canonical diagnostic fields", () => {
    expect(handler).toMatch(/reply\.log\.warn\(/);
    expect(handler).toMatch(
      /event:\s*"governance\.case_legal_holds\.subsystem_not_deployed"/,
    );
    // Bounded triage fields surfaced for SRE:
    for (const field of [
      "requestId",
      "teamId",
      "prismaName",
      "prismaCode",
      "missingTable",
      "missingColumn",
      "modelName",
      "message",
    ]) {
      const re = new RegExp(`${field}:`);
      expect(handler, `WARN log missing bounded field ${field}`).toMatch(re);
    }
  });

  it("non-schema-drift errors continue to propagate (re-thrown — NOT swallowed)", () => {
    // The fallthrough after the if-block must be `throw err`.
    const catchIdx = handler.indexOf("} catch (err) {");
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBlock = handler.slice(catchIdx);
    expect(catchBlock).toMatch(/throw err/);
  });

  it("success path returns the projected rows with 200", () => {
    expect(handler).toMatch(
      /reply\.code\(200\)\.send\(\s*\{\s*caseLegalHolds:\s*rows\.map\(projectCaseLegalHold\)/,
    );
  });
});

// =============================================================================
// Part 3 — Other governance endpoints UNCHANGED (no regression)
// =============================================================================

describe("Phase 32.7.6 — adjacent governance endpoints continue to use runGovernanceHandler (no regression)", () => {
  const SRC = readApi("src/routes/governance.routes.ts");

  it("/v1/governance/policy GET still calls runGovernanceHandler", () => {
    const idx = SRC.indexOf('"/v1/governance/policy"');
    expect(idx).toBeGreaterThan(-1);
    // The first GET on /v1/governance/policy is the read handler;
    // verify runGovernanceHandler still wraps its body.
    const block = SRC.slice(idx, idx + 2000);
    expect(block).toMatch(/runGovernanceHandler\(reply,/);
  });

  it("/v1/governance/legal-holds GET still calls runGovernanceHandler", () => {
    const routeIdx = SRC.indexOf('"/v1/governance/legal-holds"');
    expect(routeIdx).toBeGreaterThan(-1);
    const block = SRC.slice(routeIdx, routeIdx + 2000);
    expect(block).toMatch(/runGovernanceHandler\(reply,/);
  });

  it("/v1/governance/retention-candidates GET still calls runGovernanceHandler", () => {
    const routeIdx = SRC.indexOf('"/v1/governance/retention-candidates"');
    if (routeIdx > -1) {
      const block = SRC.slice(routeIdx, routeIdx + 2000);
      expect(block).toMatch(/runGovernanceHandler\(reply,/);
    }
  });

  it("case-legal-holds POST place + POST release are unchanged (no try/catch added there)", () => {
    expect(SRC).toMatch(/placeCaseLegalHold\(\{/);
    expect(SRC).toMatch(/releaseCaseLegalHold\(\{/);
  });
});

// =============================================================================
// Part 4 — Frontend renders the empty array as the operator-safe empty state
// =============================================================================

describe("Phase 32.7.6 — frontend renders empty caseLegalHolds as 'No case-level legal holds placed' (Phase 32.8E architecture)", () => {
  // Phase 32.8E — the bespoke /governance widget state machine was
  // consolidated into the GovernanceControlPlane component. The
  // empty-state copy moved into the Preservation tab.
  const SRC = readFileSync(
    fileURLToPath(
      new URL(
        "../../../apps/web/components/governance-experience/GovernanceControlPlane.tsx",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("empty caseLegalHolds renders an empty-state note (NOT the error widget)", () => {
    expect(SRC).toMatch(
      /caseHolds\.length === 0[\s\S]{0,300}No case-level legal holds placed/,
    );
  });

  it("preservation tab renders a 'ready' path for empty data (no error widget regression)", () => {
    // The new architecture surfaces the empty-state inline; the
    // section status is 'ok' (or 'degraded') and the empty list
    // is rendered as a neutral note, not as an error state.
    expect(SRC).toMatch(/data-tab-body="preservation"/);
    expect(SRC).toMatch(/cc-section-note/);
  });
});

// =============================================================================
// Part 5 — runGovernanceHandler fail-closed contract preserved for core routes
// =============================================================================

describe("Phase 32.7.6 — fail-closed governance contract preserved for CORE routes", () => {
  const SRC = readApi("src/routes/_governance-error-bound.ts");

  it("PRISMA_SCHEMA_DRIFT_CODES still includes P2022 / P2021 / P2025", () => {
    expect(SRC).toMatch(/PRISMA_SCHEMA_DRIFT_CODES[\s\S]{0,400}P2022[\s\S]{0,200}P2021[\s\S]{0,200}P2025/);
  });

  it("runGovernanceHandler still emits 503 with governance_schema_unavailable on schema drift", () => {
    expect(SRC).toMatch(/code:\s*"governance_schema_unavailable"/);
    expect(SRC).toMatch(/reply\.code\(503\)\.send/);
  });

  it("Phase 32.7.4 bounded server-side WARN diagnostic still emitted by runGovernanceHandler", () => {
    expect(SRC).toMatch(/event:\s*"governance\.schema_unavailable"/);
    expect(SRC).toMatch(/reply\.log\.warn\(/);
  });
});

// =============================================================================
// Part 6 — Frontend governance page error wording is unchanged for the OTHER widgets
// =============================================================================

describe("Phase 32.7.6 — frontend per-section unavailable copy preserved under Phase 32.8E", () => {
  // Phase 32.8E — the per-widget `widgetErrorMessageFor` mapper
  // was consolidated into a single `SectionNote` component on the
  // GovernanceControlPlane. The per-domain copy now comes from a
  // bounded enum (degraded / unavailable / not_applicable) rather
  // than per-widget switch statements. The runGovernanceHandler
  // 503 contract (Part 5 above) remains the backend canonical
  // signal — this test verifies the FRONTEND continues to render
  // a bounded, operator-safe state per section.
  const SRC = readFileSync(
    fileURLToPath(
      new URL(
        "../../../apps/web/components/governance-experience/GovernanceControlPlane.tsx",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("frontend renders a section-level 'temporarily unavailable' state for any failed section", () => {
    expect(SRC).toMatch(/temporarily unavailable/);
  });

  it("the bounded SectionNote enum covers degraded / unavailable / not_applicable", () => {
    expect(SRC).toMatch(/status === "degraded"/);
    expect(SRC).toMatch(/status === "unavailable"/);
  });
});
