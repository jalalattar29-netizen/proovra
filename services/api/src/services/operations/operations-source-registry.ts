/**
 * THE OPERATIONS SOURCE REGISTRY — DISCOVERY ACCOUNTING.
 *
 * WHAT IT IS FOR
 * --------------
 * Discovery reads a dozen different places to answer "what is wrong in this
 * workspace". Before this file existed there was no list of them: the scanners
 * were an anonymous array literal inside the generator, so nothing could state
 * which sources a run was SUPPOSED to cover, and therefore nothing could tell
 * a run that covered all of them from a run that quietly skipped three.
 *
 * That is the gap the readiness contract needs closed. `PARTIAL` means "a
 * required source did not succeed", and that sentence has no meaning without a
 * declared set of required sources. This registry is that set.
 *
 * WHAT MOVED, AND WHY
 * -------------------
 * The LIFECYCLE half of each source — who may resolve it, what probe answers
 * that question, how it recovers, how it recurs, what suppression means for
 * it, who it is for, whether it carries a number — now lives in
 * `@proovra/shared-runtime`'s `OPERATIONS_SOURCE_LIFECYCLES`.
 *
 * It had to move because BOTH hosts write operational conditions, and a
 * lifecycle contract only one of them could read is the same shape of defect
 * the transition authority already fixed once. It is not COPIED here: the
 * fields below that used to be declared twice — `disposition`,
 * `requiredCapability`, `remediationCategory` — are DERIVED from that contract,
 * so there is no second place for them to drift.
 *
 * What stays here is the part that is genuinely about DISCOVERY: which model
 * the sweep reads, under which workspace-scope authority, what its query asks,
 * and whether a failure to complete it makes the workspace's picture
 * incomplete.
 *
 * IT IS ALSO STILL THE ANTI-DISAPPEARANCE RULE
 * --------------------------------------------
 * Every source carries an explicit disposition — now via the shared contract.
 * A source whose conditions nobody can act on is not omitted; it is recorded as
 * `NO_SAFE_REMEDIATION_AUTHORITY` or `GUIDANCE_ONLY`, by name, so the absence
 * of a button is a decision on the record rather than an oversight nobody can
 * see.
 */

import type { IncidentCategory } from "@proovra/shared";
import {
  lifecycleForSourceId,
  OPERATIONS_SOURCE_LIFECYCLES,
  type OperationsSourceLifecycle,
  type SourceRemediationDisposition,
} from "@proovra/shared-runtime";

/**
 * What Operations can do about the conditions a source produces.
 *
 * The vocabulary now lives with the lifecycle contract. Re-exported under its
 * long-standing local names so every existing reader keeps working and there
 * is still exactly one definition.
 */
export const SOURCE_DISPOSITIONS: readonly SourceRemediationDisposition[] = [
  "MANAGED_INCIDENT",
  "NOTIFICATION_ONLY",
  "SPECIALIZED_SURFACE",
  "SAFE_DEEP_LINK",
  "SAFE_REMEDIATION",
  "GUIDANCE_ONLY",
  "NO_SAFE_REMEDIATION_AUTHORITY",
  "NOT_APPLICABLE",
] as const;
export type SourceDisposition = SourceRemediationDisposition;

/** Which workspace-scope authority bounds the source's discovery query. */
export type SourceScopeAuthority =
  /** `workspaceEvidenceWhere` — the canonical mixed-ownership population. */
  | "WORKSPACE_EVIDENCE_SCOPE"
  /** `workspaceCaseWhere`. */
  | "WORKSPACE_CASE_SCOPE"
  /** Scoped through a relation onto one of the above. */
  | "EVIDENCE_RELATION_SCOPE"
  /** `workspaceIncidentWhere` — scope discriminator + workspace id. */
  | "WORKSPACE_INCIDENT_SCOPE"
  /** A model whose `team_id` is NOT NULL: a strict equality is complete. */
  | "STRICT_WORKSPACE_COLUMN"
  /** Platform-wide telemetry with no tenant column at all. */
  | "PLATFORM_TELEMETRY";

