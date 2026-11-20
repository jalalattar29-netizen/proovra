/**
 * THE PREFLIGHT MUST NOT REPORT HEALTHY AGAINST THE PREVIOUS SCHEMA.
 *
 * The deploy this pins: code ships before its migrations, the preflight passes
 * — the URL is local, no migration carries a blocked pattern, the migration
 * files match the schema — and the first Operations request answers
 * `column "scope" does not exist`. Every check that passed was about the
 * REPOSITORY. None asked the database.
 *
 * The four cases below are the four states a rollout can actually be in, and
 * the two half-applied ones matter most: the release needs an enum value from
 * one migration AND a column from another, so a database can satisfy either
 * half and still be unable to serve a request. A check that looked for one
 * object would call both of those healthy.
 *
 * They run against an INJECTED probe rather than a live catalog. That is not a
 * shortcut — a live database can be in exactly one state per run, so proving
 * the half-applied cases against one would mean mutating a real schema into a
 * shape no migration produces. The probe is the seam the module already
 * exposes, and the SQL it hands back is asserted separately to be read-only.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as requirementsModule from "../scripts/runtime-schema-requirements.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = resolve(HERE, "../scripts/runtime-schema-requirements.mjs");
const MIGRATIONS_DIR = resolve(HERE, "../prisma/migrations");

type Requirement = {
  id: string;
  kind: string;
  detail: string;
  requiredBy: string;
  suppliedBy: string;
};
type CheckResult = {
  ok: boolean;
  missing: Requirement[];
  indeterminate: string[];
};
type Mod = {
  RUNTIME_SCHEMA_REQUIREMENTS: ReadonlyArray<Requirement>;
  checkRuntimeSchemaRequirements: (
    probe: (sql: string) => Promise<boolean>,
  ) => Promise<CheckResult>;
  describeRuntimeSchemaFailure: (r: {
    missing: Requirement[];
    indeterminate: string[];
  }) => string;
};

// Statically imported (an in-test dynamic import can time out under load);
// `load` keeps the call sites' shape.
const load = async (): Promise<Mod> => requirementsModule as unknown as Mod;

/**
 * 20281121* — the 0376721d9 remediation release, object by object. Each entry
 * is the requirement id and the SQL shape its probe must have; matched before
 * every older matcher, several of which would otherwise claim these probes
 * (e.g. any `report_generation_requests` probe, any `authenticated_sessions`
 * column, any `disclosure_profile` column).
 */
const RELEASE_0376721_OBJECTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["external_identity_mappings.link_source", /table_name = 'external_identity_mappings'\s+AND column_name = 'link_source'/],
  ["authenticated_sessions.parent_session_id_hash", /table_name = 'authenticated_sessions'\s+AND column_name = 'parent_session_id_hash'/],
  ["authenticated_sessions_user_id_parent_session_id_hash_idx", /indexname = 'authenticated_sessions_user_id_parent_session_id_hash_idx'/],
  ["subscriptions.provider_intent_key", /table_name = 'subscriptions'\s+AND column_name = 'provider_intent_key'/],
  ["subscriptions.provider_intent_at_utc", /table_name = 'subscriptions'\s+AND column_name = 'provider_intent_at_utc'/],
  ["subscriptions.customer_cancel_requested_at_utc", /table_name = 'subscriptions'\s+AND column_name = 'customer_cancel_requested_at_utc'/],
  ["evidence_exchange_packages.disclosure_profile", /table_name = 'evidence_exchange_packages'\s+AND column_name = 'disclosure_profile'/],
  ["evidence_extracted_texts.source_part_id", /table_name = 'evidence_extracted_texts'\s+AND column_name = 'source_part_id'/],
  ["evidence_extracted_texts_part_claim_uniq", /x\.relname = 'evidence_extracted_texts_part_claim_uniq'/],
  ["evidence.released_objects_removed_at_utc", /table_name = 'evidence'\s+AND column_name = 'released_objects_removed_at_utc'/],
  ["case_siu_exports.includes_pii", /table_name = 'case_siu_exports'\s+AND column_name = 'includes_pii'/],
  ["case_siu_exports.included_evidence_ids", /table_name = 'case_siu_exports'\s+AND column_name = 'included_evidence_ids'/],
  ["workspace_ownership_offers.table", /information_schema\.tables[\s\S]*table_name = 'workspace_ownership_offers'/],
  ["coding_value_history.table", /information_schema\.tables[\s\S]*table_name = 'coding_value_history'/],
  ["redaction_page_previews.table", /information_schema\.tables[\s\S]*table_name = 'redaction_page_previews'/],
  ["redaction_page_previews_project_id_page_index_key", /x\.relname = 'redaction_page_previews_project_id_page_index_key'/],
  ["governance_reconciliation_runs.heartbeat_at_utc", /table_name = 'governance_reconciliation_runs'\s+AND column_name = 'heartbeat_at_utc'/],
  ["evidence_exchange_packages.quota_reserved_period_start_utc", /table_name = 'evidence_exchange_packages'\s+AND column_name = 'quota_reserved_period_start_utc'/],
  ["governance_reconciliation_kind.archive_restore", /typname = 'GovernanceReconciliationKind'\s+AND e\.enumlabel = 'ARCHIVE_RESTORE'/],
  ["report_generation_requests.storage_reserved_bytes", /table_name = 'report_generation_requests'\s+AND column_name = 'storage_reserved_bytes'/],
  ["operational_workflow_events.idempotency_token", /table_name = 'operational_workflow_events'\s+AND column_name = 'idempotency_token'/],
  ["operational_workflow_events_team_id_idempotency_token_key", /x\.relname = 'operational_workflow_events_team_id_idempotency_token_key'/],
  ["bulk_operational_action_runs.idempotency_token", /table_name = 'bulk_operational_action_runs'\s+AND column_name = 'idempotency_token'/],
  ["bulk_operational_action_runs_team_id_idempotency_token_key", /x\.relname = 'bulk_operational_action_runs_team_id_idempotency_token_key'/],
];
const RELEASE_0376721_IDS = RELEASE_0376721_OBJECTS.map(([id]) => id);

