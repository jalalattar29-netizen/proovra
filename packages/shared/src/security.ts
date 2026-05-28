/**
 * Phase 11 — Security hardening canonical types + safe helpers.
 *
 * Browser-safe (no Prisma, no Node-only imports). Holds:
 *   - File security scan status catalog
 *   - Security event severity / type catalogs
 *   - File validation primitives:
 *       * magic-bytes signatures (hand-rolled, no deps)
 *       * executable / dangerous extension blocklist
 *       * MIME/extension mismatch detection
 *   - Archive limit constants
 *
 * Wording rule (see Phase 11 brief): never claim "virus free", "secure",
 * "guaranteed safe". Use "flagged", "suspicious", "blocked by policy",
 * "scan pending", "failed validation".
 */

// -----------------------------------------------------------------------------
// Catalogs
// -----------------------------------------------------------------------------

export const FILE_SECURITY_SCAN_STATUSES = [
  "PENDING",
  "CLEAN",
  "SUSPICIOUS",
  "FAILED",
  "SKIPPED",
] as const;
export type FileSecurityScanStatus =
  (typeof FILE_SECURITY_SCAN_STATUSES)[number];

export const SECURITY_EVENT_SEVERITIES = ["INFO", "WARNING", "HIGH"] as const;
export type SecurityEventSeverity = (typeof SECURITY_EVENT_SEVERITIES)[number];

/**
 * Stable canonical event types. Adding one requires a code change so
 * we don't accumulate operator-facing surprise labels. Operators can
 * filter the /security UI by these.
 */
