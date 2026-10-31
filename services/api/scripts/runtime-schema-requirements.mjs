/**
 * WHAT THE RUNNING CODE REQUIRES OF THE DATABASE — declared, and checked
 * against the database it is actually pointed at.
 *
 * THE FAILURE THIS EXISTS TO PREVENT
 * ---------------------------------------------------------------------------
 * A deploy that applies the code before the migrations passes every check the
 * preflight used to run — the URL is local, no migration carries a blocked
 * pattern, the migration files are in sync with the schema — and then serves
 * its first Operations request with:
 *
 *     column "scope" does not exist
 *
 * Every one of those checks was about the REPOSITORY. None of them asked the
 * connected database whether it has the objects the new readers name. So the
 * preflight reported healthy against the previous schema, which is the one
 * answer it must never give.
 *
 * WHY A DECLARATION RATHER THAN A QUERY PER READER
 * ---------------------------------------------------------------------------
 * The requirement is a property of a RELEASE, not of a statement. Listing it
 * once, with the migration that supplies it and the remedy, means the failure
 * message can say what is missing, which migration provides it and what to run
 * — instead of surfacing a driver error that names a column and leaves the
 * operator to work out which migration they skipped.
 *
 * EXPAND-ONLY, AND THAT IS WHY ROLLBACK IS CODE-FIRST
 * ---------------------------------------------------------------------------
 * Every requirement below is an added enum value, an added column or an added
 * index. None is a narrowing. An OLDER process runs unharmed against the
 * EXPANDED schema — it simply never selects the value and never reads the
 * column — so rolling a release back means reverting API/Worker/Web code and
 * LEAVING the schema expanded. Dropping an enum value is not supported by
 * PostgreSQL, and dropping `scope` would destroy the only record of which
 * incidents were classified deliberately. Neither belongs in a rollback.
 */

/**
 * @typedef {{
 *   id: string,
 *   kind: "enum_type" | "enum_value" | "column" | "index" | "table" | "constraint",
 *   detail: string,
 *   requiredBy: string,
 *   suppliedBy: string,
 * }} RuntimeSchemaRequirement
 */

