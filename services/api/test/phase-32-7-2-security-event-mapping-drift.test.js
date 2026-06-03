/**
 * Phase 32.7.2 — SecurityEvent Prisma mapping drift repair
 * regression tests (source-contract).
 *
 * Production inspection confirmed the `security_events` table uses
 * CAMELCASE column names (id, teamId, userId, eventType, severity,
 * ipAddressHash, userAgent, requestId, metadataJson, createdAtUtc).
 *
 * The previous Prisma model expected SNAKE_CASE columns via
 * `@map("team_id")` / `@map("event_type")` / `@map("created_at")`,
 * causing P2022 on every query and INSERT. This cascaded into:
 *   - readiness `checkWorkers` UNKNOWN (telemetry_query_failed)
 *   - worker reconcile heartbeat writes silently failing
 *   - governance routes 503 (when any handler emitted a security
 *     event that failed)
 *
 * This phase realigns the Prisma model to the actual production
 * schema. NO DB migration. NO column rename. NO data movement.
 * Only Prisma `@map(...)` annotations + a writer-side fold of the
 * removed FK fields into the bounded `metadataJson` blob.
 *
 * Invariants this test enforces:
 *   1. SecurityEvent fields map to camelCase production columns.
 *   2. `details` field is aliased to production column `metadataJson`.
 *   3. `createdAt` field is aliased to production column `createdAtUtc`.
 *   4. Production-only fields (userId, ipAddressHash, userAgent,
 *      requestId) are declared on the model.
 *   5. Removed fields (evidenceId / apiCredentialId / webhookEndpointId)
 *      do NOT appear on the model.
 *   6. Writer `emitSecurityEvent` folds the removed FK fields into
 *      the metadataJson blob (preserves caller-facing input shape).
 *   7. Projector `projectSecurityEvent` round-trips the removed FK
 *      fields from the metadataJson blob (preserves projection shape).
 *   8. EvidenceLegalHold, CaseLegalHold, WorkspaceGovernancePolicy
 *      models remain SNAKE_CASE-mapped (no regression).
 *   9. ReviewEscalation model retains Phase 32.6.2 @map annotations
 *      (no regression).
 *  10. No SQL migration was added (the repair is Prisma-only).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readSchema() {
    return readFileSync(fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)), "utf8");
}
function readApi(rel) {
    return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
function extractModelBlock(schema, modelName) {
    const re = new RegExp(`model\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`, "m");
    const match = schema.match(re);
    expect(match, `model ${modelName} must exist in schema.prisma`).toBeTruthy();
    return match[1];
}
const SCHEMA = readSchema();
const SECURITY_EVENT = extractModelBlock(SCHEMA, "SecurityEvent");
const EVIDENCE_LEGAL_HOLD = extractModelBlock(SCHEMA, "EvidenceLegalHold");
const CASE_LEGAL_HOLD = extractModelBlock(SCHEMA, "CaseLegalHold");
const WORKSPACE_GOVERNANCE_POLICY = extractModelBlock(SCHEMA, "WorkspaceGovernancePolicy");
const REVIEW_ESCALATION = extractModelBlock(SCHEMA, "ReviewEscalation");
// =============================================================================
// Part 1 — SecurityEvent: camelCase production schema alignment
// =============================================================================
describe("Phase 32.7.2 — SecurityEvent maps to camelCase production columns", () => {
    it("primary fields map to camelCase columns (teamId, userId, eventType)", () => {
        expect(SECURITY_EVENT).toMatch(/teamId\s+String\?\s+@map\("teamId"\)/);
        expect(SECURITY_EVENT).toMatch(/userId\s+String\?\s+@map\("userId"\)/);
        expect(SECURITY_EVENT).toMatch(/eventType\s+String\s+@map\("eventType"\)/);
    });
    it("legacy snake_case mappings are gone (no team_id / event_type / created_at)", () => {
        expect(SECURITY_EVENT).not.toMatch(/@map\("team_id"\)/);
        expect(SECURITY_EVENT).not.toMatch(/@map\("event_type"\)/);
        expect(SECURITY_EVENT).not.toMatch(/@map\("created_at"\)/);
    });
    it("`details` Prisma field aliases to production column `metadataJson`", () => {
        expect(SECURITY_EVENT).toMatch(/details\s+Json\?\s+@map\("metadataJson"\)/);
    });
    it("`createdAt` Prisma field aliases to production column `createdAtUtc`", () => {
        expect(SECURITY_EVENT).toMatch(/createdAt\s+DateTime[\s\S]{0,80}@map\("createdAtUtc"\)/);
    });
    it("production-only fields declared on the model", () => {
        expect(SECURITY_EVENT).toMatch(/ipAddressHash\s+String\?\s+@map\("ipAddressHash"\)/);
        expect(SECURITY_EVENT).toMatch(/userAgent\s+String\?\s+@map\("userAgent"\)/);
        expect(SECURITY_EVENT).toMatch(/requestId\s+String\?\s+@map\("requestId"\)/);
    });
    it("evidenceId / apiCredentialId / webhookEndpointId are removed from the model", () => {
        expect(SECURITY_EVENT).not.toMatch(/^\s*evidenceId\s+String/m);
        expect(SECURITY_EVENT).not.toMatch(/^\s*apiCredentialId\s+String/m);
        expect(SECURITY_EVENT).not.toMatch(/^\s*webhookEndpointId\s+String/m);
    });
    it("table mapping stays `security_events` (no table rename)", () => {
        expect(SECURITY_EVENT).toMatch(/@@map\("security_events"\)/);
    });
});
// =============================================================================
// Part 2 — Writer folds removed FK fields into metadataJson
// =============================================================================
describe("Phase 32.7.2 — emitSecurityEvent folds removed FKs into metadataJson", () => {
    const SRC = readApi("src/services/security/security-event.service.ts");
    it("EmitSecurityEventInput preserves the legacy field shape (caller compat)", () => {
        expect(SRC).toMatch(/evidenceId\?:\s*string\s*\|\s*null/);
        expect(SRC).toMatch(/apiCredentialId\?:\s*string\s*\|\s*null/);
        expect(SRC).toMatch(/webhookEndpointId\?:\s*string\s*\|\s*null/);
    });
    it("the prisma `securityEvent.create({ data })` no longer references the removed columns", () => {
        const createIdx = SRC.indexOf("client.securityEvent.create");
        expect(createIdx).toBeGreaterThan(-1);
        const createBlock = SRC.slice(createIdx, createIdx + 1500);
        expect(createBlock).not.toMatch(/evidenceId:\s*input\.evidenceId/);
        expect(createBlock).not.toMatch(/apiCredentialId:\s*input\.apiCredentialId/);
        expect(createBlock).not.toMatch(/webhookEndpointId:\s*input\.webhookEndpointId/);
    });
    it("relation IDs are folded into a bounded `relationContext` object", () => {
        expect(SRC).toMatch(/relationContext:\s*Record<string,\s*unknown>/);
        expect(SRC).toMatch(/relationContext\.evidenceId\s*=\s*input\.evidenceId/);
        expect(SRC).toMatch(/relationContext\.apiCredentialId\s*=\s*input\.apiCredentialId/);
        expect(SRC).toMatch(/relationContext\.webhookEndpointId\s*=\s*input\.webhookEndpointId/);
    });
    it("consolidated `details` is passed to securityEvent.create", () => {
        expect(SRC).toMatch(/consolidatedDetails/);
        expect(SRC).toMatch(/details:\s*consolidatedDetails\s*\?\?\s*undefined/);
    });
    it("the existing safeDetails bounded redaction still gates the write", () => {
        expect(SRC).toMatch(/safeDetails\(input\.details\s*\?\?\s*null\)/);
    });
});
// =============================================================================
// Part 3 — Projector round-trips the FK fields from metadataJson
// =============================================================================
describe("Phase 32.7.2 — projectSecurityEvent round-trips FK fields from JSON", () => {
    const SRC = readApi("src/services/security/security-event.service.ts");
    const fnIdx = SRC.indexOf("export function projectSecurityEvent");
    expect(fnIdx).toBeGreaterThan(-1);
    const fn = SRC.slice(fnIdx, fnIdx + 2000);
    it("public projection shape still exposes evidenceId / apiCredentialId / webhookEndpointId", () => {
        expect(fn).toMatch(/evidenceId:\s*string\s*\|\s*null/);
        expect(fn).toMatch(/apiCredentialId:\s*string\s*\|\s*null/);
        expect(fn).toMatch(/webhookEndpointId:\s*string\s*\|\s*null/);
    });
    it("values are extracted from row.details (where emitSecurityEvent folded them)", () => {
        expect(fn).toMatch(/row\.details/);
        expect(fn).toMatch(/readString\(\s*"evidenceId"\s*\)/);
        expect(fn).toMatch(/readString\(\s*"apiCredentialId"\s*\)/);
        expect(fn).toMatch(/readString\(\s*"webhookEndpointId"\s*\)/);
    });
    it("non-string / missing values gracefully default to null", () => {
        expect(fn).toMatch(/typeof v === "string" \? v : null/);
    });
});
// =============================================================================
// Part 4 — No regression on the other governance models (snake_case preserved)
// =============================================================================
describe("Phase 32.7.2 — EvidenceLegalHold model preserved (snake_case)", () => {
    it("all key fields map to snake_case production columns", () => {
        expect(EVIDENCE_LEGAL_HOLD).toMatch(/teamId\s+String\s+@map\("team_id"\)/);
        expect(EVIDENCE_LEGAL_HOLD).toMatch(/evidenceId\s+String\s+@map\("evidence_id"\)/);
        expect(EVIDENCE_LEGAL_HOLD).toMatch(/caseId\s+String\?\s+@map\("case_id"\)/);
        expect(EVIDENCE_LEGAL_HOLD).toMatch(/placedByUserId\s+String\s+@map\("placed_by_user_id"\)/);
        expect(EVIDENCE_LEGAL_HOLD).toMatch(/placedAtUtc\s+DateTime[\s\S]{0,80}@map\("placed_at_utc"\)/);
        expect(EVIDENCE_LEGAL_HOLD).toMatch(/releasedByUserId\s+String\?\s+@map\("released_by_user_id"\)/);
        expect(EVIDENCE_LEGAL_HOLD).toMatch(/releasedAtUtc\s+DateTime\?\s+@map\("released_at_utc"\)/);
        expect(EVIDENCE_LEGAL_HOLD).toMatch(/releaseNote\s+String\?\s+@map\("release_note"\)/);
    });
    it("@@map(\"evidence_legal_holds\")", () => {
        expect(EVIDENCE_LEGAL_HOLD).toMatch(/@@map\("evidence_legal_holds"\)/);
    });
});
describe("Phase 32.7.2 — CaseLegalHold model preserved (snake_case)", () => {
    it("all key fields map to snake_case production columns", () => {
        expect(CASE_LEGAL_HOLD).toMatch(/teamId\s+String\s+@map\("team_id"\)/);
        expect(CASE_LEGAL_HOLD).toMatch(/caseId\s+String\s+@map\("case_id"\)/);
        expect(CASE_LEGAL_HOLD).toMatch(/placedByUserId\s+String\s+@map\("placed_by_user_id"\)/);
        expect(CASE_LEGAL_HOLD).toMatch(/placedAtUtc\s+DateTime[\s\S]{0,80}@map\("placed_at_utc"\)/);
        expect(CASE_LEGAL_HOLD).toMatch(/releasedByUserId\s+String\?\s+@map\("released_by_user_id"\)/);
        expect(CASE_LEGAL_HOLD).toMatch(/releasedAtUtc\s+DateTime\?\s+@map\("released_at_utc"\)/);
    });
    it("@@map(\"case_legal_holds\")", () => {
        expect(CASE_LEGAL_HOLD).toMatch(/@@map\("case_legal_holds"\)/);
    });
});
describe("Phase 32.7.2 — WorkspaceGovernancePolicy model preserved (snake_case)", () => {
    it("all key fields map to snake_case production columns", () => {
        expect(WORKSPACE_GOVERNANCE_POLICY).toMatch(/teamId\s+String\s+@unique\s+@map\("team_id"\)/);
        expect(WORKSPACE_GOVERNANCE_POLICY).toMatch(/allowOriginalDownload\s+Boolean\s+@default\(true\)\s+@map\("allow_original_download"\)/);
        expect(WORKSPACE_GOVERNANCE_POLICY).toMatch(/createdAt\s+DateTime[\s\S]{0,80}@map\("created_at"\)/);
        expect(WORKSPACE_GOVERNANCE_POLICY).toMatch(/updatedAt\s+DateTime[\s\S]{0,80}@map\("updated_at"\)/);
    });
    it("@@map(\"workspace_governance_policies\")", () => {
        expect(WORKSPACE_GOVERNANCE_POLICY).toMatch(/@@map\("workspace_governance_policies"\)/);
    });
});
describe("Phase 32.7.2 — ReviewEscalation Phase-32.6.2 @maps preserved", () => {
    it("safeSummary still maps to safe_summary", () => {
        expect(REVIEW_ESCALATION).toMatch(/safeSummary\s+String\s+@map\("safe_summary"\)/);
    });
    it("resolutionNote still maps to resolution_note", () => {
        expect(REVIEW_ESCALATION).toMatch(/resolutionNote\s+String\?\s+@map\("resolution_note"\)/);
    });
});
// =============================================================================
// Part 5 — No SQL migration was added for this phase
// =============================================================================
describe("Phase 32.7.2 — no new Prisma migration was authored", () => {
    it("no Phase 32.7.2-attributable migration was added (later phases may add their own)", () => {
        const migrationsDir = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
        const entries = readdirSync(migrationsDir).filter((name) => {
            const full = `${migrationsDir}${name}`;
            try {
                return statSync(full).isDirectory();
            }
            catch {
                return false;
            }
        });
        // Phase 32.7.2 itself must NOT have added a migration (the fix is
        // Prisma-side only). Later phases legitimately author their own and
        // are allow-listed here.
        const PERMITTED_LATER_MIGRATIONS = new Set([
            "20260625100000_phase328cpppp_dashboard_intelligence_closure",
            "20260626100000_phase328cppppp_structural_intelligence_closure",
            "20260627100000_phase328c_control_plane_closure",
            "20260628100000_phase328c_workflow_causality",
            "20260629100000_phase328c_enterprise_gap_closure",
            "20260630100000_phase328d_matter_workspace",
            "20260720100000_personal_workspace_bootstrap",
            "20260720200000_dashboard_projections",
            "20260721000000_workspace_persona_profile",
            // R8.1 — MFA factor + recovery-code schema migration (append-only).
            "20260722000000_r8_1_mfa_activation",
            // R8.1.3 — durable MFA pending challenge store (append-only).
            "20260724000000_r8_1_3_mfa_pending_challenges",
            // R8.1.4 — lost-factor recovery request workflow (append-only).
            "20260725000000_r8_1_4_mfa_recovery_requests",
            // R8.1.5 — recovery email preflight + per-org fail-mode.
            "20260726000000_r8_1_5_recovery_email_preflight",
            // R8.1.6 — pending-digest idempotency log.
            "20260727000000_r8_1_6_recovery_digest_logs",
            // R8.1.7 — admin digest preferences + per-admin digest log.
            "20260728000000_r8_1_7_digest_preferences",
            // Phase E3 — Operational Automation Foundation
            // (automation_rules + automation_runs tables + bounded CHECK
            // constraints for trigger / action / status allowlists).
            "20260801000000_phase_e3_automation_foundation",
            // Phase E3.2 — Secure Webhook Delivery
            // (automation_webhook_destinations + automation_webhook_deliveries
            // tables + extended action-type CHECK to include
            // WEBHOOK_DELIVERY_INTERNAL_ONLY).
            "20260802000000_phase_e3_2_webhook_delivery",
            // Phase E3.3 — Async Delivery & Retry Runtime
            // (extend delivery status CHECK with RETRY_SCHEDULED +
            // RETRY_EXHAUSTED; add 3 destination-health columns:
            // consecutive_failure_count + auto_disabled_at + disabled_reason).
            "20260803000000_phase_e3_3_async_delivery_runtime",
            // Phase E10.1 — DEF-038 closure. Stripe webhook event
            // idempotency: new stripe_webhook_events table with UNIQUE
            // index on stripe_event_id. The webhook handler turns
            // duplicate deliveries into safe no-ops.
            "20260804000000_phase_e10_1_stripe_webhook_idempotency",
            // Phases following E10.1 — each documented under its own
            // phase doc. Added here so the 32.7.2 guard keeps detecting
            // unattributed migrations; these are deliberate.
            "20260925000000_phase0_schema_catchup",
            "20260926000000_p2_7x_stage1_org_model_additive",
            "20260927000000_p2_7x_stage6_invite_token_hash",
            "20260928000000_p2_7x_stage6_teams_org_not_null",
            "20260929000000_phase_b2_workflow_review_decisions",
            "20260930000000_phase_a0_integrity_hard_gate",
            "20261001000000_phase_a1_evidence_org_tenancy",
            "20261002000000_phase_a2_pdf_artifact_status",
            "20261003000000_phase_g3_1_notification_preferences",
            // Phase M3.1 — SIU durability (Prisma persistence for SIU
            // profiles + saved views + export rows, replacing the
            // in-memory registry). Additive: new tables only, no
            // destructive changes to protected runtime tables.
            "20261004000000_phase_m3_1_siu_durability",
            // Phase M3.2 — SIU governance / export persistence.
            // Persists SIU saved views + SIU export ZIP rows + adds the
            // SIU_PII_REVEAL step-up purpose. Additive.
            "20261005000000_phase_m3_2_siu_governance_export",
            // Phase O-Final — Production column repair. Pure-additive
            // (ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS) on
            // tables created with `CREATE TABLE IF NOT EXISTS` in their
            // original migration. Repairs missing `discussion_mentions.team_id`
            // + sister at-risk columns. See
            // `docs/operations/production-schema-repair.md`.
            "20261006000000_phase_o_final_production_column_repair",
            // Phase O — Live schema compatibility repair. Pure-additive
            // (ADD COLUMN IF NOT EXISTS) for live-audit-confirmed scalar
            // mismatches, plus deterministic camelCase→snake_case backfills
            // wrapped in DO blocks. See
            // `docs/operations/live-schema-compatibility-repair.md`.
            "20261007000000_phase_o_live_schema_compatibility_repair",
            // Phase O — Final additive repair for the last CRITICAL table
            // (`evidence_workflow_instance_evidence`). Closes the 5
            // remaining live-audit CRITICAL findings: missing id +
            // step_instance_id, naming drift on workflowInstanceId /
            // evidenceId / createdAt. PK promotion + unique index deferred
            // until operator verifies no duplicates. See
            // `docs/operations/live-schema-compatibility-repair.md`.
            "20261008000000_phase_o_workflow_join_table_final_repair",
            // Final Closure Remediation Part D — drops the orphan
            // `reviewer_queue_projections` table introduced in 37.97 but
            // never wired into any service / worker / route / read path.
            // The sister table `org_health_projections` is the canonical
            // dashboard read model and is untouched.
            // `DROP TABLE IF EXISTS ... CASCADE` is idempotent and safe.
            "20261009000000_drop_reviewer_queue_projection",
            // Phase 2B Closure — invitation delivery + SSO federation schema.
            "20261015000000_phase_2b_closure_invitation_delivery_sso",
            // Phase 3A — enterprise redaction platform schema.
            "20261101000000_phase_3a_redaction_platform",
            // Phase 3A Elite Closure — policy engine + video intelligence schema.
            "20261201000000_phase_3a_elite_closure_policy_video",
            // Phase 3B — intelligence platform schema.
            "20261215000000_phase_3b_intelligence_platform",
            // Phase 3B Enterprise Closure — intelligence quality + budget schema.
            "20261216000000_phase_3b_enterprise_closure",
            // Phase 4A — trust center + enterprise governance schema.
            "20261220000000_phase_4a_trust_and_governance",
            // Phase 4A Enterprise Closure — department membership + policy enforcement schema.
            "20261225000000_phase_4a_enterprise_closure",
            // Phase 4B — product packaging + lifecycle foundation.
            "20261230000000_phase_4b_packaging_and_lifecycle",
            // Phase 4B — final closure: exchange package builds + archive transitions + destruction certs.
            "20261231000000_phase_4b_final_closure",
            // Phase R3 — consolidated schema reality alignment (model catchup).
            "20270101000000_phase_r3_model_catchup",
            // Phase R7 — schema catchup: missing models + additive columns.
            "20270102000000_phase_r7_schema_catchup",
            // Phase R7 trust — align Subprocessor / TrustCenterArticle / Status* with services.
            "20270103000000_phase_r7_trust_schema_fix",
            // Phase R7 redaction — align RedactionVersion / Region / Detection / Decision / Approval / Derivative / Policy* with services.
            "20270104000000_phase_r7_redaction_schema_fix",
            // Phase R7 reviewer-workspace — align CodingSchema / CodingField / CodingValue / ReviewerDisagreement / QcSample with services.
            "20270105000000_phase_r7_reviewer_workspace_schema_fix",
            // Phase R7 governance — align Department / DelegatedAdminGrant / GovernancePolicy* / AccessReview* / CrossOrgReviewGrant with services.
            "20270106000000_phase_r7_governance_schema_fix",
            // Phase R7 capture-trust — align CaptureDeviceAttestation (additive expires_at_utc + provider_metadata)
            // and relax CaptureTrustEventRecord.evidence_id (pre-finalise trust events) with services.
            "20270107000000_phase_r7_capture_trust_schema_fix",
            // Phase R7 intelligence — add ProviderBudget.state for ACTIVE/DISABLED/EXHAUSTED gate filter.
            "20270108000000_phase_r7_intelligence_schema_fix",
            // Phase R7 redaction — promote workspace-scoped name uniqueness to a DB-level unique index.
            "20270109000000_phase_r7_redaction_policy_unique",
            // Phase 5 — Collaboration Teams foundation (team_membership +
            // team_invitations + team_assignments + team_activity_events
            // + team_seat_grants tables). Additive only — Team is the
            // constitutional collaboration sub-unit (NOT a workspace, NOT
            // a tenant) per the Phase 7 closure constitution.
            "20270201000000_phase_5_collaboration_teams",
            // Phase 7 — Collaboration completion (discussion_threads +
            // discussion_comments + discussion_mentions + notification_*
            // tables + team_guest_collaborators + team_access_reviews).
            // Additive only. Comments / mentions / guest collaboration
            // form the Team product completion layer.
            "20270301000000_phase_7_collaboration_completion",
            // Phase 10 — PayPal webhook idempotency (paypal_webhook_events
            // table created to mirror the Stripe webhook dedup model).
            // Additive only.
            "20270401000000_phase_10_paypal_webhook_idempotency",
            // Phase 10 — PayPal webhook payload-hash strengthening
            // (additive payload_hash column). Hash-based dedup so a true
            // duplicate delivery is recognised independent of status.
            "20270501000000_phase_10_paypal_webhook_payload_hash",
            // Phase 13 — Investigation Intelligence Completion: additive
            // graph_edge_id back-reference column on evidence_similarities +
            // CHECK constraint widenings for the new ENTITY node kind +
            // EXTRACTED_FROM edge type. Reuses existing tables; no new
            // model added. Phase O additive pattern; safety-gate verdict
            // SAFE / 0 findings.
            "20270601000000_phase13_intelligence_chain",
            // Phase 15 — Privacy-safe semantic search. Additive pgvector
            // sibling column (`embedding_vector vector(1536)`) on the
            // existing EvidenceSemanticChunk table — the legacy `embedding`
            // Bytes column is preserved for backward compatibility. The
            // CREATE EXTENSION + ALTER COLUMN + CREATE INDEX steps are each
            // wrapped in DO $$ ... END $$ blocks with information_schema
            // guards and an insufficient_privilege EXCEPTION so the
            // migration degrades gracefully on Postgres deployments where
            // the running user cannot install extensions. Phase O additive
            // pattern; safety-gate verdict SAFE / 0 findings.
            "20270701000000_phase15_semantic_search",
            // Phase 16 — Real semantic search activation. Additive single
            // table `semantic_usage_daily` for per-workspace-per-UTC-day
            // counter rollup (chunks embedded + tokens consumed + EUR
            // spent). Read by `canEmbedMore` (daily cap + monthly budget)
            // and by `getSemanticUsageSummary`. Phase O additive pattern;
            // DO $$ guards, `IF NOT EXISTS`, no DROP / no RENAME.
            "20270801000000_phase16_semantic_usage",
            // Sentry batch — Phase O schema-drift repair. Closes the 9
            // schema-drift items from the 13-issue Sentry triage:
            //   NODE-1R evidence_exchange_packages.updated_at
            //   NODE-1Q chain_transfers.updated_at
            //   NODE-1E status_components.updated_at
            //   NODE-1H provider_budgets.archived_at
            //   NODE-1M redaction_projects.closed_at_utc
            //   NODE-1J subprocessors.category / country / description
            //   NODE-1N redaction_policy_assignments.version_id (+ backfill)
            //   NODE-1K delegated_admin_grants.granted_to_user_id +
            //           scope_target_id + created_at + updated_at (+ backfill)
            //   NODE-1P coding_schemas + coding_fields defensive R7 surface
            //           re-assert. Pure additive (ADD COLUMN IF NOT EXISTS),
            //           idempotent, DO $$ guards on every backfill, no DROP /
            //           no RENAME / no SET NOT NULL on pre-existing columns.
            "20270802000000_phase_sentry_batch_schema_drift_repair",
            // Phase Governance Additive Repair (user brief: 4 governance tables
            // — cross_org_review_grants, access_review_campaigns,
            // governance_policies, departments — were left with their R3+R7
            // overlay column set in production because Phase 4A's CREATE TABLE
            // statements did not use IF NOT EXISTS and therefore no-op'd when
            // the R3-skeleton tables already existed. 15 Prisma-declared columns
            // and 1 supporting index added additively here; zero DROP / RENAME /
            // TRUNCATE / DELETE / UPDATE / REVOKE / SET-NOT-NULL statements.
            "20270803000000_phase_governance_additive_repair",
            // Phase 1 Production Drift Stabilization — consolidated additive
            // closure for the post-Sentry / post-Governance drift discovered by
            // the 3-workstream Phase 1 audit (coverage + reviewer-ops trace +
            // unobserved scan). 10 Prisma-declared columns across 6 tables:
            //   redaction_policy_assignments.revoked_at + created_at
            //   reviewer_corrections.accepted_at + reverted_at + superseded_at + updated_at
            //   legal_holds.updated_at
            //   retention_policy_configs.updated_at
            //   destruction_requests.updated_at
            //   archive_tier_transitions.created_at
            // Pure additive (ADD COLUMN IF NOT EXISTS); zero DROP / RENAME /
            // TRUNCATE / DELETE / UPDATE / REVOKE / SET-NOT-NULL statements.
            "20270804000000_phase1_production_drift_stabilization",
            // Phase 2 Drift Repair (Domain 1 — Trust / Status / Subprocessors).
            // 15 Prisma-declared columns across 6 tables:
            //   trust_center_article_versions.published_at_utc
            //   subprocessor_versions.team_id + effective_at_utc
            //   status_incidents.external_ref + component_keys + postmortem_url + updated_at
            //   status_incident_updates.team_id
            //   maintenance_windows.team_id + state + description + component_keys + updated_at
            //   security_claim_checks.created_at + updated_at
            // Pure additive (ADD COLUMN IF NOT EXISTS); zero DROP / RENAME /
            // TRUNCATE / DELETE / UPDATE / REVOKE / SET-NOT-NULL statements.
            "20270805000000_phase2_drift_repair_trust_status",
            // Phase 2 Drift Repair (Domain 2 — Governance). 10 Prisma-declared
            // columns across 3 tables:
            //   delegated_admin_grants.organization_id + department_id + workspace_id
            //   governance_policy_assignments.scope + inherit_from_parent +
            //                                  is_override + assigned_by_user_id
            //   governance_policy_audits.code + reason + occurred_at_utc
            // Pure additive (ADD COLUMN IF NOT EXISTS); zero DROP / RENAME /
            // TRUNCATE / DELETE / UPDATE / REVOKE / SET-NOT-NULL statements.
            "20270806000000_phase2_drift_repair_governance",
            // Phase 2 Drift Repair (Domain 3 — Redaction). 20 Prisma-declared
            // columns across 7 tables:
            //   redaction_versions.authored_by_user_id + superseded_at_utc +
            //                     submitted_at_utc + approved_at_utc
            //   redaction_detections.kind + suggested_region_kind +
            //                       suggested_region_geometry + suggested_method +
            //                       decision_state
            //   redaction_decisions.version_id
            //   redaction_approvals.approver_user_id + decided_at_utc
            //   redaction_derivatives.storage_bucket + render_started_at +
            //                        rendered_at_utc + failure_reason
            //   redaction_activities.version_id + occurred_at_utc
            //   redaction_policy_versions.reviewed_by_user_id
            // Excludes the RedactionPolicyAudit table-name drift
            // (REQUIRES_MANUAL_DECISION). Pure additive (ADD COLUMN IF NOT EXISTS);
            // zero DROP / RENAME / TRUNCATE / DELETE / UPDATE / REVOKE / SET-NOT-NULL.
            "20270807000000_phase2_drift_repair_redaction",
            // Phase 2 Drift Repair (Domain 7 — Exchange / Lifecycle Webhooks).
            // 5 Prisma-declared columns across 2 tables:
            //   webhook_endpoints.updated_at
            //   webhook_deliveries.updated_at + created_at + next_retry_at +
            //                     next_attempt_at_utc
            // Pure additive (ADD COLUMN IF NOT EXISTS); zero DROP / RENAME /
            // TRUNCATE / DELETE / UPDATE / REVOKE / SET-NOT-NULL statements.
            "20270808000000_phase2_drift_repair_lifecycle_webhooks",
            // Phase 2.1 Final Drift Closure — operator-pre-deploy bundle that
            // resolves the 4 open items from the Phase 2 manual-decision table:
            //   * CREATE TABLE IF NOT EXISTS "redaction_policy_audits" (plural,
            //     matches Prisma @@map); legacy singular "redaction_policy_audit"
            //     left untouched. NO RENAME, NO DROP, NO data move.
            //   * entitlements.team_seats INTEGER NOT NULL DEFAULT 0
            //   * verification_packages.package_type VARCHAR(64) NULL
            //   * verification_packages.trust_decision_snapshot JSONB NULL
            // Pure additive (CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS);
            // zero DROP / RENAME / TRUNCATE / DELETE / UPDATE / REVOKE statements.
            "20270809000000_phase_2_1_final_drift_closure",
        ]);
        const newer = entries.filter((name) => {
            const m = name.match(/^(\d{14})/);
            if (!m)
                return false;
            if (m[1] <= "20260620300000")
                return false;
            return !PERMITTED_LATER_MIGRATIONS.has(name);
        });
        expect(newer).toEqual([]);
    });
});