/** 20281122000000 (M676) — the two derived-asset storage reservation columns. */
const DERIVED_STORAGE_RESERVATION_COLUMNS =
  /table_name = 'evidence_part_derived_assets'\s+AND column_name = 'storage_reserved_(bytes|at_utc)'/;

/**
 * A database in a given state, expressed as the objects it HAS.
 *
 * Matching on the probe SQL rather than on a requirement id is deliberate: it
 * exercises the real probe strings, so a probe that looks for the wrong object
 * fails here instead of passing against a fixture keyed to its own name.
 */
/** Every column the commercial remediation migrations add. */
const COMMERCIAL_REMEDIATION_COLUMNS =
  /'credential_proven_at_utc'|'pending_enterprise_workspace_name'|'external_contract_ref'|'status_before_termination'|'primary_interest'|'organization_type'/;

function databaseWith(present: {
  reconciliationEnumValue?: boolean;
  incidentScopeType?: boolean;
  scopeColumn?: boolean;
  scopeIndex?: boolean;
  metricSnapshotColumn?: boolean;
  workspaceClosedAtColumn?: boolean;
  inviteTokenHashColumn?: boolean;
  inviteRevokedAtColumn?: boolean;
  // P3-9 — the output/commercial tables and their load-bearing uniqueness.
  reportGenerationRequestsTable?: boolean;
  reportGenerationRequestsIdempotencyUnique?: boolean;
  evidenceCreditLedgerTable?: boolean;
  evidenceCreditLedgerEvidenceIdUnique?: boolean;
  // INTERNAL PLAN GRANT (20281002000000).
  planGrantsTable?: boolean;
  // UC-0 — the acquisition/provenance foundation (20280601000000).
  uc0AcquisitionFoundation?: boolean;
  // UC capture closure (20281001000000 / 000400 / 000600) — columns the
  // Evidence and derived-asset models declare.
  ucCaptureClosureColumns?: boolean;
  disclosureProfileColumn?: boolean;
  packageProfileRows?: boolean;
  signingKeyPurpose?: boolean;
  otsTruthColumns?: boolean;
  incidentMessageCode?: boolean;
  threeDecisions?: boolean;
  captureClientAttempt?: boolean;
  disclosurePolicy?: boolean;
  // 20281028000000 — team archive and step-up assurance, object by object.
  teamArchiveStepUp?: StepUpState;
  // 20281029000000 — the combined screen recording's three widened CHECKs.
  combinedRecording?: { runKind?: boolean; assetKind?: boolean; sizeCeiling?: boolean };
  // 20281030000000 — billing remediation columns and tables.
  billingRemediation?: boolean;
  // 20281031000000 — billing product decisions.
  billingDecisions?: boolean;
  // 20281101000000 — Stripe customer per recurring currency.
  customerCurrency?: boolean;
  // 20281106000000 — the sealed OIDC client secret.
  sealedClientSecret?: boolean;
  // 20281104000000 onward — the commercial remediation columns.
  commercialRemediation?: boolean;
  // 20281102000000 — destruction governance truth.
  destructionTruth?: boolean;
  // 20281121* — the ids (RELEASE_0376721_OBJECTS) of the objects present.
  release0376721?: ReadonlyArray<string>;
  // 20281122000000 — M676, the derived-asset storage reservation columns.
  derivedStorageReservation?: boolean;
}) {
  return async (sql: string): Promise<boolean> => {
    const release = RELEASE_0376721_OBJECTS.find(([, shape]) => shape.test(sql));
    if (release) return (present.release0376721 ?? []).includes(release[0]);
    if (DERIVED_STORAGE_RESERVATION_COLUMNS.test(sql)) return present.derivedStorageReservation === true;
    if (/'client_secret_sealed'/.test(sql)) return present.sealedClientSecret === true;
    if (COMMERCIAL_REMEDIATION_COLUMNS.test(sql)) {
      return present.commercialRemediation === true;
    }
    if (sql.includes("execution_requested_at_utc")) return present.destructionTruth === true;
    if (/table_name = 'billing_provider_customers'\s+AND column_name = 'currency'/.test(sql)) {
      return present.customerCurrency === true;
    }
    if (/'addon_end_consent_plan'|'depends_on_plan_grant_id'|'billing_provider_customers'/.test(sql)) {
      return present.billingDecisions === true;
    }
    if (/'provider_schedule_id'|'refunded_amount_cents'|'payment_adjustments'|'billing_provider_binding_checks'/.test(sql)) {
      return present.billingRemediation === true;
    }
    // 20281029000000 — CHECK definitions; matched before anything that names
    // the derived-asset table.
    const combined = present.combinedRecording ?? {};
    if (sql.includes("media_intelligence_runs_kind_bounded")) {
      return combined.runKind === true && sql.includes("combine_screen_recording");
    }
    if (sql.includes("evidence_part_derived_assets_kind_bounded")) {
      return combined.assetKind === true && sql.includes("screen_recording_combined");
    }
    if (sql.includes("evidence_part_derived_assets_size_bounded")) {
      return combined.sizeCeiling === true && sql.includes("671088640");
    }
    // 20281028000000 — matched FIRST: its column probes name tables no other
    // matcher knows, and its CHECK probe must not fall through to anything.
    const stepUp = present.teamArchiveStepUp ?? {};
    if (sql.includes("typname = 'MfaFactorKind'")) return stepUp.passkeyEnum === true;
    if (sql.includes("mfa_factors_kind_payload_chk")) return stepUp.passkeyCheck === true;
    if (sql.includes("indisunique") && sql.includes("'mfa_webauthn_credentials'")) {
      return sql.includes("'credential_id'") ? stepUp.credentialIdUnique === true : stepUp.factorIdUnique === true;
    }
    if (sql.includes("information_schema.tables") && sql.includes("'mfa_webauthn_credentials'")) {
      return stepUp.credentialTable === true;
    }
    const stepUpColumn = /table_name = '(step_up_challenges|organization_security_policies|authenticated_sessions|collaboration_teams)'\s+AND column_name = '(\w+)'/.exec(sql);
    if (stepUpColumn) return (stepUp.columns ?? []).includes(`${stepUpColumn[1]}.${stepUpColumn[2]}`);
    if (sql.includes("WORKSPACE_OPERATIONS")) return present.reconciliationEnumValue === true;
    if (sql.includes("typname = 'IncidentScope'")) return present.incidentScopeType === true;
    if (sql.includes("column_name = 'scope'")) return present.scopeColumn === true;
    if (sql.includes("operational_incidents_scope_team_status_idx")) {
      return present.scopeIndex === true;
    }
    // OPERATIONS LIFECYCLE CLOSURE — the current-value column. An aggregate
    // condition's number lives here, refreshed on every observation; without
    // it the number returns to the title, where the writer never rewrote it
    // and a backlog of 26 stayed 26 for the life of the condition.
    if (sql.includes("column_name = 'metric_snapshot'")) {
      return present.metricSnapshotColumn === true;
    }
    // ADM-004 — THE workspace-liveness authority. Without it, every control
    // plane population query cannot tell a closed workspace from a live one.
    if (sql.includes("column_name = 'closed_at_utc'")) {
      return present.workspaceClosedAtColumn === true;
    }
    // WORKSPACE INVITATION LIFECYCLE (Release A, 20280501000000). `token_hash`
    // is the sole lookup authority for accepting an invitation; `revoked_at` is
    // named in the WHERE of every pending-invitation reader. A database without
    // them fails those reads outright rather than degrading — which is exactly
    // how the absence surfaced in production: a Prisma error naming no column,
    // raised inside a live request, because nothing declared the requirement
    // here for the preflight to check.
    if (sql.includes("table_name = 'team_invites'") && sql.includes("token_hash")) {
      return present.inviteTokenHashColumn === true;
    }
    if (sql.includes("table_name = 'team_invites'") && sql.includes("revoked_at")) {
      return present.inviteRevokedAtColumn === true;
    }
    /*
     * P3-9 (2026-09-10) — the two tables the whole output experience rests on,
     * and the two uniqueness properties that make them correct.
     *
     * The UNIQUE-index probes are matched FIRST and are told apart by the
     * column they assert on, because a name match would not distinguish them:
     * both are `pg_index` queries and both name a table.
     */
    if (sql.includes("indisunique") && sql.includes("idempotency_key")) {
      return present.reportGenerationRequestsIdempotencyUnique === true;
    }
    if (sql.includes("indisunique") && sql.includes("evidence_id")) {
      return present.evidenceCreditLedgerEvidenceIdUnique === true;
    }
    if (sql.includes("table_name = 'report_generation_requests'")) {
      return present.reportGenerationRequestsTable === true;
    }
    if (
      sql.includes("column_name = 'signing_key_sha256'") ||
      sql.includes("column_name = 'generation_parameters'") ||
      (sql.includes("table_name = 'evidence_part_derived_assets'") && sql.includes("column_name = 'storage_version_id'"))
    ) {
      return present.ucCaptureClosureColumns === true;
    }
    // 20281006000000 — one row per package profile, reserved before it is built.
    if (sql.includes("verification_packages_external_version_key") || (sql.includes("table_name = 'verification_packages'") && sql.includes("column_name = 'state'"))) {
      return present.packageProfileRows === true;
    }
    // 20281006000100 — every signing key states its purpose.
    if (sql.includes("table_name = 'signing_keys'") && sql.includes("column_name = 'purpose'")) {
      return present.signingKeyPurpose === true;
    }
    // 20281015120000 — the capture attempt id (AUD-026).
    if (sql.includes("table_name = 'capture_sessions'") && sql.includes("column_name = 'client_attempt_id'")) {
      return present.captureClientAttempt === true;
    }
    // 20281018000000 — the verification disclosure policy and the share download grant.
    if (
      (sql.includes("table_name = 'evidence'") && sql.includes("column_name = 'verification_disclosure_mode'")) ||
      (sql.includes("table_name = 'verification_share_tokens'") && sql.includes("column_name = 'allow_original_download'"))
    ) {
      return present.disclosurePolicy === true;
    }
    // 20281014000000 — canonical verification identity + archive restore requests.
    if (
      (sql.includes("table_name = 'evidence'") && sql.includes("column_name = 'verification_ref'")) ||
      sql.includes("table_name = 'evidence_archive_restore_requests'")
    ) {
      return present.threeDecisions === true;
    }
    // 20281013000000 — the condition message code and params.
    if (sql.includes("table_name = 'operational_incidents'") && sql.includes("column_name = 'message_code'")) {
      return present.incidentMessageCode === true;
    }
    // 20281012000000 — the OTS attestation / chain-check columns.
    if (sql.includes("table_name = 'evidence'") && sql.includes("column_name = 'ots_chain_verification_status'")) {
      return present.otsTruthColumns === true;
    }
    // 20281005000000 — the package row's disclosure profile.
    if (sql.includes("column_name = 'disclosure_profile'")) {
      return present.disclosureProfileColumn === true;
    }
    if (sql.includes("table_name = 'plan_grants'")) {
      return present.planGrantsTable === true;
    }
    if (sql.includes("table_name = 'evidence_credit_ledger_entries'")) {
      return present.evidenceCreditLedgerTable === true;
    }
    // UC-0 (20280601000000) — one migration supplies all seven objects.
    if (
      sql.includes("column_name = 'acquisition_mode'") ||
      sql.includes("column_name = 'artifact_class'") ||
      sql.includes("typname = 'CaptureSessionStatus'") ||
      sql.includes("column_name = 'nonce_sha256'") ||
      sql.includes("column_name = 'acquisition_mode_snapshot'") ||
      sql.includes("column_name = 'verifier_version'") ||
      sql.includes("evidence_part_derived_assets_team_part_kind_variant_uk")
    ) {
      return present.uc0AcquisitionFoundation === true;
    }
    throw new Error(`unrecognised probe:\n${sql}`);
  };
}

