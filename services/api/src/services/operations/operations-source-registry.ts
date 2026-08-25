/**
 * THE OPERATIONS SOURCE REGISTRY.
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
 * IT IS ALSO THE ANTI-DISAPPEARANCE RULE
 * --------------------------------------
 * Every source carries an explicit `disposition`. A source whose conditions
 * nobody can act on is not omitted — it is recorded as
 * `NO_SAFE_REMEDIATION_AUTHORITY` or `GUIDANCE_ONLY`, by name, so the absence
 * of a button is a decision on the record rather than an oversight nobody can
 * see. `verify-operations-source-registry.mjs` fails the build if a registered
 * incident category has no source, or a source has no disposition.
 *
 * RELATIONSHIP TO THE REMEDIATION REGISTRY
 * ----------------------------------------
 * `remediation-registry.ts` answers "given a condition that EXISTS, what may
 * an operator do about it?" — keyed by incident category and fingerprint
 * class. This file answers "what does discovery LOOK AT, and is that look
 * required for the picture to be complete?" They are different questions about
 * the same conditions, and the dispositions here are stated in the wider
 * vocabulary the convergence brief asked for, with `remediationCategory`
 * naming the row in the other registry that owns the action. Neither file
 * copies the other's answer.
 */

import type { IncidentCategory } from "@proovra/shared";

/**
 * What Operations can do about the conditions a source produces.
 *
 * Wider than `RemediationDisposition` because it also has to describe sources
 * whose conditions are not managed incidents at all — a per-user notification,
 * a specialised console — and "this source produces nothing actionable" has to
 * be sayable about those too.
 */
export const SOURCE_DISPOSITIONS = [
  /** Becomes an OperationalIncident with assignment, SLA and acknowledgement. */
  "MANAGED_INCIDENT",
  /** Reaches the person, never the shared queue. */
  "NOTIFICATION_ONLY",
  /** Owned by a purpose-built console (queues, signers, recovery). */
  "SPECIALIZED_SURFACE",
  /** Operations links to the surface that owns the fix. */
  "SAFE_DEEP_LINK",
  /** A real, domain-authorized action may be executed from Operations. */
  "SAFE_REMEDIATION",
  /** Explanation only. There is nothing to press and we say so. */
  "GUIDANCE_ONLY",
  /**
   * A remediation is imaginable and CANNOT be built safely. Recorded by name
   * so the refusal is auditable rather than looking like an omission.
   */
  "NO_SAFE_REMEDIATION_AUTHORITY",
  /** Not reachable in this product configuration. */
  "NOT_APPLICABLE",
] as const;
export type SourceDisposition = (typeof SOURCE_DISPOSITIONS)[number];

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

