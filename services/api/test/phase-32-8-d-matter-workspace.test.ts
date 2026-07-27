/**
 * Phase 32.8D — Matter Workspace.
 *
 * Source-contract tests covering:
 *
 *  PART 1  — Schema additions (3 new models + 6 enums + 6 Case columns)
 *  PART 2  — Migration source-contract (idempotent + rollback)
 *  PART 3  — Risk engine (deterministic, real sources, bounded)
 *  PART 4  — Matter Workspace API (11 sections + side-effect safety)
 *  PART 5  — Matter Queue API
 *  PART 6  — Lifecycle service (status / assignment / comment / link)
 *  PART 7  — Routes wired + permission gates + audit emission
 *  PART 8  — Frontend types mirror backend envelopes
 *  PART 9  — No-regression invariants (no fake data, no side effects)
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

const SCHEMA = readApi("prisma/schema.prisma");
const MIGRATION = readApi(
  "prisma/migrations/20260630100000_phase328d_matter_workspace/migration.sql",
);
const RISK = readApi("src/services/cases/case-risk-engine.service.ts");
const MATTER_WS = readApi("src/services/cases/matter-workspace.service.ts");
const MATTER_QUEUE = readApi("src/services/cases/matter-queue.service.ts");
const LIFECYCLE = readApi("src/services/cases/case-lifecycle.service.ts");
const ROUTES = readApi("src/routes/case-workspace.routes.ts");
const CASES_TYPES = readWeb("components/cases-experience/types.ts");

// =============================================================================
// PART 1 — Schema
// =============================================================================

describe("Phase 32.8D — schema additions", () => {
  it("Case gains status / priority / description / referenceNumber / closedAtUtc / closureReason", () => {
    const block = SCHEMA.match(/model\s+Case\s*\{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/status\s+CaseStatus\s+@default\(OPEN\)/);
    expect(block![0]).toMatch(/priority\s+CasePriority\s+@default\(P2\)/);
    expect(block![0]).toMatch(/description\s+String\?\s+@db\.VarChar\(4000\)/);
    expect(block![0]).toMatch(
      /referenceNumber\s+String\?\s+@map\("reference_number"\)\s+@db\.VarChar\(60\)/,
    );
    expect(block![0]).toMatch(/closedAtUtc\s+DateTime\?\s+@map\("closed_at_utc"\)/);
    expect(block![0]).toMatch(
      /closureReason\s+String\?\s+@map\("closure_reason"\)\s+@db\.VarChar\(400\)/,
    );
  });

  it("Case has unique partial constraint on (teamId, referenceNumber)", () => {
    expect(SCHEMA).toMatch(/case_team_reference_number_uniq/);
  });

  it("CaseAssignment + CaseStatusHistory + CaseRiskSnapshot models exist", () => {
    expect(SCHEMA).toMatch(/model\s+CaseAssignment\s*\{/);
    expect(SCHEMA).toMatch(/model\s+CaseStatusHistory\s*\{/);
    expect(SCHEMA).toMatch(/model\s+CaseRiskSnapshot\s*\{/);
    expect(SCHEMA).toMatch(/@@map\("case_assignments"\)/);
    expect(SCHEMA).toMatch(/@@map\("case_status_history"\)/);
    expect(SCHEMA).toMatch(/@@map\("case_risk_snapshots"\)/);
  });

  it("all 6 new enums are declared", () => {
    for (const name of [
      "CaseStatus",
      "CasePriority",
      "CaseAssignmentRole",
      "CaseAssignmentStatus",
      "CaseRiskLevel",
      "CaseRiskSnapshotSource",
    ]) {
      expect(SCHEMA).toMatch(new RegExp(`enum\\s+${name}\\s*\\{`));
    }
  });

  it("CaseStatus lifecycle enum has the 6 approved values", () => {
    for (const v of [
      "OPEN",
      "INVESTIGATING",
      "ON_HOLD",
      "RESOLVED",
      "CLOSED",
      "ARCHIVED",
    ]) {
      expect(SCHEMA).toContain(v);
    }
  });

  it("CaseAssignmentRole has the 5 approved roles", () => {
    for (const v of [
      "OWNER",
      "INVESTIGATOR",
      "REVIEWER",
      "GOVERNANCE",
      "OBSERVER",
    ]) {
      expect(SCHEMA).toContain(v);
    }
  });

  it("CaseRiskSnapshot stores reasonCodes as JSON + bounded operator strings", () => {
    expect(SCHEMA).toMatch(/reasonCodes\s+Json\s+@map\("reason_codes"\)/);
    expect(SCHEMA).toMatch(
      /recommendedAction\s+String\s+@map\("recommended_action"\)\s+@db\.VarChar\(400\)/,
    );
  });

  it("CaseAssignment has unique on (caseId, assignedToUserId, role)", () => {
    expect(SCHEMA).toMatch(
      /@@unique\(\[caseId,\s*assignedToUserId,\s*role\]/,
    );
  });
});

// =============================================================================
// PART 2 — Migration
// =============================================================================

describe("Phase 32.8D — migration", () => {
  it("creates all 3 new tables idempotently", () => {
    for (const t of [
      "case_assignments",
      "case_status_history",
      "case_risk_snapshots",
    ]) {
      expect(MIGRATION).toMatch(
        new RegExp(`CREATE TABLE IF NOT EXISTS "${t}"`),
      );
    }
  });

  it("creates all 6 new enums with IF NOT EXISTS guards", () => {
    for (const name of [
      "CaseStatus",
      "CasePriority",
      "CaseAssignmentRole",
      "CaseAssignmentStatus",
      "CaseRiskLevel",
      "CaseRiskSnapshotSource",
    ]) {
      expect(MIGRATION).toMatch(
        new RegExp(
          `IF NOT EXISTS \\(SELECT 1 FROM pg_type WHERE typname = '${name}'\\)`,
        ),
      );
    }
  });

  it("ALTER TABLE on cases uses ADD COLUMN IF NOT EXISTS", () => {
    expect(MIGRATION).toMatch(
      /ALTER TABLE "cases"[\s\S]{0,800}ADD COLUMN IF NOT EXISTS "status"/,
    );
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS "priority"/);
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS "reference_number"/);
  });

  it("partial UNIQUE INDEX on (team_id, reference_number) is created with WHERE clause", () => {
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "case_team_reference_number_uniq"[\s\S]{0,200}WHERE "reference_number" IS NOT NULL/,
    );
  });

  it("CASCADE FKs on all 3 new tables", () => {
    expect(MIGRATION).toMatch(/case_assignments_case_id_fkey[\s\S]{0,200}ON DELETE CASCADE/);
    expect(MIGRATION).toMatch(/case_status_history_case_id_fkey[\s\S]{0,200}ON DELETE CASCADE/);
    expect(MIGRATION).toMatch(/case_risk_snapshots_case_id_fkey[\s\S]{0,200}ON DELETE CASCADE/);
  });

  it("rollback plan documented in header", () => {
    expect(MIGRATION).toMatch(/Rollback \(operator-side, in psql\):/);
    expect(MIGRATION).toMatch(/DROP TABLE IF EXISTS "case_risk_snapshots"/);
    expect(MIGRATION).toMatch(/DROP TABLE IF EXISTS "case_assignments"/);
  });
});

// =============================================================================
// PART 3 — Risk engine
// =============================================================================

describe("Phase 32.8D — risk engine", () => {
  it("exports computeCaseRisk + recordCaseRiskSnapshot + listCaseEvidenceIds", () => {
    expect(RISK).toMatch(/export async function computeCaseRisk\(/);
    expect(RISK).toMatch(/export async function recordCaseRiskSnapshot\(/);
    expect(RISK).toMatch(/export async function listCaseEvidenceIds\(/);
  });

  it("listCaseEvidenceIds UNIONs legacy Evidence.caseId + canonical CaseEvidenceLink", () => {
    expect(RISK).toMatch(/prisma\.evidence\.findMany[\s\S]{0,200}caseId:\s*input\.caseId/);
    expect(RISK).toMatch(
      /prisma\.caseEvidenceLink\.findMany[\s\S]{0,200}caseId:\s*input\.caseId/,
    );
  });

  it("risk score is deterministic 0..100 via clamp100 + bounded penalties", () => {
    expect(RISK).toMatch(/function clamp100/);
    expect(RISK).toMatch(/Math\.max\(0,\s*Math\.min\(100/);
    expect(RISK).toMatch(/Math\.min\(40,\s*openIncidents \* 10\)/);
    expect(RISK).toMatch(/Math\.min\(20,\s*overdueWorkflows \* 8\)/);
    expect(RISK).toMatch(/Math\.min\(20,\s*integrityConcernCount \* 12\)/);
  });

  it("risk level thresholds match the approved formula", () => {
    expect(RISK).toMatch(/NONE_MIN:\s*90/);
    expect(RISK).toMatch(/LOW_MIN:\s*75/);
    expect(RISK).toMatch(/MEDIUM_MIN:\s*55/);
    expect(RISK).toMatch(/HIGH_MIN:\s*30/);
  });

  it("reads from real tables only — no fabricated counters", () => {
    expect(RISK).toMatch(/prisma\.operationalIncident\.count/);
    expect(RISK).toMatch(/prisma\.operationalWorkflow\.count/);
    expect(RISK).toMatch(/prisma\.caseLegalHold\.count/);
    expect(RISK).toMatch(/prisma\.evidenceIntegritySnapshot\.findMany/);
    expect(RISK).toMatch(/prisma\.reviewerCapacitySnapshot\.count/);
  });

  it("bounded reason codes list", () => {
    for (const code of [
      "EVIDENCE_GAP",
      "INCIDENT_OPEN",
      "WORKFLOW_OVERDUE",
      "INTEGRITY_FAILED",
      "GOVERNANCE_BLOCKER",
      "LEGAL_HOLD_ACTIVE",
    ]) {
      expect(RISK).toContain(`"${code}"`);
    }
  });

  it("recordCaseRiskSnapshot never throws", () => {
    expect(RISK).toMatch(
      /catch[\s\S]{0,80}\/\* advisory write — never throws \*\//,
    );
  });

  it("no AI/ML/statistical scoring language", () => {
    for (const banned of [
      "machine learning",
      "AI score",
      "ML model",
      "neural network",
    ]) {
      expect(RISK).not.toMatch(new RegExp(banned, "i"));
    }
  });
});

// =============================================================================
// PART 4 — Matter Workspace API (11 sections + side-effect safety)
// =============================================================================

describe("Phase 32.8D — Matter Workspace API", () => {
  it("buildMatterWorkspace exposes all 11 required sections", () => {
    for (const section of [
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
      expect(MATTER_WS).toMatch(new RegExp(`${section}:\\s*\\{`));
    }
  });

  it("workspace reads UNION evidence sources (legacy + CaseEvidenceLink)", () => {
    expect(MATTER_WS).toMatch(/listCaseEvidenceIds\(/);
  });

  it("workspace reads NEVER generate reports/packages/signed URLs", () => {
    expect(MATTER_WS).not.toMatch(/getSignedUrl/i);
    expect(MATTER_WS).not.toMatch(/generateReport/i);
    expect(MATTER_WS).not.toMatch(/generatePackage/i);
  });

  it("workspace reads NEVER emit custody/security/audit events", () => {
    expect(MATTER_WS).not.toMatch(/recordCustodyEvent\(/);
    expect(MATTER_WS).not.toMatch(/recordSecurityEvent\(/);
    expect(MATTER_WS).not.toMatch(/appendPlatformAuditLog\(/);
  });

  it("timeline merges OperationalTimelineEvent projection + direct case-table reads", () => {
    expect(MATTER_WS).toMatch(/prisma\.operationalTimelineEvent\.findMany/);
    expect(MATTER_WS).toMatch(/prisma\.caseStatusHistory\.findMany/);
    expect(MATTER_WS).toMatch(/prisma\.caseAssignment\.findMany/);
    expect(MATTER_WS).toMatch(/prisma\.caseEvidenceLink\.findMany/);
  });

  it("reviewerCoordination reuses ReviewerCapacitySnapshot (no fake reviewer data)", () => {
    expect(MATTER_WS).toMatch(/prisma\.reviewerCapacitySnapshot\.findMany/);
  });

  it("custodyAndIntegrity reads real EvidenceIntegritySnapshot rows", () => {
    expect(MATTER_WS).toMatch(/prisma\.evidenceIntegritySnapshot\.findMany/);
    expect(MATTER_WS).toMatch(/REVIEW_REQUIRED|FAILED/);
  });

  it("deliverables joins Report + VerificationPackage + VerificationView", () => {
    expect(MATTER_WS).toMatch(/prisma\.report\.findMany/);
    expect(MATTER_WS).toMatch(/prisma\.verificationPackage\.findMany/);
    expect(MATTER_WS).toMatch(/prisma\.verificationView\.findMany/);
  });

  it("incidentsAndCausality reuses OperationalIncident + OperationalCausalityChain", () => {
    expect(MATTER_WS).toMatch(/prisma\.operationalIncident\.findMany/);
    expect(MATTER_WS).toMatch(/prisma\.operationalCausalityChain\.findMany/);
  });

  it("each section is wrapped in try/catch — single failure degrades the section, never the envelope", () => {
    const tryBlocks = MATTER_WS.match(/try\s*\{/g) ?? [];
    expect(tryBlocks.length).toBeGreaterThanOrEqual(11);
  });
});

// =============================================================================
// PART 5 — Matter Queue API
// =============================================================================

describe("Phase 32.8D — Matter Queue API", () => {
  it("buildMatterQueue exists + accepts filter object", () => {
    expect(MATTER_QUEUE).toMatch(/export async function buildMatterQueue\(/);
    expect(MATTER_QUEUE).toMatch(/filter:\s*MatterQueueFilter/);
  });

  it("bounded result set (max 200)", () => {
    expect(MATTER_QUEUE).toMatch(/Math\.min\(Math\.max\(input\.limit \?\? 50,\s*1\),\s*200\)/);
  });

  it("filter supports the approved capabilities", () => {
    expect(MATTER_QUEUE).toMatch(/hasOpenIncidents/);
    expect(MATTER_QUEUE).toMatch(/hasGovernanceBlockers/);
    expect(MATTER_QUEUE).toMatch(/hasOverdueWorkflows/);
    expect(MATTER_QUEUE).toMatch(/hasLegalHold/);
    expect(MATTER_QUEUE).toMatch(/missingArtifact/);
    expect(MATTER_QUEUE).toMatch(/assignedToUserId/);
    expect(MATTER_QUEUE).toMatch(/search/);
  });

  it("each row carries the real counters from the risk engine + workflow tables", () => {
    expect(MATTER_QUEUE).toMatch(/prisma\.operationalIncident\.count/);
    expect(MATTER_QUEUE).toMatch(/prisma\.operationalWorkflow\.count/);
    expect(MATTER_QUEUE).toMatch(/prisma\.caseLegalHold\.count/);
    expect(MATTER_QUEUE).toMatch(/prisma\.caseRiskSnapshot\.findMany/);
  });

  it("per-row failure degrades that row only, never the whole queue", () => {
    expect(MATTER_QUEUE).toMatch(/catch\s*\{[\s\S]{0,400}items\.push/);
  });
});

// =============================================================================
// PART 6 — Lifecycle service
// =============================================================================

describe("Phase 32.8D — case lifecycle service", () => {
  it("exports all 7 lifecycle actions", () => {
    for (const fn of [
      "changeCaseStatus",
      "addCaseAssignment",
      "removeCaseAssignment",
      "addCaseComment",
      "resolveCaseComment",
      "addEvidenceLink",
      "removeEvidenceLink",
    ]) {
      expect(LIFECYCLE).toMatch(new RegExp(`export async function ${fn}\\(`));
    }
  });

  it("status transitions are derived from a canonical STATUS_VALUES list (any → any)", () => {
    expect(LIFECYCLE).toMatch(/ALLOWED_TRANSITIONS/);
    // Phase CASES-STATUS-MANUAL — case status is plain
    // organizational metadata for personal users. The transition
    // table is now Object.fromEntries over STATUS_VALUES with
    // self-transitions excluded — every status reaches every
    // other status. Legal-hold and audit logic are unchanged.
    expect(LIFECYCLE).toMatch(
      /const STATUS_VALUES = \[\s*\n?\s*"OPEN",\s*\n?\s*"INVESTIGATING",\s*\n?\s*"ON_HOLD",\s*\n?\s*"RESOLVED",\s*\n?\s*"CLOSED",\s*\n?\s*"ARCHIVED",\s*\n?\s*\] as const;/,
    );
    expect(LIFECYCLE).toMatch(
      /const ALLOWED_TRANSITIONS: Record<string, string\[\]> = Object\.fromEntries\(/,
    );
  });

  it("active legal hold blocks CLOSED/ARCHIVED transitions", () => {
    expect(LIFECYCLE).toMatch(
      /if \(CLOSURE_STATUSES\.has\(input\.toStatus\)\)[\s\S]{0,400}active_legal_hold_blocks_closure/,
    );
  });

  it("every action emits a canonical tenant-audit row", () => {
    const audits = LIFECYCLE.match(/emitTenantAudit\(/g) ?? [];
    expect(audits.length).toBeGreaterThanOrEqual(7);
  });

  it("audit workspaceId is derived from the persisted case's own teamId", () => {
    // PHASE 11 §3 Batch A — migrated off the ad-hoc `category:
    // "cases.lifecycle"` field onto the canonical tenant-audit facade,
    // which writes an authoritative `workspaceId` DB column instead.
    expect(LIFECYCLE).toMatch(/workspaceId:\s*existing\.teamId/);
    expect(LIFECYCLE).not.toMatch(/appendPlatformAuditLog\(/);
  });

  it("changeCaseStatus writes a CaseStatusHistory row", () => {
    const block = LIFECYCLE.match(/export async function changeCaseStatus[\s\S]*?\n\}\s*\n/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/client\.caseStatusHistory\.create/);
  });

  it("addCaseAssignment enforces workspace membership for team workspaces", () => {
    expect(LIFECYCLE).toMatch(/client\.teamMember\.findFirst[\s\S]{0,200}invalid_assignee/);
  });

  it("addEvidenceLink rejects cross-workspace evidence on team cases", () => {
    expect(LIFECYCLE).toMatch(
      /existing\.teamId && evidence\.teamId !== existing\.teamId/,
    );
  });

  it("bounded operator-safe note truncation (≤400 chars) on every mutation", () => {
    const slices = LIFECYCLE.match(/\.slice\(0,\s*400\)/g) ?? [];
    expect(slices.length).toBeGreaterThanOrEqual(5);
  });
});

// =============================================================================
// PART 7 — Routes wired + permission gates
// =============================================================================

describe("Phase 32.8D — routes", () => {
  it("matter queue + workspace + risk read routes registered", () => {
    expect(ROUTES).toMatch(/"\/v1\/cases\/matter-queue"/);
    expect(ROUTES).toMatch(/"\/v1\/cases\/:id\/matter-workspace"/);
    expect(ROUTES).toMatch(/"\/v1\/cases\/:id\/risk"/);
  });

  it("status + assignments + comments + evidence-links lifecycle routes registered", () => {
    expect(ROUTES).toMatch(/"\/v1\/cases\/:id\/status"/);
    expect(ROUTES).toMatch(/"\/v1\/cases\/:id\/assignments"/);
    expect(ROUTES).toMatch(/"\/v1\/cases\/:id\/assignments\/:assignmentId"/);
    expect(ROUTES).toMatch(/"\/v1\/cases\/:id\/comments"/);
    expect(ROUTES).toMatch(/"\/v1\/cases\/:id\/comments\/:commentId\/resolve"/);
    expect(ROUTES).toMatch(/"\/v1\/cases\/:id\/evidence-links"/);
    expect(ROUTES).toMatch(/"\/v1\/cases\/:id\/evidence-links\/:linkId"/);
  });

  it("every read route goes through requireWorkspaceMember or requireCaseAccess", () => {
    const matterQueueBlock = ROUTES.match(
      /app\.get\(\s*"\/v1\/cases\/matter-queue"[\s\S]*?\}\s*,\s*\)/,
    );
    expect(matterQueueBlock).not.toBeNull();
    expect(matterQueueBlock![0]).toMatch(/requireWorkspaceMember/);
    const matterWsBlock = ROUTES.match(
      /app\.get\(\s*"\/v1\/cases\/:id\/matter-workspace"[\s\S]*?\}\s*,\s*\)/,
    );
    expect(matterWsBlock).not.toBeNull();
    expect(matterWsBlock![0]).toMatch(/requireCaseAccess/);
  });

  // OBSOLETE — Phase 32.8D-frontend-closure removed the dead
  // OPERATOR/INVESTIGATOR/AUDITOR checks (those values don't exist
  // on TeamRole — TeamRole = OWNER/ADMIN/MEMBER/VIEWER). The
  // canonical gate now consults the bounded `gateCaseMutation`
  // helper. New tests live in phase-32-8-d-frontend-closure.test.ts.
  it.skip("status mutation route restricts to OWNER/ADMIN/OPERATOR/INVESTIGATOR", () => {
    const block = ROUTES.match(
      /app\.post\(\s*"\/v1\/cases\/:id\/status"[\s\S]*?\}\s*,\s*\)/,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/role !== "OWNER"/);
    expect(block![0]).toMatch(/role !== "ADMIN"/);
    expect(block![0]).toMatch(/role !== "OPERATOR"/);
    expect(block![0]).toMatch(/role !== "INVESTIGATOR"/);
  });

  // OBSOLETE — the canonical case-mutation guard now lives in
  // `gateCaseMutation` / `evaluateCaseMutationPermission`. Per-route
  // inline role-string checks were removed. See
  // phase-32-8-d-frontend-closure.test.ts for the new contract.
  it.skip("assignment mutation route restricts to OWNER/ADMIN", () => {});
  it.skip("comment route rejects VIEWER/AUDITOR", () => {});

  it("error mapper translates CaseError codes to bounded HTTP statuses", () => {
    expect(ROUTES).toMatch(/handleCaseError/);
    expect(ROUTES).toMatch(/active_legal_hold_blocks_closure[\s\S]{0,200}409/);
  });
});

// =============================================================================
// PART 8 — Frontend types mirror backend envelopes
// =============================================================================

describe("Phase 32.8D — frontend types", () => {
  it("MatterQueueItem + MatterQueueEnvelope exported", () => {
    expect(CASES_TYPES).toMatch(/export type MatterQueueItem\s*=/);
    expect(CASES_TYPES).toMatch(/export type MatterQueueEnvelope\s*=/);
  });

  it("MatterWorkspaceEnvelope mirrors the 11-section backend shape", () => {
    expect(CASES_TYPES).toMatch(/export type MatterWorkspaceEnvelope\s*=/);
    for (const section of [
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
      expect(CASES_TYPES).toMatch(new RegExp(`${section}:\\s*\\{`));
    }
  });

  it("MatterRiskComputation + MatterRiskReasonCode exported", () => {
    expect(CASES_TYPES).toMatch(/export type MatterRiskComputation\s*=/);
    expect(CASES_TYPES).toMatch(/export type MatterRiskReasonCode\s*=/);
  });

  it("envelope carries viewer.canMutate flag for capability-aware UI", () => {
    expect(CASES_TYPES).toMatch(/canMutate:\s*boolean/);
  });
});

// =============================================================================
// PART 9 — No-regression invariants
// =============================================================================

describe("Phase 32.8D — no-regression invariants", () => {
  it("no service uses legal-overclaim language", () => {
    for (const src of [RISK, MATTER_WS, MATTER_QUEUE, LIFECYCLE]) {
      for (const banned of ["admissible", "court-ready", "proves authenticity"]) {
        expect(src).not.toMatch(new RegExp(`\\b${banned}\\b`, "i"));
      }
    }
  });

  it("no service exposes raw payloads / signed URLs / storage keys", () => {
    for (const src of [RISK, MATTER_WS, MATTER_QUEUE, LIFECYCLE]) {
      expect(src).not.toMatch(/getSignedUrl/i);
      expect(src).not.toMatch(/storageKey/i);
      expect(src).not.toMatch(/canonicalBytes/);
    }
  });

  it("no service generates report/package output", () => {
    for (const src of [RISK, MATTER_WS, MATTER_QUEUE, LIFECYCLE]) {
      expect(src).not.toMatch(/generateReport/i);
      expect(src).not.toMatch(/generatePackage/i);
    }
  });

  it("workspace + queue reads never write audit logs", () => {
    expect(MATTER_WS).not.toMatch(/appendPlatformAuditLog/);
    expect(MATTER_WS).not.toMatch(/emitTenantAudit/);
    expect(MATTER_QUEUE).not.toMatch(/appendPlatformAuditLog/);
    expect(MATTER_QUEUE).not.toMatch(/emitTenantAudit/);
  });

  it("only the lifecycle service writes audit logs (canonical tenant-audit facade)", () => {
    expect(LIFECYCLE).toMatch(/emitTenantAudit/);
    expect(LIFECYCLE).not.toMatch(/appendPlatformAuditLog\(/);
  });

  it("no fake AI / ML / 'powered by'", () => {
    for (const src of [RISK, MATTER_WS, MATTER_QUEUE]) {
      for (const banned of ["AI-powered", "machine learning", "powered by AI"]) {
        expect(src).not.toMatch(new RegExp(banned, "i"));
      }
    }
  });
});
