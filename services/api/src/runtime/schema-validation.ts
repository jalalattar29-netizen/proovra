/**
 * Runtime schema validation.
 *
 * Asserts that the production Prisma client and the live database are
 * in agreement on the tables, columns, enums, and indexes the API's
 * critical paths depend on. Runs on API startup and is also exposed
 * via the `/admin/runtime/schema-status` endpoint for operator probes.
 *
 * Goals:
 *   1. Detect drift BEFORE the first request would have hit a P2022 /
 *      P2021 / undefined-column failure in production.
 *   2. Tag drift events to Sentry with stable fingerprints so the
 *      on-call sees one incident per drift class, not one per request.
 *   3. Surface a degraded-mode banner via the schema-status route so
 *      operators can confirm whether reviewer-ops endpoints will work
 *      without firing a request that may corrupt state.
 *   4. Fail-fast ONLY on CRITICAL reviewer-ops or governance schema
 *      corruption. Non-critical drift (missing optional table, missing
 *      index) returns a "DEGRADED" status so we don't reject perfectly-
 *      good evidence intake just because reviewer dashboards are stale.
 *
 * Hard rules:
 *   - This module never writes. Inspection-only.
 *   - Validation queries use parameterised `to_regclass` and
 *     information_schema lookups — no string concatenation, no
 *     dynamic SQL beyond bind values.
 *   - The catalog of expected objects is encoded as a typed value in
 *     this file. Updating the catalog requires a code review.
 */

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../db.js";

// -----------------------------------------------------------------------------
// Expected-schema catalog
// -----------------------------------------------------------------------------

/** A target object the runtime expects to exist in the live database. */
export type ExpectedSchemaObject =
  | {
      kind: "table";
      name: string;
      /**
       * `critical` — API cannot serve traffic safely without it. Drift
       * at this level fails startup.
       *
       * `important` — Specific subsystem will degrade but the rest of
       * the platform stays healthy. Reported as degraded.
       *
       * `optional` — Index or telemetry table. Logged as info only.
       */
      severity: "critical" | "important" | "optional";
      /** Bound subsystem id; surfaces on the status endpoint. */
      subsystem: SubsystemId;
    }
  | {
      kind: "column";
      table: string;
      column: string;
      severity: "critical" | "important" | "optional";
      subsystem: SubsystemId;
    }
  | {
      kind: "enum";
      name: string;
      severity: "critical" | "important" | "optional";
      subsystem: SubsystemId;
    }
  | {
      kind: "enum_value";
      enumName: string;
      value: string;
      severity: "critical" | "important" | "optional";
      subsystem: SubsystemId;
    }
  | {
      kind: "index";
      table: string;
      indexName: string;
      severity: "critical" | "important" | "optional";
      subsystem: SubsystemId;
    };

export type SubsystemId =
  | "core_evidence"
  | "governance_lifecycle"
  | "reviewer_ops"
  | "workflow_engine"
  | "integrations"
  | "identity"
  | "operational_incidents"
  | "search_discovery";

/**
 * The expected-schema catalog. Updated when a new migration adds
 * runtime-critical objects. Mirrors Prisma `@@map` values from
 * `services/api/prisma/schema.prisma`.
 */