/** The discovery half of a source. The lifecycle half is the shared contract. */
type OperationsSourceDiscovery = {
  /** Stable id. Persisted in run metadata; never renamed casually. */
  readonly id: string;
  /** The model or subsystem the condition is observed in. */
  readonly owner: string;
  readonly scopeAuthority: SourceScopeAuthority;
  /** What the discovery query asks. Prose, kept in step with the scanner. */
  readonly discovery: string;
  /** How occurrences collapse into conditions. */
  readonly fingerprint: string;
  /** What makes the condition stop being true. */
  readonly resolution: string;
  /**
   * Does a failure of this source make the workspace picture incomplete?
   *
   * `true` puts it in `requiredSources`, so a run that could not complete it
   * is PARTIAL and the workspace may not be described as clear. Set `false`
   * only where the source genuinely does not bear on whether the workspace has
   * unresolved work — platform telemetry, for instance, which is about the
   * platform and not about this tenant's records.
   */
  readonly freshnessParticipating: boolean;
  readonly surfaces: {
    readonly home: boolean;
    readonly notifications: boolean;
    readonly operations: boolean;
  };
};

/**
 * A source, whole: its discovery accounting joined to its lifecycle contract.
 *
 * `disposition`, `requiredCapability`, `remediationCategory` and `reopen` are
 * DERIVED from the shared contract rather than declared again here. That is
 * the point — they were the three fields that could disagree with the
 * lifecycle, and now they cannot.
 */
export type OperationsSource = OperationsSourceDiscovery & {
  /** The full canonical lifecycle contract for this source. */
  readonly lifecycle: OperationsSourceLifecycle;
  /** Derived: what may be DONE about it. Never read as resolution authority. */
  readonly disposition: SourceDisposition;
  /** Derived: which canonical permission a viewer needs to see it. */
  readonly requiredCapability: string;
  /** Derived: the incident category its conditions carry. */
  readonly remediationCategory: IncidentCategory;
  /** Derived: what happens when it becomes true again after resolving. */
  readonly reopen: OperationsSourceLifecycle["recurrencePolicy"];
};

/**
 * The discovery rows.
 *
 * Ordered by how a triaging operator would read them: provability first,
 * then the artifact pipeline, then coordination, then platform health, and
 * finally the sources the sweep deliberately does NOT read.
 */
