/**
 * Phase 32.8C++++ — Dashboard Intelligence Closure.
 *
 * Source-contract regression suite. Locks in the schema additions,
 * migration, advisory writers, and dashboard wiring established in
 * Phase 32.8C++++:
 *
 *  PART 1 — Prisma schema additions
 *           - EvidenceIntegritySnapshot model (1:1 with Evidence)
 *           - AccessAnomaly model + 3 enums
 *           - resolved_at_utc / resolved_by_user_id on
 *             EvidenceAnnotation + EvidenceReviewerComment
 *           - Evidence + Team back-relations wired
 *
 *  PART 2 — Migration file source-contract
 *           - Idempotent additive guards
 *           - Cascade rules correct (CASCADE / SET NULL)
 *           - Rollback plan present in header
 *
 *  PART 3 — integrity-snapshot.service.ts contract
 *           - Pure derivation function exported
 *           - Writer is idempotent (upsert)
 *           - Writer/reader only project bounded fields
 *           - Backfill never throws
 *           - No raw file bytes / signed URLs / secrets
 *           - Operator-safe language (no legal claims)
 *
 *  PART 4 — access-anomaly.service.ts contract
 *           - Rule-based classifier exported (no ML)
 *           - Classifier is read-only on SecurityEvent
 *           - Bounded query (take cap)
 *           - Bounded enum-driven category set
 *           - Operator-safe summary, no raw payloads
 *           - No legal overclaiming
 *
 *  PART 5 — Dashboard wiring
 *           - runDeepIntegrityWatch prefers persisted snapshot
 *           - runDeepIntegrityWatch lazy-backfills on empty
 *           - runAccessSecurityClassifier prefers persisted anomalies
 *           - runAccessSecurityClassifier lazy-classifies on empty
 *           - sourceSummary updated to advertise new advisory tables
 *
 *  PART 6 — No-regression invariants
 *           - No fake data / hardcoded metrics
 *           - No page-load side effects (no report/package/signed-url
 *             generation; only advisory snapshot writes wrapped in
 *             try/catch)
 *           - No exposed secrets / storage keys / signed URLs
 *           - Writer failures never block evidence / report /
 *             package / verify flows (try/catch wrapping)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readApi(rel) {
    return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
const SCHEMA = readApi("prisma/schema.prisma");
const MIGRATION = readApi("prisma/migrations/20260625100000_phase328cpppp_dashboard_intelligence_closure/migration.sql");
const INTEGRITY = readApi("src/services/dashboard/integrity-snapshot.service.ts");
const ANOMALY = readApi("src/services/dashboard/access-anomaly.service.ts");
const COMMAND_CENTER = readApi("src/services/dashboard/command-center.service.ts");
// =============================================================================
// PART 1 — Prisma schema additions
// =============================================================================
describe("Phase 32.8C++++ — Prisma schema additions", () => {
    it("declares EvidenceIntegritySnapshot model with unique evidenceId", () => {
        expect(SCHEMA).toMatch(/model\s+EvidenceIntegritySnapshot\s*\{/);
        expect(SCHEMA).toMatch(/evidenceId\s+String\s+@unique/);
    });
    it("EvidenceIntegritySnapshot maps to evidence_integrity_snapshots table", () => {
        expect(SCHEMA).toMatch(/@@map\("evidence_integrity_snapshots"\)/);
    });
    it("EvidenceIntegritySnapshot includes the bounded boolean tri-state columns", () => {
        for (const field of [
            "canonicalHashMatches",
            "signatureValid",
            "custodyChainValid",
            "timestampDigestMatches",
            "otsHashMatches",
        ]) {
            expect(SCHEMA).toMatch(new RegExp(`${field}\\s+Boolean\\?`));
        }
    });
    it("EvidenceIntegritySnapshot bounds string status columns to VarChar(24)", () => {
        expect(SCHEMA).toMatch(/tsaStatus\s+String\?\s+@map\("tsa_status"\)\s+@db\.VarChar\(24\)/);
        expect(SCHEMA).toMatch(/otsStatus\s+String\?\s+@map\("ots_status"\)\s+@db\.VarChar\(24\)/);
        expect(SCHEMA).toMatch(/overallStatus\s+String\?\s+@map\("overall_status"\)\s+@db\.VarChar\(24\)/);
    });
    it("EvidenceIntegritySnapshot stores reasonCodes as Json", () => {
        expect(SCHEMA).toMatch(/reasonCodes\s+Json\?/);
    });
    it("declares AccessAnomaly model with 3 enums", () => {
        expect(SCHEMA).toMatch(/model\s+AccessAnomaly\s*\{/);
        expect(SCHEMA).toMatch(/enum\s+AccessAnomalyCategory\s*\{/);
        expect(SCHEMA).toMatch(/enum\s+AccessAnomalySeverity\s*\{/);
        expect(SCHEMA).toMatch(/enum\s+AccessAnomalyStatus\s*\{/);
    });
    it("AccessAnomaly maps to access_anomalies table", () => {
        expect(SCHEMA).toMatch(/@@map\("access_anomalies"\)/);
    });
    it("AccessAnomalyCategory enum lists the bounded classifier categories", () => {
        for (const v of [
            "REPEATED_FAILED_ACCESS",
            "BLOCKED_EXPORT_ATTEMPT",
            "API_CREDENTIAL_CHANGE",
            "WEBHOOK_FAILURE_SPIKE",
            "ADMIN_ROLE_CHANGE",
            "STEP_UP_FAILED",
            "PERMISSION_DENIED_BURST",
            "UNCATEGORIZED",
        ]) {
            expect(SCHEMA).toContain(v);
        }
    });
    it("AccessAnomalyStatus enum lists OPEN/ACKNOWLEDGED/RESOLVED/SUPPRESSED", () => {
        for (const v of ["OPEN", "ACKNOWLEDGED", "RESOLVED", "SUPPRESSED"]) {
            expect(SCHEMA).toContain(v);
        }
    });
    it("AccessAnomaly bounds sampleEventType to VarChar(80) and summary to VarChar(400)", () => {
        expect(SCHEMA).toMatch(/sampleEventType\s+String\s+@map\("sample_event_type"\)\s+@db\.VarChar\(80\)/);
        // `summary` Prisma field name matches the column name, so no @map needed.
        expect(SCHEMA).toMatch(/summary\s+String\?\s+@db\.VarChar\(400\)/);
    });
    it("EvidenceReviewerComment + EvidenceAnnotation got resolved_at_utc / resolved_by_user_id", () => {
        const reviewer = SCHEMA.match(/model\s+EvidenceReviewerComment\s*\{[\s\S]*?\n\}/);
        const annotation = SCHEMA.match(/model\s+EvidenceAnnotation\s*\{[\s\S]*?\n\}/);
        expect(reviewer).not.toBeNull();
        expect(annotation).not.toBeNull();
        for (const block of [reviewer[0], annotation[0]]) {
            expect(block).toMatch(/resolvedAtUtc\s+DateTime\?\s+@map\("resolved_at_utc"\)/);
            expect(block).toMatch(/resolvedByUserId\s+String\?\s+@map\("resolved_by_user_id"\)/);
        }
    });
    it("Evidence model declares back-relations for new advisory tables", () => {
        const evidenceBlock = SCHEMA.match(/model\s+Evidence\s*\{[\s\S]*?\n\}/);
        expect(evidenceBlock).not.toBeNull();
        expect(evidenceBlock[0]).toMatch(/integritySnapshot\s+EvidenceIntegritySnapshot\?/);
        expect(evidenceBlock[0]).toMatch(/accessAnomalies\s+AccessAnomaly\[\]/);
    });
    it("Team model declares accessAnomalies back-relation", () => {
        const teamBlock = SCHEMA.match(/model\s+Team\s*\{[\s\S]*?\n\}/);
        expect(teamBlock).not.toBeNull();
        expect(teamBlock[0]).toMatch(/accessAnomalies\s+AccessAnomaly\[\]/);
    });
});
// =============================================================================
// PART 2 — Migration file source-contract
// =============================================================================
describe("Phase 32.8C++++ — migration file source-contract", () => {
    it("migration file exists and creates evidence_integrity_snapshots idempotently", () => {
        expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS "evidence_integrity_snapshots"/);
    });
    it("creates access_anomalies idempotently", () => {
        expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS "access_anomalies"/);
    });
    it("creates AccessAnomaly enums with IF NOT EXISTS guards", () => {
        expect(MIGRATION).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'AccessAnomalyCategory'\)/);
        expect(MIGRATION).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'AccessAnomalySeverity'\)/);
        expect(MIGRATION).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'AccessAnomalyStatus'\)/);
    });
    it("ALTER TABLE statements use ADD COLUMN IF NOT EXISTS (additive, idempotent)", () => {
        expect(MIGRATION).toMatch(/ALTER TABLE "evidence_reviewer_comments"[\s\S]*?ADD COLUMN IF NOT EXISTS "resolved_at_utc"/);
        expect(MIGRATION).toMatch(/ALTER TABLE "evidence_annotations"[\s\S]*?ADD COLUMN IF NOT EXISTS "resolved_at_utc"/);
    });
    it("integrity snapshot CASCADEs on evidence delete (1:1 mirror)", () => {
        expect(MIGRATION).toMatch(/evidence_integrity_snapshots_evidence_id_fkey[\s\S]*?ON DELETE CASCADE/);
    });
    it("access_anomaly CASCADEs on team delete and SET NULLs on evidence delete (history survives)", () => {
        expect(MIGRATION).toMatch(/access_anomalies_team_id_fkey[\s\S]*?ON DELETE CASCADE/);
        expect(MIGRATION).toMatch(/access_anomalies_evidence_id_fkey[\s\S]*?ON DELETE SET NULL/);
    });
    it("creates indexes for dashboard read patterns (workspace + status / severity / category)", () => {
        expect(MIGRATION).toContain('"evidence_integrity_snapshots_team_id_overall_status_idx"');
        expect(MIGRATION).toContain('"access_anomalies_team_id_status_idx"');
        expect(MIGRATION).toContain('"access_anomalies_team_id_category_idx"');
        expect(MIGRATION).toContain('"access_anomalies_severity_idx"');
    });
    it("documents a rollback plan in the header comments", () => {
        expect(MIGRATION).toMatch(/Rollback \(operator-side, in psql\):/);
        expect(MIGRATION).toMatch(/DROP TABLE IF EXISTS "evidence_integrity_snapshots"/);
        expect(MIGRATION).toMatch(/DROP TABLE IF EXISTS "access_anomalies"/);
    });
    it("documents that the data is ADVISORY and empty on first deploy", () => {
        expect(MIGRATION).toMatch(/ADVISORY operational data/);
    });
    it("never references signed URLs, storage keys, or raw bytes", () => {
        expect(MIGRATION).not.toMatch(/signed[_-]url/i);
        expect(MIGRATION).not.toMatch(/storage[_-]key/i);
        expect(MIGRATION).not.toMatch(/raw[_-]bytes/i);
    });
});
// =============================================================================
// PART 3 — integrity-snapshot.service.ts contract
// =============================================================================
describe("Phase 32.8C++++ — integrity-snapshot.service.ts contract", () => {
    it("exports a PURE derivation function used by both writer and live-fallback", () => {
        expect(INTEGRITY).toMatch(/export function deriveIntegritySnapshot\(/);
    });
    it("writer is idempotent on evidenceId (upsert)", () => {
        expect(INTEGRITY).toMatch(/prisma\.evidenceIntegritySnapshot\.upsert\(/);
        expect(INTEGRITY).toMatch(/where:\s*\{\s*evidenceId:/);
    });
    it("reader filters to actionable statuses only", () => {
        expect(INTEGRITY).toMatch(/overallStatus:\s*\{\s*in:\s*\[\s*"REVIEW_REQUIRED",\s*"FAILED"\s*\]/);
    });
    it("reader projects bounded fields only (no raw bytes, no signed URLs)", () => {
        expect(INTEGRITY).not.toMatch(/fileBytes/);
        expect(INTEGRITY).not.toMatch(/signedUrl/i);
        expect(INTEGRITY).not.toMatch(/storageKey/i);
        expect(INTEGRITY).not.toMatch(/canonicalBytes/);
    });
    it("backfill is bounded and never throws", () => {
        expect(INTEGRITY).toMatch(/export async function backfillIntegritySnapshots/);
        expect(INTEGRITY).toMatch(/Math\.min\(Math\.max\(input\.limit,\s*1\),\s*200\)/);
        expect(INTEGRITY).toMatch(/Never throws/);
    });
    it("uses a bounded source-version label (so derivation rules can be re-run safely)", () => {
        expect(INTEGRITY).toMatch(/INTEGRITY_SOURCE_VERSION\s*=\s*"v\d/);
    });
    it("does not use legal-overclaim language", () => {
        // Word-boundary matched so substrings like "authentication" / "truthful"
        // inside operator-facing copy do not false-positive.
        for (const banned of [
            "admissible",
            "authentic",
            "proves",
            "court-ready",
            "truth",
            "fraud",
        ]) {
            expect(INTEGRITY).not.toMatch(new RegExp(`\\b${banned}\\b`, "i"));
        }
    });
    it("does not write to SecurityEvent / AdminAuditLog / CustodyEvent", () => {
        expect(INTEGRITY).not.toMatch(/securityEvent\.create/);
        expect(INTEGRITY).not.toMatch(/adminAuditLog\.create/);
        expect(INTEGRITY).not.toMatch(/custodyEvent\.create/);
    });
    it("documents that writer failures must NEVER block core flows", () => {
        expect(INTEGRITY).toMatch(/Writer failures NEVER block|ADVISORY/);
    });
});
// =============================================================================
// PART 4 — access-anomaly.service.ts contract
// =============================================================================
describe("Phase 32.8C++++ — access-anomaly.service.ts contract", () => {
    it("exports a rule-based classifier (no ML)", () => {
        expect(ANOMALY).toMatch(/export function classifyEventType\(/);
        expect(ANOMALY).toMatch(/Rule-based classifier on eventType strings — no ML/);
    });
    it("classifier is read-only on SecurityEvent (only reads, never writes)", () => {
        expect(ANOMALY).toMatch(/prisma\.securityEvent\.findMany\(/);
        expect(ANOMALY).not.toMatch(/prisma\.securityEvent\.(create|update|delete|upsert)/);
    });
    it("classifier query is bounded (take cap + windowed)", () => {
        expect(ANOMALY).toMatch(/take:\s*1000/);
        expect(ANOMALY).toMatch(/CLASSIFIER_WINDOW_HOURS\s*=\s*\d+/);
    });
    it("writes the bounded AccessAnomaly enum categories only", () => {
        for (const v of [
            "REPEATED_FAILED_ACCESS",
            "BLOCKED_EXPORT_ATTEMPT",
            "API_CREDENTIAL_CHANGE",
            "WEBHOOK_FAILURE_SPIKE",
            "ADMIN_ROLE_CHANGE",
            "STEP_UP_FAILED",
            "PERMISSION_DENIED_BURST",
            "UNCATEGORIZED",
        ]) {
            expect(ANOMALY).toContain(v);
        }
    });
    it("does not project raw event payloads (only sourceEventIds)", () => {
        expect(ANOMALY).toMatch(/No raw event payloads are projected/);
        expect(ANOMALY).not.toMatch(/payload:\s*true/);
        expect(ANOMALY).not.toMatch(/metadata:\s*true/);
    });
    it("operator-safe summary is bounded ≤ 400 chars", () => {
        expect(ANOMALY).toMatch(/Bounded operator-safe summary string \(≤ 400 chars\)/);
    });
    it("does not use legal-overclaim language", () => {
        // Word-boundary matched so substrings like "authentication" inside
        // operator-facing copy do not false-positive.
        for (const banned of [
            "admissible",
            "authentic",
            "proves",
            "court-ready",
            "fraud",
        ]) {
            expect(ANOMALY).not.toMatch(new RegExp(`\\b${banned}\\b`, "i"));
        }
    });
    it("reader filters to actionable statuses (OPEN / ACKNOWLEDGED)", () => {
        expect(ANOMALY).toMatch(/status:\s*\{\s*in:\s*\[\s*"OPEN",\s*"ACKNOWLEDGED"\s*\]/);
    });
    it("classifier upsert is idempotent on (teamId, category, actorUserId, sampleEventType, window)", () => {
        expect(ANOMALY).toMatch(/prisma\.accessAnomaly\.findFirst/);
        expect(ANOMALY).toMatch(/prisma\.accessAnomaly\.(update|create)/);
    });
    it("documents classifier failures NEVER block evidence/report/package flows", () => {
        expect(ANOMALY).toMatch(/Classifier failures NEVER block/);
    });
});
// =============================================================================
// PART 5 — Dashboard wiring (command-center.service.ts)
// =============================================================================
describe("Phase 32.8C++++ — dashboard wiring", () => {
    it("imports the integrity snapshot reader + backfill", () => {
        expect(COMMAND_CENTER).toMatch(/import\s*\{[^}]*backfillIntegritySnapshots[^}]*\}\s*from\s*"\.\/integrity-snapshot\.service\.js"/);
        expect(COMMAND_CENTER).toMatch(/import\s*\{[^}]*listWorkspaceIntegritySnapshots[^}]*\}\s*from\s*"\.\/integrity-snapshot\.service\.js"/);
    });
    it("imports the access anomaly reader + classifier", () => {
        expect(COMMAND_CENTER).toMatch(/import\s*\{[^}]*listWorkspaceAccessAnomalies[^}]*\}\s*from\s*"\.\/access-anomaly\.service\.js"/);
        expect(COMMAND_CENTER).toMatch(/import\s*\{[^}]*runClassifierForWorkspace[^}]*\}\s*from\s*"\.\/access-anomaly\.service\.js"/);
    });
    it("runDeepIntegrityWatch sourceSummary advertises EvidenceIntegritySnapshot", () => {
        expect(COMMAND_CENTER).toMatch(/EvidenceIntegritySnapshot[^"\n]*Phase 32\.8C\+\+\+\+/);
    });
    it("runAccessSecurityClassifier sourceSummary advertises AccessAnomaly", () => {
        expect(COMMAND_CENTER).toMatch(/AccessAnomaly[^"\n]*Phase 32\.8C\+\+\+\+/);
    });
    it("dedicated integrity columns are now CLOSED by the snapshot table", () => {
        expect(COMMAND_CENTER).not.toContain("canonical_hash_recompute");
        expect(COMMAND_CENTER).not.toContain("signature_valid_per_record");
        expect(COMMAND_CENTER).not.toContain("custody_chain_valid_per_record");
    });
    it("TSA issuer schema gap is CLOSED in Phase 32.8C+++++; only the worker-side ASN.1 parser deployment remains pending", () => {
        // Phase 32.8C++++ left `tsa_issuer_field` as the only outstanding
        // integrity unsupportedSignal. Phase 32.8C+++++ closes that gap by
        // adding the columns + a no-op API stub. The remaining gap is the
        // worker-side parser, which is reframed accordingly.
        expect(COMMAND_CENTER).toMatch(/worker-side ASN\.1 TSA parser not yet deployed/);
    });
});
// =============================================================================
// PART 6 — No-regression invariants
// =============================================================================
describe("Phase 32.8C++++ — no-regression invariants", () => {
    it("new services never emit security/audit/custody events on dashboard read paths", () => {
        for (const src of [INTEGRITY, ANOMALY]) {
            expect(src).not.toMatch(/recordSecurityEvent\(/);
            expect(src).not.toMatch(/recordAuditEvent\(/);
            expect(src).not.toMatch(/recordCustodyEvent\(/);
        }
    });
    it("new services never generate signed URLs or report/package output", () => {
        for (const src of [INTEGRITY, ANOMALY]) {
            expect(src).not.toMatch(/getSignedUrl/i);
            expect(src).not.toMatch(/generateReport/i);
            expect(src).not.toMatch(/generatePackage/i);
        }
    });
    it("new services never log or project file bytes or storage keys", () => {
        for (const src of [INTEGRITY, ANOMALY]) {
            expect(src).not.toMatch(/storageKey/i);
            expect(src).not.toMatch(/canonicalBytes/);
            expect(src).not.toMatch(/fileBytes/);
        }
    });
    it("schema additions are nullable / default-bearing (no required-without-default fields on new columns of existing tables)", () => {
        // resolved_at_utc / resolved_by_user_id added to existing tables must
        // be optional so the migration applies without backfill.
        expect(SCHEMA).toMatch(/resolvedAtUtc\s+DateTime\?\s+@map\("resolved_at_utc"\)/);
        expect(SCHEMA).toMatch(/resolvedByUserId\s+String\?\s+@map\("resolved_by_user_id"\)/);
    });
});
