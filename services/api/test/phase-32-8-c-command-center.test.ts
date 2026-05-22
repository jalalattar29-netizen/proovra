/**
 * Phase 32.8C — Enterprise Evidence Operations Command Center.
 *
 * Source-contract regression suite. Locks in the architecture
 * established in Phase 32.8C:
 *
 *  PART 1 — backend aggregator endpoint exists, is read-only, has
 *           no audit emission, and is workspace-membership gated.
 *  PART 2 — service layer assembles each section independently with
 *           bounded queries and partial-failure tolerance.
 *  PART 3 — frontend command center reads from the aggregator and
 *           renders every required section (A–H).
 *  PART 4 — personal vs team behavior.
 *  PART 5 — role-aware quick actions.
 *  PART 6 — no fake metrics, no decorative widgets, no fabricated
 *           data.
 *  PART 7 — /dashboard top-level redirect (Phase 32.8B) preserved;
 *           sub-routes remain accessible as orphan admin surfaces
 *           pending Phase 32.8D migration; not surfaced in nav.
 *  PART 8 — runtime details link to Platform Health rather than
 *           being duplicated on /home.
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

const ROUTE = readApi("src/routes/dashboard.routes.ts");
const SERVICE = readApi("src/services/dashboard/command-center.service.ts");
const SERVER = readApi("src/server.ts");
const CC = readWeb("components/command-center/CommandCenter.tsx");
const CC_TYPES = readWeb("components/command-center/types.ts");
const HOME = readWeb("app/(app)/home/page.tsx");
const NAV_CONFIG = readWeb("lib/navigation-config.ts");

// =============================================================================
// PART 1 — Backend aggregator endpoint
// =============================================================================

describe("Phase 32.8C — `/v1/dashboard/command-center` aggregator endpoint", () => {
  it("registers GET /v1/dashboard/command-center", () => {
    expect(ROUTE).toMatch(
      /app\.get\(\s*"\/v1\/dashboard\/command-center"/,
    );
  });

  it("requires authentication (requireAuth preHandler)", () => {
    expect(ROUTE).toMatch(/preHandler:\s*requireAuth/);
  });

  it("enforces ACTIVE workspace membership (404 on non-member, 403 on inactive)", () => {
    expect(ROUTE).toMatch(/requireMember\(/);
    expect(ROUTE).toMatch(/code\(404\)\.send\(\{\s*error:\s*\{\s*code:\s*"not_found"/);
    expect(ROUTE).toMatch(/membership\.status\s*!==\s*"ACTIVE"/);
  });

  it("only handles GET — no POST/PUT/DELETE mutators", () => {
    expect(ROUTE).not.toMatch(/app\.post\(/);
    expect(ROUTE).not.toMatch(/app\.put\(/);
    expect(ROUTE).not.toMatch(/app\.delete\(/);
    expect(ROUTE).not.toMatch(/app\.patch\(/);
  });

  it("does NOT call the audit middleware or audit helpers (loading the dashboard is not an auditable event)", () => {
    // Bounded list of audit-emitter symbols that must NOT appear in
    // the dashboard route or service.
    const forbidden = [
      /auditEvidenceAction\(/,
      /auditMiddleware\(/,
      /emitSecurityEvent\(/,
      /writeAuditEvent\(/,
      /writeAnalyticsEvent\(/,
    ];
    for (const re of forbidden) {
      expect(ROUTE, `route must not call ${re}`).not.toMatch(re);
      expect(SERVICE, `service must not call ${re}`).not.toMatch(re);
    }
  });

  it("is registered in services/api/src/server.ts", () => {
    expect(SERVER).toMatch(/import \{ dashboardRoutes \}/);
    expect(SERVER).toMatch(/app\.register\(dashboardRoutes\)/);
  });
});

// =============================================================================
// PART 2 — Service layer composition
// =============================================================================

describe("Phase 32.8C — service layer composition", () => {
  it("exports buildCommandCenter as the canonical entrypoint", () => {
    expect(SERVICE).toMatch(/export async function buildCommandCenter\(/);
  });

  it("runs every section in parallel with Promise.all so one section's latency does not block others", () => {
    expect(SERVICE).toMatch(/Promise\.all\(\s*\[/);
  });

  it("each section runner wraps its body in try/catch (partial-failure tolerant)", () => {
    // Phase 32.8C full rebuild — the runner set now covers operational
    // pressure, case ops, reviewer orchestration, pipeline detail,
    // governance, organizational intelligence, timeline, audit
    // readiness, plus the preserved auxiliary runners.
    const runners = [
      "runOperationalPressure",
      "runCaseOperations",
      "runReviewerOrchestration",
      "runPipelineDetail",
      "runGovernancePosture",
      "runOrganizationalIntelligence",
      "runTimeline",
      "runAuditReadiness",
      "runRecentEvidence",
      "runIncidents",
      "runLegacyPipelineSummary",
      "runLegacyReviewerWorkload",
    ];
    for (const name of runners) {
      const idx = SERVICE.indexOf(`async function ${name}`);
      expect(idx, `runner ${name} not found`).toBeGreaterThan(-1);
      const next = SERVICE.indexOf("\n}\n", idx);
      const body = SERVICE.slice(idx, next > idx ? next : idx + 6000);
      expect(body, `runner ${name} missing try`).toMatch(/try\s*\{/);
      expect(body, `runner ${name} missing catch`).toMatch(/catch\s*[\(\{]/);
    }
  });

  it("declares bounded limits (no `take` left unbounded)", () => {
    // Phase 32.8C full rebuild — bounded limits per the new section catalog.
    expect(SERVICE).toMatch(/RECENT_EVIDENCE_LIMIT\s*=\s*8/);
    expect(SERVICE).toMatch(/INCIDENTS_LIMIT\s*=\s*10/);
    expect(SERVICE).toMatch(/PRESSURE_TOTAL\s*=\s*32/);
    expect(SERVICE).toMatch(/PRESSURE_PER_KIND\s*=\s*6/);
    expect(SERVICE).toMatch(/TOP_CASES_LIMIT\s*=\s*8/);
    expect(SERVICE).toMatch(/TOP_REVIEWERS_LIMIT\s*=\s*8/);
    expect(SERVICE).toMatch(/TIMELINE_LIMIT\s*=\s*30/);
    const findMany = SERVICE.match(/\.findMany\(\{[\s\S]*?\}\)/g) ?? [];
    expect(findMany.length).toBeGreaterThanOrEqual(10);
    for (const block of findMany) {
      expect(block, `unbounded findMany: ${block.slice(0, 80)}`).toMatch(/take:/);
    }
  });

  it("personal-workspace reviewer/governance sections return `not_applicable` instead of broken data", () => {
    // The new runners are `runReviewerOrchestration` + `runGovernancePosture`.
    const reviewerIdx = SERVICE.indexOf(
      "async function runReviewerOrchestration",
    );
    const reviewerEnd = SERVICE.indexOf("\n}\n", reviewerIdx);
    const reviewerBody = SERVICE.slice(reviewerIdx, reviewerEnd);
    expect(reviewerBody).toMatch(/scope === "PERSONAL"/);
    expect(reviewerBody).toMatch(/status:\s*"not_applicable"/);

    const govIdx = SERVICE.indexOf("async function runGovernancePosture");
    const govEnd = SERVICE.indexOf("\n}\n", govIdx);
    const govBody = SERVICE.slice(govIdx, govEnd);
    expect(govBody).toMatch(/scope === "PERSONAL"/);
    expect(govBody).toMatch(/status:\s*"not_applicable"/);
  });

  it("envelope shape exposes the canonical sections including the Phase 32.8C full-rebuild sections", () => {
    for (const section of [
      "summary",
      "operationalPressure",
      "attentionQueue",
      "caseOperations",
      "reviewerOrchestration",
      "pipelineDetail",
      "governancePosture",
      "organizationalIntelligence",
      "timeline",
      "auditReadiness",
      "recentEvidence",
      "pipeline",
      "reviewerWorkload",
      "incidents",
    ]) {
      expect(SERVICE).toMatch(new RegExp(`${section}:\\s*\\{`));
    }
  });

  it("detectWorkspaceScope marks single-member workspaces as PERSONAL and multi-member as TEAM", () => {
    expect(SERVICE).toMatch(
      /scope:\s*memberCount\s*<=\s*1\s*\?\s*"PERSONAL"\s*:\s*"TEAM"/,
    );
  });
});

// =============================================================================
// PART 3 — Frontend command center renders every required section
// =============================================================================

describe("Phase 32.8C — frontend command center renders all 8 mandatory operational sections (Full Rebuild)", () => {
  it("exports CommandCenter as the canonical /home renderer", () => {
    expect(CC).toMatch(/export function CommandCenter\(\)/);
    expect(HOME).toMatch(
      /import\s*\{\s*CommandCenter\s*\}\s*from\s*"[^"]*components\/command-center\/CommandCenter"/,
    );
    expect(HOME).toMatch(/<CommandCenter\s*\/>/);
  });

  it("renders the 8 mandatory operational sections (operational pressure, case ops, reviewer orchestration, pipeline detail, governance posture, organizational intelligence, timeline, audit readiness) plus auxiliary surfaces", () => {
    for (const fn of [
      "SummaryStrip",
      "OperationalPressureSection",
      "CaseOperationsSection",
      "ReviewerOrchestrationSection",
      "PipelineDetailSection",
      "GovernancePostureSection",
      "OrganizationalIntelligenceSection",
      "TimelineSection",
      "AuditReadinessSection",
      "RecentEvidenceSection",
      "IncidentsSection",
      "QuickActions",
    ]) {
      expect(CC, `section component ${fn} missing`).toMatch(
        new RegExp(`function ${fn}\\(`),
      );
    }
  });

  it("Platform Impact Banner reuses the canonical RuntimeStatusBanner with bounded forDomains scoping (not a duplicate runtime view)", () => {
    expect(CC).toMatch(/RuntimeStatusBanner/);
    expect(CC).toMatch(/forDomains=\{\[/);
    expect(CC).toMatch(/"core_evidence"/);
    expect(CC).toMatch(/"governance_lifecycle"/);
    expect(CC).toMatch(/"reviewer_ops"/);
  });

  it("fetches from `/v1/dashboard/command-center` with the active workspace id", () => {
    expect(CC).toMatch(/\/v1\/dashboard\/command-center/);
    expect(CC).toMatch(/encodeURIComponent\(workspace\.workspaceId\)/);
  });

  it("renders per-section status states (ok / degraded / unavailable / not_applicable)", () => {
    expect(CC).toMatch(/function SectionNote\(/);
    expect(CC).toMatch(/function PersonalNote\(/);
    expect(CC_TYPES).toMatch(
      /SectionStatus =\s*\|\s*"ok"\s*\|\s*"degraded"\s*\|\s*"unavailable"\s*\|\s*"not_applicable"/,
    );
  });

  it("provides distinct loading / empty / error / no-workspace / auth-error states (no infinite loaders)", () => {
    for (const fn of [
      "CommandCenterLoading",
      "NoWorkspaceState",
      "AuthErrorState",
      "UnavailableState",
    ]) {
      expect(CC, `${fn} missing`).toMatch(new RegExp(`function ${fn}\\(`));
    }
  });
});

// =============================================================================
// PART 4 — Personal vs team behavior
// =============================================================================

describe("Phase 32.8C — personal vs team workspace behavior", () => {
  it("personal workspace shows neutral 'basic evidence controls' note for reviewer + governance — never broken team widgets", () => {
    expect(CC).toMatch(
      /Personal workspace uses basic evidence controls/,
    );
    // The note explicitly covers BOTH reviewer and governance.
    expect(CC).toMatch(/Reviewer orchestration is a team workspace feature/);
    expect(CC).toMatch(/Governance posture is a team workspace feature/);
  });

  it("summary strip hides team-only metrics (reviewer pending, governance attention) when workspace is personal", () => {
    const summary = CC.slice(CC.indexOf("function SummaryStrip"));
    expect(summary).toMatch(/visible:\s*isTeam/);
  });

  it("Reviewer Orchestration section short-circuits on `not_applicable` (no broken zero-state)", () => {
    const block = CC.slice(CC.indexOf("function ReviewerOrchestrationSection"));
    expect(block).toMatch(/section\.status === "not_applicable"/);
  });

  it("Governance Posture section short-circuits on `not_applicable` (no broken zero-state)", () => {
    const block = CC.slice(CC.indexOf("function GovernancePostureSection"));
    expect(block).toMatch(/section\.status === "not_applicable"/);
  });

  it("workspace.scope is surfaced via a stable data attribute (data-cc-workspace-scope)", () => {
    expect(CC).toMatch(/data-cc-workspace-scope=\{workspace\.scope\}/);
  });
});

// =============================================================================
// PART 5 — Role-aware quick actions
// =============================================================================

describe("Phase 32.8C — role-aware quick actions (Section H)", () => {
  it("Capture action requires a mutation-capable role (canMutate)", () => {
    const block = CC.slice(CC.indexOf("function QuickActions"));
    expect(block).toMatch(/id:\s*"capture"[\s\S]{0,200}visible:\s*canMutate/);
  });

  it("Create Case action requires a mutation-capable role", () => {
    const block = CC.slice(CC.indexOf("function QuickActions"));
    expect(block).toMatch(/id:\s*"cases"[\s\S]{0,200}visible:\s*canMutate/);
  });

  it("Review queue action requires team workspace", () => {
    const block = CC.slice(CC.indexOf("function QuickActions"));
    expect(block).toMatch(/id:\s*"reviewer-ops"[\s\S]{0,200}visible:\s*isTeam/);
  });

  it("Governance hub action requires team workspace AND admin-class role", () => {
    const block = CC.slice(CC.indexOf("function QuickActions"));
    expect(block).toMatch(
      /id:\s*"governance"[\s\S]{0,400}visible:\s*isTeam[\s\S]{0,200}OWNER[\s\S]{0,100}ADMIN/,
    );
  });

  it("canMutate excludes VIEWER (read-only role)", () => {
    // canMutate is true for OWNER / ADMIN / MEMBER / REVIEWER.
    // VIEWER is intentionally absent — guard the literal string
    // "VIEWER" (with quotes) so REVIEWER doesn't accidentally
    // satisfy the pattern. Allow whitespace between `canMutate =`
    // and the `role ===` chain (the formatter may break across
    // multiple lines).
    const m = CC.match(/canMutate\s*=\s*[\s\S]{0,300}role\s*===\s*"[A-Z]+"/);
    expect(m, "canMutate definition not found").toBeTruthy();
    const block = m![0];
    expect(block).toContain('"OWNER"');
    expect(block).toContain('"ADMIN"');
    expect(block).toContain('"MEMBER"');
    expect(block).toContain('"REVIEWER"');
    expect(block).not.toContain('"VIEWER"');
  });
});

// =============================================================================
// PART 6 — No fake metrics, no decorative widgets, no fabricated data
// =============================================================================

describe("Phase 32.8C — no fake metrics, no decorative charts, no fabricated data", () => {
  it("frontend source contains no hardcoded numeric metrics (no `value: 42`, etc.)", () => {
    // The Command Center never hardcodes a metric value. Counts
    // come from envelope.data only. Spot-check: no literal
    // numeric value fields in section data.
    const numericLiteralValue = /\bvalue:\s*\d{2,}\b/.exec(CC);
    if (numericLiteralValue) {
      expect(
        false,
        `unexpected hardcoded numeric metric: ${numericLiteralValue[0]} — every value must come from envelope.data`,
      ).toBe(true);
    }
  });

  it("frontend source does not import a charting library (no fake graphs)", () => {
    const banned = [
      /from\s+"chart\.js"/,
      /from\s+"recharts"/,
      /from\s+"d3"/,
      /from\s+"victory"/,
      /from\s+"@nivo\//,
    ];
    for (const re of banned) {
      expect(CC, `forbidden charting import: ${re}`).not.toMatch(re);
    }
  });

  it("frontend source does not contain marketing copy patterns from the old /home", () => {
    // The Phase 32.8B audit found wording like "ready for action",
    // "Trusted chain of custody", "Workspace flow" — those are
    // marketing copy. The Command Center removes them.
    for (const phrase of [
      "ready for action",
      "Trusted chain of custody",
      "Capture → Sign → Report → Share",
      "Workspace flow",
    ]) {
      expect(
        CC,
        `marketing copy "${phrase}" must not appear in CommandCenter`,
      ).not.toContain(phrase);
      expect(
        HOME,
        `marketing copy "${phrase}" must not appear in /home/page.tsx`,
      ).not.toContain(phrase);
    }
  });

  it("every numeric tile and summary card binds to a backend-provided field", () => {
    // Confirm we read fields like `d.evidenceActiveCount`, not
    // `Math.random()` or `Date.now() % N`.
    expect(CC).not.toMatch(/Math\.random/);
    expect(CC).not.toMatch(/Date\.now\(\)\s*%/);
    // Phase 32.8C Full Rebuild — the canonical envelope fields the
    // new sections bind to.
    for (const field of [
      "evidenceActiveCount",
      "reportReadyCount",
      "reviewerPendingCount",
      "governanceAttentionCount",
      "openIncidentsCount",
      "operationalPressureCount",
      "auditReadinessFlags",
      "queueDepth",
      "overdueCount",
      "openEscalationsCount",
      "completedLast7dCount",
      "completedPrev7dCount",
      "inactiveReviewerCount",
      "activeLegalHoldsCount",
      "retentionCandidatesCount",
      "blockedExportsCount",
      "evidenceCreatedLast24h",
      "evidenceCreatedLast7d",
    ]) {
      expect(CC, `field ${field} missing in CommandCenter`).toContain(field);
    }
  });
});

// =============================================================================
// PART 7 — /dashboard redirect + sub-route disposition
// =============================================================================

describe("Phase 32.8C — old /dashboard surface disposition", () => {
  it("/dashboard top-level redirect to /home is preserved (Phase 32.8B)", () => {
    const dashboardPage = readWeb("app/(app)/dashboard/page.tsx");
    expect(dashboardPage).toMatch(
      /import\s*\{\s*redirect\s*\}\s*from\s*"next\/navigation"/,
    );
    expect(dashboardPage).toMatch(/redirect\("\/home"\)/);
  });

  it("/dashboard/api-keys remains accessible (real admin functionality — Phase 32.8D will migrate)", () => {
    const apiKeys = readWeb("app/(app)/dashboard/api-keys/page.tsx");
    // The page is NOT a redirect — it still hosts the real admin UI.
    expect(apiKeys).not.toMatch(
      /^import\s*\{\s*redirect\s*\}\s*from\s*"next\/navigation"/m,
    );
  });

  it("/dashboard/quotas remains accessible (real billing-aware functionality — Phase 32.8D will migrate)", () => {
    const quotas = readWeb("app/(app)/dashboard/quotas/page.tsx");
    expect(quotas).not.toMatch(
      /^import\s*\{\s*redirect\s*\}\s*from\s*"next\/navigation"/m,
    );
  });

  it("/dashboard/insights remains accessible (real /v1/insights backed — Phase 32.8D will decide canonical home)", () => {
    const insights = readWeb("app/(app)/dashboard/insights/page.tsx");
    expect(insights).not.toMatch(
      /^import\s*\{\s*redirect\s*\}\s*from\s*"next\/navigation"/m,
    );
  });

  it("/dashboard/batch-analysis remains accessible (real evidence batching — Phase 32.8D will fold into evidence flows)", () => {
    const batch = readWeb("app/(app)/dashboard/batch-analysis/page.tsx");
    expect(batch).not.toMatch(
      /^import\s*\{\s*redirect\s*\}\s*from\s*"next\/navigation"/m,
    );
  });

  it("none of the /dashboard sub-routes are referenced in the canonical navigation config", () => {
    // No href to /dashboard/* in the Phase 32.8B sidebar.
    expect(NAV_CONFIG).not.toMatch(/href:\s*"\/dashboard\/api-keys"/);
    expect(NAV_CONFIG).not.toMatch(/href:\s*"\/dashboard\/quotas"/);
    expect(NAV_CONFIG).not.toMatch(/href:\s*"\/dashboard\/insights"/);
    expect(NAV_CONFIG).not.toMatch(/href:\s*"\/dashboard\/batch-analysis"/);
  });
});

// =============================================================================
// PART 8 — Runtime details link to Platform Health, not duplicated on /home
// =============================================================================

describe("Phase 32.8C — runtime details delegate to Platform Health", () => {
  it("Incidents section links out to /ops or /ops/observability for full details (no duplicated runtime panel)", () => {
    const block = CC.slice(CC.indexOf("function IncidentsSection"));
    expect(block).toMatch(/Operations Center/);
    expect(block).toMatch(/href="\/ops/);
  });

  it("Incidents 'detailed platform health' footnote points at /ops (Phase 32.8A boundary preserved)", () => {
    expect(CC).toMatch(
      /Detailed platform health lives under[\s\S]{0,80}Operations Center/,
    );
  });

  it("CommandCenter does NOT render the Phase 28-J /admin/runtime panels inline (no duplication of /ops)", () => {
    // Bounded list of admin-runtime widgets that must NOT be rendered
    // inline by the Command Center.
    expect(CC).not.toMatch(/AdminRuntimeReadinessPanel/);
    expect(CC).not.toMatch(/AdminRuntimeQueuesPanel/);
    expect(CC).not.toMatch(/AdminRuntimeWorkersPanel/);
    expect(CC).not.toMatch(/AdminRuntimeMigrationsPanel/);
  });
});

// =============================================================================
// PART 9 — Read-only contract (no mutation / no audit / no expensive operations)
// =============================================================================

describe("Phase 32.8C — read-only / no-side-effects contract", () => {
  it("service does NOT call any Prisma write methods (no .create / .update / .delete / .upsert / .createMany)", () => {
    for (const re of [
      /prisma\.[a-zA-Z]+\.create\(/,
      /prisma\.[a-zA-Z]+\.createMany\(/,
      /prisma\.[a-zA-Z]+\.update\(/,
      /prisma\.[a-zA-Z]+\.updateMany\(/,
      /prisma\.[a-zA-Z]+\.delete\(/,
      /prisma\.[a-zA-Z]+\.deleteMany\(/,
      /prisma\.[a-zA-Z]+\.upsert\(/,
    ]) {
      expect(SERVICE, `service must not call ${re}`).not.toMatch(re);
    }
  });

  it("service does NOT invoke report / package / TSA / custody / OTS / billing engines", () => {
    // These are exact module/symbol names from the audit; the
    // dashboard MUST NOT touch them.
    const forbiddenSymbols = [
      "renderReport",
      "buildVerificationPackage",
      "buildReportPackage",
      "stampWithTsa",
      "appendCustodyEvent",
      "openTimestamp",
      "computeBillingCharge",
      "chargeBilling",
    ];
    for (const sym of forbiddenSymbols) {
      expect(
        SERVICE,
        `service must not invoke ${sym}`,
      ).not.toContain(sym);
    }
  });

  it("envelope projects only counts + bounded titles — no raw file content / signed URLs / privileged legal text", () => {
    // Bounded list of fields that must NOT appear in the service
    // (they would be a leak vector).
    for (const sym of [
      "storageBucket",
      "storageKey",
      "presignedUrl",
      "signedUrl",
      "fileSha256:",
      "internalNotes",
    ]) {
      expect(
        SERVICE,
        `service must not project ${sym} in the dashboard envelope`,
      ).not.toContain(sym);
    }
  });
});

// =============================================================================
// PART 10 — Full Rebuild operational signals
// =============================================================================

describe("Phase 32.8C (Full Rebuild) — operational pressure aggregation", () => {
  it("operational pressure category enum covers the canonical SOC signals", () => {
    for (const category of [
      "overdue_review",
      "stalled_review",
      "unassigned_review",
      "open_escalation",
      "stuck_upload",
      "missing_report",
      "missing_package",
      "failed_report",
      "failed_package",
      "retry_storm",
      "policy_conflict",
      "evidence_no_case",
      "unsigned_evidence_old",
      "blocked_export",
      "operational_incident",
    ]) {
      expect(
        SERVICE,
        `operational pressure category ${category} missing`,
      ).toContain(`"${category}"`);
    }
  });

  it("operational pressure section carries severity counts (critical / high / warning / info)", () => {
    expect(SERVICE).toMatch(
      /counts:\s*\{[\s\S]{0,200}critical:[\s\S]{0,80}high:[\s\S]{0,80}warning:[\s\S]{0,80}info:/,
    );
  });

  it("declares stuck-upload + stalled-review + reviewer-inactivity thresholds (bounded operational windows)", () => {
    expect(SERVICE).toMatch(/STUCK_UPLOAD_HOURS\s*=\s*\d+/);
    expect(SERVICE).toMatch(/STALLED_REVIEW_HOURS\s*=\s*\d+/);
    expect(SERVICE).toMatch(/REVIEWER_INACTIVITY_HOURS\s*=\s*\d+/);
    expect(SERVICE).toMatch(/UNSIGNED_EVIDENCE_AGE_DAYS\s*=\s*\d+/);
    expect(SERVICE).toMatch(/RETRY_STORM_OCCURRENCE_THRESHOLD\s*=\s*\d+/);
  });

  it("missing-report + missing-package signals derive from real Prisma relations (no fabrication)", () => {
    expect(SERVICE).toMatch(/status:\s*"SIGNED",[\s\S]{0,80}reports:\s*\{\s*none:\s*\{\}\s*\}/);
    expect(SERVICE).toMatch(
      /status:\s*"REPORTED",[\s\S]{0,80}verificationPackages:\s*\{\s*none:\s*\{\}\s*\}/,
    );
  });

  it("retry-storm signal reads occurrenceCount from operationalIncident (real data)", () => {
    expect(SERVICE).toMatch(
      /occurrenceCount:\s*\{\s*gte:\s*RETRY_STORM_OCCURRENCE_THRESHOLD/,
    );
  });

  it("blocked-export signal reads verificationPackageMetadata.blocked === true (no fabrication)", () => {
    const m = SERVICE.match(/blocked === true/g) ?? [];
    expect(m.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Phase 32.8C (Full Rebuild) — case operations + reviewer orchestration + pipeline detail", () => {
  it("caseOperations envelope exposes the canonical investigation signals", () => {
    for (const field of [
      "activeCasesCount",
      "casesWithEvidenceGapsCount",
      "unreviewedEvidenceCount",
      "unlinkedEvidenceCount",
      "topCases",
    ]) {
      expect(SERVICE).toMatch(new RegExp(`${field}:`));
    }
  });

  it("reviewerOrchestration envelope exposes throughput delta + inactivity + queue depth", () => {
    for (const field of [
      "queueDepth",
      "dueSoonCount",
      "completedLast7dCount",
      "completedPrev7dCount",
      "inactiveReviewerCount",
      "topReviewers",
    ]) {
      expect(SERVICE).toMatch(new RegExp(`${field}:`));
    }
  });

  it("pipelineDetail envelope covers evidence + reports + packages + public-verify breakdown", () => {
    for (const field of [
      "evidence: {",
      "reports: {",
      "packages: {",
      "publicVerify: {",
      "stuckUploading",
      "missingFromSigned",
      "missingFromReported",
    ]) {
      expect(SERVICE).toContain(field);
    }
  });

  it("public-verify stage breakdown reads the real PublicVerifyState enum (PUBLISHED / UNPUBLISHED / SUSPENDED)", () => {
    expect(SERVICE).toMatch(/by:\s*\["publicVerifyState"\]/);
    expect(SERVICE).toContain('verifyCount("PUBLISHED")');
    expect(SERVICE).toContain('verifyCount("UNPUBLISHED")');
    expect(SERVICE).toContain('verifyCount("SUSPENDED")');
  });
});

describe("Phase 32.8C (Full Rebuild) — organizational intelligence + timeline + audit readiness", () => {
  it("organizationalIntelligence envelope exposes 24h + 7d throughput windows", () => {
    for (const field of [
      "evidenceCreatedLast24h",
      "evidenceCreatedLast7d",
      "evidenceFinalizedLast7d",
      "reportsGeneratedLast7d",
      "packagesGeneratedLast7d",
      "activityLast7d",
    ]) {
      expect(SERVICE).toMatch(new RegExp(`${field}:`));
    }
  });

  it("timeline kinds cover the canonical operational heartbeat events", () => {
    for (const kind of [
      "evidence_finalized",
      "report_generated",
      "package_generated",
      "lifecycle_transition",
      "hold_placed",
      "hold_released",
      "destruction_review",
      "escalation_opened",
      "incident_opened",
    ]) {
      expect(SERVICE).toContain(`"${kind}"`);
    }
  });

  it("timeline reads real-timestamp event sources (no synthetic events)", () => {
    expect(SERVICE).toMatch(/prisma\.report\.findMany/);
    expect(SERVICE).toMatch(/prisma\.verificationPackage\.findMany/);
    expect(SERVICE).toMatch(/prisma\.evidenceLifecycleEvent\.findMany/);
    expect(SERVICE).toMatch(/prisma\.reviewEscalation\.findMany/);
    expect(SERVICE).toMatch(/prisma\.operationalIncident\.findMany/);
  });

  it("auditReadiness counters bound to a fixed key catalog (no invented signals)", () => {
    for (const key of [
      "unsigned_evidence_old",
      "missing_reports",
      "failed_packages",
      "pending_governance_reviews",
      "unresolved_escalations",
      "evidence_pending_reviewer_signoff",
      "blocked_exports",
    ]) {
      expect(SERVICE).toContain(`"${key}"`);
    }
  });
});

describe("Phase 32.8C (Full Rebuild) — enterprise frontend hierarchy + empty states", () => {
  it("frontend uses operationally-credible empty-state copy (NOT 'Nothing needs attention 🙂')", () => {
    expect(CC).toContain("No operational pressure detected");
    expect(CC).toContain("No active investigations");
    expect(CC).toContain("All reviewer queues within SLA");
    expect(CC).toContain("No governance conflicts detected");
    expect(CC).toContain("No recent operational events");
    expect(CC).toContain("All audit-readiness signals nominal");
    // The forbidden chatty empty state must NEVER appear.
    expect(CC).not.toContain("Nothing needs attention");
  });

  it("operational pressure section is the page hero (rendered before grid sections)", () => {
    const pressureIdx = CC.indexOf("<OperationalPressureSection");
    const caseOpsIdx = CC.indexOf("<CaseOperationsSection");
    const reviewerIdx = CC.indexOf("<ReviewerOrchestrationSection");
    const pipelineIdx = CC.indexOf("<PipelineDetailSection");
    const governanceIdx = CC.indexOf("<GovernancePostureSection");
    const timelineIdx = CC.indexOf("<TimelineSection");
    const auditIdx = CC.indexOf("<AuditReadinessSection");
    expect(pressureIdx).toBeGreaterThan(0);
    expect(caseOpsIdx).toBeGreaterThan(pressureIdx);
    expect(reviewerIdx).toBeGreaterThan(pressureIdx);
    expect(pipelineIdx).toBeGreaterThan(pressureIdx);
    expect(governanceIdx).toBeGreaterThan(pressureIdx);
    expect(timelineIdx).toBeGreaterThan(pressureIdx);
    expect(auditIdx).toBeGreaterThan(pressureIdx);
  });

  it("pressure severity strip surfaces critical / high / warning / info pill counts", () => {
    expect(CC).toContain('data-cc-pressure-severity="critical"');
    expect(CC).toContain('data-cc-pressure-severity="high"');
    expect(CC).toContain('data-cc-pressure-severity="warning"');
    expect(CC).toContain('data-cc-pressure-severity="info"');
  });

  it("pipeline detail surfaces granular per-stage data attributes (evidence / reports / packages / public-verify)", () => {
    expect(CC).toContain("data-cc-pipeline-evidence");
    expect(CC).toContain("data-cc-pipeline-reports");
    expect(CC).toContain("data-cc-pipeline-packages");
    expect(CC).toContain("data-cc-pipeline-public-verify");
  });

  it("timeline surfaces a stable per-event data attribute", () => {
    expect(CC).toContain("data-cc-timeline-list");
    expect(CC).toContain("data-cc-timeline-kind=");
    expect(CC).toContain("data-cc-timeline-severity=");
  });

  it("audit-readiness section surfaces a stable per-counter data attribute", () => {
    expect(CC).toContain("data-cc-audit-list");
    expect(CC).toContain("data-cc-audit-key=");
  });

  it("never uses childish empty-state emoji ('🙂' / '🎉' / '👍' etc.) in operator-facing copy", () => {
    for (const emoji of ["🙂", "🎉", "👍", "✨", "🚀"]) {
      expect(CC, `forbidden emoji ${emoji} in operator copy`).not.toContain(emoji);
    }
  });
});
