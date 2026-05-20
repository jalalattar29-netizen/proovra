/**
 * Phase 20 — Lightweight in-process metrics foundation.
 *
 * A counter + gauge registry that the rest of the API can use without
 * pulling in a vendor SDK. Designed to be drained later by Prometheus,
 * Datadog, or Sentry; for now we expose a JSON snapshot via
 * `/v1/ops/metrics` (auth-gated).
 *
 * Hard invariants:
 *   - Counters are monotonic — `bump()` increments, never decrements.
 *   - Gauges are last-write-wins — `setGauge()` overrides.
 *   - Counter / gauge names are STABLE strings (the catalog below).
 *     Ad-hoc names from request input are NEVER accepted — that would
 *     allow a caller to balloon the registry.
 *   - Snapshot is bounded (the catalog is finite) so the JSON cannot
 *     grow unbounded.
 *   - No PII, no secrets, no per-team values — everything is global.
 *     Per-team operational counts live in the SecurityEvent / audit
 *     tables.
 */
// -----------------------------------------------------------------------------
// Catalog — adding a name requires a code change (deliberate).
// -----------------------------------------------------------------------------
export const COUNTER_NAMES = [
    "security_event_emit_failed",
    "security_event_emit_dropped_unknown_type",
    "step_up_started",
    "step_up_approved",
    "step_up_denied",
    "step_up_required_blocked",
    "high_risk_action_blocked",
    "communication_message_failed",
    "communication_message_sent",
    "communication_message_cancelled",
    "communication_recipient_opted_out",
    "verification_started",
    "verification_check_succeeded",
    "verification_check_failed",
    "session_revoked",
    "all_sessions_revoked",
    "session_revocation_check_failed",
    "trusted_device_added",
    "trusted_device_revoked",
    "webhook_invalid_signature",
    "webhook_delivery_failed",
    "webhook_delivery_succeeded",
    "api_key_auth_failed",
    "api_key_ip_denied",
    "notification_failed",
    "notification_sent",
    "notification_skipped",
    "review_sla_overdue",
    "intelligence_job_failed",
    "intelligence_job_stuck",
    "upload_stalled",
    "upload_abandoned",
    "permission_denied",
    "production_config_violation",
    // Phase 21 — observability + incident counters. Operator-visible
    // signals for the /ops UI; bumped from the incident service,
    // alert provider, webhook handlers, and the request lifecycle.
    "operational_incident_opened",
    "operational_incident_increment",
    "operational_incident_acknowledged",
    "operational_incident_resolved",
    "operational_incident_suppressed",
    "alert_sent",
    "alert_suppressed_rate_limit",
    "alert_provider_failed",
    "request_5xx",
    "request_4xx",
    "request_unhandled_error",
    "observability_provider_init",
    "observability_provider_capture",
    "jobs_started_total",
    "jobs_failed_total",
    "jobs_retry_exhausted_total",
    "webhook_received_total",
    "webhook_invalid_signature_total",
    "webhook_processing_failed_total",
    "webhook_processed_total",
    // Phase 22 — Evidence Workflow Engine counters. Bumped from
    // engine + route layer; surfaced via /v1/ops/metrics.
    "workflows_created_total",
    "workflows_submitted_total",
    "workflows_approved_total",
    "workflows_blocked_total",
    "workflow_step_waived_total",
    "workflow_step_satisfied_total",
    "workflow_intake_abuse_total",
    "workflow_export_blocked_total",
    "workflow_transition_invalid_total",
    // Phase 24 — search + discovery counters.
    "search_executed_total",
    "search_indexing_succeeded_total",
    "search_indexing_failed_total",
    "search_governance_filtered_total",
    "search_visibility_filtered_total",
    "search_saved_view_created_total",
    "search_relationship_created_total",
    // Phase 24-J — discovery audit + async indexing + OCR/transcript
    // foundations.
    "search_audit_log_written_total",
    "search_audit_log_write_failed_total",
    "search_audit_log_read_failed_total",
    "search_indexing_enqueued_total",
    "search_indexing_enqueue_failed_total",
    "search_indexing_started_total",
    "search_indexing_lag_seconds",
    "search_indexing_backlog",
    "search_ocr_text_recorded_total",
    "search_ocr_text_indexed_total",
    "search_ocr_unindexed_rows",
    "search_transcript_segment_recorded_total",
    "search_transcript_segment_indexed_total",
    "search_transcript_unindexed_rows",
    "search_fail_closed_engaged_total",
    "search_result_returned_total",
    // Phase 25 — reviewer operations intelligence + worker rebuild
    // observability.
    "reviewer_priority_computed_total",
    "reviewer_assignment_suggested_total",
    "reviewer_assignment_ineligible_total",
    "reviewer_stuck_workflow_detected_total",
    "reviewer_escalation_storm_detected_total",
    "reviewer_workload_pressure_total",
    // Phase 26 — centralized authorize() helper.
    "authorize_allowed_total",
    "authorize_denied_total",
    "authorize_failed_closed_total",
    // Phase 30 — resumable multipart upload session lifecycle.
    "upload_session_created_total",
    "upload_session_resumed_total",
    "upload_session_completed_total",
    "upload_session_aborted_total",
    "upload_session_expired_total",
    "upload_session_create_failed_total",
    "upload_session_reap_failed_total",
    "upload_session_idempotent_reuse_total",
    "upload_part_marked_uploaded_total",
    "upload_part_verified_total",
    "upload_hash_mismatch_total",
    // Phase 30.6 — route-level counters for the resumable upload REST
    // surface (both authenticated-web + API-key paths). The Phase 30
    // service-layer counters above bump per-service-call; these bump
    // per-route-invocation so we can distinguish e.g. "REST surface saw
    // a session-create attempt" from "service created a row" (matters
    // when idempotent reuse collapses a fresh POST onto an existing row).
    "upload_session_route_created_total",
    "upload_session_route_completed_total",
    // Phase 30.7 — custody-safe finalize gate. Counts evaluations of
    // the gate at evidence-finalize time: `no_session` is the legacy
    // single-shot path (gate doesn't apply); `allowed`/`denied` are
    // resumable-session paths.
    "upload_session_finalize_gate_no_session_total",
    "upload_session_finalize_gate_allowed_total",
    "upload_session_finalize_gate_denied_total",
    "upload_session_finalize_gate_failed_total",
    // Phase 30.8 — S3 native multipart lifecycle counters.
    // `initiated`/`completed`/`aborted` are success counts; the rest
    // are explicit failure surfaces so SRE can distinguish "we asked
    // S3 nicely and it said no" from "the routes are working but the
    // bucket is misconfigured".
    "multipart_initiated_total",
    "multipart_initiated_failed_total",
    "multipart_presign_part_total",
    "multipart_part_marked_uploaded_total",
    "multipart_part_verified_total",
    "multipart_completed_total",
    "multipart_aborted_total",
    "multipart_abort_failed_total",
    "multipart_complete_failed_total",
    "multipart_head_failed_total",
    "multipart_verify_failed_total",
    "multipart_stale_cleanup_total",
    // Phase 30.9 — client-side upload operations telemetry. The
    // orchestrator (apps/web/lib/uploads/multipart-uploader.ts) drives
    // these via beacon-style POSTs to /v1/ops/metrics in a follow-up
    // batch; for now they're catalog-registered so the metrics-snapshot
    // endpoint can surface zeros consistently.
    "upload_resume_total",
    "upload_pause_total",
    "upload_cancel_total",
    "upload_retry_total",
    "upload_chunk_retry_total",
    "upload_recovery_total",
    "offline_draft_created_total",
    "offline_draft_recovered_total",
    "offline_draft_conflict_total",
    "background_sync_retry_total",
    "background_sync_failed_total",
    // Phase 30.11 — Mixed-material finalize gate counters. Bumped by
    // the strengthened ALL-sessions gate so SRE can distinguish:
    //   - `allowed`: every session COMPLETED + every part VERIFIED
    //   - `blocked`: at least one session blocking finalize
    // Plus capture-side selection counters (bumped from the browser
    // via /v1/ops/upload-telemetry when the resumable flag is on).
    "mixed_material_finalize_allowed_total",
    "mixed_material_finalize_blocked_total",
    "capture_resumable_selected_total",
    "capture_resumable_completed_total",
    "capture_resumable_failed_total",
    "capture_resumable_recovered_total",
    // Phase 30.12 — unified manifest observability. Bumped by
    // consumers that resolve materials via buildUnifiedEvidenceManifest.
    "unified_manifest_materials_total",
    "unified_manifest_mixed_evidence_total",
    // Phase 31 — Media intelligence advisory layer. The 6 counters
    // below carry the brief's full media-intelligence catalog. The
    // graph / timeline / derived-asset / lineage / similarity
    // counters are reserved for the future phases that implement
    // those subsystems; we only register the ones the deterministic
    // analyzer + read API actually bump today.
    "media_intelligence_job_started_total",
    "media_intelligence_job_completed_total",
    "media_intelligence_job_failed_total",
    "media_signal_created_total",
    // Reserved for future async workers (derived assets, duplicates,
    // lineage). Registering the names now keeps the metrics snapshot
    // stable as those subsystems land.
    "derived_asset_created_total",
    "duplicate_candidate_created_total",
    "lineage_candidate_created_total",
    // Phase 32 placeholders — the graph subsystem is deferred. The
    // names are registered so SRE dashboards can pin their tile
    // contracts today and the values surface as zeros until the
    // graph code ships.
    "graph_edge_created_total",
    "graph_edge_removed_total",
    "graph_query_total",
    "graph_query_denied_total",
    "timeline_query_total",
    // Phase 31.5 / 32 newly-active counters. The catalog above
    // included these as reserved entries; this phase brings them
    // live (analyzer bumps + graph builder bumps).
    "media_signal_acknowledged_total",
    "derived_asset_failed_total",
    "graph_node_created_total",
    "graph_reconcile_started_total",
    "graph_reconcile_completed_total",
    "graph_reconcile_failed_total",
    // Phase 31.6 — Async media intelligence orchestration counters.
    // `enqueue_*` fires from the API producer (route-side); `processor_*`
    // fires from the worker consumer. `dlq_total` is bumped when an
    // attempt exhausts retries. `run_dismissed_total` is the operator-
    // initiated terminal transition for a permanently failed run.
    "media_intelligence_enqueue_total",
    "media_intelligence_enqueue_failed_total",
    "media_intelligence_processor_started_total",
    "media_intelligence_processor_completed_total",
    "media_intelligence_processor_failed_total",
    "media_intelligence_processor_deferred_total",
    "media_intelligence_dlq_total",
    "media_intelligence_run_dismissed_total",
    // Phase 32.5 — Investigation graph query counters.
    "graph_search_executed_total",
    "graph_timeline_executed_total",
    "graph_case_subgraph_loaded_total",
    // Phase 31.18 — duplicate / similarity review + graph navigation
    // explorer + reviewer intelligence console counters.
    "graph_duplicate_list_total",
    "graph_duplicate_list_executed_total",
    "graph_seeds_executed_total",
    "reviewer_console_query_total",
    // Phase 31.20 — OCR / transcript indexing producer counters.
    "ocr_indexer_started_total",
    "ocr_indexer_completed_total",
    // Phase 31.20 — three more graph subsystem queue counters.
    "graph_domain_sync_executed_total",
    "graph_timeline_sync_executed_total",
    "graph_search_projection_executed_total",
    // Phase 31.21 — tombstone count for the per-domain stale sweep.
    "graph_node_removed_total",
    // Phase 31.13 — derived assets pipeline (image thumbnails this
    // phase; video frames + waveforms reserved for future ffmpeg
    // wiring). Dedicated `mi-derived-assets` BullMQ queue.
    "derived_assets_enqueue_total",
    "derived_assets_enqueue_failed_total",
    "derived_assets_processor_started_total",
    "derived_assets_processor_completed_total",
    "derived_assets_processor_failed_total",
    "derived_assets_processor_unsupported_total",
    "derived_assets_dlq_total",
    // Phase 27/28 — external reviewer grant persistence + lifecycle.
    "external_review_invited_total",
    "external_review_accepted_total",
    "external_review_accessed_total",
    "external_review_revoked_total",
    "external_review_expired_total",
    "external_review_grant_issue_failed_total",
    "external_review_grant_lookup_denied_total",
    // Phase 25.5 — assignment intelligence + reconciliation wiring.
    "reviewer_assignment_rank_computed_total",
    "reviewer_assignment_auto_blocked_total",
    "reviewer_assignment_overload_detected_total",
    "reviewer_assignment_imbalance_total",
    "reviewer_assignment_applied_total",
    "reviewer_reassignment_total",
    "reviewer_queue_pressure_total",
    "reviewer_stuck_workflow_escalated_total",
    "reviewer_escalation_reopened_total",
    "reviewer_operational_incident_created_total",
    "search_indexing_rebuild_started_total",
    "search_indexing_rebuild_succeeded_total",
    "search_indexing_rebuild_failed_total",
    "search_indexing_rebuild_skipped_total",
    "search_indexing_stale_documents_total",
    // Phase 25 — Reviewer Operations Intelligence + SLA engine.
    "reviewer_queue_viewed_total",
    "reviewer_assignment_created_total",
    "reviewer_reassigned_total",
    "reviewer_review_started_total",
    "reviewer_review_completed_total",
    "reviewer_review_paused_total",
    "reviewer_information_requested_total",
    "reviewer_review_approved_total",
    "reviewer_review_rejected_total",
    "reviewer_sla_due_soon_total",
    "reviewer_sla_breached_total",
    "reviewer_escalation_created_total",
    "reviewer_escalation_acknowledged_total",
    "reviewer_escalation_resolved_total",
    "reviewer_escalation_suppressed_total",
    "reviewer_escalation_duplicate_blocked_total",
    "reviewer_workload_computed_total",
    "reviewer_invalid_transition_blocked_total",
    "reviewer_reconcile_run_total",
    "reviewer_reconcile_failed_total",
    // Phase 25.5 — hardening counters.
    "reviewer_bulk_action_total",
    "reviewer_bulk_action_partial_total",
    "reviewer_step_up_required_total",
    "reviewer_step_up_satisfied_total",
    "reviewer_reminder_scheduled_total",
    "reviewer_reminder_duplicate_blocked_total",
    "reviewer_reminder_delivered_total",
    "reviewer_reminder_failed_total",
    "reviewer_inactivity_detected_total",
    "reviewer_reassignment_suggestion_total",
    "reviewer_saved_view_created_total",
    "reviewer_saved_view_deleted_total",
    "reviewer_sla_policy_updated_total",
    "reviewer_analytics_viewed_total",
    // Phase 26 — Enterprise identity governance.
    "sso_connection_created_total",
    "sso_connection_revoked_total",
    "sso_login_total",
    "sso_login_failure_total",
    "sso_jit_provisioned_total",
    "sso_jit_denied_total",
    "scim_token_created_total",
    "scim_token_revoked_total",
    "scim_sync_total",
    "scim_user_created_total",
    "scim_user_updated_total",
    "scim_user_deactivated_total",
    "scim_invalid_token_total",
    "rbac_permission_eval_total",
    "rbac_temporary_elevation_total",
    "rbac_explicit_deny_total",
    "session_revoked_admin_total",
    "session_inventory_viewed_total",
    "access_review_completed_total",
    "trusted_device_revoked_admin_total",
    // Phase 26.5 — Identity hardening.
    "session_heartbeat_total",
    "session_heartbeat_sampled_skip_total",
    "stale_session_total",
    "stale_session_swept_total",
    "suspicious_session_total",
    "adaptive_step_up_total",
    "adaptive_block_total",
    "scim_group_sync_total",
    "scim_group_created_total",
    "scim_group_deleted_total",
    "scim_group_membership_total",
    "sso_callback_failure_total",
    "sso_callback_replay_total",
    "idp_outage_total",
    "idp_outage_cleared_total",
    "forced_reauth_total",
    "session_replay_detected_total",
    // Phase 26.75 — Identity runtime enforcement.
    "adaptive_auth_block_total",
    "adaptive_auth_reauth_total",
    "adaptive_auth_step_up_total",
    "adaptive_auth_allow_total",
    "runtime_risk_recompute_total",
    "runtime_risk_recompute_failed_total",
    "geo_lookup_total",
    "geo_lookup_cache_hit_total",
    "geo_lookup_failure_total",
    "geo_lookup_timeout_total",
    "quarantined_session_total",
    "quarantine_release_total",
    "privileged_session_high_risk_total",
    "privileged_session_blocked_total",
    "forced_reauth_runtime_total",
    "forced_reauth_cooldown_skipped_total",
    "high_risk_session_total",
    "runtime_incident_total",
    "emergency_org_revoke_total",
    "trusted_device_decay_total",
    "trusted_device_auto_invalidated_total",
    // Phase 27 — Retention + lifecycle.
    "retention_policy_created_total",
    "retention_policy_updated_total",
    "retention_policy_superseded_total",
    "retention_recomputed_total",
    "destruction_review_created_total",
    "destruction_review_approved_total",
    "destruction_review_denied_total",
    "destruction_review_deferred_total",
    "destruction_review_restored_total",
    "destruction_executed_total",
    "destruction_blocked_by_hold_total",
    "destruction_blocked_by_immutable_total",
    "export_blocked_by_lifecycle_total",
    "lifecycle_transition_total",
    "lifecycle_transition_blocked_total",
    "evidence_archived_total",
    "evidence_restored_total",
    // Phase 27.5 — Governance operationalization counters.
    "governance_reconciliation_runs_total",
    "governance_reconciliation_run_failed_total",
    "governance_reconciliation_run_partial_total",
    "governance_reconciliation_lock_contention_total",
    "retention_reconciliation_scanned_total",
    "retention_reconciliation_matched_total",
    "retention_reconciliation_review_created_total",
    "retention_reconciliation_extended_total",
    "destruction_orchestrator_planned_total",
    "destruction_orchestrator_executed_total",
    "destruction_orchestrator_failed_total",
    "destruction_orchestrator_rolled_back_total",
    "destruction_orchestrator_partial_failure_total",
    "immutable_storage_check_total",
    "immutable_storage_drift_total",
    "immutable_storage_check_failed_total",
    "governance_notification_emitted_total",
    "governance_notification_deduped_total",
    "governance_notification_throttled_total",
    "governance_notification_delivered_total",
    "governance_notification_delivery_failed_total",
    "governance_export_snapshot_created_total",
    "lifecycle_drift_detected_total",
    // Phase Y — Observability platform counters.
    "ots_upgrade_started_total",
    "ots_upgrade_succeeded_total",
    "ots_upgrade_failed_total",
    "ots_upgrade_pending_total",
    "platform_audit_chain_drift_detected_total",
    "platform_audit_append_failed_total",
    "worker_span_total",
    "worker_span_failed_total",
    "worker_heartbeat_total",
    "queue_job_enqueued_total",
    "queue_job_processed_total",
    "queue_job_failed_total",
    "queue_job_stalled_total",
    "queue_dlq_total",
    "observability_metrics_exporter_calls_total",
    "observability_alert_evaluations_total",
    "observability_sink_failures_total",
    // Operational seeding + E2E validation (staging / demo only — env-gated).
    "operational_seed_run_total",
    "operational_seed_created_reviews_total",
    "operational_seed_created_escalations_total",
    "operational_seed_created_incidents_total",
    "operational_seed_cleanup_total",
    "operational_e2e_validation_success_total",
    "operational_e2e_validation_failed_total",
    // Phase 28-D — Cross-system governance integration counters.
    "governance_snapshot_requested_total",
    "export_governance_blocked_total",
    "package_governance_blocked_total",
    "immutable_drift_block_total",
    "legal_hold_export_block_total",
    "retention_destruction_candidate_total",
    "external_review_access_blocked_total",
    "operational_timeline_loaded_total",
    // Phase 28-E — Fail-closed enforcement, external review, discovery.
    "package_generation_blocked_total",
    "export_generation_blocked_total",
    "external_review_access_granted_total",
    "external_review_access_revoked_total",
    "external_review_access_denied_total",
    "governance_ui_snapshot_loaded_total",
    "operational_timeline_rendered_total",
    "discovery_index_event_total",
    // Phase 28-F — Runtime readiness aggregator + empty-state instrumentation.
    "runtime_readiness_check_total",
    "runtime_readiness_degraded_total",
    "runtime_readiness_critical_total",
    "runtime_queue_health_check_total",
    "runtime_migration_drift_detected_total",
    "enterprise_empty_state_rendered_total",
    "governance_snapshot_ui_loaded_total",
    "operational_timeline_ui_loaded_total",
];
export const GAUGE_NAMES = [
    "communications_retry_scheduled",
    "communications_failed_24h",
    "notifications_retry_scheduled",
    "step_up_pending",
    "trusted_devices_active",
    "revoked_sessions_total",
    "open_access_reviews",
    "stalled_uploads",
    "intelligence_jobs_processing",
    // Phase 21 — incident + queue depth gauges.
    "operational_incidents_open",
    "operational_incidents_open_critical",
    "operational_incidents_open_high",
    "queue_backlog_count",
    "queue_oldest_pending_age_seconds",
    // Phase 24 — search indexing depth + lag.
    "search_documents_indexed",
    "search_documents_pending_reindex",
    "search_indexing_lag_seconds",
    // Phase 25 — Reviewer Operations dashboards.
    "reviewer_queue_backlog_total",
    "reviewer_queue_unassigned",
    "reviewer_queue_overdue",
    "reviewer_queue_due_soon",
    "reviewer_escalations_open",
    "reviewer_escalations_critical_open",
    "reviewer_workload_max_active",
    // Phase 26 — Identity governance dashboards.
    "active_sso_connections",
    "active_scim_tokens",
    "active_sessions_total",
    "active_sessions_high_privilege",
    "stale_trusted_devices",
    // Phase 26.5 — Identity hardening dashboards.
    "stale_session_backlog",
    "high_risk_sessions",
    "idp_in_outage",
    "scim_groups_active",
    "sso_callback_pending",
    // Phase 26.75 — Identity runtime dashboards.
    "quarantined_sessions_open",
    "privileged_sessions_aged",
    "geo_cache_size",
    "trusted_devices_decayed",
    // Phase 27 — Governance lifecycle dashboards.
    "evidence_pending_destruction",
    "active_legal_holds",
    "retention_policy_conflicts",
    "blocked_destruction_attempts",
    "governance_incidents_total",
    "export_governance_blocks",
    "lifecycle_pending_destruction",
    "lifecycle_on_hold",
    "lifecycle_retention_locked",
    "lifecycle_destroyed",
    // Phase 27.5 — Governance operationalization dashboards.
    "governance_reconciliation_runs_inflight",
    "destruction_executions_inflight",
    "immutable_storage_drift_open",
    "governance_notifications_pending",
    "governance_notifications_failed",
    "governance_overdue_reviews",
    // Phase Y — Observability platform gauges.
    "ots_upgrade_pending_inflight",
    "ots_upgrade_backlog",
    "audit_chain_last_drift_check_age_seconds",
    "worker_last_heartbeat_age_seconds",
    "queue_active_count",
    "queue_waiting_count",
    "queue_delayed_count",
    "queue_failed_count",
    "queue_completed_count",
    "queue_dlq_size",
    "observability_alerts_firing",
    "observability_alerts_firing_critical",
    // Phase 30.8 — multipart reaper telemetry.
    "multipart_stale_scanned",
    "multipart_stale_aborted",
    "multipart_stale_failed",
    // Phase 31.6 — Media intelligence async orchestration dashboards.
    // Surfaced by the runtime readiness aggregator + /ops dashboards
    // so SRE can pin "queue depth" and "oldest pending" tiles on the
    // same surface as the Phase Y queue gauges.
    "media_intelligence_runs_pending",
    "media_intelligence_runs_processing",
    "media_intelligence_runs_failed",
    "media_intelligence_oldest_pending_age_seconds",
    "media_intelligence_queue_depth",
    // Phase 31.13 — derived assets pipeline.
    "derived_assets_pending",
    "derived_assets_processing",
    "derived_assets_failed",
    "derived_assets_completed",
    "derived_assets_unsupported",
    "derived_assets_oldest_pending_age_seconds",
];
const VALID_COUNTERS = new Set(COUNTER_NAMES);
const VALID_GAUGES = new Set(GAUGE_NAMES);
// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------
const counters = new Map();
const gauges = new Map();
const startedAtMs = Date.now();
export function bump(name, by = 1) {
    if (!VALID_COUNTERS.has(name))
        return;
    if (!Number.isFinite(by) || by <= 0)
        return;
    const current = counters.get(name) ?? 0;
    counters.set(name, current + by);
}
export function setGauge(name, value) {
    if (!VALID_GAUGES.has(name))
        return;
    if (!Number.isFinite(value) || value < 0)
        return;
    gauges.set(name, Math.floor(value));
}
export function readCounter(name) {
    return counters.get(name) ?? 0;
}
export function readGauge(name) {
    return gauges.get(name) ?? 0;
}
export function snapshotMetrics() {
    const out = {
        uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
        counters: {},
        gauges: {},
    };
    for (const name of COUNTER_NAMES) {
        out.counters[name] = counters.get(name) ?? 0;
    }
    for (const name of GAUGE_NAMES) {
        out.gauges[name] = gauges.get(name) ?? 0;
    }
    return out;
}
/**
 * Test-only — clears the registry. Production paths must never call
 * this; it would lose every counter recorded since startup.
 */
