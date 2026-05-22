/**
 * Phase 32.8E — Teams + Governance + ReviewerOps enterprise rebuild.
 *
 * Source-contract regression suite. Pins:
 *
 *  PART 1 — Backend workspace-admin service: read-only, audit-free,
 *           bounded, partial-failure tolerant, no secret projection.
 *  PART 2 — Backend governance-control-plane service: same contract,
 *           Phase 14 case_legal_holds treated as a CORE feature
 *           (subsystem-disabled banner reserved for genuine schema
 *           drift only).
 *  PART 3 — Backend reviewer-command service: same contract,
 *           personal-workspace short-circuit to `not_applicable`.
 *  PART 4 — Routes registered, auth + membership gated, GET-only.
 *  PART 5 — Frontend /teams page: aggregator-driven workspace admin,
 *           role matrix, governance + integrations + billing snapshot,
 *           viewer role hides mutation CTAs.
 *  PART 6 — Frontend /governance page: control plane tabs, personal-
 *           workspace neutral state, preservation disclaimer, no
 *           overclaiming.
 *  PART 7 — Frontend /reviewer-ops page: orchestration summary,
 *           escalation command, workload, policy + reconciliation,
 *           personal-workspace neutral state.
 *  PART 8 — Shared invariants: no fake data, no secret exposure, no
 *           browse side effects, no OTS/TSA/custody/billing regression,
 *           canonical routes preserved.
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

const WORKSPACE_ADMIN_SVC = readApi(
  "src/services/workspace-admin/workspace-admin.service.ts",
);
const GOVERNANCE_SVC = readApi(
  "src/services/governance/governance-control-plane.service.ts",
);
const REVIEWER_SVC = readApi(
  "src/services/reviewer-ops/reviewer-command.service.ts",
);
const ROUTES = readApi("src/routes/enterprise-aggregators.routes.ts");
const SERVER = readApi("src/server.ts");

const WORKSPACE_PANEL = readWeb(
  "components/workspace-admin/WorkspaceAdminPanel.tsx",
);
const GOVERNANCE_PANEL = readWeb(
  "components/governance-experience/GovernanceControlPlane.tsx",
);
const REVIEWER_PANEL = readWeb(
  "components/reviewer-experience/ReviewerCommandConsole.tsx",
);
const TEAMS_PAGE = readWeb("app/(app)/teams/page.tsx");
const GOVERNANCE_PAGE = readWeb("app/(app)/governance/page.tsx");
const REVIEWER_PAGE = readWeb("app/(app)/reviewer-ops/page.tsx");

// =============================================================================
// PART 1 — workspace-admin service
// =============================================================================

describe("Phase 32.8E — workspace-admin aggregator service contract", () => {
  it("exports buildWorkspaceAdmin entrypoint", () => {
    expect(WORKSPACE_ADMIN_SVC).toMatch(
      /export async function buildWorkspaceAdmin\(/,
    );
  });

  it("never calls Prisma write methods", () => {
    for (const re of [
      /prisma\.[A-Za-z]+\.create\(/,
      /prisma\.[A-Za-z]+\.update\(/,
      /prisma\.[A-Za-z]+\.delete\(/,
      /prisma\.[A-Za-z]+\.upsert\(/,
      /prisma\.[A-Za-z]+\.createMany\(/,
      /prisma\.[A-Za-z]+\.updateMany\(/,
      /prisma\.[A-Za-z]+\.deleteMany\(/,
    ]) {
      expect(WORKSPACE_ADMIN_SVC, `must not call ${re}`).not.toMatch(re);
    }
  });

  it("never emits audit / analytics / security events", () => {
    for (const sym of [
      "auditTeamAction",
      "auditCaseAction",
      "auditEvidenceAction",
      "auditMiddleware",
      "fireTeamAnalyticsEvent",
      "fireCaseAnalyticsEvent",
      "writeAnalyticsEvent",
      "emitSecurityEvent",
      "writeAuditEvent",
    ]) {
      expect(
        WORKSPACE_ADMIN_SVC,
        `must not invoke ${sym}`,
      ).not.toContain(sym);
    }
  });

  it("never projects API key secrets, webhook secrets, or storage keys", () => {
    for (const sym of [
      "apiKeyHash",
      "tokenHash",
      "secret:",
      "secretHash",
      "signingSecret",
      "storageKey",
      "storageBucket",
      "presignedUrl",
      "signedUrl",
    ]) {
      expect(
        WORKSPACE_ADMIN_SVC,
        `service must not project ${sym}`,
      ).not.toContain(sym);
    }
  });

  it("declares bounded limits on every findMany", () => {
    expect(WORKSPACE_ADMIN_SVC).toMatch(/MEMBERS_LIMIT\s*=\s*100/);
    expect(WORKSPACE_ADMIN_SVC).toMatch(/INVITES_LIMIT\s*=\s*50/);
    expect(WORKSPACE_ADMIN_SVC).toMatch(/RECENT_ACTIVITY_LIMIT\s*=\s*25/);
    const findMany = WORKSPACE_ADMIN_SVC.match(/\.findMany\(\{[\s\S]*?\}\)/g) ?? [];
    expect(findMany.length).toBeGreaterThanOrEqual(3);
    for (const block of findMany) {
      expect(
        block,
        `unbounded findMany in workspace-admin: ${block.slice(0, 80)}`,
      ).toMatch(/take:/);
    }
  });

  it("personal vs team scope detected via memberCount", () => {
    expect(WORKSPACE_ADMIN_SVC).toMatch(
      /scope:\s*WorkspaceScope\s*=\s*memberCount\s*<=\s*1\s*\?\s*"PERSONAL"\s*:\s*"TEAM"/,
    );
  });

  it("envelope exposes canonical sections (overview / access / governanceSnapshot / integrationsPosture / billing / operationalAccountability)", () => {
    for (const section of [
      "overview",
      "access",
      "governanceSnapshot",
      "integrationsPosture",
      "billing",
      "operationalAccountability",
    ]) {
      expect(WORKSPACE_ADMIN_SVC).toMatch(
        new RegExp(`${section}:\\s*\\{`),
      );
    }
  });

  it("operational accountability skips reviewer workload on PERSONAL scope", () => {
    expect(WORKSPACE_ADMIN_SVC).toMatch(/scope === "TEAM"/);
  });
});

// =============================================================================
// PART 2 — governance-control-plane service
// =============================================================================

describe("Phase 32.8E — governance-control-plane aggregator service contract", () => {
  it("exports buildGovernanceControlPlane entrypoint", () => {
    expect(GOVERNANCE_SVC).toMatch(
      /export async function buildGovernanceControlPlane\(/,
    );
  });

  it("never calls Prisma write methods", () => {
    for (const re of [
      /prisma\.[A-Za-z]+\.create\(/,
      /prisma\.[A-Za-z]+\.update\(/,
      /prisma\.[A-Za-z]+\.delete\(/,
      /prisma\.[A-Za-z]+\.upsert\(/,
    ]) {
      expect(GOVERNANCE_SVC, `must not call ${re}`).not.toMatch(re);
    }
  });

  it("never emits audit / analytics events", () => {
    for (const sym of [
      "auditEvidenceAction",
      "auditCaseAction",
      "writeAnalyticsEvent",
      "emitSecurityEvent",
    ]) {
      expect(GOVERNANCE_SVC, `must not invoke ${sym}`).not.toContain(sym);
    }
  });

  it("never invokes report / package / TSA / custody / billing engines", () => {
    for (const sym of [
      "renderReport",
      "buildVerificationPackage",
      "stampWithTsa",
      "appendCustodyEvent",
      "computeBillingCharge",
      "getSignedDownloadUrl",
      "presignS3",
    ]) {
      expect(GOVERNANCE_SVC, `must not invoke ${sym}`).not.toContain(sym);
    }
  });

  it("case_legal_holds is treated as a CORE feature — subsystem-disabled banner reserved for genuine schema drift only", () => {
    // P2021/P2022 drift handler exists.
    expect(GOVERNANCE_SVC).toMatch(/isPrismaTableOrColumnMissing/);
    // The posture section sets `caseLegalHoldsEnabled = false` ONLY
    // when the genuine schema-drift error fires, not unconditionally.
    expect(GOVERNANCE_SVC).toMatch(
      /caseLegalHoldsEnabled\s*=\s*true/,
    );
    expect(GOVERNANCE_SVC).toMatch(
      /if\s*\(isPrismaTableOrColumnMissing\(err\)\)\s*\{[\s\S]{0,80}caseLegalHoldsEnabled\s*=\s*false/,
    );
  });

  it("declares bounded limits on every findMany", () => {
    expect(GOVERNANCE_SVC).toMatch(/HOLDS_LIMIT\s*=\s*50/);
    expect(GOVERNANCE_SVC).toMatch(/INCIDENTS_LIMIT\s*=\s*10/);
    const findMany = GOVERNANCE_SVC.match(/\.findMany\(\{[\s\S]*?\}\)/g) ?? [];
    expect(findMany.length).toBeGreaterThanOrEqual(4);
    for (const block of findMany) {
      expect(
        block,
        `unbounded findMany in governance-control-plane: ${block.slice(0, 80)}`,
      ).toMatch(/take:/);
    }
  });

  it("envelope exposes canonical sections (posture / preservation / retention / exportGovernance / policy / incidents)", () => {
    for (const section of [
      "posture",
      "preservation",
      "retention",
      "exportGovernance",
      "policy",
      "incidents",
    ]) {
      expect(GOVERNANCE_SVC).toMatch(new RegExp(`${section}:\\s*\\{`));
    }
  });

  it("export governance reads ONLY the verificationPackageMetadata.blocked flag (no signed URLs / no presigned reads)", () => {
    expect(GOVERNANCE_SVC).toMatch(/verificationPackageMetadata/);
    expect(GOVERNANCE_SVC).toMatch(/blocked === true/);
  });
});

// =============================================================================
// PART 3 — reviewer-command service
// =============================================================================

describe("Phase 32.8E — reviewer-command aggregator service contract", () => {
  it("exports buildReviewerCommand entrypoint", () => {
    expect(REVIEWER_SVC).toMatch(
      /export async function buildReviewerCommand\(/,
    );
  });

  it("never calls Prisma write methods", () => {
    for (const re of [
      /prisma\.[A-Za-z]+\.create\(/,
      /prisma\.[A-Za-z]+\.update\(/,
      /prisma\.[A-Za-z]+\.delete\(/,
      /prisma\.[A-Za-z]+\.upsert\(/,
    ]) {
      expect(REVIEWER_SVC, `must not call ${re}`).not.toMatch(re);
    }
  });

  it("personal-workspace short-circuits ALL sections to `not_applicable` (no zero-counts confusion)", () => {
    expect(REVIEWER_SVC).toMatch(/if \(scope === "PERSONAL"\)/);
    // All 6 sections return not_applicable in the personal branch.
    for (const section of [
      "summary",
      "queuePeek",
      "escalations",
      "workload",
      "workflowPolicy",
      "reconciliationHealth",
    ]) {
      expect(
        REVIEWER_SVC,
        `personal short-circuit missing ${section}`,
      ).toMatch(
        new RegExp(`${section}:\\s*\\{\\s*status:\\s*"not_applicable"`),
      );
    }
  });

  it("declares bounded limits", () => {
    expect(REVIEWER_SVC).toMatch(/QUEUE_PEEK_LIMIT\s*=\s*10/);
    expect(REVIEWER_SVC).toMatch(/ESCALATIONS_LIMIT\s*=\s*10/);
    expect(REVIEWER_SVC).toMatch(/WORKLOAD_LIMIT\s*=\s*10/);
    const findMany = REVIEWER_SVC.match(/\.findMany\(\{[\s\S]*?\}\)/g) ?? [];
    expect(findMany.length).toBeGreaterThanOrEqual(2);
    for (const block of findMany) {
      expect(block).toMatch(/take:/);
    }
  });

  it("envelope exposes canonical sections (summary / queuePeek / escalations / workload / workflowPolicy / reconciliationHealth)", () => {
    for (const section of [
      "summary",
      "queuePeek",
      "escalations",
      "workload",
      "workflowPolicy",
      "reconciliationHealth",
    ]) {
      expect(REVIEWER_SVC).toMatch(new RegExp(`${section}:\\s*\\{`));
    }
  });

  it("SLA tone classifier maps overdue / due_soon / ok bounded set", () => {
    expect(REVIEWER_SVC).toMatch(/function classifySlaTone\(/);
    expect(REVIEWER_SVC).toMatch(/return "overdue"/);
    expect(REVIEWER_SVC).toMatch(/return "due_soon"/);
    expect(REVIEWER_SVC).toMatch(/return "ok"/);
  });
});

// =============================================================================
// PART 4 — Routes registered + auth-gated
// =============================================================================

describe("Phase 32.8E — enterprise aggregator routes", () => {
  it("registers GET /v1/teams/workspace-admin", () => {
    expect(ROUTES).toMatch(
      /app\.get\(\s*"\/v1\/teams\/workspace-admin"/,
    );
  });

  it("registers GET /v1/governance/control-plane", () => {
    expect(ROUTES).toMatch(
      /app\.get\(\s*"\/v1\/governance\/control-plane"/,
    );
  });

  it("registers GET /v1/reviewer-ops/command", () => {
    expect(ROUTES).toMatch(
      /app\.get\(\s*"\/v1\/reviewer-ops\/command"/,
    );
  });

  it("every route requires authentication via preHandler: requireAuth", () => {
    const matches =
      ROUTES.match(/app\.get\(\s*"\/v1\/[^"]+",[\s\S]*?preHandler:\s*requireAuth/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("only handles GET — no POST/PUT/DELETE/PATCH", () => {
    expect(ROUTES).not.toMatch(/app\.post\(/);
    expect(ROUTES).not.toMatch(/app\.put\(/);
    expect(ROUTES).not.toMatch(/app\.delete\(/);
    expect(ROUTES).not.toMatch(/app\.patch\(/);
  });

  it("workspace-membership gate uses 404-on-non-member, 403-on-inactive", () => {
    expect(ROUTES).toMatch(/requireWorkspaceMember\(/);
    expect(ROUTES).toMatch(
      /code\(404\)\.send\(\{\s*error:\s*\{\s*code:\s*"not_found"/,
    );
    expect(ROUTES).toMatch(/membership\.status\s*!==\s*"ACTIVE"/);
  });

  it("server registers the enterprise aggregator routes", () => {
    expect(SERVER).toMatch(/import \{ enterpriseAggregatorsRoutes \}/);
    expect(SERVER).toMatch(/app\.register\(enterpriseAggregatorsRoutes\)/);
  });
});

// =============================================================================
// PART 5 — Frontend /teams contract
// =============================================================================

describe("Phase 32.8E — /teams workspace administration", () => {
  it("delegates the /teams page to WorkspaceAdminPanel", () => {
    expect(TEAMS_PAGE).toMatch(/<WorkspaceAdminPanel\s*\/>/);
  });

  it("reads from the audit-free /v1/teams/workspace-admin aggregator", () => {
    expect(WORKSPACE_PANEL).toMatch(/\/v1\/teams\/workspace-admin\?teamId=/);
  });

  it("renders the canonical tabs (Overview / Access / Role Matrix / Governance / Integrations / Billing / Accountability)", () => {
    for (const label of [
      'label: "Overview"',
      'label: "Access & Roles"',
      'label: "Role Matrix"',
      'label: "Governance Snapshot"',
      'label: "Integrations"',
      'label: "Billing & Seats"',
      'label: "Operational Accountability"',
    ]) {
      expect(WORKSPACE_PANEL).toContain(label);
    }
  });

  it("renders the role permission matrix with OWNER / ADMIN / MEMBER / VIEWER columns", () => {
    expect(WORKSPACE_PANEL).toMatch(/<th>OWNER<\/th>/);
    expect(WORKSPACE_PANEL).toMatch(/<th>ADMIN<\/th>/);
    expect(WORKSPACE_PANEL).toMatch(/<th>MEMBER<\/th>/);
    expect(WORKSPACE_PANEL).toMatch(/<th>VIEWER<\/th>/);
  });

  it("never surfaces API key secrets, webhook secrets, or signed URLs", () => {
    for (const sym of [
      "apiKeyHash",
      "tokenHash",
      "signingSecret",
      "secretHash",
      "presignedUrl",
      "signedUrl",
    ]) {
      expect(WORKSPACE_PANEL, `must not surface ${sym}`).not.toContain(sym);
    }
  });

  it("integrations posture explicitly notes secrets are not surfaced", () => {
    expect(WORKSPACE_PANEL).toMatch(
      /Secrets are never surfaced here/,
    );
  });

  it("personal workspace gates out team-only tabs (Governance, Integrations, Accountability)", () => {
    expect(WORKSPACE_PANEL).toMatch(
      /key:\s*"governance",[\s\S]{0,80}visible:\s*isTeam/,
    );
    expect(WORKSPACE_PANEL).toMatch(
      /key:\s*"integrations",[\s\S]{0,80}visible:\s*isTeam/,
    );
    expect(WORKSPACE_PANEL).toMatch(
      /key:\s*"accountability",[\s\S]{0,80}visible:\s*isTeam/,
    );
  });

  it("canManage gates admin CTAs to OWNER/ADMIN (Viewer/Member do not see edit links)", () => {
    const idx = WORKSPACE_PANEL.indexOf("canManage =");
    expect(idx).toBeGreaterThan(-1);
    const block = WORKSPACE_PANEL.slice(idx, idx + 200);
    expect(block).toContain('"OWNER"');
    expect(block).toContain('"ADMIN"');
    expect(block).not.toContain('"MEMBER"');
    expect(block).not.toContain('"VIEWER"');
  });

  it("renders distinct loading / no-workspace / auth-error / not-found / unavailable shells", () => {
    for (const fn of [
      "ShellLoading",
      "ShellNoWorkspace",
      "ShellAuthError",
      "ShellNotFound",
      "ShellUnavailable",
    ]) {
      expect(WORKSPACE_PANEL).toMatch(new RegExp(`function ${fn}\\(`));
    }
  });

  it("never contains fake numeric metric literals", () => {
    expect(WORKSPACE_PANEL).not.toMatch(/Math\.random/);
    expect(WORKSPACE_PANEL).not.toMatch(/\bvalue:\s*\d{2,}\b/);
  });
});

// =============================================================================
// PART 6 — Frontend /governance control plane
// =============================================================================

describe("Phase 32.8E — /governance control plane", () => {
  it("delegates the /governance page to GovernanceControlPlane", () => {
    expect(GOVERNANCE_PAGE).toMatch(/<GovernanceControlPlane\s*\/>/);
  });

  it("reads from /v1/governance/control-plane", () => {
    expect(GOVERNANCE_PANEL).toMatch(/\/v1\/governance\/control-plane\?teamId=/);
  });

  it("renders the canonical tabs (posture / preservation / retention / exports / policy / incidents)", () => {
    for (const key of [
      `["posture", "Posture"]`,
      `["preservation", "Preservation"]`,
      `["retention", "Retention & Destruction"]`,
      `["exports", "Export Governance"]`,
      `["policy", "Policy"]`,
      `["incidents", "Incidents"]`,
    ]) {
      expect(GOVERNANCE_PANEL).toContain(key);
    }
  });

  it("personal workspace renders neutral 'team workspace features' note instead of team tabs", () => {
    expect(GOVERNANCE_PANEL).toMatch(
      /Personal workspaces use basic evidence controls/,
    );
    expect(GOVERNANCE_PANEL).toMatch(
      /Governance posture[\s\S]{0,200}team[\s\S]{0,40}workspace features/,
    );
  });

  it("preservation tab includes the explicit no-admissibility / no-authenticity disclaimer", () => {
    expect(GOVERNANCE_PANEL).toMatch(
      /does not\s+assert legal admissibility or authenticity of any record/,
    );
  });

  it("never makes positive legal admissibility / authenticity / court-ready claims (quoted negations OK)", () => {
    const positiveClaim = (phrase: string): RegExp =>
      new RegExp(
        `(?<!["NOT not ])\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b(?!["])`,
      );
    for (const banned of [
      "legally admissible",
      "guaranteed",
      "verified truth",
    ]) {
      expect(
        GOVERNANCE_PANEL,
        `governance panel must not claim "${banned}"`,
      ).not.toMatch(positiveClaim(banned));
    }
  });

  it("policy edit link is gated to OWNER/ADMIN (isAdmin predicate)", () => {
    expect(GOVERNANCE_PANEL).toMatch(
      /isAdmin\s*=\s*env\.workspace\.role\s*===\s*"OWNER"\s*\|\|\s*env\.workspace\.role\s*===\s*"ADMIN"/,
    );
  });

  it("renders the export-governance gate-flag tiles for report / package / public-verify / original-download", () => {
    for (const tile of [
      'data-governance-gate-tile="report"',
      'data-governance-gate-tile="package"',
      'data-governance-gate-tile="public_verify"',
      'data-governance-gate-tile="original"',
    ]) {
      expect(GOVERNANCE_PANEL).toContain(tile);
    }
  });

  it("never invents fake export-block reasons (every reason comes from the envelope)", () => {
    // The map projection uses b.reason / b.outcome — no hardcoded strings.
    expect(GOVERNANCE_PANEL).toMatch(/<span>\{b\.reason\}<\/span>/);
  });

  it("does NOT call audited /v1/governance/case-legal-holds GET on mount (reads only the consolidated control-plane aggregator)", () => {
    expect(GOVERNANCE_PANEL).not.toMatch(
      /apiFetch\([^)]*\/v1\/governance\/case-legal-holds/,
    );
    expect(GOVERNANCE_PANEL).not.toMatch(
      /apiFetch\([^)]*\/v1\/governance\/legal-holds/,
    );
    expect(GOVERNANCE_PANEL).not.toMatch(
      /apiFetch\([^)]*\/v1\/governance\/retention-candidates/,
    );
  });
});

// =============================================================================
// PART 7 — Frontend /reviewer-ops review orchestration
// =============================================================================

describe("Phase 32.8E — /reviewer-ops review orchestration", () => {
  it("delegates the /reviewer-ops page to ReviewerCommandConsole", () => {
    expect(REVIEWER_PAGE).toMatch(/<ReviewerCommandConsole\s*\/>/);
  });

  it("reads from /v1/reviewer-ops/command", () => {
    expect(REVIEWER_PANEL).toMatch(/\/v1\/reviewer-ops\/command\?teamId=/);
  });

  it("renders the canonical sections (Summary / Queue Peek / Escalations / Workload / Policy / Reconciliation)", () => {
    for (const fn of [
      "SummarySection",
      "QueuePeekSection",
      "EscalationsSection",
      "WorkloadSection",
      "PolicySection",
      "ReconciliationSection",
    ]) {
      expect(REVIEWER_PANEL).toMatch(new RegExp(`function ${fn}\\(`));
    }
  });

  it("personal workspace renders neutral 'team workspace feature' note (no broken zero-state queue)", () => {
    expect(REVIEWER_PANEL).toMatch(
      /Reviewer orchestration is a team workspace feature/,
    );
  });

  it("explicitly notes this is a triage surface — reviewer actions live on per-workflow pages", () => {
    expect(REVIEWER_PANEL).toMatch(
      /Reviewer actions live on the per-workflow inspector pages/,
    );
  });

  it("SLA tones are bounded (ok / due_soon / overdue) — no synthesized urgency", () => {
    expect(REVIEWER_PANEL).toMatch(/slaTone === "overdue"/);
    expect(REVIEWER_PANEL).toMatch(/slaTone === "due_soon"/);
  });

  it("never calls audited /v1/reviewer-ops/{queue,dashboard,workload,escalations} on mount (uses only the consolidated aggregator)", () => {
    expect(REVIEWER_PANEL).not.toMatch(
      /apiFetch\([^)]*\/v1\/reviewer-ops\/queue/,
    );
    expect(REVIEWER_PANEL).not.toMatch(
      /apiFetch\([^)]*\/v1\/reviewer-ops\/dashboard/,
    );
    expect(REVIEWER_PANEL).not.toMatch(
      /apiFetch\([^)]*\/v1\/reviewer-ops\/workload/,
    );
    expect(REVIEWER_PANEL).not.toMatch(
      /apiFetch\([^)]*\/v1\/reviewer-ops\/escalations/,
    );
  });

  it("links to the canonical sub-routes (per-workflow detail + SLA + escalations + governance policy + ops observability)", () => {
    expect(REVIEWER_PANEL).toMatch(/href=\{`\/reviewer-ops\/\$\{encodeURIComponent\(row\.workflowId\)\}`\}/);
    expect(REVIEWER_PANEL).toMatch(/href="\/reviewer-ops\/sla"/);
    expect(REVIEWER_PANEL).toMatch(/href=\{`\/reviewer-ops\/escalations`\}/);
    expect(REVIEWER_PANEL).toMatch(/href="\/governance\/policy"/);
    expect(REVIEWER_PANEL).toMatch(/href="\/ops\/observability"/);
  });

  it("renders distinct loading / no-workspace / auth-error / unavailable shells", () => {
    for (const fn of [
      "ShellLoading",
      "ShellNoWorkspace",
      "ShellAuthError",
      "ShellUnavailable",
    ]) {
      expect(REVIEWER_PANEL).toMatch(new RegExp(`function ${fn}\\(`));
    }
  });
});

// =============================================================================
// PART 8 — Shared invariants
// =============================================================================

describe("Phase 32.8E — shared invariants", () => {
  it("none of the new frontend panels CALL side-effecting endpoints on mount", () => {
    const panels = { WORKSPACE_PANEL, GOVERNANCE_PANEL, REVIEWER_PANEL };
    for (const [name, src] of Object.entries(panels)) {
      // Browse must not trigger report / package downloads.
      expect(src, `${name} must not call /report/latest on mount`).not.toMatch(
        /apiFetch\([^)]*\/v1\/evidence\/[^)]*\/report\/latest/,
      );
      expect(
        src,
        `${name} must not call /verification-package on mount`,
      ).not.toMatch(
        /apiFetch\([^)]*\/v1\/evidence\/[^)]*\/verification-package/,
      );
      // Browse must not trigger team-export ZIP.
      expect(src, `${name} must not call /v1/cases/:id/export on mount`).not.toMatch(
        /apiFetch\([^)]*\/v1\/cases\/[^)]*\/export/,
      );
      // Browse must not call the audited /v1/teams or /v1/teams/:id GETs.
      expect(src, `${name} must not call /v1/teams (audited list)`).not.toMatch(
        /apiFetch\("\/v1\/teams"/,
      );
      expect(src, `${name} must not call /v1/teams/:id (audited GET)`).not.toMatch(
        /apiFetch\(`\/v1\/teams\/\$\{[^}]+\}\`[\s,}]/,
      );
    }
  });

  it("frontend panels never project secrets or signed URLs", () => {
    const panels = { WORKSPACE_PANEL, GOVERNANCE_PANEL, REVIEWER_PANEL };
    for (const [name, src] of Object.entries(panels)) {
      for (const sym of [
        "apiKeyHash",
        "tokenHash",
        "signingSecret",
        "secretHash",
        "presignedUrl",
        "signedUrl",
        "storageKey",
      ]) {
        expect(src, `${name} must not project ${sym}`).not.toContain(sym);
      }
    }
  });

  it("no panel makes positive legal overclaim statements (quoted negations OK)", () => {
    const panels = { WORKSPACE_PANEL, GOVERNANCE_PANEL, REVIEWER_PANEL };
    const positiveClaim = (phrase: string): RegExp =>
      new RegExp(
        `(?<!["NOT not ])\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b(?!["])`,
      );
    for (const banned of [
      "legally admissible",
      "guaranteed",
      "verified truth",
      "proves authenticity",
    ]) {
      for (const [name, src] of Object.entries(panels)) {
        expect(
          src,
          `${name} must not claim "${banned}"`,
        ).not.toMatch(positiveClaim(banned));
      }
    }
  });

  it("services do not import OTS / TSA / custody / report-generator / verification-package / billing engines", () => {
    const services = {
      WORKSPACE_ADMIN_SVC,
      GOVERNANCE_SVC,
      REVIEWER_SVC,
    };
    const forbidden = [
      /from\s+"[^"]*\/services\/custody/,
      /from\s+"[^"]*\/services\/timestamping/,
      /from\s+"[^"]*\/services\/ots/,
      /from\s+"[^"]*\/services\/billing-checkout/,
      /from\s+"[^"]*\/services\/report-generator/,
      /from\s+"[^"]*\/services\/verification-package/,
    ];
    for (const [name, src] of Object.entries(services)) {
      for (const re of forbidden) {
        expect(src, `${name} must not import ${re}`).not.toMatch(re);
      }
    }
  });

  it("canonical legacy routes remain intact (no accidental redirect breakage)", () => {
    // The bounded sub-routes preserved through 32.8E are still real pages
    // hosting the audited mutation flows.
    for (const path of [
      "app/(app)/teams/[id]/page.tsx",
      "app/(app)/governance/policy/page.tsx",
      "app/(app)/governance/retention/page.tsx",
      "app/(app)/governance/destruction/page.tsx",
      "app/(app)/governance/lifecycle/page.tsx",
      "app/(app)/reviewer-ops/[reviewId]/page.tsx",
      "app/(app)/reviewer-ops/sla/page.tsx",
      "app/(app)/reviewer-ops/escalations/page.tsx",
    ]) {
      expect(
        readWeb(path).length,
        `expected canonical legacy page ${path} to remain intact`,
      ).toBeGreaterThan(100);
    }
  });
});
