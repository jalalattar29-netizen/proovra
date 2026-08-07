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
// Phase C1.1 — `CaseWorkspace` was renamed to `MatterWorkspace` (the
// canonical operator vocabulary). Negative invariants (no legal
// overclaim, no presigned URL exposure) continue to apply to the
// canonical surface. Positive shape-assertions about CaseWorkspace
// internals (tab labels, section data attributes) are now covered by
// `phase-c1-matter-workspace.test.ts`.
const CASE_WORKSPACE = readWeb("components/cases-experience/MatterWorkspace.tsx");
const REPORTS_INDEX = readWeb("components/reports-experience/ReportsIndex.tsx");
const CASES_PAGE = readWeb("app/(app)/cases/page.tsx");
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
      /scope === "SINGLE_OCCUPANT"[\s\S]{0,200}status:\s*"not_applicable"/,
    );
  });

  it("preservation aggregates case-level + evidence-level holds independently (degrades on partial failure)", () => {
    // Two sequential try/catch around CaseLegalHold and EvidenceLegalHold,
    // with the section status reduced from per-block ok/failed flags.
    expect(CASE_SVC).toMatch(/preservationAnyFailed/);
    expect(CASE_SVC).toMatch(/preservationAnyOk/);
    // PHASE 12 POINT 3 — both hold levels now live in the ONE canonical table.
    // The aggregation is still INDEPENDENT (that is the invariant): the
    // case-level read is scope-filtered, the evidence-level read is not, and a
    // partial failure still degrades rather than reporting a clean record.
    expect(CASE_SVC).toMatch(/evidenceLegalHold/);
    expect(CASE_SVC).toMatch(/scope: "CASE"/);
    // The retired delegate may not reappear.
    expect(CASE_SVC).not.toMatch(/prisma\.caseLegalHold\./);
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
    // Normalize CRLF→LF before searching for the trailing `\n}\n`.
    // Use a large bounded window so we capture the helper regardless
    // of formatting drift (the helper is ~60-80 lines).
    const normalized = ROUTES.slice(idx, idx + 4000).replace(/\r\n/g, "\n");
    const endIdx = normalized.indexOf("\n}\n");
    const body = endIdx > -1 ? normalized.slice(0, endIdx + 4) : normalized;
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

  it("create / archive / delete actions only fire on explicit user click (no mutation on page mount)", () => {
    // §3 overflow menu — the Matter Queue now surfaces per-row actions:
    // create case (POST /v1/cases via the modal), archive (POST
    // /v1/cases/:id/status {ARCHIVED}) and delete (DELETE /v1/cases/:id).
    // All are bound to explicit click handlers (the row overflow menu /
    // create button), never fired on mount. The invariants we still
    // enforce: only POST + DELETE (no PUT/PATCH), and every mutation is
    // reached through a handler, not module/effect scope.
    const mutations = CASES_INDEX.match(/apiFetch\([^)]*method:\s*"(POST|PUT|PATCH|DELETE)"/g) ?? [];
    for (const m of mutations) {
      expect(m).toMatch(/POST|DELETE/);
      expect(m).not.toMatch(/PUT|PATCH/);
    }
    // Guard against a mutation escaping into a top-level effect: no
    // apiFetch mutation appears inside a bare useEffect body.
    expect(CASES_INDEX).not.toMatch(
      /useEffect\([^)]*apiFetch\([^)]*method:\s*"(POST|DELETE)"/,
    );
  });

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

  it("matter workspace never exposes presigned / signed URLs on render (safety invariant)", () => {
    // Phase C1 / C1.1 — the legacy 32.8D positive assertions on
    // `data-matter-section-evidence-report-ready` (the CaseWorkspace
    // section data attributes) are now covered by
    // `phase-c1-matter-workspace.test.ts`. The negative safety
    // invariant — the workspace must NEVER surface presigned or
    // signed URLs in its render path — still applies to the
    // canonical MatterWorkspace and is asserted here.
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

  // The mount-side check needs to ignore apiFetch calls nested
  // inside explicit click-handler async functions (`triggerReport`,
  // `triggerPackage`). Those are USER-initiated downloads, which
  // are the canonical, expected use of these side-effecting
  // endpoints. We strip those handler bodies from the source before
  // matching so the "on mount" check stays meaningful.
  function stripClickHandlers(src: string): string {
    return src.replace(
      /const\s+(?:triggerReport|triggerPackage)\s*=\s*async[\s\S]*?\n {2}\};/g,
      "",
    );
  }

  it("never CALLS the side-effecting `/v1/evidence/:id/report/latest` on mount (docstring mentions OK)", () => {
    // Match an actual fetch/apiFetch call OUTSIDE the user-initiated
    // click handlers. Calls inside `triggerReport` are expected and
    // intentional — the user pressed the Download Report button.
    const onMount = stripClickHandlers(REPORTS_INDEX);
    expect(onMount).not.toMatch(
      /apiFetch\([^)]*\/v1\/evidence\/[^)]*\/report\/latest/,
    );
    expect(onMount).not.toMatch(
      /fetch\([^)]*\/v1\/evidence\/[^)]*\/report\/latest/,
    );
  });

  it("never CALLS the side-effecting `/v1/evidence/:id/verification-package` on mount (docstring mentions OK)", () => {
    const onMount = stripClickHandlers(REPORTS_INDEX);
    expect(onMount).not.toMatch(
      /apiFetch\([^)]*\/v1\/evidence\/[^)]*\/verification-package/,
    );
    expect(onMount).not.toMatch(
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
    // Strip user-initiated download click handlers
    // (`triggerReport` / `triggerPackage`) so this check stays
    // focused on mount-time / passive surface emission. Click
    // handlers are by definition user-driven and the canonical
    // entry point for these endpoints.
    const stripDownloadHandlers = (s: string) =>
      s.replace(
        /const\s+(?:triggerReport|triggerPackage)\s*=\s*async[\s\S]*?\n {2}\};/g,
        "",
      );
    const sources = {
      CASES_INDEX: stripDownloadHandlers(CASES_INDEX),
      CASE_WORKSPACE: stripDownloadHandlers(CASE_WORKSPACE),
      REPORTS_INDEX: stripDownloadHandlers(REPORTS_INDEX),
    };
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
    // Phase C1 / C1.1 — the legacy 32.8D Custody/Integrity disclaimer
    // line ("does not assert legal admissibility") moved into
    // `phase-c1-matter-workspace.test.ts` along with the rest of the
    // MatterWorkspace section-shape contract. The negative invariants
    // — the workspace must NEVER make legal-admissibility or court-
    // ready claims — still apply to the canonical MatterWorkspace
    // and are asserted here.
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
      /reviewCoordination[\s\S]{0,400}scope === "SINGLE_OCCUPANT"[\s\S]{0,200}not_applicable/,
    );
    // Phase C1 / C1.1 — the canonical MatterWorkspace consumes the
    // server-provided SectionStatus enum (`ok | degraded | unavailable
    // | not_applicable`) verbatim. The shape-level assertion that the
    // workspace recognises the `not_applicable` value is asserted by
    // the SectionStatus type literal declared inline in the component
    // (the broader contract is covered by
    // `phase-c1-matter-workspace.test.ts`).
    expect(CASE_WORKSPACE).toMatch(/"not_applicable"/);
  });
});