type StepUpState = {
  passkeyEnum?: boolean;
  passkeyCheck?: boolean;
  credentialTable?: boolean;
  credentialIdUnique?: boolean;
  factorIdUnique?: boolean;
  /** present columns, as "table.column" */
  columns?: string[];
};

const STEP_UP_COLUMNS = [
  "step_up_challenges.method",
  "step_up_challenges.sso_connection_id",
  "step_up_challenges.authn_context",
  "step_up_challenges.webauthn_challenge",
  "step_up_challenges.handoff_token_hash",
  "step_up_challenges.handoff_used_at_utc",
  "organization_security_policies.step_up_assurance",
  "organization_security_policies.step_up_sms_allowed",
  "organization_security_policies.idp_step_up_accepted_contexts",
  "organization_security_policies.idp_step_up_max_age_seconds",
  "authenticated_sessions.auth_method",
  "authenticated_sessions.authn_context",
  "authenticated_sessions.idp_auth_at_utc",
  "collaboration_teams.archived_by_user_id",
  "collaboration_teams.archive_reason",
];

const STEP_UP_APPLIED: StepUpState = {
  passkeyEnum: true,
  passkeyCheck: true,
  credentialTable: true,
  credentialIdUnique: true,
  factorIdUnique: true,
  columns: STEP_UP_COLUMNS,
};