export const SECURITY_EVENT_TYPES = [
  "repeated_upload_failure",
  "suspicious_file_type",
  "executable_upload_blocked",
  "mime_mismatch",
  "double_extension_detected",
  "suspicious_archive",
  "archive_limit_exceeded",
  "excessive_rate_limit_hits",
  "webhook_failure_loop",
  "webhook_unsafe_redirect",
  "webhook_target_blocked",
  "governance_bypass_attempt",
  "anti_enumeration_probe",
  "scanner_unavailable",
  // Phase 12 — reliability / operations signals. These are NOT security
  // findings; they reuse the SecurityEvent table because it is already
  // the canonical operator-facing "non-chain" signal log. Severity is
  // INFO/WARNING by default; HIGH is reserved for true incidents.
  "upload_stalled",
  "upload_resumed",
  "upload_abandoned",
  "finalize_duplicate_detected",
  // Phase 30.7 — finalize refused by upload-session gate.
  "finalize_blocked_by_upload_session",
  // Phase 30.8 — S3 native multipart lifecycle observability.
  "multipart_initiate_failed",
  "multipart_complete_failed",
  "multipart_head_failed",
  "multipart_hash_mismatch",
  "multipart_abort_failed",
  "reconciliation_triggered",
  "orphaned_upload_detected",
  "multipart_inconsistency_detected",
  "recovery_review_required",
  // Phase 17 — enterprise identity & access platform. Every access
  // decision that mutates membership lifecycle, capability grants,
  // delegated admin scopes, service-account state, contributor session
  // state, org security policy, access reviews, or external identity
  // mappings emits one of these. They are operator-visible in the
  // /security and /identity surfaces. PERMISSION_DENIED is the canonical
  // event for an actor failing a permission check (fail-closed).
  "member_invited",
  "member_role_changed",
  "member_suspended",
  "member_revoked",
  "member_restored",
  "capability_granted",
  "capability_revoked",
  "delegated_admin_granted",
  "delegated_admin_revoked",
  "service_account_disabled",
  "service_account_rotated",
  "contributor_session_revoked",
  "org_security_policy_updated",
  "access_review_initiated",
  "access_review_completed",
  "external_identity_linked",
  "external_identity_unlinked",
  "permission_denied",
  // Phase 18 — enterprise communications & external outreach. Operator-
  // visible signals for SMS/WhatsApp/Verify activity. invalid_signature
  // is HIGH; everything else is INFO/WARNING unless the route layer
  // explicitly escalates.
  "communication_message_failed",
  "communication_provider_unconfigured",
  "communication_rate_limit_exceeded",
  "communication_recipient_opted_out",
  "communication_webhook_invalid_signature",
  "communication_inbound_stop_received",
  "communication_inbound_start_received",
  "verification_started",
  "verification_check_failed",
  "verification_check_succeeded",
  // Phase 19 — enterprise identity security & adaptive access control.
  // Every step-up start/check + every adaptive risk decision emits one
  // of these so the /security-center surface is exhaustive. None of
  // these events carry OTP codes, raw phones, secrets, or session
  // tokens — see the service layer for the privacy contract.
  "mfa_policy_updated",
  "step_up_started",
  "step_up_approved",
  "step_up_denied",
  "step_up_expired",
  "trusted_device_added",
  "trusted_device_revoked",
  "session_revoked",
  "all_sessions_revoked",
  "suspicious_login_detected",
  "high_risk_action_blocked",
  "high_risk_action_step_up_required",
  "service_account_risk_detected",
  "contributor_risk_detected",
  "impossible_travel_signal",
  // Phase 22 — Evidence Workflow Engine. These describe workflow
  // mutations, intake link issuance, step-completion auditing, and
  // export-gate decisions. Operator-visible in /security and /ops
  // surfaces. Payloads contain NO private notes / reviewer notes /
  // legal-hold reasons / OTPs / raw phones / secrets.
  "workflow_template_created",
  "workflow_template_activated",
  "workflow_template_archived",
  "workflow_instance_created",
  "workflow_instance_submitted",
  "workflow_instance_changes_requested",
  "workflow_instance_approved",
  "workflow_instance_cancelled",
  "workflow_step_mapped",
  "workflow_step_satisfied",
  "workflow_step_waived",
  "workflow_review_assigned",
  "workflow_visibility_decided",
  "workflow_export_blocked",
  "workflow_intake_link_created",
  "workflow_intake_link_revoked",
  "workflow_intake_abuse_detected",
  // Phase 24 — Enterprise Evidence Discovery Platform.
  // Operator-visible signals for search execution, indexing failures,
  // saved-view changes, and relationship creation. Payloads contain
  // NO query text beyond a short hash + length, NO private notes,
  // NO secrets.
  "search_executed",
  "search_governance_blocked_result",
  "search_visibility_filtered_result",
  "search_indexing_failed",
  "search_indexing_drift_detected",
  "search_saved_view_created",
  "search_saved_view_updated",
  "search_saved_view_deleted",
  "search_relationship_created",
  "search_relationship_deleted",
  // Phase 24-J — discovery audit + OCR/transcript foundations + async
  // indexing. Each event documents a failure or a fail-closed
  // engagement; the search service does NOT emit a success-event per
  // query (that's what the dedicated `search_audit_logs` table is for).
  "search_audit_log_write_failed",
  "search_audit_log_read_failed",
  "search_indexing_enqueue_failed",
  "search_indexing_lag_critical",
  "search_ocr_text_redacted",
  "search_ocr_text_indexing_failed",
  "search_transcript_segment_redacted",
  "search_transcript_segment_indexing_failed",
  "search_fail_closed_engaged",
  "search_semantic_unavailable",
  // Phase 30 — resumable upload session lifecycle events.
  "upload_session_create_failed",
  "upload_session_resume_failed",
  "upload_session_completed",
  "upload_session_aborted",
  "upload_part_hash_mismatch",
  // Phase 27/28 — external reviewer grant lifecycle events.
  "external_review_invited",
  "external_review_revoked",
  "external_review_grant_issue_failed",
  "external_review_grant_lookup_failed",
  "external_review_grant_transition_failed",
  // Phase 25 — Reviewer Operations Intelligence + SLA engine.
  "reviewer_assignment_created",
  "reviewer_reassigned",
  "reviewer_review_started",
  "reviewer_review_paused",
  "reviewer_information_requested",
  "reviewer_review_approved",
  "reviewer_review_rejected",
  "reviewer_sla_due_soon",
  "reviewer_sla_breached",
  "reviewer_escalation_created",
  "reviewer_escalation_acknowledged",
  "reviewer_escalation_reassigned",
  "reviewer_escalation_resolved",
  "reviewer_escalation_suppressed",
  "reviewer_workload_computed",
  "reviewer_queue_viewed",
  "reviewer_reconcile_run",
  // Phase 25.5 — reviewer ops hardening.
  "reviewer_bulk_triage_executed",
  "reviewer_step_up_required",
  "reviewer_step_up_satisfied",
  "reviewer_reminder_scheduled",
  "reviewer_reminder_delivered",
  "reviewer_reminder_failed",
  "reviewer_inactivity_detected",
  "reviewer_saved_view_created",
  "reviewer_saved_view_deleted",
  "reviewer_sla_policy_updated",
  "reviewer_governance_flags_updated",
  // Phase 26 — Enterprise identity governance.
  "sso_connection_created",
  "sso_connection_updated",
  "sso_connection_revoked",
  "sso_login_started",
  "sso_login_succeeded",
  "sso_login_failed",
  "sso_jit_provisioned",
  "sso_jit_denied",
  "scim_token_created",
  "scim_token_revoked",
  "scim_user_created",
  "scim_user_updated",
  "scim_user_deactivated",
  "scim_user_unknown_provider",
  "session_inventory_viewed",
  "session_revoked_admin",
  "all_sessions_revoked_admin",
  "rbac_temporary_elevation_granted",
  "rbac_temporary_elevation_expired",
  "rbac_permission_matrix_viewed",
  "access_review_decided",
  // Phase 26.5 — Identity hardening.
  "suspicious_session_detected",
  "forced_reauthentication",
  "session_replay_detected",
  "session_heartbeat_timeout",
  "adaptive_step_up_triggered",
  "adaptive_block_triggered",
  "scim_group_created",
  "scim_group_updated",
  "scim_group_synced",
  "scim_group_deleted",
  "scim_group_membership_changed",
  "idp_outage_detected",
  "idp_outage_cleared",
  "sso_callback_replay_detected",
  "sso_state_expired",
  "stale_session_swept",
  // Phase 26.75 — Identity runtime enforcement.
  "session_quarantined",
  "session_quarantine_released",
  "runtime_risk_escalated",
  "runtime_risk_cooled_down",
  "privileged_session_blocked",
  "geo_anomaly_detected",
  "geo_lookup_failed",
  "suspicious_admin_runtime_activity",
  "suspicious_reviewer_runtime_activity",
  "forced_runtime_reauthentication",
  "emergency_org_session_revoke",
  "trusted_device_decayed",
  "trusted_device_auto_invalidated",
  // Phase G3.1 — operator notification preferences (workspace-aware
  // toggles for the bounded set of operational event types).
  "notification_preference_updated",
  // Phase P1.1 — identity operations completion (SCIM drift +
  // reconciliation, SAML mapping preview/update, SSO health, bounded
  // session identity timeline).
  "scim_drift_scan_completed",
  "scim_reconciliation_executed",
  "scim_reconciliation_token_archived",
  "scim_reconciliation_membership_suspended",
  "scim_reconciliation_group_archived",
  "scim_sync_replayed",
  "saml_mapping_previewed",
  "saml_mapping_updated",
  "saml_mapping_privilege_warning",
  "sso_health_checked",
  "identity_session_timeline_viewed",
  // Phase P2.1 — Immutable export operations + reproducibility.
  "export_reproducibility_verified",
  "object_lock_status_checked",
  // Phase P2.3 — Queue operations + replay safety.
  "queue_job_replay_attempted",
  "queue_job_replay_forbidden",
  "queue_job_replay_succeeded",
  "queue_job_replay_failed",
  "queue_worker_stalled_detected",
  // Phase P2.5 — DR validation.
  "backup_validation_started",
  "backup_validation_completed",
  "restore_validation_started",
  "restore_validation_completed",
  "restore_validation_failed",
  "recovery_report_generated",
  // Phase P3.1 — Signer governance + detached custody attestations.
  "signer_staged",
  "signer_health_checked",
  "signer_health_degraded",
  "signer_rotation_previewed",
  "signer_promoted",
  "signer_retired",
  "signer_revoked",
  "signer_signature_failure",
  "custody_attestation_signed",
  "custody_attestation_verified",
  "custody_attestation_backfill_started",
  "custody_attestation_backfill_completed",
  // Phase P3.1.1 — Verification Package attestation closure.
  "verification_package_attestations_included",
  "verification_package_attestations_degraded",
  "verification_package_attestations_missing",
  "signer_snapshot_included",
  "package_attestation_verification_failed",
  // Phase 27 — Retention + legal hold + lifecycle.
  "retention_policy_created",
  "retention_policy_updated",
  "retention_policy_paused",
  "retention_policy_superseded",
  "retention_policy_archived",
  "retention_policy_attached",
  "retention_recomputed",
  "destruction_review_created",
  "destruction_review_approved",
  "destruction_review_denied",
  "destruction_review_deferred",
  "destruction_review_restored",
  "destruction_executed",
  "destruction_blocked_by_hold",
  "destruction_blocked_by_immutable",
  "export_blocked_by_lifecycle",
  "evidence_lifecycle_transition",
  "lifecycle_transition_blocked",
  "evidence_archived",
  "evidence_restored",
  // Phase 27.5 — Governance operationalization.
  "governance_reconciliation_started",
  "governance_reconciliation_finished",
  "governance_reconciliation_failed",
  "destruction_execution_planned",
  "destruction_execution_started",
  "destruction_execution_storage_deleted",
  "destruction_execution_tombstoned",
  "destruction_execution_completed",
  "destruction_execution_failed",
  "destruction_execution_rolled_back",
  "immutable_storage_drift",
  "immutable_storage_reconciliation_failure",
  "governance_notification_emitted",
  "governance_notification_suppressed",
  "governance_notification_throttled",
  "governance_notification_delivery_failed",
  "governance_export_snapshot_created",
  "governance_lifecycle_drift_detected",
  // Phase R8 — enterprise identity & security activation. Bounded
  // identity-side event vocabulary covering MFA lifecycle, SSO login
  // outcomes, SCIM provisioning lifecycle, and API-key lifecycle.
  // These supplement the existing Phase 17/19 entries so SIEM
  // exporters and operator-facing security surfaces have a single
  // canonical event taxonomy. Payloads carry NO TOTP secrets, NO
  // raw API keys, NO IdP private keys, NO SAML assertion contents
  // beyond a redacted subject hash — the service layer enforces
  // the privacy contract.
  "mfa_enrollment_started",
  "mfa_enrollment_completed",
  "mfa_factor_added",
  "mfa_factor_removed",
  "mfa_verification_succeeded",
  "mfa_verification_failed",
  // Phase 2.4 — user-self password change events. Emitted by
  // `/v1/users/me/password/change`. Payload carries NEVER the
  // password itself; only `actorUserId` + a coarse `reason` /
  // `method` field.
  "password_changed",
  "password_change_failed",
  "auth_login_failed",
  "sso_login_succeeded",
  "sso_login_failed",
  "scim_user_provisioned",
  "scim_user_deprovisioned",
  "scim_group_synced",
  "api_key_issued",
  "api_key_revoked",
  // Phase R8.1.3 — durable MFA challenge + org enforcement vocabulary.
  // These supplement the R8 set so SIEM dashboards can distinguish
  // policy-side activity (`org_mfa_*`) from individual challenge
  // lifecycle (`mfa_challenge_*`). Payloads carry user ids,
  // policy levels, challenge id hashes — NEVER the OTP, NEVER the
  // recovery code, NEVER the signed token, NEVER raw IP/UA.
  "org_mfa_policy_updated",
  "org_mfa_policy_enforced",
  "mfa_challenge_created",
  "mfa_challenge_expired",
  "mfa_challenge_replayed",
  "mfa_challenge_consumed",
  "mfa_enrollment_required",
  // Phase R8.1.4 — MFA admin lifecycle + scheduled GC + circuit
  // breaker. Operational events that close the enterprise MFA
  // story: scheduled cleanup, enforcement degradation under
  // database failures, admin lifecycle actions on user factors,
  // and the lost-factor recovery workflow. Payloads carry user
  // ids, request ids, action labels, and reason codes — never
  // OTP / recovery code / signed token / secret / IV / auth tag.
  "mfa_challenge_gc_completed",
  "mfa_enforcement_degraded",
  "mfa_enforcement_failed_closed",
  "mfa_admin_factor_revoked",
  "mfa_admin_reenrollment_required",
  "mfa_trusted_devices_reset",
  "mfa_recovery_requested",
  "mfa_recovery_approved",
  "mfa_recovery_completed",
  // Phase R8.1.5 — recovery email preflight + self-cancel +
  // per-org fail-mode events. Payloads carry user ids, request
  // ids, mailbox-bound boolean — NEVER the raw email token, OTP,
  // recovery code, TOTP secret, or signed pending token.
  "mfa_recovery_email_verification_sent",
  "mfa_recovery_email_verified",
  "mfa_recovery_email_expired",
  "mfa_recovery_cancelled",
  "org_mfa_fail_mode_updated",
  // Phase R8.1.6 — recovery throttle + pending digest events.
  // Payloads carry user/team ids + counts + window-seconds, never
  // raw email tokens, OTPs, recovery codes, signed pending tokens,
  // TOTP secrets, or message body content.
  "mfa_recovery_throttled",
  "mfa_recovery_digest_sent",
  // Phase R8.1.7 — recovery digest operations polish.
  // `mfa_recovery_digest_failed` fires when the email transport
  // returns a non-OK status for an admin's consolidated digest.
  // `mfa_recovery_digest_preference_updated` fires when an admin
  // changes their digest opt-in / suppress-until value. Payloads
  // carry user/team ids + bounded counters — never raw email
  // addresses, OTPs, recovery codes, or signed tokens.
  "mfa_recovery_digest_failed",
  "mfa_recovery_digest_preference_updated",
  // Phase R8.1.9 — recovery finalization events.
  // `mfa_recovery_digest_snooze_link_used` fires when an admin
  // clicks the one-click snooze link in a digest email.
  // `mfa_recovery_digest_test_sent` / `_test_failed` track the
  // send-test digest action used by admins to preview email
  // rendering. Payloads carry user ids + bounded counters; never
  // raw snooze tokens, OTPs, recovery codes, or signed pending
  // tokens.
  "mfa_recovery_digest_snooze_link_used",
  "mfa_recovery_digest_test_sent",
  "mfa_recovery_digest_test_failed",
  // Phase R8.2 — Real SAML SP activation. These events track SAML
  // connection lifecycle and assertion validation outcomes. Payloads
  // carry connection ids, user-id hashes, and sanitised error codes —
  // NEVER raw assertion XML, NameID values, certificates, private keys,
  // or session tokens. `saml_assertion_rejected` is HIGH severity
  // because it indicates an IdP-signed assertion the SP refused — a
  // potential attack signal.
  "saml_connection_created",
  "saml_connection_updated",
  "saml_connection_revoked",
  "saml_login_started",
  "saml_login_succeeded",
  "saml_login_failed",
  "saml_assertion_rejected",
  "saml_jit_provisioned",
  "saml_jit_denied",
  "saml_user_linked",
  "saml_metadata_ingested",
  // Phase R8.2.1 — Real IdP interoperability + SAML hardening. These
  // events close the enterprise SAML story: test-connection flow so
  // admins can validate IdP config without issuing a real session;
  // certificate rotation lifecycle (rotation and expiry warning);
  // attribute mapping failure (IdP returned no mappable email);
  // JIT policy denial (SCIM-managed orgs or domain restrictions).
  // Payloads carry connection ids, user-id hashes, and sanitised error
  // codes — NEVER raw assertion XML, NameID, certificates, or private keys.
  "saml_connection_test_started",
  "saml_connection_test_succeeded",
  "saml_connection_test_failed",
  "saml_certificate_rotated",
  "saml_certificate_expiring",
  "saml_attribute_mapping_failed",
  "saml_jit_policy_denied",

  // ---------------------------------------------------------------------------
  // Phase E3 — Operational Automation Foundation
  //
  // Bounded automation lifecycle. Payloads carry rule + run + target ids
  // only — NEVER raw evidence content, secrets, tokens, or external
  // payloads. Reason strings are operator-safe and truncated to 400 chars
  // by the service layer.
  // ---------------------------------------------------------------------------
  "automation_rule_created",
  "automation_rule_updated",
  "automation_rule_enabled",
  "automation_rule_disabled",
  "automation_run_started",
  "automation_run_succeeded",
  "automation_run_failed",
  "automation_run_skipped",
  "automation_action_executed",

  // ---------------------------------------------------------------------------
  // Phase E3.2 — Secure Webhook Delivery
  //
  // Webhook destination + delivery lifecycle. Payloads carry destination
  // id + run id + bounded reason classifications only. NEVER include
  // the webhook secret, the full URL with query, the payload body, the
  // response body, or evidence content. Origin (scheme + host) only
  // when host visibility helps operators diagnose delivery failures.
  // ---------------------------------------------------------------------------
  "automation_webhook_destination_created",
  "automation_webhook_destination_updated",
  "automation_webhook_destination_disabled",
  "automation_webhook_secret_rotated",
  "automation_webhook_delivery_succeeded",
  "automation_webhook_delivery_failed",
  "automation_webhook_delivery_skipped",

  // ---------------------------------------------------------------------------
  // Phase E3.3 — Async Delivery & Retry Runtime
  //
  // Lifecycle events for the async webhook delivery runtime. The
  // dispatcher transitions deliveries through PENDING → DELIVERING →
  // (SUCCEEDED | RETRY_SCHEDULED | FAILED). RETRY_SCHEDULED rows wait
  // for `nextAttemptAt` then re-enter DELIVERING. After the bounded
  // attempt cap (4 total), terminal state becomes RETRY_EXHAUSTED.
  //
  // After 10 consecutive failures on a destination, the runtime auto-
  // disables it + emits the destination_auto_disabled event so
  // operators see the action explicitly (never silent).
  // ---------------------------------------------------------------------------
  "automation_webhook_delivery_retry_scheduled",
  "automation_webhook_delivery_retry_exhausted",
  "automation_webhook_destination_auto_disabled",

  // ---------------------------------------------------------------------------
  // Phase A0 — Integrity hard-gate.
  //
  // Emitted alongside the INTEGRITY_REJECTED_HASH_MISMATCH custody
  // event when a recomputed SHA-256 disagrees with the stored
  // `Evidence.fileSha256`. Severity is HIGH because the event is
  // never expected during normal operation: completion has already
  // run a server-side stream hash, so a later mismatch indicates the
  // stored object changed under us, the wrong evidence row was
  // touched, or a storage-layer integrity event. The payload carries
  // `expectedSha256` and `computedSha256` truncated to first/last 8
  // hex chars (full hashes already live on the custody-event payload
  // and in structured logs), plus `source` ("worker.report" |
  // "reconciler") so operators can route the alert.
  "evidence_integrity_rejected",

  // ---------------------------------------------------------------------------
  // Phase A3 — Operational hardening.
  //
  // Webhook signature failure. Emitted by the Stripe / PayPal /
  // Twilio webhook routes when signature verification refuses the
  // delivery. Severity HIGH because every signed-webhook failure
  // either indicates a misconfigured deployment (clock skew, wrong
  // secret) or an active attack. Payload carries: provider
  // ("stripe" | "paypal" | "twilio"), reason category (one of the
  // bounded WEBHOOK_SIGNATURE_FAILURE_REASONS below), request id.
  // NEVER carries the raw signature, the secret, the assertion body,
  // or any header that could re-enable the attack on replay.
  "webhook_signature_failure",

  // Analytics endpoint abuse. Emitted when the bounded analytics
  // event allowlist + payload validator rejects a request. Severity
  // INFO (cardinality is bounded; this is a routing signal, not an
  // attack signal). Payload carries the rejection reason category.
  "analytics_request_rejected",

  // AI chat abuse. Emitted when the per-user rate limit, the payload
  // bounds, or the upstream timeout cuts off a chat request.
  // Severity INFO unless the rate-limit hits exceed the daily cost-
  // guard threshold (then escalate via the cost guard's own path).
  "ai_chat_abuse_signal",
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

// -----------------------------------------------------------------------------
// Archive limits — overridden by env at the API layer
// -----------------------------------------------------------------------------

/** Default cap on TOTAL uncompressed bytes per archive (~512 MiB). */
export const DEFAULT_MAX_ARCHIVE_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

/** Default cap on number of entries inside a single archive. */
export const DEFAULT_MAX_ARCHIVE_ENTRY_COUNT = 5000;

/**
 * Maximum ratio of uncompressed to compressed size at which we still
 * trust the archive. Higher ratios are characteristic of zip bombs.
 */
export const DEFAULT_MAX_ARCHIVE_COMPRESSION_RATIO = 200;

// -----------------------------------------------------------------------------
// Dangerous extensions / MIME types
//
// The list is intentionally conservative — only items that are almost
// never legitimate evidence uploads. Reviewer workflows can override
// per case via the policy layer (future work).
// -----------------------------------------------------------------------------

const DANGEROUS_EXTENSIONS_LIST = [
  "exe",
  "scr",
  "msi",
  "bat",
  "cmd",
  "com",
  "vbs",
  "vbe",
  "js",
  "jse",
  "wsf",
  "wsh",
  "ps1",
  "psm1",
  "ps1xml",
  "lnk",
  "reg",
  "dll",
  "sys",
  "jar",
  "app",
  "dmg",
  "pkg",
  "deb",
  "rpm",
  "msu",
  "msp",
  "apk",
  "ipa",
  "elf",
  "out",
  "sh",
  "bash",
  "zsh",
  "py",
  "rb",
  "pl",
  "php",
  "jsp",
  "asp",
  "aspx",
] as const;

const DANGEROUS_EXTENSION_SET: ReadonlySet<string> = new Set(
  DANGEROUS_EXTENSIONS_LIST,
);

const DANGEROUS_MIME_PREFIXES = [
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-msi",
  "application/x-executable",
  "application/x-mach-binary",
  "application/x-elf",
  "application/x-dosexec",
  "application/vnd.microsoft.portable-executable",
  "application/x-sh",
  "application/x-bat",
] as const;

export function isDangerousExtension(name: string | null | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase().trim();
  // Capture the final segment after the last "."; also check
  // double-extension cases like foo.pdf.exe.
  const segments = lower.split(".");
  if (segments.length < 2) return false;
  const last = segments[segments.length - 1] ?? "";
  return DANGEROUS_EXTENSION_SET.has(last);
}

export function isDangerousMimeType(
  mime: string | null | undefined,
): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase().trim();
  for (const prefix of DANGEROUS_MIME_PREFIXES) {
    if (m === prefix || m.startsWith(`${prefix};`)) return true;
  }
  return false;
}