export const EXPECTED_SCHEMA: ReadonlyArray<ExpectedSchemaObject> = [
  // ---------------------------------------------------------------------------
  // Core evidence — without these tables the platform has no fall-back.
  // ---------------------------------------------------------------------------
  { kind: "table", name: "evidence", severity: "critical", subsystem: "core_evidence" },
  { kind: "table", name: "users", severity: "critical", subsystem: "core_evidence" },
  { kind: "table", name: "teams", severity: "critical", subsystem: "core_evidence" },
  { kind: "table", name: "custody_events", severity: "critical", subsystem: "core_evidence" },
  { kind: "table", name: "admin_audit_logs", severity: "critical", subsystem: "core_evidence" },

  // ---------------------------------------------------------------------------
  // Governance lifecycle (Phase 9 + 27).
  // ---------------------------------------------------------------------------
  { kind: "enum", name: "EvidenceDeletionMode", severity: "important", subsystem: "governance_lifecycle" },
  { kind: "enum", name: "LegalHoldStatus", severity: "important", subsystem: "governance_lifecycle" },
  { kind: "table", name: "workspace_governance_policies", severity: "important", subsystem: "governance_lifecycle" },
  { kind: "table", name: "evidence_legal_holds", severity: "important", subsystem: "governance_lifecycle" },
  { kind: "table", name: "evidence_retention_policies", severity: "important", subsystem: "governance_lifecycle" },
  { kind: "table", name: "evidence_retention_policy_versions", severity: "important", subsystem: "governance_lifecycle" },
  { kind: "table", name: "destruction_reviews", severity: "important", subsystem: "governance_lifecycle" },
  { kind: "table", name: "evidence_lifecycle_events", severity: "important", subsystem: "governance_lifecycle" },
  { kind: "enum_value", enumName: "CustodyEventType", value: "LEGAL_HOLD_PLACED", severity: "important", subsystem: "governance_lifecycle" },
  { kind: "enum_value", enumName: "CustodyEventType", value: "LEGAL_HOLD_RELEASED", severity: "important", subsystem: "governance_lifecycle" },

  // ---------------------------------------------------------------------------
  // Reviewer ops (Phase 13 + 25). CRITICAL — these tables back the
  // dashboards the brief asked us to activate. P2022 here = production
  // outage, which is what triggered this whole consolidation phase.
  // ---------------------------------------------------------------------------
  { kind: "table", name: "evidence_review_workflows", severity: "critical", subsystem: "reviewer_ops" },
  { kind: "table", name: "evidence_review_workflow_events", severity: "critical", subsystem: "reviewer_ops" },
  { kind: "table", name: "review_escalations", severity: "critical", subsystem: "reviewer_ops" },
  { kind: "table", name: "reviewer_workload_snapshots", severity: "critical", subsystem: "reviewer_ops" },
  { kind: "table", name: "reviewer_ops_reminders", severity: "important", subsystem: "reviewer_ops" },
  // Phase 25 additive columns on evidence_review_workflows.
  { kind: "column", table: "evidence_review_workflows", column: "assignment_due_at_utc", severity: "critical", subsystem: "reviewer_ops" },
  { kind: "column", table: "evidence_review_workflows", column: "completion_due_at_utc", severity: "critical", subsystem: "reviewer_ops" },
  { kind: "column", table: "evidence_review_workflows", column: "paused_reason", severity: "critical", subsystem: "reviewer_ops" },
  { kind: "column", table: "evidence_review_workflows", column: "active_escalation_id", severity: "critical", subsystem: "reviewer_ops" },
  // Unique constraint dedup'ing escalations per fingerprint.
  { kind: "index", table: "review_escalations", indexName: "review_escalations_team_fingerprint_uk", severity: "critical", subsystem: "reviewer_ops" },

  // ---------------------------------------------------------------------------
  // Reviewer Ops — Phase 24 / 25.5 saved views. Drift on `scope` is the
  // exact P2022 the operator saw on /reviewer-ops/saved-views; register
  // the column so the next time it's missing we catch it at startup
  // rather than at request time.
  // ---------------------------------------------------------------------------
  { kind: "table", name: "saved_search_views", severity: "important", subsystem: "reviewer_ops" },
  { kind: "column", table: "saved_search_views", column: "scope", severity: "critical", subsystem: "reviewer_ops" },
  { kind: "column", table: "saved_search_views", column: "query_json", severity: "critical", subsystem: "reviewer_ops" },
  { kind: "column", table: "saved_search_views", column: "visibility", severity: "important", subsystem: "reviewer_ops" },
  { kind: "column", table: "saved_search_views", column: "pinned", severity: "important", subsystem: "reviewer_ops" },
  { kind: "column", table: "saved_search_views", column: "last_used_at_utc", severity: "important", subsystem: "reviewer_ops" },

  // ---------------------------------------------------------------------------
  // Workflow engine (Phase 22).
  // ---------------------------------------------------------------------------
  { kind: "table", name: "evidence_workflow_templates", severity: "important", subsystem: "workflow_engine" },
  { kind: "table", name: "evidence_workflow_instances", severity: "important", subsystem: "workflow_engine" },
  { kind: "table", name: "evidence_workflow_step_instances", severity: "important", subsystem: "workflow_engine" },
  { kind: "table", name: "evidence_workflow_instance_evidence", severity: "important", subsystem: "workflow_engine" },
  { kind: "table", name: "evidence_workflow_visibility_decisions", severity: "important", subsystem: "workflow_engine" },
  { kind: "column", table: "evidence_workflow_templates", column: "status", severity: "important", subsystem: "workflow_engine" },

  // ---------------------------------------------------------------------------
  // Integrations (Phase 10).
  // ---------------------------------------------------------------------------
  { kind: "table", name: "api_credentials", severity: "important", subsystem: "integrations" },
  { kind: "table", name: "integration_webhook_endpoints", severity: "important", subsystem: "integrations" },
  { kind: "table", name: "integration_webhook_deliveries", severity: "important", subsystem: "integrations" },

  // ---------------------------------------------------------------------------
  // Operational incidents (Phase 21).
  // ---------------------------------------------------------------------------
  { kind: "table", name: "operational_incidents", severity: "important", subsystem: "operational_incidents" },
  { kind: "table", name: "operational_incident_events", severity: "important", subsystem: "operational_incidents" },

  // ---------------------------------------------------------------------------
  // Search + Discovery (Phase 24 + 24-J). The Phase 24 base shipped
  // `evidence_search_documents` and `saved_search_views`; Phase 24-J
  // adds the dedicated audit log, OCR text, and transcript stores.
  // The FTS `tsv` column on `evidence_search_documents` is OPTIONAL —
  // the service falls back to ILIKE when it's missing — so it's
  // registered as `important` not `critical`.
  // ---------------------------------------------------------------------------
  { kind: "table", name: "evidence_search_documents", severity: "important", subsystem: "search_discovery" },
  { kind: "table", name: "saved_search_views", severity: "important", subsystem: "search_discovery" },
  { kind: "table", name: "search_audit_logs", severity: "important", subsystem: "search_discovery" },
  { kind: "table", name: "evidence_ocr_text", severity: "important", subsystem: "search_discovery" },
  { kind: "table", name: "evidence_transcript_segments", severity: "important", subsystem: "search_discovery" },
  // Phase 24-J FTS additions on the search document table. Missing →
  // the service falls back to ILIKE; not a fail-fast.
  { kind: "column", table: "evidence_search_documents", column: "tsv", severity: "optional", subsystem: "search_discovery" },
  { kind: "index", table: "evidence_search_documents", indexName: "evidence_search_documents_tsv_gin", severity: "optional", subsystem: "search_discovery" },
  // Audit log critical columns.
  { kind: "column", table: "search_audit_logs", column: "fail_closed", severity: "important", subsystem: "search_discovery" },
  { kind: "column", table: "search_audit_logs", column: "filtered_governance_count", severity: "important", subsystem: "search_discovery" },
  // OCR / transcript visibility scope columns — drift here would
  // disable the governance gate on Discovery indexing.
  { kind: "column", table: "evidence_ocr_text", column: "visibility_scope", severity: "important", subsystem: "search_discovery" },
  { kind: "column", table: "evidence_ocr_text", column: "redacted", severity: "important", subsystem: "search_discovery" },
  { kind: "column", table: "evidence_transcript_segments", column: "visibility_scope", severity: "important", subsystem: "search_discovery" },
  { kind: "column", table: "evidence_transcript_segments", column: "redacted", severity: "important", subsystem: "search_discovery" },

  // ---------------------------------------------------------------------------
  // Phase 27/28 — External reviewer grant persistence. Drift on the
  // state catalog or the token-hash column would silently break
  // external review access — register them at `critical` severity so
  // the next startup fails fast if the drift patch hasn't been applied.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Phase 30 — Resumable multipart upload sessions. Drift on `state`
  // or the unique (session_id, part_index) index would silently break
  // upload resumability. Register at critical severity so the startup
  // validator catches drift before the upload path fails at runtime.
  // ---------------------------------------------------------------------------
  { kind: "table", name: "evidence_upload_sessions", severity: "important", subsystem: "core_evidence" },
  { kind: "table", name: "evidence_upload_session_parts", severity: "important", subsystem: "core_evidence" },
  { kind: "column", table: "evidence_upload_sessions", column: "state", severity: "critical", subsystem: "core_evidence" },
  { kind: "column", table: "evidence_upload_sessions", column: "completed_at_utc", severity: "critical", subsystem: "core_evidence" },
  { kind: "column", table: "evidence_upload_session_parts", column: "state", severity: "critical", subsystem: "core_evidence" },
  { kind: "column", table: "evidence_upload_session_parts", column: "verified_at_utc", severity: "critical", subsystem: "core_evidence" },
  { kind: "column", table: "evidence_upload_session_parts", column: "server_sha256", severity: "critical", subsystem: "core_evidence" },
  { kind: "index", table: "evidence_upload_session_parts", indexName: "evidence_upload_session_parts_uk", severity: "critical", subsystem: "core_evidence" },
  // Phase 30.8 — S3 native multipart columns. Critical: dropping the
  // `multipart_upload_id` / `storage_key` columns would break the
  // abort/complete path against S3 and risk orphaning multipart
  // transactions on the storage side.
  { kind: "column", table: "evidence_upload_sessions", column: "multipart_upload_id", severity: "critical", subsystem: "core_evidence" },
  { kind: "column", table: "evidence_upload_sessions", column: "storage_bucket", severity: "critical", subsystem: "core_evidence" },
  { kind: "column", table: "evidence_upload_sessions", column: "storage_key", severity: "critical", subsystem: "core_evidence" },
  { kind: "column", table: "evidence_upload_sessions", column: "completed_at_storage_utc", severity: "important", subsystem: "core_evidence" },
  { kind: "column", table: "evidence_upload_session_parts", column: "part_etag", severity: "critical", subsystem: "core_evidence" },
  { kind: "index", table: "evidence_upload_sessions", indexName: "evidence_upload_sessions_multipart_uk", severity: "important", subsystem: "core_evidence" },
  // Phase 30.12 — upload-session → EvidencePart bridge columns.
  // Dropping `bridged_evidence_part_id` would break the idempotency
  // guarantee on completeStorageMultipart's bridge step (a retry
  // could create a second EvidencePart row).
  { kind: "column", table: "evidence_upload_sessions", column: "target_part_index", severity: "critical", subsystem: "core_evidence" },
  { kind: "column", table: "evidence_upload_sessions", column: "original_file_name", severity: "critical", subsystem: "core_evidence" },
  { kind: "column", table: "evidence_upload_sessions", column: "expected_mime_type", severity: "important", subsystem: "core_evidence" },
  { kind: "column", table: "evidence_upload_sessions", column: "bridged_evidence_part_id", severity: "critical", subsystem: "core_evidence" },
  // Phase 31 — media intelligence signals table. Important (not
  // critical) — the platform's core evidence path runs without
  // this table; missing it only degrades the advisory layer.
  { kind: "table", name: "media_intelligence_signals", severity: "important", subsystem: "core_evidence" },
  { kind: "column", table: "media_intelligence_signals", column: "signal_type", severity: "important", subsystem: "core_evidence" },
  { kind: "column", table: "media_intelligence_signals", column: "severity", severity: "important", subsystem: "core_evidence" },
  { kind: "index", table: "media_intelligence_signals", indexName: "media_intelligence_signals_evidence_material_type_uk", severity: "important", subsystem: "core_evidence" },
  // Phase 31.5 — media intelligence run tracker. Important
  // (not critical) — analyzer can fall back to synchronous mode
  // without it, and core evidence flow never depends on it.
  { kind: "table", name: "media_intelligence_runs", severity: "important", subsystem: "core_evidence" },
  { kind: "column", table: "media_intelligence_runs", column: "status", severity: "important", subsystem: "core_evidence" },
  { kind: "column", table: "media_intelligence_runs", column: "kind", severity: "important", subsystem: "core_evidence" },
  // Phase 31.8 — bounded per-EvidencePart EXIF summary persistence.
  // Important (not critical) — analyzer can degrade gracefully to
  // the heuristic exifPresent flag when the table is absent.
  { kind: "table", name: "evidence_part_exif_summaries", severity: "important", subsystem: "core_evidence" },
  { kind: "column", table: "evidence_part_exif_summaries", column: "exif_present", severity: "important", subsystem: "core_evidence" },
  { kind: "column", table: "evidence_part_exif_summaries", column: "has_gps", severity: "important", subsystem: "core_evidence" },
  { kind: "column", table: "evidence_part_exif_summaries", column: "status", severity: "important", subsystem: "core_evidence" },
  { kind: "index", table: "evidence_part_exif_summaries", indexName: "evidence_part_exif_summaries_team_part_uk", severity: "important", subsystem: "core_evidence" },
  // Phase 31.13 — bounded derived-assets pipeline (image thumbnails
  // this phase; video frames / waveforms reserved for the future).
  // Important (not critical) — the report / package / verify flows
  // all work without derived assets; absence yields "no derived
  // previews" UI states.
  { kind: "table", name: "evidence_part_derived_assets", severity: "important", subsystem: "core_evidence" },
  { kind: "column", table: "evidence_part_derived_assets", column: "asset_kind", severity: "important", subsystem: "core_evidence" },
  { kind: "column", table: "evidence_part_derived_assets", column: "status", severity: "important", subsystem: "core_evidence" },
  { kind: "column", table: "evidence_part_derived_assets", column: "derived_sha256", severity: "important", subsystem: "core_evidence" },
  { kind: "index", table: "evidence_part_derived_assets", indexName: "evidence_part_derived_assets_team_part_kind_uk", severity: "important", subsystem: "core_evidence" },
  // Phase 32 — investigation graph. Important (not critical) —
  // the graph is an advisory traversal layer; missing it doesn't
  // block evidence lifecycle.
  { kind: "table", name: "investigation_graph_nodes", severity: "important", subsystem: "core_evidence" },
  { kind: "table", name: "investigation_graph_edges", severity: "important", subsystem: "core_evidence" },
  { kind: "table", name: "manual_relationships", severity: "important", subsystem: "core_evidence" },
  { kind: "index", table: "investigation_graph_nodes", indexName: "investigation_graph_nodes_team_kind_ext_uk", severity: "important", subsystem: "core_evidence" },
  { kind: "index", table: "investigation_graph_edges", indexName: "investigation_graph_edges_team_triple_uk", severity: "important", subsystem: "core_evidence" },

  { kind: "table", name: "external_review_grants", severity: "important", subsystem: "governance_lifecycle" },
  { kind: "column", table: "external_review_grants", column: "state", severity: "critical", subsystem: "governance_lifecycle" },
  { kind: "column", table: "external_review_grants", column: "token_hash", severity: "critical", subsystem: "governance_lifecycle" },
  { kind: "column", table: "external_review_grants", column: "expires_at_utc", severity: "critical", subsystem: "governance_lifecycle" },
  { kind: "column", table: "external_review_grants", column: "scope_kind", severity: "important", subsystem: "governance_lifecycle" },
  { kind: "column", table: "external_review_grants", column: "allow_original_download", severity: "important", subsystem: "governance_lifecycle" },
  { kind: "index", table: "external_review_grants", indexName: "external_review_grants_token_hash_uk", severity: "critical", subsystem: "governance_lifecycle" },
];

