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
  // Normalize CRLF to LF so source-text contract scans (e.g. `\n}\n`
  // boundary detection in PART 2) behave the same on Windows checkouts
  // as on POSIX CI runners.
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");
}
function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");
}

const ROUTE = readApi("src/routes/dashboard.routes.ts");
const SERVICE = readApi("src/services/dashboard/command-center.service.ts");
const SERVER = readApi("src/server.ts");
const CC = readWeb("components/command-center/CommandCenter.tsx");
const CC_TYPES = readWeb("components/command-center/types.ts");
const HOME = readWeb("app/(app)/home/page.tsx");
// Phase 38.6 — canonical navigation source of truth is the route
// registry (`lib/navigation/routeRegistry.ts`); the legacy
// `lib/navigation-config.ts` was deleted.
const NAV_CONFIG = readWeb("lib/navigation/routeRegistry.ts");

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

  it("detectWorkspaceScope uses the workspace's personal/team flag rather than member count", () => {
    expect(SERVICE).toMatch(
      /scope:\s*team\?\.isPersonal\s*===\s*true\s*\?\s*"PERSONAL"\s*:\s*"TEAM"/,
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
    // R1 Bug A — CommandCenter now reads the canonical activeSpace
    // (Personal Space OR Organization) via useActiveSpace() rather
    // than the legacy team-only workspace gate. The fetch URL is
    // therefore keyed by `activeSpace.id`.
    expect(CC).toMatch(/\/v1\/dashboard\/command-center/);
    // R8.1A — Part G narrowed `activeSpace.id` (which is `string | null`
    // for PERSONAL spaces) into a local `activeSpaceId` const before
    // using it in encodeURIComponent. The intent is preserved: the
    // canonical active-space id keys the fetch. Accept either pattern.
    expect(CC).toMatch(
      /encodeURIComponent\((?:activeSpace\.id|activeSpaceId)\)/,
    );
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
    expect(CC).toMatch(/Reviewer orchestration is a workspace feature/);
    expect(CC).toMatch(/Governance posture is a workspace feature/);
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

  it("Governance hub action gated by canonical canViewGovernance capability prop", () => {
    // Phase 32.8 Foundation cleanup — visibility uses the canonical
    // `canViewGovernance` prop (sourced from ctx.can("GOVERNANCE_VIEW"))
    // instead of inline role-string equality.
    const block = CC.slice(CC.indexOf("function QuickActions"));
    expect(block).toMatch(
      /id:\s*['"]governance['"][\s\S]{0,400}visible:\s*canViewGovernance/,
    );
  });

  // OBSOLETE — Phase 32.8 Foundation cleanup eliminated the
  // role-string equality chain in canMutate. It now reads from
  // canonical capabilities: ctx.can("CASES_MANAGE") || ctx.can("REVIEWER_OPS_ACT").
  // The VIEWER exclusion is enforced server-side in the capability
  // resolver and unit-tested in phase-32-8-foundation-cleanup.test.ts.
  it.skip("canMutate excludes VIEWER (read-only role)", () => {});
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
  it("/dashboard top-level redirect to /home is preserved (Phase 32.8B → CR1 Part 2 folded into next.config.js)", () => {
    // CR1 Part 2 moved the JSX-level redirect into next.config.js as a
    // canonical 308. End-user behavior is identical.
    const cfg = readWeb("next.config.js");
    expect(cfg).toMatch(/async\s+redirects\s*\(/);
    expect(cfg).toMatch(
      /source:\s*["']\/dashboard["'][\s\S]{0,200}destination:\s*["']\/home["']/,
    );
  });

  it("/dashboard/api-keys is retired (Phase Final-A3-PT2): page file deleted, URL redirects to canonical /integrations surface", () => {
    // Phase Final-A3-PT2 retired the legacy in-memory user-scoped API
    // key store; the canonical, team-scoped, durable surface is
    // `/integrations`. The Next.js page file was deleted and
    // `next.config.js` now declares a 308 redirect from
    // `/dashboard/api-keys` → `/integrations`. This test inverts the
    // original 32.8C assertion: the page MUST NOT exist as a file.
    const apiKeysFs = require("node:fs") as typeof import("node:fs");
    const apiKeysPath = require("node:url").fileURLToPath(
      new URL(
        "../../../apps/web/app/(app)/dashboard/api-keys/page.tsx",
        import.meta.url,
      ),
    );
    expect(apiKeysFs.existsSync(apiKeysPath)).toBe(false);
    // The canonical redirect must be present in next.config.js.
    const cfg = readWeb("next.config.js");
    expect(cfg).toMatch(
      /source:\s*["']\/dashboard\/api-keys["'][\s\S]{0,200}destination:\s*["']\/integrations["']/,
    );
  });

  it("/dashboard/quotas remains accessible (real billing-aware functionality — Phase 32.8D will migrate)", () => {
    const quotas = readWeb("app/(app)/operations/quotas/page.tsx");
    expect(quotas).not.toMatch(
      /^import\s*\{\s*redirect\s*\}\s*from\s*"next\/navigation"/m,
    );
  });

  it("/dashboard/insights was retired in Phase 6 — page file + registry entries removed", () => {
    // Phase 6 cleanup — the page used to call /v1/insights which never
    // had a backend route. The page is gone and the next.config.js
    // permanent redirect to /home covers any external link.
    expect(() => readWeb("app/(app)/dashboard/insights/page.tsx")).toThrow();
  });

  it("/dashboard/batch-analysis remains accessible (real evidence batching — Phase 32.8D will fold into evidence flows)", () => {
    const batch = readWeb("app/(app)/operations/batch-analysis/page.tsx");
    expect(batch).not.toMatch(
      /^import\s*\{\s*redirect\s*\}\s*from\s*"next\/navigation"/m,
    );
  });

  it("no /dashboard sub-route is surfaced in the canonical navigation registry", () => {
    // Phase 38.6 — repointed to routeRegistry.ts. `/dashboard/api-keys`
    // and `/dashboard/insights` were retired outright (redirect only) and
    // must not appear as routes at all.
    expect(NAV_CONFIG).not.toMatch(/href:\s*"\/dashboard\/api-keys"/);
    expect(NAV_CONFIG).not.toMatch(/href:\s*"\/dashboard\/insights"/);
    // `/dashboard/quotas` and `/dashboard/batch-analysis` DO have registry
    // entries (the live pages exist) but are intentionally kept out of
    // every discovery surface — never sidebar-eligible, command-palette,
    // or All Tools. Assert each entry declares all three visibility flags
    // false so it can never leak into navigation.
    for (const href of ["/operations/quotas", "/operations/batch-analysis"]) {
      const idx = NAV_CONFIG.indexOf(`href: "${href}"`);
      expect(idx, `routeRegistry missing entry for ${href}`).toBeGreaterThan(-1);
      // Slice from this entry's href to the end of its object literal.
      const entry = NAV_CONFIG.slice(idx, NAV_CONFIG.indexOf("\n  },", idx));
      expect(entry, `${href} must not be sidebar-eligible`).toMatch(
        /sidebarEligible:\s*false/,
      );
      expect(entry, `${href} must not be command-palette visible`).toMatch(
        /commandPaletteVisible:\s*false/,
      );
      expect(entry, `${href} must not be All Tools visible`).toMatch(
        /allToolsVisible:\s*false/,
      );
    }
  });
});

// =============================================================================
// PART 8 — Runtime details link to Platform Health, not duplicated on /home
// =============================================================================

describe("Phase 32.8C — runtime details delegate to Platform Health", () => {
  it("Incidents section links out to /operations or /operations/observability for full details (no duplicated runtime panel)", () => {
    const block = CC.slice(CC.indexOf("function IncidentsSection"));
    expect(block).toMatch(/Operations Center/);
    // Phase 3 canonicalised the platform-ops surface /ops → /operations.
    expect(block).toMatch(/href="\/operations/);
  });

  it("Incidents footnote points at /operations (Phase 32.8A boundary preserved)", () => {
    // Phase 32.8C control plane — the footnote was reworded to explain
    // that operator actions (acknowledge/assign/resolve/suppress) live
    // on the Operations Center page, not the dashboard. The boundary
    // is preserved (the link still points at /operations/observability;
    // Phase 3 canonicalised /ops → /operations).
    expect(CC).toMatch(
      /Operator actions[\s\S]{0,200}Operations Center/,
    );
    expect(CC).toMatch(/href="\/operations\/observability/);
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
    // envelope projection. `fileSha256` is intentionally permitted at
    // the Prisma query layer (groupBy / where) for duplicate-hash
    // clustering — Phase 32.8C++ — but the test still verifies it
    // never lands in a result-object literal that would expose the
    // raw hex to the envelope payload.
    for (const sym of [
      "storageBucket",
      "storageKey",
      "presignedUrl",
      "signedUrl",
      "internalNotes",
    ]) {
      expect(
        SERVICE,
        `service must not project ${sym} in the dashboard envelope`,
      ).not.toContain(sym);
    }
    // fileSha256 may only appear as a query-side `by`/`where` token
    // and as a 16-char prefix in cluster IDs — NEVER as a full
    // payload field on a returned object (e.g., `fileSha256: row.fileSha256`).
    expect(SERVICE).not.toMatch(/fileSha256:\s*row\.fileSha256/);
    expect(SERVICE).not.toMatch(/fileSha256:\s*r\.fileSha256/);
    expect(SERVICE).not.toMatch(/fileSha256:\s*e\.fileSha256/);
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

// =============================================================================
// PART 11 — Phase 32.8C+ Operational Intelligence Engine
// =============================================================================

describe("Phase 32.8C+ — Operational routing catalog", () => {
  it("declares the bounded ReasonCode enum covering every required signal", () => {
    for (const reason of [
      "REVIEW_OVERDUE",
      "REVIEW_DUE_SOON",
      "REVIEW_UNASSIGNED",
      "REVIEW_STALLED",
      "REVIEWER_INACTIVE",
      "REVIEWER_OVERLOADED",
      "CASE_AT_RISK",
      "CASE_EVIDENCE_GAP",
      "EVIDENCE_STUCK_UPLOAD",
      "EVIDENCE_UNSIGNED_TOO_LONG",
      "EVIDENCE_NO_CASE",
      "REPORT_MISSING",
      "REPORT_FAILED",
      "PACKAGE_MISSING",
      "PACKAGE_FAILED",
      "PACKAGE_BLOCKED_BY_GOVERNANCE",
      "EXPORT_BLOCKED_BY_GOVERNANCE",
      "GOVERNANCE_CONFLICT",
      "LEGAL_HOLD_ACTIVE",
      "RETENTION_REVIEW_DUE",
      "DESTRUCTION_REVIEW_PENDING",
      "QUEUE_CONGESTION",
      "RETRY_STORM",
      "OPERATIONAL_INCIDENT",
      "INTEGRITY_REVIEW_REQUIRED",
      "INTEGRITY_FAILED",
      "CUSTODY_GAP",
      "ACCESS_ANOMALY",
    ]) {
      expect(SERVICE, `ReasonCode ${reason} missing`).toContain(`"${reason}"`);
    }
  });

  it("declares OperationalDomain + AffectedEntityType bounded enums", () => {
    for (const domain of [
      "review_ops",
      "evidence_pipeline",
      "reports",
      "packages",
      "governance",
      "custody_integrity",
      "security_access",
      "operational_health",
      "case_ops",
    ]) {
      expect(SERVICE).toContain(`"${domain}"`);
    }
    for (const t of [
      "evidence",
      "review_workflow",
      "escalation",
      "case",
      "case_hold",
      "evidence_hold",
      "incident",
      "destruction_review",
      "policy",
      "security_event",
    ]) {
      expect(SERVICE).toContain(`"${t}"`);
    }
  });

  it("ROUTING_CATALOG enriches every pressure category with reasonCode + recommendedAction + primaryRoute", () => {
    expect(SERVICE).toMatch(
      /const ROUTING_CATALOG:\s*Record<\s*OperationalPressureItem\["category"\],\s*RoutingMeta\s*>/,
    );
    // Sample a few key entries.
    expect(SERVICE).toMatch(/overdue_review:\s*\{[\s\S]{0,400}reasonCode:\s*"REVIEW_OVERDUE"/);
    expect(SERVICE).toMatch(/missing_report:\s*\{[\s\S]{0,400}reasonCode:\s*"REPORT_MISSING"/);
    expect(SERVICE).toMatch(/blocked_export:\s*\{[\s\S]{0,500}reasonCode:\s*"EXPORT_BLOCKED_BY_GOVERNANCE"/);
  });

  it("enrichPressureItems is the single point of routing-field assignment", () => {
    expect(SERVICE).toMatch(/function enrichPressureItems\(/);
    // The routing-queue view sources from `pressure.items` already
    // enriched — confirms a single canonical enrichment path.
    expect(SERVICE).toMatch(/routingQueueItems = pressure\.items[\s\S]{0,200}filter/);
  });
});

describe("Phase 32.8C+ — Investigation Intelligence engine", () => {
  it("exports runInvestigationIntelligence + per-case risk scoring", () => {
    expect(SERVICE).toMatch(/async function runInvestigationIntelligence\(/);
    expect(SERVICE).toMatch(/InvestigationRiskItem/);
    expect(SERVICE).toMatch(/InvestigationRiskLevel/);
  });

  it("risk levels are bounded (CRITICAL / HIGH / MEDIUM / LOW / NONE)", () => {
    expect(SERVICE).toMatch(
      /InvestigationRiskLevel\s*=[\s\S]{0,200}"CRITICAL"[\s\S]{0,80}"HIGH"[\s\S]{0,80}"MEDIUM"[\s\S]{0,80}"LOW"[\s\S]{0,80}"NONE"/,
    );
  });

  it("risk reason codes come from real DB-derivable signals", () => {
    // Bounded set of reason codes that the investigation engine emits.
    for (const code of [
      "CASE_NO_EVIDENCE",
      "OPEN_ESCALATIONS",
      "OVERDUE_REVIEWS",
      "PACKAGE_BLOCKED",
      "MISSING_REPORTS",
      "ACTIVE_HOLD_STALE",
    ]) {
      expect(SERVICE).toContain(`"${code}"`);
    }
  });

  it("cross-case signals: evidence-in-multiple-cases is now CLOSED (Phase 32.8C+++++); only cross_case_same_submitter remains unsupported", () => {
    // Phase 32.8C+++++ — CaseEvidenceLink schema closes the many-to-many
    // gap. The runCrossCaseIntelligenceV2 engine reads from this table.
    // The catalog string "cross_case_evidence_linkage" may still appear
    // in a comment explaining that it's CLOSED, but it MUST NOT appear
    // as an unsupportedSignals push entry.
    expect(SERVICE).not.toMatch(
      /unsupportedSignals\.push\([^)]*cross_case_evidence_linkage/,
    );
    expect(SERVICE).not.toMatch(
      /unsupportedSignals:\s*\[[^\]]*cross_case_evidence_linkage/,
    );
    expect(SERVICE).not.toMatch(/Evidence has a singular caseId column/);
    expect(SERVICE).toMatch(/cross_case_same_submitter/);
  });

  it("recommendedAction is a bounded operator string (not marketing copy)", () => {
    // Verify the engine surfaces bounded action copy.
    expect(SERVICE).toMatch(
      /Triage the open escalation/,
    );
    expect(SERVICE).toMatch(
      /Reassign or complete the overdue review/,
    );
    expect(SERVICE).toMatch(
      /Link evidence to this case/,
    );
  });
});

describe("Phase 32.8C+ — Queue Congestion engine", () => {
  it("queue congestion exposes a bounded queueId enum", () => {
    for (const q of [
      "review_queue",
      "report_queue_pending",
      "package_queue_pending",
      "destruction_review_queue",
      "escalation_queue",
    ]) {
      expect(SERVICE).toContain(`"${q}"`);
    }
  });

  it("queue congestion explicitly marks BullMQ infra queues as unsupported", () => {
    expect(SERVICE).toContain(
      "bullmq_infra_queues (BullMQ queue depth is in-memory; no DB snapshot)",
    );
    expect(SERVICE).toContain(
      "worker_stalled_jobs (worker stall signal lives in the worker process, not DB)",
    );
  });

  it("review queue depth derives from real Prisma queries (no fabrication)", () => {
    expect(SERVICE).toMatch(
      /prisma\.evidenceReviewWorkflow\.count\(\{[\s\S]{0,80}status:\s*"QUEUED"/,
    );
  });

  it("report + package queue pending derive from real evidence/Report/VerificationPackage relations", () => {
    expect(SERVICE).toMatch(
      /status:\s*"SIGNED",\s*reports:\s*\{\s*none:\s*\{\}\s*\}/,
    );
    expect(SERVICE).toMatch(
      /status:\s*"REPORTED",[\s\S]{0,80}verificationPackages:\s*\{\s*none:\s*\{\}\s*\}/,
    );
  });
});

describe("Phase 32.8C+ — Custody / Integrity Anomaly engine", () => {
  it("exposes a bounded integrity reasonCode set", () => {
    for (const r of [
      "INTEGRITY_REVIEW_REQUIRED",
      "INTEGRITY_FAILED",
      "PACKAGE_BUT_NO_REPORT",
      "PACKAGE_BLOCKED",
    ]) {
      expect(SERVICE).toContain(`"${r}"`);
    }
  });

  it("uses the real verificationStatus enum (REVIEW_REQUIRED / FAILED) — does NOT recompute hashes from the dashboard", () => {
    expect(SERVICE).toMatch(
      /verificationStatus:\s*\{\s*in:\s*\["REVIEW_REQUIRED",\s*"FAILED"\]/,
    );
    // The engine MUST NOT call hash/signature compute logic.
    expect(SERVICE).not.toContain("recomputeHash");
    expect(SERVICE).not.toContain("verifySignature");
  });

  it("marks deeper custody/TSA/OTS signals as unsupported with explicit reasons", () => {
    expect(SERVICE).toContain("custody_chain_hash_recompute");
    expect(SERVICE).toContain("tsa_signal_unavailable");
    expect(SERVICE).toContain("ots_signal_unavailable");
    expect(SERVICE).toContain("signature_mismatch");
  });

  it("never makes legal-admissibility / authenticity claims in copy", () => {
    // Custody section copy must use bounded language.
    expect(SERVICE).toMatch(/operator-side review/);
    for (const banned of [
      "legally admissible",
      "court-ready",
      "proves authenticity",
      "verified as real",
    ]) {
      expect(SERVICE, `forbidden phrase ${banned}`).not.toContain(banned);
    }
  });
});

describe("Phase 32.8C+ — Access / Security Anomaly engine", () => {
  it("reads ONLY real SecurityEvent rows filtered to WARNING|HIGH in last 24h", () => {
    expect(SERVICE).toMatch(
      /prisma\.securityEvent\.findMany\(\{[\s\S]{0,400}severity:\s*\{\s*in:\s*\["WARNING",\s*"HIGH"\]/,
    );
  });

  it("marks AccessAnomaly classifier + failed-login burst as unsupported with reasons", () => {
    expect(SERVICE).toContain("access_anomaly_classifier");
    expect(SERVICE).toContain("failed_login_burst");
  });

  it("never invents security events when SecurityEvent rows are absent", () => {
    // Locate the function and bound the slice generously — TypeScript
    // formatter may emit `})` patterns that match the `\n}\n` anchor
    // before the actual function close.
    const idx = SERVICE.indexOf("async function runAccessSecurityAnomalies");
    expect(idx).toBeGreaterThan(-1);
    const body = SERVICE.slice(idx, idx + 4000);
    // Body MUST source items from a real Prisma findMany on
    // SecurityEvent — not from a synthesized list.
    expect(body).toMatch(/prisma\.securityEvent\.findMany/);
    // Empty-list fallback: when query returns 0 rows the items array
    // is `[]`, never invented data.
    expect(body).not.toMatch(/\bsynth\b/i);
    expect(body).not.toMatch(/\bfake\b/i);
  });
});

describe("Phase 32.8C+ — Workload Engine", () => {
  it("workload health enum is bounded (HEALTHY / WATCH / DEGRADED / CRITICAL)", () => {
    expect(SERVICE).toMatch(
      /WorkloadHealth\s*=[\s\S]{0,80}"HEALTHY"[\s\S]{0,40}"WATCH"[\s\S]{0,40}"DEGRADED"[\s\S]{0,40}"CRITICAL"/,
    );
  });

  it("saturation score is computed from real assigned + overdue counts", () => {
    expect(SERVICE).toMatch(
      /saturationScore\s*=\s*Math\.min\(\s*10,\s*Math\.round\(g\._count\._all\s*\+\s*overdue\s*\*\s*1\.5\)/,
    );
  });

  it("bottleneck detection uses thresholded counts, not arbitrary classification", () => {
    expect(SERVICE).toMatch(/saturationScore\s*>=\s*8\s*\|\|\s*overdue\s*>=\s*4/);
  });

  it("personal-workspace short-circuits to not_applicable + HEALTHY (no broken team workload)", () => {
    expect(SERVICE).toMatch(
      /scope === "PERSONAL"[\s\S]{0,400}status:\s*"not_applicable"[\s\S]{0,200}health:\s*"HEALTHY"/,
    );
  });
});

describe("Phase 32.8C+ — Envelope contract + unsupportedSignals catalog", () => {
  it("envelope adds the 7 new intelligence sections", () => {
    for (const section of [
      "investigationIntelligence",
      "routingQueue",
      "queueCongestion",
      "custodyIntegrityAnomalies",
      "accessSecurityAnomalies",
      "workloadEngine",
      "timelineIntelligence",
      "pipelineIntelligence",
    ]) {
      expect(SERVICE).toMatch(new RegExp(`${section}:\\s*\\{`));
    }
  });

  it("every intelligence section ships SectionMeta (status + warnings + unsupportedSignals + sourceSummary)", () => {
    expect(SERVICE).toMatch(/type SectionMeta\s*=/);
    expect(SERVICE).toMatch(/warnings:\s*string\[\]/);
    expect(SERVICE).toMatch(/unsupportedSignals:\s*string\[\]/);
    expect(SERVICE).toMatch(/sourceSummary:\s*string\[\]/);
  });

  it("envelope exposes top-level unsupportedSignals catalog (signal + reason rows)", () => {
    expect(SERVICE).toMatch(
      /unsupportedSignals:\s*Array<\{\s*signal:\s*string;\s*reason:\s*string\s*\}>/,
    );
    expect(SERVICE).toMatch(/function buildUnsupportedSignalsCatalog\(/);
  });

  it("buildCommandCenter wires every new engine into the envelope", () => {
    const idx = SERVICE.indexOf("export async function buildCommandCenter");
    const end = SERVICE.length;
    const body = SERVICE.slice(idx, end);
    for (const runner of [
      "runInvestigationIntelligence",
      "runQueueCongestion",
      "runCustodyIntegrityAnomalies",
      "runAccessSecurityAnomalies",
      "runWorkloadEngine",
    ]) {
      expect(body, `buildCommandCenter must call ${runner}`).toContain(
        runner,
      );
    }
  });
});

describe("Phase 32.8C+ — Frontend command center renders the intelligence layer", () => {
  it("renders the new section components (Critical Bar / Routing Queue / Investigation Risk / Workload / Queue / Custody / Security / Unsupported)", () => {
    for (const fn of [
      "CriticalOperationsBar",
      "RoutingQueueSection",
      "InvestigationRiskBoard",
      "WorkloadEngineBoard",
      "QueueCongestionSection",
      "CustodyIntegrityWatch",
      "AccessSecurityWatch",
      "UnsupportedSignalsSection",
    ]) {
      expect(CC, `section component ${fn} missing`).toMatch(
        new RegExp(`function ${fn}\\(`),
      );
    }
  });

  it("Critical Operations Bar surfaces health + headline + a next-action route", () => {
    const block = CC.slice(CC.indexOf("function CriticalOperationsBar"));
    expect(block).toMatch(/data-cc-critical-bar/);
    expect(block).toMatch(/data-cc-critical-tone/);
    expect(block).toMatch(/ec-critical-bar-action/);
  });

  it("Routing queue rows carry stable reason + domain + severity data attributes (test-friendly + operator-friendly)", () => {
    expect(CC).toContain("data-cc-routing-reason=");
    expect(CC).toContain("data-cc-routing-domain=");
    expect(CC).toContain("data-cc-routing-severity=");
    expect(CC).toContain("data-cc-routing-primary-route");
  });

  it("Investigation risk board surfaces per-case risk level + reason codes + recommended action", () => {
    expect(CC).toContain("data-cc-investigation-risk=");
    expect(CC).toContain("data-cc-investigation-reason=");
    expect(CC).toMatch(/Recommended:/);
  });

  it("Custody/Integrity watch reads bounded reasonCode chips (no admissibility / authenticity claims)", () => {
    expect(CC).toContain("data-cc-integrity-reason=");
    expect(CC).toMatch(
      /not a claim of authenticity or admissibility/,
    );
  });

  it("Access/Security watch reads from SecurityEvent rows only — no synthetic events", () => {
    expect(CC).toContain("data-cc-security-event-id=");
    // Phase 32.8C operational closure — the empty-state copy is operationally
    // meaningful: it enumerates what classes of activity were scanned and
    // explicitly states that a 0-result means none of those activities
    // were observed.
    expect(CC).toMatch(
      /No suspicious access activity in the last 24 hours/,
    );
    expect(CC).toMatch(/no impossible-travel sessions/);
  });

  it("Unsupported signals section is rendered as a collapsible <details>, hidden by default", () => {
    expect(CC).toMatch(/<details className="ec-unsupported"/);
    expect(CC).toMatch(/<summary className="ec-unsupported-summary"/);
  });

  it("frontend never references hashRecompute / verifySignature / chargeBilling / signedUrl helpers", () => {
    for (const sym of [
      "recomputeHash",
      "verifySignature",
      "chargeBilling",
      "computeBillingCharge",
      "signedUrl",
      "presignedUrl",
    ]) {
      expect(CC, `forbidden symbol ${sym}`).not.toContain(sym);
    }
  });

  it("frontend never makes positive overclaim statements (negations + quoted disclaimers OK)", () => {
    const positiveClaim = (phrase: string): RegExp =>
      new RegExp(
        `(?<!["NOT not ])\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b(?!["])`,
      );
    for (const banned of [
      "legally admissible",
      "court-ready",
      "guaranteed",
      "verified truth",
      "proves authenticity",
      "verified as real",
    ]) {
      expect(
        CC,
        `Command Center must not claim "${banned}"`,
      ).not.toMatch(positiveClaim(banned));
    }
  });
});

// =============================================================================
// PART 12 — Phase 32.8C++ Deep Operations Intelligence
// =============================================================================

describe("Phase 32.8C++ — Permission-aware action routing", () => {
  it("ROUTING_CATALOG entries carry requiredRoles + requiredPermission + escalationPath", () => {
    expect(SERVICE).toMatch(/requiredPermission:\s*("[^"]+"|null)/);
    expect(SERVICE).toMatch(/requiredRoles:\s*\[/);
    expect(SERVICE).toMatch(/escalationPath:\s*("[^"]+"|null)/);
    // Sample bounded permission values.
    for (const perm of [
      "evidence_request.review",
      "review.assign",
      "review.escalation.resolve",
      "evidence.write",
      "evidence.finalize",
      "case.write",
      "governance.policy.update",
      "governance.hold.read",
    ]) {
      expect(SERVICE).toContain(`"${perm}"`);
    }
  });

  it("enrichPressureItems accepts viewerRole + computes canCurrentUserAct", () => {
    expect(SERVICE).toMatch(/function enrichPressureItems\([\s\S]{0,1200}viewerRole:\s*string/);
    expect(SERVICE).toMatch(
      /canCurrentUserAct = \(meta\.requiredRoles as ReadonlyArray<string>\)\.includes\(\s*viewerRole/,
    );
    expect(SERVICE).toMatch(/safeActionLabel/);
  });

  it("buildCommandCenter passes the viewer role into the operational pressure engine", () => {
    expect(SERVICE).toMatch(
      /runOperationalPressure\(\s*input\.teamId,\s*scope,\s*input\.role\s*\)/,
    );
  });

  it("frontend renders 'cannot act' state for routing items the viewer cannot execute", () => {
    expect(CC).toContain("ec-routing-cannot-act");
    expect(CC).toContain('data-cc-can-act="true"');
    expect(CC).toContain('data-cc-can-act="false"');
    expect(CC).toContain("data-cc-required-roles");
  });
});

describe("Phase 32.8C++ — Relationship Intelligence engine", () => {
  it("exports runRelationshipIntelligence + bounded cluster kinds", () => {
    expect(SERVICE).toMatch(/async function runRelationshipIntelligence\(/);
    for (const kind of [
      "duplicate_hash",
      "same_intake_session",
      "same_submitter",
      "explicit_relationship",
      "same_case",
    ]) {
      expect(SERVICE).toContain(`"${kind}"`);
    }
  });

  it("duplicate-hash clusters derive from real Evidence.fileSha256 groupBy + count > 1", () => {
    expect(SERVICE).toMatch(
      /prisma\.evidence\.groupBy\(\{[\s\S]{0,400}by:\s*\["fileSha256"\][\s\S]{0,500}having:\s*\{\s*fileSha256:\s*\{\s*_count:\s*\{\s*gt:\s*1\s*\}/,
    );
  });

  it("explicit EvidenceRelationship rows are surfaced when present", () => {
    expect(SERVICE).toMatch(/prisma\.evidenceRelationship\.findMany/);
  });

  it("declares intake-session + many-to-many evidence-case as unsupported with reasons", () => {
    expect(SERVICE).toContain(
      "intake_session_clustering (Evidence has no intakeSessionId column",
    );
    expect(SERVICE).toContain(
      "evidence_in_multiple_cases (Evidence.caseId is singular; no join table)",
    );
  });
});

describe("Phase 32.8C++ — Cross-Case Intelligence V2 engine", () => {
  it("exports bounded V2 signal types", () => {
    expect(SERVICE).toMatch(/async function runCrossCaseIntelligenceV2\(/);
    for (const t of [
      "shared_governance_block",
      "shared_reviewer_overload",
      "shared_failed_report_pattern",
      "shared_failed_package_pattern",
      "repeated_evidence_gaps",
      "repeated_overdue_reviews",
      "stale_with_active_hold",
    ]) {
      expect(SERVICE).toContain(`"${t}"`);
    }
  });

  it("personal-workspace short-circuits cross-case V2 to not_applicable", () => {
    expect(SERVICE).toMatch(
      /runCrossCaseIntelligenceV2[\s\S]{0,1200}scope === "PERSONAL"[\s\S]{0,400}status:\s*"not_applicable"/,
    );
  });

  it("shared-governance-block signal counts real package-blocked metadata across cases", () => {
    expect(SERVICE).toMatch(
      /m && m\.blocked === true && row\.caseId/,
    );
  });
});

describe("Phase 32.8C++ — Reconstructed Timeline engine", () => {
  it("exports runReconstructedTimeline + bounded family enum", () => {
    expect(SERVICE).toMatch(/async function runReconstructedTimeline\(/);
    for (const fam of [
      '"evidence"',
      '"report"',
      '"package"',
      '"governance"',
      '"review"',
      '"incident"',
      '"audit"',
      '"security"',
    ]) {
      expect(SERVICE).toContain(fam);
    }
  });

  it("each event carries actor + confidence + safeToDisplay + sourceTable fields", () => {
    expect(SERVICE).toMatch(/confidence:\s*Confidence/);
    expect(SERVICE).toMatch(/safeToDisplay:\s*boolean/);
    expect(SERVICE).toMatch(/sourceTable:\s*string/);
  });

  it("AdminAuditLog is INTENTIONALLY excluded from the reconstructed timeline (workspace scoping risk)", () => {
    // The engine must NOT call prisma.adminAuditLog.findMany in
    // the reconstructed-timeline runner — would leak cross-workspace
    // admin actions. The unsupported declaration is the contract.
    const idx = SERVICE.indexOf("async function runReconstructedTimeline");
    const end = SERVICE.indexOf("\n}\n", idx + 4000);
    const body = SERVICE.slice(idx, end > idx ? end : idx + 8000);
    expect(body).not.toMatch(/prisma\.adminAuditLog\.findMany/);
    expect(body).toContain("admin_audit_log_workspace_scope");
  });

  it("timeline events source from real Prisma tables (Report / VerificationPackage / EvidenceLifecycleEvent / OperationalIncident / ReviewEscalation / SecurityEvent)", () => {
    const idx = SERVICE.indexOf("async function runReconstructedTimeline");
    const body = SERVICE.slice(idx, idx + 8000);
    expect(body).toMatch(/prisma\.report\.findMany/);
    expect(body).toMatch(/prisma\.verificationPackage\.findMany/);
    expect(body).toMatch(/prisma\.evidenceLifecycleEvent\.findMany/);
    expect(body).toMatch(/prisma\.operationalIncident\.findMany/);
    expect(body).toMatch(/prisma\.reviewEscalation\.findMany/);
    expect(body).toMatch(/prisma\.securityEvent\.findMany/);
  });
});

describe("Phase 32.8C++ — Deep Integrity Watch engine", () => {
  it("exports bounded deep-integrity reason codes", () => {
    expect(SERVICE).toMatch(/async function runDeepIntegrityWatch\(/);
    for (const r of [
      "INTEGRITY_REVIEW_REQUIRED",
      "INTEGRITY_FAILED",
      "TSA_UNAVAILABLE",
      "OTS_UNAVAILABLE",
      "OTS_FAILED",
      "REPORT_FINALIZED_NO_PACKAGE_AGED",
      "PACKAGE_BLOCKED",
    ]) {
      expect(SERVICE).toContain(`"${r}"`);
    }
  });

  it("uses real TSA + OTS columns from Evidence (no fabricated columns)", () => {
    expect(SERVICE).toMatch(/tsaTokenBase64:\s*null/);
    expect(SERVICE).toMatch(/otsStatus:\s*null/);
    expect(SERVICE).toMatch(/otsStatus:\s*\{\s*in:\s*\["PENDING",\s*"FAILED",\s*"ERRORED"\]/);
  });

  it("each signal carries sourceFields + confidence", () => {
    expect(SERVICE).toMatch(/sourceFields:\s*string\[\]/);
    expect(SERVICE).toMatch(/confidence:\s*Confidence/);
  });

  it("integrity columns + TSA issuer schema gap are now CLOSED (Phase 32.8C++++ + 32.8C+++++); only the worker-side ASN.1 parser remains pending deployment", () => {
    // Phase 32.8C++++ — EvidenceIntegritySnapshot table provides
    // canonicalHashMatches / signatureValid / custodyChainValid /
    // timestampDigestMatches / otsHashMatches columns.
    // Phase 32.8C+++++ — TSA issuer columns + parseStatus added; the
    // remaining gap is the worker-side ASN.1 parser deployment.
    expect(SERVICE).toMatch(/worker-side ASN\.1 TSA parser not yet deployed/);
    expect(SERVICE).not.toContain("canonical_hash_recompute");
    expect(SERVICE).not.toContain("signature_valid_per_record");
    expect(SERVICE).not.toContain("custody_chain_valid_per_record");
  });

  it("uses legally-safe language only (no admissibility/authenticity claims)", () => {
    const idx = SERVICE.indexOf("async function runDeepIntegrityWatch");
    const body = SERVICE.slice(idx, idx + 6000);
    for (const banned of [
      "legally admissible",
      "court-ready",
      "proves authenticity",
      "authentic",
      "fraud",
    ]) {
      expect(body, `forbidden ${banned} in deep integrity engine`).not.toContain(banned);
    }
  });
});

describe("Phase 32.8C++ — Access Security Classifier", () => {
  it("bounded anomaly category enum", () => {
    expect(SERVICE).toMatch(/async function runAccessSecurityClassifier\(/);
    for (const c of [
      "repeated_failed_access",
      "blocked_export_attempt",
      "api_credential_change",
      "webhook_failure_spike",
      "admin_role_change",
      "step_up_failed",
      "permission_denied_burst",
      "uncategorized",
    ]) {
      expect(SERVICE).toContain(`"${c}"`);
    }
  });

  it("classifier is rule-based on eventType strings (no ML)", () => {
    expect(SERVICE).toMatch(/function classifySecurityEventType\(eventType:\s*string\)/);
    expect(SERVICE).toContain("ml_anomaly_score");
  });

  it("classifier reads ONLY real SecurityEvent rows last 24h with severity WARNING|HIGH", () => {
    const idx = SERVICE.indexOf("async function runAccessSecurityClassifier");
    const body = SERVICE.slice(idx, idx + 4000);
    expect(body).toMatch(/prisma\.securityEvent\.findMany/);
    expect(body).toMatch(
      /severity:\s*\{\s*in:\s*\["WARNING",\s*"HIGH"\]/,
    );
  });
});

describe("Phase 32.8C++ — Queue / Worker Telemetry", () => {
  it("reconcile health enum bounded (FRESH / STALE / UNAVAILABLE)", () => {
    expect(SERVICE).toMatch(/async function runQueueWorkerTelemetry\(/);
    expect(SERVICE).toMatch(
      /reconcileHealth:\s*"FRESH"\s*\|\s*"STALE"\s*\|\s*"UNAVAILABLE"/,
    );
  });

  it("heartbeat source is SecurityEvent with eventType=reviewer_reconcile_run", () => {
    expect(SERVICE).toMatch(
      /eventType:\s*"reviewer_reconcile_run"/,
    );
  });

  it("BullMQ infra depth and worker heartbeat persistence are now CLOSED via QueueTelemetrySnapshot + WorkerTelemetrySnapshot (Phase 32.8C+++++)", () => {
    // Phase 32.8C+++++ — durable QueueTelemetrySnapshot + WorkerTelemetrySnapshot
    // tables replace the old "no DB-persisted snapshot" / "heartbeat not persisted"
    // unsupportedSignals. The dashboard now reads from the persisted samples and
    // lazy-writes DB-derived snapshots if BullMQ-source samples are missing.
    expect(SERVICE).not.toMatch(/no DB-persisted queue snapshot/);
    expect(SERVICE).not.toMatch(/worker process heartbeat is not persisted/);
    expect(SERVICE).toMatch(/QueueTelemetrySnapshot[^"\n]*Phase 32\.8C\+\+\+\+\+/);
    expect(SERVICE).toMatch(/WorkerTelemetrySnapshot[^"\n]*Phase 32\.8C\+\+\+\+\+/);
  });
});

describe("Phase 32.8C++ — Coordination Signals", () => {
  it("bounded coordination signal types", () => {
    expect(SERVICE).toMatch(/async function runCoordinationSignals\(/);
    for (const t of [
      "escalation_unassigned",
      "annotation_requires_review",
      "legal_note_pending",
      "review_without_recent_activity",
    ]) {
      expect(SERVICE).toContain(`"${t}"`);
    }
  });

  it("uses real tables only (ReviewEscalation acknowledgedByUserId IS NULL / EvidenceAnnotation / EvidenceReviewerComment / CaseComment)", () => {
    const idx = SERVICE.indexOf("async function runCoordinationSignals");
    // Phase 32.8C+++++ grew the function — extend the body window.
    const body = SERVICE.slice(idx, idx + 8000);
    expect(body).toMatch(/acknowledgedByUserId:\s*null/);
    expect(body).toMatch(/prisma\.evidenceAnnotation/);
    expect(body).toMatch(/prisma\.evidenceReviewerComment/);
    expect(body).toMatch(/prisma\.caseComment/);
  });

  it("case-level comments + annotation resolution tracking are now CLOSED (Phase 32.8C+++++ + Phase 32.8C++++)", () => {
    // Phase 32.8C+++++ — CaseComment table provides case-level comments.
    // Phase 32.8C++++ — resolvedAtUtc / resolvedByUserId added to
    // EvidenceAnnotation + EvidenceReviewerComment.
    // The previous "unsupported" declarations are removed; the section
    // sourceSummary now advertises the new sources directly.
    expect(SERVICE).not.toContain("case_level_comments (no Case-level comment table)");
    expect(SERVICE).not.toContain(
      "annotation_resolution_tracking (no resolved/unresolved column on EvidenceAnnotation)",
    );
    expect(SERVICE).toMatch(/CaseComment[^"\n]*Phase 32\.8C\+\+\+\+\+/);
  });
});

describe("Phase 32.8C++ — Predictive Risk Forecast (deterministic)", () => {
  it("bounded forecast type enum + confidence levels", () => {
    expect(SERVICE).toMatch(/function runPredictiveRisk\(input:\s*\{/);
    for (const t of [
      "sla_breach_imminent",
      "reviewer_capacity_breach",
      "report_pipeline_degradation",
      "package_pipeline_degradation",
      "governance_pressure_rising",
      "audit_readiness_gap",
    ]) {
      expect(SERVICE).toContain(`"${t}"`);
    }
    expect(SERVICE).toMatch(/confidence:\s*"low"\s*\|\s*"medium"\s*\|\s*"high"/);
  });

  it("uses deterministic thresholds — NOT ML predictions / NOT AI claims", () => {
    expect(SERVICE).toMatch(/ml_probability_model/);
    const idx = SERVICE.indexOf("function runPredictiveRisk");
    const body = SERVICE.slice(idx, idx + 6000);
    for (const banned of [
      "AI predicts",
      "ML model",
      "artificial intelligence",
      "machine learning",
    ]) {
      expect(body, `forbidden ${banned}`).not.toContain(banned);
    }
  });

  it("forecast is derived from real engine outputs (no extra DB round-trip)", () => {
    expect(SERVICE).toMatch(
      /runPredictiveRisk\(\{\s*reviewer:\s*reviewerOrch,\s*governance,\s*pipeline:\s*pipelineDetail,\s*audit:\s*auditReadiness/,
    );
  });
});

describe("Phase 32.8C++ — Org Intelligence V2", () => {
  it("bounded orgHealth enum (HEALTHY / WATCH / DEGRADED / CRITICAL)", () => {
    expect(SERVICE).toMatch(/async function runOrgIntelligenceV2\(/);
    expect(SERVICE).toMatch(
      /orgHealth:\s*"HEALTHY"\s*\|\s*"WATCH"\s*\|\s*"DEGRADED"\s*\|\s*"CRITICAL"/,
    );
  });

  it("bottleneck domains derived from pressure items' affectedDomain (no synthesized domains)", () => {
    expect(SERVICE).toMatch(/for \(const item of pressure\.items\)/);
    expect(SERVICE).toMatch(/item\.affectedDomain/);
    expect(SERVICE).toMatch(/item\.sourceTable/);
  });

  it("throughput windows include 24h + 7d + 30d", () => {
    expect(SERVICE).toMatch(/last24h:\s*number/);
    expect(SERVICE).toMatch(/last7d:\s*number/);
    expect(SERVICE).toMatch(/last30d:\s*number/);
  });
});

describe("Phase 32.8C++ — Envelope contract + unsupported signals", () => {
  it("envelope adds the 9 new deep-intelligence sections", () => {
    for (const section of [
      "relationshipIntelligence",
      "crossCaseIntelligenceV2",
      "reconstructedTimeline",
      "deepIntegrityWatch",
      "accessSecurityClassifier",
      "queueWorkerTelemetry",
      "coordinationSignals",
      "predictiveRisk",
      "organizationalIntelligenceV2",
    ]) {
      expect(SERVICE).toMatch(new RegExp(`${section}:\\s*\\{`));
    }
  });

  it("buildUnsupportedSignalsCatalog aggregates all new engine metas (transparency)", () => {
    const idx = SERVICE.indexOf("const unsupportedSignals = buildUnsupportedSignalsCatalog");
    expect(idx).toBeGreaterThan(-1);
    const body = SERVICE.slice(idx, idx + 1200);
    for (const m of [
      "relationshipResult.meta",
      "crossCaseV2Result.meta",
      "reconstructedTimelineResult.meta",
      "deepIntegrityResult.meta",
      "securityClassifierResult.meta",
      "queueWorkerTelemetryResult.meta",
      "coordinationResult.meta",
      "predictiveRiskResult.meta",
      "orgIntelligenceV2Result.meta",
    ]) {
      expect(body, `unsupported aggregator missing ${m}`).toContain(m);
    }
  });
});

describe("Phase 32.8C++ — Frontend renders the deep intelligence layer", () => {
  it("renders the new section components", () => {
    for (const fn of [
      "PredictiveRiskBoard",
      "OrgIntelligenceV2Board",
      "RelationshipIntelligenceBoard",
      "CrossCaseIntelligenceV2Board",
      "DeepIntegrityWatch",
      "AccessSecurityClassifierBoard",
      "QueueWorkerTelemetryBoard",
      "CoordinationSignalsBoard",
      "ReconstructedTimelineSection",
    ]) {
      expect(CC, `section ${fn} missing`).toMatch(
        new RegExp(`function ${fn}\\(`),
      );
    }
  });

  it("deep-intelligence sections expose stable data attributes for test + automation", () => {
    for (const attr of [
      "data-cc-forecast-id=",
      "data-cc-forecast-type=",
      "data-cc-forecast-confidence=",
      "data-cc-org-v2-tile=",
      "data-cc-bottleneck-list",
      "data-cc-cluster-id=",
      "data-cc-cross-id=",
      "data-cc-reconstructed-id=",
      "data-cc-deep-integrity-reason=",
      "data-cc-classifier-category=",
      "data-cc-queue-telemetry-tile=",
      "data-cc-coord-id=",
    ]) {
      expect(CC, `attribute ${attr} missing in frontend`).toContain(attr);
    }
  });

  it("predictive risk explicitly tells the operator it is a deterministic forecast (no AI/ML claim)", () => {
    expect(CC).toMatch(/deterministic heuristic forecast/);
    expect(CC).toMatch(/no ML, no AI claims/);
    expect(CC).not.toContain("AI predicts");
    expect(CC).not.toContain("machine learning");
  });
});
