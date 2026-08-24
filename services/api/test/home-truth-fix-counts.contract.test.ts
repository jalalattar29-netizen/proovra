/**
 * Phase HOME-TRUTH-FIX — backend counts must be operationally truthful.
 *
 * This file locks the SHAPE of the dashboard projections that the
 * Home headline KPIs read from. Without these locks a future refactor
 * could silently reintroduce the bug that prompted the audit: Trust
 * Ready reading 100% while every record is missing both a Report and
 * a Verification Package (the puppeteer __name failure mode).
 *
 * What this file pins:
 *
 *  1. `TrustSummary` now exposes `endToEndReady`,
 *     `signedWithoutReport`, `reportedWithoutPackage`. The headline
 *     "End-to-end ready" KPI reads `endToEndReady`, not `signed`.
 *
 *  2. The `endToEndReady` predicate requires status=REPORTED AND a
 *     Report row AND a VerificationPackage row AND not-SUSPENDED.
 *     It MUST NOT degrade to just a signature presence check.
 *
 *  3. `pipelineDetail.reports.ready` / `packages.ready` are now
 *     EVIDENCE-DISTINCT counts (one evidence with v1/v2/v3 contributes
 *     once), with soft-deleted evidence excluded. The raw
 *     report/package row count is preserved under `versionsTotal` for
 *     surfaces that explicitly want it.
 *
 *  4. `OperationalPressureItem.category` includes the new
 *     `tsa_failed` / `ots_failed` categories so the timestamp
 *     providers escalate into the Operational Queue rather than
 *     living only in the Trust State row counts.
 *
 *  5. The org-health projection now scopes the "pending report" /
 *     "pending package" counts by `status` so pre-SIGNED evidence
 *     (CREATED / UPLOADING / failed-hash-mismatch) is NOT treated
 *     as "missing a report".
 *
 * These are file-level grep contracts — the canonical behavior is
 * also exercised by the DB-backed `trust-summary.service.ts` and
 * `command-center.service.ts` integration tests that already run
 * against the real workspace; this file guards the shape so the
 * integration tests can stay focused on the values.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const TRUST_SUMMARY = readFileSync(
  resolve(
    REPO_ROOT,
    "services",
    "api",
    "src",
    "services",
    "dashboard",
    "trust-summary.service.ts",
  ),
  "utf8",
);
const COMMAND_CENTER = readFileSync(
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
const REFRESH_PROJ = readFileSync(
  resolve(
    REPO_ROOT,
    // WORKSPACE-SCOPE CONVERGENCE — the org-health projection moved into
    // `@proovra/shared-runtime`. It existed twice, in the API and the Worker,
    // and the two computed different pending-report counts because only one
    // carried the pipeline-status filter this file exists to pin.
    "packages",
    "shared-runtime",
    "src",
    "org-health-projection.ts",
  ),
  "utf8",
);

describe("HOME-TRUTH-FIX — TrustSummary exposes operationally-truthful counts", () => {
  it("exports endToEndReady / signedWithoutReport / reportedWithoutPackage in the TrustSummary type", () => {
    expect(TRUST_SUMMARY).toMatch(/endToEndReady:\s*number/);
    expect(TRUST_SUMMARY).toMatch(/signedWithoutReport:\s*number/);
    expect(TRUST_SUMMARY).toMatch(/reportedWithoutPackage:\s*number/);
  });

  it("endToEndReady query requires status=REPORTED AND has Report AND has Package AND not-SUSPENDED", () => {
    // The unique comment marker that immediately precedes the actual
    // count() call body (the phrase "End-to-end ready" alone also
    // appears in the function's leading docstring — we need the
    // one tied to the query).
    const anchor = "End-to-end ready — every link in the deliverable chain";
    const endToEndStart = TRUST_SUMMARY.indexOf(anchor);
    expect(endToEndStart).toBeGreaterThan(0);
    const tail = TRUST_SUMMARY.slice(endToEndStart, endToEndStart + 1200);
    expect(tail).toMatch(/status:\s*"REPORTED"/);
    expect(tail).toMatch(/reports:\s*\{\s*some:\s*\{\s*\}\s*\}/);
    expect(tail).toMatch(/verificationPackages:\s*\{\s*some:\s*\{\s*\}\s*\}/);
    expect(tail).toMatch(/publicVerifyState:\s*"SUSPENDED"/);
  });

  it("signedWithoutReport requires status=SIGNED AND no Report row", () => {
    const start = TRUST_SUMMARY.indexOf("Stuck-SIGNED");
    expect(start).toBeGreaterThan(0);
    const tail = TRUST_SUMMARY.slice(start, start + 400);
    expect(tail).toMatch(/status:\s*"SIGNED"/);
    expect(tail).toMatch(/reports:\s*\{\s*none:\s*\{\s*\}\s*\}/);
  });

  it("reportedWithoutPackage requires status=REPORTED AND no Package row", () => {
    const start = TRUST_SUMMARY.indexOf("Stuck-REPORTED");
    expect(start).toBeGreaterThan(0);
    const tail = TRUST_SUMMARY.slice(start, start + 400);
    expect(tail).toMatch(/status:\s*"REPORTED"/);
    expect(tail).toMatch(/verificationPackages:\s*\{\s*none:\s*\{\s*\}\s*\}/);
  });

  it("`signed` is kept on the response (documented as NOT a readiness signal)", () => {
    expect(TRUST_SUMMARY).toMatch(/signed:\s*number/);
    expect(TRUST_SUMMARY).toMatch(/NOT a\s+\*?\s*"ready"/);
  });
});

describe("HOME-TRUTH-FIX — Reports/Packages KPI uses evidence-distinct counts", () => {
  it("reportsReady counts EVIDENCE records (with at least one Report), not Report rows", () => {
    // The new query: prisma.evidence.count({ where: { teamId, deletedAt: null, reports: { some: {} } } })
    expect(COMMAND_CENTER).toMatch(
      /prisma\.evidence\.count\(\{\s*\n?\s*where:\s*\{\s*\n?\s*AND:\s*\[pop\.evidence\],\s*\n?\s*deletedAt:\s*null,\s*\n?\s*reports:\s*\{\s*some:\s*\{\s*\}\s*\}/,
    );
  });

  it("packagesReady counts EVIDENCE records (with at least one VerificationPackage), not Package rows", () => {
    expect(COMMAND_CENTER).toMatch(
      /prisma\.evidence\.count\(\{\s*\n?\s*where:\s*\{\s*\n?\s*AND:\s*\[pop\.evidence\],\s*\n?\s*deletedAt:\s*null,\s*\n?\s*verificationPackages:\s*\{\s*some:\s*\{\s*\}\s*\}/,
    );
  });

  it("raw report/package ROW counts are preserved as `versionsTotal` (must not be labelled 'ready')", () => {
    expect(COMMAND_CENTER).toMatch(/reportVersionsTotal/);
    expect(COMMAND_CENTER).toMatch(/packageVersionsTotal/);
    // Both raw-row counts MUST exclude soft-deleted evidence too.
    expect(COMMAND_CENTER).toMatch(
      /prisma\.report\.count\(\{\s*\n?\s*where:\s*\{\s*evidence:\s*\{\s*teamId,\s*deletedAt:\s*null\s*\}\s*\}/,
    );
    expect(COMMAND_CENTER).toMatch(
      /prisma\.verificationPackage\.count\(\{\s*\n?\s*where:\s*\{\s*evidence:\s*\{\s*teamId,\s*deletedAt:\s*null\s*\}\s*\}/,
    );
  });

  it("the pipelineDetail envelope exposes both ready (distinct) and versionsTotal", () => {
    // Type-level lock.
    expect(COMMAND_CENTER).toMatch(/ready:\s*number;\s*\n\s*[\s\S]{0,400}?versionsTotal:\s*number/);
  });
});

describe("HOME-TRUTH-FIX — Operational Queue includes timestamp-provider failures", () => {
  it("OperationalPressureItem.category includes tsa_failed and ots_failed", () => {
    expect(COMMAND_CENTER).toMatch(/\|\s*"tsa_failed"/);
    expect(COMMAND_CENTER).toMatch(/\|\s*"ots_failed"/);
  });

  it("ReasonCode includes TSA_FAILED and OTS_FAILED", () => {
    expect(COMMAND_CENTER).toMatch(/\|\s*"TSA_FAILED"/);
    expect(COMMAND_CENTER).toMatch(/\|\s*"OTS_FAILED"/);
  });

  /**
   * CONTRACT MIGRATION — Attention Architecture Phases 3 + 4D (2026-08-22).
   *
   * THE INVARIANT IS UNCHANGED AND IS NOW MUCH STRONGER: a TSA or OTS failure
   * must SURFACE, rather than living only as a count in a Trust State row.
   * What changed is where it surfaces from.
   *
   * The Command Center used to scan `Evidence` for failed timestamp statuses
   * itself and emit a `tsa_failed` / `ots_failed` pressure item. That was a
   * second authority over the same question /operations was answering, and it
   * had no lifecycle at all — the item could not be acknowledged, assigned,
   * resolved or audited, and it reappeared on every page load for as long as
   * the record stayed broken.
   *
   * Those failures are now first-class SHARED OPERATIONAL CONDITIONS, one per
   * Evidence record, opened by
   * `services/api/src/services/operations/evidence-integrity-conditions.service.ts`,
   * resolved from the record's own status column, and projected here through
   * the canonical summary. The per-record independence, idempotency, reopen
   * and severity behaviour are proven in
   * `attention-arch-phase3-evidence-integrity.test.ts`.
   *
   * So what this file now asserts is that the Command Center does NOT scan for
   * them itself, and that the writer which does exists and is wired.
   */
  it("the Command Center no longer scans Evidence for failed timestamp statuses", () => {
    const start = COMMAND_CENTER.indexOf(
      "async function runOperationalPressure(",
    );
    expect(start).toBeGreaterThan(0);
    const body = COMMAND_CENTER.slice(start, COMMAND_CENTER.indexOf("\n}\n", start));
    expect(body).not.toContain("tsaStatus:");
    expect(body).not.toContain("otsStatus:");
    expect(body).not.toMatch(/prisma\.evidence\.findMany/);
  });

  it("per-Evidence integrity failures are opened as conditions with their own lifecycle", () => {
    const WRITER = readFileSync(
      resolve(
        REPO_ROOT,
        "services/api/src/services/operations/evidence-integrity-conditions.service.ts",
      ),
      "utf8",
    );
    // One condition per record per proof class — never grouped by reason,
    // filename, provider, workspace or date.
    expect(WRITER).toContain("export function integrityConditionFingerprint(");
    expect(WRITER).toContain("return `${integrityClass}:${evidenceId}`;");
    // Resolution comes from the record's own status column, positively read.
    expect(WRITER).toContain("isCurrentlyFailing(");
    expect(WRITER).toContain("resolved_by_domain_truth");
  });

  it("tsa/ots wording is operationally neutral — does NOT claim invalid evidence", () => {
    // Vocabulary discipline — a TSA failure is an operational
    // timestamp-anchoring issue, NOT a content-integrity finding.
    // The next-step copy and operationalExplanation MUST avoid
    // wording that implies the evidence itself is invalid.
    const tsa = COMMAND_CENTER.slice(
      COMMAND_CENTER.indexOf("tsa_failed: {"),
      COMMAND_CENTER.indexOf("tsa_failed: {") + 1200,
    );
    expect(tsa).toMatch(/RFC 3161/);
    expect(tsa).not.toMatch(/invalid evidence/i);
    expect(tsa).not.toMatch(/tampered/i);
    expect(tsa).not.toMatch(/inadmissible/i);

    const ots = COMMAND_CENTER.slice(
      COMMAND_CENTER.indexOf("ots_failed: {"),
      COMMAND_CENTER.indexOf("ots_failed: {") + 1200,
    );
    expect(ots).toMatch(/OpenTimestamps/);
    expect(ots).not.toMatch(/invalid evidence/i);
    expect(ots).not.toMatch(/tampered/i);
    expect(ots).not.toMatch(/inadmissible/i);
  });
});

