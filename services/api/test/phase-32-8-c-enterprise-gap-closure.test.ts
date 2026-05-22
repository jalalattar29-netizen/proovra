/**
 * Phase 32.8C FINAL-3 — Enterprise Gap Closure.
 *
 * Source-contract tests covering:
 *
 *  PART 1 — Reviewer Ops + Governance: no hard personal-workspace fallback
 *  PART 2 — Header: no raw UUID; scope-derived label
 *  PART 3 — Schema: 4 new tables + 9 new enums
 *  PART 4 — Migration: idempotent + rollback documented
 *  PART 5 — Reviewer capacity engine (deterministic, real sources)
 *  PART 6 — Bulk actions service + routes (audited, permission gates,
 *           no destructive retry)
 *  PART 7 — Operational graph engine (real sources, idempotent)
 *  PART 8 — Organizational health writer (deterministic scoring)
 *  PART 9 — Persona resolver + capability matrix
 *  PART 10 — Dashboard envelope wiring
 *  PART 11 — Frontend renders new boards
 *  PART 12 — No regression invariants (no fake data, no overclaim,
 *            no auth bypass, no destructive retry)
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
  "prisma/migrations/20260629100000_phase328c_enterprise_gap_closure/migration.sql",
);
const REV_CAP = readApi("src/services/dashboard/reviewer-capacity.service.ts");
const BULK = readApi("src/services/dashboard/bulk-actions.service.ts");
const GRAPH = readApi("src/services/dashboard/operational-graph.service.ts");
const ORG_HEALTH = readApi("src/services/dashboard/org-health.service.ts");
const PERSONA = readApi("src/services/dashboard/persona-resolver.service.ts");
const OPS_ROUTES = readApi("src/routes/ops.routes.ts");
const COMMAND_CENTER = readApi(
  "src/services/dashboard/command-center.service.ts",
);
const REVIEWER_BACKEND = readApi(
  "src/services/reviewer-ops/reviewer-command.service.ts",
);
const REVIEWER_TSX = readWeb(
  "components/reviewer-experience/ReviewerCommandConsole.tsx",
);
const GOVERNANCE_TSX = readWeb(
  "components/governance-experience/GovernanceControlPlane.tsx",
);
const TOPBAR_TSX = readWeb("components/app-shell-v2/AppTopbarV2.tsx");
const CC_TYPES = readWeb("components/command-center/types.ts");
const CC_TSX = readWeb("components/command-center/CommandCenter.tsx");

// =============================================================================
// PART 1 — Reviewer Ops + Governance: no hard personal-workspace fallback
// =============================================================================

describe("Phase 32.8C FINAL-3 — Reviewer Ops + Governance gating fix", () => {
  it("Reviewer Ops does NOT early-return a plain text fallback for personal workspace", () => {
    // The previous broken pattern wrapped EVERY non-team workspace in a
    // <section data-reviewer-personal> with only text. The new layout
    // renders the full surface plus an inline banner.
    expect(REVIEWER_TSX).not.toMatch(
      /<section className="cc-section" data-reviewer-personal>/,
    );
    expect(REVIEWER_TSX).toMatch(/data-reviewer-personal-banner/);
  });

  it("Reviewer Ops renders all section components for both scopes", () => {
    // The non-team branch used to skip these. Now they render every time.
    const block = REVIEWER_TSX.match(/!isTeam \? \([\s\S]*?\) : null\}[\s\S]*?ReconciliationSection/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/<SummarySection/);
    expect(block![0]).toMatch(/<QueuePeekSection/);
    expect(block![0]).toMatch(/<EscalationsSection/);
    expect(block![0]).toMatch(/<WorkloadSection/);
    expect(block![0]).toMatch(/<PolicySection/);
    expect(block![0]).toMatch(/<ReconciliationSection/);
  });

  it("Governance does NOT early-return a plain text fallback for personal workspace", () => {
    expect(GOVERNANCE_TSX).not.toMatch(
      /<section className="cc-section" data-governance-personal>/,
    );
    expect(GOVERNANCE_TSX).toMatch(/data-governance-personal-banner/);
  });

  it("Reviewer Ops backend returns status='ok' (not 'not_applicable') for personal workspace", () => {
    expect(REVIEWER_BACKEND).toMatch(
      /scope === "PERSONAL"[\s\S]{0,400}status:\s*"ok"/,
    );
    expect(REVIEWER_BACKEND).not.toMatch(
      /scope === "PERSONAL"[\s\S]{0,400}status:\s*"not_applicable"/,
    );
  });

  it("Reviewer Ops personal banner labels team-only actions explicitly", () => {
    expect(REVIEWER_TSX).toMatch(
      /Team-only actions[\s\S]{0,200}disabled with clear labels/,
    );
  });

  it("Governance personal banner labels team-only actions explicitly", () => {
    expect(GOVERNANCE_TSX).toMatch(
      /Team-only mutating actions[\s\S]{0,200}disabled with clear labels/,
    );
  });
});

// =============================================================================
// PART 2 — Header: no raw UUID
// =============================================================================

describe("Phase 32.8C FINAL-3 — header workspace display", () => {
  it("topbar NEVER falls back to workspace.workspaceId in the display", () => {
    // The previous broken pattern wrote `: workspace.workspaceId` as the
    // last fallback. The new code uses a scope-derived label
    // ("Personal workspace" / "Workspace") instead.
    const block = TOPBAR_TSX.match(/strong data-workspace-name>[\s\S]*?<\/strong>/);
    expect(block).not.toBeNull();
    expect(block![0]).not.toMatch(/workspace\.workspaceId/);
  });

  it("topbar renders scope-derived label when name is missing", () => {
    expect(TOPBAR_TSX).toMatch(/"Personal workspace"/);
    expect(TOPBAR_TSX).toMatch(/"Workspace"/);
  });

  it("teams fetch does NOT fall back to the raw id as the name", () => {
    // The previous broken line was: `name: ... ? t.name : t.id`.
    // The new line uses `: null` so the chip uses a scope-derived label.
    expect(TOPBAR_TSX).not.toMatch(/name:\s*typeof t\.name === "string" && t\.name \? t\.name : t\.id/);
    expect(TOPBAR_TSX).toMatch(
      /name:\s*typeof t\.name === "string" && t\.name \? t\.name : null/,
    );
  });

  it("workspace switcher menu items also fall back to a label, not a UUID", () => {
    expect(TOPBAR_TSX).toMatch(
      /w\.name \?\?[\s\S]{0,200}Personal workspace/,
    );
  });
});

// =============================================================================
// PART 3 — Schema
// =============================================================================

describe("Phase 32.8C FINAL-3 — schema additions", () => {
  it("ReviewerCapacitySnapshot + ReviewerRoutingRecommendation models exist", () => {
    expect(SCHEMA).toMatch(/model\s+ReviewerCapacitySnapshot\s*\{/);
    expect(SCHEMA).toMatch(/model\s+ReviewerRoutingRecommendation\s*\{/);
    expect(SCHEMA).toMatch(/@@map\("reviewer_capacity_snapshots"\)/);
    expect(SCHEMA).toMatch(/@@map\("reviewer_routing_recommendations"\)/);
  });

  it("BulkOperationalActionRun + Item models + 3 enums exist", () => {
    expect(SCHEMA).toMatch(/model\s+BulkOperationalActionRun\s*\{/);
    expect(SCHEMA).toMatch(/model\s+BulkOperationalActionItem\s*\{/);
    expect(SCHEMA).toMatch(/enum\s+BulkOperationalActionType\s*\{/);
    expect(SCHEMA).toMatch(/enum\s+BulkOperationalActionStatus\s*\{/);
    expect(SCHEMA).toMatch(/enum\s+BulkOperationalActionItemStatus\s*\{/);
  });

  it("OperationalGraphNode + Edge models exist with unique constraints", () => {
    expect(SCHEMA).toMatch(/model\s+OperationalGraphNode\s*\{/);
    expect(SCHEMA).toMatch(/model\s+OperationalGraphEdge\s*\{/);
    expect(SCHEMA).toMatch(/@@unique\(\[teamId,\s*nodeType,\s*entityId\]\)/);
    expect(SCHEMA).toMatch(
      /@@unique\(\[teamId,\s*sourceNodeId,\s*targetNodeId,\s*edgeType\]\)/,
    );
  });

  it("OrganizationalHealthSnapshot model exists with bounded score columns", () => {
    expect(SCHEMA).toMatch(/model\s+OrganizationalHealthSnapshot\s*\{/);
    expect(SCHEMA).toMatch(/healthScore\s+Int\?/);
    expect(SCHEMA).toMatch(/auditReadinessScore\s+Int\?/);
    expect(SCHEMA).toMatch(/queueReliabilityScore\s+Int\?/);
  });

  it("BulkOperationalActionType enum lists the 8 bounded action types", () => {
    for (const v of [
      "BULK_ASSIGN_WORKFLOWS",
      "BULK_ESCALATE_WORKFLOWS",
      "BULK_SUPPRESS_INCIDENTS",
      "BULK_RESOLVE_WORKFLOWS",
      "BULK_SCHEDULE_RETRY",
      "BULK_ACKNOWLEDGE_INCIDENTS",
      "BULK_ADD_MITIGATION",
      "BULK_DISMISS_RECOMMENDATIONS",
    ]) {
      expect(SCHEMA).toContain(v);
    }
  });

  it("OperationalGraphNodeType lists the 12 bounded node types", () => {
    for (const v of [
      "INCIDENT",
      "WORKFLOW",
      "CORRELATION",
      "CASE",
      "EVIDENCE",
      "QUEUE",
      "WORKER",
      "REVIEWER",
      "GOVERNANCE_POLICY",
      "EXPORT",
      "REPORT",
      "PACKAGE",
    ]) {
      expect(SCHEMA).toContain(v);
    }
  });

  it("OperationalGraphEdgeType lists the 9 bounded edge types", () => {
    for (const v of [
      "CAUSED",
      "BLOCKS",
      "DEPENDS_ON",
      "IMPACTS",
      "ESCALATES_TO",
      "MITIGATES",
      "OWNS",
      "ASSIGNED_TO",
      "RELATED_TO",
    ]) {
      expect(SCHEMA).toContain(v);
    }
  });
});

// =============================================================================
// PART 4 — Migration
// =============================================================================

describe("Phase 32.8C FINAL-3 — migration source-contract", () => {
  it("creates all 7 tables idempotently", () => {
    for (const t of [
      "reviewer_capacity_snapshots",
      "reviewer_routing_recommendations",
      "bulk_operational_action_runs",
      "bulk_operational_action_items",
      "operational_graph_nodes",
      "operational_graph_edges",
      "organizational_health_snapshots",
    ]) {
      expect(MIGRATION).toMatch(
        new RegExp(`CREATE TABLE IF NOT EXISTS "${t}"`),
      );
    }
  });

  it("creates all 9 new enums with IF NOT EXISTS guards", () => {
    for (const name of [
      "ReviewerSaturationLevel",
      "ReviewerCapacitySource",
      "ReviewerRoutingRecommendationType",
      "ReviewerRoutingRecommendationStatus",
      "BulkOperationalActionType",
      "BulkOperationalActionStatus",
      "BulkOperationalActionItemStatus",
      "OperationalGraphNodeType",
      "OperationalGraphEdgeType",
    ]) {
      expect(MIGRATION).toMatch(
        new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_type WHERE typname = '${name}'\\)`),
      );
    }
  });

  it("documents rollback plan", () => {
    expect(MIGRATION).toMatch(/Rollback \(operator-side, in psql\):/);
    expect(MIGRATION).toMatch(/DROP TABLE IF EXISTS "organizational_health_snapshots"/);
    expect(MIGRATION).toMatch(/DROP TABLE IF EXISTS "reviewer_capacity_snapshots"/);
  });

  it("bulk_action_items has CASCADE FK to parent run", () => {
    expect(MIGRATION).toMatch(
      /bulk_operational_action_items_run_id_fkey[\s\S]*?ON DELETE CASCADE/,
    );
  });
});

// =============================================================================
// PART 5 — Reviewer capacity engine
// =============================================================================

describe("Phase 32.8C FINAL-3 — reviewer capacity engine", () => {
  it("exports computeReviewerCapacityForWorkspace + listReviewerCapacity + listReviewerRoutingRecommendations", () => {
    expect(REV_CAP).toMatch(/export async function computeReviewerCapacityForWorkspace\(/);
    expect(REV_CAP).toMatch(/export async function listReviewerCapacity\(/);
    expect(REV_CAP).toMatch(/export async function listReviewerRoutingRecommendations\(/);
  });

  it("reads from real EvidenceReviewWorkflow rows — no fake reviewers", () => {
    expect(REV_CAP).toMatch(/prisma\.evidenceReviewWorkflow\.findMany/);
  });

  it("recommendations are idempotent on (teamId, recommendationKey)", () => {
    expect(REV_CAP).toMatch(/prisma\.reviewerRoutingRecommendation\.upsert/);
    expect(REV_CAP).toMatch(/teamId_recommendationKey/);
  });

  it("never projects raw bytes / signed URLs / storage keys", () => {
    expect(REV_CAP).not.toMatch(/storageKey/i);
    expect(REV_CAP).not.toMatch(/signedUrl/i);
  });

  it("never uses legal-overclaim language", () => {
    for (const banned of ["admissible", "authentic", "proves", "court-ready"]) {
      expect(REV_CAP).not.toMatch(new RegExp(`\\b${banned}\\b`, "i"));
    }
  });
});

// =============================================================================
// PART 6 — Bulk actions service + routes
// =============================================================================

describe("Phase 32.8C FINAL-3 — bulk actions", () => {
  it("exports runBulkAction + getBulkActionRun", () => {
    expect(BULK).toMatch(/export async function runBulkAction\(/);
    expect(BULK).toMatch(/export async function getBulkActionRun\(/);
  });

  it("MAX_TARGETS is bounded at 200", () => {
    expect(BULK).toMatch(/MAX_TARGETS\s*=\s*200/);
  });

  it("fans out to the underlying lifecycle service per target (not a bypass)", () => {
    for (const fn of [
      "assignWorkflow",
      "escalateWorkflow",
      "resolveWorkflow",
      "addMitigation",
      "scheduleRetry",
      "suppressIncident",
      "acknowledgeIncident",
    ]) {
      expect(BULK).toContain(fn);
    }
  });

  it("BULK_SCHEDULE_RETRY only records intent — does NOT invoke a queue", () => {
    // The directive: "If a retry is unsafe: record 'retry review
    // scheduled' only."
    expect(BULK).toMatch(/SAFE retry intent only — does NOT invoke BullMQ/);
    expect(BULK).not.toMatch(/queue\.add/);
  });

  it("emits a single platform audit log row per run + per-target audit via the lifecycle service", () => {
    expect(BULK).toMatch(/appendPlatformAuditLog\(/);
    expect(BULK).toMatch(/action:\s*`observability\.bulk_action\./);
  });

  it("BULK_ASSIGN_WORKFLOWS enforces workspace membership on the assignee", () => {
    expect(BULK).toMatch(/c\.teamMember\.findFirst/);
    expect(BULK).toMatch(/invalid_assignee/);
  });

  it("ops routes register POST + GET bulk-action endpoints", () => {
    expect(OPS_ROUTES).toMatch(
      /app\.post\(\s*"\/v1\/ops\/bulk-actions"/,
    );
    expect(OPS_ROUTES).toMatch(
      /app\.get\(\s*"\/v1\/ops\/bulk-actions\/:id"/,
    );
  });

  it("bulk-action POST uses requireOpsActorAction (mutating gate)", () => {
    const block = OPS_ROUTES.match(
      /app\.post\(\s*"\/v1\/ops\/bulk-actions"[\s\S]*?\}\s*,\s*\)/,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/preHandler:\s*requireAuth/);
    expect(block![0]).toMatch(/requireOpsActorAction/);
  });

  it("body schema caps targetIds at 200 + validates UUIDs", () => {
    expect(OPS_ROUTES).toMatch(/targetIds:\s*z\.array\(z\.string\(\)\.uuid\(\)\)\.min\(1\)\.max\(200\)/);
  });
});

// =============================================================================
// PART 7 — Operational graph engine
// =============================================================================

describe("Phase 32.8C FINAL-3 — operational graph engine", () => {
  it("exports projectOperationalGraphForWorkspace + getOperationalGraphSummary", () => {
    expect(GRAPH).toMatch(/export async function projectOperationalGraphForWorkspace\(/);
    expect(GRAPH).toMatch(/export async function getOperationalGraphSummary\(/);
  });

  it("reads from real incidents/workflows/correlations only", () => {
    expect(GRAPH).toMatch(/prisma\.operationalIncident\.findMany/);
    expect(GRAPH).toMatch(/prisma\.operationalWorkflow\.findMany/);
    expect(GRAPH).toMatch(/prisma\.operationalCorrelation\.findMany/);
  });

  it("nodes are idempotent on (teamId, nodeType, entityId)", () => {
    expect(GRAPH).toMatch(/teamId_nodeType_entityId/);
    expect(GRAPH).toMatch(/prisma\.operationalGraphNode\.upsert/);
  });

  it("edges are idempotent on (teamId, source, target, edgeType)", () => {
    expect(GRAPH).toMatch(/teamId_sourceNodeId_targetNodeId_edgeType/);
    expect(GRAPH).toMatch(/prisma\.operationalGraphEdge\.upsert/);
  });

  it("blast-radius reads bounded counts only — no raw entity bodies", () => {
    expect(GRAPH).toMatch(/impactedEvidenceCount/);
    expect(GRAPH).toMatch(/impactedCaseCount/);
    expect(GRAPH).toMatch(/impactedReviewerCount/);
    expect(GRAPH).not.toMatch(/fileBytes/);
    expect(GRAPH).not.toMatch(/storageKey/i);
  });

  it("top root causes are derived from edge out-degree (no fake ranking)", () => {
    expect(GRAPH).toMatch(/prisma\.operationalGraphEdge\.groupBy/);
    expect(GRAPH).toMatch(/sourceNodeId.*"desc"/);
  });
});

// =============================================================================
// PART 8 — Organizational health writer
// =============================================================================

describe("Phase 32.8C FINAL-3 — organizational health writer", () => {
  it("exports recordOrgHealthSnapshotForWorkspace + getLatestOrgHealthSnapshot", () => {
    expect(ORG_HEALTH).toMatch(/export async function recordOrgHealthSnapshotForWorkspace\(/);
    expect(ORG_HEALTH).toMatch(/export async function getLatestOrgHealthSnapshot\(/);
  });

  it("scores are deterministic 0..100 — bounded by clamp100", () => {
    expect(ORG_HEALTH).toMatch(/function clamp100/);
    expect(ORG_HEALTH).toMatch(/Math\.max\(0,\s*Math\.min\(100/);
  });

  it("reads real counters only — no fabricated scores", () => {
    // Allow chained calls broken across multiple lines for readability.
    expect(ORG_HEALTH).toMatch(/prisma\.operationalIncident\s*\n?\s*\.count|prisma\.operationalIncident\.count/);
    expect(ORG_HEALTH).toMatch(/prisma\.operationalWorkflow\s*\n?\s*\.count|prisma\.operationalWorkflow\.count/);
    expect(ORG_HEALTH).toMatch(/prisma\.queueTelemetrySnapshot\s*\n?\s*\.count|prisma\.queueTelemetrySnapshot\.count/);
    expect(ORG_HEALTH).toMatch(/prisma\.evidence\s*\n?\s*\.count|prisma\.evidence\.count/);
  });

  it("never uses AI/ML scoring terminology", () => {
    for (const banned of ["machine learning", "ML score", "AI model", "ai-derived"]) {
      expect(ORG_HEALTH).not.toMatch(new RegExp(banned, "i"));
    }
  });
});

// =============================================================================
// PART 9 — Persona resolver + capability matrix
// =============================================================================

describe("Phase 32.8C FINAL-3 — persona resolver + capability matrix", () => {
  it("exports resolveCapabilityMatrix + CapabilityMatrix type", () => {
    expect(PERSONA).toMatch(/export function resolveCapabilityMatrix\(/);
    expect(PERSONA).toMatch(/export type CapabilityMatrix\s*=/);
  });

  it("enumerates the 6 personas (OWNER_ADMIN / REVIEWER / GOVERNANCE_OFFICER / OPERATOR / INVESTIGATOR / VIEWER)", () => {
    for (const p of [
      "OWNER_ADMIN",
      "REVIEWER",
      "GOVERNANCE_OFFICER",
      "OPERATOR",
      "INVESTIGATOR",
      "VIEWER",
    ]) {
      expect(PERSONA).toContain(`"${p}"`);
    }
  });

  it("capability matrix gates bulk actions to OWNER_ADMIN + team workspace", () => {
    // bulkActions: canMutate && isAdmin
    expect(PERSONA).toMatch(/bulkActions:\s*canMutate && isAdmin/);
  });

  it("VIEWER persona cannot mutate even in team workspace", () => {
    expect(PERSONA).toMatch(/persona !== "VIEWER"/);
  });

  it("sectionOrder is deterministic per persona", () => {
    expect(PERSONA).toMatch(/function sectionOrderForPersona/);
    expect(PERSONA).toMatch(/case "REVIEWER":[\s\S]*?reviewerCapacity/);
    expect(PERSONA).toMatch(/case "GOVERNANCE_OFFICER":[\s\S]*?governancePosture/);
    expect(PERSONA).toMatch(/case "OPERATOR":[\s\S]*?incidents/);
  });

  it("matrix never weakens auth (explicit doc note)", () => {
    expect(PERSONA).toMatch(/NEVER weakens auth/);
  });
});

// =============================================================================
// PART 10 — Dashboard envelope wiring
// =============================================================================

describe("Phase 32.8C FINAL-3 — dashboard envelope wiring", () => {
  it("envelope adds reviewerCapacity + operationalGraph + organizationalHealth sections", () => {
    expect(COMMAND_CENTER).toMatch(/reviewerCapacity:\s*\{/);
    expect(COMMAND_CENTER).toMatch(/operationalGraph:\s*\{/);
    expect(COMMAND_CENTER).toMatch(/organizationalHealth:\s*\{/);
  });

  it("envelope adds top-level capabilityMatrix", () => {
    expect(COMMAND_CENTER).toMatch(/capabilityMatrix:\s*CapabilityMatrix/);
  });

  it("runReviewerCapacityBoard + runOperationalGraphSection + runOrganizationalHealthSection are defined", () => {
    expect(COMMAND_CENTER).toMatch(/async function runReviewerCapacityBoard\(/);
    expect(COMMAND_CENTER).toMatch(/async function runOperationalGraphSection\(/);
    expect(COMMAND_CENTER).toMatch(/async function runOrganizationalHealthSection\(/);
  });

  it("each new section lazy-generates then reads (failures wrapped)", () => {
    expect(COMMAND_CENTER).toMatch(
      /computeReviewerCapacityForWorkspace\(\{\s*teamId\s*\}\)\.catch\(/,
    );
    expect(COMMAND_CENTER).toMatch(
      /projectOperationalGraphForWorkspace\(\{\s*teamId\s*\}\)\.catch\(/,
    );
    expect(COMMAND_CENTER).toMatch(
      /recordOrgHealthSnapshotForWorkspace\(\{\s*teamId\s*\}\)\.catch\(/,
    );
  });

  it("personal workspaces get reviewerCapacity status=not_applicable, not unavailable", () => {
    const block = COMMAND_CENTER.match(
      /async function runReviewerCapacityBoard[\s\S]*?\n\}\s*\n/,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/scope === "PERSONAL"[\s\S]*?status:\s*"not_applicable"/);
  });

  it("frontend types.ts mirrors the new envelope shape", () => {
    expect(CC_TYPES).toMatch(/reviewerCapacity\?:\s*\{/);
    expect(CC_TYPES).toMatch(/operationalGraph\?:\s*\{/);
    expect(CC_TYPES).toMatch(/organizationalHealth\?:\s*\{/);
    expect(CC_TYPES).toMatch(/capabilityMatrix\?:\s*\{/);
  });
});

// =============================================================================
// PART 11 — Frontend renders new boards
// =============================================================================

describe("Phase 32.8C FINAL-3 — frontend renders new boards", () => {
  it("ReviewerCapacityBoard component is defined", () => {
    expect(CC_TSX).toMatch(/function ReviewerCapacityBoard\(/);
    expect(CC_TSX).toMatch(/data-cc-reviewer-capacity\b/);
    expect(CC_TSX).toMatch(/data-cc-reviewer-saturation/);
  });

  it("OperationalGraphSummaryBoard component is defined", () => {
    expect(CC_TSX).toMatch(/function OperationalGraphSummaryBoard\(/);
    expect(CC_TSX).toMatch(/data-cc-graph-counts\b/);
    expect(CC_TSX).toMatch(/data-cc-graph-blast-radius\b/);
    expect(CC_TSX).toMatch(/data-cc-graph-root-causes\b/);
  });

  it("OrganizationalHealthBoard component is defined", () => {
    expect(CC_TSX).toMatch(/function OrganizationalHealthBoard\(/);
    expect(CC_TSX).toMatch(/data-cc-org-health-tiles\b/);
    expect(CC_TSX).toMatch(/data-cc-health-key="audit"/);
    expect(CC_TSX).toMatch(/data-cc-health-key="reviewer"/);
  });

  it("ReviewerCapacityBoard renders routing recommendations strip", () => {
    expect(CC_TSX).toMatch(/data-cc-reviewer-recommendations-block/);
    expect(CC_TSX).toMatch(/data-cc-reviewer-recommendations\b/);
  });

  it("Operational graph shows blast-radius tiles (impacted evidence / cases / reviewers)", () => {
    expect(CC_TSX).toMatch(/data-cc-blast-evidence/);
    expect(CC_TSX).toMatch(/data-cc-blast-cases/);
    expect(CC_TSX).toMatch(/data-cc-blast-reviewers/);
  });

  it("OrganizationalHealthBoard renders 9 deterministic-score tiles", () => {
    for (const k of [
      "health",
      "operational",
      "governance",
      "audit",
      "reviewer",
      "queue-reliability",
      "artifact-reliability",
      "workflow-completion",
      "incident-frequency",
    ]) {
      expect(CC_TSX).toContain(`data-cc-health-key="${k}"`);
    }
  });

  it("new boards are read-only (no inline mutation buttons)", () => {
    for (const fn of [
      "ReviewerCapacityBoard",
      "OperationalGraphSummaryBoard",
      "OrganizationalHealthBoard",
    ]) {
      const block = CC_TSX.match(new RegExp(`function ${fn}\\([\\s\\S]*?\\n\\}\\s*\\n`));
      expect(block).not.toBeNull();
      expect(block![0]).not.toMatch(/<button/);
      expect(block![0]).not.toMatch(/onClick/);
    }
  });
});

// =============================================================================
// PART 12 — No-regression invariants
// =============================================================================

describe("Phase 32.8C FINAL-3 — no-regression invariants", () => {
  it("no service generates signed URLs or report/package output", () => {
    for (const src of [REV_CAP, BULK, GRAPH, ORG_HEALTH, PERSONA]) {
      expect(src).not.toMatch(/getSignedUrl/i);
      expect(src).not.toMatch(/generateReport/i);
      expect(src).not.toMatch(/generatePackage/i);
    }
  });

  it("no service uses legal-overclaim language (word-boundary)", () => {
    for (const src of [REV_CAP, BULK, GRAPH, ORG_HEALTH, PERSONA]) {
      for (const banned of ["admissible", "authentic", "proves", "court-ready"]) {
        expect(src).not.toMatch(new RegExp(`\\b${banned}\\b`, "i"));
      }
    }
  });

  it("no service writes to custody/security/audit chains directly", () => {
    for (const src of [REV_CAP, GRAPH, ORG_HEALTH, PERSONA]) {
      expect(src).not.toMatch(/recordCustodyEvent\(/);
      expect(src).not.toMatch(/recordSecurityEvent\(/);
    }
  });

  it("bulk action runner audits every run via appendPlatformAuditLog", () => {
    expect(BULK).toMatch(/appendPlatformAuditLog\(/);
  });

  it("frontend new sections never emit POSTs (dashboard remains read-only)", () => {
    for (const fn of [
      "ReviewerCapacityBoard",
      "OperationalGraphSummaryBoard",
      "OrganizationalHealthBoard",
    ]) {
      const block = CC_TSX.match(new RegExp(`function ${fn}\\([\\s\\S]*?\\n\\}\\s*\\n`));
      expect(block).not.toBeNull();
      expect(block![0]).not.toMatch(/method:\s*"POST"/);
      expect(block![0]).not.toMatch(/<form/);
    }
  });

  it("topbar fix does NOT break the workspace switcher menu", () => {
    // Phase 32.8C FINAL-4 — switcher is now grouped; the menu still
    // iterates workspaceList (now via filter + per-group map) and
    // still exposes the scope chip hook.
    expect(TOPBAR_TSX).toMatch(/workspaceList\.filter/);
    expect(TOPBAR_TSX).toMatch(/data-workspace-scope-chip/);
  });

  it("reviewer-ops + governance UI gating fix preserves the SectionShell pattern", () => {
    expect(REVIEWER_TSX).toMatch(/<SummarySection/);
    expect(GOVERNANCE_TSX).toMatch(/<nav className="case-tabs"/);
  });
});
