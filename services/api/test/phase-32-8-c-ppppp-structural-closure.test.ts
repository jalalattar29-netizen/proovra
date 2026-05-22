/**
 * Phase 32.8C+++++ — Structural Intelligence Closure.
 *
 * Source-contract regression suite. Locks in:
 *
 *  PART 1 — Prisma schema additions (5 new models + 9 new enums +
 *           TSA issuer columns on EvidenceIntegritySnapshot)
 *  PART 2 — Migration file source-contract
 *  PART 3 — Queue telemetry service (DB-derived writer + reader)
 *  PART 4 — Worker telemetry service (heartbeat writer + reader)
 *  PART 5 — Case ↔ evidence link service (lazy backfill, cross-case
 *           intelligence reads)
 *  PART 6 — Operational timeline projection (idempotent writer +
 *           reader)
 *  PART 7 — Case comment backlog reader
 *  PART 8 — TSA issuer derivation (no-op stub, UNAVAILABLE by default)
 *  PART 9 — Dashboard wiring (unsupportedSignals shrink; sourceSummary
 *           advertises new sources)
 *  PART 10 — No-regression invariants (no fake data, no signed URLs,
 *           no legal overclaim, no core-flow blocking)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

const SCHEMA = readApi("prisma/schema.prisma");
const MIGRATION = readApi(
  "prisma/migrations/20260626100000_phase328cppppp_structural_intelligence_closure/migration.sql",
);
const QUEUE = readApi("src/services/dashboard/queue-telemetry.service.ts");
const WORKER = readApi("src/services/dashboard/worker-telemetry.service.ts");
const CASE_LINK = readApi("src/services/dashboard/case-evidence-link.service.ts");
const TIMELINE = readApi("src/services/dashboard/operational-timeline.service.ts");
const CASE_COMMENT = readApi("src/services/dashboard/case-comment.service.ts");
const INTEGRITY = readApi("src/services/dashboard/integrity-snapshot.service.ts");
const COMMAND_CENTER = readApi("src/services/dashboard/command-center.service.ts");

// =============================================================================
// PART 1 — Prisma schema additions
// =============================================================================

describe("Phase 32.8C+++++ — Prisma schema additions", () => {
  it("declares QueueTelemetrySnapshot model + 2 enums", () => {
    expect(SCHEMA).toMatch(/model\s+QueueTelemetrySnapshot\s*\{/);
    expect(SCHEMA).toMatch(/enum\s+QueueTelemetryDomain\s*\{/);
    expect(SCHEMA).toMatch(/enum\s+QueueTelemetrySource\s*\{/);
    expect(SCHEMA).toMatch(/@@map\("queue_telemetry_snapshots"\)/);
  });

  it("declares WorkerTelemetrySnapshot model + 2 enums", () => {
    expect(SCHEMA).toMatch(/model\s+WorkerTelemetrySnapshot\s*\{/);
    expect(SCHEMA).toMatch(/enum\s+WorkerTelemetryKind\s*\{/);
    expect(SCHEMA).toMatch(/enum\s+WorkerTelemetryStatus\s*\{/);
    expect(SCHEMA).toMatch(/@@map\("worker_telemetry_snapshots"\)/);
  });

  it("declares CaseEvidenceLink model + 2 enums with unique (caseId, evidenceId, role)", () => {
    expect(SCHEMA).toMatch(/model\s+CaseEvidenceLink\s*\{/);
    expect(SCHEMA).toMatch(/enum\s+CaseEvidenceLinkRole\s*\{/);
    expect(SCHEMA).toMatch(/enum\s+CaseEvidenceLinkSource\s*\{/);
    expect(SCHEMA).toMatch(/@@unique\(\[caseId,\s*evidenceId,\s*role\]\)/);
    expect(SCHEMA).toMatch(/@@map\("case_evidence_links"\)/);
  });

  it("declares OperationalTimelineEvent model + 2 enums with idempotency unique", () => {
    expect(SCHEMA).toMatch(/model\s+OperationalTimelineEvent\s*\{/);
    expect(SCHEMA).toMatch(/enum\s+OperationalTimelineFamily\s*\{/);
    expect(SCHEMA).toMatch(/enum\s+OperationalTimelineConfidence\s*\{/);
    expect(SCHEMA).toMatch(/operational_timeline_source_uniq/);
    expect(SCHEMA).toMatch(/@@map\("operational_timeline_events"\)/);
  });

  it("declares CaseComment model + visibility enum", () => {
    expect(SCHEMA).toMatch(/model\s+CaseComment\s*\{/);
    expect(SCHEMA).toMatch(/enum\s+CaseCommentVisibility\s*\{/);
    expect(SCHEMA).toMatch(/@@map\("case_comments"\)/);
  });

  it("EvidenceIntegritySnapshot gains TSA issuer parsing columns", () => {
    const block = SCHEMA.match(/model\s+EvidenceIntegritySnapshot\s*\{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    const txt = block![0];
    expect(txt).toMatch(/tsaIssuerCommonName\s+String\?\s+@map\("tsa_issuer_common_name"\)/);
    expect(txt).toMatch(/tsaIssuerOrganization\s+String\?\s+@map\("tsa_issuer_organization"\)/);
    expect(txt).toMatch(/tsaPolicyOid\s+String\?\s+@map\("tsa_policy_oid"\)/);
    expect(txt).toMatch(/tsaParseStatus\s+String\?\s+@map\("tsa_parse_status"\)/);
    expect(txt).toMatch(/tsaParseErrorCode\s+String\?\s+@map\("tsa_parse_error_code"\)/);
    expect(txt).toMatch(/tsaParsedAtUtc\s+DateTime\?\s+@map\("tsa_parsed_at_utc"\)/);
  });

  it("Team model declares queueTelemetrySnapshots back-relation", () => {
    const teamBlock = SCHEMA.match(/model\s+Team\s*\{[\s\S]*?\n\}/);
    expect(teamBlock).not.toBeNull();
    expect(teamBlock![0]).toMatch(/queueTelemetrySnapshots\s+QueueTelemetrySnapshot\[\]/);
  });

  it("CaseEvidenceLinkRole enum lists the bounded roles", () => {
    for (const v of [
      "PRIMARY",
      "SUPPORTING",
      "RELATED",
      "DUPLICATE",
      "DERIVED",
      "CONTEXT",
    ]) {
      expect(SCHEMA).toContain(v);
    }
  });

  it("QueueTelemetryDomain enum lists the bounded domains", () => {
    for (const v of [
      "REPORT",
      "PACKAGE",
      "REVIEW",
      "GOVERNANCE",
      "INTAKE",
      "WORKER",
      "OTHER",
    ]) {
      expect(SCHEMA).toContain(v);
    }
  });

  it("WorkerTelemetryStatus enum lists HEALTHY/DEGRADED/CRITICAL/UNKNOWN", () => {
    for (const v of ["HEALTHY", "DEGRADED", "CRITICAL", "UNKNOWN"]) {
      expect(SCHEMA).toContain(v);
    }
  });

  it("OperationalTimelineFamily enum lists the bounded families", () => {
    for (const v of [
      "EVIDENCE",
      "CASE",
      "CUSTODY",
      "REPORT",
      "PACKAGE",
      "REVIEW",
      "GOVERNANCE",
      "SECURITY",
      "OPS",
      "EXPORT",
      "SYSTEM",
    ]) {
      expect(SCHEMA).toContain(v);
    }
  });
});

// =============================================================================
// PART 2 — Migration file source-contract
// =============================================================================

describe("Phase 32.8C+++++ — migration file source-contract", () => {
  it("creates queue_telemetry_snapshots idempotently", () => {
    expect(MIGRATION).toMatch(
      /CREATE TABLE IF NOT EXISTS "queue_telemetry_snapshots"/,
    );
  });

  it("creates worker_telemetry_snapshots idempotently", () => {
    expect(MIGRATION).toMatch(
      /CREATE TABLE IF NOT EXISTS "worker_telemetry_snapshots"/,
    );
  });

  it("creates case_evidence_links idempotently with unique constraint", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS "case_evidence_links"/);
    expect(MIGRATION).toMatch(/case_evidence_links_case_id_evidence_id_role_key/);
  });

  it("creates operational_timeline_events idempotently with the idempotency unique", () => {
    expect(MIGRATION).toMatch(
      /CREATE TABLE IF NOT EXISTS "operational_timeline_events"/,
    );
    expect(MIGRATION).toMatch(/operational_timeline_source_uniq/);
  });

  it("creates case_comments idempotently", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS "case_comments"/);
  });

  it("creates all 9 new enums with IF NOT EXISTS guards", () => {
    for (const name of [
      "QueueTelemetryDomain",
      "QueueTelemetrySource",
      "WorkerTelemetryKind",
      "WorkerTelemetryStatus",
      "CaseEvidenceLinkRole",
      "CaseEvidenceLinkSource",
      "OperationalTimelineFamily",
      "OperationalTimelineConfidence",
      "CaseCommentVisibility",
    ]) {
      expect(MIGRATION).toMatch(
        new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_type WHERE typname = '${name}'\\)`),
      );
    }
  });

  it("ALTER TABLE on evidence_integrity_snapshots uses ADD COLUMN IF NOT EXISTS", () => {
    expect(MIGRATION).toMatch(
      /ALTER TABLE "evidence_integrity_snapshots"[\s\S]*?ADD COLUMN IF NOT EXISTS "tsa_issuer_common_name"/,
    );
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS "tsa_parse_status"/);
  });

  it("queue_telemetry_snapshots CASCADEs on team delete", () => {
    expect(MIGRATION).toMatch(
      /queue_telemetry_snapshots_team_id_fkey[\s\S]*?ON DELETE CASCADE/,
    );
  });

  it("documents that all five tables are ADVISORY operational data", () => {
    expect(MIGRATION).toMatch(/ADVISORY operational data/);
  });

  it("documents a rollback plan covering every addition", () => {
    expect(MIGRATION).toMatch(/Rollback \(operator-side, in psql\):/);
    expect(MIGRATION).toMatch(/DROP TABLE IF EXISTS "queue_telemetry_snapshots"/);
    expect(MIGRATION).toMatch(/DROP TABLE IF EXISTS "worker_telemetry_snapshots"/);
    expect(MIGRATION).toMatch(/DROP TABLE IF EXISTS "case_evidence_links"/);
    expect(MIGRATION).toMatch(/DROP TABLE IF EXISTS "operational_timeline_events"/);
    expect(MIGRATION).toMatch(/DROP TABLE IF EXISTS "case_comments"/);
  });

  it("never references signed URLs, storage keys, or raw bytes", () => {
    expect(MIGRATION).not.toMatch(/signed[_-]url/i);
    expect(MIGRATION).not.toMatch(/storage[_-]key/i);
    expect(MIGRATION).not.toMatch(/raw[_-]bytes/i);
  });

  it("creates dashboard read-pattern indexes for each new table", () => {
    expect(MIGRATION).toContain('"queue_telemetry_snapshots_queue_name_sampled_at_utc_idx"');
    expect(MIGRATION).toContain('"worker_telemetry_snapshots_worker_kind_heartbeat_at_utc_idx"');
    expect(MIGRATION).toContain('"case_evidence_links_team_id_linked_at_utc_idx"');
    expect(MIGRATION).toContain('"operational_timeline_events_team_id_occurred_at_utc_idx"');
    expect(MIGRATION).toContain('"case_comments_team_id_created_at_idx"');
  });
});

// =============================================================================
// PART 3 — Queue telemetry service
// =============================================================================

describe("Phase 32.8C+++++ — queue-telemetry.service.ts", () => {
  it("writer never throws (advisory data) and bounds queueName", () => {
    expect(QUEUE).toMatch(/Advisory write — never throws/);
    expect(QUEUE).toMatch(/queueName:\s*input\.sample\.queueName\.slice\(0,\s*80\)/);
  });

  it("DB-derived writer reads from existing bounded count queries only", () => {
    expect(QUEUE).toMatch(/prisma\.evidenceReviewWorkflow\.count/);
    expect(QUEUE).toMatch(/prisma\.evidence\.count/);
    expect(QUEUE).toMatch(/prisma\.destructionReview\.count/);
  });

  it("uses the correct DestructionReview status enum strings", () => {
    // Catalog: PENDING|UNDER_REVIEW|APPROVED|DENIED|DEFERRED|RESTORED|EXECUTED|CANCELLED
    expect(QUEUE).toMatch(/\["PENDING",\s*"UNDER_REVIEW",\s*"DEFERRED"\]/);
  });

  it("reader caps the bounded result and de-duplicates per queueName", () => {
    expect(QUEUE).toMatch(/Math\.min\(Math\.max\(input\.limit \?\? \d+,\s*1\),\s*50\)/);
    expect(QUEUE).toMatch(/seen\.add\(r\.queueName\)/);
  });

  it("never projects raw bytes / signed URLs / storage keys", () => {
    expect(QUEUE).not.toMatch(/storageKey/i);
    expect(QUEUE).not.toMatch(/signedUrl/i);
    expect(QUEUE).not.toMatch(/canonicalBytes/);
  });

  it("never emits security/audit/custody events", () => {
    expect(QUEUE).not.toMatch(/recordSecurityEvent\(/);
    expect(QUEUE).not.toMatch(/recordAuditEvent\(/);
    expect(QUEUE).not.toMatch(/recordCustodyEvent\(/);
  });
});

// =============================================================================
// PART 4 — Worker telemetry service
// =============================================================================

describe("Phase 32.8C+++++ — worker-telemetry.service.ts", () => {
  it("writer never throws and bounds workerId + lastErrorMessage", () => {
    expect(WORKER).toMatch(/Advisory write — never throws/);
    expect(WORKER).toMatch(/workerId:\s*sample\.workerId\.slice\(0,\s*120\)/);
    expect(WORKER).toMatch(/sample\.lastErrorMessage\.slice\(0,\s*400\)/);
  });

  it("reader returns one row per workerKind (latest heartbeat)", () => {
    expect(WORKER).toMatch(/seen\.add\(r\.workerKind\)/);
  });

  it("reader caps the bounded result set", () => {
    expect(WORKER).toMatch(/take:\s*200/);
  });

  it("never projects raw stack traces, secrets, or signed URLs", () => {
    expect(WORKER).toMatch(/No raw stack traces/);
    expect(WORKER).not.toMatch(/storageKey/i);
    expect(WORKER).not.toMatch(/signedUrl/i);
  });
});

// =============================================================================
// PART 5 — Case ↔ evidence link service
// =============================================================================

describe("Phase 32.8C+++++ — case-evidence-link.service.ts", () => {
  it("lazy backfill from Evidence.caseId is idempotent (findUnique then create)", () => {
    expect(CASE_LINK).toMatch(/prisma\.caseEvidenceLink\.findUnique/);
    expect(CASE_LINK).toMatch(/role:\s*"PRIMARY"/);
    expect(CASE_LINK).toMatch(/source:\s*"SYSTEM"/);
  });

  it("backfill is bounded (≤ 1000) and never throws", () => {
    expect(CASE_LINK).toMatch(/Math\.min\(Math\.max\(input\.limit \?\? 200,\s*1\),\s*1000\)/);
    expect(CASE_LINK).toMatch(/Outer read failure — return partial counts/);
  });

  it("cross-case readers detect evidence linked to multiple cases", () => {
    expect(CASE_LINK).toMatch(/listEvidenceLinkedToMultipleCases/);
    expect(CASE_LINK).toMatch(/having:\s*\{\s*caseId:\s*\{\s*_count:\s*\{\s*gt:\s*1/);
  });

  it("reader returns case clusters sharing evidence", () => {
    expect(CASE_LINK).toMatch(/listCaseSharedEvidenceClusters/);
  });

  it("never projects raw evidence contents", () => {
    expect(CASE_LINK).not.toMatch(/fileBytes/);
    expect(CASE_LINK).not.toMatch(/canonicalBytes/);
    expect(CASE_LINK).not.toMatch(/storageKey/i);
  });
});

// =============================================================================
// PART 6 — Operational timeline projection
// =============================================================================

describe("Phase 32.8C+++++ — operational-timeline.service.ts", () => {
  it("projection writer uses upsert keyed on the unique (sourceTable, sourceId, eventType)", () => {
    expect(TIMELINE).toMatch(/prisma\.operationalTimelineEvent\.upsert/);
    expect(TIMELINE).toMatch(/operational_timeline_source_uniq/);
  });

  it("projection sources are bounded (≤ INGEST_LIMIT_PER_SOURCE)", () => {
    expect(TIMELINE).toMatch(/INGEST_LIMIT_PER_SOURCE\s*=\s*200/);
  });

  it("projection ingests from real existing source tables only", () => {
    expect(TIMELINE).toMatch(/prisma\.custodyEvent\.findMany/);
    expect(TIMELINE).toMatch(/prisma\.evidenceLifecycleEvent\.findMany/);
    expect(TIMELINE).toMatch(/prisma\.operationalIncident\.findMany/);
  });

  it("reader filters to safe-to-display rows only", () => {
    expect(TIMELINE).toMatch(/safeToDisplay:\s*true/);
  });

  it("reader caps the bounded result set", () => {
    expect(TIMELINE).toMatch(/Math\.min\(Math\.max\(input\.limit \?\? 50,\s*1\),\s*200\)/);
  });

  it("summary is truncated to 400 chars before write", () => {
    expect(TIMELINE).toMatch(/input\.summary\.slice\(0,\s*400\)/);
  });

  it("never projects raw payloads / signed URLs / storage keys", () => {
    expect(TIMELINE).not.toMatch(/payload:\s*true/);
    expect(TIMELINE).not.toMatch(/storageKey/i);
    expect(TIMELINE).not.toMatch(/signedUrl/i);
  });
});

// =============================================================================
// PART 7 — Case comment backlog reader
// =============================================================================

describe("Phase 32.8C+++++ — case-comment.service.ts", () => {
  it("reader returns bounded open/resolved/stale-open counts only", () => {
    expect(CASE_COMMENT).toMatch(/openCount/);
    expect(CASE_COMMENT).toMatch(/resolvedCount/);
    expect(CASE_COMMENT).toMatch(/staleOpenCount/);
  });

  it("reader never returns raw body content", () => {
    expect(CASE_COMMENT).not.toMatch(/body:\s*true/);
    expect(CASE_COMMENT).not.toMatch(/select:\s*\{[^}]*body/);
  });

  it("reader degrades to zero counts on failure", () => {
    expect(CASE_COMMENT).toMatch(
      /catch\s*\{\s*return\s*\{\s*openCount:\s*0,\s*resolvedCount:\s*0,\s*staleOpenCount:\s*0\s*\};\s*\}/,
    );
  });
});

// =============================================================================
// PART 8 — TSA issuer derivation (no-op stub, UNAVAILABLE by default)
// =============================================================================

describe("Phase 32.8C+++++ — TSA issuer parsing safety", () => {
  it("exports deriveTsaIssuerProjection", () => {
    expect(INTEGRITY).toMatch(/export function deriveTsaIssuerProjection\(/);
  });

  it("derivation returns UNAVAILABLE when no token", () => {
    expect(INTEGRITY).toMatch(/tsaParseStatus:\s*"UNAVAILABLE"[\s\S]*?tsaParseErrorCode:\s*"TSA_TOKEN_ABSENT"/);
  });

  it("API derivation NEVER fabricates parsed issuer fields", () => {
    expect(INTEGRITY).toMatch(/API does not parse ASN\.1/);
    expect(INTEGRITY).toMatch(/PARSER_NOT_AVAILABLE_IN_API/);
    // tsaIssuerCommonName / Organization / PolicyOid are never set to a
    // non-null literal in this file.
    expect(INTEGRITY).not.toMatch(/tsaIssuerCommonName:\s*"[A-Z]/);
    expect(INTEGRITY).not.toMatch(/tsaIssuerOrganization:\s*"[A-Z]/);
  });

  it("snapshot writer wires the derivation fields into upsert create + update", () => {
    expect(INTEGRITY).toMatch(/tsaIssuerCommonName:\s*issuer\.tsaIssuerCommonName/);
    expect(INTEGRITY).toMatch(/tsaParseStatus:\s*issuer\.tsaParseStatus/);
  });
});

// =============================================================================
// PART 9 — Dashboard wiring (unsupportedSignals shrink; sources updated)
// =============================================================================

describe("Phase 32.8C+++++ — dashboard wiring", () => {
  it("imports the 5 new services", () => {
    expect(COMMAND_CENTER).toMatch(
      /from\s*"\.\/queue-telemetry\.service\.js"/,
    );
    expect(COMMAND_CENTER).toMatch(
      /from\s*"\.\/worker-telemetry\.service\.js"/,
    );
    expect(COMMAND_CENTER).toMatch(
      /from\s*"\.\/case-evidence-link\.service\.js"/,
    );
    expect(COMMAND_CENTER).toMatch(
      /from\s*"\.\/operational-timeline\.service\.js"/,
    );
    expect(COMMAND_CENTER).toMatch(/from\s*"\.\/case-comment\.service\.js"/);
  });

  it("queue/worker telemetry section advertises new tables in sourceSummary", () => {
    expect(COMMAND_CENTER).toMatch(
      /QueueTelemetrySnapshot[^"\n]*Phase 32\.8C\+\+\+\+\+/,
    );
    expect(COMMAND_CENTER).toMatch(
      /WorkerTelemetrySnapshot[^"\n]*Phase 32\.8C\+\+\+\+\+/,
    );
  });

  it("queue/worker telemetry section no longer declares 'no DB-persisted queue snapshot' as unsupported", () => {
    expect(COMMAND_CENTER).not.toMatch(/no DB-persisted queue snapshot/);
    expect(COMMAND_CENTER).not.toMatch(/worker_process_heartbeat[^"\n]*not persisted/);
  });

  it("cross-case intelligence section no longer declares 'evidence.caseId singular' as unsupported", () => {
    expect(COMMAND_CENTER).not.toMatch(/evidence\.caseId singular/);
    expect(COMMAND_CENTER).not.toMatch(/Evidence has a singular caseId column/);
  });

  it("cross-case section advertises CaseEvidenceLink in sourceSummary", () => {
    expect(COMMAND_CENTER).toMatch(
      /CaseEvidenceLink[^"\n]*Phase 32\.8C\+\+\+\+\+/,
    );
  });

  it("coordination signals section no longer declares 'no Case-level comment table' as unsupported", () => {
    expect(COMMAND_CENTER).not.toMatch(/no Case-level comment table/);
  });

  it("coordination signals section no longer declares 'no resolved/unresolved column' as unsupported", () => {
    expect(COMMAND_CENTER).not.toMatch(
      /no resolved\/unresolved column on EvidenceAnnotation/,
    );
  });

  it("coordination signals section advertises CaseComment + resolvedAtUtc sources", () => {
    expect(COMMAND_CENTER).toMatch(
      /CaseComment[^"\n]*Phase 32\.8C\+\+\+\+\+/,
    );
    expect(COMMAND_CENTER).toMatch(
      /EvidenceReviewerComment\(resolvedAtUtc IS NULL — Phase 32\.8C\+\+\+\+\)/,
    );
  });

  it("reconstructed timeline advertises OperationalTimelineEvent", () => {
    expect(COMMAND_CENTER).toMatch(
      /OperationalTimelineEvent[^"\n]*Phase 32\.8C\+\+\+\+\+/,
    );
  });

  it("deep integrity unsupported signal is reframed (worker parser not yet deployed) — not the schema gap", () => {
    expect(COMMAND_CENTER).toMatch(/worker-side ASN\.1 TSA parser not yet deployed/);
    expect(COMMAND_CENTER).not.toMatch(
      /Evidence has tsaTokenBase64 \+ tsaGenTimeUtc but no tsaIssuer column/,
    );
  });

  it("QueueWorkerTelemetry contract gains queueSnapshots + workerHeartbeats", () => {
    expect(COMMAND_CENTER).toMatch(/queueSnapshots:\s*Array<\{/);
    expect(COMMAND_CENTER).toMatch(/workerHeartbeats:\s*Array<\{/);
  });

  it("coordination section returns the new backlog field", () => {
    expect(COMMAND_CENTER).toMatch(/type\s+CoordinationBacklog\s*=\s*\{/);
    expect(COMMAND_CENTER).toMatch(/caseCommentOpenCount:\s*number/);
  });
});

// =============================================================================
// PART 10 — No-regression invariants
// =============================================================================

describe("Phase 32.8C+++++ — no-regression invariants", () => {
  it("no new service emits security/audit/custody events", () => {
    for (const src of [QUEUE, WORKER, CASE_LINK, TIMELINE, CASE_COMMENT]) {
      expect(src).not.toMatch(/recordSecurityEvent\(/);
      expect(src).not.toMatch(/recordAuditEvent\(/);
      expect(src).not.toMatch(/recordCustodyEvent\(/);
    }
  });

  it("no new service generates signed URLs or report/package output", () => {
    for (const src of [QUEUE, WORKER, CASE_LINK, TIMELINE, CASE_COMMENT]) {
      expect(src).not.toMatch(/getSignedUrl/i);
      expect(src).not.toMatch(/generateReport/i);
      expect(src).not.toMatch(/generatePackage/i);
    }
  });

  it("no new service contains legal-overclaim language (word-boundary matched)", () => {
    for (const src of [QUEUE, WORKER, CASE_LINK, TIMELINE, CASE_COMMENT]) {
      for (const banned of [
        "admissible",
        "authentic",
        "proves",
        "court-ready",
        "fraud",
      ]) {
        expect(src).not.toMatch(new RegExp(`\\b${banned}\\b`, "i"));
      }
    }
  });

  it("schema additions on existing tables (TSA issuer columns) are nullable", () => {
    const block = SCHEMA.match(/model\s+EvidenceIntegritySnapshot\s*\{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    // Every new TSA column on the existing table must be optional (nullable),
    // so the migration applies without backfill.
    for (const field of [
      "tsaIssuerCommonName",
      "tsaIssuerOrganization",
      "tsaPolicyOid",
      "tsaParseStatus",
      "tsaParseErrorCode",
      "tsaParsedAtUtc",
    ]) {
      expect(block![0]).toMatch(new RegExp(`${field}\\s+(String|DateTime)\\?`));
    }
  });
});
