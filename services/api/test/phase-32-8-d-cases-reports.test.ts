/**
 * Phase 32.8D — Cases + Reports enterprise rebuild.
 *
 * Source-contract regression suite. Pins:
 *
 *  PART 1 — Backend `case-workspace.service.ts` is read-only, partial-
 *           failure tolerant, no audit emission, bounded queries.
 *  PART 2 — Backend `reports-aggregator.service.ts` same contract +
 *           no signed-URL / no download side effects.
 *  PART 3 — Routes `/v1/cases/summary`, `/v1/cases/:id/workspace`,
 *           `/v1/reports/artifacts` are registered, GET-only,
 *           authenticated + workspace-membership gated.
 *  PART 4 — Frontend /cases list page uses the aggregator (no fake
 *           metrics) and gates create-case behind a mutation-capable
 *           role.
 *  PART 5 — Frontend /cases/[id] page renders the canonical tabs and
 *           short-circuits team-only tabs in personal workspaces.
 *  PART 6 — Frontend /reports page does NOT call the side-effecting
 *           download endpoints on mount, uses bounded lifecycle copy,
 *           and never makes legal-admissibility claims.
 *  PART 7 — Shared invariants: no fake data, no overclaiming language,
 *           no Prisma writes from any of the new aggregators, no
 *           OTS/TSA/custody/billing/report-generation calls.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

const CASE_SVC = readApi("src/services/cases/case-workspace.service.ts");
const REPORTS_SVC = readApi("src/services/reports/reports-aggregator.service.ts");
const ROUTES = readApi("src/routes/case-workspace.routes.ts");
const SERVER = readApi("src/server.ts");

const CASES_INDEX = readWeb("components/cases-experience/CasesIndex.tsx");
const CASE_WORKSPACE = readWeb("components/cases-experience/CaseWorkspace.tsx");
const REPORTS_INDEX = readWeb("components/reports-experience/ReportsIndex.tsx");
const CASES_PAGE = readWeb("app/(app)/cases/page.tsx");
const CASE_DETAIL_PAGE = readWeb("app/(app)/cases/[id]/page.tsx");
const REPORTS_PAGE = readWeb("app/(app)/reports/page.tsx");

// =============================================================================
// PART 1 — case-workspace service: read-only + partial-failure tolerant
// =============================================================================

describe("Phase 32.8D — case-workspace service contract", () => {
  it("exports buildCasesSummary + buildCaseWorkspace entrypoints", () => {
    expect(CASE_SVC).toMatch(/export async function buildCasesSummary\(/);
    expect(CASE_SVC).toMatch(/export async function buildCaseWorkspace\(/);
  });

  it("never calls Prisma write methods", () => {
    for (const re of [
      /prisma\.[A-Za-z]+\.create\(/,
      /prisma\.[A-Za-z]+\.createMany\(/,
      /prisma\.[A-Za-z]+\.update\(/,
      /prisma\.[A-Za-z]+\.updateMany\(/,
      /prisma\.[A-Za-z]+\.delete\(/,
      /prisma\.[A-Za-z]+\.deleteMany\(/,
      /prisma\.[A-Za-z]+\.upsert\(/,
    ]) {
      expect(CASE_SVC, `service must not call ${re}`).not.toMatch(re);
    }
  });

  it("never emits audit / analytics / security events on load", () => {
    for (const sym of [
      "auditCaseAction",
      "auditEvidenceAction",
      "auditMiddleware",
      "writeAnalyticsEvent",
      "fireCaseAnalyticsEvent",
      "emitSecurityEvent",
      "writeAuditEvent",
    ]) {
      expect(CASE_SVC, `case service must not invoke ${sym}`).not.toContain(
        sym,
      );
    }
  });

  it("declares bounded limits on every list query", () => {
    expect(CASE_SVC).toMatch(/SUMMARY_CASES_LIMIT\s*=\s*50/);
    expect(CASE_SVC).toMatch(/CASE_EVIDENCE_LIMIT\s*=\s*25/);
    expect(CASE_SVC).toMatch(/CASE_TIMELINE_LIMIT\s*=\s*30/);
    expect(CASE_SVC).toMatch(/CASE_ACTIVITY_LIMIT\s*=\s*25/);
    // Every findMany has a `take:` cap.
    const findMany = CASE_SVC.match(/\.findMany\(\{[\s\S]*?\}\)/g) ?? [];
    expect(findMany.length).toBeGreaterThanOrEqual(6);
    for (const block of findMany) {
      expect(
        block,
        `case service has unbounded findMany: ${block.slice(0, 80)}`,
      ).toMatch(/take:/);
    }
  });

  it("personal-case `reviewCoordination` short-circuits to `not_applicable`", () => {
    expect(CASE_SVC).toMatch(
      /scope === "PERSONAL"[\s\S]{0,200}status:\s*"not_applicable"/,
    );
  });

  it("preservation aggregates case-level + evidence-level holds independently (degrades on partial failure)", () => {
    // Two sequential try/catch around CaseLegalHold and EvidenceLegalHold,
    // with the section status reduced from per-block ok/failed flags.
    expect(CASE_SVC).toMatch(/preservationAnyFailed/);
    expect(CASE_SVC).toMatch(/preservationAnyOk/);
    expect(CASE_SVC).toMatch(/caseLegalHold/);
    expect(CASE_SVC).toMatch(/evidenceLegalHold/);
  });

  it("timeline is built from real timestamps only (case + evidence + holds — no synthesized events)", () => {
    const tlIdx = CASE_SVC.indexOf("timeline = ");
    expect(tlIdx).toBeGreaterThan(-1);
    // The kinds match the bounded TimelineEntry kinds.
    for (const kind of [
      "case_created",
      "case_updated",
      "evidence_linked",
      "legal_hold_placed",
      "legal_hold_released",
    ]) {
      expect(CASE_SVC).toMatch(new RegExp(`kind:\\s*"${kind}"`));
    }
  });

  it("activity feed reads ONLY from prisma.teamActivity (no synthetic events)", () => {
    expect(CASE_SVC).toMatch(/prisma\.teamActivity\.findMany/);
  });

  it("envelope shapes expose the canonical sections", () => {
    for (const section of [
      "overview",
      "evidence",
      "preservation",
      "reviewCoordination",
      "timeline",
      "activity",
    ]) {
      expect(CASE_SVC).toMatch(new RegExp(`${section}:\\s*\\{`));
    }
  });
});

// =============================================================================
// PART 2 — reports aggregator service: read-only + side-effect-free
// =============================================================================

describe("Phase 32.8D — reports aggregator service contract", () => {
  it("exports listWorkspaceArtifacts as the canonical entrypoint", () => {
    expect(REPORTS_SVC).toMatch(
      /export async function listWorkspaceArtifacts\(/,
    );
  });

  it("never calls Prisma write methods", () => {
    for (const re of [
      /prisma\.[A-Za-z]+\.create\(/,
      /prisma\.[A-Za-z]+\.update\(/,
      /prisma\.[A-Za-z]+\.delete\(/,
      /prisma\.[A-Za-z]+\.upsert\(/,
    ]) {
      expect(REPORTS_SVC, `reports service must not call ${re}`).not.toMatch(re);
    }
  });

  it("never imports or invokes report / package generation or signed-URL engines", () => {
    // Browsing /reports must NOT generate artifacts or signed URLs.
    for (const sym of [
      "renderReport",
      "buildReport",
      "buildReportPackage",
      "buildVerificationPackage",
      "generateReport",
      "generateVerificationPackage",
      "stampWithTsa",
      "appendCustodyEvent",
      "createCustodyEvent",
      "getSignedDownloadUrl",
      "generateSignedUrl",
      "presignS3",
      "computeBillingCharge",
    ]) {
      expect(
        REPORTS_SVC,
        `reports service must not invoke ${sym}`,
      ).not.toContain(sym);
    }
  });

  it("never emits audit / analytics / security events", () => {
    for (const sym of [
      "auditEvidenceAction",
      "auditMiddleware",
      "writeAnalyticsEvent",
      "emitSecurityEvent",
      "writeAuditEvent",
    ]) {
      expect(
        REPORTS_SVC,
        `reports service must not invoke ${sym}`,
      ).not.toContain(sym);
    }
  });

  it("declares bounded lifecycle enums (report + package)", () => {
    expect(REPORTS_SVC).toMatch(
      /export type ReportLifecycle\s*=[\s\S]{0,200}"not_requested"[\s\S]{0,200}"pending"[\s\S]{0,200}"ready"[\s\S]{0,200}"failed"[\s\S]{0,200}"unavailable"/,
    );
    expect(REPORTS_SVC).toMatch(
      /export type PackageLifecycle\s*=[\s\S]{0,200}"not_requested"[\s\S]{0,200}"pending"[\s\S]{0,200}"ready"[\s\S]{0,200}"blocked"[\s\S]{0,200}"failed"[\s\S]{0,200}"unavailable"/,
    );
  });

  it("bounded limits: default 25, max 100", () => {
    expect(REPORTS_SVC).toMatch(/DEFAULT_LIMIT\s*=\s*25/);
    expect(REPORTS_SVC).toMatch(/MAX_LIMIT\s*=\s*100/);
  });

  it("never projects raw storage keys, signed URLs, file SHA, or privileged legal text", () => {
    for (const sym of [
      "storageKey",
      "storageBucket",
      "presignedUrl",
      "signedUrl",
      "fileSha256:",
      "internalNotes",
      "intakePlanJson",
    ]) {
      expect(
        REPORTS_SVC,
        `reports service must not project ${sym}`,
      ).not.toContain(sym);
    }
  });
});

// =============================================================================
// PART 3 — Routes registered + auth-gated + GET-only
// =============================================================================

describe("Phase 32.8D — routes registered + workspace-gated", () => {
  it("registers GET /v1/cases/summary", () => {
    expect(ROUTES).toMatch(/app\.get\(\s*"\/v1\/cases\/summary"/);
  });

  it("registers GET /v1/cases/:id/workspace", () => {
    expect(ROUTES).toMatch(/app\.get\(\s*"\/v1\/cases\/:id\/workspace"/);
  });

  it("registers GET /v1/reports/artifacts", () => {
    expect(ROUTES).toMatch(/app\.get\(\s*"\/v1\/reports\/artifacts"/);
  });

  it("every route requires authentication", () => {
    const gets = ROUTES.match(/app\.get\(\s*"\/v1\/[^"]+",[\s\S]*?preHandler:\s*requireAuth/g) ?? [];
    expect(gets.length).toBeGreaterThanOrEqual(3);
  });

  it("read endpoints remain GET-only (Phase 32.8D adds explicit audited lifecycle POST/DELETE routes alongside)", () => {
    // Phase 32.8D — the case-workspace routes file now hosts BOTH the
    // original read endpoints AND the new audited lifecycle mutations
    // (status / assignments / comments / evidence-links). Each mutation
    // is permission-gated + audited; the original GET endpoints remain
    // read-only and side-effect safe. The constraint we still enforce
    // is no PUT/PATCH (we use POST + DELETE only).
    expect(ROUTES).not.toMatch(/app\.put\(/);
    expect(ROUTES).not.toMatch(/app\.patch\(/);
    // The new POST routes are present and audited.
    expect(ROUTES).toMatch(/"\/v1\/cases\/:id\/status"/);
    expect(ROUTES).toMatch(/"\/v1\/cases\/:id\/assignments"/);
    expect(ROUTES).toMatch(/"\/v1\/cases\/:id\/comments"/);
    expect(ROUTES).toMatch(/"\/v1\/cases\/:id\/evidence-links"/);
  });

  it("workspace-membership gate uses 404-on-non-member / 403-on-inactive", () => {
    expect(ROUTES).toMatch(/requireWorkspaceMember\(/);
    expect(ROUTES).toMatch(
      /code\(404\)\.send\(\{\s*error:\s*\{\s*code:\s*"not_found"/,
    );
    expect(ROUTES).toMatch(/membership\.status\s*!==\s*"ACTIVE"/);
  });

  it("case-access gate (owner | direct access | workspace member) — 404 on no access", () => {
    expect(ROUTES).toMatch(/requireCaseAccess\(/);
    // Verify the helper exists and 404s on absent or denied access.
    const idx = ROUTES.indexOf("async function requireCaseAccess");
    expect(idx).toBeGreaterThan(-1);
    const body = ROUTES.slice(idx, ROUTES.indexOf("\n}\n", idx) + 4);
    expect(body).toMatch(/ownerUserId === userId/);
    expect(body).toMatch(/code\(404\)/);
  });

  it("server registers the new routes", () => {
    expect(SERVER).toMatch(/import \{ caseWorkspaceRoutes \}/);
    expect(SERVER).toMatch(/app\.register\(caseWorkspaceRoutes\)/);
  });
});

// =============================================================================
// PART 4 — Frontend /cases list contract
// =============================================================================

describe("Phase 32.8D — /cases list page (CasesIndex)", () => {
  it("delegates the cases page to CasesIndex", () => {
    expect(CASES_PAGE).toMatch(/<CasesIndex\s*\/>/);
    expect(CASES_PAGE).toMatch(
      /import\s*\{\s*CasesIndex\s*\}\s*from\s*"[^"]*components\/cases-experience\/CasesIndex"/,
    );
  });

  // OBSOLETE — Phase 32.8D-frontend rebuilt CasesIndex as the Matter
  // Operations Queue consuming /v1/cases/matter-queue. The new
  // contract is asserted by phase-32-8-d-frontend-matter-workspace.test.ts.
  it.skip("reads from /v1/cases/summary (the audit-free aggregator)", () => {});

  it.skip("renders the operational summary tiles backed by real envelope data", () => {
    for (const key of [
      'data-cases-summary-key="total"',
      'data-cases-summary-key="with_evidence"',
    ]) {
      expect(CASES_INDEX).toContain(key);
    }
    // Team-only summary cards are gated by `isTeam` AND reference the
    // canonical workspace fields.
    expect(CASES_INDEX).toMatch(/isTeam\s*\?[\s\S]{0,3000}casesWithActiveHolds/);
    expect(CASES_INDEX).toMatch(/isTeam\s*\?[\s\S]{0,3000}casesWithPendingReview/);
  });

  // OBSOLETE — Phase 32.8D-frontend removed the inline "create case"
  // button from the Matter Operations Queue. Case creation is driven
  // from the evidence-detail flow / admin tooling. The new tests live
  // in phase-32-8-d-frontend-matter-workspace.test.ts.
  it.skip("gates the 'Create case' button by canonical CASES_MANAGE capability", () => {});

  it("create / rename / delete actions only fire on explicit user click (no mutation on page mount)", () => {
    // The only mutation in the index file is onCreateCase, which is
    // bound to a button click. No `apiFetch(...)` with method !== GET
    // appears in the file outside of explicit click handlers.
    const mutations = CASES_INDEX.match(/apiFetch\([^)]*method:\s*"(POST|PUT|PATCH|DELETE)"/g) ?? [];
    // Only the explicit create case POST is allowed.
    for (const m of mutations) {
      expect(m).toMatch(/POST/);
    }
    expect(mutations.length).toBeLessThanOrEqual(1);
  });

  // OBSOLETE — Phase 32.8D-frontend replaced the all/with_evidence/
  // with_holds/with_review filter set with the canonical matter-queue
  // filters (status/riskLevel/assignedToMe/hasOpenIncidents/etc).
  // See phase-32-8-d-frontend-matter-workspace.test.ts for the new
  // filter contract.
  it.skip("provides bounded filters: all / with_evidence / with_holds / with_review (last two team-only)", () => {});

  // OBSOLETE — Phase 32.8D-frontend uses `QueueLoading`,
  // `QueueAuthError`, `QueueUnavailable` shells. Personal mode now
  // routes through CapabilityDegradedPanel rather than a dedicated
  // CasesNoWorkspace shell.
  it.skip("renders distinct loading / no-workspace / auth-error / unavailable states (no infinite loaders)", () => {});

  it("never contains fake metrics or hardcoded numeric values", () => {
    // No `value: N` literals or Math.random.
    expect(CASES_INDEX).not.toMatch(/Math\.random/);
    expect(CASES_INDEX).not.toMatch(/\bvalue:\s*\d{2,}\b/);
  });
});

// =============================================================================
// PART 5 — Frontend /cases/[id] tabbed workspace
// =============================================================================

describe("Phase 32.8D — /cases/[id] tabbed workspace (CaseWorkspace)", () => {
  it("delegates the detail page to CaseWorkspace", () => {
    expect(CASE_DETAIL_PAGE).toMatch(/<CaseWorkspace\s+caseId=\{caseId\}\s*\/>/);
  });

  // OBSOLETE — Phase 32.8D-frontend rewired CaseWorkspace to consume
  // /v1/cases/:id/matter-workspace (the enterprise envelope), not the
  // legacy /v1/cases/:id/workspace. The new contract is asserted by
  // phase-32-8-d-frontend-matter-workspace.test.ts.
  it.skip("fetches the workspace envelope from /v1/cases/:id/workspace (NOT /v1/cases/:id which is audited)", () => {});

  it.skip("renders the canonical tabs: Overview, Linked Evidence, Timeline, Review Coordination, Legal Preservation, Activity", () => {
    expect(CASE_WORKSPACE).toMatch(/label: "Overview"/);
    expect(CASE_WORKSPACE).toMatch(/label: "Linked Evidence"/);
    expect(CASE_WORKSPACE).toMatch(/label: "Timeline"/);
    expect(CASE_WORKSPACE).toMatch(/label: "Review Coordination"/);
    expect(CASE_WORKSPACE).toMatch(/label: "Legal Preservation"/);
    expect(CASE_WORKSPACE).toMatch(/label: "Activity"/);
  });

  // OBSOLETE — Phase 32.8D-frontend replaced the tab-based workspace
  // with the 11-section matter workspace. Reviewer + governance
  // sections now use server-provided section status + capability
  // gating instead of local `isTeam` short-circuits.
  it.skip("Review Coordination + Activity tabs are gated by `isTeam` (personal cases short-circuit to neutral state)", () => {});

  it.skip("personal-scope short-circuit copy: 'Personal case uses basic evidence controls.'", () => {});

  // OBSOLETE — Phase 32.8D-frontend's timeline section uses new
  // empty-state copy ("No timeline events in this view." /
  // "No timeline events recorded for this matter.") and the
  // 11-section matter workspace no longer has a separate Activity
  // tab. Disclaimer language preserved in the Custody/Integrity
  // section (asserted by phase-32-8-d-frontend-matter-workspace).
  it.skip("Timeline tab handles the 'no events' state with honest copy (NOT fake events)", () => {});
  it.skip("Activity tab handles the 'no events' state with honest copy", () => {});
  it.skip("Preservation tab includes the no-legal-admissibility disclaimer", () => {});

  it("never makes legal overclaiming statements", () => {
    for (const banned of [
      "legally admissible",
      "court-ready",
      "guaranteed",
      "verified truth",
      "proves authenticity",
    ]) {
      expect(
        CASE_WORKSPACE,
        `case workspace must not say "${banned}"`,
      ).not.toContain(banned);
    }
  });

  it("renders linked evidence with bounded report + package readiness flags only (no presigned URL exposure)", () => {
    // Phase 32.8D-frontend uses new data attributes
    // (`data-matter-section-evidence-report-ready` etc.) — but the
    // safety invariant (NO presigned URL exposure) still applies.
    expect(CASE_WORKSPACE).toMatch(/data-matter-section-evidence-report-ready/);
    expect(CASE_WORKSPACE).toMatch(/data-matter-section-evidence-package-ready/);
    expect(CASE_WORKSPACE).not.toContain("presignedUrl");
    expect(CASE_WORKSPACE).not.toContain("signedUrl");
  });
});

// =============================================================================
// PART 6 — Frontend /reports artifact lifecycle index
// =============================================================================

describe("Phase 32.8D — /reports artifact lifecycle (ReportsIndex)", () => {
  it("delegates the reports page to ReportsIndex", () => {
    expect(REPORTS_PAGE).toMatch(/<ReportsIndex\s*\/>/);
  });

  it("reads only from the side-effect-free `/v1/reports/artifacts` aggregator", () => {
    expect(REPORTS_INDEX).toMatch(/\/v1\/reports\/artifacts\?/);
  });

  it("never CALLS the side-effecting `/v1/evidence/:id/report/latest` on mount (docstring mentions OK)", () => {
    // Match an actual fetch/apiFetch call, not a docstring reference.
    expect(REPORTS_INDEX).not.toMatch(
      /apiFetch\([^)]*\/v1\/evidence\/[^)]*\/report\/latest/,
    );
    expect(REPORTS_INDEX).not.toMatch(
      /fetch\([^)]*\/v1\/evidence\/[^)]*\/report\/latest/,
    );
  });

  it("never CALLS the side-effecting `/v1/evidence/:id/verification-package` on mount (docstring mentions OK)", () => {
    expect(REPORTS_INDEX).not.toMatch(
      /apiFetch\([^)]*\/v1\/evidence\/[^)]*\/verification-package/,
    );
    expect(REPORTS_INDEX).not.toMatch(
      /fetch\([^)]*\/v1\/evidence\/[^)]*\/verification-package/,
    );
  });

  it("does not call any /v1/governance/export-eligibility on mount (no governance probe side effects)", () => {
    expect(REPORTS_INDEX).not.toMatch(
      /apiFetch\([^)]*\/v1\/governance\/export-eligibility/,
    );
    expect(REPORTS_INDEX).not.toMatch(
      /fetch\([^)]*\/v1\/governance\/export-eligibility/,
    );
  });

  it("renders bounded lifecycle copy (no generic 'download unavailable')", () => {
    for (const phrase of [
      "Report ready",
      "Report pending",
      "Package ready",
      "Package pending",
      "Package blocked",
    ]) {
      expect(REPORTS_INDEX).toContain(phrase);
    }
    // The bounded label resolver enumerates each lifecycle value.
    expect(REPORTS_INDEX).toMatch(/function reportLabel\(/);
    expect(REPORTS_INDEX).toMatch(/function packageLabel\(/);
  });

  it("explicitly tells the operator that browsing is side-effect-free", () => {
    expect(REPORTS_INDEX).toMatch(
      /Browsing this page never triggers report or package generation/,
    );
  });

  it("never makes legal-admissibility / authenticity / court-ready / truth claims (negations and quoted disclaimers are OK)", () => {
    // The page DOES contain quoted negations like `"court-ready" status`
    // inside the disclaimer. We want to catch UNQUALIFIED claims —
    // e.g., `court-ready report`, `legally admissible evidence`. The
    // regex below requires the phrase to NOT be preceded by `"` or
    // `NOT` / `not` (negation form).
    const positiveClaim = (phrase: string): RegExp =>
      new RegExp(`(?<!["NOT not ])\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b(?!["])`);
    for (const banned of [
      "legally admissible",
      "guaranteed",
      "verified truth",
      "proves authenticity",
    ]) {
      expect(
        REPORTS_INDEX,
        `reports index must not make positive claim "${banned}"`,
      ).not.toMatch(positiveClaim(banned));
    }
  });

  it("includes the bounded no-claim disclaimer at the top of the page", () => {
    expect(REPORTS_INDEX).toMatch(
      /record integrity at the time of\s+generation and do NOT assert legal admissibility/,
    );
  });

  it("renders distinct loading / no-workspace / auth-error / unavailable states", () => {
    for (const fn of [
      "ReportsLoading",
      "ReportsNoWorkspace",
      "ReportsAuthError",
      "ReportsUnavailable",
    ]) {
      expect(REPORTS_INDEX).toMatch(new RegExp(`function ${fn}\\(`));
    }
  });

  it("renders package-blocked rows with the bounded reason chip", () => {
    expect(REPORTS_INDEX).toMatch(
      /data-reports-package-blocked-reason=\{row\.package\.blockedReason\}/,
    );
    expect(REPORTS_INDEX).toContain("Export blocked by governance");
  });

  it("never contains fake metric literals or Math.random", () => {
    expect(REPORTS_INDEX).not.toMatch(/Math\.random/);
    expect(REPORTS_INDEX).not.toMatch(/\bvalue:\s*\d{2,}\b/);
  });
});

// =============================================================================
// PART 7 — Shared invariants
// =============================================================================

describe("Phase 32.8D — shared invariants", () => {
  it("aggregator services do not import the OTS / TSA / custody / billing modules", () => {
    const forbiddenImports = [
      /from\s+"[^"]*\/services\/custody/,
      /from\s+"[^"]*\/services\/timestamping/,
      /from\s+"[^"]*\/services\/ots/,
      /from\s+"[^"]*\/services\/billing/,
      /from\s+"[^"]*\/services\/report-generator/,
      /from\s+"[^"]*\/services\/verification-package/,
    ];
    for (const re of forbiddenImports) {
      expect(CASE_SVC, `case service must not import ${re}`).not.toMatch(re);
      expect(
        REPORTS_SVC,
        `reports service must not import ${re}`,
      ).not.toMatch(re);
    }
  });

  it("services never project sensitive raw fields (signed URLs, storage keys, file SHA, internal notes)", () => {
    for (const sym of [
      "storageKey",
      "storageBucket",
      "presignedUrl",
      "signedUrl",
      "fileSha256:",
      "internalNotes",
    ]) {
      expect(CASE_SVC, `case service must not project ${sym}`).not.toContain(sym);
      expect(
        REPORTS_SVC,
        `reports service must not project ${sym}`,
      ).not.toContain(sym);
    }
  });

  it("frontend cases + reports surfaces never make positive overclaim statements", () => {
    const sources = { CASES_INDEX, CASE_WORKSPACE, REPORTS_INDEX };
    const positiveClaim = (phrase: string): RegExp =>
      new RegExp(
        `(?<!["NOT not ])\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b(?!["])`,
      );
    for (const banned of [
      "legally admissible",
      "guaranteed",
      "verified truth",
    ]) {
      for (const [name, src] of Object.entries(sources)) {
        expect(
          src,
          `${name} must not contain positive overclaim "${banned}"`,
        ).not.toMatch(positiveClaim(banned));
      }
    }
  });

  it("none of the new frontend components CALL side-effecting download endpoints (docstring mentions are OK)", () => {
    const sources = { CASES_INDEX, CASE_WORKSPACE, REPORTS_INDEX };
    for (const [name, src] of Object.entries(sources)) {
      expect(
        src,
        `${name} must not call /report/latest on mount`,
      ).not.toMatch(/apiFetch\([^)]*\/v1\/evidence\/[^)]*\/report\/latest/);
      expect(
        src,
        `${name} must not call /verification-package on mount`,
      ).not.toMatch(
        /apiFetch\([^)]*\/v1\/evidence\/[^)]*\/verification-package/,
      );
      // Case-export ZIP endpoint must not be called on mount.
      expect(
        src,
        `${name} must not call /v1/cases/:id/export on mount`,
      ).not.toMatch(/apiFetch\([^)]*\/v1\/cases\/[^)]*\/export/);
    }
  });

  it("cases experience preservation copy never claims legal authenticity", () => {
    // Phase 32.8D-frontend preserves the safety invariant — custody
    // copy uses bounded vocabulary instead of legal claims. The new
    // disclaimer lives in the Custody/Integrity section.
    expect(CASE_WORKSPACE).toMatch(/does\s+not assert legal admissibility/i);
    // Negative invariants apply across both workspace surfaces.
    expect(CASE_WORKSPACE).not.toMatch(/\blegally admissible\b/);
    expect(CASE_WORKSPACE).not.toMatch(/\bcourt-ready\b/);
  });

  it("/v1/cases/summary, /v1/cases/:id/workspace, /v1/reports/artifacts response shapes carry per-section `status`", () => {
    expect(CASE_SVC).toMatch(/status:\s*SectionStatus/);
    expect(REPORTS_SVC).toMatch(/status:\s*SectionStatus/);
  });

  it("personal-workspace governance/reviewer sections honor not_applicable from the server", () => {
    // server-side guard (legacy /v1/cases/:id/workspace)
    expect(CASE_SVC).toMatch(
      /reviewCoordination[\s\S]{0,400}scope === "PERSONAL"[\s\S]{0,200}not_applicable/,
    );
    // Phase 32.8D-frontend: the matter workspace section shell renders
    // a structured "not_applicable" branch sourced from the server's
    // SectionStatus. Frontend never invents the gate.
    expect(CASE_WORKSPACE).toMatch(/status === "not_applicable"/);
  });
});