const FULLY_MIGRATED = {
  commercialRemediation: true,
  billingRemediation: true,
  billingDecisions: true,
  customerCurrency: true,
  sealedClientSecret: true,
  destructionTruth: true,
  teamArchiveStepUp: STEP_UP_APPLIED,
  reconciliationEnumValue: true,
  incidentScopeType: true,
  scopeColumn: true,
  scopeIndex: true,
  metricSnapshotColumn: true,
  workspaceClosedAtColumn: true,
  inviteTokenHashColumn: true,
  inviteRevokedAtColumn: true,
  reportGenerationRequestsTable: true,
  reportGenerationRequestsIdempotencyUnique: true,
  evidenceCreditLedgerTable: true,
  planGrantsTable: true,
  evidenceCreditLedgerEvidenceIdUnique: true,
  uc0AcquisitionFoundation: true,
  ucCaptureClosureColumns: true,
  disclosureProfileColumn: true,
  packageProfileRows: true,
  signingKeyPurpose: true,
  otsTruthColumns: true,
  incidentMessageCode: true,
  threeDecisions: true,
  captureClientAttempt: true,
  disclosurePolicy: true,
  combinedRecording: { runKind: true, assetKind: true, sizeCeiling: true },
  release0376721: RELEASE_0376721_IDS,
  derivedStorageReservation: true,
};