/** @type {ReadonlyArray<RuntimeSchemaRequirement>} */
export const RUNTIME_SCHEMA_REQUIREMENTS = Object.freeze([
  {
    id: "governance_reconciliation_kind.workspace_operations",
    kind: "enum_value",
    detail: 'enum "GovernanceReconciliationKind" must contain WORKSPACE_OPERATIONS',
    requiredBy:
      "scheduled Operations discovery claims its run through the shared reconciliation-run authority",
    suppliedBy: "20271222000000_workspace_operations_reconciliation_kind",
  },
  {
    id: "incident_scope.type",
    kind: "enum_type",
    detail: 'enum type "IncidentScope" must exist',
    requiredBy: "operational_incidents.scope is typed by it",
    suppliedBy: "20271223000000_operational_incident_scope",
  },
  {
    id: "operational_incidents.scope",
    kind: "column",
    detail: 'column public."operational_incidents"."scope" must exist',
    requiredBy:
      "tenant incident reads are scope-discriminated; without it a workspace read returns other tenants' orphans or fails outright",
    suppliedBy: "20271223000000_operational_incident_scope",
  },
  {
    id: "operational_incidents_scope_team_status_idx",
    kind: "index",
    detail:
      'index "operational_incidents_scope_team_status_idx" must exist on public."operational_incidents"',
    requiredBy: "the scope-discriminated incident readers scan (scope, team_id, status)",
    suppliedBy: "20271223000000_operational_incident_scope",
  },
  {
    id: "operational_incidents.metric_snapshot",
    kind: "column",
    detail: 'column public."operational_incidents"."metric_snapshot" must exist',
    requiredBy:
      "aggregate conditions carry their CURRENT value here, refreshed on every observation. The writer selects it to compute previousValue and delta, and the queue reads it; without the column the number returns to the title, where recordIncident never rewrote it and a backlog of 26 stayed 26 for the life of the condition",
    suppliedBy: "20271225000000_operational_incident_metric_snapshot",
  },
  {
    id: "teams.closed_at_utc",
    kind: "column",
    detail: 'column public."teams"."closed_at_utc" must exist',
    requiredBy:
      "THE workspace-liveness authority. Every Platform Admin population query filters on it through liveWorkspaceWhere()/workspaceLifecycleWhere(), executeWorkspaceClosure writes it inside the closure transaction and reopenClosedWorkspace clears it. Without the column the console cannot distinguish a closed workspace from a live one — the exact defect the column exists to remove — and every one of those readers fails on the first request rather than degrading",
    suppliedBy: "20271230000000_workspace_lifecycle_authority",
  },
  /**
   * WORKSPACE INVITATION LIFECYCLE (Release A, `20280501000000`).
   *
   * These were the columns this module exists for and did not cover. The
   * release shipped code that names them and no declaration that the database
   * must have them, so `db:preflight` reported healthy against the previous
   * schema — the one answer the header above says it must never give — and the
   * absence surfaced instead as
   *
   *     Invalid `prisma.teamInvite.findMany()` invocation
   *     The column `(not available)` does not exist in the current database
   *
   * inside a live request, with a Sentry transaction label that pointed at a
   * neighbouring route because the client issues four workspace reads at once.
   * A driver error naming no column is exactly the diagnosis this file replaces
   * with "apply 20280501000000".
   *
   * Both are declared because they fail differently and both are load-bearing:
   * `token_hash` is the sole lookup authority for accepting an invitation, and
   * `revoked_at` is named in the WHERE of every pending-invitation reader, so
   * without it the seat allowance, the collaboration entitlement projection and
   * the workspace invitation list all fail rather than degrade.
   */
  {
    id: "team_invites.token_hash",
    kind: "column",
    detail: 'column public."team_invites"."token_hash" must exist',
    requiredBy:
      "THE invitation lookup authority. acceptWorkspaceInvitation resolves a link by hashing the raw token and matching this column, and createWorkspaceInvitation/resendWorkspaceInvitation are the only writers of it. Without the column no workspace invitation can be issued or accepted at all",
    suppliedBy: "20280501000000_workspace_invite_lifecycle_hardening",
  },
  {
    id: "team_invites.revoked_at",
    kind: "column",
    detail: 'column public."team_invites"."revoked_at" must exist',
    requiredBy:
      "revocation is a STATE, not a deletion. Every pending-invitation reader filters on it — the workspace invitation list, resolveWorkspaceInvitationAllowance (the seat gate) and the collaboration entitlement projection — so its absence fails those reads outright instead of degrading, and a revoked invitation would otherwise be indistinguishable from a live one",
    suppliedBy: "20280501000000_workspace_invite_lifecycle_hardening",
  },

  /**
   * ==========================================================================
   * P3-9 (2026-09-10) — THE TWO TABLES THE OUTPUT EXPERIENCE NOW RESTS ON.
   * ==========================================================================
   * Both predate this file and neither was declared, and the reason they were
   * missed is the reason they are the most dangerous omission in it: every
   * READER of them degrades gracefully.
   *
   * `reportGenerationRequest` is read through `.catch(() => null)` on the
   * artifact-status projection, an async IIFE with a try/catch in the Reports
   * aggregator, `.catch(() => [])` in the user-scoped fallback and a try/catch
   * in the billing projection — because a missing row is a normal state and
   * those surfaces must render without one. So if the TABLE were absent, no
   * request would fail: every record would simply project `NOT_REQUESTED`,
   * every Generate click would return `REQUEST_PERSIST_FAILED`, and the
   * preflight would report the release healthy. A silent, product-wide output
   * outage with a green deploy — which is precisely the answer the header above
   * says this file must never give.
   *
   * The UNIQUE indexes are declared alongside the tables rather than assumed,
   * because in both cases the uniqueness IS the correctness property:
   *
   *   report_generation_requests.idempotency_key
   *       the version-anchored key is what collapses two concurrent completion
   *       fan-outs into one request and lets the DB elect a single winner of a
   *       supersession race. Without the index both callers succeed and two
   *       runnable requests race for one artifact version.
   *
   *   evidence_credit_ledger_entries.evidence_id
   *       the serialization point for credit spend. Without it a retried
   *       completion can burn a second credit for one record — a customer
   *       charged twice — and `resolveEvidenceFunding` can no longer answer
   *       "how was this record funded" with one row.
   */
  {
    id: "report_generation_requests.table",
    kind: "table",
    detail: 'table public."report_generation_requests" must exist',
    requiredBy:
      "THE durable generation-intent authority. It is the only real execution state the platform has for report and verification-package generation: createReportGenerationRequest is its one writer, the worker claims and settles rows in it, and the artifact-status projection, the Reports aggregator, the user-scoped Reports fallback and the Billing eligibility count all read it. Every one of those readers degrades on error rather than failing, so an absent table does not surface as an error — it silently reports every record as never-requested and refuses every Generate click, with a green preflight",
    suppliedBy: "20271113000000_point5_report_generation_authority",
  },
  {
    id: "report_generation_requests.idempotency_key_unique",
    kind: "index",
    detail:
      'a UNIQUE index on public."report_generation_requests"("idempotency_key") must exist',
    requiredBy:
      "the version-anchored idempotency key is what makes duplicate generation intent collapse instead of racing. Two concurrent completion fan-outs for one record compute the same key and the unique violation elects one winner; the loser reuses the winner's row. Without the index both inserts succeed, two runnable requests exist for one baseline artifact version, and the supersession chain can advance twice",
    suppliedBy: "20271113000000_point5_report_generation_authority",
  },
  {
    id: "evidence_credit_ledger_entries.table",
    kind: "table",
    detail: 'table public."evidence_credit_ledger_entries" must exist',
    requiredBy:
      "THE evidence-credit authority. It records purchases, admin grants and per-record consumption, and it answers two questions nothing else can: how a record's completion was funded (resolveEvidenceFunding — which decides whether a FREE account's record earns a report and verification package) and whether an account is genuinely an evidence-credit customer (hasSettledEvidenceCreditGrant — which decides storage-add-on eligibility). Its absence silently downgrades every credit-funded record to plan-only entitlement",
    suppliedBy: "20271227000000_billing_commercial_correctness",
  },
  {
    id: "evidence_credit_ledger_entries.evidence_id_unique",
    kind: "index",
    detail:
      'a UNIQUE index on public."evidence_credit_ledger_entries"("evidence_id") must exist',
    requiredBy:
      "the serialization point for credit spend. consumeEvidenceCreditForCompletion decrements the wallet conditionally and then INSERTs this row inside the completion transaction; the unique violation is what rolls a concurrent second spend back. Without the index a retried or re-delivered completion can burn a second credit for one evidence record — a customer charged twice for one capture",
    suppliedBy: "20271227000000_billing_commercial_correctness",
  },
  {
    id: "plan_grants.table",
    kind: "table",
    detail: 'table public."plan_grants" must exist',
    requiredBy:
      "INTERNAL PLAN GRANT — every Personal plan resolution (API workspace scopes, platform context, checkout guard, commercial lifecycle, worker scopes) reads the active internal grant from it. An image on a database without it fails those reads outright, so it must be migrated BEFORE the API and worker images that carry the reader",
    suppliedBy: "20281002000000_internal_plan_grants",
  },
  {
    id: "evidence.signing_key_sha256",
    kind: "column",
    detail: 'column public."evidence"."signing_key_sha256" must exist',
    requiredBy:
      "UC-TRUST-003 — the Evidence model declares it, so EVERY unnarrowed evidence read (library, detail, verify, report, package) names it; on a database without it those reads fail with P2022 — the over-declared-model outage class. Migrate BEFORE the API and worker images",
    suppliedBy: "20281001000400_signing_key_identity_immutable",
  },
  {
    id: "evidence_part_derived_assets.generation_parameters",
    kind: "column",
    detail: 'column public."evidence_part_derived_assets"."generation_parameters" must exist',
    requiredBy:
      "UC-DER-005/006 — the derived-asset model declares it; every unnarrowed derived-asset read and the worker's producers name it, so a database without it fails them with P2022",
    suppliedBy: "20281001000000_derived_asset_generations",
  },
  {
    id: "evidence_part_derived_assets.storage_version_id",
    kind: "column",
    detail: 'column public."evidence_part_derived_assets"."storage_version_id" must exist',
    requiredBy:
      "UC-DER-006 — the derived-asset model declares it and the worker writes the S3 VersionId into it; a database without it fails those reads and writes with P2022",
    suppliedBy: "20281001000600_derived_asset_storage_version",
  },
  {
    id: "evidence.acquisition_mode",
    kind: "column",
    detail: 'column public."evidence"."acquisition_mode" must exist',
    requiredBy:
      "THE acquisition authority. createEvidence writes it for every new record and every acquisition surface (library, detail, search, report, package, public Verify) reads it; without it evidence creation fails outright",
    suppliedBy: "20280601000000_uc0_acquisition_provenance_foundation",
  },
  {
    id: "evidence_parts.artifact_class",
    kind: "column",
    detail: 'column public."evidence_parts"."artifact_class" must exist',
    requiredBy:
      "the original / capture-record / derived boundary in reports, verification packages and the public Verify record counts",
    suppliedBy: "20280601000000_uc0_acquisition_provenance_foundation",
  },
  {
    id: "capture_session_status.active",
    kind: "enum_value",
    detail: 'enum "CaptureSessionStatus" must contain ACTIVE',
    requiredBy:
      "server-issued direct-capture sessions (the mobile app ingest adapter) open in ACTIVE; without the value no mobile submission can start",
    suppliedBy: "20280601000000_uc0_acquisition_provenance_foundation",
  },
  {
    id: "capture_sessions.nonce_sha256",
    kind: "column",
    detail: 'column public."capture_sessions"."nonce_sha256" must exist',
    requiredBy:
      "the replay defence for direct-capture sessions: the server-issued nonce is checked against this hash when a client declares a signed part",
    suppliedBy: "20280601000000_uc0_acquisition_provenance_foundation",
  },
  {
    id: "reports.acquisition_mode_snapshot",
    kind: "column",
    detail: 'column public."reports"."acquisition_mode_snapshot" must exist',
    requiredBy:
      "the report worker snapshots acquisition on every generated report version so historical reports stay deterministic",
    suppliedBy: "20280601000000_uc0_acquisition_provenance_foundation",
  },
  {
    id: "capture_device_attestations.verifier_version",
    kind: "column",
    detail: 'column public."capture_device_attestations"."verifier_version" must exist',
    requiredBy:
      "the attestation verifier stamps which verifier wrote each verdict; readers only display a positive verdict written by a cryptographic verifier",
    suppliedBy: "20280601000000_uc0_acquisition_provenance_foundation",
  },
  {
    id: "evidence_part_derived_assets.variant_uk",
    kind: "index",
    detail:
      'unique index public."evidence_part_derived_assets_team_part_kind_variant_uk" must exist',
    requiredBy:
      "the derivative writer upserts ON CONFLICT (team_id, evidence_part_id, asset_kind, variant_key); without the index every derived-asset write fails",
    suppliedBy: "20280601000000_uc0_acquisition_provenance_foundation",
  },
  {
    id: "report_generation_requests.progress_stage",
    kind: "column",
    detail: 'column public."report_generation_requests"."progress_stage" must exist',
    requiredBy:
      "the worker records the durable display step of every report/package run (recordRequestProgress) and /artifacts/status projects it; without the column every progress write fails and the Artifacts & Versions progress card cannot follow a request",
    suppliedBy: "20281004000000_report_request_progress_stage",
  },
  {
    id: "verification_packages.disclosure_profile",
    kind: "column",
    detail: 'column public."verification_packages"."disclosure_profile" must exist',
    requiredBy:
      "every package row states its disclosure profile (FULL_FORENSIC or EXTERNAL_DISCLOSURE, each its own row) and every package reader filters on it; without the column every package read and commit fails",
    suppliedBy: "20281005000000_verification_package_disclosure_profile",
  },
  {
    id: "verification_packages.state",
    kind: "column",
    detail: 'column public."verification_packages"."state" must exist',
    requiredBy:
      "the worker reserves each package row (RESERVED) before building it and publishes it (PUBLISHED); every reader counts only published rows; without the column every package read and reservation fails",
    suppliedBy: "20281006000000_verification_package_profile_rows",
  },
  {
    id: "verification_packages.external_version_key",
    kind: "index",
    detail: 'unique index public."verification_packages_external_version_key" must exist',
    requiredBy:
      "one issuance writes a FULL_FORENSIC and an EXTERNAL_DISCLOSURE row for the same version; the profile-aware keys (and the retirement of the (evidence_id, version) key in the same migration) are what admit the second row",
    suppliedBy: "20281006000000_verification_package_profile_rows",
  },
  {
    id: "signing_keys.purpose",
    kind: "column",
    detail: 'column public."signing_keys"."purpose" must exist',
    requiredBy:
      "every signing-key lookup names its purpose (EVIDENCE_SIGNATURE or PACKAGE_SEAL); without the column evidence signing, verification and package sealing fail",
    suppliedBy: "20281006000100_signing_key_purpose",
  },
  {
    id: "evidence.ots_chain_verification_status",
    kind: "column",
    detail: 'column public."evidence"."ots_chain_verification_status" must exist',
    requiredBy:
      "the Prisma client still maps the deprecated ots_anchor_check / ots_attestation_* / ots_chain_* columns (2026-10-13: no writer, no reader) until the contraction release; a whole-row evidence read fails without them",
    suppliedBy: "20281012000000_evidence_ots_truth_columns",
  },
  {
    id: "operational_incidents.message_code",
    kind: "column",
    detail: 'column public."operational_incidents"."message_code" must exist',
    requiredBy:
      "every condition writer records the semantic message code and params its title and summary were rendered from; without the columns every incident write fails",
    suppliedBy: "20281013000000_operational_incident_message_code",
  },
  {
    id: "evidence.verification_ref",
    kind: "column",
    detail: 'column public."evidence"."verification_ref" must exist',
    requiredBy:
      "the canonical verification identity: the report worker issues it before Report v1 is rendered and the public route resolves pvr_ references by it; a whole-row evidence read fails without the three-decisions columns",
    suppliedBy: "20281014000000_free_outputs_canonical_verification_retention_archive",
  },
  {
    id: "evidence.verification_disclosure_mode",
    kind: "column",
    detail: 'column public."evidence"."verification_disclosure_mode" must exist',
    requiredBy:
      "the verification disclosure policy: the public route selects it to decide what the pvr_ page discloses, and the library filter, dashboards and search read it; a whole-row evidence read fails without it",
    suppliedBy: "20281018000000_verification_disclosure_policy",
  },
  {
    id: "verification_share_tokens.allow_original_download",
    kind: "column",
    detail: 'column public."verification_share_tokens"."allow_original_download" must exist',
    requiredBy:
      "a reviewer share's explicit original-download grant: every share read (resolution, listing, rotation) selects it",
    suppliedBy: "20281018000000_verification_disclosure_policy",
  },
  {
    id: "evidence_archive_restore_requests.table",
    kind: "table",
    detail: 'table public."evidence_archive_restore_requests" must exist',
    requiredBy:
      "the durable retention-archive restore outbox: the API writes one request per restore and the worker lifecycle sweep claims and verifies it; without it no archived record can be restored",
    suppliedBy: "20281014000000_free_outputs_canonical_verification_retention_archive",
  },
  {
    id: "capture_sessions.client_attempt_id",
    kind: "column",
    detail: 'column public."capture_sessions"."client_attempt_id" must exist',
    requiredBy:
      "the direct-capture open writes and replays a client attempt id so a retried open returns the same session; every capture-session read selects it",
    suppliedBy: "20281015120000_capture_session_client_attempt",
  },

  /**
   * TEAM ARCHIVE AND STEP-UP ASSURANCE (`20281028000000`).
   *
   * Released without a declaration here, so the gate passed against the
   * previous schema and the only guard was the worker's migration-head check —
   * which proves the LEDGER row, not the objects. The columns below are mapped
   * by models Prisma reads WHOLE (no `select`), so a single absent column fails
   * every read of that model, not just the new feature: the session row on
   * authenticated requests, the Organization security policy, every
   * Collaboration Team read. The enum value, the widened CHECK and the
   * credential table are what passkey enrolment and assertion write and read.
   */
  {
    id: "mfa_factor_kind.passkey",
    kind: "enum_value",
    detail: 'enum "MfaFactorKind" must contain PASSKEY',
    requiredBy:
      "a passkey is an MFA factor row; enrolment writes it and every factor read decodes it — an image that knows PASSKEY against a database that does not fails both",
    suppliedBy: "20281028000000_team_archive_step_up_assurance",
  },
  {
    id: "mfa_factors_kind_payload_chk.passkey",
    kind: "constraint",
    detail: 'check "mfa_factors_kind_payload_chk" on public."mfa_factors" must admit kind PASSKEY',
    requiredBy:
      "the pre-widening CHECK admits only TOTP and SMS/WHATSAPP payloads, so with the enum value alone every passkey enrolment is rejected by the database",
    suppliedBy: "20281028000000_team_archive_step_up_assurance",
  },
  {
    id: "mfa_webauthn_credentials.table",
    kind: "table",
    detail: 'table public."mfa_webauthn_credentials" must exist',
    requiredBy: "the public key, counter and credential id of every passkey; registration writes it and every assertion reads it",
    suppliedBy: "20281028000000_team_archive_step_up_assurance",
  },
  {
    id: "mfa_webauthn_credentials.credential_id_unique",
    kind: "index",
    detail: 'a unique index on public."mfa_webauthn_credentials"("credential_id") must exist',
    requiredBy:
      "an assertion resolves its credential by credential_id; without uniqueness one authenticator id could resolve to two factors",
    suppliedBy: "20281028000000_team_archive_step_up_assurance",
  },
  {
    id: "mfa_webauthn_credentials.factor_id_unique",
    kind: "index",
    detail: 'a unique index on public."mfa_webauthn_credentials"("factor_id") must exist',
    requiredBy: "a passkey factor owns exactly one credential (the one-to-one relation Prisma upserts and reads through)",
    suppliedBy: "20281028000000_team_archive_step_up_assurance",
  },
  ...[
    "method",
    "sso_connection_id",
    "authn_context",
    "webauthn_challenge",
    "handoff_token_hash",
    "handoff_used_at_utc",
  ].map((column) =>
    stepUpColumn(
      "step_up_challenges",
      column,
      "every step-up challenge is read and written as a whole row; without it no step-up can be issued or answered, team archive included",
    ),
  ),
  ...[
    "step_up_assurance",
    "step_up_sms_allowed",
    "idp_step_up_accepted_contexts",
    "idp_step_up_max_age_seconds",
  ].map((column) =>
    stepUpColumn(
      "organization_security_policies",
      column,
      "the Organization security policy is read as a whole row wherever it is evaluated; its absence fails policy reads, not just step-up",
    ),
  ),
  ...["auth_method", "authn_context", "idp_auth_at_utc"].map((column) =>
    stepUpColumn(
      "authenticated_sessions",
      column,
      "the session row is read as a whole row when a session is resolved; its absence fails signed-in requests",
    ),
  ),
  ...["archived_by_user_id", "archive_reason"].map((column) =>
    stepUpColumn(
      "collaboration_teams",
      column,
      "every Collaboration Team read selects the whole row; its absence fails team reads, not just archive",
    ),
  ),

  /**
   * THE COMBINED SCREEN RECORDING (`20281029000000`). Three CHECK swaps; each
   * is asserted by its DEFINITION (the pre-widening constraint has the same
   * name and is exactly what must be refused). Without them the run row, the
   * derived row, or a recording larger than 50 MB is rejected by the database.
   */
  {
    id: "media_intelligence_runs_kind_bounded.combine_screen_recording",
    kind: "constraint",
    detail: 'check "media_intelligence_runs_kind_bounded" on public."media_intelligence_runs" must admit kind combine_screen_recording',
    requiredBy:
      "the combined-recording run is a MediaIntelligenceRun; creating it (after seal, or the owner's Prepare action) is rejected by the narrower CHECK",
    suppliedBy: "20281029000000_screen_recording_combined_derivative",
  },
  {
    id: "evidence_part_derived_assets_kind_bounded.screen_recording_combined",
    kind: "constraint",
    detail:
      'check "evidence_part_derived_assets_kind_bounded" on public."evidence_part_derived_assets" must admit asset kind screen_recording_combined',
    requiredBy: "the worker records the combined recording as a derived row of this kind; the narrower CHECK rejects the write",
    suppliedBy: "20281029000000_screen_recording_combined_derivative",
  },
  {
    id: "evidence_part_derived_assets_size_bounded.combined_ceiling",
    kind: "constraint",
    detail:
      'check "evidence_part_derived_assets_size_bounded" on public."evidence_part_derived_assets" must admit size_bytes up to 671088640',
    requiredBy: "a combined recording is up to 640 MiB; the previous 50,000,000-byte ceiling rejects every real one",
    suppliedBy: "20281029000000_screen_recording_combined_derivative",
  },
  // 20281030000000 — billing remediation. The API maps these columns in every
  // subscription and payment read, so a database without them fails every
  // billing request, not one feature.
  {
    id: "subscriptions.provider_schedule_id",
    kind: "column",
    detail: 'column public."subscriptions"."provider_schedule_id" must exist',
    requiredBy: "every subscription read selects it through the Prisma client",
    suppliedBy: "20281030000000_billing_remediation_convergence",
  },
  {
    id: "payments.refunded_amount_cents",
    kind: "column",
    detail: 'column public."payments"."refunded_amount_cents" must exist',
    requiredBy: "every payment read selects it through the Prisma client",
    suppliedBy: "20281030000000_billing_remediation_convergence",
  },
  {
    id: "payment_adjustments.table",
    kind: "table",
    detail: 'table public."payment_adjustments" must exist',
    requiredBy: "a provider refund is recorded here before the payment moves; without it refund webhooks fail",
    suppliedBy: "20281030000000_billing_remediation_convergence",
  },
  {
    id: "billing_provider_binding_checks.table",
    kind: "table",
    detail: 'table public."billing_provider_binding_checks" must exist',
    requiredBy: "reconciliation records a provider reference the provider does not know here",
    suppliedBy: "20281030000000_billing_remediation_convergence",
  },
  // 20281031000000 — billing product decisions. Both columns are mapped in every
  // subscription and add-on read.
  {
    id: "subscriptions.addon_end_consent_plan",
    kind: "column",
    detail: 'column public."subscriptions"."addon_end_consent_plan" must exist',
    requiredBy: "every subscription read selects it through the Prisma client",
    suppliedBy: "20281031000000_billing_product_decisions",
  },
  {
    id: "workspace_storage_addons.depends_on_plan_grant_id",
    kind: "column",
    detail: 'column public."workspace_storage_addons"."depends_on_plan_grant_id" must exist',
    requiredBy: "every storage add-on read selects it through the Prisma client",
    suppliedBy: "20281031000000_billing_product_decisions",
  },
  {
    id: "billing_provider_customers.table",
    kind: "table",
    detail: 'table public."billing_provider_customers" must exist',
    requiredBy: "a Stripe checkout resolves the billing owner's customer here",
    suppliedBy: "20281031000000_billing_product_decisions",
  },
]);

