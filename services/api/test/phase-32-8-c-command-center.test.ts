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
    // The 7 section runners must each have at least one try/catch.
    const runners = [
      "runSummary",
      "runRecentEvidence",
      "runPipeline",
      "runReviewerWorkload",
      "runGovernancePosture",
      "runIncidents",
      "runAttentionQueue",
    ];
    for (const name of runners) {
      const idx = SERVICE.indexOf(`async function ${name}`);
      expect(idx, `runner ${name} not found`).toBeGreaterThan(-1);
      // The next `\n}` closes the function. Slice the body.
      const next = SERVICE.indexOf("\n}\n", idx);
      const body = SERVICE.slice(idx, next > idx ? next : idx + 4000);
      expect(body, `runner ${name} missing try`).toMatch(/try\s*\{/);
      // Allow both `catch (err)` and ES2019+ `catch {` (optional binding).
      expect(body, `runner ${name} missing catch`).toMatch(/catch\s*[\(\{]/);
    }
  });

  it("declares bounded limits (no `take` left unbounded)", () => {
    // Recent evidence ≤ 10, incidents ≤ 8, attention ≤ 24, per-kind ≤ 5.
    expect(SERVICE).toMatch(/RECENT_EVIDENCE_LIMIT\s*=\s*10/);
    expect(SERVICE).toMatch(/INCIDENTS_LIMIT\s*=\s*8/);
    expect(SERVICE).toMatch(/ATTENTION_TOTAL_LIMIT\s*=\s*24/);
    expect(SERVICE).toMatch(/ATTENTION_LIMIT_PER_KIND\s*=\s*5/);
    // Every findMany carries a `take:` argument.
    const findMany = SERVICE.match(/\.findMany\(\{[\s\S]*?\}\)/g) ?? [];
    expect(findMany.length).toBeGreaterThanOrEqual(4);
    for (const block of findMany) {
      expect(block, `unbounded findMany: ${block.slice(0, 80)}`).toMatch(/take:/);
    }
  });

  it("personal-workspace reviewer/governance sections return `not_applicable` instead of broken data", () => {
    // runReviewerWorkload and runGovernancePosture must early-return
    // a `not_applicable` envelope when `scope === "PERSONAL"`.
    const reviewerIdx = SERVICE.indexOf("async function runReviewerWorkload");
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

  it("envelope shape exposes the canonical sections (summary / attentionQueue / recentEvidence / pipeline / reviewerWorkload / governancePosture / incidents)", () => {
    for (const section of [
      "summary",
      "attentionQueue",
      "recentEvidence",
      "pipeline",
      "reviewerWorkload",
      "governancePosture",
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

describe("Phase 32.8C — frontend command center renders A–H sections", () => {
  it("exports CommandCenter as the canonical /home renderer", () => {
    expect(CC).toMatch(/export function CommandCenter\(\)/);
    expect(HOME).toMatch(
      /import\s*\{\s*CommandCenter\s*\}\s*from\s*"[^"]*components\/command-center\/CommandCenter"/,
    );
    expect(HOME).toMatch(/<CommandCenter\s*\/>/);
  });

  it("renders the 8 canonical sections (A Summary, B Attention, C Recent Evidence, D Pipeline, E Reviewer Workload, F Governance Posture, G Platform Banner, H Quick Actions) plus Incidents", () => {
    // Each section function exists.
    for (const fn of [
      "SummaryStrip",
      "AttentionQueue",
      "RecentEvidenceSection",
      "PipelineSection",
      "ReviewerWorkloadSection",
      "GovernancePostureSection",
      "IncidentsSection",
      "QuickActions",
    ]) {
      expect(CC, `section component ${fn} missing`).toMatch(
        new RegExp(`function ${fn}\\(`),
      );
    }
  });

  it("Platform Impact Banner (G) reuses the canonical RuntimeStatusBanner with bounded forDomains scoping (not a duplicate runtime view)", () => {
    expect(CC).toMatch(/RuntimeStatusBanner/);
    expect(CC).toMatch(/forDomains=\{\[/);
    // Confirm it's scoped (not just `forDomains` with everything).
    expect(CC).toMatch(/"core_evidence"/);
    expect(CC).toMatch(/"governance_lifecycle"/);
    expect(CC).toMatch(/"reviewer_ops"/);
  });

  it("fetches from `/v1/dashboard/command-center` with the active workspace id", () => {
    expect(CC).toMatch(/\/v1\/dashboard\/command-center/);
    expect(CC).toMatch(/encodeURIComponent\(workspace\.workspaceId\)/);
  });

  it("renders per-section status states (ok / degraded / unavailable / not_applicable)", () => {
    expect(CC).toMatch(/SectionStatusNote/);
    expect(CC).toMatch(/PersonalScopeNote/);
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
    expect(CC).toMatch(/Reviewer queues are a team workspace feature/);
    expect(CC).toMatch(/Governance posture is a team workspace feature/);
  });

  it("summary strip hides team-only metrics (reviewer pending, governance attention) when workspace is personal", () => {
    // SummaryStrip filters cards by `c.visible`; the reviewer +
    // governance cards bind visibility to `isTeam`.
    const summary = CC.slice(CC.indexOf("function SummaryStrip"));
    expect(summary).toMatch(/visible:\s*isTeam/);
  });

  it("Reviewer Workload section short-circuits on `not_applicable` (no broken zero-state)", () => {
    const block = CC.slice(CC.indexOf("function ReviewerWorkloadSection"));
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
    // satisfy the pattern.
    const idx = CC.indexOf("canMutate = role ===");
    expect(idx).toBeGreaterThan(-1);
    const block = CC.slice(idx, idx + 200);
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
    // Required backend-provided field references.
    for (const field of [
      "evidenceActiveCount",
      "reportReadyCount",
      "reviewerPendingCount",
      "governanceAttentionCount",
      "openIncidentsCount",
      "queuedCount",
      "overdueCount",
      "openEscalationsCount",
      "activeLegalHoldsCount",
      "retentionCandidatesCount",
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
