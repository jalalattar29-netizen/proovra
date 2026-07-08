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
// Phase Final-Closure-Remediation — the legacy `app/(app)/teams/page.tsx`
// was deleted (duplicate of `app/(app)/workspaces/page.tsx`). The
// canonical surface is `/workspaces`; the `/teams` URL now redirects
// there via `next.config.js`. We read the canonical surface instead.
const WORKSPACES_PAGE = readWeb("app/(app)/workspaces/page.tsx");
const NEXT_CONFIG = readWeb("next.config.js");
const GOVERNANCE_PAGE = readWeb("app/(app)/governance/page.tsx");
// Phase Final-Vocab-Alignment — the legacy `/reviewer-ops/page.tsx`
// was deleted. The canonical reviewer console moved to `/review/page.tsx`
// (Phase C0). The page still mounts a reviewer command surface; the
// component is now `<ReviewerConsole>` (the consolidated keyboard-first
// queue) rather than the older `<ReviewerCommandConsole>` panel. Tests
// that asserted the older panel name are now keyed on the canonical
// reviewer console mount instead.
const REVIEWER_PAGE = readWeb("app/(app)/review/page.tsx");

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

  it("personal-workspace returns status='ok' with empty data (capability degradation, Phase 32.8C FINAL-3)", () => {
    // Phase 32.8C FINAL-3 flipped the personal-workspace short-circuit
    // from `not_applicable` to `ok` with bounded empty data. The frontend
    // no longer hides the page; it renders enterprise-lite read-only
    // surfaces and gates mutating actions at the route level.
    expect(REVIEWER_SVC).toMatch(/if \(scope === "PERSONAL"\)/);
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
        new RegExp(`${section}:\\s*\\{\\s*status:\\s*"ok"`),
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
  it("/workspaces keeps the canonical WorkspaceAdministrationHome; /teams is self-serve canonical", () => {
    // Phase HOME-DATA-OWNERSHIP — the /teams → /workspaces redirect was
    // REMOVED: it shadowed the self-serve /teams landing
    // (app/(app)/teams/page.tsx, Phase IA-self-serve-completion) and
    // blanked Home's "Invite a teammate" for personal-space users.
    // /workspaces still mounts WorkspaceAdministrationHome; the
    // reverse mapping (/workspaces → /teams for self-serve) lives in
    // lib/surface/tiers.ts.
    expect(WORKSPACES_PAGE).toMatch(/<WorkspaceAdministrationHome\s*\/>/);
    expect(NEXT_CONFIG).not.toMatch(
      /source:\s*["']\/teams["'][\s\S]{0,200}destination:\s*["']\/workspaces["']/,
    );
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

  it("canManage gates admin CTAs via canonical TEAM_MANAGE capability", () => {
    // Phase 32.8 Foundation cleanup — role-string equality
    // replaced with ctx.can("TEAM_MANAGE"). VIEWER/MEMBER exclusion
    // enforced server-side in the capability resolver.
    const idx = WORKSPACE_PANEL.indexOf("canManage =");
    expect(idx).toBeGreaterThan(-1);
    const block = WORKSPACE_PANEL.slice(idx, idx + 200);
    expect(block).toMatch(/ctx\.can\(\s*['"]TEAM_MANAGE['"]\s*\)/);
  });

  it("renders distinct loading / auth-error / not-found / unavailable shells", () => {
    // CR1.6 — `ShellNoWorkspace` removed (dead-code cleanup). The
    // no-team rendering path is now PageRouteGate + the in-component
    // CapabilityDegradedPanel for personal users. The remaining four
    // structured shells are still required.
    for (const fn of [
      "ShellLoading",
      "ShellAuthError",
      "ShellNotFound",
      "ShellUnavailable",
    ]) {
      expect(WORKSPACE_PANEL).toMatch(new RegExp(`function ${fn}\\(`));
    }
    // Regression pin — must not be re-introduced.
    expect(WORKSPACE_PANEL).not.toMatch(/function ShellNoWorkspace\(/);
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

  it("personal workspace renders capability-degradation banner alongside the full tabs (Phase 32.8C FINAL-3)", () => {
    // Phase 32.8C FINAL-3 — Governance no longer hides the page for
    // personal workspaces. It renders an inline banner explaining that
    // team-only mutating actions are disabled, then the full tab set
    // renders below. The banner has a `data-governance-personal-banner`
    // hook for tests.
    expect(GOVERNANCE_PANEL).toMatch(/data-governance-personal-banner/);
    expect(GOVERNANCE_PANEL).toMatch(/read-only\s+enterprise-lite/);
    expect(GOVERNANCE_PANEL).toMatch(/Team-only mutating actions/);
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

  it("policy edit link is gated via canonical GOVERNANCE_ACT capability", () => {
    // Phase 32.8 Foundation cleanup — role-string equality replaced
    // with ctx.can("GOVERNANCE_ACT").
    expect(GOVERNANCE_PANEL).toMatch(
      /isAdmin\s*=\s*ctx\.can\(\s*['"]GOVERNANCE_ACT['"]\s*\)/,
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

describe("Phase 32.8E — /review canonical reviewer console mount", () => {
  it("delegates the canonical reviewer page to a reviewer console component", () => {
    // Phase Final-Vocab-Alignment — `/review/page.tsx` is now the
    // canonical reviewer surface (the legacy `/reviewer-ops/page.tsx`
    // was deleted). The consolidated keyboard-first console is
    // `<ReviewerConsole>`; the older `<ReviewerCommandConsole>` panel
    // remains as a building block for future re-mount but is no
    // longer the page-level component. Accept either canonical mount.
    expect(REVIEWER_PAGE).toMatch(/<Reviewer(Command)?Console\b/);
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

  it("personal workspace renders capability-degradation banner alongside the full surface (Phase 32.8C FINAL-3)", () => {
    // Phase 32.8C FINAL-3 — Reviewer Ops no longer hides the page for
    // personal workspaces. An inline banner explains team-only mutating
    // actions are disabled; the full reviewer surface renders below.
    expect(REVIEWER_PANEL).toMatch(/data-reviewer-personal-banner/);
    expect(REVIEWER_PANEL).toMatch(
      /Personal workspace[\s\S]{0,200}read-only enterprise-lite mode/,
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
    expect(REVIEWER_PANEL).toMatch(/href="\/operations\/observability"/);
  });

  it("renders distinct loading / auth-error / unavailable shells", () => {
    // CR1.6 — `ShellNoWorkspace` removed (dead-code cleanup). The
    // no-team rendering path is now the in-component
    // CapabilityDegradedPanel (REVIEWER_OPS_VIEW); PageRouteGate
    // (review.queue, ORGANIZATION_ONLY) blocks entry for personal
    // users. The remaining three structured shells are still required.
    for (const fn of [
      "ShellLoading",
      "ShellAuthError",
      "ShellUnavailable",
    ]) {
      expect(REVIEWER_PANEL).toMatch(new RegExp(`function ${fn}\\(`));
    }
    // Regression pin — must not be re-introduced.
    expect(REVIEWER_PANEL).not.toMatch(/function ShellNoWorkspace\(/);
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
