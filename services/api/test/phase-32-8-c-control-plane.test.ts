/**
 * Phase 32.8C — Enterprise Operations Control Plane.
 *
 * Source-contract tests:
 *
 *  PART 1 — Schema: assignment lifecycle fields on OperationalIncident +
 *           OperationalCorrelation model + 1 new enum
 *  PART 2 — Migration: idempotent, additive, with rollback plan
 *  PART 3 — Incident generator: deterministic, real sources, bounded,
 *           non-blocking, no fake incidents
 *  PART 4 — Correlation engine: deterministic patterns, bounded reads,
 *           idempotent upsert, expiry, no fake data
 *  PART 5 — assignIncident action: workspace-member check, audited,
 *           metric registered, no auth weakening
 *  PART 6 — Routes: /v1/ops/incidents/:id/assign exists; ack/resolve/
 *           suppress preserved
 *  PART 7 — Envelope: incidents.correlations[] exposed; assignment
 *           fields exposed on IncidentItem
 *  PART 8 — Frontend renders correlations + assignment chips
 *  PART 9 — No fake data / no legal overclaim / no secret leakage /
 *           no page-load side effects
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
  "prisma/migrations/20260627100000_phase328c_control_plane_closure/migration.sql",
);
const GENERATOR = readApi("src/services/dashboard/incident-generator.service.ts");
const CORRELATION = readApi(
  "src/services/dashboard/incident-correlation.service.ts",
);
const INCIDENT_SVC = readApi("src/services/observability/incident.service.ts");
const OPS_ROUTES = readApi("src/routes/ops.routes.ts");
const COMMAND_CENTER = readApi(
  "src/services/dashboard/command-center.service.ts",
);
const CC_TYPES = readWeb("components/command-center/types.ts");
const CC_TSX = readWeb("components/command-center/CommandCenter.tsx");

// =============================================================================
// PART 1 — Schema
// =============================================================================

describe("Phase 32.8C control plane — schema additions", () => {
  it("OperationalIncident gains assignment lifecycle fields", () => {
    const block = SCHEMA.match(/model\s+OperationalIncident\s*\{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/assignedOperatorUserId\s+String\?\s+@map\("assigned_operator_user_id"\)/);
    expect(block![0]).toMatch(/assignedByUserId\s+String\?\s+@map\("assigned_by_user_id"\)/);
    expect(block![0]).toMatch(/assignedAtUtc\s+DateTime\?\s+@map\("assigned_at_utc"\)/);
    expect(block![0]).toMatch(/@@index\(\[assignedOperatorUserId\]\)/);
  });

  it("OperationalCorrelation model + enum exist", () => {
    expect(SCHEMA).toMatch(/model\s+OperationalCorrelation\s*\{/);
    expect(SCHEMA).toMatch(/enum\s+OperationalCorrelationType\s*\{/);
    expect(SCHEMA).toMatch(/@@map\("operational_correlations"\)/);
  });

  it("OperationalCorrelation has unique (teamId, correlationKey)", () => {
    expect(SCHEMA).toMatch(/@@unique\(\[teamId,\s*correlationKey\]\)/);
  });

  it("OperationalCorrelationType lists the bounded pattern catalog", () => {
    for (const v of [
      "PIPELINE_DEGRADATION",
      "REVIEW_BOTTLENECK",
      "AUDIT_READINESS_GAP",
      "GOVERNANCE_ESCALATION",
      "INFRASTRUCTURE_PRESSURE",
      "QUEUE_SATURATION_CHAIN",
      "RETRY_STORM_CHAIN",
      "OTHER",
    ]) {
      expect(SCHEMA).toContain(v);
    }
  });

  it("OperationalCorrelation bounds operator-safe strings to 400 chars", () => {
    expect(SCHEMA).toMatch(/rootOperationalCause\s+String\s+@map\("root_operational_cause"\)\s+@db\.VarChar\(400\)/);
    expect(SCHEMA).toMatch(/operationalSummary\s+String\s+@map\("operational_summary"\)\s+@db\.VarChar\(400\)/);
    expect(SCHEMA).toMatch(/recommendedAction\s+String\s+@map\("recommended_action"\)\s+@db\.VarChar\(400\)/);
  });

  it("OperationalCorrelation has expiry field for auto-rotation", () => {
    expect(SCHEMA).toMatch(/expiresAtUtc\s+DateTime\s+@map\("expires_at_utc"\)/);
  });
});

// =============================================================================
// PART 2 — Migration
// =============================================================================

describe("Phase 32.8C control plane — migration source-contract", () => {
  it("ADD COLUMN IF NOT EXISTS on operational_incidents (assignment columns)", () => {
    expect(MIGRATION).toMatch(/ALTER TABLE "operational_incidents"[\s\S]*?ADD COLUMN IF NOT EXISTS "assigned_operator_user_id"/);
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS "assigned_by_user_id"/);
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS "assigned_at_utc"/);
  });

  it("creates operational_correlations idempotently", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS "operational_correlations"/);
  });

  it("creates OperationalCorrelationType enum with IF NOT EXISTS guard", () => {
    expect(MIGRATION).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'OperationalCorrelationType'\)/,
    );
  });

  it("documents that the data is ADVISORY and writes never block core flows", () => {
    expect(MIGRATION).toMatch(/ADVISORY operational data/);
  });

  it("documents a full rollback plan in header", () => {
    expect(MIGRATION).toMatch(/Rollback \(operator-side, in psql\):/);
    expect(MIGRATION).toMatch(/DROP TABLE IF EXISTS "operational_correlations"/);
    expect(MIGRATION).toMatch(/DROP COLUMN IF EXISTS "assigned_at_utc"/);
  });

  it("creates dashboard read-pattern indexes", () => {
    expect(MIGRATION).toContain('"operational_correlations_team_id_last_detected_at_utc_idx"');
    expect(MIGRATION).toContain('"operational_correlations_team_id_severity_idx"');
    expect(MIGRATION).toContain('"operational_incidents_assigned_operator_user_id_idx"');
  });
});

// =============================================================================
// PART 3 — Incident generator
// =============================================================================

describe("Phase 32.8C control plane — incident generator", () => {
  it("exports generateIncidentsForWorkspace as the public entry point", () => {
    expect(GENERATOR).toMatch(/export async function generateIncidentsForWorkspace\(/);
  });

  it("routes every generated incident through the existing recordIncident upsert", () => {
    expect(GENERATOR).toMatch(/import\s*\{[\s\S]*?recordIncident[\s\S]*?\}\s*from\s*"\.\.\/observability\/incident\.service\.js"/);
    expect(GENERATOR).toMatch(/await\s+recordIncident\(/);
  });

  it("every rule reads from real existing tables — no fabricated data", () => {
    expect(GENERATOR).toMatch(/prisma\.evidence\.count/);
    expect(GENERATOR).toMatch(/prisma\.evidenceReviewWorkflow\.count/);
    expect(GENERATOR).toMatch(/prisma\.operationalIncident\.count/);
    expect(GENERATOR).toMatch(/prisma\.queueTelemetrySnapshot\.findFirst/);
    expect(GENERATOR).toMatch(/prisma\.workerTelemetrySnapshot\.findFirst/);
  });

  it("every threshold is a named constant (deterministic, no magic numbers in fingerprints)", () => {
    for (const k of [
      "REPORT_BACKLOG_HIGH",
      "REPORT_BACKLOG_CRITICAL",
      "PACKAGE_BACKLOG_HIGH",
      "PACKAGE_BACKLOG_CRITICAL",
      "STALE_REVIEW_HOURS",
      "RETRY_STORM_OCCURRENCE_THRESHOLD",
      "TELEMETRY_STALE_MINUTES",
      "WORKER_HEARTBEAT_STALE_MINUTES",
      "UNSIGNED_FINALIZED_AGED_DAYS",
      "COORDINATION_STALE_DAYS",
    ]) {
      expect(GENERATOR).toContain(k);
    }
  });

  it("generator wraps every rule in try/catch and never throws", () => {
    expect(GENERATOR).toMatch(/Generator failures NEVER block/);
    expect(GENERATOR).toMatch(/try\s*\{[\s\S]*?recordIncident/);
  });

  it("fingerprints are stable per (workspace, rule) for idempotent dedup", () => {
    // Every fingerprint embeds `:${ctx.teamId}` so the existing
    // unique(teamId, fingerprint) constraint collapses repeats.
    const fpLines = GENERATOR.match(/fingerprint:\s*`[^`]*\$\{ctx\.teamId\}`/g);
    expect(fpLines).not.toBeNull();
    expect(fpLines!.length).toBeGreaterThanOrEqual(6);
  });

  it("never projects raw bytes / signed URLs / storage keys", () => {
    expect(GENERATOR).not.toMatch(/storageKey/i);
    expect(GENERATOR).not.toMatch(/signedUrl/i);
    expect(GENERATOR).not.toMatch(/canonicalBytes/);
  });

  it("never uses legal-overclaim language", () => {
    for (const banned of ["admissible", "authentic", "proves", "court-ready"]) {
      expect(GENERATOR).not.toMatch(new RegExp(`\\b${banned}\\b`, "i"));
    }
  });
});

// =============================================================================
// PART 4 — Correlation engine
// =============================================================================

describe("Phase 32.8C control plane — correlation engine", () => {
  it("exports correlateWorkspaceIncidents + listWorkspaceCorrelations", () => {
    expect(CORRELATION).toMatch(/export async function correlateWorkspaceIncidents\(/);
    expect(CORRELATION).toMatch(/export async function listWorkspaceCorrelations\(/);
  });

  it("scan is bounded (≤ 200 incidents, ≤ 2h window)", () => {
    expect(CORRELATION).toMatch(/take:\s*200/);
    expect(CORRELATION).toMatch(/CORRELATION_WINDOW_HOURS\s*=\s*2/);
  });

  it("correlations expire automatically", () => {
    expect(CORRELATION).toMatch(/CORRELATION_EXPIRY_HOURS\s*=\s*24/);
    expect(CORRELATION).toMatch(/expiresAtUtc:\s*\{\s*gt:\s*now\s*\}/);
  });

  it("upserts on (teamId, correlationKey) — idempotent on re-detection", () => {
    expect(CORRELATION).toMatch(/prisma\.operationalCorrelation\.upsert/);
    expect(CORRELATION).toMatch(/teamId_correlationKey/);
  });

  it("detects each bounded pattern (no statistical scoring, no ML)", () => {
    for (const pattern of [
      "PIPELINE_DEGRADATION",
      "RETRY_STORM_CHAIN",
      "INFRASTRUCTURE_PRESSURE",
      "GOVERNANCE_ESCALATION",
      "AUDIT_READINESS_GAP",
      "QUEUE_SATURATION_CHAIN",
    ]) {
      expect(CORRELATION).toContain(`"${pattern}"`);
    }
  });

  it("never reads job payloads / signed URLs / raw bytes", () => {
    expect(CORRELATION).not.toMatch(/storageKey/i);
    expect(CORRELATION).not.toMatch(/signedUrl/i);
    // The string "payloads" appears once in a comment promising NOT to
    // expose them. We forbid the explicit `payload:` query selector
    // pattern instead.
    expect(CORRELATION).not.toMatch(/payload:\s*true/);
  });

  it("scan failure returns zero — never blocks dashboard", () => {
    expect(CORRELATION).toMatch(
      /Read failure — return zero/,
    );
  });

  it("bounded strings: every operator-facing string is .slice(0, 400)", () => {
    expect(CORRELATION).toMatch(/rootOperationalCause\.slice\(0,\s*400\)/);
    expect(CORRELATION).toMatch(/operationalSummary\.slice\(0,\s*400\)/);
    expect(CORRELATION).toMatch(/recommendedAction\.slice\(0,\s*400\)/);
  });
});

// =============================================================================
// PART 5 — assignIncident action
// =============================================================================

describe("Phase 32.8C control plane — assignIncident action", () => {
  it("exports assignIncident from the existing incident service", () => {
    expect(INCIDENT_SVC).toMatch(/export async function assignIncident\(/);
  });

  it("assignIncident emits a tenant audit log row via the canonical facade", () => {
    const block = INCIDENT_SVC.match(/export async function assignIncident[\s\S]*?\n\}\s*\n/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/emitTenantAudit\(/);
    expect(block![0]).toMatch(/action:\s*"observability\.incident\.assigned"/);
  });

  it("assignIncident emits an OperationalIncidentEvent history row", () => {
    const block = INCIDENT_SVC.match(/export async function assignIncident[\s\S]*?\n\}\s*\n/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/operationalIncidentEvent\.create/);
    expect(block![0]).toMatch(/eventType:\s*"assigned"/);
  });

  it("assignIncident bumps the operational_incident_assigned counter", () => {
    expect(INCIDENT_SVC).toMatch(/bump\("operational_incident_assigned"\)/);
  });

  it("assignIncident throws incident_not_found when row missing in workspace scope", () => {
    expect(INCIDENT_SVC).toMatch(
      /assignIncident[\s\S]*?if \(!existing\) throw new IncidentError\("incident_not_found"\)/,
    );
  });
});

// =============================================================================
// PART 6 — Routes
// =============================================================================

describe("Phase 32.8C control plane — routes", () => {
  it("POST /v1/ops/incidents/:id/assign is registered", () => {
    expect(OPS_ROUTES).toMatch(
      /app\.post\(\s*"\/v1\/ops\/incidents\/:id\/assign"/,
    );
  });

  /**
   * CONTRACT MIGRATION — Attention Architecture Phase 4B / D29 (2026-08-22).
   *
   * The INVARIANT is unchanged and still asserted: this mutation sits behind
   * `requireAuth` AND an authorization gate, and cannot reach its handler
   * without both. What changed is WHICH permission the gate asks for.
   *
   * `requireOpsActorAction` resolved to `identity.access_review.action` — the
   * permission that decides whether somebody keeps their ACCESS to a
   * workspace. Sixteen generic Operations mutations were gated on it, so
   * anyone allowed to acknowledge a failed report was thereby allowed to
   * adjudicate access reviews. The gate is now `requireOpsCapability` with the
   * Operations permission that describes the action, which is strictly
   * NARROWER than what this test used to accept.
   */
  it("assign route requires auth + the operations.assign capability", () => {
    const block = OPS_ROUTES.match(/app\.post\(\s*"\/v1\/ops\/incidents\/:id\/assign"[\s\S]*?\}\s*,\s*\)/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/preHandler:\s*requireAuth/);
    expect(block![0]).toMatch(
      /requireOpsCapability\(req,\s*reply,\s*body\.teamId,\s*"operations\.assign"\)/,
    );
  });

  it("assign route validates assigneeUserId as a UUID", () => {
    expect(OPS_ROUTES).toMatch(/assigneeUserId:\s*z\.string\(\)\.uuid\(\)/);
  });

  it("assign route enforces workspace membership on the assignee", () => {
    const block = OPS_ROUTES.match(/app\.post\(\s*"\/v1\/ops\/incidents\/:id\/assign"[\s\S]*?\}\s*,\s*\)/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/prisma\.teamMember\.findFirst/);
    expect(block![0]).toMatch(/invalid_assignee/);
  });

  it("existing ack/resolve/suppress routes preserved", () => {
    expect(OPS_ROUTES).toMatch(/\/v1\/ops\/incidents\/:id\/ack/);
    expect(OPS_ROUTES).toMatch(/\/v1\/ops\/incidents\/:id\/resolve/);
    expect(OPS_ROUTES).toMatch(/\/v1\/ops\/incidents\/:id\/suppress/);
  });
});