// -----------------------------------------------------------------------------
// Validation result types
// -----------------------------------------------------------------------------

export type SchemaCheckOutcome = "present" | "missing" | "unknown";

export type SchemaCheckResult = {
  target: ExpectedSchemaObject;
  outcome: SchemaCheckOutcome;
  /** Free-form diagnostic context. Never leaks privileged values. */
  detail?: string;
};

export type SubsystemHealth = {
  subsystem: SubsystemId;
  status: "healthy" | "degraded" | "critical";
  missingCritical: number;
  missingImportant: number;
  missingOptional: number;
};

export type SchemaValidationReport = {
  /** Overall status: critical, degraded, or healthy. */
  status: "healthy" | "degraded" | "critical";
  /** ISO timestamp of the validation run. */
  ranAtUtc: string;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Total objects checked. */
  checked: number;
  /** Stable fingerprint of the missing-object set — used as the Sentry
   *  issue grouping key so one alert fires per drift class. */
  driftFingerprint: string;
  /** Per-object results — only failures included by default. */
  failures: ReadonlyArray<SchemaCheckResult>;
  /** Per-subsystem rollup. */
  subsystems: ReadonlyArray<SubsystemHealth>;
};

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

async function checkTable(
  prisma: PrismaClient,
  name: string,
): Promise<SchemaCheckOutcome> {
  try {
    const result = await prisma.$queryRawUnsafe<{ present: boolean }[]>(
      `SELECT (to_regclass('public.' || $1) IS NOT NULL) AS present`,
      name,
    );
    return result[0]?.present ? "present" : "missing";
  } catch {
    return "unknown";
  }
}

