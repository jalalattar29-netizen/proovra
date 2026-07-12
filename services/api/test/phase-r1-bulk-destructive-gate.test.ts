/**
 * Phase R1 — Bulk destructive-action gate parity (regression).
 *
 * Finding (Global Enterprise Forensic Audit, Critical #1): the bulk
 * endpoint `POST /v1/evidence/bulk` applied only `assertEvidenceNotLocked`
 * + `assertEvidenceDeletionAllowedByRetention` (object-lock retention) to
 * the TRASH and ARCHIVE actions, and did NOT run `runDestructiveActionGate`
 * — the only path that enforces the canonical `EvidenceLegalHold`
 * (Phase 27 / 4A) legal-hold model. Consequence: team-scoped evidence
 * under an active legal hold could be trashed/archived via the bulk path,
 * while the single-record DELETE/archive routes correctly blocked it.
 *
 * These are source-contract assertions (the pattern already used by
 * `phase-x1-architecture-closure.test.ts` for this same gate) so they run
 * without database infrastructure. They pin that the bulk TRASH and
 * ARCHIVE cases invoke the canonical gate with the same SensitiveAction /
 * routeLabel pair as their single-record counterparts, and prevent the
 * bypass from silently regressing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const routesSrc = readSource("../src/routes/evidence.routes.ts");

/** Extract the body of the `POST /v1/evidence/bulk` handler. */
function bulkHandlerRegion(): string {
  const start = routesSrc.indexOf('"/v1/evidence/bulk"');
  expect(start).toBeGreaterThan(-1);
  // End at the next top-level route registration after the bulk handler.
  const rest = routesSrc.slice(start + 1);
  const nextRoute = rest.search(/app\.(get|post|put|patch|delete)\(/);
  const end = nextRoute === -1 ? rest.length : nextRoute;
  return rest.slice(0, end);
}

/** Slice a single `case "X": { ... }` block out of a region. */
function caseBlock(region: string, label: string): string {
  const start = region.indexOf(`case "${label}":`);
  expect(start).toBeGreaterThan(-1);
  const rest = region.slice(start + `case "${label}":`.length);
  const next = rest.search(/\n\s*case "|\n\s*default:/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("Phase R1 — bulk destructive-action gate parity", () => {
  const region = bulkHandlerRegion();

  it("bulk handler imports the canonical destructive-action gate", () => {
    expect(region).toContain("runDestructiveActionGate");
    expect(region).toContain(
      "governance/destructive-action-gate.service.js",
    );
  });

  it("bulk TRASH runs the gate with the delete SensitiveAction", () => {
    const trash = caseBlock(region, "TRASH");
    expect(trash).toContain("runDestructiveActionGate");
    expect(trash).toContain('action: "delete_evidence"');
    expect(trash).toContain('routeLabel: "delete"');
    // The gate must still sit alongside the pre-existing lock/retention asserts.
    expect(trash).toContain("assertEvidenceNotLocked");
    expect(trash).toContain("assertEvidenceDeletionAllowedByRetention");
  });

  it("bulk ARCHIVE runs the gate with the archive SensitiveAction", () => {
    const archive = caseBlock(region, "ARCHIVE");
    expect(archive).toContain("runDestructiveActionGate");
    expect(archive).toContain('action: "archive_evidence"');
    expect(archive).toContain('routeLabel: "archive"');
    expect(archive).toContain("assertEvidenceNotLocked");
  });

  it("a gated bulk record is recorded as a failed row (throws the gate code)", () => {
    // The bulk loop's per-record catch records `error.message` as `reason`;
    // the gate integrates by throwing the decision code on block.
    const trash = caseBlock(region, "TRASH");
    expect(trash).toMatch(/if \(gate\.gated\)\s*\{\s*throw new Error\(gate\.body\.code\)/);
  });
});