/**
 * One 20281028000000 column requirement. Its probe is `columnProbe` below,
 * keyed by the same id.
 *
 * @param {string} table
 * @param {string} column
 * @param {string} requiredBy
 * @returns {RuntimeSchemaRequirement}
 */
function stepUpColumn(table, column, requiredBy) {
  return {
    id: `${table}.${column}`,
    kind: "column",
    detail: `column public."${table}"."${column}" must exist`,
    requiredBy,
    suppliedBy: "20281028000000_team_archive_step_up_assurance",
  };
}

/** The same catalog read every hand-written column probe above makes. */
function columnProbe(table, column) {
  return `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = '${table}'
       AND column_name = '${column}'
     LIMIT 1`;
}

/**
 * A unique index whose single column is `column` — asserted through pg_index,
 * like the idempotency key above, because the property is the uniqueness, not
 * the name a generator chose.
 */
function singleColumnUniqueProbe(table, column) {
  return `
    SELECT 1
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a
        ON a.attrelid = t.oid
       AND a.attnum = i.indkey[0]
     WHERE n.nspname = 'public'
       AND t.relname = '${table}'
       AND i.indisunique
       AND i.indnatts = 1
       AND a.attname = '${column}'
     LIMIT 1`;
}

/**
 * A CHECK constraint whose DEFINITION matches `likePattern` (a SQL LIKE
 * pattern, quotes already doubled). Asserted by definition because a widened
 * CHECK keeps the name of the narrower one it replaced.
 */