/**
 * Detects "double extension" like `report.pdf.exe`. We treat this as
 * suspicious if the second-to-last segment looks like a benign type
 * and the actual final extension is dangerous OR a known archive.
 */
export function hasDoubleExtension(
  name: string | null | undefined,
): boolean {
  if (!name) return false;
  const lower = name.toLowerCase().trim();
  const segments = lower.split(".");
  if (segments.length < 3) return false;
  const last = segments[segments.length - 1] ?? "";
  const penultimate = segments[segments.length - 2] ?? "";
  const benignPenultimate = new Set([
    "pdf",
    "doc",
    "docx",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
    "csv",
    "txt",
    "rtf",
    "jpg",
    "jpeg",
    "png",
    "gif",
    "webp",
    "heic",
    "mp3",
    "wav",
    "mp4",
    "mov",
    "m4a",
    "json",
    "xml",
  ]);
  if (!benignPenultimate.has(penultimate)) return false;
  if (DANGEROUS_EXTENSION_SET.has(last)) return true;
  if (last === "zip" || last === "rar" || last === "7z" || last === "tar") {
    return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Magic-bytes sniffing
//
// We sniff only enough to detect mismatches between the claimed MIME
// type and the actual file content. This is NOT a substitute for a
// real AV — it catches cheap disguises (e.g. EXE renamed to .jpg).
// -----------------------------------------------------------------------------

export type SniffedFileType = {
  /** Canonical MIME for the sniffed bytes; null if unrecognised. */
  mime: string | null;
  /** Human-readable label, useful for audit messages. */
  label: string | null;
  /** True when the sniffed mime looks like an executable / dangerous binary. */
  executable: boolean;
};

type Signature = {
  offset: number;
  bytes: number[];
  mime: string;
  label: string;
  executable?: boolean;
};

/**
 * Compact, hand-curated signature table. Order matters for prefixes
 * that overlap (e.g. RIFF subtypes). Each entry is matched at `offset`
 * — the test consumes the listed bytes and ignores positions where
 * the value is -1 (don't-care).
 */
const SIGNATURES: ReadonlyArray<Signature> = [
  // Common executables (dangerous)
  { offset: 0, bytes: [0x4d, 0x5a], mime: "application/x-msdownload", label: "PE/EXE", executable: true },
  { offset: 0, bytes: [0x7f, 0x45, 0x4c, 0x46], mime: "application/x-elf", label: "ELF", executable: true },
  { offset: 0, bytes: [0xfe, 0xed, 0xfa, 0xce], mime: "application/x-mach-binary", label: "Mach-O 32", executable: true },
  { offset: 0, bytes: [0xfe, 0xed, 0xfa, 0xcf], mime: "application/x-mach-binary", label: "Mach-O 64", executable: true },
  { offset: 0, bytes: [0xce, 0xfa, 0xed, 0xfe], mime: "application/x-mach-binary", label: "Mach-O 32 LE", executable: true },
  { offset: 0, bytes: [0xcf, 0xfa, 0xed, 0xfe], mime: "application/x-mach-binary", label: "Mach-O 64 LE", executable: true },
  { offset: 0, bytes: [0xca, 0xfe, 0xba, 0xbe], mime: "application/java-vm", label: "Java class", executable: true },

  // Images
  { offset: 0, bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg", label: "JPEG" },
  { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: "image/png", label: "PNG" },
  { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], mime: "image/gif", label: "GIF87a" },
  { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], mime: "image/gif", label: "GIF89a" },
  { offset: 0, bytes: [0x42, 0x4d], mime: "image/bmp", label: "BMP" },
  { offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00], mime: "image/tiff", label: "TIFF (LE)" },
  { offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a], mime: "image/tiff", label: "TIFF (BE)" },

  // PDF / Office
  { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], mime: "application/pdf", label: "PDF" },
  { offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], mime: "application/x-ole-storage", label: "Legacy Office (OLE)" },

  // Archives — also exposed for the archive-limit check
  { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04], mime: "application/zip", label: "ZIP" },
  { offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06], mime: "application/zip", label: "ZIP (empty)" },
  { offset: 0, bytes: [0x50, 0x4b, 0x07, 0x08], mime: "application/zip", label: "ZIP (spanned)" },
  { offset: 0, bytes: [0x1f, 0x8b], mime: "application/gzip", label: "GZIP" },
  { offset: 0, bytes: [0x42, 0x5a, 0x68], mime: "application/x-bzip2", label: "BZIP2" },
  { offset: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], mime: "application/x-7z-compressed", label: "7z" },
  { offset: 0, bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], mime: "application/vnd.rar", label: "RAR" },
  { offset: 257, bytes: [0x75, 0x73, 0x74, 0x61, 0x72], mime: "application/x-tar", label: "TAR (ustar)" },

  // Audio / video — common
  { offset: 0, bytes: [0x49, 0x44, 0x33], mime: "audio/mpeg", label: "MP3 (ID3)" },
  { offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53], mime: "audio/ogg", label: "OGG" },
  { offset: 0, bytes: [0x66, 0x4c, 0x61, 0x43], mime: "audio/flac", label: "FLAC" },
  { offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3], mime: "video/x-matroska", label: "Matroska/WebM" },
  // RIFF container (WAV / AVI / WEBP) — disambiguated below
  { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], mime: "application/octet-stream", label: "RIFF (generic)" },
  // ISO BMFF (mp4/m4a/mov) — ftyp at offset 4
  { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70], mime: "video/mp4", label: "ISO BMFF" },
];