const DISCOVERY: readonly OperationsSourceDiscovery[] = [
  {
    id: "evidence_integrity.tsa_failed",
    owner: "Evidence.tsaStatus",
    scopeAuthority: "WORKSPACE_EVIDENCE_SCOPE",
    discovery: "Evidence in workspace scope with tsaStatus = FAILED",
    fingerprint: "one condition per (Evidence, tsa_failure)",
    resolution: "the record's RFC 3161 timestamp is validated",
    freshnessParticipating: true,
    surfaces: { home: true, notifications: true, operations: true },
  },
  {
    id: "evidence_integrity.ots_failed",
    owner: "Evidence.otsStatus",
    scopeAuthority: "WORKSPACE_EVIDENCE_SCOPE",
    discovery: "Evidence in workspace scope with otsStatus = FAILED",
    fingerprint: "one condition per (Evidence, ots_failure)",
    resolution: "the stored proof resolves to ANCHORED (a Bitcoin attestation recorded)",
    freshnessParticipating: true,
    surfaces: { home: true, notifications: true, operations: true },
  },
  {
    id: "evidence_integrity.ots_pending_aged",
    owner: "Evidence.otsStatus",
    scopeAuthority: "WORKSPACE_EVIDENCE_SCOPE",
    discovery: "Evidence in workspace scope pending an OTS upgrade past its window",
    // REGISTERED AND CURRENTLY SILENT, and the shared contract says so by
    // name: `syncEvidenceIntegrityConditions` iterates the two FAILED classes
    // only, so no persisted condition carries this source's identity today.
    fingerprint: "reserved: no condition currently carries this identity",
    resolution: "the stored proof resolves to ANCHORED (a Bitcoin attestation recorded)",
    freshnessParticipating: true,
    surfaces: { home: true, notifications: true, operations: true },
  },
  {
    id: "pipeline.report_backlog",
    owner: "Evidence.latestReportVersion",
    scopeAuthority: "WORKSPACE_EVIDENCE_SCOPE",
    discovery: "count of SIGNED evidence in workspace scope with no report",
    fingerprint: "one workspace-level condition, threshold-triggered",
    resolution: "the backlog falls below the HIGH threshold",
    freshnessParticipating: true,
    surfaces: { home: true, notifications: false, operations: true },
  },
  {
    id: "pipeline.package_backlog",
    owner: "Evidence.verificationPackageVersion",
    scopeAuthority: "WORKSPACE_EVIDENCE_SCOPE",
    discovery: "count of REPORTED evidence in workspace scope with no package",
    fingerprint: "one workspace-level condition, threshold-triggered",
    resolution: "the backlog falls below the HIGH threshold",
    freshnessParticipating: true,
    surfaces: { home: true, notifications: false, operations: true },
  },
  {
    id: "pipeline.signed_without_report_aged",
    owner: "Evidence.status",
    scopeAuthority: "WORKSPACE_EVIDENCE_SCOPE",
    // STATED FROM THE SCANNER, not from the source id. `scanUnsignedFinalizedAged`
    // counts `status = UPLOADED` past the window — upload complete, signing
    // still pending — which is a different population from SIGNED. The prose
    // here used to say SIGNED and the code has always said UPLOADED; the code
    // is the authority and this line now matches it.
    // RETIRED (OPS-13): no writer ever sets UPLOADED, so the scanner could
    // never observe this. It no longer participates in freshness and appears
    // on no customer surface; historical rows are closed as retired.
    discovery: "retired — counted Evidence(status=UPLOADED), a status no writer sets",
    fingerprint: "one workspace-level condition, threshold-triggered (historical rows only)",
    resolution: "closed by the existing-data reconciliation as retired, never as recovered",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: false },
  },
  {
    id: "review.stale_workflows",
    owner: "EvidenceReviewWorkflow",
    // NOT the model's own `team_id`. It is nullable AND its writer stores
    // `params.teamId ?? null`, so a workflow created without an explicit
    // workspace is invisible to a strict predicate. The Evidence row is the
    // ownership authority — the relation is `@unique`.
    scopeAuthority: "EVIDENCE_RELATION_SCOPE",
    discovery: "open review workflows on in-scope evidence, untouched past the window",
    fingerprint: "one workspace-level condition, threshold-triggered",
    resolution: "the stale set empties",
    freshnessParticipating: true,
    surfaces: { home: true, notifications: true, operations: true },
  },
  {
    id: "coordination.backlog_stale",
    owner: "EvidenceReviewerComment / EvidenceAnnotation / CaseComment",
    // The first two go through the Evidence relation. `CaseComment.team_id` is
    // NOT NULL — proven from the schema — so a strict predicate on THAT model
    // is complete, and widening it would be a change with no defect behind it.
    scopeAuthority: "EVIDENCE_RELATION_SCOPE",
    discovery: "unresolved comments and annotations older than the coordination window",
    fingerprint: "one workspace-level condition, threshold-triggered",
    resolution: "the unresolved set falls below threshold",
    freshnessParticipating: true,
    surfaces: { home: true, notifications: true, operations: true },
  },
  // RETIRED (OPS-002 / OPS-001). Kept as rows so their stored conditions
  // stay explainable; nothing discovers or produces them any more, and they
  // are on no surface. The "retry storm" counted re-observed workspace
  // conditions, not job retries; the "telemetry sampler" measured Home visits.
  {
    id: "queue.retry_storm",
    owner: "(retired — never produced)",
    scopeAuthority: "PLATFORM_TELEMETRY",
    discovery: "retired: not discovered",
    fingerprint: "none",
    resolution: "not applicable",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: false },
  },
  {
    id: "platform.telemetry_stale",
    owner: "(retired — never produced)",
    scopeAuthority: "PLATFORM_TELEMETRY",
    discovery: "retired: not discovered",
    fingerprint: "none",
    resolution: "not applicable",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: false },
  },
  {
    id: "platform.worker_heartbeat_stale",
    owner: "WorkerHeartbeat via getWorkerFleetHealth",
    scopeAuthority: "PLATFORM_TELEMETRY",
    discovery: "the worker-fleet liveness authority reports no live heartbeat, once per sweep tick",
    fingerprint: "ONE platform condition (platform:worker_heartbeat_stale), never one per workspace",
    resolution: "the fleet authority reports a live heartbeat",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: true },
  },
  {
    id: "platform.bitcoin_verifier_unavailable",
    owner: "Bitcoin verifier readiness via worker_telemetry_snapshots (kind OTS)",
    scopeAuthority: "PLATFORM_TELEMETRY",
    discovery: "live Bitcoin verification is enabled and the newest verifier readiness says not ready, once per sweep tick",
    fingerprint: "ONE platform condition (platform:bitcoin_verifier_unavailable), never one per workspace",
    resolution: "the verifier reports ready (it never changes evidence truth)",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: true },
  },
  // -------------------------------------------------------------------------
  // Sources that are REAL and are deliberately NOT discovered by this sweep.
  //
  // They are listed because the alternative is that they vanish. A category
  // that appears in `INCIDENT_CATEGORIES`, is written by some other authority,
  // and appears nowhere here would look — to anyone reading this file — like a
  // source nobody had thought about.
  // -------------------------------------------------------------------------
  {
    id: "intake.delivery_failed",
    // The id is historical. Its producers are the upload service failing to
    // start or resume an upload session (bridged security events); no intake
    // link delivery is recorded anywhere, so none is claimed.
    owner: "Upload sessions (upload service failures)",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written by the security-event bridge when the upload service fails to start or resume an upload",
    fingerprint: "one condition per (workspace, failure kind)",
    resolution: "an operator concludes the failure has been handled",
    // Written by its own domain at the moment of failure, not found by a
    // sweep. Requiring the sweep to attempt it would mean declaring a source
    // this run does not read, which is exactly the kind of claim the
    // accounting exists to prevent.
    freshnessParticipating: false,
    surfaces: { home: true, notifications: true, operations: true },
  },
  {
    id: "capture.upload_stalled",
    owner: "UploadSession",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written by the upload reconciler when a live upload of a not-yet-finalized record stops making progress",
    fingerprint: "one condition per upload (upload_stalled:<evidenceId>)",
    resolution: "the upload completes, is resumed or abandoned, or the record is finalized or deleted (probe)",
    // Written at the moment of the stall by the platform maintenance sweep, not
    // by the workspace operations sweep.
    freshnessParticipating: false,
    surfaces: { home: true, notifications: true, operations: true },
  },
  // HISTORY ONLY (2026-10-14): rows the retired per-workspace upload-session
  // bridge filed under intake.delivery_failed. Never produced again; shown to
  // their workspace as resolved history, never on Home or as a notification.
  {
    id: "capture.legacy_upload_session_signal",
    owner: "(retired — history only)",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "retired: not discovered",
    fingerprint: "the old bridge identity upload:security_event:upload_stalled",
    resolution: "history: closed by the truth reconciliation",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: true },
  },
  {
    id: "communications.provider_failure",
    owner: "NotificationDelivery",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written by the delivery authority on provider failure",
    fingerprint: "one condition per (provider, failure class)",
    resolution: "an operator concludes the message has been handled",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: true, operations: true },
  },
  {
    // OPS-13 — the destination the delivery runtime switched off by itself.
    id: "integration.webhook_destination_disabled",
    owner: "AutomationWebhookDestination.autoDisabledAt",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written by the delivery runtime when consecutive failures cross the auto-disable threshold",
    fingerprint: "one condition per destination",
    resolution: "the destination is re-enabled, which clears autoDisabledAt and the failure counter",
    freshnessParticipating: false,
    surfaces: { home: true, notifications: true, operations: true },
  },
  {
    id: "webhook.security_failure",
    owner: "AutomationWebhookDelivery",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written by the webhook dispatcher on signature or delivery failure",
    fingerprint: "one condition per destination",
    resolution: "an operator concludes the destination is healthy",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: true, operations: true },
  },
  {
    id: "search.indexing_failure",
    owner: "EvidenceSearchDocument / GovernanceReconciliationRun(SEARCH_INDEX)",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "the workspace's newest TERMINAL SEARCH_INDEX run has status FAILED or PARTIAL",
    fingerprint: "one condition per workspace index",
    resolution: "a later SEARCH_INDEX run for the workspace SUCCEEDS",
    // Advisory, like the telemetry sampler: nothing evidential depends on the
    // search index, so a workspace whose index is behind still has a complete
    // and truthful picture of its records. It is therefore not part of the
    // freshness contract that decides whether the sweep may be called
    // complete — being unable to read the run table does not make the
    // workspace's EVIDENCE picture partial.
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: true },
  },
  {
    id: "job.background_failure",
    owner: "BullMQ queues via the queue inventory",
    scopeAuthority: "PLATFORM_TELEMETRY",
    discovery: "jobs that failed after exhausting their retries in the last hour, read from the queue inventory once per sweep tick",
    fingerprint: "one PLATFORM condition per queue (platform:job_failure:<queue>)",
    resolution: "no final failure on that queue inside the window",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: true },
  },
  {
    id: "integration.configuration_failure",
    owner: "ApiCredential / integration settings",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    // NOT PRODUCED: no emitter writes this source (NOT_YET_DISCOVERED). It is
    // advertised on no surface until a real producer exists.
    discovery: "not produced — no emitter writes this source (registered for classification only)",
    fingerprint: "one condition per integration",
    resolution: "the configuration is corrected",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: false },
  },
  {
    id: "identity.security_condition",
    owner: "SecurityEvent",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written by the security-event authority",
    fingerprint: "one condition per (event class, window)",
    resolution: "an operator records the workspace's conclusion",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: true, operations: true },
  },
  {
    id: "governance.policy_condition",
    owner: "none — not produced",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "not produced: no emitter writes it and nothing routes to it (historical classification only)",
    fingerprint: "historical rows only",
    resolution: "not applicable — inactive",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: false },
  },
  {
    id: "storage.condition",
    owner: "object storage",
    scopeAuthority: "PLATFORM_TELEMETRY",
    // NOT PRODUCED: no emitter writes this source (NOT_YET_DISCOVERED). It is
    // advertised on no surface until a real producer exists.
    discovery: "not produced — no emitter writes this source (registered for classification only)",
    fingerprint: "one condition per failure class",
    resolution: "storage recovers",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: false },
  },
  {
    id: "ai.condition",
    owner: "AI provider budget / availability",
    scopeAuthority: "PLATFORM_TELEMETRY",
    // NOT PRODUCED: no emitter writes this source (NOT_YET_DISCOVERED). It is
    // advertised on no surface until a real producer exists.
    discovery: "not produced — no emitter writes this source (registered for classification only)",
    fingerprint: "one condition per failure class",
    resolution: "the provider recovers or the budget resets",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: false },
  },
  {
    id: "database.condition",
    owner: "PostgreSQL",
    scopeAuthority: "PLATFORM_TELEMETRY",
    // NOT PRODUCED: no emitter writes this source (NOT_YET_DISCOVERED). It is
    // advertised on no surface until a real producer exists.
    discovery: "not produced — no emitter writes this source (registered for classification only)",
    fingerprint: "one condition per failure class",
    resolution: "the database recovers",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: false },
  },
  // -------------------------------------------------------------------------
  // WRITTEN BY THEIR OWN DOMAIN, AT THE MOMENT IT HAPPENS.
  //
  // Thirteen production emitters — three access-control services, the
  // security-event bridge's default branch, the destruction reviewer, two
  // reviewer-ops engines, the operational seeder and five Worker emitters —
  // were writing conditions this accounting had never heard of. They were not
  // MISSING from the sweep; they are not the sweep's to find. Each is written
  // by the domain that observes the fault, at the instant it observes it.
  //
  // None of them is `freshnessParticipating`: requiring the sweep to attempt a
  // source it does not read would be declaring a coverage claim the run cannot
  // honour, which is exactly what this accounting exists to prevent.
  // -------------------------------------------------------------------------
  {
    id: "evidence_integrity.ots_budget_exhausted",
    owner: "Evidence.otsStatus (worker OTS processor)",
    scopeAuthority: "WORKSPACE_EVIDENCE_SCOPE",
    discovery: "written by the OTS processor when the global anchoring budget is spent",
    fingerprint: "one condition per (Evidence, budget exhaustion)",
    resolution: "the record's OpenTimestamps proof is anchored",
    freshnessParticipating: false,
    surfaces: { home: true, notifications: true, operations: true },
  },
  {
    id: "pipeline.report_generation_failed",
    owner: "Evidence.latestReportVersion (worker report processor)",
    scopeAuthority: "WORKSPACE_EVIDENCE_SCOPE",
    discovery: "written by the report processor when generation fails or exhausts retries",
    fingerprint: "one condition per (Evidence, error class)",
    resolution: "the record gains a report",
    freshnessParticipating: false,
    surfaces: { home: true, notifications: true, operations: true },
  },
  {
    // RELIABILITY CLOSURE (2026-09-09) — the never-attempted population. NULL
    // OTS columns were excluded from every scan in this file's sibling, so a
    // lost finalize→queue handoff was invisible by construction.
    id: "evidence_integrity.ots_initialization_stalled",
    owner: "Evidence.otsStatus / Evidence.otsProofBase64 (both NULL)",
    scopeAuthority: "WORKSPACE_EVIDENCE_SCOPE",
    discovery:
      "finalized evidence in workspace scope whose OTS columns are both NULL past the stalled-initialization window",
    fingerprint: "one condition per (Evidence, never-attempted)",
    resolution: "the record gains ANY OTS status",
    freshnessParticipating: false,
    surfaces: { home: true, notifications: true, operations: true },
  },
  {
    // RELIABILITY CLOSURE (2026-09-09) — a TECHNICAL package failure, distinct
    // from its governance-denied sibling below. A policy decision is not an
    // outage; a build or storage failure is, and it previously had no condition
    // at all — only a counter and a log line.
    id: "pipeline.package_generation_failed",
    owner: "Evidence.verificationPackageVersion (worker report processor)",
    scopeAuthority: "WORKSPACE_EVIDENCE_SCOPE",
    discovery:
      "written by the report processor when the verification package half of a generation fails to build or store",
    fingerprint: "one condition per (Evidence, error class)",
    resolution: "the record gains a verification package",
    freshnessParticipating: false,
    surfaces: { home: true, notifications: true, operations: true },
  },
  {
    id: "pipeline.package_generation_denied",
    owner: "Evidence.verificationPackageVersion (worker package gate)",
    scopeAuthority: "WORKSPACE_EVIDENCE_SCOPE",
    discovery: "written by the package-eligibility gate when it refuses to build",
    fingerprint: "one condition per (workspace, Evidence, denial outcome)",
    resolution: "the record gains a verification package",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: true, operations: true },
  },
  {
    id: "review.escalation",
    owner: "EvidenceReviewWorkflow.status",
    scopeAuthority: "EVIDENCE_RELATION_SCOPE",
    discovery: "written by the escalation engine on a HIGH/CRITICAL escalation",
    fingerprint: "one condition per (reason, workflow)",
    resolution: "the workflow leaves its open statuses",
    freshnessParticipating: false,
    surfaces: { home: true, notifications: true, operations: true },
  },
  {
    id: "review.escalation_storm",
    owner: "reviewer reconcile sweep",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written by the reviewer reconcile when one sweep crosses the storm threshold",
    fingerprint: "one condition per (workspace, day)",
    resolution: "an operator records a conclusion about workload",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: true, operations: true },
  },
  {
    // RETIRED (OPS-13). The bridge no longer writes a default row: an
    // unrecognised event type is counted and logged. Kept so historical rows
    // stay explainable; the existing-data reconciliation closes the ones whose
    // event type has since been classified.
    id: "security.unclassified_signal",
    owner: "(retired — never produced)",
    scopeAuthority: "PLATFORM_TELEMETRY",
    discovery: "retired: not discovered",
    fingerprint: "none",
    resolution: "not applicable",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: false },
  },
  {
    id: "identity.idp_outage",
    owner: "SsoConnection.outageDetectedAtUtc",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written by SSO hardening when consecutive callback failures cross the threshold",
    fingerprint: "one condition per SSO connection",
    resolution: "the first successful callback clears outageDetectedAtUtc",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: true, operations: true },
  },
  {
    id: "identity.runtime_block",
    owner: "adaptive runtime gate",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written when adaptive auth BLOCKS an action",
    fingerprint: "one condition per (workspace, action, hour)",
    resolution: "an operator records the investigation outcome",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: true, operations: true },
  },
  {
    id: "identity.high_risk_session_surge",
    owner: "runtime risk recompute",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written when one recompute sweep sees the high-risk session threshold crossed",
    fingerprint: "one condition per (workspace, dedup window)",
    resolution: "an operator records the investigation outcome",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: true, operations: true },
  },
  {
    id: "governance.retention_unverified",
    owner: "TrashGraceReconciler",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written when the lifecycle sweep cannot read a record's storage retention completely and consistently",
    fingerprint: "one condition per (record, cause)",
    resolution: "an operator records the investigation of the stored versions; the record is never purged meanwhile",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: true, operations: true },
  },
  {
    id: "governance.archive_restore_failed",
    owner: "EvidenceArchiveRestoreRequest",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written when a verified archive restore refuses to reactivate a record",
    fingerprint: "one condition per restore request",
    resolution: "an operator records the investigation; the record stays archived until a later restore verifies",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: true, operations: true },
  },
  {
    id: "governance.destruction_executed",
    owner: "DestructionReview",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written at the moment a destruction review is executed",
    fingerprint: "one condition per destruction review",
    resolution: "an operator acknowledges the record; the destruction is irreversible",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: true, operations: true },
  },
  {
    id: "governance.notification_escalated",
    owner: "GovernanceNotification",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written by the worker notification emitter on a HIGH/CRITICAL fan-out",
    fingerprint: "one condition per (kind, dedupe key)",
    resolution: "an operator records the follow-up",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: true, operations: true },
  },
  {
    id: "billing.dependent_cancellation_failed",
    owner: "WorkspaceStorageAddon.dependentCancellationState",
    // STRICT_WORKSPACE_COLUMN: an add-on belonging to a shared workspace
    // carries that workspace's team_id, and one belonging to a personal
    // account carries the owner's personal team. A workspace therefore sees
    // its own obligations and no others.
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery:
      "Recurring Storage add-ons in workspace scope whose dependentCancellationState is PENDING, RETRY_SCHEDULED, ACTION_REQUIRED or MANUAL_INTERVENTION",
    fingerprint: "one condition per (storage add-on, dependent_cancellation)",
    resolution:
      "the add-on's dependentCancellationState reaches CONFIRMED — which only a provider call or a provider observation writes",
    freshnessParticipating: true,
    // Home and Notifications too: the customer is being charged, and a fact
    // that costs money every month should not wait for someone to open the
    // Operations page.
    surfaces: { home: true, notifications: true, operations: true },
  },
  {
    /*
     * The provider has stopped accepting our credential.
     *
     * `recordProviderFailureSignal` has emitted this since the
     * reconciliation work landed, and the registry was never extended for it —
     * so the one incident class that NO customer action and no retry can
     * resolve arrived at Operations as an unregistered source. Consumers
     * classify, scope and route by registry entry, which means the incident
     * that most needs an operator was the one they were least able to see.
     *
     * PLATFORM-WIDE, not workspace-scoped: a refused API key is our
     * relationship with Stripe or PayPal, not one tenant's problem, and
     * `recordIncident` is called with `teamId: null` for exactly that reason.
     * One stable condition per provider, so a bad key opens one incident
     * rather than one per customer or sweep that observes the refusal.
     */
    id: "billing.provider_authorization",
    owner: "payment provider credential",
    // No tenant column exists on this condition at all — the emitter passes
    // `teamId: null` because a refused key is ours, not a customer's.
    scopeAuthority: "PLATFORM_TELEMETRY",
    discovery:
      "written when a provider reconciliation call fails with AUTHORIZATION_FAILED — the provider refused our credentials",
    fingerprint: "one condition per provider (stable: billing-provider-auth:<provider>)",
    resolution:
      "closed by the emitter on the next payment-provider observation that answers (customer re-check/abandon, the reconciliation sweep or checkout-attempt recovery); there is no probe that can observe a provider key becoming valid",
    freshnessParticipating: false,
    // Not a workspace's business, and nothing a customer can act on: this is
    // an operator page fact. It reaches Notifications because nobody is
    // watching Operations at 3am, and never Home, which is a customer surface.
    surfaces: { home: false, notifications: true, operations: true },
  },
  {
    id: "storage.immutable_drift",
    owner: "immutable storage reconciliation",
    scopeAuthority: "WORKSPACE_EVIDENCE_SCOPE",
    discovery: "written when the reconciler finds a record's immutable copy has drifted",
    fingerprint: "one condition per (outcome, Evidence)",
    resolution: "the newest ImmutableStorageCheck for the record reports OK, or a different drift class",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: true, operations: true },
  },
  {
    id: "platform.operational_seed",
    owner: "operational seeding flow",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written by the demo/staging seeder, tagged with its seed run",
    fingerprint: "one condition per (seed run, scenario)",
    resolution: "an operator dismisses the demo row",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: true },
  },
] as const;

