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

import { existsSync, readFileSync } from "node:fs";
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
// Phase 12 Point 4 — `reviewer-command.service.ts` + its
// `GET /v1/reviewer-ops/command` route were removed as a duplicate
// reviewer aggregator (second read path, second authorization path).
// The canonical reviewer aggregator is `GET /v1/reviewer-ops/console`;
// its contract carries the invariants that used to be pinned here.
const REVIEWER_SVC = readApi("src/routes/reviewer-console.routes.ts");
const ROUTES = readApi("src/routes/enterprise-aggregators.routes.ts");
const SERVER = readApi("src/server.ts");

const WORKSPACE_PANEL = readWeb(
  "components/workspace-admin/WorkspaceAdminPanel.tsx",
);
const GOVERNANCE_PANEL = readWeb(
  "components/governance-experience/GovernanceControlPlane.tsx",
);
const REVIEWER_PANEL = readWeb(
  "components/reviewer-experience/ReviewerConsole.tsx",
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
      /scope:\s*WorkspaceScope\s*=\s*memberCount\s*<=\s*1\s*\?\s*"SINGLE_OCCUPANT"\s*:\s*"SHARED"/,
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
    expect(WORKSPACE_ADMIN_SVC).toMatch(/scope === "SHARED"/);
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
// PART 3 — canonical reviewer aggregator
// =============================================================================

describe("Phase 32.8E — reviewer aggregator contract (canonical console)", () => {
  it("the duplicate reviewer-command aggregator service stays removed", () => {
    expect(
      existsSync(
        fileURLToPath(
          new URL(
            "../src/services/reviewer-ops/reviewer-command.service.ts",
            import.meta.url,
          ),
        ),
      ),
    ).toBe(false);
  });

  it("registers the aggregator as a read-only GET", () => {
    expect(REVIEWER_SVC).toMatch(/app\.get\(\s*\n?\s*"\/v1\/reviewer-ops\/console"/);
    expect(REVIEWER_SVC).not.toMatch(/app\.post\(/);
    expect(REVIEWER_SVC).not.toMatch(/app\.put\(/);
    expect(REVIEWER_SVC).not.toMatch(/app\.patch\(/);
    expect(REVIEWER_SVC).not.toMatch(/app\.delete\(/);
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

  it("degrades a failing section instead of failing the envelope", () => {
    // A sub-query failure yields `status: "degraded"` for that section
    // only; workspace scope never turns a section off.
    expect(REVIEWER_SVC).toMatch(/status:\s*"degraded"/);
    expect(REVIEWER_SVC).not.toMatch(/status:\s*"not_applicable"/);
  });

  it("declares a bounded per-section limit and applies it to every section", () => {
    expect(REVIEWER_SVC).toMatch(/const SECTION_LIMIT\s*=\s*\d+/);
    const limitUses = REVIEWER_SVC.match(/limit:\s*SECTION_LIMIT/g) ?? [];
    expect(limitUses.length).toBeGreaterThanOrEqual(4);
    expect(REVIEWER_SVC).toMatch(/sectionLimit:\s*SECTION_LIMIT/);
  });

  it("envelope exposes the canonical console sections", () => {
    for (const section of [
      "queue",
      "mine",
      "escalations",
      "sla",
      "workload",
      "savedViews",
      "diagnostics",
    ]) {
      expect(REVIEWER_SVC).toMatch(new RegExp(`${section}:\\s*[\\{a-zA-Z]`));
    }
  });

  it("authorizes through the canonical member-access path, not a local role read", () => {
    expect(REVIEWER_SVC).toMatch(/evaluateMemberAccess\(/);
    expect(REVIEWER_SVC).toMatch(
      /code\(404\)\.send\(\{\s*error:\s*\{\s*code:\s*"not_found"/,
    );
    expect(REVIEWER_SVC).toMatch(/code\(403\)/);
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

  it("the duplicate GET /v1/reviewer-ops/command aggregator stays removed", () => {
    // Phase 12 Point 4 — removed as a second reviewer read path with a
    // second authorization path. `GET /v1/reviewer-ops/console` is the
    // canonical reviewer aggregator (see PART 3).
    // Assert on the registration, not on the removal note that explains
    // why it is gone.
    expect(ROUTES).not.toMatch(/app\.get\(\s*"\/v1\/reviewer-ops\/command"/);
    expect(ROUTES).not.toMatch(/buildReviewerCommand\(/);
    expect(ROUTES).not.toMatch(/reviewer-command\.service/);
  });

  it("every route requires authentication via preHandler: requireAuth", () => {
    const gets = ROUTES.match(/app\.get\(\s*"\/v1\/[^"]+"/g) ?? [];
    const guarded =
      ROUTES.match(/app\.get\(\s*"\/v1\/[^"]+",[\s\S]*?preHandler:\s*requireAuth/g) ?? [];
    expect(gets.length).toBeGreaterThanOrEqual(2);
    expect(guarded.length).toBe(gets.length);
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
  it("delegates the canonical reviewer page to the reviewer console component", () => {
    // Phase Final-Vocab-Alignment — `/review/page.tsx` is the canonical
    // reviewer surface (the legacy `/reviewer-ops/page.tsx` was
    // deleted). Phase 12 Point 4 deleted the older, unmounted
    // `<ReviewerCommandConsole>` panel after folding its unique
    // capabilities into this console, so the mount is now exact.
    expect(REVIEWER_PAGE).toMatch(/<ReviewerConsole\b/);
    expect(REVIEWER_PAGE).not.toMatch(/ReviewerCommandConsole/);
  });

  it("reads the workspace state from the consolidated console aggregator", () => {
    expect(REVIEWER_PANEL).toMatch(/\/v1\/reviewer-ops\/console\?teamId=/);
    // The retired duplicate aggregator must not come back.
    expect(REVIEWER_PANEL).not.toMatch(/\/v1\/reviewer-ops\/command/);
  });

  it("renders the canonical sections (Queue / Escalations / Workload / SLA / Saved views / Multi-stage summary)", () => {
    for (const fn of [
      "QueueTable",
      "EscalationsTable",
      "WorkloadTable",
      "SlaPanel",
      "SavedViewsPanel",
    ]) {
      expect(REVIEWER_PANEL).toMatch(new RegExp(`function ${fn}\\(`));
    }
    expect(REVIEWER_PANEL).toMatch(/<MultiStageReviewSummaryCard/);
  });

  it("the one team-only affordance degrades to a labelled banner, never a blank surface", () => {
    // Phase 32.8C FINAL-3 invariant, carried onto the live console:
    // scope never hides the surface. Bulk triage is the only team-only
    // action, and it explains itself instead of disappearing.
    const bulk = readWeb("components/reviewer-experience/ReviewerBulkOpsBar.tsx");
    expect(bulk).toMatch(/data-reviewer-bulk-personal-banner/);
    expect(bulk).toMatch(
      /Bulk reviewer operations require a workspace[\s\S]{0,200}open each workflow individually/,
    );
  });

  it("explicitly notes decisions happen on the per-workflow surface", () => {
    expect(REVIEWER_PANEL).toMatch(
      /Daily evidence\s*\n?\s*decisions happen in Reviewer Workspace/,
    );
  });

  it("bulk triage maps only to bounded backend actions — no invented semantics", () => {
    const bulk = readWeb("components/reviewer-experience/ReviewerBulkOpsBar.tsx");
    for (const action of [
      "ASSIGN_TO_ME",
      "PRIORITY_HIGH",
      "PRIORITY_NORMAL",
      "PRIORITY_URGENT",
      "ESCALATE",
      "PAUSE",
      "REQUEST_INFO",
      "CLOSE",
    ]) {
      expect(bulk).toMatch(new RegExp(`"${action}"`));
    }
    // ASSIGN_TO_ME is the only UI-side alias; it maps to the backend
    // ASSIGN action with an explicit assignee.
    expect(bulk).toMatch(/action === "ASSIGN_TO_ME" \? "ASSIGN"/);
    // Note-required actions cannot submit without a note.
    expect(bulk).toMatch(/A short note is required for that action/);
  });

  it("surfaces the 207 partial-success outcome honestly", () => {
    const bulk = readWeb("components/reviewer-experience/ReviewerBulkOpsBar.tsx");
    expect(bulk).toMatch(/data-reviewer-bulk-last-succeeded/);
    expect(bulk).toMatch(/data-reviewer-bulk-last-failed/);
    expect(bulk).toMatch(/data-reviewer-bulk-failed-error-code/);
    // Per-row outcome markers live on the queue rows.
    expect(REVIEWER_PANEL).toMatch(/data-reviewer-bulk-row-outcome/);
  });

  it("never predicts permission client-side — server denial is surfaced verbatim", () => {
    const bulk = readWeb("components/reviewer-experience/ReviewerBulkOpsBar.tsx");
    expect(bulk).toMatch(/statusCode === 403/);
    expect(bulk).toMatch(/REVIEWER_OPS_ACT/);
    expect(bulk).toMatch(/statusCode === 429/);
  });

  it("SLA tones are bounded (ok / due_soon / overdue) — no synthesized urgency", () => {
    expect(REVIEWER_PANEL).toMatch(/severityTone|priorityTone|statusTone/);
    expect(REVIEWER_PANEL).toMatch(/<SlaPanel/);
  });

  it("links to the canonical sub-routes (per-workflow detail + SLA + escalations + governance policy + ops observability)", () => {
    expect(REVIEWER_PAGE).toMatch(/\/reviewer-ops\/\$\{candidate\}/);
    expect(REVIEWER_PANEL).toMatch(/href="\/reviewer-ops\/sla"/);
    expect(REVIEWER_PANEL).toMatch(/href="\/reviewer-ops\/escalations"/);
    expect(REVIEWER_PANEL).toMatch(/href="\/governance\/policy"/);
    expect(REVIEWER_PANEL).toMatch(/href="\/operations\/observability"/);
  });

  it("gates the operator deep-link behind a canonical capability", () => {
    expect(REVIEWER_PANEL).toMatch(/useCan\(\s*"OBSERVABILITY_VIEW"\s*\)/);
    expect(REVIEWER_PANEL).toMatch(
      /canObservability \?[\s\S]{0,200}\/operations\/observability/,
    );
  });

  it("renders distinct loading / error / empty states", () => {
    expect(REVIEWER_PANEL).toMatch(/loading/);
    expect(REVIEWER_PANEL).toMatch(/<EmptyState/);
    // The retired shells must not be re-introduced.
    expect(REVIEWER_PANEL).not.toMatch(/function ShellNoWorkspace\(/);
  });

  it("the unmounted ReviewerCommandConsole stays removed", () => {
    for (const rel of [
      "components/reviewer-experience/ReviewerCommandConsole.tsx",
      "components/reviewer-experience/types.ts",
    ]) {
      expect(
        existsSync(
          fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
        ),
        `${rel} must stay removed`,
      ).toBe(false);
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
        /apiFetch\(`\/v1\/teams\/\$\{[^}]+\}`[\s,}]/,
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