describe("runtime schema requirements", () => {
  it("the PREVIOUS schema is REFUSED, with a bounded actionable reason", async () => {
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    const result = await checkRuntimeSchemaRequirements(databaseWith({}));

    expect(result.ok, "a pre-migration database must not be reported healthy").toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);

    const reason = describeRuntimeSchemaFailure(result);
    // ACTIONABLE: names the object, the reason and the migration that supplies it.
    expect(reason).toContain('column public."operational_incidents"."scope" must exist');
    expect(reason).toContain("20271223000000_operational_incident_scope");
    expect(reason).toContain("20271222000000_workspace_operations_reconciliation_kind");
    // …and states the ORDER, because applying them the other way round is the
    // mistake the message exists to prevent.
    expect(reason).toContain("20271222000000, commit, then 20271223000000");
    /*
     * BOUNDED: an operator has to be able to read it.
     *
     * P3-9 (2026-09-10) — expressed PER REQUIREMENT rather than as a flat 30.
     *
     * The flat bound was calibrated when there were eight requirements and
     * broke at twelve, which would have made every future declaration a
     * choice between adding a requirement and bumping a magic number — and
     * bumping it is how a bound stops meaning anything.
     *
     * The property that actually matters is that the message stays THREE lines
     * per missing object (the detail, why it is needed, which migration
     * supplies it) plus a header and the ordering footer. That is what makes it
     * readable, and it fails if a requirement starts contributing a paragraph.
     */
    const LINES_PER_REQUIREMENT = 3;
    const FIXED_OVERHEAD = 4;
    expect(reason.split("\n").length).toBeLessThanOrEqual(
      result.missing.length * LINES_PER_REQUIREMENT + FIXED_OVERHEAD,
    );
  });

  it("the verification disclosure columns absent is REFUSED (20281018000000)", async () => {
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    const result = await checkRuntimeSchemaRequirements(databaseWith({ ...FULLY_MIGRATED, disclosurePolicy: false }));
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.id)).toEqual(
      expect.arrayContaining(["evidence.verification_disclosure_mode", "verification_share_tokens.allow_original_download"]),
    );
    expect(describeRuntimeSchemaFailure(result)).toContain("20281018000000_verification_disclosure_policy");
  });

  it("the FULLY MIGRATED schema is accepted", async () => {
    const { checkRuntimeSchemaRequirements } = await load();
    const result = await checkRuntimeSchemaRequirements(databaseWith(FULLY_MIGRATED));
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.indeterminate).toEqual([]);
  });

  it("enum present but the scope COLUMN absent is REFUSED", async () => {
    // 20271222000000 applied, 20271223000000 not. The reconciliation sweep
    // would claim its run and the incident readers would then fail on a column
    // that is not there.
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    const result = await checkRuntimeSchemaRequirements(
      databaseWith({ reconciliationEnumValue: true }),
    );
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.id)).toContain("operational_incidents.scope");
    expect(describeRuntimeSchemaFailure(result)).toContain(
      "20271223000000_operational_incident_scope",
    );
  });

  it("everything else migrated but the invite lifecycle absent is REFUSED", async () => {
    /*
     * THE PRODUCTION FAILURE THIS CLOSES.
     *
     * Release A (20280501000000) shipped code that names `token_hash` and
     * `revoked_at` and no declaration that the database must have them, so the
     * preflight reported healthy against the previous schema — the one answer
     * this module must never give — and the absence surfaced instead as
     *
     *     Invalid `prisma.teamInvite.findMany()` invocation
     *     The column `(not available)` does not exist in the current database
     *
     * inside a live request. A driver error that names no column is exactly the
     * diagnosis this file replaces with "apply 20280501000000".
     */
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    const result = await checkRuntimeSchemaRequirements(
      databaseWith({
        ...FULLY_MIGRATED,
        inviteTokenHashColumn: false,
        inviteRevokedAtColumn: false,
      }),
    );
    expect(result.ok, "a database without Release A must not be reported healthy").toBe(
      false,
    );
    expect(result.missing.map((m) => m.id)).toEqual(
      expect.arrayContaining(["team_invites.token_hash", "team_invites.revoked_at"]),
    );
    const reason = describeRuntimeSchemaFailure(result);
    expect(reason).toContain('column public."team_invites"."token_hash" must exist');
    expect(reason).toContain('column public."team_invites"."revoked_at" must exist');
    // NAMES THE MIGRATION — the whole point is that the operator does not have
    // to work out which one they skipped.
    expect(reason).toContain("20280501000000_workspace_invite_lifecycle_hardening");
  });

  it("the scope column present but the required ENUM VALUE absent is REFUSED", async () => {
    // The mirror image: 20271223000000 applied, 20271222000000 not. Nothing
    // about the incident readers is wrong; scheduled Operations discovery
    // cannot claim its run.
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    // Spread from FULLY_MIGRATED rather than re-listing the others: the claim
    // is "this ONE thing is missing", and a hand-written list makes that claim
    // false the moment a requirement is added — reporting the new requirement
    // as a failure of this scenario instead of exercising it.
    const result = await checkRuntimeSchemaRequirements(
      databaseWith({ ...FULLY_MIGRATED, reconciliationEnumValue: false }),
    );
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.id)).toEqual([
      "governance_reconciliation_kind.workspace_operations",
    ]);
    expect(describeRuntimeSchemaFailure(result)).toContain(
      "20271222000000_workspace_operations_reconciliation_kind",
    );
  });

  it("a probe that THROWS fails closed and never surfaces the raw error", async () => {
    const {
      checkRuntimeSchemaRequirements,
      describeRuntimeSchemaFailure,
      RUNTIME_SCHEMA_REQUIREMENTS,
    } = await load();
    const secret =
      'password authentication failed for user "proovra" at 10.0.0.7:5432';
    const result = await checkRuntimeSchemaRequirements(async () => {
      throw new Error(secret);
    });

    expect(result.ok, "an unreadable catalog is not a healthy one").toBe(false);
    expect(result.indeterminate.length).toBe(RUNTIME_SCHEMA_REQUIREMENTS.length);

    const reason = describeRuntimeSchemaFailure(result);
    expect(reason).toContain("treated as absent");
    // The driver's words are the operator's problem to find in a log, never
    // something this function hands onward.
    expect(reason).not.toContain(secret);
    expect(reason).not.toContain("password");
    expect(reason).not.toContain("10.0.0.7");
  });

  it("every requirement has a probe — a silent pass is the failure mode", async () => {
    const { RUNTIME_SCHEMA_REQUIREMENTS, checkRuntimeSchemaRequirements } = await load();
    const seen: string[] = [];
    await checkRuntimeSchemaRequirements(async (sql) => {
      seen.push(sql);
      return true;
    });
    expect(seen.length).toBe(RUNTIME_SCHEMA_REQUIREMENTS.length);
  });

  it("the probes are read-only catalog reads", async () => {
    // This runs against a production database during a release. It must not be
    // able to write, and must not depend on an application table that a
    // half-migrated database might not have.
    const source = readFileSync(MODULE_PATH, "utf8");
    const probes = source.slice(source.indexOf("const PROBES"), source.indexOf("export async function"));
    for (const banned of ["INSERT", "UPDATE", "DELETE", "ALTER", "CREATE", "DROP"]) {
      expect(probes.toUpperCase(), `a probe must not ${banned}`).not.toContain(` ${banned} `);
    }
    for (const catalog of ["pg_type", "pg_enum", "information_schema.columns", "pg_indexes"]) {
      expect(probes).toContain(catalog);
    }
  });
});

/**
 * P3-9 (2026-09-10) — NEGATIVE CONTRACTS FOR THE OUTPUT/COMMERCIAL TABLES.
 *
 * Each of these was a silent failure before the declaration existed: every
 * reader of `report_generation_requests` catches its own errors (a missing row
 * is a normal state), so an absent TABLE produced no error anywhere — just a
 * product where nothing had ever been requested and nothing could be. These
 * tests are what make "the preflight refuses it" a fact rather than a claim.
 */