async function checkColumn(
  prisma: PrismaClient,
  table: string,
  column: string,
): Promise<SchemaCheckOutcome> {
  try {
    const result = await prisma.$queryRawUnsafe<{ present: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = $1
           AND column_name = $2
       ) AS present`,
      table,
      column,
    );
    return result[0]?.present ? "present" : "missing";
  } catch {
    return "unknown";
  }
}

async function checkEnum(
  prisma: PrismaClient,
  name: string,
): Promise<SchemaCheckOutcome> {
  try {
    const result = await prisma.$queryRawUnsafe<{ present: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = $1) AS present`,
      name,
    );
    return result[0]?.present ? "present" : "missing";
  } catch {
    return "unknown";
  }
}

async function checkEnumValue(
  prisma: PrismaClient,
  enumName: string,
  value: string,
): Promise<SchemaCheckOutcome> {
  try {
    const result = await prisma.$queryRawUnsafe<{ present: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
         WHERE t.typname = $1 AND e.enumlabel = $2
       ) AS present`,
      enumName,
      value,
    );
    return result[0]?.present ? "present" : "missing";
  } catch {
    return "unknown";
  }
}

async function checkIndex(
  prisma: PrismaClient,
  table: string,
  indexName: string,
): Promise<SchemaCheckOutcome> {
  try {
    const result = await prisma.$queryRawUnsafe<{ present: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = $1
           AND indexname = $2
       ) AS present`,
      table,
      indexName,
    );
    return result[0]?.present ? "present" : "missing";
  } catch {
    return "unknown";
  }
}

