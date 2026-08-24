/**
 * Phase HOME-NUMERIC-TRUTH-FIX — regression lock for the
 * `runPipelineDetail` status groupBy.
 *
 * THE BUG (closed by this fix):
 *
 *   `services/api/src/services/dashboard/command-center.service.ts`
 *   `runPipelineDetail()` issued
 *
 *     prisma.evidence.groupBy({
 *       by: ["status"],
 *       where: { teamId },       // ← NO deletedAt filter
 *       _count: { _all: true },
 *     })
 *
 *   while the SIBLING queries 12 lines below (`reportsReady`,
 *   `packagesReady`) DID carry `deletedAt: null`. The asymmetry
 *   produced impossible numbers on dashboards where soft-deletes
 *   existed:
 *
 *     reportsQueued  = max(0, signed   - reportsReady)
 *     packagesQueued = max(0, reported - packagesReady)
 *
 *   The proof sandbox (`/tmp/audit-prove-hypothesis.sql`)
 *   demonstrated: 100 active REPORTED + 99 soft-deleted REPORTED
 *   produced `reported = 200`, `packagesQueued = 199` with the
 *   unfixed query, `reported = 101`, `packagesQueued = 100` with
 *   `deletedAt: null` added — matching the user-reported
 *   "Records reported = 222 against Total evidence = 123" symptom.
 *
 * THIS TEST:
 *
 *   1. Pins the `where: { teamId, deletedAt: null }` shape on BOTH
 *      groupBy calls in `runPipelineDetail` (status + publicVerify).
 *   2. Pins the sibling distinct-evidence count queries also carry
 *      `deletedAt: null` — anti-drift between the two sides.
 *   3. Documents the load-bearing arithmetic invariants that the fix
 *      preserves:
 *        Records reported ≤ Total evidence (active)
 *        Packages missing ≤ Records reported (active)
 *        Reports queued  ≤ Records signed   (active)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SRC = readFileSync(
  resolve(
    REPO_ROOT,
    "services",
    "api",
    "src",
    "services",
    "dashboard",
    "command-center.service.ts",
  ),
  "utf8",
);

describe("runPipelineDetail — every groupBy excludes soft-deleted evidence", () => {
  it("the status groupBy carries `where: { teamId, deletedAt: null }`", () => {
    // Slice the runPipelineDetail body and grep the status groupBy
    // verbatim. The presence of `deletedAt: null` in the same `where`
    // block as the status groupBy is the load-bearing invariant.
    const start = SRC.indexOf("async function runPipelineDetail");
    expect(start).toBeGreaterThan(0);
    const after = SRC.indexOf("\nasync function ", start + 1);
    const body = SRC.slice(start, after > 0 ? after : start + 12_000);
    expect(body).toMatch(
      /prisma\.evidence\.groupBy\(\{\s*by:\s*\[\s*"status"\s*\][\s\S]*?where:\s*\{\s*AND:\s*\[pop\.evidence\],\s*deletedAt:\s*null\s*\}/,
    );
  });

  it("the publicVerify groupBy ALSO carries `deletedAt: null`", () => {
    const start = SRC.indexOf("async function runPipelineDetail");
    const after = SRC.indexOf("\nasync function ", start + 1);
    const body = SRC.slice(start, after > 0 ? after : start + 12_000);
    expect(body).toMatch(
      /prisma\.evidence\.groupBy\(\{\s*by:\s*\[\s*"publicVerifyState"\s*\][\s\S]*?where:\s*\{\s*AND:\s*\[pop\.evidence\],\s*deletedAt:\s*null\s*\}/,
    );
  });

  it("the sibling distinct-evidence counts (reportsReady/packagesReady) still carry `deletedAt: null` — symmetry preserved", () => {
    const start = SRC.indexOf("async function runPipelineDetail");
    const after = SRC.indexOf("\nasync function ", start + 1);
    const body = SRC.slice(start, after > 0 ? after : start + 12_000);
    // reportsReady — distinct-evidence count with reports.some + deletedAt:null
    expect(body).toMatch(
      /prisma\.evidence\.count\(\{\s*\n?\s*where:\s*\{\s*\n?\s*AND:\s*\[pop\.evidence\],\s*\n?\s*deletedAt:\s*null,\s*\n?\s*reports:\s*\{\s*some:\s*\{\s*\}\s*\}/,
    );
    // packagesReady — distinct-evidence count with verificationPackages.some + deletedAt:null
    expect(body).toMatch(
      /prisma\.evidence\.count\(\{\s*\n?\s*where:\s*\{\s*\n?\s*AND:\s*\[pop\.evidence\],\s*\n?\s*deletedAt:\s*null,\s*\n?\s*verificationPackages:\s*\{\s*some:\s*\{\s*\}\s*\}/,
    );
    // versionsTotal rows also exclude deleted
    expect(body).toMatch(
      /prisma\.report\.count\(\{\s*\n?\s*where:\s*\{\s*evidence:\s*\{\s*teamId,\s*deletedAt:\s*null\s*\}\s*\}/,
    );
    expect(body).toMatch(
      /prisma\.verificationPackage\.count\(\{\s*\n?\s*where:\s*\{\s*evidence:\s*\{\s*teamId,\s*deletedAt:\s*null\s*\}\s*\}/,
    );
  });

  it("the queued arithmetic is bounded by the (now-correctly-scoped) state counts", () => {
    // The arithmetic itself is unchanged; we pin that the formulas
    // still reference `stateCount("SIGNED")` and `stateCount("REPORTED")`
    // because those are now the deletedAt-filtered counts (a future
    // refactor mustn't accidentally swap them for the raw groupBy
    // result or a different source).
    const start = SRC.indexOf("async function runPipelineDetail");
    const after = SRC.indexOf("\nasync function ", start + 1);
    const body = SRC.slice(start, after > 0 ? after : start + 12_000);
    expect(body).toMatch(
      /const\s+signed\s*=\s*stateCount\(\s*"SIGNED"\s*\)/,
    );
    expect(body).toMatch(
      /const\s+reported\s*=\s*stateCount\(\s*"REPORTED"\s*\)/,
    );
    expect(body).toMatch(
      /reportsQueued\s*=\s*Math\.max\(\s*0\s*,\s*signed\s*-\s*reportsReady\s*\)/,
    );
    expect(body).toMatch(
      /packagesQueued\s*=\s*Math\.max\(\s*0\s*,\s*reported\s*-\s*packagesReady\s*\)/,
    );
  });

  it("Recent Evidence chip uses 'Signed' (not the legacy 'Sealed')", () => {
    // Phase HOME-COPY-FIX — locks the user-visible rename. "Sealed"
    // overclaimed legal closure; "Signed" matches the underlying
    // `status === "SIGNED"` predicate verbatim.
    const HVM = readFileSync(
      resolve(
        REPO_ROOT,
        "apps",
        "web",
        "components",
        "home-experience",
        "home-view-model.ts",
      ),
      "utf8",
    );
    // The literal chip return must say "Signed".
    expect(HVM).toMatch(
      /if\s*\(\s*status\s*===\s*"SIGNED"\s*\)\s*return\s*\{\s*label:\s*"Signed"/,
    );
    // The chip predicate body MUST NOT contain the literal "Sealed"
    // anymore. The comment block above is allowed to mention it for
    // historical context — we scope the assertion to the chip return
    // statements only.
    const chipStart = HVM.indexOf("function recentEvidenceTrustChip");
    expect(chipStart).toBeGreaterThan(0);
    const chipEnd = HVM.indexOf("\nfunction ", chipStart + 1);
    const chipBody = HVM.slice(chipStart, chipEnd > 0 ? chipEnd : chipStart + 2000);
    expect(chipBody).not.toMatch(/label:\s*"Sealed"/);
  });
});