describe("runtime schema requirements — output and commercial tables", () => {
  it("a database without report_generation_requests is REFUSED, and says which migration", async () => {
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } =
      await load();
    const result = await checkRuntimeSchemaRequirements(
      databaseWith({ ...FULLY_MIGRATED, reportGenerationRequestsTable: false }),
    );
    expect(
      result.ok,
      "a database with no generation-request table must not be reported healthy",
    ).toBe(false);
    const reason = describeRuntimeSchemaFailure(result);
    expect(reason).toContain('table public."report_generation_requests" must exist');
    expect(reason).toContain("20271113000000_point5_report_generation_authority");
  });

  it("the table WITHOUT its unique idempotency key is REFUSED", async () => {
    // The table alone is not the requirement: without the unique index two
    // concurrent callers both insert, and two runnable requests race for one
    // artifact version.
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } =
      await load();
    const result = await checkRuntimeSchemaRequirements(
      databaseWith({
        ...FULLY_MIGRATED,
        reportGenerationRequestsIdempotencyUnique: false,
      }),
    );
    expect(result.ok).toBe(false);
    expect(describeRuntimeSchemaFailure(result)).toContain("idempotency_key");
  });

  it("a database without evidence_credit_ledger_entries is REFUSED", async () => {
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } =
      await load();
    const result = await checkRuntimeSchemaRequirements(
      databaseWith({ ...FULLY_MIGRATED, evidenceCreditLedgerTable: false }),
    );
    expect(result.ok).toBe(false);
    expect(describeRuntimeSchemaFailure(result)).toContain(
      'table public."evidence_credit_ledger_entries" must exist',
    );
  });

  it("the credit ledger WITHOUT its unique evidence_id is REFUSED", async () => {
    // This uniqueness is the serialization point for credit spend. Without it a
    // retried completion can charge a customer twice for one capture.
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } =
      await load();
    const result = await checkRuntimeSchemaRequirements(
      databaseWith({
        ...FULLY_MIGRATED,
        evidenceCreditLedgerEvidenceIdUnique: false,
      }),
    );
    expect(result.ok).toBe(false);
    expect(describeRuntimeSchemaFailure(result)).toContain("evidence_id");
  });
});

/**
 * 20281028000000 — TEAM ARCHIVE AND STEP-UP ASSURANCE.
 *
 * The release went out with this migration undeclared: the gate passed against
 * the previous schema and the only guard left was the worker's migration-head
 * check, which compares LEDGER rows. A ledger row proves a migration was
 * recorded, not that its objects exist — so each case below is a database the
 * ledger would call current and the release cannot run against.
 */
describe("runtime schema requirements — team archive and step-up assurance (20281028000000)", () => {
  const MIGRATION = "20281028000000_team_archive_step_up_assurance";

  it("none of its objects present is REFUSED, every one named, the migration named", async () => {
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    const result = await checkRuntimeSchemaRequirements(databaseWith({ ...FULLY_MIGRATED, teamArchiveStepUp: {} }));
    expect(result.ok).toBe(false);
    expect(result.indeterminate).toEqual([]);
    expect(result.missing.map((m) => m.id).sort()).toEqual(
      [
        "mfa_factor_kind.passkey",
        "mfa_factors_kind_payload_chk.passkey",
        "mfa_webauthn_credentials.table",
        "mfa_webauthn_credentials.credential_id_unique",
        "mfa_webauthn_credentials.factor_id_unique",
        ...STEP_UP_COLUMNS,
      ].sort(),
    );
    expect(result.missing.every((m) => m.suppliedBy === MIGRATION)).toBe(true);
    const reason = describeRuntimeSchemaFailure(result);
    expect(reason).toContain(MIGRATION);
    expect(reason).toContain('column public."authenticated_sessions"."auth_method" must exist');
  });

  it("the enum value added but the CHECK not widened is REFUSED — enrolment would be rejected", async () => {
    const { checkRuntimeSchemaRequirements } = await load();
    const result = await checkRuntimeSchemaRequirements(
      databaseWith({ ...FULLY_MIGRATED, teamArchiveStepUp: { ...STEP_UP_APPLIED, passkeyCheck: false } }),
    );
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.id)).toEqual(["mfa_factors_kind_payload_chk.passkey"]);
  });

  it("ONE session column absent is REFUSED, and only that column is reported", async () => {
    const { checkRuntimeSchemaRequirements } = await load();
    const result = await checkRuntimeSchemaRequirements(
      databaseWith({
        ...FULLY_MIGRATED,
        teamArchiveStepUp: {
          ...STEP_UP_APPLIED,
          columns: STEP_UP_COLUMNS.filter((c) => c !== "authenticated_sessions.auth_method"),
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.id)).toEqual(["authenticated_sessions.auth_method"]);
  });

  it("the credential table WITHOUT its unique credential_id is REFUSED", async () => {
    const { checkRuntimeSchemaRequirements } = await load();
    const result = await checkRuntimeSchemaRequirements(
      databaseWith({ ...FULLY_MIGRATED, teamArchiveStepUp: { ...STEP_UP_APPLIED, credentialIdUnique: false } }),
    );
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.id)).toEqual(["mfa_webauthn_credentials.credential_id_unique"]);
  });

  it("the CHECK is asserted by its definition, not its name — the pre-widening constraint has the same name", async () => {
    const { checkRuntimeSchemaRequirements } = await load();
    const seen: string[] = [];
    await checkRuntimeSchemaRequirements(async (sql) => {
      seen.push(sql);
      return true;
    });
    const check = seen.find((sql) => sql.includes("mfa_factors_kind_payload_chk"));
    expect(check).toBeDefined();
    expect(check).toContain("pg_get_constraintdef");
    expect(check).toContain("PASSKEY");
  });
});

describe("runtime schema requirements — billing remediation (20281030000000)", () => {
  it("an image that maps these columns is refused on a database without them", async () => {
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    const result = await checkRuntimeSchemaRequirements(databaseWith({ ...FULLY_MIGRATED, billingRemediation: false }));
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.id).sort()).toEqual([
      "billing_provider_binding_checks.table",
      "payment_adjustments.table",
      "payments.refunded_amount_cents",
      "subscriptions.provider_schedule_id",
    ]);
    expect(describeRuntimeSchemaFailure(result)).toContain("20281030000000_billing_remediation_convergence");
  });
});

