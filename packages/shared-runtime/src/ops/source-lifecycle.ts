/**
 * THE OPERATIONS SOURCE LIFECYCLE CONTRACT.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG, AND WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * Resolution authority used to be declared per `IncidentCategory`. There are
 * fourteen categories and twenty-two Operations SOURCES, and the mapping is
 * neither one-to-one nor close to it: four different sources write category
 * WORKER, and three unrelated writers put conditions under REPORT. So a rule
 * stated per category was a rule stated about a set nobody had enumerated.
 *
 * The measured consequence: `pipeline.report_backlog` inherited
 * `REPORT -> OPERATOR_MAY_RESOLVE`, so an operator could declare
 *
 *     "Report backlog above threshold (26)"
 *
 * RESOLVED while all twenty-six records were still above the threshold. The
 * next sweep reopened it — correctly, and minutes later — so the workspace
 * displayed a false all-clear for up to one reconciliation interval, and the
 * operator learned that the button does not mean anything.
 *
 * Authority is a property of the SOURCE, because the question it answers —
 * "can this condition's own source tell us whether it is still true?" — is a
 * question about the source and about nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY SEPARATE
 * ---------------------------------------------------------------------------
 * REMEDIATION and RESOLUTION are different questions and are declared
 * separately:
 *
 *   remediationDisposition   what an operator may DO about the condition
 *   resolutionAuthority      whether an operator may declare it OVER
 *
 * They come apart in both directions, which is why conflating them was a
 * defect rather than a shortcut. `pipeline.report_backlog` has a real
 * remediation (regenerate the artifacts) AND is source-truth: pressing the
 * button is allowed, calling the backlog gone is not. `tsa_failed` has NO safe
 * remediation at all and is also source-truth. Nothing may read
 * `SAFE_REMEDIATION` as implying `OPERATOR_DECISION`.
 *
 * ---------------------------------------------------------------------------
 * WHY IT LIVES IN shared-runtime
 * ---------------------------------------------------------------------------
 * Both hosts write operational conditions — the API's `recordIncident` and the
 * Worker's `recordWorkerIncident`. A lifecycle contract that lived in one of
 * them would be a contract the other could not consult, which is exactly how
 * the transition rule drifted before `incident-transition-authority.ts`
 * brought it here.
 *
 * This module is pure. It reads no database, holds no clock and performs no
 * I/O. The probes that ask a source what it currently says are implemented in
 * the API, keyed by the `activityProbeKey` declared here; the POLICY is not
 * duplicated inside them.
 */

import type { IncidentCategory } from "@proovra/shared";

// ===========================================================================
// VOCABULARY
// ===========================================================================

/**
 * WHO MAY DECLARE A CONDITION FROM THIS SOURCE RESOLVED.
 *
 * SOURCE_TRUTH
 *   A deterministic probe of the source answers "is this still true?". The
 *   source decides; recovery resolves the condition automatically and an
 *   operator may not contradict an active source.
 *
 * OPERATOR_DECISION
 *   Resolution is a human operational conclusion, not a technical fact — the
 *   condition records something that HAPPENED, and whether the workspace is
 *   done with it is a judgement. Never used merely because no probe exists.
 *
 * NO_DIRECT_RESOLUTION
 *   The workspace cannot truthfully declare the condition recovered and the
 *   platform has no safe probe. There is no Resolve action at all: only
 *   acknowledge, assign, suppress, and whatever safe remediation exists.
 */
export const RESOLUTION_AUTHORITIES = [
  "SOURCE_TRUTH",
  "OPERATOR_DECISION",
  "NO_DIRECT_RESOLUTION",
] as const;
export type ResolutionAuthority = (typeof RESOLUTION_AUTHORITIES)[number];

/**
 * WHAT A PROBE SAW.
 *
 * UNKNOWN is a first-class answer and never collapses into either of the other
 * two. "We could not check" is not "it is fine", and it is not "it is still
 * broken" either — it is its own state, and it fails closed.
 *
 * NOT_APPLICABLE means the SUBJECT the condition names cannot be identified at
 * all — most often a record that has since been deleted. It is distinguishable
 * from UNKNOWN because a subject that is gone can never be observed active
 * again, so refusing on it would leave the condition permanently unclosable by
 * anyone. Each source states what it means.
 */
export const SOURCE_ACTIVITIES = [
  "ACTIVE",
  "RECOVERED",
  "UNKNOWN",
  "NOT_APPLICABLE",
] as const;
export type SourceActivity = (typeof SOURCE_ACTIVITIES)[number];