function fingerprintFailures(failures: ReadonlyArray<SchemaCheckResult>): string {
  // Stable key: sorted "kind:name" pairs hashed to a short hex digest.
  // Used as the Sentry grouping fingerprint so the on-call sees one
  // alert per drift class, not one per check round.
  const keys = failures
    .map((f) => {
      const t = f.target;
      if (t.kind === "column") return `column:${t.table}.${t.column}`;
      if (t.kind === "enum_value") return `enum_value:${t.enumName}.${t.value}`;
      if (t.kind === "index") return `index:${t.table}.${t.indexName}`;
      return `${t.kind}:${(t as { name: string }).name}`;
    })
    .sort()
    .join("|");
  if (keys.length === 0) return "ok";
  // 32-bit FNV-1a — short, stable, no crypto dep.
  let hash = 0x811c9dc5;
  for (let i = 0; i < keys.length; i++) {
    hash ^= keys.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return `drift_${hash.toString(16).padStart(8, "0")}`;
}

function rollUpSubsystems(
  failures: ReadonlyArray<SchemaCheckResult>,
): SubsystemHealth[] {
  const ids: SubsystemId[] = [
    "core_evidence",
    "governance_lifecycle",
    "reviewer_ops",
    "workflow_engine",
    "integrations",
    "identity",
    "operational_incidents",
    "search_discovery",
  ];
  return ids.map((subsystem) => {
    const subsystemFailures = failures.filter(
      (f) => f.target.subsystem === subsystem,
    );
    const missingCritical = subsystemFailures.filter(
      (f) => f.target.severity === "critical",
    ).length;
    const missingImportant = subsystemFailures.filter(
      (f) => f.target.severity === "important",
    ).length;
    const missingOptional = subsystemFailures.filter(
      (f) => f.target.severity === "optional",
    ).length;
    const status: SubsystemHealth["status"] =
      missingCritical > 0
        ? "critical"
        : missingImportant > 0
          ? "degraded"
          : "healthy";
    return {
      subsystem,
      status,
      missingCritical,
      missingImportant,
      missingOptional,
    };
  });
}

/**
 * Run the full validation sweep. Never throws — all failures are
 * collected and projected into the report shape. The caller decides
 * what to do (log, alert, return JSON, refuse to boot).
 */
export async function runSchemaValidation(
  prisma: PrismaClient = defaultPrisma,
): Promise<SchemaValidationReport> {
  const startedAt = Date.now();
  const failures: SchemaCheckResult[] = [];
  let checked = 0;

  for (const target of EXPECTED_SCHEMA) {
    checked += 1;
    let outcome: SchemaCheckOutcome = "unknown";
    try {
      switch (target.kind) {
        case "table":
          outcome = await checkTable(prisma, target.name);
          break;
        case "column":
          outcome = await checkColumn(prisma, target.table, target.column);
          break;
        case "enum":
          outcome = await checkEnum(prisma, target.name);
          break;
        case "enum_value":
          outcome = await checkEnumValue(prisma, target.enumName, target.value);
          break;
        case "index":
          outcome = await checkIndex(prisma, target.table, target.indexName);
          break;
      }
    } catch (err) {
      outcome = "unknown";
      failures.push({
        target,
        outcome,
        detail:
          err instanceof Error
            ? err.message.slice(0, 200)
            : "unknown_query_error",
      });
      continue;
    }
    if (outcome !== "present") {
      failures.push({ target, outcome });
    }
  }

  const subsystems = rollUpSubsystems(failures);
  const anyCritical = subsystems.some((s) => s.status === "critical");
  const anyDegraded = subsystems.some((s) => s.status === "degraded");
  const status: SchemaValidationReport["status"] = anyCritical
    ? "critical"
    : anyDegraded
      ? "degraded"
      : "healthy";

  return {
    status,
    ranAtUtc: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    checked,
    driftFingerprint: fingerprintFailures(failures),
    failures,
    subsystems,
  };
}

// -----------------------------------------------------------------------------
// Startup wiring
// -----------------------------------------------------------------------------

export type SchemaValidationLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
};

