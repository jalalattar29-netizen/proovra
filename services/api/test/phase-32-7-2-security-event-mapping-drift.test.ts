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

const SCHEMA = readSchema();
const SECURITY_EVENT = extractModelBlock(SCHEMA, "SecurityEvent");
const EVIDENCE_LEGAL_HOLD = extractModelBlock(SCHEMA, "EvidenceLegalHold");
const CASE_LEGAL_HOLD = extractModelBlock(SCHEMA, "CaseLegalHold");
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
    expect(EVIDENCE_LEGAL_HOLD).toMatch(
      /evidenceId\s+String\s+@map\("evidence_id"\)/,
    );
    expect(EVIDENCE_LEGAL_HOLD).toMatch(/caseId\s+String\?\s+@map\("case_id"\)/);
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

describe("Phase 32.7.2 — CaseLegalHold model preserved (snake_case)", () => {
  it("all key fields map to snake_case production columns", () => {
    expect(CASE_LEGAL_HOLD).toMatch(/teamId\s+String\s+@map\("team_id"\)/);
    expect(CASE_LEGAL_HOLD).toMatch(/caseId\s+String\s+@map\("case_id"\)/);
    expect(CASE_LEGAL_HOLD).toMatch(
      /placedByUserId\s+String\s+@map\("placed_by_user_id"\)/,
    );
    expect(CASE_LEGAL_HOLD).toMatch(
      /placedAtUtc\s+DateTime[\s\S]{0,80}@map\("placed_at_utc"\)/,
    );
    expect(CASE_LEGAL_HOLD).toMatch(
      /releasedByUserId\s+String\?\s+@map\("released_by_user_id"\)/,
    );
    expect(CASE_LEGAL_HOLD).toMatch(
      /releasedAtUtc\s+DateTime\?\s+@map\("released_at_utc"\)/,
    );
  });

  it("@@map(\"case_legal_holds\")", () => {
    expect(CASE_LEGAL_HOLD).toMatch(/@@map\("case_legal_holds"\)/);
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
  it("no Phase 32.7.2-attributable migration was added (later phases may add their own)", () => {
    const migrationsDir = fileURLToPath(
      new URL("../prisma/migrations/", import.meta.url),
    );
    const entries = readdirSync(migrationsDir).filter((name) => {
      const full = `${migrationsDir}${name}`;
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    });
    // Phase 32.7.2 itself must NOT have added a migration (the fix is
    // Prisma-side only). Later phases legitimately author their own and
    // are allow-listed here.
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
    ]);
    const newer = entries.filter((name) => {
      const m = name.match(/^(\d{14})/);
      if (!m) return false;
      if (m[1] <= "20260620300000") return false;
      return !PERMITTED_LATER_MIGRATIONS.has(name);
    });
    expect(newer).toEqual([]);
  });
});