function bytesMatch(buf: Uint8Array, sig: Signature): boolean {
  if (buf.length < sig.offset + sig.bytes.length) return false;
  for (let i = 0; i < sig.bytes.length; i += 1) {
    const want = sig.bytes[i];
    if (want < 0) continue;
    if (buf[sig.offset + i] !== want) return false;
  }
  return true;
}

/**
 * Sniff the leading bytes of a file. Returns the best-matching MIME +
 * label, or `null` mime when nothing is recognised (caller may treat
 * "unknown" as a soft warning, not a block).
 *
 * Input MUST be the head of the file (at least 512 bytes for full
 * coverage; tar's signature lives at offset 257). Callers should slice
 * to at least 1024 bytes for safety.
 */
export function sniffFileType(head: Uint8Array | Buffer): SniffedFileType {
  const buf =
    head instanceof Uint8Array ? head : new Uint8Array(head as ArrayBuffer);
  let riffMatched = false;
  for (const sig of SIGNATURES) {
    if (bytesMatch(buf, sig)) {
      if (sig.label === "RIFF (generic)") {
        riffMatched = true;
        continue;
      }
      return {
        mime: sig.mime,
        label: sig.label,
        executable: sig.executable === true,
      };
    }
  }
  if (riffMatched && buf.length >= 12) {
    const tag = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
    if (tag === "WAVE") {
      return { mime: "audio/wav", label: "WAV", executable: false };
    }
    if (tag === "AVI ") {
      return { mime: "video/x-msvideo", label: "AVI", executable: false };
    }
    if (tag === "WEBP") {
      return { mime: "image/webp", label: "WebP", executable: false };
    }
    return {
      mime: "application/octet-stream",
      label: "RIFF",
      executable: false,
    };
  }
  return { mime: null, label: null, executable: false };
}

