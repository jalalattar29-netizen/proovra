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

function readSchema(): string {
  return readFileSync(
    fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)),
    "utf8",
  );
}
function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

function extractModelBlock(schema: string, modelName: string): string {
  const re = new RegExp(`model\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`, "m");
  const match = schema.match(re);
  expect(match, `model ${modelName} must exist in schema.prisma`).toBeTruthy();
  return match![1];
}

/**
 * PHASE 12 POINT 3 — same extraction WITHOUT the must-exist assertion, for
 * models that are expected to be absent. `extractModelBlock` asserts at module
 * scope, so using it on a deliberately-removed model aborts collection and the
 * whole file reports "no tests" instead of a real result.
 */
function findModelBlock(schema: string, modelName: string): string | null {
  const re = new RegExp(`model\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`, "m");
  return schema.match(re)?.[1] ?? null;
}

const SCHEMA = readSchema();
const SECURITY_EVENT = extractModelBlock(SCHEMA, "SecurityEvent");
const EVIDENCE_LEGAL_HOLD = extractModelBlock(SCHEMA, "EvidenceLegalHold");
const CASE_LEGAL_HOLD = findModelBlock(SCHEMA, "CaseLegalHold");
const WORKSPACE_GOVERNANCE_POLICY = extractModelBlock(
  SCHEMA,
  "WorkspaceGovernancePolicy",
);
const REVIEW_ESCALATION = extractModelBlock(SCHEMA, "ReviewEscalation");

// =============================================================================
// Part 1 — SecurityEvent: camelCase production schema alignment
// =============================================================================

describe("Phase 32.7.2 — SecurityEvent maps to camelCase production columns", () => {
  it("primary fields map to camelCase columns (teamId, userId, eventType)", () => {
    expect(SECURITY_EVENT).toMatch(/teamId\s+String\?\s+@map\("teamId"\)/);
    expect(SECURITY_EVENT).toMatch(/userId\s+String\?\s+@map\("userId"\)/);
    expect(SECURITY_EVENT).toMatch(
      /eventType\s+String\s+@map\("eventType"\)/,
    );
  });

  it("legacy snake_case mappings are gone (no team_id / event_type / created_at)", () => {
    expect(SECURITY_EVENT).not.toMatch(/@map\("team_id"\)/);
    expect(SECURITY_EVENT).not.toMatch(/@map\("event_type"\)/);
    expect(SECURITY_EVENT).not.toMatch(/@map\("created_at"\)/);
  });

  it("`details` Prisma field aliases to production column `metadataJson`", () => {
    expect(SECURITY_EVENT).toMatch(
      /details\s+Json\?\s+@map\("metadataJson"\)/,
    );
  });

  it("`createdAt` Prisma field aliases to production column `createdAtUtc`", () => {
    expect(SECURITY_EVENT).toMatch(
      /createdAt\s+DateTime[\s\S]{0,80}@map\("createdAtUtc"\)/,
    );
  });

  it("production-only fields declared on the model", () => {
    expect(SECURITY_EVENT).toMatch(
      /ipAddressHash\s+String\?\s+@map\("ipAddressHash"\)/,
    );
    expect(SECURITY_EVENT).toMatch(
      /userAgent\s+String\?\s+@map\("userAgent"\)/,
    );
    expect(SECURITY_EVENT).toMatch(
      /requestId\s+String\?\s+@map\("requestId"\)/,
    );
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
    expect(SRC).toMatch(
      /relationContext\.apiCredentialId\s*=\s*input\.apiCredentialId/,
    );
    expect(SRC).toMatch(
      /relationContext\.webhookEndpointId\s*=\s*input\.webhookEndpointId/,
    );
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
  // Phase 5 hardening added a sibling `projectSecurityEventDetails`
  // helper above this function. Anchor on `(row` so we slice the
  // single-row projection, NOT the allow-list helper.
  const fnIdx = SRC.indexOf("export function projectSecurityEvent(row");
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
    // PHASE 12B CLUSTER 8 — `evidenceId` became NULLABLE when this table
    // became the CANONICAL legal-hold model: CASE and WORKSPACE scoped holds
    // have no single evidence target. The column mapping is unchanged, and a
    // CHECK constraint (migration 20271106000000) guarantees an
    // EVIDENCE-scoped row still always carries one.
    expect(EVIDENCE_LEGAL_HOLD).toMatch(
      /evidenceId\s+String\?\s+@map\("evidence_id"\)/,
    );
    expect(EVIDENCE_LEGAL_HOLD).toMatch(/caseId\s+String\?\s+@map\("case_id"\)/);
    expect(EVIDENCE_LEGAL_HOLD).toMatch(/scope\s+LegalHoldScope/);
    expect(EVIDENCE_LEGAL_HOLD).toMatch(
      /placedByUserId\s+String\s+@map\("placed_by_user_id"\)/,
    );
    expect(EVIDENCE_LEGAL_HOLD).toMatch(
      /placedAtUtc\s+DateTime[\s\S]{0,80}@map\("placed_at_utc"\)/,
    );
    expect(EVIDENCE_LEGAL_HOLD).toMatch(
      /releasedByUserId\s+String\?\s+@map\("released_by_user_id"\)/,
    );
    expect(EVIDENCE_LEGAL_HOLD).toMatch(
      /releasedAtUtc\s+DateTime\?\s+@map\("released_at_utc"\)/,
    );
    expect(EVIDENCE_LEGAL_HOLD).toMatch(
      /releaseNote\s+String\?\s+@map\("release_note"\)/,
    );
  });

  it("@@map(\"evidence_legal_holds\")", () => {
    expect(EVIDENCE_LEGAL_HOLD).toMatch(/@@map\("evidence_legal_holds"\)/);
  });
});