describe("HOME-TRUTH-FIX — projection no longer counts pre-SIGNED rows as pending", () => {
  // WORKSPACE-SCOPE CONVERGENCE — the eligible statuses are now NAMED
  // constants at the top of the authority rather than literals repeated at
  // each query. That is what made the divergence fixable: the Worker's copy
  // omitted the filter entirely, and a filter that exists in one spelling in
  // one file is a filter that can be forgotten in another.
  //
  // Both halves are asserted — that the constants hold exactly these statuses,
  // AND that the counts are bounded by them — so neither a renamed constant
  // nor a widened one can pass.
  it("the eligible-status constants name exactly the pipeline stages", () => {
    expect(REFRESH_PROJ).toMatch(
      /REPORT_ELIGIBLE_STATUSES\s*=\s*\[\s*"SIGNED",\s*"REPORTED"\s*\]\s*as const/,
    );
    expect(REFRESH_PROJ).toMatch(
      /PACKAGE_ELIGIBLE_STATUSES\s*=\s*\[\s*"REPORTED"\s*\]\s*as const/,
    );
  });

  it("pendingReportCount is scoped to status SIGNED or REPORTED", () => {
    expect(REFRESH_PROJ).toMatch(
      /status:\s*\{\s*in:\s*\[\s*\.\.\.REPORT_ELIGIBLE_STATUSES\s*\][\s\S]{0,120}reports:\s*\{\s*none/,
    );
  });

  it("pendingPackageCount is scoped to status REPORTED (package only meaningful after report)", () => {
    expect(REFRESH_PROJ).toMatch(
      /status:\s*\{\s*in:\s*\[\s*\.\.\.PACKAGE_ELIGIBLE_STATUSES\s*\][\s\S]{0,160}verificationPackages:\s*\{\s*none/,
    );
  });

  it("the Worker no longer carries its own copy of the arithmetic", () => {
    // The defect in one assertion. The processor must DELEGATE, never count.
    const worker = readFileSync(
      resolve(REPO_ROOT, "services", "worker", "src", "subsystem-queue-processors.ts"),
      "utf8",
    );
    const start = worker.indexOf("export async function processOrgHealthRefreshJob");
    expect(start).toBeGreaterThan(0);
    const end = worker.indexOf("\nexport async function ", start + 1);
    const body = worker.slice(start, end > 0 ? end : worker.length);
    expect(body).toMatch(/refreshOrgHealthProjection\(\s*\{\s*teamId\s*\}/);
    expect(body).not.toMatch(/prisma\.evidence\.count/);
    expect(body).not.toMatch(/prisma\.case\.count/);
    expect(body).not.toMatch(/orgHealthProjection\.upsert/);
  });
});