export function __resetMetricsForTests() {
    counters.clear();
    gauges.clear();
}
// -----------------------------------------------------------------------------
// Phase Y — Prometheus exposition
//
// Renders the in-process registry to the Prometheus text format. Pure
// projection over the registry — no side effects, safe to call on
// every scrape. Counters are emitted as `counter`, gauges as `gauge`.
// Includes a process `uptime_seconds` gauge so operators can confirm
// the api was alive at scrape time even when every catalog metric is
// still at zero (fresh start).
// -----------------------------------------------------------------------------
import { formatPrometheusExposition, } from "@proovra/shared";
const EXPORTER_ENV = (process.env.NODE_ENV ?? "development").slice(0, 32);
const EXPORTER_SERVICE = "proovra-api";
export function buildPrometheusExposition() {
    // Best-effort metric bump — never let exposition crash itself.
    try {
        bump("observability_metrics_exporter_calls_total");
    }
    catch {
        /* never propagates */
    }
    const metrics = [];
    metrics.push({
        name: "proovra_uptime_seconds",
        kind: "gauge",
        help: "Process uptime in seconds since this api instance started.",
        value: Math.floor((Date.now() - startedAtMs) / 1000),
    });
    for (const name of COUNTER_NAMES) {
        metrics.push({
            name,
            kind: "counter",
            value: counters.get(name) ?? 0,
        });
    }
    for (const name of GAUGE_NAMES) {
        metrics.push({
            name,
            kind: "gauge",
            value: gauges.get(name) ?? 0,
        });
    }
    return formatPrometheusExposition({
        globalLabels: [
            { name: "service", value: EXPORTER_SERVICE },
            { name: "env", value: EXPORTER_ENV },
        ],
        metrics,
    });
}