// PHASE 12 POINT 3 — this file used to assert the CaseLegalHold model was
// PRESERVED with snake_case column maps. That model is now deliberately gone:
// 20271108000000_legal_hold_legacy_removal DROPs `case_legal_holds`, and while
// the model stayed declared a generated migration would have re-created the
// table and silently resurrected the retired authority. The coverage is not
// dropped — it is inverted into a stays-removed guard, so the column-mapping
// pin cannot come back by accident.
describe("Phase 12 Point 3 — CaseLegalHold model stays REMOVED", () => {
  it("schema.prisma declares no CaseLegalHold model", () => {
    expect(CASE_LEGAL_HOLD).toBeNull();
    expect(SCHEMA).not.toMatch(/^model CaseLegalHold\b/m);
  });

  it('schema.prisma maps nothing to "case_legal_holds"', () => {
    expect(SCHEMA).not.toMatch(/@@map\("case_legal_holds"\)/);
  });

  it("the canonical EvidenceLegalHold model is the one that survives", () => {
    expect(EVIDENCE_LEGAL_HOLD).toBeTruthy();
    expect(EVIDENCE_LEGAL_HOLD).toMatch(/@@map\("evidence_legal_holds"\)/);
  });
});

describe("Phase 32.7.2 — WorkspaceGovernancePolicy model preserved (snake_case)", () => {
  it("all key fields map to snake_case production columns", () => {
    expect(WORKSPACE_GOVERNANCE_POLICY).toMatch(
      /teamId\s+String\s+@unique\s+@map\("team_id"\)/,
    );
    expect(WORKSPACE_GOVERNANCE_POLICY).toMatch(
      /allowOriginalDownload\s+Boolean\s+@default\(true\)\s+@map\("allow_original_download"\)/,
    );
    expect(WORKSPACE_GOVERNANCE_POLICY).toMatch(
      /createdAt\s+DateTime[\s\S]{0,80}@map\("created_at"\)/,
    );
    expect(WORKSPACE_GOVERNANCE_POLICY).toMatch(
      /updatedAt\s+DateTime[\s\S]{0,80}@map\("updated_at"\)/,
    );
  });

  it("@@map(\"workspace_governance_policies\")", () => {
    expect(WORKSPACE_GOVERNANCE_POLICY).toMatch(
      /@@map\("workspace_governance_policies"\)/,
    );
  });
});

describe("Phase 32.7.2 — ReviewEscalation Phase-32.6.2 @maps preserved", () => {
  it("safeSummary still maps to safe_summary", () => {
    expect(REVIEW_ESCALATION).toMatch(
      /safeSummary\s+String\s+@map\("safe_summary"\)/,
    );
  });

  it("resolutionNote still maps to resolution_note", () => {
    expect(REVIEW_ESCALATION).toMatch(
      /resolutionNote\s+String\?\s+@map\("resolution_note"\)/,
    );
  });
});

// =============================================================================
// Part 5 — No SQL migration was added for this phase
// =============================================================================

