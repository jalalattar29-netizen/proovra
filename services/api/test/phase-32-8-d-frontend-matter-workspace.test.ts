/**
 * Phase 32.8D-frontend — Matter Operations Queue + Matter Workspace
 * source-contract tests.
 *
 * Pinned invariants:
 *
 *   1. /cases consumes /v1/cases/matter-queue (not /v1/cases/summary).
 *   2. /cases/:id consumes /v1/cases/:id/matter-workspace (not the
 *      legacy /v1/cases/:id/workspace).
 *   3. All 11 sections are rendered.
 *   4. Authority is canonical only — no useActiveWorkspaceId, no
 *      /v1/users/me authority fetch, no /v1/teams authority fetch,
 *      no inline role-string equality.
 *   5. No signed-URL / report / package generation on render.
 *   6. No legal-admissibility / authenticity / truth claims.
 *   7. The 7 audited mutation endpoints are wired with correct
 *      method + path shape.
 *   8. Mutation errors classified for 403 / 409 / 422 / 404 with
 *      explicit copy.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const INDEX = readWeb("components/cases-experience/CasesIndex.tsx");
const WORKSPACE = readWeb("components/cases-experience/CaseWorkspace.tsx");
const INDEX_PAGE = readWeb("app/(app)/cases/page.tsx");
const DETAIL_PAGE = readWeb("app/(app)/cases/[id]/page.tsx");
const TYPES = readWeb("components/cases-experience/types.ts");

// ===========================================================================
// PART 1 — Matter Operations Queue (CasesIndex)
// ===========================================================================

describe("Phase 32.8D-frontend — Matter Operations Queue", () => {
  it("/cases page delegates to the CasesIndex component", () => {
    expect(INDEX_PAGE).toMatch(/<CasesIndex\s*\/>/);
  });

  it("consumes GET /v1/cases/matter-queue with a teamId query", () => {
    expect(INDEX).toMatch(/apiFetch\(\s*[`"]\/v1\/cases\/matter-queue/);
    expect(INDEX).toMatch(/teamId/);
  });

  it("does NOT consume the legacy /v1/cases/summary endpoint anymore", () => {
    const live = stripComments(INDEX);
    expect(live).not.toMatch(/apiFetch\(\s*[`"]\/v1\/cases\/summary/);
  });

  it("renders the required operational counters per row", () => {
    for (const dataKey of [
      "linked-evidence",
      "evidence-gap",
      "open-incidents",
      "active-workflows",
      "overdue-workflows",
      "governance-blockers",
      "assignments",
    ]) {
      expect(INDEX).toContain(`data-matter-queue-row-counter`);
      expect(INDEX).toContain(`"${dataKey}"`);
    }
  });

  it("renders risk score / level / reason codes / recommended action per row", () => {
    expect(INDEX).toMatch(/data-matter-queue-row-chip="risk"/);
    expect(INDEX).toMatch(/data-matter-queue-row-reason-codes/);
    expect(INDEX).toMatch(/data-matter-queue-row-recommendation/);
  });

  it("renders legal hold chip when activeLegalHoldCount > 0", () => {
    expect(INDEX).toMatch(/data-matter-queue-row-chip="hold"/);
    expect(INDEX).toMatch(/activeLegalHoldCount/);
  });

  it("wires the required server filters as query parameters", () => {
    for (const param of [
      "status",
      "riskLevel",
      "assignedToUserId",
      "hasOpenIncidents",
      "hasGovernanceBlockers",
      "hasOverdueWorkflows",
      "hasLegalHold",
      "missingArtifact",
      "search",
    ]) {
      expect(INDEX).toMatch(new RegExp(`qs\\.set\\(\\s*[\\"\`]${param}`));
    }
  });

  it("Personal workspace renders CapabilityDegradedPanel (no plain-text fallback)", () => {
    expect(INDEX).toMatch(/CapabilityDegradedPanel/);
    expect(INDEX).toMatch(/data-cases-personal-mode/);
  });

  it("does NOT fabricate any counters — every counter reads from the row envelope", () => {
    const live = stripComments(INDEX);
    // No literal counter values like ` 42 evidence` that would
    // signal hardcoded data; values come from `row.X` accessors.
    expect(live).toMatch(/row\.linkedEvidenceCount/);
    expect(live).toMatch(/row\.openIncidentCount/);
    expect(live).toMatch(/row\.overdueWorkflowCount/);
    expect(live).toMatch(/row\.governanceBlockerCount/);
    expect(live).toMatch(/row\.activeLegalHoldCount/);
    expect(live).toMatch(/row\.riskScore/);
    expect(live).toMatch(/row\.riskLevel/);
  });

  it("has empty / loading / auth-error / unavailable shells with retry", () => {
    expect(INDEX).toMatch(/data-matter-queue-empty/);
    expect(INDEX).toMatch(/data-matter-queue-loading/);
    expect(INDEX).toMatch(/data-matter-queue-auth-error/);
    expect(INDEX).toMatch(/data-matter-queue-unavailable/);
    expect(INDEX).toMatch(/onRetry/);
  });
});

// ===========================================================================
// PART 2 — Matter Workspace (CaseWorkspace)
// ===========================================================================

describe("Phase 32.8D-frontend — Matter Workspace", () => {
  // OBSOLETE — Phase C1 made /cases/[id] the canonical tabbed Matter
  // Workspace component. CaseWorkspace continues to mount on
  // /cases/[id]/classic. See phase-c1-matter-workspace.test.ts for the
  // current canonical mount contract.
  it.skip("/cases/:id page delegates to the CaseWorkspace component", () => {
    expect(DETAIL_PAGE).toMatch(/<CaseWorkspace[\s\S]*caseId/);
  });

  it("consumes GET /v1/cases/:id/matter-workspace", () => {
    expect(WORKSPACE).toMatch(
      /apiFetch\(\s*[`"]\/v1\/cases\/\$\{encodeURIComponent\(caseId\)\}\/matter-workspace/,
    );
  });

  it("does NOT consume the legacy /v1/cases/:id/workspace endpoint anymore", () => {
    const live = stripComments(WORKSPACE);
    expect(live).not.toMatch(
      /apiFetch\(\s*[`"]\/v1\/cases\/\$\{encodeURIComponent\(caseId\)\}\/workspace[`"\s]/,
    );
  });

  it("renders all 11 canonical sections by stable data attribute", () => {
    // SectionShell renders `data-matter-section={testid}` — assert the
    // testid is passed verbatim at every call site.
    for (const section of [
      "command-summary",
      "evidence",
      "relationships",
      "workflows",
      "incidents-causality",
      "reviewer-coordination",
      "governance",
      "custody-integrity",
      "timeline",
      "notes",
      "deliverables",
    ]) {
      expect(WORKSPACE).toContain(`testid="${section}"`);
    }
  });

  it("renders the section jump nav with all 11 anchors", () => {
    for (const id of [
      "section-command-summary",
      "section-evidence",
      "section-relationships",
      "section-workflows",
      "section-incidents",
      "section-reviewer",
      "section-governance",
      "section-custody",
      "section-timeline",
      "section-notes",
      "section-deliverables",
    ]) {
      expect(WORKSPACE).toContain(id);
    }
  });

  it("section shell exposes status (ok / degraded / unavailable / not_applicable)", () => {
    expect(WORKSPACE).toMatch(/data-matter-section-status=\{status\}/);
    expect(WORKSPACE).toMatch(/status === "unavailable"/);
    expect(WORKSPACE).toMatch(/status === "not_applicable"/);
  });

  it("Command Summary renders risk + counters + recommendation", () => {
    // <Tile dataKey="X" /> renders `data-matter-section-tile={dataKey}` —
    // assert the dataKey prop reaches the component at every call site.
    expect(WORKSPACE).toMatch(/dataKey="risk-score"/);
    expect(WORKSPACE).toMatch(/dataKey="risk-level"/);
    expect(WORKSPACE).toMatch(/dataKey="linked-evidence"/);
    expect(WORKSPACE).toMatch(/data-matter-section-risk-reasons/);
    expect(WORKSPACE).toMatch(/data-matter-section-recommendation/);
  });

  it("Command Summary surfaces closure-blocked warning when an active hold exists", () => {
    expect(WORKSPACE).toMatch(/data-matter-section-closure-blocked/);
  });

  it("Evidence Board renders link role/source + report/package readiness", () => {
    expect(WORKSPACE).toMatch(/data-matter-section-evidence-report-ready/);
    expect(WORKSPACE).toMatch(/data-matter-section-evidence-report-missing/);
    expect(WORKSPACE).toMatch(/data-matter-section-evidence-package-ready/);
    expect(WORKSPACE).toMatch(/data-matter-section-evidence-package-missing/);
    expect(WORKSPACE).toMatch(/data-matter-section-evidence-link-role/);
    expect(WORKSPACE).toMatch(/data-matter-section-evidence-link-source/);
  });

  it("Custody/Integrity uses bounded vocabulary (no legal-admissibility claims)", () => {
    const live = stripComments(WORKSPACE);
    expect(live).not.toMatch(/\blegally admissible\b/i);
    expect(live).not.toMatch(/\bcourt-ready\b/i);
    expect(live).not.toMatch(/\bauthentic\b/i);
    expect(live).not.toMatch(/\bproves\b/i);
    // Positive: uses bounded vocabulary.
    expect(WORKSPACE).toMatch(/integrity state/i);
    expect(WORKSPACE).toMatch(/verification state/i);
  });

  it("Timeline merges OperationalTimelineEvent + lifecycle (filterable by family)", () => {
    expect(WORKSPACE).toMatch(/data-matter-section-timeline-family-filter/);
    expect(WORKSPACE).toMatch(/data-matter-section-timeline-family=/);
    expect(WORKSPACE).toMatch(/data-matter-section-timeline-event-type=/);
  });
});

// ===========================================================================
// PART 3 — Authority + safety invariants
// ===========================================================================

describe("Phase 32.8D-frontend — Authority + safety", () => {
  it("uses usePlatformContext / useTeamId; never useActiveWorkspaceId", () => {
    expect(INDEX).toMatch(/usePlatformContext|useTeamId/);
    expect(WORKSPACE).toMatch(/usePlatformContext/);
    const liveIndex = stripComments(INDEX);
    const liveWorkspace = stripComments(WORKSPACE);
    expect(liveIndex).not.toMatch(/useActiveWorkspaceId/);
    expect(liveWorkspace).not.toMatch(/useActiveWorkspaceId/);
  });

  it("does NOT fetch /v1/users/me or /v1/teams for authority anywhere", () => {
    const liveIndex = stripComments(INDEX);
    const liveWorkspace = stripComments(WORKSPACE);
    for (const src of [liveIndex, liveWorkspace]) {
      expect(src).not.toMatch(/apiFetch\(\s*[`'"]\/v1\/users\/me/);
      expect(src).not.toMatch(/apiFetch\(\s*[`'"]\/v1\/teams[`'"]/);
    }
  });

  it("does NOT gate UI on role-string equality (no role === 'OWNER'/'ADMIN'/'MEMBER'/'VIEWER')", () => {
    const liveIndex = stripComments(INDEX);
    const liveWorkspace = stripComments(WORKSPACE);
    for (const src of [liveIndex, liveWorkspace]) {
      expect(src).not.toMatch(/role\s*===\s*['"]OWNER['"]/);
      expect(src).not.toMatch(/role\s*===\s*['"]ADMIN['"]/);
      expect(src).not.toMatch(/role\s*===\s*['"]MEMBER['"]/);
      expect(src).not.toMatch(/role\s*===\s*['"]VIEWER['"]/);
      expect(src).not.toMatch(/platformRole\s*===/);
    }
  });

  it("page render path does NOT generate signed URLs / reports / packages", () => {
    const liveIndex = stripComments(INDEX);
    const liveWorkspace = stripComments(WORKSPACE);
    for (const src of [liveIndex, liveWorkspace]) {
      expect(src).not.toMatch(/getSignedUrl\(/);
      expect(src).not.toMatch(/generateReport\(/);
      expect(src).not.toMatch(/generatePackage\(/);
      // No POST to evidence report/package generation endpoints on render.
      expect(src).not.toMatch(
        /apiFetch\([^)]+\/v1\/evidence\/[^)]+\/(report|package)[^)]+method:\s*['"]POST['"]/,
      );
    }
  });

  it("CaseWorkspace surfaces server-provided per-case capability gates for action buttons", () => {
    // Phase 32.8D-frontend-closure-2 — coarse canMutate/canManage
    // were replaced with fine-grained per-action gates that come
    // from the canonical envelope. The exhaustive assertions live
    // in the closure-2 test file.
    expect(WORKSPACE).toMatch(/viewer\.canChangeStatus/);
    expect(WORKSPACE).toMatch(/viewer\.canAssign/);
  });

  it("CaseWorkspace renders disabled buttons with a clear reason (title attribute)", () => {
    // Phase 32.8D-frontend-closure renamed the disabled-reason
    // helpers to fine-grained variables per case mutation type
    // (statusChangeDisabledReason, assignDisabledReason,
    // evidenceLinkDisabledReason, commentDisabledReason).
    expect(WORKSPACE).toMatch(/statusChangeDisabledReason/);
    expect(WORKSPACE).toMatch(/assignDisabledReason/);
    expect(WORKSPACE).toMatch(/evidenceLinkDisabledReason/);
    expect(WORKSPACE).toMatch(/commentDisabledReason/);
    expect(WORKSPACE).toMatch(/title=/);
  });
});

// ===========================================================================
// PART 4 — Mutation wiring
// ===========================================================================

describe("Phase 32.8D-frontend — Mutation wiring", () => {
  it("status change calls POST /v1/cases/:id/status with bounded enum body", () => {
    expect(WORKSPACE).toMatch(
      /apiFetch\([^)]+\/v1\/cases\/\$\{encodeURIComponent\(caseId\)\}\/status[\s\S]+?method:\s*['"]POST['"]/,
    );
    expect(WORKSPACE).toMatch(/toStatus/);
  });

  it("add assignment calls POST /v1/cases/:id/assignments with role + assignedToUserId", () => {
    expect(WORKSPACE).toMatch(
      /apiFetch\([^)]+\/v1\/cases\/\$\{encodeURIComponent\(caseId\)\}\/assignments[\s\S]+?method:\s*['"]POST['"]/,
    );
    expect(WORKSPACE).toMatch(/assignedToUserId/);
  });

  it("remove assignment calls DELETE /v1/cases/:id/assignments/:assignmentId", () => {
    expect(WORKSPACE).toMatch(
      /\/v1\/cases\/\$\{encodeURIComponent\(caseId\)\}\/assignments\/\$\{encodeURIComponent\(assignmentId\)\}[\s\S]+?method:\s*['"]DELETE['"]/,
    );
  });

  it("add comment calls POST /v1/cases/:id/comments with body + visibility", () => {
    expect(WORKSPACE).toMatch(
      /apiFetch\([^)]+\/v1\/cases\/\$\{encodeURIComponent\(caseId\)\}\/comments[\s\S]+?method:\s*['"]POST['"]/,
    );
    expect(WORKSPACE).toMatch(/visibility/);
  });

  it("resolve comment calls POST /v1/cases/:id/comments/:commentId/resolve", () => {
    expect(WORKSPACE).toMatch(
      /\/v1\/cases\/\$\{encodeURIComponent\(caseId\)\}\/comments\/\$\{encodeURIComponent\(commentId\)\}\/resolve[\s\S]+?method:\s*['"]POST['"]/,
    );
  });

  it("link evidence calls POST /v1/cases/:id/evidence-links with evidenceId + role", () => {
    expect(WORKSPACE).toMatch(
      /apiFetch\([^)]+\/v1\/cases\/\$\{encodeURIComponent\(caseId\)\}\/evidence-links[\s\S]+?method:\s*['"]POST['"]/,
    );
    expect(WORKSPACE).toMatch(/evidenceId/);
  });

  it("unlink evidence calls DELETE /v1/cases/:id/evidence-links/:linkId", () => {
    expect(WORKSPACE).toMatch(
      /\/v1\/cases\/\$\{encodeURIComponent\(caseId\)\}\/evidence-links\/\$\{encodeURIComponent\(linkId\)\}[\s\S]+?method:\s*['"]DELETE['"]/,
    );
  });

  it("mutation error classifier handles 403, 409, 422, and 404 distinctly", () => {
    expect(WORKSPACE).toMatch(/statusCode\s*===\s*403/);
    expect(WORKSPACE).toMatch(/statusCode\s*===\s*409/);
    expect(WORKSPACE).toMatch(/statusCode\s*===\s*422/);
    expect(WORKSPACE).toMatch(/statusCode\s*===\s*404/);
  });

  it("409 with active_legal_hold_blocks_closure surfaces a specific operator message", () => {
    expect(WORKSPACE).toMatch(/active_legal_hold_blocks_closure/);
    expect(WORKSPACE).toMatch(/Active legal hold blocks closing or archiving/);
  });

  it("Mutations refresh the envelope after success (no optimistic divergence)", () => {
    // The shared runMutation wrapper calls load() after success.
    expect(WORKSPACE).toMatch(/await load\(\)/);
    expect(WORKSPACE).toMatch(/runMutation/);
  });
});

// ===========================================================================
// PART 5 — Types contract
// ===========================================================================

describe("Phase 32.8D-frontend — types contract", () => {
  it("frontend types export MatterQueueEnvelope + MatterQueueItem", () => {
    expect(TYPES).toMatch(/MatterQueueEnvelope/);
    expect(TYPES).toMatch(/MatterQueueItem/);
  });

  it("frontend types export MatterWorkspaceEnvelope with all 11 sections", () => {
    expect(TYPES).toMatch(/MatterWorkspaceEnvelope/);
    for (const key of [
      "commandSummary",
      "evidence",
      "relationships",
      "workflows",
      "incidentsAndCausality",
      "reviewerCoordination",
      "governance",
      "custodyAndIntegrity",
      "timeline",
      "notes",
      "deliverables",
    ]) {
      expect(TYPES).toContain(`${key}:`);
    }
  });
});