// -----------------------------------------------------------------------------
// Mismatch detection
// -----------------------------------------------------------------------------

export type MimeMismatchSeverity = "none" | "warn" | "block";

export type FileValidationFindings = {
  claimedMime: string | null;
  sniffedMime: string | null;
  sniffedLabel: string | null;
  executable: boolean;
  dangerousExtension: boolean;
  doubleExtension: boolean;
  mismatch: MimeMismatchSeverity;
  /** Short canonical reason for the worst finding. Useful for audit. */
  reason: string | null;
};

/**
 * Decide whether the sniffed bytes contradict the claimed MIME / file
 * name. "warn" findings flag the upload for review but do not block;
 * "block" findings indicate the upload should be refused.
 */
export function classifyFileValidation(input: {
  claimedMime: string | null;
  fileName: string | null;
  head: Uint8Array | Buffer;
}): FileValidationFindings {
  const sniffed = sniffFileType(input.head);
  const claimed = (input.claimedMime ?? "").toLowerCase().trim() || null;
  const dangerousExt = isDangerousExtension(input.fileName);
  const doubleExt = hasDoubleExtension(input.fileName);

  let mismatch: MimeMismatchSeverity = "none";
  let reason: string | null = null;

  if (sniffed.executable || dangerousExt || isDangerousMimeType(claimed)) {
    mismatch = "block";
    reason = "executable_or_dangerous_type";
  } else if (doubleExt) {
    mismatch = "block";
    reason = "double_extension";
  } else if (claimed && sniffed.mime && !mimeFamiliesMatch(claimed, sniffed.mime)) {
    mismatch = "warn";
    reason = "mime_content_mismatch";
  }

  return {
    claimedMime: claimed,
    sniffedMime: sniffed.mime,
    sniffedLabel: sniffed.label,
    executable: sniffed.executable,
    dangerousExtension: dangerousExt,
    doubleExtension: doubleExt,
    mismatch,
    reason,
  };
}

/**
 * Loose family comparison: image/* vs image/*, application/zip vs
 * application/zip, etc. Strict equality is too brittle (image/jpg vs
 * image/jpeg, audio/mp3 vs audio/mpeg) so we compare the top-level
 * family AND treat a handful of well-known aliases as compatible.
 */
function mimeFamiliesMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.split(";")[0].trim().toLowerCase();
  const A = norm(a);
  const B = norm(b);
  if (A === B) return true;
  const aliases: Record<string, string> = {
    "image/jpg": "image/jpeg",
    "image/pjpeg": "image/jpeg",
    "audio/mp3": "audio/mpeg",
    "audio/x-wav": "audio/wav",
    "video/quicktime": "video/mp4",
    "video/x-m4v": "video/mp4",
    "audio/x-m4a": "video/mp4",
    "audio/mp4": "video/mp4",
  };
  if (aliases[A] === B || aliases[B] === A) return true;
  const af = A.split("/")[0];
  const bf = B.split("/")[0];
  // Same top-level family is good enough for sniff/claimed comparison.
  return af.length > 0 && af === bf;
}