describe("Phase 32.7.2 — no new Prisma migration was authored", () => {
  // Phase 32.7.2 itself must NOT have added a migration (the fix is
  // Prisma-side only). Later phases legitimately author their own and
  // are allow-listed here.
  //
  // PHASE 12 POINT 8 — hoisted from inside the `it` so the gate's REFUSALS can
  // be proved too. It is the same exact-name set it has always been: no range,
  // no prefix match, no "allow everything newer". A gate that has only ever
  // passed has not been shown to be capable of failing.
  const PERMITTED_LATER_MIGRATIONS = new Set<string>([
      "20260625100000_phase328cpppp_dashboard_intelligence_closure",
      "20260626100000_phase328cppppp_structural_intelligence_closure",
      "20260627100000_phase328c_control_plane_closure",
      "20260628100000_phase328c_workflow_causality",
      "20260629100000_phase328c_enterprise_gap_closure",
      "20260630100000_phase328d_matter_workspace",
      "20260720100000_personal_workspace_bootstrap",
      "20260720200000_dashboard_projections",
      "20260721000000_workspace_persona_profile",
      // PHASE 3 (2026-07-21) — normalized membership-grant provenance.
      "20270920200000_membership_grant_provenance",
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
      // Phase 2B — HIGH schema drift repair, split into safe additive batches.
      "20270906000000_phase_2b_1_timestamp_repairs",
      "20270906010000_phase_2b_2_integer_widening",
      "20270906020000_phase_2b_3_string_type_alignment",
      "20270906030000_phase_2b_4_nullability_hardening",
      "20270906040000_phase_2b_5_enum_alignment",
      "20270906050000_phase_2b_6_uuid_and_identifier_alignment",
      "20270906060000_phase_2b_7_json_semantic_repairs",
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
      // Wave 1 — Investigation graph taxonomy renames + new deferred kinds.
      // Additive CHECK widening on investigation_graph_nodes.node_kind +
      // investigation_graph_edges.edge_type. Existing names remain valid
      // (kept as deprecated aliases for one release). 5 renames + 5 new
      // deferred node kinds + 4 new deferred edge types. Pure additive
      // (DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT with widened set);
      // zero DROP TABLE / DROP COLUMN / RENAME / data movement.
      "20270810000000_wave1_graph_taxonomy_renames",
      // Wave 2 — Duplicate / Similarity / Lineage decisions. Adds one new
      // table `duplicate_decisions` with bounded CHECK constraints on
      // edge_type (SAME_HASH_AS | SIMILAR_TO | POSSIBLE_DERIVATIVE_OF) +
      // decision (CONFIRMED | DISMISSED | MARKED_DERIVATIVE). Pure
      // additive (CREATE TABLE IF NOT EXISTS + ADD CONSTRAINT guarded
      // by NOT EXISTS); zero DROP / RENAME / data movement.
      "20270811000000_wave2_duplicate_decisions",
      // Wave 3 — CustodyEventType enum widening (Phase 7A). Adds 8 new
      // Investigation-mutation custody event values to the Postgres
      // enum `CustodyEventType`:
      //   DUPLICATE_DECISION_RECORDED
      //   MANUAL_RELATIONSHIP_CREATED
      //   MANUAL_RELATIONSHIP_RETRACTED
      //   GRAPH_RECONCILE_REQUESTED
      //   MEDIA_INTELLIGENCE_REFRESH_REQUESTED
      //   INVESTIGATION_GRAPH_EXPORTED
      //   INVESTIGATION_TIMELINE_EXPORTED
      //   INVESTIGATION_DUPLICATES_EXPORTED
      // Each ALTER TYPE wrapped in a DO $$ block + ADD VALUE IF NOT EXISTS
      // for idempotency. Pure additive — zero DROP VALUE / RENAME VALUE /
      // data movement. Existing values remain valid.
      "20270812000000_wave3_custody_event_type_widening",
      // PHASE 2 — true dual-active API key rotation. Adds three nullable
      // columns to `api_credentials` (`previous_key_hash`,
      // `previous_key_prefix`, `previous_valid_until_utc`) plus a small
      // BTree index on the validity-window column and a partial UNIQUE
      // index on `previous_key_hash WHERE NOT NULL`. Pure additive: no
      // DROP / RENAME / data movement; nullable columns require no
      // backfill, and `ADD COLUMN IF NOT EXISTS` plus `CREATE INDEX
      // IF NOT EXISTS` keep the migration idempotent across re-runs.
      // Unblocks the rotate-with-grace flow in the integrations admin
      // surface and the corresponding two-key acceptance window in
      // `verifyApiKeyDetailed`.
      "20270813000000_phase2_api_key_dual_active_rotation",
      // PHASE 4 — webhook endpoint dual-signing rotation. Adds three
      // nullable columns to `integration_webhook_endpoints`
      // (`previous_secret_ciphertext`, `previous_secret_prefix`,
      // `previous_secret_valid_until_utc`) plus a small BTree index on
      // the validity-window column. Pure additive: no DROP / RENAME /
      // data movement; nullable columns require no backfill, and
      // `ADD COLUMN IF NOT EXISTS` plus `CREATE INDEX IF NOT EXISTS`
      // keep the migration idempotent across re-runs. Unblocks
      // Stripe-style multi-sig (`X-Proovra-Signature: v1=<new>,v1=<old>`)
      // in the dispatcher while the grace window is open.
      "20270814000000_phase4_webhook_dual_signing_rotation",
      // PHASE closure — webhook delivery response duration. Adds a
      // single nullable INTEGER column `response_duration_ms` to
      // `integration_webhook_deliveries`. The dispatcher brackets the
      // single outbound `httpClient(...)` call in `attemptDeliveryInner`
      // with `process.hrtime.bigint()` and persists the measured
      // wall-clock milliseconds. NULL is honest — left as-is when the
      // row reached a terminal status WITHOUT issuing the fetch (e.g.
      // signing_key_unavailable). Pure additive: no DROP / RENAME /
      // data movement; no DEFAULT so no table rewrite; `ADD COLUMN IF
      // NOT EXISTS` keeps the migration idempotent. Unblocks the
      // `averageLatencyMsLast24h` tile on the integrations health
      // dashboard.
      "20270815000000_phase_closure_webhook_delivery_duration",
      // Phase T — canonical workflow-template identity trio (slug + version
      // + optional db FK) added as nullable columns + nullable FK with
      // ON DELETE SET NULL on Evidence and EvidenceReviewWorkflow. Pure
      // additive: no NOT NULL, no DROP / RENAME, no defaults, no
      // backfill. Unblocks template provenance across the lifecycle
      // surfaces (review workflow, escalation, reports, packages).
      "20270816000000_phase_t_template_identity_columns",
      // Phase T — repair missing UUID defaults on coding_schemas.id and
      // coding_fields.id. This is a deliberate production drift repair
      // migration for Phase 32.7.2.
      "20270817000000_phase_t_coding_schema_uuid_default_repair",
      "20270818000000_phase_t_coding_values_updated_at_default",
      "20270818010000_phase_t_coding_values_id_default",
      "20270818020000_phase_t_reviewer_disagreements_defaults",
      // Phase T — Trust Center / status / subprocessor drift repair.
      // Adds `effective_at` to the version history tables used by the
      // Trust Center seed and status projection path. Pure additive,
      // bounded to development drift repair.
      "20270818030000_phase_t_trust_center_drift_repair",
      // Phase T — repair missing published_at support on trust center
      // article versions so canonical publish-state reads stop failing.
      "20270819000000_phase_t_trust_center_versions_published_at_repair",
      // Phase T — repair missing published_at support on subprocessor
      // versions so canonical trust disclosures project cleanly.
      "20270819010000_phase_t_subprocessor_versions_runtime_repair",
      // Phase IA-reliability — InboxItemState (per-user read/dismiss/
      // snooze state for /v1/me/inbox). Additive: new table + indexes,
      // no destructive changes. See
      // `services/api/prisma/migrations/20270820000000_add_inbox_item_state/migration.sql`.
      "20270820000000_add_inbox_item_state",
      // Search-index drift repair — drops NOT NULL on legacy
      // camelCase columns on `evidence_search_documents`. These
      // columns were left in place when the canonical write
      // surface moved to snake_case; production accumulated 144
      // evidence rows against 0 search documents because every
      // `Prisma.create()` raised a NOT NULL violation on the
      // camelCase shadow. Idempotent (gated on
      // information_schema.columns + is_nullable='NO'). Scoped to
      // exactly evidence_search_documents.
      "20270821000000_phase_search_evidence_search_documents_legacy_drop_not_null",
      // Intake-link enterprise messaging — adds sender_display_mode +
      // sender_display_name columns to workflow_intake_links so the
      // operator can choose between PROOVRA / WORKSPACE / CUSTOM
      // (PROOVRA branding is always preserved by the shared resolver).
      // Additive only; existing rows default to PROOVRA mode.
      "20270822000000_intake_link_sender_identity",
      // P0 forensic — split the dispatcher's idempotency marker off
      // provider_message_id (which must hold the real Twilio SID for
      // webhook correlation) into a dedicated delivery_idempotency_key
      // column. Backfill migrates hijacked rows; CREATE INDEX is
      // wrapped in the Phase O-Final information_schema.columns guard.
      "20270823000000_communication_message_idem_key_split",
      // Intake Links Operations Console — operator-facing archive
      // lifecycle. Adds archived_at_utc + archived_by_user_id (both
      // nullable, no backfill) so an enterprise-grade Active tab can
      // hide cluttered historical links without revoking access.
      // CREATE INDEX is wrapped in the Phase O-Final guard.
      "20270824000000_intake_link_archive",
      // Intake Links — location collection. Adds
      // workflow_intake_links.location_policy (default 'NONE' so
      // existing links keep their previous no-prompt behaviour) and
      // evidence.location_source (nullable) with a guarded backfill
      // that stamps CAPTURE_BROWSER_GEOLOCATION onto rows that
      // already carry coordinates. Reuses the existing Evidence.lat
      // / lng / accuracyMeters columns end-to-end so no parallel
      // location concept is introduced.
      "20270825000000_intake_link_location_collection",
      // Pricing hardening — Enterprise plan tier on the PlanType enum
      // (ALTER TYPE ADD VALUE IF NOT EXISTS), Entitlement.legacy_record_
      // cap_override (additive INTEGER, nullable), and two Phase O-Final
      // guarded CREATE INDEX statements on evidence (team_id,created_at
      // and team_id,deleted_at,created_at). Backfills legacy_record_cap_
      // override for PRO accounts already above 100 records so existing
      // records remain accessible while new creation is blocked above
      // the grandfathered allowance. Pure additive: zero DROP / RENAME /
      // TRUNCATE / DELETE / UPDATE-without-WHERE / SET-NOT-NULL.
      "20270826000000_pricing_hardening_enterprise_plan_record_caps",
      // Contact Sales lead capture — sibling to demo_requests for the
      // /contact-sales marketing form. Adds contact_sales_requests
      // table + ContactSalesStatus + ContactSalesPriority enums + 5
      // guarded indexes. Pure additive Phase O-Final-style migration:
      // CREATE TYPE wrapped in DO + duplicate-object check, CREATE
      // TABLE IF NOT EXISTS, every CREATE INDEX guarded by
      // information_schema.columns existence checks. Zero DROP /
      // RENAME / TRUNCATE / DELETE / UPDATE on existing tables.
      // demo_requests rows are NOT touched. Allowlisted in
      // phase-o-migration-safety-gate.test.ts via
      // APPROVED_CRITICAL_BY_MIGRATION for the same CREATE_TABLE_IF_
      // NOT_EXISTS kind as the wave2_duplicate_decisions precedent.
      "20270827000000_contact_sales_lead_capture",
      // Enterprise email verification (EV). Adds email_verification_tokens
      // table + 3 indexes + FK + a single bounded UPDATE backfilling
      // users.email_verified_at for legacy accounts (so they aren't
      // locked out when the verify gate ships). Pure-additive Phase O
      // pattern: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
      // FK wrapped in a DO + duplicate-object guard, UPDATE scoped by
      // `WHERE email_verified_at IS NULL`. Zero DROP / RENAME /
      // TRUNCATE / DELETE / UPDATE-without-WHERE / SET-NOT-NULL.
      // Allowlisted in phase-o-migration-safety-gate.test.ts via
      // APPROVED_CRITICAL_BY_MIGRATION for the CREATE_TABLE_IF_NOT_EXISTS
      // kind, matching the contact-sales precedent.
      "20270828000000_email_verification_tokens",
      // Phase 2A live production reconciliation catch-up. Additive-only:
      // 47 missing columns from the live audit, plus guarded null-only
      // backfills from legacy source columns where the mapping is
      // unambiguous. No DROP / RENAME / FK changes / destructive enum work.
      "20270829000000_phase_2a_live_missing_columns_catchup",
      "20270829000000_evr_p4_canonical_verification_record",
"20270830000000_evr_p10_tsa_retry_tracking",
"20270901000000_verification_package_validation_findings",
      "20270902000000_verification_package_hash",
"20270903000000_verification_package_validation_status",
"20270904000000_report_claims_package_verified",
"20270905000000_contributor_identity_snapshot",
      // Phase 2C-D LOW-drift cleanup. Safe single-statement DB relaxation:
      // media_intelligence_records.provider_confidence DROP NOT NULL so the
      // DB matches the already-nullable runtime/model contract. Unrelated to
      // Phase 32.7.2 SecurityEvent mapping, so allowlisting preserves the
      // original guardrail intent without blocking later safe schema work.
      "20270906070000_phase_2c_d_provider_confidence_nullable_relaxation",
      // Enterprise Technical Metadata + Capture Environment layer.
      // Additive, nullable-only (ADD COLUMN IF NOT EXISTS on evidence /
      // evidence_parts: technical_metadata + capture_environment +
      // technical_meta_parsed_at/parser). No destructive change, no FK /
      // enum change. Unrelated to Phase 32.7.2 SecurityEvent mapping;
      // allowlisted so the guardrail keeps detecting UNattributed
      // migrations while permitting this deliberate metadata work.
      "20270907000000_technical_metadata_capture_environment",
      // Removes the unsupported anchor receipt_id / public_url columns
      // from evidence_anchors (receipt_id, public_url). Deliberate,
      // confirmed-unused destructive cleanup; DROP COLUMN IF EXISTS is
      // idempotent and its CRITICAL finding is separately reviewed in
      // phase-o-migration-safety-gate's APPROVED_CRITICAL_BY_MIGRATION.
      // Unrelated to Phase 32.7.2 SecurityEvent mapping.
      "20270908000000_drop_evidence_anchor_publication_columns",
      // Phase 2 Blocker 1 — brand-new-owner enterprise provisioning.
      // Additive, nullable-only (ADD COLUMN pending_enterprise_seats on
      // organizations). No destructive change, no FK / enum change, no
      // existing data touched. Unrelated to Phase 32.7.2 SecurityEvent
      // mapping; allowlisted so the guardrail keeps detecting UNattributed
      // migrations while permitting this deliberate provisioning work.
      "20270909000000_org_pending_enterprise_seats",
      "20270910000000_phase_3_enterprise_identity_domains_and_sp_signing",
      // PROOVRA Enterprise AI Program — four ADDITIVE-ONLY migrations
      // (CREATE TABLE IF NOT EXISTS + guarded enum/index creation; zero
      // DROP / RENAME / TRUNCATE / destructive UPDATE). They back the
      // workspace AI governance policy, the Copilot defensibility run
      // store, the durable AI usage ledger, and the human-authored
      // Reviewer Criteria Catalog. Unrelated to Phase 32.7.2
      // SecurityEvent mapping; allowlisted so the guardrail keeps
      // detecting UNattributed migrations.
      "20270911000000_workspace_ai_policy",
      "20270912000000_ai_copilot_runs",
      "20270913000000_ai_usage_ledger",
      "20270914000000_reviewer_criteria_catalog",
      // Phase F-8 — honest provider-label VALUE rename (varchar column, not
      // an enum): scoped, idempotent UPDATEs rewriting the never-operational
      // OPENAI_ENTITY_EXTRACTION / OPENAI_DOCUMENT_SUMMARY labels to LOCAL_*
      // on media_intelligence_records + provider_usage_events, guarded by
      // to_regclass. No DDL, no deletes. Unrelated to Phase 32.7.2
      // SecurityEvent mapping.
      "20270915000000_mi_provider_local_value_rename",
      // Operations-Center completion — persistent history snapshots +
      // notification schedule settings + preference frequency column.
      // Pure-additive (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT
      // EXISTS / guarded FKs+indexes); zero destructive statements.
      // Unrelated to Phase 32.7.2 SecurityEvent mapping.
      "20270916000000_operations_center_history_and_schedule",
      // Operations-Center forensic completion — organization notification
      // policy table + snapshot resolution-provenance columns. Pure-
      // additive (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
      // guarded FK); zero destructive statements. Unrelated to Phase
      // 32.7.2 SecurityEvent mapping.
      "20270917000000_org_notification_policy_and_resolution_provenance",
      // Lifecycle Phase 3 (2026-07-17) — linked login methods (additive
      // table + deterministic backfill from users.provider_user_id).
      "20270918000000_user_identity_links",
      // Lifecycle Phase 4 (2026-07-17) — personal account data export
      // requests (additive table, no backfill).
      "20270919000000_account_data_export_requests",
      // Lifecycle Phase 5 (2026-07-17) — personal account closure
      // requests (additive table, no backfill).
      "20270920000000_account_closure_requests",
      // Lifecycle Phase 6 (2026-07-17) — organization closure requests
      // (additive table, no backfill).
      "20270921000000_organization_closure_requests",
      // Lifecycle Phase 7 (2026-07-17) — workspace closure requests
      // (additive table, no backfill).
      "20270922000000_workspace_closure_requests",
      // Settings remediation (2026-07-17) — notification-schedule timezone
      // becomes nullable (NULL = inherit account timezone); constraint
      // relaxation + restrictive idempotent backfill only.
      "20270923000000_notification_schedule_timezone_inherit",
      // Workspace-persona deletion (2026-07-20) — drops the retired
      // workspace_persona_profiles table (product-approved physical
      // deletion of the workspace-persona / workflow-personalization /
      // operational-density feature family). Not Phase 32.7.2-attributable.
      "20270924000000_drop_workspace_persona_profiles",
      // P1 domain remediation (2026-07-21) — explicit workspaceKind
      // discriminator on teams + OrganizationKind on organizations, with a
      // deterministic backfill. Not Phase 32.7.2-attributable.
      "20270920000000_workspace_kind_discriminator",
      // P2 domain remediation (2026-07-21) — org-invite workspace assignments
      // + acceptedByUserId (additive). Not Phase 32.7.2-attributable.
      "20270920100000_org_invite_workspace_assignments",
      // PHASE 3 (2026-07-21) — normalized membership-grant provenance
      // (additive membership_grants table). Not Phase 32.7.2-attributable.
      "20270920200000_membership_grant_provenance",
      // PHASE 3 (2026-07-22) — LEGACY_UNKNOWN provenance backfill.
      "20270920250000_membership_grant_legacy_backfill",
      // PHASE 4 (2026-07-22) — canonical Enterprise contract state.
      "20270920300000_enterprise_contract_state",
      // PHASE 4 §7.1 (2026-07-22) — provisioning idempotency requests.
      "20260722110000_enterprise_provisioning_idempotency",
      // PHASE 10 §13.2 (2026-07-22) — User.identityMode (managed identity).
      "20270925000000_user_identity_mode",
      // PHASE 10 §Step-1 (2026-07-23) — OrganizationSecurityPolicy convergence
      // (org-keyed), managed-identity ownership + backfill, AuthenticatedSession
      // organization-context, and policy lifecycle. All additive; unapplied.
      "20271001000000_org_security_policy_phase10",
      "20271002000000_managed_identity_ownership",
      "20271003000000_managed_identity_ownership_backfill",
      "20271004000000_authenticated_session_org_context",
      "20271005000000_org_security_policy_org_scoped",
      "20271006000000_org_security_policy_lifecycle",
      // PHASE 11 (2026-07-24) — authoritative tenant columns on admin_audit_logs.
      "20271101000000_audit_tenant_columns",
      // PHASE 12 — uuid id DEFAULT repair (11 tables whose creating migrations
      // omitted the gen_random_uuid() default that schema.prisma promises).
      "20271102000000_uuid_id_default_repair",
      // PHASE 12B Wave 1B — CaseEvidenceLink canonical authority: teamId
      // nullable + idempotent backfill from Evidence.caseId (forward-only,
      // unapplied; column drop deferred until runtime readers reach zero).
      "20271103000000_case_evidence_link_canonical",
      // Track 1B closure — SPLIT by PHASE 12 POINT 6 into an EXPAND half
      // (final backfill + the two validated foreign keys on
      // case_evidence_links, Release B) and a CONTRACT half (the
      // Evidence.case_id column drop, Release D). One SQL file cannot sit in
      // two release waves.
      "20271104000000_case_evidence_link_integrity",
      "20271105000000_evidence_case_id_removal",
      // PHASE 12B CLUSTER 8 — legal-hold convergence. `evidence_legal_holds`
      // becomes the CANONICAL legal-hold model (additive columns + FKs +
      // scope/target CHECK); the backfill copies the two legacy stores into
      // it idempotently; the legacy-removal migration is authored but MUST
      // NOT be applied until the backfill is applied and verified (it guards
      // itself with a RAISE EXCEPTION on any unconverted row).
      "20271106000000_legal_hold_canonical",
      "20271107000000_legal_hold_backfill",
      "20271108000000_legal_hold_legacy_removal",
      // PHASE 12B CLUSTER 9 — `workspace_governance_policies.version`, the
      // optimistic-concurrency column that turns PUT /v1/governance/policy from
      // a blind last-write-wins upsert into a conditional UPDATE. Additive,
      // idempotent, forward-only; unapplied.
      "20271109000000_workspace_governance_policy_version",
      // PHASE 12B (Exchange cluster) — truthful download semantics on
      // evidence_exchange_package_deliveries. Additive; unapplied. Registered
      // here because it already exists in the tree and this allowlist is the
      // "later phases may add their own" register, not a suppression: any
      // migration NOT listed here still fails this assertion.
      "20271110000000_exchange_download_authorization_semantics",
      // PHASE 12B B3 — binds a step-up challenge to the session that started it
      // and to the Organization it was minted against, so an approved
      // elevation stops behaving like a bearer token replayable from another
      // device. Both columns are NULLABLE and additive; forward-only; the
      // service enforces "must match WHEN PRESENT" so no backfill is needed.
      // Unapplied.
      "20271111000000_step_up_session_organization_binding",
      // PHASE 12 POINT 4 — schema-authority convergence. Drops 3 superseded
      // singular audit tables (zero runtime references; the canonical PLURAL
      // tables the Prisma models map are the live ones), 5 duplicate columns a
      // catch-up migration added alongside their @map-ed originals (three of
      // them NOT NULL, which made delegatedAdminGrant.create /
      // crossOrgReviewGrant.create / redactionPolicyAssignment.create fail
      // outright), and converts security_events.severity from the enum to the
      // VARCHAR production already uses. Every drop is guarded and RAISES
      // rather than destroying ambiguous data. Unapplied.
      // PHASE 12 POINT 6 — SPLIT. The repair that unblocks the three broken
      // `create()` paths (relaxing the orphaned NOT NULL duplicates) and the
      // severity type convergence are non-destructive and ship in Release A;
      // the physical removal of the five duplicate columns and the three
      // superseded singular tables is a CONTRACT step and ships in Release D.
      "20271112000000_point4_write_unblock_repair",
      "20271117000000_point4_schema_authority_contract",
      // PHASE 12 POINT 5 — durable report/package generation authority. Adds
      // ONE new table (report_generation_requests) so the authorization
      // outcome that permits regenerating a finalised report is persisted by
      // the authorized synchronous path instead of riding on a BullMQ payload
      // as an unverified boolean. Pure-additive, forward-only, no backfill.
      // Unapplied.
      "20271113000000_point5_report_generation_authority",
      // PHASE 12 POINT 5 — widen media_intelligence_runs.kind to the catalog
      // the worker actually implements. The CHECK constraint enumerated eight
      // kinds while twelve were reachable, so four kinds that real producers
      // enqueue (compute_perceptual_hashes, extract_ocr_azure,
      // extract_transcript_deepgram, extract_technical_metadata) could not
      // have a run row inserted for them AT ALL. That is the root cause behind
      // `enqueueMediaIntelligenceAnalysis` having an OPTIONAL `runId`: the
      // producer could not create the durable row, so it was allowed to
      // proceed without one, and those jobs ran with nothing to record their
      // state on. Strict superset — no existing row can violate it.
      // Forward-only, guarded, idempotent. Unapplied.
      "20271114000000_point5_media_intelligence_kind_catalog",
      // PHASE 12 POINT 5 (2026-08-04) — three partial unique indexes that
      // make three documented-but-nonexistent claims real: one RUNNING
      // governance reconciliation run per (kind, lock_key), one non-terminal
      // DestructionExecution per review, one in-flight ArchiveTierTransition
      // per evidence. Each was a read-then-write, so two sweeps both saw an
      // empty slot and both took it — for the destruction family that meant
      // two certificates and two ledger rows for one approved destruction.
      // Pre-existing duplicates are resolved forward (newest keeps the slot,
      // older recorded as FAILED with a bounded reason) before each index is
      // built. Guarded, idempotent, forward-only. Unapplied.
      "20271115000000_point5_atomic_sweep_claims",
      // PHASE 12 POINT 6 — CONTRACT PRECONDITION for
      // 20270924000000_drop_workspace_persona_profiles. That migration is
      // tracked in git, so its bytes (and therefore its Prisma checksum) must
      // not change; the guard that refuses its `DROP ... CASCADE` when a
      // foreign key or view still depends on the table is added as a
      // lexically preceding migration instead. Measures and RAISEs only.
      "20270923500000_persona_profiles_removal_precondition",
      // PHASE 12 POINT 6 — post-cutover tightening of the legal-hold
      // scope/target CHECK to `EVIDENCE ⇒ case_id IS NULL`. The EXPAND step
      // installs the relaxed branch because the pre-cutover build still
      // writes the contextual tag; this migration refuses (never blanks) if
      // any tagged row remains. Release D.
      "20271118000000_legal_hold_strict_scope_target",
      // PHASE 12 POINT 8 — belongs to Point 8, NOT to Phase 32.7.2; listing it
      // here permits it, it does not attribute it.
      //
      // It repairs an extension-ORDERING defect.
      // `20260620100000_phase24_31_consolidated_drift_patches` creates
      // `evidence_search_documents.embedding` and its IVFFLAT index inside
      // `IF has_pgvector`, but `CREATE EXTENSION vector` is not issued until
      // `20270701000000_phase15_semantic_search` — a year later in lexical
      // order — so on every database built from this chain the guard is false
      // when evaluated and both objects are silently skipped, while the
      // datamodel goes on declaring the column. Additive, idempotent, and it
      // RAISEs rather than skipping when pgvector is absent.
      "20271119000000_search_document_embedding_after_extension",
      // PHASE 12 CORRECTIVE PASS §2/§3 (2026-08-06) — INV-001 + NEW-004.
      //
      // Not attributable to Phase 32.7.2 and unrelated to security-event
      // mapping. Together they establish ONE authority for an external-review
      // invitation and a DURABLE identity for each message sent about it:
      // expand adds `token_version` plus the delivery intent columns, backfill
      // classifies existing rows deterministically WITHOUT renumbering
      // `attempt`, and contract enforces the invariants and drops the five
      // duplicate lifecycle columns behind readiness checks that ship in the
      // same file and RAISE rather than destroy.
      //
      // They replace `20271120000000_external_review_delivery_intent_
      // idempotency`, which keyed the intent on `attempt` and re-numbered
      // history to make that key creatable.
      "20271120000000_external_review_invitation_authority_expand",
      "20271121000000_external_review_invitation_authority_backfill",
      "20271122000000_external_review_invitation_authority_contract",
      // PHASE 12 CORRECTIVE PASS §5.2 (2026-08-06) — ARCH-002. The workspace
      // kind becomes MANDATORY and stops being derivable from a commercial
      // plan. Unrelated to Phase 32.7.2 security-event mapping.
      "20271123000000_workspace_kind_authority_expand",
      "20271124000000_workspace_kind_authority_backfill",
      "20271125000000_workspace_kind_authority_contract",
      // PHASE 12 CORRECTIVE PASS §2 (2026-08-07) — ARCH-004. Organization
      // membership gains ACTIVE/SUSPENDED/REVOKED so revocation stops being a
      // physical delete. Unrelated to Phase 32.7.2 security-event mapping.
      "20271126000000_org_membership_lifecycle_expand",
      "20271127000000_org_membership_lifecycle_backfill",
      "20271128000000_org_membership_lifecycle_contract",
      // PHASE 12 CORRECTIVE PASS §2 CONTINUATION (2026-08-07) — ARCH-005. The
      // Automation runtime gains a lease, a monotonic claim fence, an attempt
      // counter, a retry schedule and a dead-letter state, so a run can no
      // longer be claimed twice, overwritten by a stalled worker, or left
      // permanently RUNNING. Unrelated to Phase 32.7.2 security-event mapping.
      "20271129000000_automation_runtime_durability_expand",
      "20271130000000_automation_runtime_durability_backfill",
      "20271131000000_automation_runtime_durability_contract",
      // PHASE 13 (NEW-058) — binds a step-up challenge to the enrolled contact
      // factor it was minted against (adds the factor columns + their index and
      // the sealed-destination columns on `mfa_factors`). Not attributable to
      // Phase 32.7.2; permitted by name, like every entry above.
      "20271201000000_new058_verified_contact_factors",
      // REDESIGN/SEARCH — adds SEARCH_INDEX to `GovernanceReconciliationKind`,
      // so Search reconciliation claims the SAME per-workspace slot the
      // governance families already use. One `ADD VALUE IF NOT EXISTS`; no
      // table, no column, no security-event mapping. Not attributable to
      // Phase 32.7.2; permitted by name, like every entry above.
      "20271215000000_search_index_reconciliation_kind",
    ]);

  /** The gate itself, unchanged: exact-name membership, nothing else. */
  const unpermitted = (entries: readonly string[]): string[] =>
    entries.filter((name) => {
      const m = name.match(/^(\d{14})/);
      if (!m) return false;
      if (m[1] <= "20260620300000") return false;
      return !PERMITTED_LATER_MIGRATIONS.has(name);
    });

  const migrationsDir = fileURLToPath(
    new URL("../prisma/migrations/", import.meta.url),
  );
  const onDisk = readdirSync(migrationsDir).filter((name) => {
    const full = `${migrationsDir}${name}`;
    try {
      return statSync(full).isDirectory();
    } catch {
      return false;
    }
  });

  it("no Phase 32.7.2-attributable migration was added (later phases may add their own)", () => {
    expect(unpermitted(onDisk)).toEqual([]);
  });

  it("the Point-8 extension-ordering repair is permitted", () => {
    const POINT8 = "20271119000000_search_document_embedding_after_extension";
    expect(onDisk).toContain(POINT8);
    expect(unpermitted([POINT8])).toEqual([]);
  });

  it("an arbitrary fictional migration is still REJECTED", () => {
    expect(unpermitted(["20991231000000_fictional_never_reviewed"])).toEqual([
      "20991231000000_fictional_never_reviewed",
    ]);
  });

  it("a migration with a similar prefix is REJECTED — this is not prefix matching", () => {
    // Same timestamp, different name; and the real name with a suffix. Both
    // must fail, or the allowlist has quietly become a pattern.
    expect(
      unpermitted([
        "20271119000000_search_document_embedding_after_extension_v2",
        "20271119000000_something_else_entirely",
        "20271119000001_search_document_embedding_after_extension",
      ]),
    ).toEqual([
      "20271119000000_search_document_embedding_after_extension_v2",
      "20271119000000_something_else_entirely",
      "20271119000001_search_document_embedding_after_extension",
    ]);
  });

  it("the allowlist is a set of exact names, not a range or a wildcard", () => {
    for (const name of PERMITTED_LATER_MIGRATIONS) {
      expect(name, `${name} must be an exact migration directory name`).toMatch(
        /^\d{14}_[a-z0-9_]+$/,
      );
      expect(name).not.toContain("*");
    }
    // Every permitted name must actually exist on disk — an allowlist entry
    // for a migration nobody can find is how a range creeps in unnoticed.
    for (const name of PERMITTED_LATER_MIGRATIONS) {
      expect(onDisk, `${name} is allow-listed but absent from the tree`).toContain(name);
    }
  });

  it("the Point-8 migration is not misattributed to Phase 32.7.2", () => {
    // Phase 32.7.2's own claim is that IT authored no migration. Permitting a
    // later phase's migration must not turn into owning it.
    const sql = readFileSync(
      `${migrationsDir}20271119000000_search_document_embedding_after_extension/migration.sql`,
      "utf8",
    );
    expect(sql).toContain("PHASE 12 POINT 8");
    expect(sql).not.toMatch(/32\.7\.2/);
  });
});