// =============================================================================
// PART 7 — Envelope changes
// =============================================================================

describe("Phase 32.8C control plane — envelope changes", () => {
  it("CommandCenterIncidentItem exposes assignment + ack fields", () => {
    expect(COMMAND_CENTER).toMatch(/assignedOperatorUserId:\s*string \| null/);
    expect(COMMAND_CENTER).toMatch(/assignedAtUtc:\s*string \| null/);
    expect(COMMAND_CENTER).toMatch(/acknowledgedByUserId:\s*string \| null/);
    expect(COMMAND_CENTER).toMatch(/acknowledgedAtUtc:\s*string \| null/);
  });

  it("CommandCenterCorrelationItem type is exported", () => {
    expect(COMMAND_CENTER).toMatch(/export type CommandCenterCorrelationItem\s*=/);
    expect(COMMAND_CENTER).toMatch(/rootOperationalCause:\s*string/);
    expect(COMMAND_CENTER).toMatch(/linkedIncidentIds:\s*string\[\]/);
  });

  it("incidents section in envelope now carries correlations[]", () => {
    expect(COMMAND_CENTER).toMatch(
      /incidents:\s*\{[\s\S]*?correlations:\s*CommandCenterCorrelationItem\[\]/,
    );
  });

  it("runIncidents lazy-runs generator + correlator before reading", () => {
    expect(COMMAND_CENTER).toMatch(
      /generateIncidentsForWorkspace\(\{\s*teamId\s*\}\)\.catch\(/,
    );
    expect(COMMAND_CENTER).toMatch(
      /correlateWorkspaceIncidents\(\{\s*teamId\s*\}\)\.catch\(/,
    );
  });

  it("runIncidents selects the assignment + acknowledgment fields", () => {
    expect(COMMAND_CENTER).toMatch(/assignedOperatorUserId:\s*true/);
    expect(COMMAND_CENTER).toMatch(/acknowledgedByUserId:\s*true/);
  });

  it("frontend types.ts mirrors backend additions", () => {
    expect(CC_TYPES).toMatch(/export type IncidentCorrelationItem\s*=/);
    expect(CC_TYPES).toMatch(/correlations:\s*IncidentCorrelationItem\[\]/);
    expect(CC_TYPES).toMatch(/assignedOperatorUserId:\s*string \| null/);
  });
});

// =============================================================================
// PART 8 — Frontend renders correlations + assignment
// =============================================================================

describe("Phase 32.8C control plane — frontend rendering", () => {
  it("IncidentCorrelations component renders the correlations strip", () => {
    expect(CC_TSX).toMatch(/function IncidentCorrelations\(/);
    expect(CC_TSX).toMatch(/data-cc-incident-correlations\b/);
    expect(CC_TSX).toMatch(/data-cc-incident-correlations-block\b/);
  });

  it("each correlation row exposes the operational hooks (root cause + summary + action)", () => {
    expect(CC_TSX).toMatch(/data-cc-correlation-type/);
    expect(CC_TSX).toMatch(/data-cc-correlation-severity/);
    expect(CC_TSX).toMatch(/data-cc-correlation-root/);
    expect(CC_TSX).toMatch(/data-cc-correlation-summary/);
    expect(CC_TSX).toMatch(/data-cc-correlation-action/);
  });

  it("incident row exposes assignment status hooks for accessibility/testing", () => {
    expect(CC_TSX).toMatch(/data-cc-incident-id/);
    expect(CC_TSX).toMatch(/data-cc-incident-status/);
    expect(CC_TSX).toMatch(/data-cc-incident-assigned/);
  });

  it("incident row renders assignment chip when an operator is assigned", () => {
    expect(CC_TSX).toMatch(/data-cc-incident-assigned-label/);
    // JSX expression form: `assigned {i.assignedOperatorUserId.slice(0, 8)}`
    expect(CC_TSX).toMatch(
      /assigned \{i\.assignedOperatorUserId\.slice\(0,\s*8\)\}/,
    );
  });

  it("dashboard is read-only: the incidents section explicitly states operator actions live on the ops page", () => {
    expect(CC_TSX).toMatch(
      /Operator actions[\s\S]*?live on the[\s\S]*?Operations Center/,
    );
  });

  it("no inline mutation buttons in the incidents section", () => {
    const block = CC_TSX.match(/function IncidentsSection\([\s\S]*?\n\}\s*\n/);
    expect(block).not.toBeNull();
    expect(block![0]).not.toMatch(/<button/);
    expect(block![0]).not.toMatch(/onClick/);
  });

  it("empty state enumerates every real source the generator scans", () => {
    expect(CC_TSX).toMatch(/No open operational incidents/);
    expect(CC_TSX).toMatch(/report\/package backlog/);
    expect(CC_TSX).toMatch(/stale telemetry/);
    expect(CC_TSX).toMatch(/worker heartbeat staleness/);
    expect(CC_TSX).toMatch(/retry storms/);
  });
});

// =============================================================================
// PART 9 — No-regression invariants
// =============================================================================

describe("Phase 32.8C control plane — no-regression invariants", () => {
  it("generator + correlation services never emit security/audit/custody events", () => {
    for (const src of [GENERATOR, CORRELATION]) {
      expect(src).not.toMatch(/recordSecurityEvent\(/);
      expect(src).not.toMatch(/recordCustodyEvent\(/);
    }
  });

  it("generator + correlation never generate signed URLs or report/package output", () => {
    for (const src of [GENERATOR, CORRELATION]) {
      expect(src).not.toMatch(/getSignedUrl/i);
      expect(src).not.toMatch(/generateReport/i);
      expect(src).not.toMatch(/generatePackage/i);
    }
  });

  it("assignIncident does NOT change incident status (assignment is orthogonal to lifecycle)", () => {
    const block = INCIDENT_SVC.match(/export async function assignIncident[\s\S]*?\n\}\s*\n/);
    expect(block).not.toBeNull();
    // Allow `status` in the audit log metadata payload, but not as a
    // mutated field on the update.
    expect(block![0]).not.toMatch(/data:\s*\{[^}]*status:/);
  });

  it("envelope additions are nullable / default-empty (graceful degradation)", () => {
    // correlations falls back to an empty array on any read failure; the
    // mapping `correlations: section.correlations ?? []` is the operator-
    // visible guarantee.
    expect(CC_TSX).toMatch(/section\.correlations \?\? \[\]/);
  });

  it("control plane does NOT bypass auth: assign route still gates on a capability", () => {
    const block = OPS_ROUTES.match(/app\.post\(\s*"\/v1\/ops\/incidents\/:id\/assign"[\s\S]*?\}\s*,\s*\)/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/preHandler:\s*requireAuth/);
    expect(block![0]).toMatch(/requireOpsCapability/);
    // And specifically NOT the identity permission it used to borrow.
    expect(block![0]).not.toMatch(/identity\.access_review\.action/);
  });
});
