/**
 * Phase R1 — bulk/single destructive-gate PARITY (regression).
 *
 * THE ORIGINAL FINDING (Global Enterprise Forensic Audit, Critical #1):
 * `POST /v1/evidence/bulk` applied only `assertEvidenceNotLocked` +
 * `assertEvidenceDeletionAllowedByRetention` to its TRASH and ARCHIVE branches
 * and did NOT run `runDestructiveActionGate` — the only path that enforces the
 * canonical legal-hold model. Team-scoped evidence under an active hold could
 * therefore be trashed in bulk while the single-record route blocked it.
 *
 * WHY THIS SUITE NOW READS DIFFERENTLY (Evidence Lifecycle Convergence,
 * 2026-08-24). The original fix added the gate to the bulk branches — a second
 * copy of the same call, kept in step by review. This suite pinned both copies,
 * which made the duplication permanent: it would have FAILED if anyone removed
 * one, including by unifying them.
 *
 * There is now ONE implementation. `applyEvidenceLifecycleAction` runs the gate,
 * and both the single routes and every bulk lifecycle branch call it. Parity is
 * no longer a property two code paths happen to share — it is the same code.
 *
 * So the assertions moved up a level: the bulk branches must hold NO gate, NO
 * lock assert and NO lifecycle write of their own (any of which would be the
 * bypass returning by a different door), they must dispatch to the canonical
 * service, and the service must run the gate with the same SensitiveAction /
 * routeLabel pair for both actions.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const routesSrc = readSource("../src/routes/evidence.routes.ts");
const serviceSrc = readSource(
  "../src/services/evidence/evidence-lifecycle.service.ts",
);

/** Extract the body of the `POST /v1/evidence/bulk` handler. */
function bulkHandlerRegion(): string {
  const start = routesSrc.indexOf('"/v1/evidence/bulk"');
  expect(start).toBeGreaterThan(-1);
  const rest = routesSrc.slice(start + 1);
  const nextRoute = rest.search(/app\.(get|post|put|patch|delete)\(/);
  const end = nextRoute === -1 ? rest.length : nextRoute;
  return rest.slice(0, end);
}

/** The four lifecycle branches, which now share one body. */
function lifecycleBranchBlock(region: string): string {
  const start = region.indexOf('case "ARCHIVE":');
  expect(start).toBeGreaterThan(-1);
  const rest = region.slice(start);
  const end = rest.indexOf('case "EXPORT_METADATA_CSV"');
  return end === -1 ? rest : rest.slice(0, end);
}

describe("Phase R1 — bulk/single destructive-gate parity", () => {
  const region = bulkHandlerRegion();
  const lifecycleBranches = lifecycleBranchBlock(region);

  it("the four bulk lifecycle actions share ONE branch body", () => {
    // Fall-through case labels with a single body. Four separate blocks is the
    // shape that drifted.
    expect(lifecycleBranches).toMatch(
      /case "ARCHIVE":\s*\n\s*case "RESTORE_ARCHIVED":\s*\n\s*case "TRASH":\s*\n\s*case "RESTORE_TRASH": \{/,
    );
  });

  it("the bulk branches dispatch to the canonical lifecycle service", () => {
    expect(lifecycleBranches).toContain("applyEvidenceLifecycleAction");
    expect(lifecycleBranches).toContain(
      "action: BULK_LIFECYCLE_ACTION[body.action]",
    );
    expect(lifecycleBranches).toContain('source: "bulk"');
  });

  it("the bulk action mapping covers all four, with no default", () => {
    const table = routesSrc.slice(
      routesSrc.indexOf("const BULK_LIFECYCLE_ACTION = {"),
      routesSrc.indexOf("} as const satisfies Record<string, EvidenceLifecycleAction>"),
    );
    expect(table).toContain('ARCHIVE: "ARCHIVE"');
    expect(table).toContain('RESTORE_ARCHIVED: "UNARCHIVE"');
    expect(table).toContain('TRASH: "TRASH"');
    expect(table).toContain('RESTORE_TRASH: "RESTORE_FROM_TRASH"');
  });

  it("the bulk branches hold NO gate, NO lock assert and NO lifecycle write", () => {
    // Any of these reappearing here is the bypass returning by another door:
    // a second decision beside the canonical one, free to disagree with it.
    expect(lifecycleBranches).not.toContain("runDestructiveActionGate");
    expect(lifecycleBranches).not.toContain("assertEvidenceNotLocked");
    expect(lifecycleBranches).not.toContain(
      "assertEvidenceDeletionAllowedByRetention",
    );
    expect(lifecycleBranches).not.toMatch(/prisma\.evidence\.update\(/);
    expect(lifecycleBranches).not.toMatch(/archivedAt:/);
    expect(lifecycleBranches).not.toMatch(/deletedAt:/);
  });

  it("a refused bulk record is recorded as a failed row carrying the canonical code", () => {
    // The bulk loop's per-record catch records `error.message` as `reason`, so
    // the branch integrates by throwing the code the service returned.
    expect(lifecycleBranches).toMatch(
      /if \(!outcome\.ok\) \{\s*throw new Error\(outcome\.code\);/,
    );
  });

  it("the canonical service runs the gate with the delete SensitiveAction for TRASH", () => {
    expect(serviceSrc).toContain("runDestructiveActionGate");
    expect(serviceSrc).toContain('"delete_evidence"');
    expect(serviceSrc).toContain('routeLabel: input.action === "ARCHIVE" ? "archive" : "delete"');
  });

  it("the canonical service runs the gate with the archive SensitiveAction for ARCHIVE", () => {
    expect(serviceSrc).toContain('"archive_evidence"');
    expect(serviceSrc).toMatch(
      /if \(input\.action === "ARCHIVE" \|\| input\.action === "TRASH"\) \{/,
    );
  });

  it("the legal-hold verdict is the union evaluator, fail-closed", () => {
    // The protection the original finding was about. It is resolved ONCE, for
    // single and bulk alike, and a lookup failure refuses the action rather
    // than reporting "no hold".
    expect(serviceSrc).toContain("evaluateEffectiveLegalHold");
    expect(serviceSrc).toMatch(
      /\} catch \{\s*return \{\s*ok: false,\s*statusCode: 503,\s*code: "GOVERNANCE_CHECK_FAILED"/,
    );
  });
});