export type OperationsSource = {
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
  /** What happens when it becomes true again after resolving. */
  readonly reopen: "REOPEN_SAME_FINGERPRINT" | "NEW_CONDITION" | "NOT_APPLICABLE";
  /** Which canonical permission a viewer needs to see it. */
  readonly requiredCapability: string;
  readonly disposition: SourceDisposition;
  /**
   * The `remediation-registry` row that owns the ACTION, when there is one.
   * Null when the disposition is not an actionable one.
   */
  readonly remediationCategory: IncidentCategory | null;
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
 * The registry.
 *
 * Ordered by how a triaging operator would read them: provability first,
 * then the artifact pipeline, then coordination, then platform health.
 */
export const OPERATIONS_SOURCES: readonly OperationsSource[] = [
  {
    id: "evidence_integrity.tsa_failed",
    owner: "Evidence.tsaStatus",
    scopeAuthority: "WORKSPACE_EVIDENCE_SCOPE",
    discovery: "Evidence in workspace scope with tsaStatus = FAILED",
    fingerprint: "one condition per (Evidence, tsa_failure)",
    resolution: "the record's tsaStatus leaves FAILED",
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "evidence.read",
    // A timestamp proves a record existed at a moment. Re-contacting the
    // authority now would mint a token whose genTime is LATER than the
    // evidence it certifies, which is not a repair — it is a different and
    // weaker claim wearing the original's name.
    disposition: "NO_SAFE_REMEDIATION_AUTHORITY",
    remediationCategory: "EVIDENCE_INTEGRITY",
    freshnessParticipating: true,
    surfaces: { home: true, notifications: true, operations: true },
  },
  {
    id: "evidence_integrity.ots_failed",
    owner: "Evidence.otsStatus",
    scopeAuthority: "WORKSPACE_EVIDENCE_SCOPE",
    discovery: "Evidence in workspace scope with otsStatus = FAILED",
    fingerprint: "one condition per (Evidence, ots_failure)",
    resolution: "otsStatus reaches ANCHORED or UPGRADED",
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "evidence.publish_verify",
    // Unlike TSA, an OTS anchor is a calendar commitment that can legitimately
    // be re-attempted: retrying does not restate when the record existed.
    disposition: "SAFE_REMEDIATION",
    remediationCategory: "EVIDENCE_INTEGRITY",
    freshnessParticipating: true,
    surfaces: { home: true, notifications: true, operations: true },
  },
  {
    id: "evidence_integrity.ots_pending_aged",
    owner: "Evidence.otsStatus",
    scopeAuthority: "WORKSPACE_EVIDENCE_SCOPE",
    discovery: "Evidence in workspace scope pending an OTS upgrade past its window",
    fingerprint: "one condition per (Evidence, ots_pending)",
    resolution: "otsStatus reaches ANCHORED or UPGRADED",
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "evidence.publish_verify",
    disposition: "SAFE_REMEDIATION",
    remediationCategory: "EVIDENCE_INTEGRITY",
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
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "evidence.generate_report",
    disposition: "SAFE_REMEDIATION",
    remediationCategory: "REPORT",
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
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "evidence.generate_report",
    disposition: "SAFE_REMEDIATION",
    remediationCategory: "PACKAGE",
    freshnessParticipating: true,
    surfaces: { home: true, notifications: false, operations: true },
  },
  {
    id: "pipeline.signed_without_report_aged",
    owner: "Evidence.status",
    scopeAuthority: "WORKSPACE_EVIDENCE_SCOPE",
    discovery: "SIGNED evidence in workspace scope older than the unsigned-aged window",
    fingerprint: "one workspace-level condition, threshold-triggered",
    resolution: "the aged set empties",
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "evidence.generate_report",
    disposition: "SAFE_REMEDIATION",
    remediationCategory: "REPORT",
    freshnessParticipating: true,
    surfaces: { home: true, notifications: false, operations: true },
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
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "review.queue.read",
    disposition: "SAFE_DEEP_LINK",
    remediationCategory: "GOVERNANCE",
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
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "evidence.read",
    disposition: "SAFE_DEEP_LINK",
    remediationCategory: "GOVERNANCE",
    freshnessParticipating: true,
    surfaces: { home: true, notifications: true, operations: true },
  },
  {
    id: "queue.retry_storm",
    owner: "OperationalIncident.occurrenceCount",
    scopeAuthority: "WORKSPACE_INCIDENT_SCOPE",
    discovery: "unresolved conditions in this workspace above the re-fire threshold",
    fingerprint: "one workspace-level condition, threshold-triggered",
    resolution: "no unresolved condition remains above the threshold",
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "operations.view",
    disposition: "GUIDANCE_ONLY",
    remediationCategory: "RECONCILIATION",
    freshnessParticipating: true,
    surfaces: { home: false, notifications: false, operations: true },
  },
  {
    id: "platform.telemetry_stale",
    owner: "QueueTelemetrySnapshot",
    scopeAuthority: "PLATFORM_TELEMETRY",
    discovery: "no telemetry snapshot inside the staleness window",
    fingerprint: "one condition, platform-wide observation surfaced per workspace",
    resolution: "a fresh snapshot lands",
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "operations.view",
    // The tenant cannot fix platform telemetry, and offering a control that
    // pretends otherwise is worse than saying nothing.
    disposition: "GUIDANCE_ONLY",
    remediationCategory: "WORKER",
    // NOT freshness-participating: this is a statement about the PLATFORM, not
    // about whether this tenant has unresolved work. Letting it mark a
    // workspace PARTIAL would make every tenant un-clearable during a
    // telemetry outage that has nothing to do with their records.
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: true },
  },
  {
    id: "platform.worker_heartbeat_stale",
    owner: "WorkerTelemetry",
    scopeAuthority: "PLATFORM_TELEMETRY",
    discovery: "no worker heartbeat inside the staleness window",
    fingerprint: "one condition, platform-wide observation surfaced per workspace",
    resolution: "a heartbeat lands",
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "operations.view",
    disposition: "GUIDANCE_ONLY",
    remediationCategory: "WORKER",
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
    owner: "IntakeSession / delivery records",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written directly by the intake domain when a delivery fails",
    fingerprint: "one condition per failed delivery",
    resolution: "the delivery succeeds or the link is closed",
    reopen: "NEW_CONDITION",
    requiredCapability: "evidence.read",
    disposition: "SAFE_DEEP_LINK",
    remediationCategory: "UPLOAD",
    // Written by its own domain at the moment of failure, not found by a
    // sweep. Requiring the sweep to attempt it would mean declaring a source
    // this run does not read, which is exactly the kind of claim the
    // accounting exists to prevent.
    freshnessParticipating: false,
    surfaces: { home: true, notifications: true, operations: true },
  },
  {
    id: "communications.provider_failure",
    owner: "NotificationDelivery",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written by the delivery authority on provider failure",
    fingerprint: "one condition per (provider, failure class)",
    resolution: "a subsequent delivery succeeds",
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "operations.view",
    disposition: "SAFE_DEEP_LINK",
    remediationCategory: "COMMUNICATIONS",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: true, operations: true },
  },
  {
    id: "webhook.security_failure",
    owner: "AutomationWebhookDelivery",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written by the webhook dispatcher on signature or delivery failure",
    fingerprint: "one condition per destination",
    resolution: "a subsequent delivery succeeds",
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "integration.webhook.manage",
    disposition: "SAFE_DEEP_LINK",
    remediationCategory: "WEBHOOK",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: true, operations: true },
  },
  {
    id: "search.indexing_failure",
    owner: "EvidenceSearchDocument / GovernanceReconciliationRun(SEARCH_INDEX)",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "owned by the Search reconciliation authority and its readiness projection",
    fingerprint: "one condition per workspace index",
    resolution: "a SEARCH_INDEX run completes READY",
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "evidence.read",
    // Search has its own readiness surface with its own run authority. Copying
    // its state into an incident would be a second answer to a question that
    // already has one.
    disposition: "SPECIALIZED_SURFACE",
    remediationCategory: "RECONCILIATION",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: true },
  },
  {
    id: "job.background_failure",
    owner: "BullMQ queues",
    scopeAuthority: "PLATFORM_TELEMETRY",
    discovery: "owned by the queue console and its replay-safety authority",
    fingerprint: "one condition per (queue, failure class)",
    resolution: "the queue drains or the job is replayed",
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "operations.view",
    disposition: "SPECIALIZED_SURFACE",
    remediationCategory: "WORKER",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: true },
  },
  {
    id: "integration.configuration_failure",
    owner: "ApiCredential / integration settings",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written by the integration domain on configuration rejection",
    fingerprint: "one condition per integration",
    resolution: "the configuration is corrected",
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "integration.webhook.manage",
    disposition: "SAFE_DEEP_LINK",
    remediationCategory: "INTEGRATION",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: true, operations: true },
  },
  {
    id: "identity.security_condition",
    owner: "SecurityEvent",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written by the security-event authority",
    fingerprint: "one condition per (event class, window)",
    resolution: "the condition ages out of its window",
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "audit.read",
    disposition: "SAFE_DEEP_LINK",
    remediationCategory: "IDENTITY_SECURITY",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: true, operations: true },
  },
  {
    id: "governance.policy_condition",
    owner: "GovernanceReconciliationRun / retention",
    scopeAuthority: "STRICT_WORKSPACE_COLUMN",
    discovery: "written by the governance reconciliation families",
    fingerprint: "one condition per (family, workspace)",
    resolution: "a subsequent run of that family succeeds",
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "governance.policy.read",
    disposition: "SAFE_DEEP_LINK",
    remediationCategory: "GOVERNANCE",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: true },
  },
  {
    id: "storage.condition",
    owner: "object storage",
    scopeAuthority: "PLATFORM_TELEMETRY",
    discovery: "written by the storage health path",
    fingerprint: "one condition per failure class",
    resolution: "storage recovers",
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "operations.view",
    disposition: "GUIDANCE_ONLY",
    remediationCategory: "STORAGE",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: true },
  },
  {
    id: "ai.condition",
    owner: "AI provider budget / availability",
    scopeAuthority: "PLATFORM_TELEMETRY",
    discovery: "written by the AI runtime on budget or provider failure",
    fingerprint: "one condition per failure class",
    resolution: "the provider recovers or the budget resets",
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "operations.view",
    disposition: "GUIDANCE_ONLY",
    remediationCategory: "AI",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: true },
  },
  {
    id: "database.condition",
    owner: "PostgreSQL",
    scopeAuthority: "PLATFORM_TELEMETRY",
    discovery: "written by the health path on database failure",
    fingerprint: "one condition per failure class",
    resolution: "the database recovers",
    reopen: "REOPEN_SAME_FINGERPRINT",
    requiredCapability: "operations.view",
    disposition: "GUIDANCE_ONLY",
    remediationCategory: "DATABASE",
    freshnessParticipating: false,
    surfaces: { home: false, notifications: false, operations: true },
  },
] as const;

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
  for (const s of OPERATIONS_SOURCES) {
    if (s.remediationCategory) out.add(s.remediationCategory);
  }
  return [...out];
}