function checkDefinitionProbe(table, conname, likePattern) {
  return `
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = '${table}'
       AND c.conname = '${conname}'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '${likePattern}'
     LIMIT 1`;
}

/**
 * The catalog probes, one per requirement id.
 *
 * Read-only, `information_schema` / `pg_catalog` only, and parameterless — this
 * runs before a release is trusted, so it must not depend on application
 * tables, and must not be able to write anything.
 */
const PROBES = Object.freeze({
  "teams.closed_at_utc": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'teams'
       AND column_name = 'closed_at_utc'
     LIMIT 1`,
  "governance_reconciliation_kind.workspace_operations": `
    SELECT 1
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE t.typname = 'GovernanceReconciliationKind'
       AND e.enumlabel = 'WORKSPACE_OPERATIONS'
     LIMIT 1`,
  "incident_scope.type": `
    SELECT 1 FROM pg_type WHERE typname = 'IncidentScope' LIMIT 1`,
  "operational_incidents.scope": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operational_incidents'
       AND column_name = 'scope'
     LIMIT 1`,
  operational_incidents_scope_team_status_idx: `
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'operational_incidents'
       AND indexname = 'operational_incidents_scope_team_status_idx'
     LIMIT 1`,
  "operational_incidents.metric_snapshot": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operational_incidents'
       AND column_name = 'metric_snapshot'
     LIMIT 1`,
  "team_invites.token_hash": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'team_invites'
       AND column_name = 'token_hash'
     LIMIT 1`,
  "team_invites.revoked_at": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'team_invites'
       AND column_name = 'revoked_at'
     LIMIT 1`,

  // P3-9 — the two output/commercial tables and the two uniqueness properties
  // that make them correct. Read-only, information_schema / pg_catalog only.
  "report_generation_requests.table": `
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'report_generation_requests'
     LIMIT 1`,
  /*
   * Asserted through pg_index rather than by index NAME.
   *
   * Prisma's `@unique` generates `report_generation_requests_idempotency_key_key`,
   * but the property this release depends on is the UNIQUENESS, not the name a
   * generator chose — and a hand-written migration or a rename would satisfy
   * the requirement while failing a name match. The predicate asks the
   * question the code actually relies on: is there a unique index whose single
   * column is `idempotency_key`.
   */
  "report_generation_requests.idempotency_key_unique": `
    SELECT 1
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a
        ON a.attrelid = t.oid
       AND a.attnum = i.indkey[0]
     WHERE n.nspname = 'public'
       AND t.relname = 'report_generation_requests'
       AND i.indisunique
       AND i.indnatts = 1
       AND a.attname = 'idempotency_key'
     LIMIT 1`,
  "report_generation_requests.progress_stage": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'report_generation_requests'
       AND column_name = 'progress_stage'
     LIMIT 1`,
  "verification_packages.disclosure_profile": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'verification_packages'
       AND column_name = 'disclosure_profile'
     LIMIT 1`,
  "plan_grants.table": `
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'plan_grants'
     LIMIT 1`,
  "evidence.signing_key_sha256": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence'
       AND column_name = 'signing_key_sha256'
     LIMIT 1`,
  "evidence_part_derived_assets.generation_parameters": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence_part_derived_assets'
       AND column_name = 'generation_parameters'
     LIMIT 1`,
  "evidence_part_derived_assets.storage_version_id": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence_part_derived_assets'
       AND column_name = 'storage_version_id'
     LIMIT 1`,
  "evidence_credit_ledger_entries.table": `
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'evidence_credit_ledger_entries'
     LIMIT 1`,
  "evidence_credit_ledger_entries.evidence_id_unique": `
    SELECT 1
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a
        ON a.attrelid = t.oid
       AND a.attnum = i.indkey[0]
     WHERE n.nspname = 'public'
       AND t.relname = 'evidence_credit_ledger_entries'
       AND i.indisunique
       AND i.indnatts = 1
       AND a.attname = 'evidence_id'
     LIMIT 1`,
  "evidence.acquisition_mode": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence'
       AND column_name = 'acquisition_mode'
     LIMIT 1`,
  "evidence_parts.artifact_class": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence_parts'
       AND column_name = 'artifact_class'
     LIMIT 1`,
  "capture_session_status.active": `
    SELECT 1
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE t.typname = 'CaptureSessionStatus'
       AND e.enumlabel = 'ACTIVE'
     LIMIT 1`,
  "capture_sessions.nonce_sha256": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'capture_sessions'
       AND column_name = 'nonce_sha256'
     LIMIT 1`,
  "reports.acquisition_mode_snapshot": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'reports'
       AND column_name = 'acquisition_mode_snapshot'
     LIMIT 1`,
  "capture_device_attestations.verifier_version": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'capture_device_attestations'
       AND column_name = 'verifier_version'
     LIMIT 1`,
  "evidence_part_derived_assets.variant_uk": `
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'evidence_part_derived_assets'
       AND indexname = 'evidence_part_derived_assets_team_part_kind_variant_uk'
     LIMIT 1`,
  "verification_packages.state": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'verification_packages'
       AND column_name = 'state'
     LIMIT 1`,
  "verification_packages.external_version_key": `
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'verification_packages'
       AND indexname = 'verification_packages_external_version_key'
     LIMIT 1`,
  "signing_keys.purpose": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'signing_keys'
       AND column_name = 'purpose'
     LIMIT 1`,
  "evidence.ots_chain_verification_status": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence'
       AND column_name = 'ots_chain_verification_status'
     LIMIT 1`,
  "operational_incidents.message_code": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operational_incidents'
       AND column_name = 'message_code'
     LIMIT 1`,
  "evidence.verification_ref": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence'
       AND column_name = 'verification_ref'
     LIMIT 1`,
  "evidence.verification_disclosure_mode": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'evidence'
       AND column_name = 'verification_disclosure_mode'
     LIMIT 1`,
  "verification_share_tokens.allow_original_download": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'verification_share_tokens'
       AND column_name = 'allow_original_download'
     LIMIT 1`,
  "evidence_archive_restore_requests.table": `
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'evidence_archive_restore_requests'
     LIMIT 1`,
  "capture_sessions.client_attempt_id": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'capture_sessions'
       AND column_name = 'client_attempt_id'
     LIMIT 1`,

  // 20281028000000 — team archive and step-up assurance.
  "mfa_factor_kind.passkey": `
    SELECT 1
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE t.typname = 'MfaFactorKind'
       AND e.enumlabel = 'PASSKEY'
     LIMIT 1`,
  /*
   * The CHECK is asserted by its DEFINITION, not its name: the pre-widening
   * constraint has the same name and is exactly what must be refused. The
   * migration compares `"kind"::text = 'PASSKEY'`, so the definition names the
   * label as a string literal.
   */
  "mfa_factors_kind_payload_chk.passkey": `
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'mfa_factors'
       AND c.conname = 'mfa_factors_kind_payload_chk'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%''PASSKEY''%'
     LIMIT 1`,
  "mfa_webauthn_credentials.table": `
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'mfa_webauthn_credentials'
     LIMIT 1`,
  "mfa_webauthn_credentials.credential_id_unique": singleColumnUniqueProbe("mfa_webauthn_credentials", "credential_id"),
  "mfa_webauthn_credentials.factor_id_unique": singleColumnUniqueProbe("mfa_webauthn_credentials", "factor_id"),
  // 20281029000000 — the combined screen recording (CHECKs by definition).
  "media_intelligence_runs_kind_bounded.combine_screen_recording": checkDefinitionProbe(
    "media_intelligence_runs",
    "media_intelligence_runs_kind_bounded",
    "%''combine_screen_recording''%",
  ),
  "evidence_part_derived_assets_kind_bounded.screen_recording_combined": checkDefinitionProbe(
    "evidence_part_derived_assets",
    "evidence_part_derived_assets_kind_bounded",
    "%''screen_recording_combined''%",
  ),
  "evidence_part_derived_assets_size_bounded.combined_ceiling": checkDefinitionProbe(
    "evidence_part_derived_assets",
    "evidence_part_derived_assets_size_bounded",
    "%671088640%",
  ),
  // 20281030000000 — billing remediation.
  "subscriptions.provider_schedule_id": columnProbe("subscriptions", "provider_schedule_id"),
  "payments.refunded_amount_cents": columnProbe("payments", "refunded_amount_cents"),
  "subscriptions.addon_end_consent_plan": columnProbe("subscriptions", "addon_end_consent_plan"),
  "workspace_storage_addons.depends_on_plan_grant_id": columnProbe("workspace_storage_addons", "depends_on_plan_grant_id"),
  "payment_adjustments.table": `
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'payment_adjustments'
     LIMIT 1`,
  "billing_provider_binding_checks.table": `
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'billing_provider_binding_checks'
     LIMIT 1`,
  "billing_provider_customers.table": `
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'billing_provider_customers'
     LIMIT 1`,
  ...Object.fromEntries(
    RUNTIME_SCHEMA_REQUIREMENTS.filter(
      (r) => r.kind === "column" && r.suppliedBy === "20281028000000_team_archive_step_up_assurance",
    ).map((r) => {
      const [table, column] = r.id.split(".");
      return [r.id, columnProbe(table, column)];
    }),
  ),
});

/**
 * Check every requirement against a database.
 *
 * `probe` is injected rather than a client being constructed here, for two
 * reasons: the caller owns the connection lifetime, and the four cases this
 * has to get right — previous schema, fully migrated, half-applied each way —
 * are then provable without a database at all.
 *
 * @param {(sql: string) => Promise<boolean>} probe resolves true when the
 *   object exists. It MAY reject; a rejection is treated as "cannot establish
 *   the schema", which fails closed.
 * @returns {Promise<{ ok: boolean, missing: RuntimeSchemaRequirement[], indeterminate: string[] }>}
 */
export async function checkRuntimeSchemaRequirements(probe) {
  const missing = [];
  const indeterminate = [];
  for (const requirement of RUNTIME_SCHEMA_REQUIREMENTS) {
    const sql = PROBES[requirement.id];
    if (!sql) {
      // A requirement with no probe would pass silently, which is the failure
      // mode this whole module exists to remove.
      indeterminate.push(requirement.id);
      continue;
    }
    let present;
    try {
      present = await probe(sql);
    } catch {
      // FAIL CLOSED. "The check errored" is not "the object is there"; the
      // ERROR ITSELF is deliberately not carried forward — see
      // `describeRuntimeSchemaFailure`.
      indeterminate.push(requirement.id);
      continue;
    }
    if (!present) missing.push(requirement);
  }
  return { ok: missing.length === 0 && indeterminate.length === 0, missing, indeterminate };
}

/**
 * The operator-facing explanation. BOUNDED and ACTIONABLE.
 *
 * It names what is absent, which migration supplies it, and what to run. It
 * never contains a driver message: a raw database error is the wrong thing to
 * put in front of a person deciding whether to roll forward, and it is the
 * wrong thing to leak anywhere a user can see. The caller has the exception if
 * it wants it for a log.
 *
 * @param {{ missing: RuntimeSchemaRequirement[], indeterminate: string[] }} result
 */
export function describeRuntimeSchemaFailure(result) {
  const lines = [];
  if (result.missing.length > 0) {
    lines.push(
      `the database is missing ${result.missing.length} object(s) this release requires:`,
    );
    for (const r of result.missing) {
      lines.push(`  - ${r.detail}`);
      lines.push(`      needed because: ${r.requiredBy}`);
      lines.push(`      supplied by:    ${r.suppliedBy}`);
    }
  }
  if (result.indeterminate.length > 0) {
    lines.push(
      `could not establish ${result.indeterminate.length} requirement(s): ` +
        `${result.indeterminate.join(", ")} — treated as absent`,
    );
  }
  // The 20271222 → 20271223 order is a real constraint (an enum value must be
  // committed before it is used), so it is stated when either is missing —
  // and ONLY then: naming it for, say, a missing UC column sends an operator
  // to two unrelated migrations.
  const operationsPair = [...result.missing.map((r) => r.suppliedBy), ...result.indeterminate].some((s) =>
    /^2027122[23]0000/.test(String(s)),
  );
  lines.push(
    operationsPair
      ? "apply the migrations in order (20271222000000, commit, then 20271223000000) " +
          "before deploying API and Worker; deploy Web afterward."
      : "apply the migrations named under 'supplied by', in timestamp order, " +
          "before deploying API and Worker; deploy Web afterward.",
  );
  return lines.join("\n");
}