export type SchemaValidationSentryHook = (input: {
  fingerprint: string;
  status: "critical" | "degraded";
  failingSubsystems: ReadonlyArray<SubsystemId>;
  summary: string;
}) => void;

/**
 * Run validation at API startup. The caller (server.ts) decides
 * whether to terminate the process on CRITICAL. Default policy:
 *   - HEALTHY: log info, return report.
 *   - DEGRADED: log warn, emit Sentry tag (low severity), return report.
 *   - CRITICAL: log error, emit Sentry tag (high severity), throw —
 *     server.ts can then choose to abort startup OR continue in
 *     read-only mode depending on env policy.
 */
export async function validateAtStartup(input: {
  logger: SchemaValidationLogger;
  sentryHook?: SchemaValidationSentryHook;
  prisma?: PrismaClient;
  failFastOnCritical?: boolean;
}): Promise<SchemaValidationReport> {
  const report = await runSchemaValidation(input.prisma ?? defaultPrisma);

  const failingSubsystems = report.subsystems
    .filter((s) => s.status !== "healthy")
    .map((s) => s.subsystem);

  if (report.status === "healthy") {
    input.logger.info(
      {
        ranAtUtc: report.ranAtUtc,
        durationMs: report.durationMs,
        checked: report.checked,
      },
      "runtime.schema_validation.healthy",
    );
    return report;
  }

  const summary = `${report.status.toUpperCase()} schema drift (${
    report.failures.length
  } / ${report.checked} missing) — subsystems: ${failingSubsystems.join(",") || "none"} — fingerprint=${report.driftFingerprint}`;

  if (report.status === "degraded") {
    input.logger.warn(
      {
        fingerprint: report.driftFingerprint,
        failingSubsystems,
        failures: report.failures.map((f) => ({
          kind: f.target.kind,
          severity: f.target.severity,
          subsystem: f.target.subsystem,
        })),
      },
      "runtime.schema_validation.degraded",
    );
    input.sentryHook?.({
      fingerprint: report.driftFingerprint,
      status: "degraded",
      failingSubsystems,
      summary,
    });
    return report;
  }

  // CRITICAL — fail-fast policy decided by caller.
  input.logger.error(
    {
      fingerprint: report.driftFingerprint,
      failingSubsystems,
      failures: report.failures.map((f) => ({
        kind: f.target.kind,
        severity: f.target.severity,
        subsystem: f.target.subsystem,
      })),
    },
    "runtime.schema_validation.critical",
  );
  input.sentryHook?.({
    fingerprint: report.driftFingerprint,
    status: "critical",
    failingSubsystems,
    summary,
  });

  if (input.failFastOnCritical) {
    const err = new Error(
      `Critical schema drift detected at startup. ${summary}`,
    );
    (err as Error & { code?: string }).code = "SCHEMA_DRIFT_CRITICAL";
    throw err;
  }

  return report;
}