describe("runtime schema requirements — derived-asset storage reservation (20281122000000, M676)", () => {
  it("an image that reserves derived bytes is refused on a database without the columns", async () => {
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    const result = await checkRuntimeSchemaRequirements(
      databaseWith({ ...FULLY_MIGRATED, derivedStorageReservation: false }),
    );
    expect(result.ok).toBe(false);
    expect(result.indeterminate).toEqual([]);
    expect(result.missing.map((m) => m.id).sort()).toEqual([
      "evidence_part_derived_assets.storage_reserved_at_utc",
      "evidence_part_derived_assets.storage_reserved_bytes",
    ]);
    expect(describeRuntimeSchemaFailure(result)).toContain("20281122000000_derived_asset_storage_reservation");
  });
});

describe("runtime schema requirements — sealed OIDC client secret (20281106000000)", () => {
  it("an image that maps the column is refused on a database without it", async () => {
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    const result = await checkRuntimeSchemaRequirements(databaseWith({ ...FULLY_MIGRATED, sealedClientSecret: false }));
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.id)).toEqual(["sso_connections.client_secret_sealed"]);
    expect(describeRuntimeSchemaFailure(result)).toContain("20281106000000_sso_client_secret_sealed");
  });
});

describe("runtime schema requirements — account credential proof (20281104000000)", () => {
  it("an image that maps the columns is refused on a database without them", async () => {
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    const result = await checkRuntimeSchemaRequirements(databaseWith({ ...FULLY_MIGRATED, commercialRemediation: false }));
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.id)).toEqual(
      expect.arrayContaining(["users.credential_proven_at_utc", "organizations.pending_enterprise_workspace_name"]),
    );
    expect(describeRuntimeSchemaFailure(result)).toContain("20281104000000_account_credential_proof");
  });
});

describe("runtime schema requirements — destruction governance truth", () => {
  it("names the migration when the column is missing", async () => {
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    const result = await checkRuntimeSchemaRequirements(databaseWith({ ...FULLY_MIGRATED, destructionTruth: false }));
    expect(result.missing.map((m) => m.id)).toEqual(["destruction_reviews.execution_requested_at_utc"]);
    expect(describeRuntimeSchemaFailure(result)).toContain("20281102000000");
  });
});

describe("runtime schema requirements — Stripe customer per currency (20281101000000)", () => {
  it("an image that maps the column is refused on a database without it", async () => {
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    const result = await checkRuntimeSchemaRequirements(databaseWith({ ...FULLY_MIGRATED, customerCurrency: false }));
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.id)).toEqual(["billing_provider_customers.currency"]);
    expect(describeRuntimeSchemaFailure(result)).toContain("20281101000000_stripe_customer_per_currency");
  });
});

describe("runtime schema requirements — billing product decisions (20281031000000)", () => {
  it("an image that maps these columns is refused on a database without them", async () => {
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    const result = await checkRuntimeSchemaRequirements(databaseWith({ ...FULLY_MIGRATED, billingDecisions: false }));
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.id).sort()).toEqual([
      "billing_provider_customers.table",
      "subscriptions.addon_end_consent_plan",
      "workspace_storage_addons.depends_on_plan_grant_id",
    ]);
    expect(describeRuntimeSchemaFailure(result)).toContain("20281031000000_billing_product_decisions");
  });
});

/**
 * 20281029000000 — THE COMBINED SCREEN RECORDING. Each CHECK keeps its name
 * when widened, so a database that never applied the swap still has a
 * constraint of that name; only its definition tells them apart.
 */
describe("runtime schema requirements — combined screen recording (20281029000000)", () => {
  const MIGRATION = "20281029000000_screen_recording_combined_derivative";

  it("the narrower CHECKs are REFUSED, each named, the migration named", async () => {
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    const result = await checkRuntimeSchemaRequirements(databaseWith({ ...FULLY_MIGRATED, combinedRecording: {} }));
    expect(result.ok).toBe(false);
    expect(result.indeterminate).toEqual([]);
    expect(result.missing.map((m) => m.id).sort()).toEqual([
      "evidence_part_derived_assets_kind_bounded.screen_recording_combined",
      "evidence_part_derived_assets_size_bounded.combined_ceiling",
      "media_intelligence_runs_kind_bounded.combine_screen_recording",
    ]);
    expect(describeRuntimeSchemaFailure(result)).toContain(MIGRATION);
  });

  it("only the size ceiling missing is refused alone", async () => {
    const { checkRuntimeSchemaRequirements } = await load();
    const result = await checkRuntimeSchemaRequirements(
      databaseWith({ ...FULLY_MIGRATED, combinedRecording: { runKind: true, assetKind: true } }),
    );
    expect(result.missing.map((m) => m.id)).toEqual(["evidence_part_derived_assets_size_bounded.combined_ceiling"]);
  });

  it("the CHECKs are asserted by definition", async () => {
    const { checkRuntimeSchemaRequirements } = await load();
    const seen: string[] = [];
    await checkRuntimeSchemaRequirements(async (sql) => {
      seen.push(sql);
      return true;
    });
    for (const [name, needle] of [
      ["media_intelligence_runs_kind_bounded", "'combine_screen_recording'"],
      ["evidence_part_derived_assets_kind_bounded", "'screen_recording_combined'"],
      ["evidence_part_derived_assets_size_bounded", "671088640"],
    ] as const) {
      const sql = seen.find((s) => s.includes(name));
      expect(sql).toContain("pg_get_constraintdef");
      expect(sql).toContain(needle);
    }
  });
});