/** Who the condition is FOR, which decides where it is projected. */
export const OPERATIONS_AUDIENCES = [
  /** The workspace has a safe action, remediation, assignment or workflow. */
  "TENANT_ACTIONABLE",
  /**
   * The condition affects the workspace and the workspace cannot repair the
   * component. Shown as bounded health information, never with a Resolve
   * control that would pretend otherwise.
   */
  "TENANT_ADVISORY",
  /**
   * Internal platform telemetry with nothing actionable for the tenant. It
   * belongs on the platform observability surface, not in a tenant queue.
   */
  "PLATFORM_INTERNAL",
] as const;
export type OperationsAudience = (typeof OPERATIONS_AUDIENCES)[number];

/** How many real-world things one condition stands for. */
export const SOURCE_CARDINALITIES = [
  /** One condition per affected record. Ten records are ten conditions. */
  "PER_RECORD",
  /** One workspace-level condition over a counted population. */
  "AGGREGATE",
  /** One condition per thing that happened. */
  "EVENT",
] as const;
export type SourceCardinality = (typeof SOURCE_CARDINALITIES)[number];

/** What makes a condition from this source stop being true. */
export const SOURCE_RECOVERY_POLICIES = [
  /** A probe observes recovery and the condition resolves itself. */
  "PROBE_AUTO_RESOLVE",
  /** No probe. A person decides the work is finished. */
  "OPERATOR_CLOSES",
  /** Neither. The condition is carried until its own surface clears it. */
  "NO_RECOVERY_SIGNAL",
] as const;
export type SourceRecoveryPolicy = (typeof SOURCE_RECOVERY_POLICIES)[number];

/** What happens when the condition becomes true again after resolving. */
export const SOURCE_RECURRENCE_POLICIES = [
  "REOPEN_SAME_FINGERPRINT",
  "NEW_CONDITION",
  "NOT_APPLICABLE",
] as const;
export type SourceRecurrencePolicy =
  (typeof SOURCE_RECURRENCE_POLICIES)[number];

/** Whether suppression is offered, and what a re-observation does to it. */
export const SOURCE_SUPPRESSION_POLICIES = [
  /** Suppression survives every re-observation until the source recovers. */
  "SUPPRESSION_PERSISTS",
  /** Suppression is not a meaningful answer for this source. */
  "SUPPRESSION_NOT_OFFERED",
] as const;
export type SourceSuppressionPolicy =
  (typeof SOURCE_SUPPRESSION_POLICIES)[number];

/**
 * What Operations is prepared to DO about conditions from this source.
 *
 * The same vocabulary the API source registry has always used, moved here so
 * remediation and resolution are declared side by side and the difference
 * between them is impossible to miss.
 */