/**
 * THE JOIN, AND THE TOTALITY CHECK THAT MAKES IT SAFE.
 *
 * A discovery row with no lifecycle contract throws at module load rather than
 * producing a source with an undefined authority. That is deliberately a hard
 * failure and not a filtered-out row: a source that silently disappeared from
 * this list would take its `freshnessParticipating` flag with it, and a run
 * that no longer required a source it used to require would report itself
 * complete over a workspace it had stopped looking at.
 */
export const OPERATIONS_SOURCES: readonly OperationsSource[] = Object.freeze(
  DISCOVERY.map((row): OperationsSource => {
    const lifecycle = lifecycleForSourceId(row.id);
    if (!lifecycle) {
      throw new Error(
        `operations source "${row.id}" has no lifecycle contract in OPERATIONS_SOURCE_LIFECYCLES`,
      );
    }
    return Object.freeze({
      ...row,
      lifecycle,
      disposition: lifecycle.remediationDisposition,
      requiredCapability: lifecycle.requiredCapability,
      remediationCategory: lifecycle.category,
      reopen: lifecycle.recurrencePolicy,
    });
  }),
);

/**
 * The reverse totality check: a lifecycle contract with no discovery row.
 *
 * Read at module load for the same reason. The two lists describe the same
 * twenty-two sources from two angles, and a source present in one and absent
 * from the other is a gap in whichever surface reads the shorter list.
 */
{
  const discovered = new Set(DISCOVERY.map((s) => s.id));
  const orphans = OPERATIONS_SOURCE_LIFECYCLES.filter(
    (l) => !discovered.has(l.sourceId),
  ).map((l) => l.sourceId);
  if (orphans.length > 0) {
    throw new Error(
      `lifecycle contracts with no discovery row: ${orphans.join(", ")}`,
    );
  }
}

/** Every source id, for accounting and for the closure gate. */
export function allSourceIds(): string[] {
  return OPERATIONS_SOURCES.map((s) => s.id);
}

/**
 * The sources whose failure makes a workspace's picture incomplete.
 *
 * This is what the run records as `requiredSources`, and therefore what
 * `PARTIAL` is measured against.
 */
export function requiredSourceIds(): string[] {
  return OPERATIONS_SOURCES.filter((s) => s.freshnessParticipating).map(
    (s) => s.id,
  );
}

export function sourceById(id: string): OperationsSource | null {
  return OPERATIONS_SOURCES.find((s) => s.id === id) ?? null;
}

/** Every incident category some registered source can produce. */
export function coveredIncidentCategories(): IncidentCategory[] {
  const out = new Set<IncidentCategory>();
  for (const s of OPERATIONS_SOURCES) out.add(s.remediationCategory);
  return [...out];
}