/**
 * 20281121* — THE 0376721d9 REMEDIATION RELEASE. It shipped sixteen migrations
 * and declared none of them, so the gate passed against the previous schema
 * and the deploy script replaced the API before the worker's head check
 * refused to start.
 */
describe("runtime schema requirements — the 0376721d9 release (20281121*)", () => {
  it("none of its objects present is REFUSED, every one named with its migration", async () => {
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    const result = await checkRuntimeSchemaRequirements(databaseWith({ ...FULLY_MIGRATED, release0376721: [] }));
    expect(result.ok).toBe(false);
    expect(result.indeterminate).toEqual([]);
    expect(result.missing.map((m) => m.id).sort()).toEqual([...RELEASE_0376721_IDS].sort());
    expect(result.missing.every((m) => /^20281121\d{6}_/.test(m.suppliedBy))).toBe(true);
    const reason = describeRuntimeSchemaFailure(result);
    expect(reason).toContain('column public."subscriptions"."provider_intent_key" must exist');
    expect(reason).toContain("20281121030000_subscription_provider_intent_key");
    expect(reason).toContain("20281121140000_ops_idempotency_reservation");
  });

  it("every one of the sixteen migrations is named by at least one requirement", () => {
    const supplied = new Set(requirementsModule.RUNTIME_SCHEMA_REQUIREMENTS.map((r) => r.suppliedBy));
    const release = readdirSync(MIGRATIONS_DIR).filter((d) => /^20281121\d{6}_/.test(d));
    expect(release).toHaveLength(16);
    expect(release.filter((m) => !supplied.has(m))).toEqual([]);
  });

  it.each(RELEASE_0376721_IDS)("only %s absent is REFUSED, and only it is reported", async (id) => {
    const { checkRuntimeSchemaRequirements } = await load();
    const result = await checkRuntimeSchemaRequirements(
      databaseWith({ ...FULLY_MIGRATED, release0376721: RELEASE_0376721_IDS.filter((x) => x !== id) }),
    );
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.id)).toEqual([id]);
  });

  it("the raw-owned part-claim index is asserted UNIQUE and PARTIAL, the idempotency keys UNIQUE", async () => {
    const { checkRuntimeSchemaRequirements } = await load();
    const seen: string[] = [];
    await checkRuntimeSchemaRequirements(async (sql) => {
      seen.push(sql);
      return true;
    });
    const partClaim = seen.find((s) => s.includes("'evidence_extracted_texts_part_claim_uniq'"));
    expect(partClaim).toContain("i.indisunique");
    expect(partClaim).toContain("i.indpred IS NOT NULL");
    for (const name of [
      "operational_workflow_events_team_id_idempotency_token_key",
      "bulk_operational_action_runs_team_id_idempotency_token_key",
      "redaction_page_previews_project_id_page_index_key",
    ]) {
      const sql = seen.find((s) => s.includes(`'${name}'`));
      expect(sql, name).toContain("i.indisunique");
    }
  });
});

/**
 * THE GUARD. From the 0376721d9 release on, every new migration must be named
 * by at least one runtime requirement — or be listed here with the reason the
 * running code needs nothing from it (e.g. a pure backfill). A migration that
 * adds a column the image maps and is declared nowhere is exactly how the gate
 * came to pass an unmigrated database twice (20281028000000, then 20281121*).
 */
const GUARD_FROM = "20281121000000";
const NOT_A_RUNTIME_REQUIREMENT: Readonly<Record<string, string>> = {};

describe("runtime schema requirements — every new migration is declared", () => {
  it(`every migration from ${GUARD_FROM} on is supplied to a requirement or exempted with a reason`, () => {
    const supplied = new Set(requirementsModule.RUNTIME_SCHEMA_REQUIREMENTS.map((r) => r.suppliedBy));
    const guarded = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{14}_/.test(d.name) && d.name.slice(0, 14) >= GUARD_FROM)
      .map((d) => d.name);
    expect(guarded.length).toBeGreaterThan(0);
    const undeclared = guarded.filter((m) => !supplied.has(m) && !(m in NOT_A_RUNTIME_REQUIREMENT));
    expect(
      undeclared,
      "declare what the migration creates in scripts/runtime-schema-requirements.mjs, " +
        "or add it to NOT_A_RUNTIME_REQUIREMENT with the reason the code needs nothing from it",
    ).toEqual([]);
  });

  it("every suppliedBy names a migration folder that exists", () => {
    const folders = new Set(readdirSync(MIGRATIONS_DIR));
    const unknown = requirementsModule.RUNTIME_SCHEMA_REQUIREMENTS.map((r) => r.suppliedBy).filter(
      (s) => !folders.has(s),
    );
    expect(unknown).toEqual([]);
  });
});

describe("the preflight consumes the declaration", () => {
  const preflight = readFileSync(resolve(HERE, "../scripts/db-preflight.mjs"), "utf8");

  it("db:preflight runs the runtime schema check", () => {
    expect(preflight).toContain("runtime-schema-requirements.mjs");
    expect(preflight).toContain("checkRuntimeSchemaRequirements");
  });

  it("a skip is recorded as WARN, never as PASS", () => {
    // "We did not look" must not read like "it is there".
    const block = preflight.slice(preflight.indexOf("Check 4"));
    const skip = block.slice(block.indexOf("skipDrift || !databaseUrl"), block.indexOf("} else {"));
    expect(skip).toContain('status: "WARN"');
    expect(skip).not.toContain('status: "PASS"');
  });

  it("an unreadable catalog is a FAIL, not a skip", () => {
    const block = preflight.slice(preflight.indexOf("Check 4"));
    const rescue = block.slice(block.indexOf("} catch {"), block.indexOf("} finally {"));
    expect(rescue).toContain('status: "FAIL"');
    expect(rescue).toContain("treated as absent");
  });
});