export const REMEDIATION_DISPOSITIONS = [
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
export type SourceRemediationDisposition =
  (typeof REMEDIATION_DISPOSITIONS)[number];

/** Whether the condition can arise in an ordinary tenant workspace. */
export const SOURCE_WORKSPACE_APPLICABILITIES = [
  /** Personal, Team, Organization and Enterprise alike. */
  "ALL_WORKSPACES",
  /** Observed platform-wide and surfaced per workspace as advisory. */
  "PLATFORM_OBSERVED",
] as const;
export type SourceWorkspaceApplicability =
  (typeof SOURCE_WORKSPACE_APPLICABILITIES)[number];

/** Does this source carry a current aggregate value, and of what? */
export const SOURCE_METRIC_CONTRACTS = [
  /** No number. The condition is the whole statement. */
  "NONE",
  /** A counted population measured against a threshold. */
  "AGGREGATE_THRESHOLD",
  /** An elapsed age in minutes measured against a staleness window. */
  "AGE_THRESHOLD",
] as const;
export type SourceMetricContract = (typeof SOURCE_METRIC_CONTRACTS)[number];

/** What an operator can open FROM the condition to see what it stands for. */
export const SOURCE_DRILL_DOWN_CONTRACTS = [
  "NONE",
  /** The affected records, paginated on the owning surface. */
  "AFFECTED_RECORDS",
  /** The specialised console that owns the subject. */
  "SOURCE_SURFACE",
] as const;
export type SourceDrillDownContract =
  (typeof SOURCE_DRILL_DOWN_CONTRACTS)[number];

/**
 * WHAT MAY BE DONE WHEN A PROBE ANSWERS NOT_APPLICABLE.
 *
 * Stated per source rather than assumed, because the two honest answers exist
 * in the product and they are opposites:
 *
 *   ALLOW_OPERATOR_CLOSE  the subject can legitimately vanish (a record is
 *                         deleted), and a condition that can never be
 *                         re-observed must not be unclosable forever;
 *   REFUSE                the subject cannot vanish, so NOT_APPLICABLE means
 *                         the probe is wrong and must never resolve anything.
 */
export const NOT_APPLICABLE_DISPOSITIONS = [
  "ALLOW_OPERATOR_CLOSE",
  "REFUSE",
] as const;
export type NotApplicableDisposition =
  (typeof NOT_APPLICABLE_DISPOSITIONS)[number];

/**
 * THE PROBE KEYS.
 *
 * One key per deterministic observation the product can actually make. The
 * IMPLEMENTATION lives in the API (it needs a database); the key is declared
 * here so a source cannot claim SOURCE_TRUTH without naming the observation
 * that backs the claim, and so the implementation map can be checked
 * exhaustive against this union at compile time.
 *
 * `NONE` is the explicit answer for a source with no probe. It is a member of
 * the union rather than a null so that "this source has no probe" is a stated
 * decision instead of a missing field.
 */
export const ACTIVITY_PROBE_KEYS = [
  "NONE",
  "evidence.tsa_status",
  "evidence.ots_status",
  "evidence.ots_pending_age",
  "pipeline.report_backlog_count",
  "pipeline.package_backlog_count",
  "pipeline.signed_without_report_aged_count",
  "review.stale_workflow_count",
  "coordination.stale_backlog_count",
  "queue.retry_storm_count",
  "platform.telemetry_age",
  "platform.worker_heartbeat_age",
] as const;
export type ActivityProbeKey = (typeof ACTIVITY_PROBE_KEYS)[number];

// ===========================================================================
// CONDITION IDENTITY — WHICH SOURCE OWNS A GIVEN CONDITION
// ===========================================================================

/**
 * How a persisted condition is traced back to the source that owns it.
 *
 * FINGERPRINT FIRST, CATEGORY NEVER ALONE. Category cannot do this job: four
 * sources write WORKER and three unrelated writers put conditions under
 * REPORT, so a category lookup would hand `pipeline.report_backlog`'s
 * backlog-count probe to a per-record report-generation failure and refuse a
 * resolution on a number that has nothing to do with it.
 *
 * FINGERPRINT_PREFIX     the sweep's own workspace-level fingerprints, which
 *                        are `<prefix>:<teamId>` and therefore matched on the
 *                        prefix and not on the whole string;
 * FINGERPRINT_CLASS      the per-record integrity fingerprints, `<class>:<id>`;
 * CATEGORY_RESIDUAL      a source that writes its own conditions from its own
 *                        domain and OWNS its category outright — claimed only
 *                        where no sweep source shares that category identity;
 * NOT_DISCOVERED         registered, and currently producing no conditions.
 */
export type SourceConditionIdentity =
  | { readonly kind: "FINGERPRINT_PREFIX"; readonly prefix: string }
  | { readonly kind: "FINGERPRINT_CLASS"; readonly className: string }
  | { readonly kind: "CATEGORY_RESIDUAL"; readonly category: IncidentCategory }
  | { readonly kind: "NOT_DISCOVERED" };

// ===========================================================================
// THE CONTRACT
// ===========================================================================

export type OperationsSourceLifecycle = {
  /** Stable source id. The same id the discovery accounting records. */
  readonly sourceId: string;
  /** The incident category conditions from this source carry. */
  readonly category: IncidentCategory;
  /** How a persisted condition is traced back to this source. */
  readonly identity: SourceConditionIdentity;
  readonly resolutionAuthority: ResolutionAuthority;
  /** The observation that backs a SOURCE_TRUTH claim. `NONE` otherwise. */
  readonly activityProbeKey: ActivityProbeKey;
  readonly recoveryPolicy: SourceRecoveryPolicy;
  readonly recurrencePolicy: SourceRecurrencePolicy;
  readonly suppressionPolicy: SourceSuppressionPolicy;
  /** What may be DONE. Never read as permission to declare it over. */
  readonly remediationDisposition: SourceRemediationDisposition;
  /** The canonical permission a viewer needs to see conditions from it. */
  readonly requiredCapability: string;
  readonly audience: OperationsAudience;
  readonly cardinality: SourceCardinality;
  readonly workspaceApplicability: SourceWorkspaceApplicability;
  readonly metricContract: SourceMetricContract;
  readonly drillDownContract: SourceDrillDownContract;
  readonly notApplicableDisposition: NotApplicableDisposition;
  /** Why this authority, in one sentence, for the person who reads the row. */
  readonly rationale: string;
};

/**
 * THE TWENTY-TWO SOURCES, UNGROUPED.
 *
 * Every field is required by the type, so a new source cannot compile without
 * an answer to every lifecycle question. There is no default and no fallback
 * to `OPERATOR_DECISION`: an undecided source does not build.
 */
export const OPERATIONS_SOURCE_LIFECYCLES: readonly OperationsSourceLifecycle[] =
  Object.freeze([
    // -----------------------------------------------------------------------
    // PROVABILITY — per record, one condition per record per failure class.
    // -----------------------------------------------------------------------
    {
      sourceId: "evidence_integrity.tsa_failed",
      category: "EVIDENCE_INTEGRITY",
      identity: { kind: "FINGERPRINT_CLASS", className: "tsa_failure" },
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "evidence.tsa_status",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      // A timestamp proves a record existed at a moment. Re-contacting the
      // authority now would mint a token whose genTime is LATER than the
      // evidence it certifies — a different and weaker claim wearing the
      // original's name. There is no safe remediation, and there is also no
      // operator resolution: the record's own column decides.
      remediationDisposition: "NO_SAFE_REMEDIATION_AUTHORITY",
      requiredCapability: "evidence.read",
      audience: "TENANT_ACTIONABLE",
      cardinality: "PER_RECORD",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "NONE",
      // The record can be deleted. A condition whose record is gone can never
      // be observed active again, so it must remain closable.
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      rationale:
        "Evidence.tsaStatus is a deterministic per-record column, and the recovery sweep already closes these from it.",
    },
    {
      sourceId: "evidence_integrity.ots_failed",
      category: "EVIDENCE_INTEGRITY",
      identity: { kind: "FINGERPRINT_CLASS", className: "ots_failure" },
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "evidence.ots_status",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      // Unlike TSA, an OTS anchor is a calendar commitment that can honestly
      // be re-attempted: retrying does not restate WHEN the record existed.
      // A real remediation, and still not a licence to declare it over.
      remediationDisposition: "SAFE_REMEDIATION",
      requiredCapability: "evidence.publish_verify",
      audience: "TENANT_ACTIONABLE",
      cardinality: "PER_RECORD",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "NONE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      rationale:
        "Evidence.otsStatus is a deterministic per-record column read by the same recovery sweep.",
    },
    {
      sourceId: "evidence_integrity.ots_pending_aged",
      category: "EVIDENCE_INTEGRITY",
      // REGISTERED AND CURRENTLY SILENT. `syncEvidenceIntegrityConditions`
      // iterates the two FAILED classes only, so no persisted condition
      // carries this source's identity today. Recorded as NOT_DISCOVERED
      // rather than given a fingerprint it does not write, because a claimed
      // identity that matches nothing is worse than an admitted silence.
      identity: { kind: "NOT_DISCOVERED" },
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "evidence.ots_pending_age",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_REMEDIATION",
      requiredCapability: "evidence.publish_verify",
      audience: "TENANT_ACTIONABLE",
      cardinality: "PER_RECORD",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "NONE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      rationale:
        "The pending-upgrade window is read from Evidence.otsStatus, the same deterministic column its failed sibling uses.",
    },
    // -----------------------------------------------------------------------
    // THE ARTIFACT PIPELINE — one workspace-level condition over a count.
    // -----------------------------------------------------------------------
    {
      sourceId: "pipeline.report_backlog",
      category: "REPORT",
      identity: {
        kind: "FINGERPRINT_PREFIX",
        prefix: "dashboard:pipeline:report_backlog",
      },
      // THE DEFECT THIS CLOSES. Inherited OPERATOR_MAY_RESOLVE from category
      // REPORT and let an operator declare a 26-record backlog over while all
      // 26 records were still above the threshold.
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "pipeline.report_backlog_count",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_REMEDIATION",
      requiredCapability: "evidence.generate_report",
      audience: "TENANT_ACTIONABLE",
      cardinality: "AGGREGATE",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "AGGREGATE_THRESHOLD",
      drillDownContract: "AFFECTED_RECORDS",
      // A workspace-level count cannot become unidentifiable.
      notApplicableDisposition: "REFUSE",
      rationale:
        "The count of SIGNED evidence with no report is re-countable on demand, so whether the backlog is still above threshold is a fact and not a judgement.",
    },
    {
      sourceId: "pipeline.package_backlog",
      category: "PACKAGE",
      identity: {
        kind: "FINGERPRINT_PREFIX",
        prefix: "dashboard:pipeline:package_backlog",
      },
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "pipeline.package_backlog_count",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_REMEDIATION",
      requiredCapability: "evidence.generate_report",
      audience: "TENANT_ACTIONABLE",
      cardinality: "AGGREGATE",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "AGGREGATE_THRESHOLD",
      drillDownContract: "AFFECTED_RECORDS",
      notApplicableDisposition: "REFUSE",
      rationale:
        "The count of REPORTED evidence with no verification package is re-countable on demand.",
    },
    {
      sourceId: "pipeline.signed_without_report_aged",
      category: "GOVERNANCE",
      identity: {
        kind: "FINGERPRINT_PREFIX",
        prefix: "dashboard:integrity:unsigned_aged",
      },
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "pipeline.signed_without_report_aged_count",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_REMEDIATION",
      requiredCapability: "evidence.generate_report",
      audience: "TENANT_ACTIONABLE",
      cardinality: "AGGREGATE",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "AGGREGATE_THRESHOLD",
      drillDownContract: "AFFECTED_RECORDS",
      notApplicableDisposition: "REFUSE",
      rationale:
        "The aged uploaded-but-unsigned set is a re-countable population measured against a fixed window.",
    },
    // -----------------------------------------------------------------------
    // COORDINATION — human work, counted, but still a countable fact.
    // -----------------------------------------------------------------------
    {
      sourceId: "review.stale_workflows",
      category: "WORKER",
      identity: {
        kind: "FINGERPRINT_PREFIX",
        prefix: "dashboard:review:stale_assignments",
      },
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "review.stale_workflow_count",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_DEEP_LINK",
      requiredCapability: "review.queue.read",
      audience: "TENANT_ACTIONABLE",
      cardinality: "AGGREGATE",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "AGGREGATE_THRESHOLD",
      drillDownContract: "AFFECTED_RECORDS",
      notApplicableDisposition: "REFUSE",
      rationale:
        "Whether untouched review workflows still exist past the window is a count, not an opinion — the workflows either moved or they did not.",
    },
    {
      sourceId: "coordination.backlog_stale",
      category: "GOVERNANCE",
      identity: {
        kind: "FINGERPRINT_PREFIX",
        prefix: "dashboard:coordination:stale_backlog",
      },
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "coordination.stale_backlog_count",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_DEEP_LINK",
      requiredCapability: "evidence.read",
      audience: "TENANT_ACTIONABLE",
      cardinality: "AGGREGATE",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "AGGREGATE_THRESHOLD",
      drillDownContract: "AFFECTED_RECORDS",
      notApplicableDisposition: "REFUSE",
      rationale:
        "Unresolved comments and annotations past the window are counted from their own resolvedAtUtc columns.",
    },
    {
      sourceId: "queue.retry_storm",
      category: "WORKER",
      identity: {
        kind: "FINGERPRINT_PREFIX",
        prefix: "dashboard:reliability:retry_storms",
      },
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "queue.retry_storm_count",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      // Nothing to press: the storm ends when the conditions underneath it are
      // dealt with, and a button claiming to end it would be a fiction.
      remediationDisposition: "GUIDANCE_ONLY",
      requiredCapability: "operations.view",
      audience: "TENANT_ACTIONABLE",
      cardinality: "AGGREGATE",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "AGGREGATE_THRESHOLD",
      drillDownContract: "AFFECTED_RECORDS",
      notApplicableDisposition: "REFUSE",
      rationale:
        "The storm is defined as a count of this workspace's own re-firing conditions, which is re-countable at any moment.",
    },
    // -----------------------------------------------------------------------
    // PLATFORM HEALTH — true about the platform, shown to the tenant.
    // -----------------------------------------------------------------------
    {
      sourceId: "platform.telemetry_stale",
      category: "WORKER",
      identity: {
        kind: "FINGERPRINT_PREFIX",
        prefix: "dashboard:telemetry:queue_stale",
      },
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "platform.telemetry_age",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "GUIDANCE_ONLY",
      requiredCapability: "operations.view",
      // The tenant cannot restart the sampler. Advisory, and therefore never
      // carrying a Resolve control that would pretend they could.
      audience: "TENANT_ADVISORY",
      cardinality: "AGGREGATE",
      workspaceApplicability: "PLATFORM_OBSERVED",
      metricContract: "AGE_THRESHOLD",
      drillDownContract: "NONE",
      notApplicableDisposition: "REFUSE",
      rationale:
        "The age of the freshest telemetry snapshot is a clock reading, so recovery is observed rather than asserted.",
    },
    {
      sourceId: "platform.worker_heartbeat_stale",
      category: "WORKER",
      identity: {
        kind: "FINGERPRINT_PREFIX",
        prefix: "dashboard:worker:heartbeat_stale",
      },
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "platform.worker_heartbeat_age",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "GUIDANCE_ONLY",
      requiredCapability: "operations.view",
      audience: "TENANT_ADVISORY",
      cardinality: "AGGREGATE",
      workspaceApplicability: "PLATFORM_OBSERVED",
      metricContract: "AGE_THRESHOLD",
      drillDownContract: "NONE",
      notApplicableDisposition: "REFUSE",
      rationale:
        "The age of the last persisted heartbeat is a clock reading against a fixed window.",
    },
    // -----------------------------------------------------------------------
    // DOMAIN-WRITTEN CONDITIONS.
    //
    // These are not found by the sweep. Their own domain writes them at the
    // moment something happens, and each one owns its category outright — no
    // sweep source shares a category identity with any of them, so a residual
    // category match is unambiguous rather than a guess.
    // -----------------------------------------------------------------------
    {
      sourceId: "intake.delivery_failed",
      category: "UPLOAD",
      identity: { kind: "CATEGORY_RESIDUAL", category: "UPLOAD" },
      // EVENT-SHAPED. A delivery that failed at 14:02 failed; nothing can make
      // that untrue later, so there is no state to probe. Whether the
      // workspace is finished with it — re-sent, chased, written off — is a
      // human conclusion, which is what OPERATOR_DECISION means.
      resolutionAuthority: "OPERATOR_DECISION",
      activityProbeKey: "NONE",
      recoveryPolicy: "OPERATOR_CLOSES",
      recurrencePolicy: "NEW_CONDITION",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_DEEP_LINK",
      requiredCapability: "evidence.read",
      audience: "TENANT_ACTIONABLE",
      cardinality: "EVENT",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      rationale:
        "A failed intake delivery is a past event with a real workspace follow-up, and its completion is a person's conclusion rather than a column.",
    },
    {
      sourceId: "communications.provider_failure",
      category: "COMMUNICATIONS",
      identity: { kind: "CATEGORY_RESIDUAL", category: "COMMUNICATIONS" },
      resolutionAuthority: "OPERATOR_DECISION",
      activityProbeKey: "NONE",
      recoveryPolicy: "OPERATOR_CLOSES",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_DEEP_LINK",
      requiredCapability: "operations.view",
      audience: "TENANT_ACTIONABLE",
      cardinality: "EVENT",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      rationale:
        "A delivery attempt that failed is a recorded attempt; the workspace decides whether the message has since been handled.",
    },
    {
      sourceId: "webhook.security_failure",
      category: "WEBHOOK",
      identity: { kind: "CATEGORY_RESIDUAL", category: "WEBHOOK" },
      resolutionAuthority: "OPERATOR_DECISION",
      activityProbeKey: "NONE",
      recoveryPolicy: "OPERATOR_CLOSES",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_DEEP_LINK",
      requiredCapability: "integration.webhook.manage",
      audience: "TENANT_ACTIONABLE",
      cardinality: "EVENT",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      rationale:
        "A signature or delivery failure on a destination is a past attempt the integrations surface owns; closing it is the operator's conclusion about that destination.",
    },
    {
      sourceId: "integration.configuration_failure",
      category: "INTEGRATION",
      identity: { kind: "CATEGORY_RESIDUAL", category: "INTEGRATION" },
      resolutionAuthority: "OPERATOR_DECISION",
      activityProbeKey: "NONE",
      recoveryPolicy: "OPERATOR_CLOSES",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_DEEP_LINK",
      requiredCapability: "integration.webhook.manage",
      audience: "TENANT_ACTIONABLE",
      cardinality: "EVENT",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      rationale:
        "The workspace owns its own integration configuration, so whether it has been corrected is exactly the kind of thing its operators know and the platform does not.",
    },
    {
      sourceId: "identity.security_condition",
      category: "IDENTITY_SECURITY",
      identity: { kind: "CATEGORY_RESIDUAL", category: "IDENTITY_SECURITY" },
      resolutionAuthority: "OPERATOR_DECISION",
      activityProbeKey: "NONE",
      recoveryPolicy: "OPERATOR_CLOSES",
      recurrencePolicy: "NEW_CONDITION",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_DEEP_LINK",
      requiredCapability: "audit.read",
      audience: "TENANT_ACTIONABLE",
      cardinality: "EVENT",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      rationale:
        "A security event happened; Security Center adjudicates it, and Operations records the workspace's conclusion rather than inventing a second verdict.",
    },
    {
      sourceId: "governance.policy_condition",
      category: "GOVERNANCE",
      identity: { kind: "CATEGORY_RESIDUAL", category: "GOVERNANCE" },
      resolutionAuthority: "OPERATOR_DECISION",
      activityProbeKey: "NONE",
      recoveryPolicy: "OPERATOR_CLOSES",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_DEEP_LINK",
      requiredCapability: "governance.policy.read",
      audience: "TENANT_ACTIONABLE",
      cardinality: "EVENT",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      rationale:
        "A governance family reported a discrepancy on one run; whether the workspace has dealt with it is a governance conclusion made on the governance surface.",
    },
    {
      sourceId: "search.indexing_failure",
      category: "RECONCILIATION",
      identity: { kind: "CATEGORY_RESIDUAL", category: "RECONCILIATION" },
      // The Search readiness authority owns whether the index is healthy. The
      // workspace cannot see that state from here and must not assert it, and
      // Operations must not become a second answer to a question that already
      // has one.
      resolutionAuthority: "NO_DIRECT_RESOLUTION",
      activityProbeKey: "NONE",
      recoveryPolicy: "NO_RECOVERY_SIGNAL",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SPECIALIZED_SURFACE",
      requiredCapability: "evidence.read",
      audience: "TENANT_ADVISORY",
      cardinality: "AGGREGATE",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "REFUSE",
      rationale:
        "Index health is owned by the SEARCH_INDEX run authority and its own readiness projection; a Resolve here would be a workspace overruling a surface it cannot read.",
    },
    {
      sourceId: "job.background_failure",
      category: "WORKER",
      identity: { kind: "CATEGORY_RESIDUAL", category: "WORKER" },
      // Platform queue state. The tenant cannot drain a queue, cannot replay a
      // job from here, and cannot know that the queue recovered.
      resolutionAuthority: "NO_DIRECT_RESOLUTION",
      activityProbeKey: "NONE",
      recoveryPolicy: "NO_RECOVERY_SIGNAL",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SPECIALIZED_SURFACE",
      requiredCapability: "operations.view",
      audience: "TENANT_ADVISORY",
      cardinality: "EVENT",
      workspaceApplicability: "PLATFORM_OBSERVED",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "REFUSE",
      rationale:
        "The queue console and its replay-safety authority own background job state; the workspace has no read that would let it declare the queue well.",
    },
    {
      sourceId: "storage.condition",
      category: "STORAGE",
      identity: { kind: "CATEGORY_RESIDUAL", category: "STORAGE" },
      resolutionAuthority: "NO_DIRECT_RESOLUTION",
      activityProbeKey: "NONE",
      recoveryPolicy: "NO_RECOVERY_SIGNAL",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "GUIDANCE_ONLY",
      requiredCapability: "operations.view",
      audience: "TENANT_ADVISORY",
      cardinality: "EVENT",
      workspaceApplicability: "PLATFORM_OBSERVED",
      metricContract: "NONE",
      drillDownContract: "NONE",
      notApplicableDisposition: "REFUSE",
      rationale:
        "Object storage is platform infrastructure; a workspace declaring it recovered would be asserting something it has no way to observe.",
    },
    {
      sourceId: "ai.condition",
      category: "AI",
      identity: { kind: "CATEGORY_RESIDUAL", category: "AI" },
      resolutionAuthority: "NO_DIRECT_RESOLUTION",
      activityProbeKey: "NONE",
      recoveryPolicy: "NO_RECOVERY_SIGNAL",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "GUIDANCE_ONLY",
      requiredCapability: "operations.view",
      audience: "TENANT_ADVISORY",
      cardinality: "EVENT",
      workspaceApplicability: "PLATFORM_OBSERVED",
      metricContract: "NONE",
      drillDownContract: "NONE",
      notApplicableDisposition: "REFUSE",
      rationale:
        "Provider availability and budget are platform state; nothing evidential depends on the step, and the workspace cannot observe the provider's recovery.",
    },
    {
      sourceId: "database.condition",
      category: "DATABASE",
      identity: { kind: "CATEGORY_RESIDUAL", category: "DATABASE" },
      resolutionAuthority: "NO_DIRECT_RESOLUTION",
      activityProbeKey: "NONE",
      recoveryPolicy: "NO_RECOVERY_SIGNAL",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "GUIDANCE_ONLY",
      requiredCapability: "operations.view",
      audience: "TENANT_ADVISORY",
      cardinality: "EVENT",
      workspaceApplicability: "PLATFORM_OBSERVED",
      metricContract: "NONE",
      drillDownContract: "NONE",
      notApplicableDisposition: "REFUSE",
      rationale:
        "A database fault is platform infrastructure and needs no workspace action; there is nothing here a tenant could truthfully close.",
    },
  ] as const satisfies readonly OperationsSourceLifecycle[]);

/**
 * THE CONTRACT FOR A CONDITION NO REGISTERED SOURCE CLAIMS.
 *
 * Not a fallback that hides a gap — a stated decision about a real population.
 * `EVIDENCE_INTEGRITY`, `REPORT` and `PACKAGE` are each written by more than
 * one authority: the sweep's own conditions carry canonical fingerprints and
 * resolve to their sources exactly, while `evidence-health.service.ts`, the
 * Worker's report processor and the inbox writer produce PER-RECORD failures
 * under the same categories with fingerprints of their own.
 *
 * Those are event-shaped: a job failed, and whether the workspace is finished
 * with it is a person's conclusion. So the contract is OPERATOR_DECISION with
 * the resolve capability and a recorded note — not SOURCE_TRUTH, which with no
 * probe would refuse forever and leave the queue permanently stuck.
 *
 * What it is NOT is a way back to category-derived policy: a condition that
 * DOES match a registered source never reaches this, and the sources owning
 * these categories' aggregate conditions are matched by fingerprint first.
 */
export const UNREGISTERED_CONDITION_LIFECYCLE: OperationsSourceLifecycle =
  Object.freeze({
    sourceId: "unregistered.condition" as const,
    // Carried by the caller; the category of the actual incident is what the
    // remediation registry keys on, and this row asserts nothing about it.
    category: "RECONCILIATION",
    identity: { kind: "NOT_DISCOVERED" } as const,
    resolutionAuthority: "OPERATOR_DECISION",
    activityProbeKey: "NONE",
    recoveryPolicy: "OPERATOR_CLOSES",
    recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
    suppressionPolicy: "SUPPRESSION_PERSISTS",
    remediationDisposition: "GUIDANCE_ONLY",
    requiredCapability: "operations.view",
    audience: "TENANT_ACTIONABLE",
    cardinality: "EVENT",
    workspaceApplicability: "ALL_WORKSPACES",
    metricContract: "NONE",
    drillDownContract: "NONE",
    notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
    rationale:
      "A per-record domain failure written under a shared category by an authority with no registered source row; event-shaped, so a person closes it.",
  });

// ===========================================================================
// LOOKUPS
// ===========================================================================

const BY_ID: ReadonlyMap<string, OperationsSourceLifecycle> = new Map(
  OPERATIONS_SOURCE_LIFECYCLES.map((s) => [s.sourceId, s]),
);

/** Every registered source id, in declaration order. */
export function operationsSourceIds(): string[] {
  return OPERATIONS_SOURCE_LIFECYCLES.map((s) => s.sourceId);
}

/** The contract for one source id, or null when it is not registered. */
export function lifecycleForSourceId(
  sourceId: string,
): OperationsSourceLifecycle | null {
  return BY_ID.get(sourceId) ?? null;
}

/** How a condition was traced to its source. Reported, never inferred twice. */
export type SourceMatchKind =
  | "FINGERPRINT"
  | "CATEGORY_RESIDUAL"
  | "UNREGISTERED";

export type ResolvedConditionSource = {
  readonly lifecycle: OperationsSourceLifecycle;
  readonly match: SourceMatchKind;
};

/**
 * WHICH SOURCE OWNS THIS CONDITION.
 *
 * Fingerprint first, category second, and the two are not interchangeable —
 * the whole defect was treating the second as if it were the first.
 *
 * Pure. Both hosts call it, and the API's probe map is keyed by the
 * `activityProbeKey` of whatever it returns.
 */
export function resolveConditionSource(condition: {
  category: string;
  fingerprint: string;
}): ResolvedConditionSource {
  const fingerprint = condition.fingerprint ?? "";
  const colon = fingerprint.indexOf(":");
  const head = colon > 0 ? fingerprint.slice(0, colon) : "";

  for (const lifecycle of OPERATIONS_SOURCE_LIFECYCLES) {
    const identity = lifecycle.identity;
    if (identity.kind === "FINGERPRINT_CLASS") {
      // `<class>:<subjectId>` — the head alone, so a subject id containing a
      // colon cannot change which source owns the condition.
      if (head !== "" && head === identity.className) {
        return { lifecycle, match: "FINGERPRINT" };
      }
    } else if (identity.kind === "FINGERPRINT_PREFIX") {
      // `<prefix>:<teamId>` — anchored with the separator so
      // `dashboard:pipeline:report_backlog_v2` cannot match
      // `dashboard:pipeline:report_backlog`.
      if (fingerprint.startsWith(`${identity.prefix}:`)) {
        return { lifecycle, match: "FINGERPRINT" };
      }
    }
  }

  for (const lifecycle of OPERATIONS_SOURCE_LIFECYCLES) {
    if (
      lifecycle.identity.kind === "CATEGORY_RESIDUAL" &&
      lifecycle.identity.category === condition.category
    ) {
      return { lifecycle, match: "CATEGORY_RESIDUAL" };
    }
  }

  return { lifecycle: UNREGISTERED_CONDITION_LIFECYCLE, match: "UNREGISTERED" };
}

/**
 * Does this source's condition carry a live aggregate value?
 *
 * Stated once so the writer, the projection and the browser agree about which
 * rows have a number rather than each deciding from a category.
 */
export function sourceCarriesMetric(
  lifecycle: OperationsSourceLifecycle,
): boolean {
  return lifecycle.metricContract !== "NONE";
}

/**
 * May a Resolve control be OFFERED for conditions from this source?
 *
 * The projection question, distinct from the server's per-request refusal.
 * A SOURCE_TRUTH condition gets no Resolve control because recovery closes it
 * automatically; a NO_DIRECT_RESOLUTION condition gets none because nobody can
 * truthfully close it. Both still validate server-side, because a stale tab is
 * not an authority.
 */
export function offersManualResolution(
  lifecycle: OperationsSourceLifecycle,
): boolean {
  return lifecycle.resolutionAuthority === "OPERATOR_DECISION";
}
