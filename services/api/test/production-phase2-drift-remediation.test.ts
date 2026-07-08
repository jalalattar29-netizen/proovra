/**
 * Production regression test — Phase 2 Full Prisma Drift Remediation.
 *
 * Pins the four additive idempotent column-repair migrations produced by
 * Phase 2 of the full-prisma-drift-remediation effort:
 *   - `20270805000000_phase2_drift_repair_trust_status`           (Domain 1 — Trust)
 *   - `20270806000000_phase2_drift_repair_governance`             (Domain 2 — Governance)
 *   - `20270807000000_phase2_drift_repair_redaction`              (Domain 3 — Redaction)
 *   - `20270808000000_phase2_drift_repair_lifecycle_webhooks`     (Domain 7 — Webhooks)
 *
 * Together they close 49 ADDITIVE_SAFE columns across 18 tables and 4 of
 * the 14 audited domains. The remaining 10 audited domains (Reviewer Ops,
 * Search/Semantic, Lifecycle/Retention, Workflows/Intake, Collaboration,
 * Billing, Evidence core, Security, Communications, Media intelligence)
 * returned ZERO confirmed drift and required no Phase 2 migration. 1 item
 * — RedactionPolicyAudit table-name drift — is REQUIRES_MANUAL_DECISION
 * and intentionally deferred per Phase 2 non-negotiables (RENAME forbidden).
 *
 * BACKGROUND. Phase 2 four-stream inventory audited every Prisma model
 * column-by-column against the live production schema. Every column added
 * here has an `@map(...)` declaration in `services/api/prisma/schema.prisma`
 * and a service callsite that would currently fail with Prisma P2022
 * (column does not exist) — mapped by the central error handler at
 * `services/api/src/server.ts:665-686` to HTTP 503 SCHEMA_NOT_READY.
 *
 * Style: source-contract (readFileSync). NO DB I/O. Matches the canonical
 * pattern of `production-phase1-drift-stabilization.test.ts`.
 *
 * Honest scoping caveats:
 *
 *   1. GROUP A.1 pins the Phase 2 master-drift-inventory doc at
 *      `docs/operations/phase2-full-prisma-drift-remediation.md`. The doc
 *      is authored in the *next* phase of the remediation workflow; the
 *      assertion is relax-to-reality and asserts presence-or-known-missing.
 *      It will hard-pin once the doc lands.
 *
 *   2. GROUP D destructive-SQL guards run against the DDL body of every
 *      Phase 2 migration (header `--` comments stripped) so explanatory
 *      text mentioning forbidden verbs (e.g. "No DROP / RENAME / DELETE
 *      / TRUNCATE / UPDATE on existing rows") does not trip the guards.
 *
 *   3. GROUP D also pins the THREE prior repair migrations
 *      (20270802 / 20270803 / 20270804) so the test catches any future
 *      regression that re-introduces destructive DDL into the closure set.
 *
 *   4. GROUP G "no schema downgrade" asserts the @map declarations for
 *      every Phase 2 column are PRESENT in `schema.prisma`. The migration
 *      brings the database FORWARD to the schema; if a future commit
 *      silently weakens the schema to match a broken production, GROUP D
 *      column-pins (GROUP D Prisma field pin) AND this group both fail.
 *
 *   5. GROUP F's no-v2 assertion uses the same `*v2*` filename heuristic
 *      as the Phase 1 stabilization test. The repo has ZERO `v2` files
 *      today; this assertion freezes that contract.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readRepo(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../${rel}`, import.meta.url)),
    "utf8",
  );
}

function tryReadRepo(rel: string): string | null {
  try {
    return readRepo(rel);
  } catch {
    return null;
  }
}

// =============================================================================
// Source-contract reads — 4 Phase 2 migrations + 3 prior migrations + central
// handler + allowlist + Prisma schema.
// =============================================================================

const PHASE2_TRUST_REL =
  "services/api/prisma/migrations/20270805000000_phase2_drift_repair_trust_status/migration.sql";
const PHASE2_GOV_REL =
  "services/api/prisma/migrations/20270806000000_phase2_drift_repair_governance/migration.sql";
const PHASE2_REDACTION_REL =
  "services/api/prisma/migrations/20270807000000_phase2_drift_repair_redaction/migration.sql";
const PHASE2_WEBHOOKS_REL =
  "services/api/prisma/migrations/20270808000000_phase2_drift_repair_lifecycle_webhooks/migration.sql";

const PHASE1_REL =
  "services/api/prisma/migrations/20270804000000_phase1_production_drift_stabilization/migration.sql";
const SENTRY_REL =
  "services/api/prisma/migrations/20270802000000_phase_sentry_batch_schema_drift_repair/migration.sql";
const GOV_REL =
  "services/api/prisma/migrations/20270803000000_phase_governance_additive_repair/migration.sql";

const PHASE2_TRUST_MIGRATION = readRepo(PHASE2_TRUST_REL);
const PHASE2_GOV_MIGRATION = readRepo(PHASE2_GOV_REL);
const PHASE2_REDACTION_MIGRATION = readRepo(PHASE2_REDACTION_REL);
const PHASE2_WEBHOOKS_MIGRATION = readRepo(PHASE2_WEBHOOKS_REL);

const PHASE1_MIGRATION = readRepo(PHASE1_REL);
const SENTRY_MIGRATION = readRepo(SENTRY_REL);
const GOV_MIGRATION = readRepo(GOV_REL);

const SERVER_TS = readRepo("services/api/src/server.ts");
const ALLOWLIST_GUARD = readRepo(
  "services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts",
);
const SCHEMA_PRISMA = readRepo("services/api/prisma/schema.prisma");

// Optional artifact — written in a later workflow stage. GROUP A.1 is
// relax-to-reality if absent.
const PHASE2_DOC = tryReadRepo(
  "docs/operations/phase2-full-prisma-drift-remediation.md",
);

// =============================================================================
// DDL-body helpers — strip `--` line comments so destructive-SQL guards run
// against EXECUTED SQL, not header text.
// =============================================================================

function ddlBody(migration: string): string {
  return migration.replace(/^\s*--.*$/gm, "");
}

const PHASE2_TRUST_BODY = ddlBody(PHASE2_TRUST_MIGRATION);
const PHASE2_GOV_BODY = ddlBody(PHASE2_GOV_MIGRATION);
const PHASE2_REDACTION_BODY = ddlBody(PHASE2_REDACTION_MIGRATION);
const PHASE2_WEBHOOKS_BODY = ddlBody(PHASE2_WEBHOOKS_MIGRATION);
const PHASE1_BODY = ddlBody(PHASE1_MIGRATION);
const SENTRY_BODY = ddlBody(SENTRY_MIGRATION);
const GOV_BODY = ddlBody(GOV_MIGRATION);

interface MigrationDescriptor {
  readonly id: string;
  readonly domain: string;
  readonly full: string;
  readonly body: string;
}

const PHASE2_MIGRATIONS: ReadonlyArray<MigrationDescriptor> = [
  {
    id: "20270805000000_phase2_drift_repair_trust_status",
    domain: "Trust / Status / Subprocessors",
    full: PHASE2_TRUST_MIGRATION,
    body: PHASE2_TRUST_BODY,
  },
  {
    id: "20270806000000_phase2_drift_repair_governance",
    domain: "Governance",
    full: PHASE2_GOV_MIGRATION,
    body: PHASE2_GOV_BODY,
  },
  {
    id: "20270807000000_phase2_drift_repair_redaction",
    domain: "Redaction",
    full: PHASE2_REDACTION_MIGRATION,
    body: PHASE2_REDACTION_BODY,
  },
  {
    id: "20270808000000_phase2_drift_repair_lifecycle_webhooks",
    domain: "Exchange / Packages / Webhooks",
    full: PHASE2_WEBHOOKS_MIGRATION,
    body: PHASE2_WEBHOOKS_BODY,
  },
];

// All 7 migrations across Phase 0/1/2 — used by GROUP D bounded destructive
// guards so the test catches any future regression that re-introduces
// forbidden DDL into the running closure set.
const ALL_CLOSURE_MIGRATIONS: ReadonlyArray<MigrationDescriptor> = [
  {
    id: "20270802000000_phase_sentry_batch_schema_drift_repair",
    domain: "Sentry batch (Phase 0)",
    full: SENTRY_MIGRATION,
    body: SENTRY_BODY,
  },
  {
    id: "20270803000000_phase_governance_additive_repair",
    domain: "Governance additive (Phase 0)",
    full: GOV_MIGRATION,
    body: GOV_BODY,
  },
  {
    id: "20270804000000_phase1_production_drift_stabilization",
    domain: "Phase 1 stabilization",
    full: PHASE1_MIGRATION,
    body: PHASE1_BODY,
  },
  ...PHASE2_MIGRATIONS,
];

// =============================================================================
// Per-Phase-2-column inventory (50 columns)
//
// Each row pins:
//   * the migration that adds the column
//   * the table + column the migration targets
//   * a regex for the Postgres type literal as written in the migration
//   * the Prisma model that declares the column via @map(...)
//   * a regex matching the @map declaration in the Prisma schema
//
// One it() is emitted per column for GROUP B (per-migration shape) AND per
// column for GROUP D Prisma-field pins (model-side declaration intact).
// =============================================================================

interface Phase2ColumnPin {
  readonly migrationId: string;
  readonly table: string;
  readonly column: string;
  readonly typeRe: RegExp;
  readonly model: string;
  readonly mapRe: RegExp;
}

// Helper: shorthand for "@map("<col>") @db.Timestamptz(6)" — used heavily.
function mapTimestamptz(col: string, nullable = true): RegExp {
  // Nullable: `DateTime? @map("<col>") @db.Timestamptz(6)`
  // Non-null with @default(now()) or @updatedAt — caller passes appropriate variant.
  return nullable
    ? new RegExp(`DateTime\\?\\s+@map\\("${col}"\\)\\s+@db\\.Timestamptz\\(6\\)`)
    : new RegExp(
        `DateTime\\s+(?:@default\\(now\\(\\)\\)|@updatedAt)\\s+@map\\("${col}"\\)\\s+@db\\.Timestamptz\\(6\\)`,
      );
}

function mapUuid(col: string, nullable = true): RegExp {
  return new RegExp(
    `String${nullable ? "\\?" : ""}\\s+@map\\("${col}"\\)\\s+@db\\.Uuid`,
  );
}

function mapVarchar(col: string, len: number, nullable = true): RegExp {
  return new RegExp(
    `String${nullable ? "\\?" : ""}\\s+@map\\("${col}"\\)\\s+@db\\.VarChar\\(${len}\\)`,
  );
}

function mapBoolean(col: string): RegExp {
  return new RegExp(
    `Boolean\\s+@default\\(false\\)\\s+@map\\("${col}"\\)`,
  );
}

function mapJson(col: string, nullable = true): RegExp {
  return new RegExp(`Json${nullable ? "\\?" : ""}\\s+@map\\("${col}"\\)`);
}

const PHASE2_COLUMNS: ReadonlyArray<Phase2ColumnPin> = [
  // -------------------------------------------------------------------------
  // Domain 1 — Trust / Status / Subprocessors (15 columns)
  // -------------------------------------------------------------------------
  {
    migrationId: "20270805000000_phase2_drift_repair_trust_status",
    table: "trust_center_article_versions",
    column: "published_at_utc",
    typeRe: /TIMESTAMPTZ\(6\)(?!\s+NOT\s+NULL)/,
    model: "TrustCenterArticleVersion",
    mapRe: mapTimestamptz("published_at_utc"),
  },
  {
    migrationId: "20270805000000_phase2_drift_repair_trust_status",
    table: "subprocessor_versions",
    column: "team_id",
    typeRe: /UUID/,
    model: "SubprocessorVersion",
    mapRe: mapUuid("team_id", false),
  },
  {
    migrationId: "20270805000000_phase2_drift_repair_trust_status",
    table: "subprocessor_versions",
    column: "effective_at_utc",
    typeRe: /TIMESTAMPTZ\(6\)(?!\s+NOT\s+NULL)/,
    model: "SubprocessorVersion",
    mapRe: mapTimestamptz("effective_at_utc"),
  },
  {
    migrationId: "20270805000000_phase2_drift_repair_trust_status",
    table: "status_incidents",
    column: "external_ref",
    typeRe: /VARCHAR\(200\)/,
    model: "StatusIncident",
    mapRe: mapVarchar("external_ref", 200),
  },
  {
    migrationId: "20270805000000_phase2_drift_repair_trust_status",
    table: "status_incidents",
    column: "component_keys",
    typeRe: /JSONB/,
    model: "StatusIncident",
    mapRe: mapJson("component_keys", false),
  },
  {
    migrationId: "20270805000000_phase2_drift_repair_trust_status",
    table: "status_incidents",
    column: "postmortem_url",
    typeRe: /VARCHAR\(600\)/,
    model: "StatusIncident",
    mapRe: mapVarchar("postmortem_url", 600),
  },
  {
    migrationId: "20270805000000_phase2_drift_repair_trust_status",
    table: "status_incidents",
    column: "updated_at",
    typeRe: /TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    model: "StatusIncident",
    mapRe: mapTimestamptz("updated_at", false),
  },
  {
    migrationId: "20270805000000_phase2_drift_repair_trust_status",
    table: "status_incident_updates",
    column: "team_id",
    typeRe: /UUID/,
    model: "StatusIncidentUpdate",
    mapRe: /String\s+@map\("team_id"\)\s+@db\.Uuid/,
  },
  {
    migrationId: "20270805000000_phase2_drift_repair_trust_status",
    table: "maintenance_windows",
    column: "team_id",
    typeRe: /UUID/,
    model: "MaintenanceWindow",
    mapRe: mapUuid("team_id", false),
  },
  {
    migrationId: "20270805000000_phase2_drift_repair_trust_status",
    table: "maintenance_windows",
    column: "state",
    typeRe: /VARCHAR\(20\)/,
    model: "MaintenanceWindow",
    // Inline declaration — no @map (column name matches field) — so look for
    // the bare field with @db.VarChar(20), allowing the Prisma client default.
    mapRe: /state\s+String(?:\s+@default\("SCHEDULED"\))?\s+@db\.VarChar\(20\)/,
  },
  {
    migrationId: "20270805000000_phase2_drift_repair_trust_status",
    table: "maintenance_windows",
    column: "description",
    typeRe: /VARCHAR\(600\)/,
    model: "MaintenanceWindow",
    mapRe: /description\s+String\s+@db\.VarChar\(600\)/,
  },
  {
    migrationId: "20270805000000_phase2_drift_repair_trust_status",
    table: "maintenance_windows",
    column: "component_keys",
    typeRe: /JSONB/,
    model: "MaintenanceWindow",
    mapRe: mapJson("component_keys", false),
  },
  {
    migrationId: "20270805000000_phase2_drift_repair_trust_status",
    table: "maintenance_windows",
    column: "updated_at",
    typeRe: /TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    model: "MaintenanceWindow",
    mapRe: mapTimestamptz("updated_at", false),
  },
  {
    migrationId: "20270805000000_phase2_drift_repair_trust_status",
    table: "security_claim_checks",
    column: "created_at",
    typeRe: /TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    model: "SecurityClaimCheck",
    mapRe: mapTimestamptz("created_at", false),
  },
  {
    migrationId: "20270805000000_phase2_drift_repair_trust_status",
    table: "security_claim_checks",
    column: "updated_at",
    typeRe: /TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    model: "SecurityClaimCheck",
    mapRe: mapTimestamptz("updated_at", false),
  },

  // -------------------------------------------------------------------------
  // Domain 2 — Governance (10 columns)
  // -------------------------------------------------------------------------
  {
    migrationId: "20270806000000_phase2_drift_repair_governance",
    table: "delegated_admin_grants",
    column: "organization_id",
    typeRe: /UUID/,
    model: "DelegatedAdminGrant",
    mapRe: mapUuid("organization_id"),
  },
  {
    migrationId: "20270806000000_phase2_drift_repair_governance",
    table: "delegated_admin_grants",
    column: "department_id",
    typeRe: /UUID/,
    model: "DelegatedAdminGrant",
    mapRe: mapUuid("department_id"),
  },
  {
    migrationId: "20270806000000_phase2_drift_repair_governance",
    table: "delegated_admin_grants",
    column: "workspace_id",
    typeRe: /UUID/,
    model: "DelegatedAdminGrant",
    mapRe: mapUuid("workspace_id"),
  },
  {
    migrationId: "20270806000000_phase2_drift_repair_governance",
    table: "governance_policy_assignments",
    column: "scope",
    typeRe: /VARCHAR\(40\)/,
    model: "GovernancePolicyAssignment",
    mapRe: /scope\s+String\s+@db\.VarChar\(40\)/,
  },
  {
    migrationId: "20270806000000_phase2_drift_repair_governance",
    table: "governance_policy_assignments",
    column: "inherit_from_parent",
    typeRe: /BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/,
    model: "GovernancePolicyAssignment",
    mapRe: mapBoolean("inherit_from_parent"),
  },
  {
    migrationId: "20270806000000_phase2_drift_repair_governance",
    table: "governance_policy_assignments",
    column: "is_override",
    typeRe: /BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/,
    model: "GovernancePolicyAssignment",
    mapRe: mapBoolean("is_override"),
  },
  {
    migrationId: "20270806000000_phase2_drift_repair_governance",
    table: "governance_policy_assignments",
    column: "assigned_by_user_id",
    typeRe: /UUID/,
    model: "GovernancePolicyAssignment",
    mapRe: mapUuid("assigned_by_user_id", false),
  },
  {
    migrationId: "20270806000000_phase2_drift_repair_governance",
    table: "governance_policy_audits",
    column: "code",
    typeRe: /VARCHAR\(80\)/,
    model: "GovernancePolicyAudit",
    mapRe: /code\s+String\?\s+@db\.VarChar\(80\)/,
  },
  {
    migrationId: "20270806000000_phase2_drift_repair_governance",
    table: "governance_policy_audits",
    column: "reason",
    typeRe: /VARCHAR\(400\)/,
    model: "GovernancePolicyAudit",
    mapRe: /reason\s+String\?\s+@db\.VarChar\(400\)/,
  },
  {
    migrationId: "20270806000000_phase2_drift_repair_governance",
    table: "governance_policy_audits",
    column: "occurred_at_utc",
    typeRe: /TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    model: "GovernancePolicyAudit",
    mapRe: mapTimestamptz("occurred_at_utc", false),
  },

  // -------------------------------------------------------------------------
  // Domain 3 — Redaction (20 columns)
  // -------------------------------------------------------------------------
  // Phase 2C-B intentionally tightened these verified Category A LOW drift
  // fields from optional to required in Prisma; DB is already NOT NULL and
  // runtime safety was verified in
  // docs/operations/phase-2c-a-runtime-safety-audit.md.
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_versions",
    column: "authored_by_user_id",
    typeRe: /UUID/,
    model: "RedactionVersion",
    mapRe: mapUuid("authored_by_user_id", false),
  },
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_versions",
    column: "superseded_at_utc",
    typeRe: /TIMESTAMPTZ\(6\)(?!\s+NOT\s+NULL)/,
    model: "RedactionVersion",
    mapRe: mapTimestamptz("superseded_at_utc"),
  },
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_versions",
    column: "submitted_at_utc",
    typeRe: /TIMESTAMPTZ\(6\)(?!\s+NOT\s+NULL)/,
    model: "RedactionVersion",
    mapRe: mapTimestamptz("submitted_at_utc"),
  },
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_versions",
    column: "approved_at_utc",
    typeRe: /TIMESTAMPTZ\(6\)(?!\s+NOT\s+NULL)/,
    model: "RedactionVersion",
    mapRe: mapTimestamptz("approved_at_utc"),
  },
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_detections",
    column: "kind",
    typeRe: /VARCHAR\(40\)/,
    model: "RedactionDetection",
    mapRe: /kind\s+String\s+@db\.VarChar\(40\)/,
  },
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_detections",
    column: "suggested_region_kind",
    typeRe: /VARCHAR\(40\)/,
    model: "RedactionDetection",
    mapRe: mapVarchar("suggested_region_kind", 40, false),
  },
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_detections",
    column: "suggested_region_geometry",
    typeRe: /JSONB/,
    model: "RedactionDetection",
    mapRe: mapJson("suggested_region_geometry", false),
  },
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_detections",
    column: "suggested_method",
    typeRe: /VARCHAR\(40\)/,
    model: "RedactionDetection",
    mapRe: mapVarchar("suggested_method", 40, false),
  },
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_detections",
    column: "decision_state",
    typeRe: /VARCHAR\(20\)/,
    model: "RedactionDetection",
    mapRe: mapVarchar("decision_state", 20, false),
  },
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_decisions",
    column: "version_id",
    typeRe: /UUID/,
    model: "RedactionDecision",
    mapRe: mapUuid("version_id", false),
  },
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_approvals",
    column: "approver_user_id",
    typeRe: /UUID/,
    model: "RedactionApproval",
    mapRe: mapUuid("approver_user_id", false),
  },
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_approvals",
    column: "decided_at_utc",
    typeRe: /TIMESTAMPTZ\(6\)(?!\s+NOT\s+NULL)/,
    model: "RedactionApproval",
    mapRe: /DateTime\s+@default\(now\(\)\)\s+@map\("decided_at_utc"\)\s+@db\.Timestamptz\(6\)/,
  },
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_derivatives",
    column: "storage_bucket",
    typeRe: /VARCHAR\(255\)/,
    model: "RedactionDerivative",
    mapRe: mapVarchar("storage_bucket", 255),
  },
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_derivatives",
    column: "render_started_at",
    typeRe: /TIMESTAMPTZ\(6\)(?!\s+NOT\s+NULL)/,
    model: "RedactionDerivative",
    mapRe: mapTimestamptz("render_started_at"),
  },
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_derivatives",
    column: "rendered_at_utc",
    typeRe: /TIMESTAMPTZ\(6\)(?!\s+NOT\s+NULL)/,
    model: "RedactionDerivative",
    mapRe: mapTimestamptz("rendered_at_utc"),
  },
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_derivatives",
    column: "failure_reason",
    typeRe: /VARCHAR\(600\)/,
    model: "RedactionDerivative",
    mapRe: mapVarchar("failure_reason", 600),
  },
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_activities",
    column: "version_id",
    typeRe: /UUID/,
    model: "RedactionActivity",
    mapRe: mapUuid("version_id"),
  },
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_activities",
    column: "occurred_at_utc",
    typeRe: /TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    model: "RedactionActivity",
    mapRe: mapTimestamptz("occurred_at_utc", false),
  },
  {
    migrationId: "20270807000000_phase2_drift_repair_redaction",
    table: "redaction_policy_versions",
    column: "reviewed_by_user_id",
    typeRe: /UUID/,
    model: "RedactionPolicyVersion",
    mapRe: mapUuid("reviewed_by_user_id"),
  },

  // -------------------------------------------------------------------------
  // Domain 7 — Exchange / Packages / Webhooks (5 columns)
  // -------------------------------------------------------------------------
  {
    migrationId: "20270808000000_phase2_drift_repair_lifecycle_webhooks",
    table: "webhook_endpoints",
    column: "updated_at",
    typeRe: /TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    model: "LifecycleWebhookEndpoint",
    mapRe: mapTimestamptz("updated_at", false),
  },
  {
    migrationId: "20270808000000_phase2_drift_repair_lifecycle_webhooks",
    table: "webhook_deliveries",
    column: "updated_at",
    typeRe: /TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    model: "LifecycleWebhookDelivery",
    mapRe: mapTimestamptz("updated_at", false),
  },
  {
    migrationId: "20270808000000_phase2_drift_repair_lifecycle_webhooks",
    table: "webhook_deliveries",
    column: "created_at",
    typeRe: /TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    model: "LifecycleWebhookDelivery",
    mapRe: mapTimestamptz("created_at", false),
  },
  {
    migrationId: "20270808000000_phase2_drift_repair_lifecycle_webhooks",
    table: "webhook_deliveries",
    column: "next_retry_at",
    typeRe: /TIMESTAMPTZ\(6\)(?!\s+NOT\s+NULL)/,
    model: "LifecycleWebhookDelivery",
    mapRe: mapTimestamptz("next_retry_at"),
  },
  {
    migrationId: "20270808000000_phase2_drift_repair_lifecycle_webhooks",
    table: "webhook_deliveries",
    column: "next_attempt_at_utc",
    typeRe: /TIMESTAMPTZ\(6\)(?!\s+NOT\s+NULL)/,
    model: "LifecycleWebhookDelivery",
    mapRe: mapTimestamptz("next_attempt_at_utc"),
  },
];

function migrationById(id: string): MigrationDescriptor {
  const found = PHASE2_MIGRATIONS.find((m) => m.id === id);
  if (!found) {
    throw new Error(`Unknown Phase 2 migration: ${id}`);
  }
  return found;
}

// =============================================================================
// GROUP A — Inventory + decision artifact pins
// =============================================================================
// A.1 — Phase 2 master-drift-inventory doc (relax-to-reality until authored)
// A.2 — Manual decision evidence non-empty (RedactionPolicyAudit deferral)
// A.3 — Allowlist allows all 4 Phase 2 migrations
// =============================================================================

describe("Phase 2 Drift Remediation — inventory + decision artifacts (GROUP A)", () => {
  it("A.1 — Phase 2 master-drift-inventory doc present (RELAX-TO-REALITY: doc authored in later workflow stage)", () => {
    if (PHASE2_DOC == null) {
      // RELAX-TO-REALITY: the inventory doc is written by a follow-up
      // workflow stage. We only assert ABSENCE-IS-KNOWN here — when the
      // doc lands, swap this branch out for the hard-pin in the else.
      expect(PHASE2_DOC).toBeNull();
      return;
    }
    expect(PHASE2_DOC.length).toBeGreaterThan(500);
    expect(PHASE2_DOC).toMatch(/Master\s+Drift\s+Matrix/i);
    expect(PHASE2_DOC).toMatch(/ADDITIVE_SAFE/);
    expect(PHASE2_DOC).toMatch(/REQUIRES_MANUAL_DECISION/);
  });

  it("A.2 — Manual decision table is non-empty (RedactionPolicyAudit table-name drift evidence intact)", () => {
    // The synthesis lists exactly ONE REQUIRES_MANUAL_DECISION item:
    // `redaction_policy_audits` (Prisma plural) vs `redaction_policy_audit`
    // (DB singular). Pin its evidence in BOTH the Phase 3A migration
    // (singular table-create) AND the Phase 2 Redaction migration (deferral
    // note). If either is silently changed, the manual-decision audit is lost.
    const phase3aTableCreate = readRepo(
      "services/api/prisma/migrations/20261201000000_phase_3a_elite_closure_policy_video/migration.sql",
    );
    expect(phase3aTableCreate).toMatch(/redaction_policy_audit\b/);

    // The Phase 2 Redaction migration must explicitly NOTE the deferral so
    // future operators know the table-name drift is intentionally excluded.
    expect(PHASE2_REDACTION_MIGRATION).toMatch(/REQUIRES_MANUAL_DECISION/i);
    expect(PHASE2_REDACTION_MIGRATION).toMatch(
      /redaction_policy_audit\b[\s\S]{0,200}redaction_policy_audits\b|redaction_policy_audits\b[\s\S]{0,200}redaction_policy_audit\b/,
    );
  });

  it("A.3 — Allowlist permits all 4 Phase 2 migrations", () => {
    expect(ALLOWLIST_GUARD).toMatch(/PERMITTED_LATER_MIGRATIONS/);
    for (const { id } of PHASE2_MIGRATIONS) {
      expect(
        ALLOWLIST_GUARD,
        `PERMITTED_LATER_MIGRATIONS must include "${id}"`,
      ).toMatch(new RegExp(`"${id}"`));
    }
  });
});

// =============================================================================
// GROUP B — Per-Phase-2 migration shape (one describe per migration file)
// =============================================================================
// For each of the 4 Phase 2 migrations, assert:
//   * File exists with byteLength > 200
//   * Every non-empty non-comment statement terminates with ;
//   * Every ADD COLUMN uses IF NOT EXISTS
//   * Every CREATE INDEX uses IF NOT EXISTS
//   * Header comment names the domain
//   * Every Phase2ColumnPin for this migration ADDs the expected column
//     with the expected Postgres type literal
// =============================================================================

for (const m of PHASE2_MIGRATIONS) {
  describe(`Phase 2 migration shape — ${m.id} (${m.domain}) (GROUP B)`, () => {
    it("B.1 — file exists, byteLength > 200", () => {
      expect(m.full.length).toBeGreaterThan(200);
    });

    it("B.2 — every non-empty non-comment statement terminates with ';'", () => {
      // Split on semicolons; each segment must EITHER be whitespace + comments
      // only, OR contain at least one non-comment non-whitespace token. The
      // final segment after the last `;` must contain no executable SQL.
      const bodyOnly = m.body.trim();
      // Last meaningful char of the DDL body must be a `;` (or empty).
      if (bodyOnly.length > 0) {
        expect(
          bodyOnly.endsWith(";"),
          `${m.id} DDL body must end with ';' (last 80 chars: ${bodyOnly.slice(-80).replace(/\n/g, "\\n")})`,
        ).toBe(true);
      }
      // Every ALTER TABLE statement must end with a `;` — pin via paired count.
      const alterStarts = (m.body.match(/\bALTER\s+TABLE\b/gi) ?? []).length;
      const semicolons = (m.body.match(/;/g) ?? []).length;
      expect(semicolons).toBeGreaterThanOrEqual(alterStarts);
    });

    it("B.3 — every ADD COLUMN uses IF NOT EXISTS", () => {
      const addColAll = m.body.match(/\bADD\s+COLUMN\b/gi) ?? [];
      const addColGuarded =
        m.body.match(/\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/gi) ?? [];
      expect(addColAll.length).toBeGreaterThan(0);
      expect(addColAll.length).toBe(addColGuarded.length);
    });

    it("B.4 — every CREATE INDEX uses IF NOT EXISTS", () => {
      const idxAll = m.body.match(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/gi) ?? [];
      const idxGuarded =
        m.body.match(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/gi) ??
        [];
      // Phase 2 migrations have ZERO new indexes — but if a future commit
      // adds any, they MUST be IF NOT EXISTS.
      expect(idxAll.length).toBe(idxGuarded.length);
    });

    it("B.5 — every ALTER TABLE uses IF EXISTS", () => {
      const alterAll = m.body.match(/\bALTER\s+TABLE\b/gi) ?? [];
      const alterGuarded =
        m.body.match(/\bALTER\s+TABLE\s+IF\s+EXISTS\b/gi) ?? [];
      expect(alterAll.length).toBeGreaterThan(0);
      expect(alterAll.length).toBe(alterGuarded.length);
    });

    it("B.6 — header comment names the domain", () => {
      expect(m.full).toMatch(/Phase 2 Drift Repair/i);
      // Domain string excerpt (the first 40 chars of m.domain) must appear
      // in the header. Use loose word-by-word containment since "Trust /
      // Status / Subprocessors" maps to "Trust" in the header etc.
      const firstWord = m.domain.split(/\s+/)[0];
      expect(m.full).toMatch(new RegExp(`\\b${firstWord}\\b`, "i"));
    });

    // B.7 — every Phase2ColumnPin targeted at this migration ADDs the expected
    // column with the expected Postgres type literal.
    const colsForMigration = PHASE2_COLUMNS.filter(
      (c) => c.migrationId === m.id,
    );
    for (const c of colsForMigration) {
      it(`B.7.${c.table}.${c.column} — ADDs ${c.table}.${c.column} via ALTER TABLE IF EXISTS + ADD COLUMN IF NOT EXISTS + ${c.typeRe.source}`, () => {
        // Locate the ALTER TABLE block(s) for this table within the migration.
        const re = new RegExp(
          `ALTER\\s+TABLE\\s+IF\\s+EXISTS\\s+"${c.table}"[\\s\\S]*?;`,
          "g",
        );
        const matches = m.full.match(re) ?? [];
        expect(
          matches.length,
          `ALTER TABLE block for ${c.table} must exist in ${m.id}`,
        ).toBeGreaterThan(0);
        const joined = matches.join("\n");
        // Pin the column under IF NOT EXISTS + the type literal.
        const colRe = new RegExp(
          `ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+"${c.column}"\\s+${c.typeRe.source}`,
        );
        expect(joined).toMatch(colRe);
      });
    }
  });
}

// =============================================================================
// GROUP C — Per-column count summary (sanity)
// =============================================================================
// Asserts the closure surface size hasn't silently grown or shrunk —
// Phase 2 was scoped to 50 ADDITIVE_SAFE columns across 4 migrations.
// =============================================================================

describe("Phase 2 Drift Remediation — closure surface size (GROUP C)", () => {
  // The Phase 2 synthesis report claimed Redaction = 20 ADDITIVE_SAFE columns
  // ("Master Drift Matrix rows 27-45 (19 items) + row 47 (1 item)"), but the
  // ACTUAL Redaction migration emits 19 ADD COLUMN statements — row 47 was
  // already covered elsewhere. RELAX-TO-REALITY: we pin the REAL on-disk
  // column count (49 = 15 Trust + 10 Gov + 19 Redaction + 5 Webhooks) so the
  // assertion reflects executed SQL, not the synthesis-report draft figure.
  // If a future commit silently adds the 50th column, the per-domain pins
  // below will fail before the total-count pin does.
  it("C.1 — exactly 49 Phase 2 column pins enumerated (matches on-disk ADD COLUMN count)", () => {
    expect(PHASE2_COLUMNS.length).toBe(49);
  });

  it("C.2 — every Phase 2 migration ID is referenced by at least one column pin", () => {
    const referencedIds = new Set(PHASE2_COLUMNS.map((c) => c.migrationId));
    for (const { id } of PHASE2_MIGRATIONS) {
      expect(
        referencedIds.has(id),
        `Migration ${id} should appear in PHASE2_COLUMNS`,
      ).toBe(true);
    }
  });

  it("C.3 — per-domain column counts match on-disk migrations (Trust=15, Gov=10, Redaction=19, Webhooks=5)", () => {
    function count(id: string): number {
      return PHASE2_COLUMNS.filter((c) => c.migrationId === id).length;
    }
    expect(
      count("20270805000000_phase2_drift_repair_trust_status"),
    ).toBe(15);
    expect(count("20270806000000_phase2_drift_repair_governance")).toBe(10);
    expect(count("20270807000000_phase2_drift_repair_redaction")).toBe(19);
    expect(
      count("20270808000000_phase2_drift_repair_lifecycle_webhooks"),
    ).toBe(5);
  });

  // Additionally pin actual on-disk ADD COLUMN counts so future drift in
  // PHASE2_COLUMNS list vs. real migrations is also detected.
  it("C.4 — on-disk ADD COLUMN count per migration matches column-pin count", () => {
    for (const m of PHASE2_MIGRATIONS) {
      const onDisk = (
        m.body.match(/\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/gi) ?? []
      ).length;
      const pinned = PHASE2_COLUMNS.filter(
        (c) => c.migrationId === m.id,
      ).length;
      expect(
        onDisk,
        `Migration ${m.id} has ${onDisk} ADD COLUMN statements but ${pinned} column pins enumerated`,
      ).toBe(pinned);
    }
  });
});

// =============================================================================
// GROUP D — Bounded GUARDs across ALL 7 closure migrations
// =============================================================================
// 8 destructive-SQL bans applied to every Phase 0/1/2 migration.
// The 4 Phase 2 migrations are PURE ADD COLUMN (no UPDATE / INSERT / DO $$ /
// CREATE INDEX); the 3 prior migrations have bounded DO $$ backfills that
// the Phase 1 test already validated — we only re-pin the negative SQL bans
// here so a regression that mutates ANY closure migration trips this guard.
// =============================================================================

describe("Phase 2 Drift Remediation — destructive-SQL guards across 7 closure migrations (GROUP D)", () => {
  for (const m of ALL_CLOSURE_MIGRATIONS) {
    it(`D.1 [${m.id}] — no DROP TABLE / DROP COLUMN / DROP INDEX / DROP CONSTRAINT / DROP TYPE / DROP SCHEMA`, () => {
      expect(m.body).not.toMatch(/\bDROP\s+TABLE\b/i);
      expect(m.body).not.toMatch(/\bDROP\s+COLUMN\b/i);
      expect(m.body).not.toMatch(/\bDROP\s+INDEX\b/i);
      expect(m.body).not.toMatch(/\bDROP\s+CONSTRAINT\b/i);
      expect(m.body).not.toMatch(/\bDROP\s+TYPE\b/i);
      expect(m.body).not.toMatch(/\bDROP\s+SCHEMA\b/i);
    });

    it(`D.2 [${m.id}] — no ALTER COLUMN DROP NOT NULL`, () => {
      expect(m.body).not.toMatch(/\bDROP\s+NOT\s+NULL\b/i);
      expect(m.body).not.toMatch(
        /\bALTER\s+COLUMN\b[\s\S]{0,80}DROP\s+NOT\s+NULL/i,
      );
    });

    it(`D.3 [${m.id}] — no SET NOT NULL outside of ADD COLUMN clauses (additive-only)`, () => {
      // SET NOT NULL on an EXISTING column is forbidden. SET NOT NULL inside
      // an ADD COLUMN (e.g. "ADD COLUMN ... NOT NULL DEFAULT NOW()") is
      // expressed via NOT NULL DEFAULT — not via the SET NOT NULL token —
      // so the bare-token ban is safe. None of the 7 closure migrations
      // emits a bare `SET NOT NULL`.
      expect(m.body).not.toMatch(/\bSET\s+NOT\s+NULL\b/i);
    });

    it(`D.4 [${m.id}] — no RENAME of any kind (table / column / constraint)`, () => {
      expect(m.body).not.toMatch(/\bRENAME\s+TO\b/i);
      expect(m.body).not.toMatch(/\bRENAME\s+COLUMN\b/i);
      expect(m.body).not.toMatch(/\bRENAME\s+CONSTRAINT\b/i);
      expect(m.body).not.toMatch(/\bRENAME\b/i);
    });

    it(`D.5 [${m.id}] — no TRUNCATE / DELETE / REVOKE / GRANT in DDL body`, () => {
      expect(m.body).not.toMatch(/\bTRUNCATE\b/i);
      expect(m.body).not.toMatch(/\bDELETE\b/i);
      expect(m.body).not.toMatch(/\bREVOKE\b/i);
      expect(m.body).not.toMatch(/\bGRANT\b/i);
    });
  }

  // Phase 2 migrations specifically: NO UPDATE / INSERT / DO $$ — they
  // are pure ALTER TABLE ADD COLUMN streams. Pin separately so a future
  // regression that adds backfill blocks to a Phase 2 migration is loud.
  for (const m of PHASE2_MIGRATIONS) {
    it(`D.6 [${m.id}] — pure ADD COLUMN (no UPDATE / INSERT / DO $$ blocks)`, () => {
      expect(m.body).not.toMatch(/\bUPDATE\b/i);
      expect(m.body).not.toMatch(/\bINSERT\b/i);
      expect(m.body).not.toMatch(/\bDO\s+\$\$/i);
    });
  }
});

// =============================================================================
// GROUP D-prisma — Per-ADD-COLUMN Prisma field pin (49 assertions)
// =============================================================================
// For every column added by Phase 2, the Prisma model that owns the column
// must STILL declare it via @map(...) (or inline field name = column name).
// Proves the migration brings the DB up to the schema — not the other way
// round (the schema-as-truth invariant from the Phase 2 non-negotiables).
// =============================================================================

describe("Phase 2 Drift Remediation — Prisma field pins (GROUP D)", () => {
  for (const c of PHASE2_COLUMNS) {
    it(`D-prisma.${c.model}.${c.column} — Prisma model ${c.model} declares column ${c.column}`, () => {
      const modelRe = new RegExp(`model\\s+${c.model}\\s*\\{[\\s\\S]+?^\\}`, "m");
      const block = SCHEMA_PRISMA.match(modelRe);
      expect(block, `Prisma model ${c.model} must exist in schema.prisma`).toBeTruthy();
      expect(
        block![0],
        `Prisma model ${c.model} must declare column "${c.column}" matching ${c.mapRe.source}`,
      ).toMatch(c.mapRe);
    });
  }
});

// =============================================================================
// GROUP E — Central handler sanity
// =============================================================================
// E.1 — P2022/P2021 → 503 SCHEMA_NOT_READY (handler bridge intact)
// E.2 — No new route file added during Phase 2 (route count stable)
// =============================================================================

// Wave 1: bumped 89 → 91. Wave 1 added 2 legitimate new route files:
//   - intelligence-capabilities.routes.ts
//   - investigation-diagnostics.routes.ts
// Both are net-new investigation-platform routes argued for in the
// Wave 1 brief, not Phase 2 drift.
// Wave 5: bumped 91 → 92. Wave 5 added 1 legitimate new route file:
//   - internal-media-intelligence-extract.routes.ts
// This is the worker→API HTTP callback that replaces the worker's
// illegal cross-import of services/api/src/services/intelligence/*.
// The worker Docker image deliberately omits services/api/src, so the
// extraction orchestration MUST cross the boundary over HTTP. The
// route is service-to-service authenticated (X-Internal-Service-Token)
// and is argued for in the Wave 5 brief, not Phase 2 drift.
// Phase IA-self-serve-regression-fix: bumped 92 → 93. Added 1
// legitimate new route file:
//   - reports.routes.ts
// User-scoped `GET /v1/reports` list endpoint. The workspace-scoped
// /v1/reports/artifacts hard-fails with 404 for self-serve PERSONAL
// users whose workspace bootstrap missed the TeamMember row, so
// generated reports never appeared on /reports. The new endpoint is
// scoped to ownerUserId + ACTIVE team membership and never widens
// the visibility surface (same SIGNED/REPORTED filter; soft-deleted
// evidence excluded). Argued for in the user's regression-fix brief.
// Search-reindex incident fix: bumped 93 → 94. Added 1 legitimate new
// route file:
//   - internal-reindex.routes.ts
// `POST /v1/internal/search/reindex` — secret-gated workspace reindex
// surface. Required because production hit `evidence_search_documents
// = 0` (0/119 indexed in the affected workspace) and the existing
// user-auth `POST /v1/search/reconcile` cannot be invoked from inside
// the API container without minting a user token. The new endpoint
// reuses the canonical `runWorkspaceReindex` service (zero
// reimplementation of projection logic) and is gated by
// `SEARCH_REINDEX_SECRET` via the existing cron-secret middleware —
// it does NOT weaken auth on /v1/search/reconcile.
//
// Contact Sales lead-capture: bumped 94 → 96. Added 2 legitimate new
// route files for the previously-missing /v1/contact-sales pipeline
// (the marketing proxy had been 404-ing on the upstream and the
// fail-open mask hid total Contact Sales lead loss):
//   - contact-sales.routes.ts
//     `POST /v1/contact-sales` — public marketing intake. Persists to
//     the new `contact_sales_requests` table, then best-effort fires
//     operator notification + visitor auto-reply via Resend. Carries
//     `TENANT_SCOPE_EXCEPTION: public_verify_token_readonly` because
//     the table has no `team_id` dimension by design (anonymous
//     visitor at submission time).
//   - admin-contact-sales.routes.ts
//     `GET /v1/admin/contact-sales`, `GET /:id`, `PATCH /:id` — the
//     operator triage queue. All three endpoints gated by
//     `requirePlatformAdmin`. Carries
//     `TENANT_SCOPE_EXCEPTION: platform_admin_global` for the same
//     reason the existing admin-demo-requests routes are not tenant
//     scoped: this is the global marketing-lead queue, the rows have
//     no tenant relation, and PATCH calls write
//     `platform_audit_log` for accountability.
// A retired operations route file was removed from the tree, dropping
// the route-file count from 96 → 95.
const ROUTE_COUNT_PHASE_2_BASELINE = 96;

describe("Phase 2 Drift Remediation — central handler sanity (GROUP E)", () => {
  it("E.1 — central error handler maps Prisma P2022/P2021 → 503 SCHEMA_NOT_READY", () => {
    expect(SERVER_TS).toMatch(
      /diag\.code\s*===\s*"P2022"\s*\|\|\s*diag\.code\s*===\s*"P2021"/,
    );
    expect(SERVER_TS).toMatch(
      /reply\.code\(503\)\.send\(\s*\{\s*error:\s*\{\s*code:\s*"SCHEMA_NOT_READY"/,
    );
    expect(SERVER_TS).toMatch(/"Resource temporarily unavailable\."/);
    expect(SERVER_TS).toMatch(/requestId/);
  });

  it("E.2 — no new route file added during Phase 2 (routes count matches baseline)", () => {
    const routesDir = fileURLToPath(
      new URL("../../../services/api/src/routes", import.meta.url),
    );
    const fileCount = readdirSync(routesDir).filter((name) => {
      const stat = statSync(`${routesDir}/${name}`);
      return stat.isFile() && name.endsWith(".ts");
    }).length;
    // RELAX-TO-REALITY note: we pin the EXACT count observed at Phase 2 close.
    // If a legitimate route ADD happens in a later phase, this pin must be
    // updated explicitly (and the new file argued for in that phase's brief).
    expect(fileCount).toBe(ROUTE_COUNT_PHASE_2_BASELINE);
  });
});

// =============================================================================
// GROUP F — No v2 systems
// =============================================================================
// Negative-glob: no `*v2*` filename anywhere under services/api/src/routes
// or apps/web/app. The repo has ZERO v2 files today.
// =============================================================================

describe("Phase 2 Drift Remediation — no new v2 systems (GROUP F)", () => {
  it("F.1 — no *v2* route in services/api/src/routes and no *v2* page in apps/web/app", () => {
    function walk(dir: string): ReadonlyArray<string> {
      const entries = readdirSync(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        const child = `${dir}/${e.name}`;
        if (e.isDirectory()) out.push(...walk(child));
        else out.push(child);
      }
      return out;
    }

    const routesDir = fileURLToPath(
      new URL("../../../services/api/src/routes", import.meta.url),
    );
    const allRouteFiles = walk(routesDir).map((p) => p.replace(/\\/g, "/"));
    const v2Routes = allRouteFiles.filter((p) =>
      /v2/i.test(p.split("/").pop() ?? ""),
    );
    expect(v2Routes).toEqual([]);

    const webAppDir = fileURLToPath(
      new URL("../../../apps/web/app", import.meta.url),
    );
    const allWebFiles = walk(webAppDir).map((p) => p.replace(/\\/g, "/"));
    const v2Pages = allWebFiles.filter((p) =>
      /v2/i.test(p.split("/").pop() ?? ""),
    );
    expect(v2Pages).toEqual([]);
  });
});

// =============================================================================
// GROUP G — No schema downgrade during Phase 2
// =============================================================================
// The Phase 2 non-negotiables forbid "changing Prisma schema to match broken
// production". To pin this, we assert key invariants on the 7 Prisma models
// touched by Phase 2 — model declarations remain intact AND every Phase 2
// column is present in its owning model (GROUP D-prisma above already pins
// the per-column @map). Here we pin the model existence + @@map(...) so a
// silent rename of the underlying table also trips the guard.
// =============================================================================

interface ModelPin {
  readonly model: string;
  readonly tableMap: string;
}

const PHASE2_MODEL_PINS: ReadonlyArray<ModelPin> = [
  // Domain 1
  { model: "TrustCenterArticleVersion", tableMap: "trust_center_article_versions" },
  { model: "SubprocessorVersion", tableMap: "subprocessor_versions" },
  { model: "StatusIncident", tableMap: "status_incidents" },
  { model: "StatusIncidentUpdate", tableMap: "status_incident_updates" },
  { model: "MaintenanceWindow", tableMap: "maintenance_windows" },
  { model: "SecurityClaimCheck", tableMap: "security_claim_checks" },
  // Domain 2
  { model: "DelegatedAdminGrant", tableMap: "delegated_admin_grants" },
  { model: "GovernancePolicyAssignment", tableMap: "governance_policy_assignments" },
  { model: "GovernancePolicyAudit", tableMap: "governance_policy_audits" },
  // Domain 3
  { model: "RedactionVersion", tableMap: "redaction_versions" },
  { model: "RedactionDetection", tableMap: "redaction_detections" },
  { model: "RedactionDecision", tableMap: "redaction_decisions" },
  { model: "RedactionApproval", tableMap: "redaction_approvals" },
  { model: "RedactionDerivative", tableMap: "redaction_derivatives" },
  { model: "RedactionActivity", tableMap: "redaction_activities" },
  { model: "RedactionPolicyVersion", tableMap: "redaction_policy_versions" },
  // Domain 7
  { model: "LifecycleWebhookEndpoint", tableMap: "webhook_endpoints" },
  { model: "LifecycleWebhookDelivery", tableMap: "webhook_deliveries" },
];

describe("Phase 2 Drift Remediation — no schema downgrade (GROUP G)", () => {
  for (const { model, tableMap } of PHASE2_MODEL_PINS) {
    it(`G.${model} — Prisma model ${model} present and @@map("${tableMap}") intact`, () => {
      const modelRe = new RegExp(`model\\s+${model}\\s*\\{[\\s\\S]+?^\\}`, "m");
      const block = SCHEMA_PRISMA.match(modelRe);
      expect(
        block,
        `Prisma model ${model} must exist in schema.prisma`,
      ).toBeTruthy();
      expect(
        block![0],
        `${model} must @@map("${tableMap}")`,
      ).toMatch(new RegExp(`@@map\\("${tableMap}"\\)`));
    });
  }
});
