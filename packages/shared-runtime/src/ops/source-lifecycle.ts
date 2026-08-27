/**
 * THE OPERATIONS SOURCE LIFECYCLE CONTRACT.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG, AND WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * Resolution authority used to be declared per `IncidentCategory`. There are
 * fourteen categories and far more Operations SOURCES, and the mapping is
 * neither one-to-one nor close to it: four sources write category WORKER, and
 * six unrelated writers put conditions under GOVERNANCE. So a rule stated per
 * category was a rule stated about a set nobody had enumerated.
 *
 * The measured consequence: `pipeline.report_backlog` inherited
 * `REPORT -> OPERATOR_MAY_RESOLVE`, so an operator could declare
 *
 *     "Report backlog above threshold (26)"
 *
 * RESOLVED while all twenty-six records were still above the threshold.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG THE SECOND TIME, AND WHY THIS FILE CHANGED AGAIN
 * ---------------------------------------------------------------------------
 * The first correction resolved a condition's source from its FINGERPRINT.
 * That was better than category and still an inference: it worked for the
 * eleven sources whose fingerprints the sweep writes, and every OTHER
 * production emitter — fifteen of them, in both hosts — fell through to a
 * category residual or to an "unregistered" contract.
 *
 * And that unregistered contract was `OPERATOR_DECISION`. So a condition the
 * system could not identify AT ALL was operator-resolvable, which is the exact
 * inversion of the fail-closed rule the whole correction exists to establish.
 *
 * Two things changed:
 *
 *   1. IDENTITY IS DECLARED, NOT INFERRED. Every writer passes a typed
 *      `sourceId`, persisted on the row. Fingerprints remain the DEDUPLICATION
 *      identity and are no longer the lifecycle authority. The fingerprint
 *      table below survives only to map rows written before the column
 *      existed, and only where one fingerprint means exactly one source.
 *
 *   2. UNKNOWN FAILS CLOSED. A missing, unknown or ambiguous source is
 *      `NO_DIRECT_RESOLUTION` with activity `UNKNOWN`. Nothing anywhere falls
 *      back to `OPERATOR_DECISION`.
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
 * remediation AND is source-truth: pressing the button is allowed, calling the
 * backlog gone is not. `tsa_failed` has NO safe remediation at all and is also
 * source-truth. Nothing may read `SAFE_REMEDIATION` as implying
 * `OPERATOR_DECISION`.
 *
 * ---------------------------------------------------------------------------
 * WHY IT LIVES IN shared-runtime
 * ---------------------------------------------------------------------------
 * Both hosts write operational conditions. A lifecycle contract that lived in
 * one of them would be a contract the other could not consult, which is how
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
 *   The condition records something that HAPPENED and cannot become untrue,
 *   and closing it is a human conclusion about the investigation — not a
 *   technical fact. Never used because a probe is merely missing, and always
 *   paired with `requiresResolutionNote`.
 *
 * NO_DIRECT_RESOLUTION
 *   The workspace cannot truthfully declare the condition recovered and the
 *   platform has no safe probe. There is no Resolve action at all: only
 *   acknowledge, assign, suppress, and whatever safe remediation exists. This
 *   is also the answer for every unknown and ambiguous condition.
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
   * The condition affects THIS workspace and the workspace cannot repair the
   * component. Shown as bounded health information, never with a Resolve
   * control that would pretend otherwise.
   */
  "TENANT_ADVISORY",
  /**
   * GLOBAL infrastructure telemetry. Not tenant-specific, nothing a tenant can
   * do, and — critically — the SAME platform fault would otherwise be
   * duplicated into every workspace's queue, counts and readiness. It belongs
   * on the platform observability surface and nowhere else.
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
  /** No probe. A person concludes the investigation is finished. */
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
 * Declared beside resolution authority so the difference between them is
 * impossible to miss.
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
 * IS THIS SOURCE ACTUALLY PRODUCING CONDITIONS?
 *
 * A registered source with no producer used to be indistinguishable from a
 * working one — `evidence_integrity.ots_pending_aged` sat in the registry with
 * a probe and a threshold for an entire release while discovery iterated only
 * the two FAILED classes, so it looked covered and observed nothing.
 *
 * ACTIVE               a production emitter writes it, and the totality gate
 *                      requires that emitter to exist;
 * NOT_YET_DISCOVERED   registered, deliberately, with NO producer today. It is
 *                      recorded rather than deleted so the condition it
 *                      describes is on the roadmap instead of forgotten — and
 *                      it may NEVER be reported as production-complete;
 * DISABLED             a producer exists in the tree and is switched off.
 */
export const SOURCE_DISCOVERY_STATES = [
  "ACTIVE",
  "NOT_YET_DISCOVERED",
  "DISABLED",
] as const;
export type SourceDiscoveryState = (typeof SOURCE_DISCOVERY_STATES)[number];

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
  "evidence.ots_pending_aged",
  "evidence.report_present",
  "evidence.package_present",
  "identity.idp_outage_state",
  "review.workflow_open",
  "pipeline.report_backlog_count",
  "pipeline.package_backlog_count",
  "pipeline.signed_without_report_aged_count",
  "review.stale_workflow_count",
  "coordination.stale_backlog_count",
  "queue.retry_storm_count",
  "platform.telemetry_age",
  "platform.worker_heartbeat_age",
  /** The append-only `ImmutableStorageCheck` verdict for one record. */
  // The add-on obligation state. Only a provider call or a provider
  // observation moves it to CONFIRMED, which is what makes the condition it
  // resolves SOURCE_TRUTH rather than operator-closable.
  "billing.dependent_cancellation_state",
  "storage.immutable_reconciliation_state",
  /** The canonical search-readiness derivation for one workspace. */
  "search.index_health",
] as const;
export type ActivityProbeKey = (typeof ACTIVITY_PROBE_KEYS)[number];

// ===========================================================================
// LEGACY FINGERPRINT IDENTITY
// ===========================================================================

/**
 * How a row written BEFORE `source_id` existed is traced to its source.
 *
 * This is a backfill and legacy-read aid, NOT the lifecycle authority. Every
 * new write carries an explicit `sourceId`; these patterns exist so the rows
 * already in production resolve to the same contract their writer would now
 * declare, and so the migration's backfill and the runtime agree by
 * construction rather than by two lists happening to match.
 *
 * A pattern is declared ONLY where one fingerprint shape means exactly one
 * source. Anything ambiguous is deliberately absent, and an ambiguous legacy
 * row therefore fails closed to NO_DIRECT_RESOLUTION rather than being guessed
 * into a contract that might let somebody close it.
 *
 * PREFIX  matched as `<prefix>:…` — the separator is part of the match, so a
 *         future `report_backlog_v2` cannot inherit `report_backlog`;
 * EXACT   the whole fingerprint.
 */
export type LegacyFingerprintPattern =
  | { readonly kind: "PREFIX"; readonly prefix: string }
  | { readonly kind: "EXACT"; readonly fingerprint: string };

// ===========================================================================
// THE CONTRACT
// ===========================================================================

export type OperationsSourceLifecycle = {
  /** Stable source id. Persisted on every new row and passed by every writer. */
  readonly sourceId: string;
  /** The incident category conditions from this source carry. */
  readonly category: IncidentCategory;
  /**
   * THE COUNT-FREE SENTENCE EVERY SURFACE RENDERS FOR THIS SOURCE.
   *
   * ---------------------------------------------------------------------
   * WHY THE TITLE COULD NOT STAY THE AUTHORITY
   * ---------------------------------------------------------------------
   * Titles were written once, at the moment the condition opened, and never
   * rewritten. Several carried the value they were about:
   *
   *     "Report backlog above threshold (26)"
   *     "Queue telemetry sampler delayed (902m)"
   *     "Retry storm pattern detected (36 repeat incidents)"
   *
   * so a workspace that worked its backlog down to 22 kept reading 26 for as
   * long as the condition existed, and `902m` was an elapsed time rendered as
   * an identity. Worse, the number was frozen INSIDE a string, where nothing
   * could tell it was a number — which is how one row came to show a title
   * claiming 26 beside a member count of 1, both unlabelled.
   *
   * The value now lives in the metric snapshot, refreshed on every
   * observation. This is what the row is CALLED, and it never changes, so it
   * can be a property of the source rather than a copy on every row.
   *
   * ---------------------------------------------------------------------
   * IT ALSO REPAIRS THE ROWS ALREADY IN PRODUCTION
   * ---------------------------------------------------------------------
   * Rows written before the stable titles shipped still carry their
   * count-bearing text in `operational_incidents.title`. Projection reads
   * THIS label for any row whose source is known, so those rows display
   * correctly immediately — with no migration, no rewrite of a historical
   * event payload, and no regex picking numbers back out of old strings.
   *
   * The stored title is left exactly as written. It is what the row said when
   * it was created, and that is a fact about the past.
   */
  readonly displayLabel: string;
  /**
   * The production modules that EMIT this source, by repo-relative path.
   *
   * The totality gate reads this: an ACTIVE source with no producer in the
   * tree fails, and a producer that passes a source id absent from this
   * registry fails. Empty is legal only for NOT_YET_DISCOVERED.
   */
  readonly producers: readonly string[];
  readonly discoveryState: SourceDiscoveryState;
  /** Legacy fingerprint shapes, for rows written before `source_id`. */
  readonly legacyFingerprints: readonly LegacyFingerprintPattern[];
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
  /**
   * Must an OPERATOR_DECISION resolution carry a note?
   *
   * True for every OPERATOR_DECISION source, enforced by a check below rather
   * than by remembering: the whole meaning of that authority is "a person
   * concluded something", and a conclusion nobody wrote down is
   * indistinguishable from a click.
   */
  readonly requiresResolutionNote: boolean;
  /** Why this authority, in one sentence, for the person who reads the row. */
  readonly rationale: string;
};

/**
 * THE REGISTERED SOURCES, UNGROUPED.
 *
 * Every field is required by the type, so a new source cannot compile without
 * an answer to every lifecycle question. There is no default and no fallback
 * to `OPERATOR_DECISION`: an undecided source does not build.
 *
 * The count is not a target. It grew from 22 to 35 because thirteen real
 * production emitters were writing conditions no registered source claimed,
 * and forcing semantically different conditions into an existing row to
 * preserve a number would have been the category defect again, one level down.
 */
export const OPERATIONS_SOURCE_LIFECYCLES: readonly OperationsSourceLifecycle[] =
  Object.freeze([
    // =======================================================================
    // PROVABILITY — per record, one condition per record per failure class.
    // =======================================================================
    {
      sourceId: "evidence_integrity.tsa_failed",
      category: "EVIDENCE_INTEGRITY",
      displayLabel: "Trusted timestamping failed",
      producers: [
        "services/api/src/services/operations/evidence-integrity-conditions.service.ts",
      ],
      discoveryState: "ACTIVE",
      legacyFingerprints: [{ kind: "PREFIX", prefix: "tsa_failure" }],
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "evidence.tsa_status",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      // A timestamp proves a record existed at a moment. Re-contacting the
      // authority now would mint a token whose genTime is LATER than the
      // evidence it certifies — a different and weaker claim wearing the
      // original's name. No safe remediation, and no operator resolution
      // either: the record's own column decides.
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
      requiresResolutionNote: false,
      rationale:
        "Evidence.tsaStatus is a deterministic per-record column, and the recovery sweep already closes these from it.",
    },
    {
      sourceId: "evidence_integrity.ots_failed",
      category: "EVIDENCE_INTEGRITY",
      displayLabel: "Blockchain anchoring failed",
      producers: [
        "services/api/src/services/operations/evidence-integrity-conditions.service.ts",
      ],
      discoveryState: "ACTIVE",
      legacyFingerprints: [{ kind: "PREFIX", prefix: "ots_failure" }],
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "evidence.ots_status",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      // Unlike TSA, an OTS anchor is a calendar commitment that can honestly
      // be re-attempted: retrying does not restate WHEN the record existed.
      remediationDisposition: "SAFE_REMEDIATION",
      requiredCapability: "evidence.publish_verify",
      audience: "TENANT_ACTIONABLE",
      cardinality: "PER_RECORD",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "NONE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      requiresResolutionNote: false,
      rationale:
        "Evidence.otsStatus is a deterministic per-record column read by the same recovery sweep.",
    },
    {
      sourceId: "evidence_integrity.ots_pending_aged",
      category: "EVIDENCE_INTEGRITY",
      displayLabel: "Blockchain anchoring still pending",
      // NO LONGER A GHOST. It sat here for a release with a probe, a threshold
      // and no producer: `syncEvidenceIntegrityConditions` iterated the two
      // FAILED classes only, so the source looked covered and observed
      // nothing. Discovery now opens it from the SAME canonical OTS global
      // budget the Worker uses to give up.
      producers: [
        "services/api/src/services/operations/evidence-integrity-conditions.service.ts",
      ],
      discoveryState: "ACTIVE",
      legacyFingerprints: [{ kind: "PREFIX", prefix: "ots_pending_aged" }],
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "evidence.ots_pending_aged",
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
      requiresResolutionNote: false,
      rationale:
        "A record still PENDING past the canonical OTS global budget is a deterministic read of otsStatus and the record's own age; the same predicate answers recovery.",
    },
    {
      sourceId: "evidence_integrity.ots_budget_exhausted",
      category: "WORKER",
      displayLabel: "Blockchain anchoring abandoned",
      producers: ["services/worker/src/ots-upgrade.processor.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [{ kind: "PREFIX", prefix: "OTS" }],
      // TERMINAL BY DESIGN — the processor stops re-enqueueing — but not
      // unobservable: it writes otsStatus FAILED, which is the same column its
      // sibling reads, and which changes if the proof is ever re-anchored
      // through the explicit user-authorized remediation.
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "evidence.ots_status",
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
      requiresResolutionNote: false,
      rationale:
        "The processor writes otsStatus=FAILED when the global anchoring budget is spent; that column is the recovery signal and nothing else is.",
    },
    // =======================================================================
    // THE ARTIFACT PIPELINE — workspace-level counts, and per-record failures.
    // =======================================================================
    {
      sourceId: "pipeline.report_backlog",
      category: "REPORT",
      displayLabel: "Report generation backlog",
      producers: ["services/api/src/services/dashboard/incident-generator.service.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [
        { kind: "PREFIX", prefix: "dashboard:pipeline:report_backlog" },
      ],
      // THE ORIGINAL DEFECT. Inherited OPERATOR_MAY_RESOLVE from category
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
      requiresResolutionNote: false,
      rationale:
        "The count of SIGNED evidence with no report is re-countable on demand, so whether the backlog is still above threshold is a fact and not a judgement.",
    },
    {
      sourceId: "pipeline.package_backlog",
      category: "PACKAGE",
      displayLabel: "Verification package backlog",
      producers: ["services/api/src/services/dashboard/incident-generator.service.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [
        { kind: "PREFIX", prefix: "dashboard:pipeline:package_backlog" },
      ],
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
      requiresResolutionNote: false,
      rationale:
        "The count of REPORTED evidence with no verification package is re-countable on demand.",
    },
    {
      sourceId: "pipeline.signed_without_report_aged",
      category: "GOVERNANCE",
      displayLabel: "Uploaded evidence awaiting signing",
      producers: ["services/api/src/services/dashboard/incident-generator.service.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [
        { kind: "PREFIX", prefix: "dashboard:integrity:unsigned_aged" },
      ],
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
      requiresResolutionNote: false,
      rationale:
        "The aged uploaded-but-unsigned set is a re-countable population measured against a fixed window.",
    },
    {
      sourceId: "pipeline.report_generation_failed",
      category: "REPORT",
      displayLabel: "Report generation failed",
      producers: ["services/worker/src/processor.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [{ kind: "PREFIX", prefix: "REPORT" }],
      // ACTIVE STATE, not an event. The condition says "this record has no
      // report"; the record either has one now or it does not, and that is a
      // column read. It was falling through to the unregistered contract,
      // which made it operator-resolvable while the record still had no
      // report.
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "evidence.report_present",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_REMEDIATION",
      requiredCapability: "evidence.generate_report",
      audience: "TENANT_ACTIONABLE",
      cardinality: "PER_RECORD",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "NONE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      requiresResolutionNote: false,
      rationale:
        "Evidence.latestReportVersion answers whether the report the job failed to produce now exists.",
    },
    {
      sourceId: "pipeline.package_generation_denied",
      category: "GOVERNANCE",
      displayLabel: "Verification package denied",
      producers: ["services/worker/src/governance/package-eligibility-gate.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [{ kind: "PREFIX", prefix: "worker_package_gate" }],
      // The gate refused to build a package for one record. Whether that
      // record now HAS a package is a column read, and it is the only honest
      // recovery signal — the governance state that caused the denial is the
      // Worker's to evaluate, not the resolve path's.
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "evidence.package_present",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_REMEDIATION",
      requiredCapability: "evidence.generate_report",
      audience: "TENANT_ACTIONABLE",
      cardinality: "PER_RECORD",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "NONE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      requiresResolutionNote: false,
      rationale:
        "Evidence.verificationPackageVersion answers whether the package the gate denied now exists.",
    },
    // =======================================================================
    // COORDINATION — human work, counted, and still a countable fact.
    // =======================================================================
    {
      sourceId: "review.stale_workflows",
      category: "WORKER",
      displayLabel: "Stale review workflows",
      producers: ["services/api/src/services/dashboard/incident-generator.service.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [
        { kind: "PREFIX", prefix: "dashboard:review:stale_assignments" },
      ],
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
      requiresResolutionNote: false,
      rationale:
        "Whether untouched review workflows still exist past the window is a count — the workflows either moved or they did not.",
    },
    {
      sourceId: "review.escalation",
      category: "GOVERNANCE",
      displayLabel: "Review escalated",
      producers: ["services/api/src/services/reviewer-ops/escalation-engine.service.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [{ kind: "PREFIX", prefix: "review-escalation" }],
      // ACTIVE STATE. The fingerprint names one workflow, and that workflow's
      // own status says whether it is still open. An escalation on a workflow
      // that has since completed is over, and the workflow says so.
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "review.workflow_open",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_DEEP_LINK",
      requiredCapability: "review.queue.read",
      audience: "TENANT_ACTIONABLE",
      cardinality: "PER_RECORD",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      requiresResolutionNote: false,
      rationale:
        "The fingerprint names one EvidenceReviewWorkflow, and its status column says whether the escalated review is still open.",
    },
    {
      sourceId: "review.escalation_storm",
      category: "GOVERNANCE",
      displayLabel: "Review escalations surging",
      producers: [
        "services/api/src/services/reviewer-ops/reviewer-operations-engine.service.ts",
      ],
      discoveryState: "ACTIVE",
      legacyFingerprints: [{ kind: "PREFIX", prefix: "reviewer:escalation_storm" }],
      // A statement about ONE PAST SWEEP, keyed by date: "this reconcile
      // created N escalations". Nothing can make that untrue, and there is no
      // later state to read. Closing it means an operator looked at workload
      // distribution and concluded.
      resolutionAuthority: "OPERATOR_DECISION",
      activityProbeKey: "NONE",
      recoveryPolicy: "OPERATOR_CLOSES",
      recurrencePolicy: "NEW_CONDITION",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_DEEP_LINK",
      requiredCapability: "review.queue.read",
      audience: "TENANT_ACTIONABLE",
      cardinality: "EVENT",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      requiresResolutionNote: true,
      rationale:
        "The fingerprint is keyed by DATE and records what one sweep did; no later state can contradict it, so closure is the operator's written conclusion about workload.",
    },
    {
      sourceId: "coordination.backlog_stale",
      category: "GOVERNANCE",
      displayLabel: "Coordination backlog",
      producers: ["services/api/src/services/dashboard/incident-generator.service.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [
        { kind: "PREFIX", prefix: "dashboard:coordination:stale_backlog" },
      ],
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
      requiresResolutionNote: false,
      rationale:
        "Unresolved comments and annotations past the window are counted from their own resolvedAtUtc columns.",
    },
    {
      sourceId: "queue.retry_storm",
      category: "WORKER",
      displayLabel: "Queue retry storm",
      producers: ["services/api/src/services/dashboard/incident-generator.service.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [
        { kind: "PREFIX", prefix: "dashboard:reliability:retry_storms" },
      ],
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
      requiresResolutionNote: false,
      rationale:
        "The storm is defined as a count of this workspace's own re-firing conditions, which is re-countable at any moment.",
    },
    // =======================================================================
    // PLATFORM HEALTH.
    //
    // Two different things wear similar names, and the audience split is the
    // whole point: a workspace-bound sampler delay is this tenant's business,
    // and a global worker heartbeat is not — the second was being duplicated
    // into every tenant's queue, counts and readiness as if each workspace had
    // its own broken worker.
    // =======================================================================
    {
      sourceId: "platform.telemetry_stale",
      category: "WORKER",
      displayLabel: "Queue telemetry sampler delayed",
      producers: ["services/api/src/services/dashboard/incident-generator.service.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [
        { kind: "PREFIX", prefix: "dashboard:telemetry:queue_stale" },
      ],
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "platform.telemetry_age",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "GUIDANCE_ONLY",
      requiredCapability: "operations.view",
      // WORKSPACE-BOUND: the scanner reads QueueTelemetrySnapshot WHERE
      // teamId = this workspace, so a stale sampler here is a fact about THIS
      // tenant's queue visibility. The tenant cannot restart the sampler, so
      // advisory — but they are entitled to know their own telemetry is dark.
      audience: "TENANT_ADVISORY",
      cardinality: "AGGREGATE",
      workspaceApplicability: "PLATFORM_OBSERVED",
      metricContract: "AGE_THRESHOLD",
      drillDownContract: "NONE",
      notApplicableDisposition: "REFUSE",
      requiresResolutionNote: false,
      rationale:
        "The age of THIS workspace's freshest telemetry snapshot is a clock reading, so recovery is observed rather than asserted.",
    },
    {
      sourceId: "platform.worker_heartbeat_stale",
      category: "WORKER",
      displayLabel: "Worker heartbeat stale",
      producers: ["services/api/src/services/dashboard/incident-generator.service.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [
        { kind: "PREFIX", prefix: "dashboard:worker:heartbeat_stale" },
      ],
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "platform.worker_heartbeat_age",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "GUIDANCE_ONLY",
      requiredCapability: "operations.view",
      // GLOBAL. The scanner reads WorkerTelemetrySnapshot WHERE
      // workerKind = 'WORKER' with NO tenant predicate — one process-wide
      // heartbeat — and then writes a per-workspace fingerprint, so ONE dead
      // worker opened one identical condition in every workspace on the
      // platform, each counted, each blocking that tenant's all-clear. It is
      // platform telemetry and belongs on the platform surface.
      audience: "PLATFORM_INTERNAL",
      cardinality: "AGGREGATE",
      workspaceApplicability: "PLATFORM_OBSERVED",
      metricContract: "AGE_THRESHOLD",
      drillDownContract: "NONE",
      notApplicableDisposition: "REFUSE",
      requiresResolutionNote: false,
      rationale:
        "The heartbeat read carries no tenant predicate: it is one global fact, and duplicating it per workspace made every tenant un-clearable for a fault none of them owned.",
    },
    // =======================================================================
    // THE SECURITY-EVENT BRIDGE.
    //
    // ONE writer — `security-event.service.ts` — maps a SecurityEvent type to
    // a category and emits `<category>:security_event:<eventType>`. Each
    // category branch is a different operational domain, so each is its own
    // source; what they share is their SHAPE: an immutable record that a class
    // of security event was observed. Nothing later can make one untrue, and
    // there is no live subject to probe — the fingerprint names an event
    // CLASS, not a destination, a provider or a connection.
    //
    // So they are OPERATOR_DECISION, and every one of them requires a written
    // conclusion. Not because a probe is missing — that would be the banned
    // reasoning — but because "we investigated this signal and it is dealt
    // with" is genuinely the only thing closure can mean here.
    // =======================================================================
    {
      sourceId: "intake.delivery_failed",
      category: "UPLOAD",
      displayLabel: "Intake delivery failed",
      producers: ["services/api/src/services/security/security-event.service.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [{ kind: "PREFIX", prefix: "upload:security_event" }],
      resolutionAuthority: "OPERATOR_DECISION",
      activityProbeKey: "NONE",
      recoveryPolicy: "OPERATOR_CLOSES",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_DEEP_LINK",
      requiredCapability: "evidence.read",
      audience: "TENANT_ACTIONABLE",
      cardinality: "EVENT",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      requiresResolutionNote: true,
      rationale:
        "The SecurityEvent bridge records that a class of stuck/failed upload was observed; the fingerprint names the event class and no delivery, so there is no live subject to probe and closure is the recorded investigation outcome.",
    },
    {
      sourceId: "communications.provider_failure",
      category: "COMMUNICATIONS",
      displayLabel: "Communications provider failure",
      producers: ["services/api/src/services/security/security-event.service.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [
        { kind: "PREFIX", prefix: "communications:security_event" },
      ],
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
      requiresResolutionNote: true,
      rationale:
        "The fingerprint is `communications:security_event:<eventType>` — an event class, not a provider or destination — so no bounded provider-health probe can be bound to THIS condition's identity; closure is the operator's recorded confirmation that delivery resumed.",
    },
    {
      sourceId: "webhook.security_failure",
      category: "WEBHOOK",
      displayLabel: "Webhook security event",
      producers: ["services/api/src/services/security/security-event.service.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [{ kind: "PREFIX", prefix: "webhook:security_event" }],
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
      requiresResolutionNote: true,
      rationale:
        "This writer emits the IMMUTABLE half — an invalid-signature burst was observed — keyed by event class. The ACTIVE half (a destination whose autoDisabledAt is set) is owned by the integrations surface and is not what this condition names.",
    },
    {
      sourceId: "identity.security_condition",
      category: "IDENTITY_SECURITY",
      displayLabel: "Identity security condition",
      producers: ["services/api/src/services/security/security-event.service.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [
        { kind: "PREFIX", prefix: "identity_security:security_event" },
      ],
      resolutionAuthority: "OPERATOR_DECISION",
      activityProbeKey: "NONE",
      recoveryPolicy: "OPERATOR_CLOSES",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_DEEP_LINK",
      requiredCapability: "audit.read",
      audience: "TENANT_ACTIONABLE",
      cardinality: "EVENT",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      requiresResolutionNote: true,
      rationale:
        "A security event happened and its SecurityEvent row is immutable; Security Center adjudicates it, and Operations records the workspace's written conclusion rather than inventing a second verdict.",
    },
    {
      sourceId: "governance.policy_condition",
      category: "GOVERNANCE",
      displayLabel: "Governance policy condition",
      producers: ["services/api/src/services/security/security-event.service.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [{ kind: "PREFIX", prefix: "governance:security_event" }],
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
      requiresResolutionNote: true,
      rationale:
        "A governance or publication security signal was recorded; it names an event class rather than a policy row, so no governance authority can re-check THIS condition and closure is the recorded review outcome.",
    },
    {
      sourceId: "security.unclassified_signal",
      category: "WORKER",
      displayLabel: "Unclassified security signal",
      producers: ["services/api/src/services/security/security-event.service.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [{ kind: "PREFIX", prefix: "worker:security_event" }],
      // -----------------------------------------------------------------
      // THIS WAS OPERATOR_DECISION, AND IT WAS THE OLD DEFECT UNDER A NAME.
      // -----------------------------------------------------------------
      // The bridge's DEFAULT branch: an event type none of the mappings above
      // claims. Registering it closed the unregistered-row hole, and then
      // reproduced the hole it was closing — the source MEANS "the platform
      // cannot classify this signal", and OPERATOR_DECISION made not knowing
      // what something is confer the right to declare it over.
      //
      // It is NO_DIRECT_RESOLUTION now. An operator can acknowledge it, assign
      // it and suppress it with a recorded reason; they cannot close it,
      // because nothing in the system knows what closed would mean. The fix
      // for a stuck row of this kind is to CLASSIFY the event type, which adds
      // a branch above and a real contract with it.
      resolutionAuthority: "NO_DIRECT_RESOLUTION",
      activityProbeKey: "NONE",
      // No probe and no operator close, so nothing signals recovery. The
      // condition is carried until the Security Center adjudicates the
      // underlying event, or until the source is classified.
      recoveryPolicy: "NO_RECOVERY_SIGNAL",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "GUIDANCE_ONLY",
      requiredCapability: "audit.read",
      // ADVISORY, not actionable: there is no safe action to offer for a
      // signal the platform could not classify, and an actionable audience
      // that offers none is a promise the surface does not keep.
      audience: "TENANT_ADVISORY",
      cardinality: "EVENT",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "REFUSE",
      requiresResolutionNote: false,
      rationale:
        "An immutable SecurityEvent whose type the bridge cannot classify; nothing knows what recovery would mean for it, so it fails closed rather than becoming closable by assertion.",
    },
    // =======================================================================
    // IDENTITY — three writers, three shapes, and only one of them is a state.
    // =======================================================================
    {
      sourceId: "identity.idp_outage",
      category: "IDENTITY_SECURITY",
      displayLabel: "Identity provider outage",
      producers: [
        "services/api/src/services/access-control/sso-hardening.service.ts",
      ],
      discoveryState: "ACTIVE",
      legacyFingerprints: [{ kind: "PREFIX", prefix: "idp-outage" }],
      // THE ONE ACTIVE STATE among the identity writers, and it has a genuine
      // canonical recovery signal: `noteSsoSuccess` clears
      // `SsoConnection.outageDetectedAtUtc` back to NULL on the first
      // successful callback. The fingerprint names the connection, so the
      // probe is bound to exactly the subject the condition is about.
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "identity.idp_outage_state",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_DEEP_LINK",
      requiredCapability: "audit.read",
      audience: "TENANT_ACTIONABLE",
      cardinality: "PER_RECORD",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      requiresResolutionNote: false,
      rationale:
        "SsoConnection.outageDetectedAtUtc is stamped on outage and cleared to NULL by the first successful callback — a canonical recovery signal bound to the connection the fingerprint names.",
    },
    {
      sourceId: "identity.runtime_block",
      category: "IDENTITY_SECURITY",
      displayLabel: "Sign-in blocked by runtime risk",
      producers: [
        "services/api/src/services/access-control/adaptive-runtime-gate.service.ts",
      ],
      discoveryState: "ACTIVE",
      legacyFingerprints: [{ kind: "PREFIX", prefix: "runtime-block" }],
      // Keyed by (team, action, HOUR). It records that adaptive auth blocked
      // an attempt during that hour. The hour is over; nothing can change it.
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
      requiresResolutionNote: true,
      rationale:
        "The fingerprint buckets by HOUR: it records a block that happened inside a window that has closed, so closure is the operator's written conclusion about that block.",
    },
    {
      sourceId: "identity.high_risk_session_surge",
      category: "IDENTITY_SECURITY",
      displayLabel: "High-risk session surge",
      producers: ["services/api/src/services/access-control/runtime-risk.service.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [
        { kind: "PREFIX", prefix: "runtime-high-risk-sessions" },
      ],
      // "One sweep saw N sessions at HIGH+ risk", bucketed by dedup window.
      // The sessions it counted may since have been revoked or expired; the
      // observation itself is finished.
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
      requiresResolutionNote: true,
      rationale:
        "A completed recompute sweep's count, bucketed by dedup window; the sessions counted are not the condition's subject and closure is the recorded investigation.",
    },
    // =======================================================================
    // GOVERNANCE AND STORAGE — written by their own domains, at the moment.
    // =======================================================================
    {
      sourceId: "governance.destruction_executed",
      category: "GOVERNANCE",
      displayLabel: "Evidence destruction executed",
      producers: [
        "services/api/src/services/governance-lifecycle/destruction-review.service.ts",
      ],
      discoveryState: "ACTIVE",
      legacyFingerprints: [{ kind: "PREFIX", prefix: "destruction_executed" }],
      // A destruction HAPPENED, and a certificate hash records it. This is the
      // most immutable thing in the product: the bytes are gone. Closure is an
      // operator acknowledging the record, never a claim that it is undone.
      resolutionAuthority: "OPERATOR_DECISION",
      activityProbeKey: "NONE",
      recoveryPolicy: "OPERATOR_CLOSES",
      recurrencePolicy: "NEW_CONDITION",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "GUIDANCE_ONLY",
      requiredCapability: "governance.policy.read",
      audience: "TENANT_ACTIONABLE",
      cardinality: "EVENT",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      requiresResolutionNote: true,
      rationale:
        "An executed destruction with a certificate hash: irreversible by construction, so the only meaning closure can carry is an operator's recorded acknowledgement.",
    },
    {
      sourceId: "governance.notification_escalated",
      category: "GOVERNANCE",
      displayLabel: "Governance notification escalated",
      producers: ["services/worker/src/governance/notification-emitter.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [
        { kind: "PREFIX", prefix: "governance_notification" },
      ],
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
      requiresResolutionNote: true,
      rationale:
        "A HIGH/CRITICAL governance notification was raised and deduped by its own key; the notification is the record, and closure is the operator's written follow-up.",
    },
    {
      sourceId: "billing.dependent_cancellation_failed",
      category: "STORAGE",
      displayLabel: "Storage add-on still billing after cancellation",
      producers: [
        "services/api/src/services/billing/dependent-cancellation-conditions.service.ts",
      ],
      discoveryState: "ACTIVE",
      legacyFingerprints: [],
      // -------------------------------------------------------------------
      // SOURCE_TRUTH, and it could not be anything else.
      // -------------------------------------------------------------------
      // The condition is "a recurring Storage add-on whose plan was cancelled
      // is still live at the payment provider" — which is to say, the customer
      // is still being charged. A person cannot make that stop by concluding
      // it has stopped, so neither a tenant nor an operator may close it with
      // a note or a decision. Only the provider's own state may resolve it,
      // and the probe reads exactly that: the durable obligation the
      // cancellation path maintains, which reaches CONFIRMED only when a
      // provider call or a provider observation proved the cancellation.
      //
      // This is deliberately stricter than "the operator has looked at it".
      // An add-on that is still charging does not care whether anyone looked.
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "billing.dependent_cancellation_state",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      // A provider-side reinstatement, or a cancellation that reported success
      // and did not take, must bring the same condition back rather than
      // leaving a closed one behind.
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      // There IS a safe remediation and the customer holds it: the dedicated
      // "Retry stopping storage add-ons" action, which re-attempts only the
      // unresolved obligations and never re-cancels the base plan.
      remediationDisposition: "SAFE_REMEDIATION",
      requiredCapability: "operations.view",
      audience: "TENANT_ACTIONABLE",
      cardinality: "PER_RECORD",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      // ALLOW_OPERATOR_CLOSE, and the distinction matters. It does NOT let
      // anyone declare the cancellation done — `resolutionAuthority` is
      // SOURCE_TRUTH and only the probe closes it on provider truth. This is
      // the narrower escape hatch every PER_RECORD source needs: if the add-on
      // row itself is gone, the condition names a subject that no longer
      // exists, and a condition nobody can close about a record nobody can see
      // is just permanent noise.
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      requiresResolutionNote: false,
      rationale:
        "The add-on's own dependentCancellationState is a durable, workspace-bound record of whether the provider has confirmed the cancellation, so the condition's truth is a column read; and because the customer is still being charged while it is open, no note or operator decision may close it.",
    },
    {
      sourceId: "storage.immutable_drift",
      category: "GOVERNANCE",
      displayLabel: "Immutable storage drift",
      producers: [
        "services/worker/src/governance/immutable-storage-reconciliation.worker.ts",
      ],
      discoveryState: "ACTIVE",
      legacyFingerprints: [
        { kind: "PREFIX", prefix: "immutable_storage_drift" },
      ],
      // -------------------------------------------------------------------
      // THIS WAS `OPERATOR_DECISION`, AND THAT WAS THE DEFECT.
      // -------------------------------------------------------------------
      // The reasoning was that re-checking means re-reading object storage,
      // which the reconciler owns, so closure had to be a human conclusion.
      // The first half is true and the second does not follow. It made an
      // IMMUTABLE-STORAGE INTEGRITY DRIFT closable by typing a sentence — on
      // an evidence platform, the one category of finding that must never be
      // dismissible by assertion.
      //
      // And the premise was wrong about the product it was describing. The
      // reconciler does not merely re-read storage; it PERSISTS every verdict
      // as an append-only `ImmutableStorageCheck` row, keyed by team and
      // evidence. That table is a canonical, workspace-bound, already-durable
      // record of what the comparison last found, and reading the newest row
      // for one record is a probe: read-only, no object-storage call, no
      // provider contact, no mutation of anything.
      //
      // So the drift closes when the RECONCILER says the record is OK, and
      // not before. An operator who believes it is fixed runs the reconciler.
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "storage.immutable_reconciliation_state",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "GUIDANCE_ONLY",
      requiredCapability: "governance.policy.read",
      audience: "TENANT_ACTIONABLE",
      cardinality: "PER_RECORD",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      requiresResolutionNote: false,
      rationale:
        "The reconciler persists every verdict as an append-only ImmutableStorageCheck row, so the newest row for the record is a read-only canonical answer to whether the drift is still there; nobody may declare an integrity drift over by writing a note.",
    },
    {
      sourceId: "platform.operational_seed",
      category: "GOVERNANCE",
      displayLabel: "Seeded demonstration condition",
      producers: ["services/api/src/services/ops/operational-seed.service.ts"],
      discoveryState: "ACTIVE",
      legacyFingerprints: [{ kind: "PREFIX", prefix: "seed" }],
      // A demo/staging scenario row, tagged with its seed run so the seed's
      // own cleanup can delete it. Registered rather than left unclassified,
      // because an unregistered row in a tenant queue is the hole this
      // closure removes — including a harmless one.
      resolutionAuthority: "OPERATOR_DECISION",
      activityProbeKey: "NONE",
      recoveryPolicy: "OPERATOR_CLOSES",
      recurrencePolicy: "NEW_CONDITION",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "GUIDANCE_ONLY",
      requiredCapability: "operations.view",
      audience: "TENANT_ACTIONABLE",
      cardinality: "EVENT",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "NONE",
      notApplicableDisposition: "ALLOW_OPERATOR_CLOSE",
      requiresResolutionNote: true,
      rationale:
        "A seeded demo condition with no underlying fault; closure is an operator dismissing the demo, recorded like any other conclusion.",
    },
    {
      sourceId: "search.indexing_failure",
      displayLabel: "Search index reconciliation failing",
      category: "RECONCILIATION",
      producers: [
        "services/api/src/services/operations/search-index-conditions.service.ts",
      ],
      // -------------------------------------------------------------------
      // NO LONGER A GAP ON THE ROADMAP.
      // -------------------------------------------------------------------
      // This sat NOT_YET_DISCOVERED on the stated grounds that index health is
      // owned by "the SEARCH_INDEX run authority and its own readiness
      // projection". That authority turned out to be exactly what a producer
      // needs: `GovernanceReconciliationRun` rows carry `kind = SEARCH_INDEX`
      // AND a `team_id`, and the worker's reconciler claims one workspace at a
      // time, so each workspace has its own terminal run with its own status.
      //
      // Workspace-scoped, durable, terminal, and already written. Reading the
      // newest one is a probe; there was nothing left to build but the read.
      discoveryState: "ACTIVE",
      // Brand new. No row in production predates the `source_id` column for
      // this source, so there is no legacy shape to trace and the migration's
      // backfill table is unchanged.
      legacyFingerprints: [],
      resolutionAuthority: "SOURCE_TRUTH",
      activityProbeKey: "search.index_health",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SPECIALIZED_SURFACE",
      requiredCapability: "evidence.read",
      // The workspace's own search is degraded and the workspace cannot
      // repair the reconciler. Advisory, therefore, and with no Resolve
      // control — the next successful run closes it.
      audience: "TENANT_ADVISORY",
      cardinality: "AGGREGATE",
      workspaceApplicability: "ALL_WORKSPACES",
      // The run row counts scanned and failed documents, but those are counts
      // of ONE run's work rather than a standing population measured against a
      // threshold, and presenting them as "affected records" would claim a
      // population nobody measured.
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "REFUSE",
      requiresResolutionNote: false,
      rationale:
        "Each workspace has its own terminal SEARCH_INDEX reconciliation run, so whether indexing is currently failing for this workspace is a durable fact the newest run states, not a judgement.",
    },
    // =======================================================================
    // REGISTERED, WITH NO PRODUCER TODAY.
    //
    // Each of these describes a condition the product can imagine and does not
    // currently emit. They are recorded rather than deleted so the gap is on
    // the record — and their discovery state says so by name, so nothing can
    // report them as production-complete. Every one fails closed.
    // =======================================================================
    {
      sourceId: "integration.configuration_failure",
      category: "INTEGRATION",
      displayLabel: "Integration configuration invalid",
      producers: [],
      discoveryState: "NOT_YET_DISCOVERED",
      legacyFingerprints: [],
      // NOT OPERATOR_DECISION. An invalid integration configuration is an
      // ACTIVE state, and the rule is explicit: prefer SOURCE_TRUTH if the
      // canonical validation authority can safely re-check it, otherwise
      // NO_DIRECT_RESOLUTION. A Settings deep link is not a reason to let
      // somebody declare the configuration fixed.
      //
      // WHAT WAS LOOKED FOR, AND WHAT WAS FOUND. The integration models this
      // product has are `WebhookEndpoint` (status, failureCount),
      // `AutomationWebhookDestination` (enabled, consecutiveFailureCount,
      // autoDisabledAt, disabledReason) and `LifecycleWebhookEndpoint`. Every
      // one of those columns records DELIVERY HEALTH — how the last attempts
      // went — and none records whether the CONFIGURATION is valid. There is
      // no stored validation verdict, no test-connection result and no
      // `validated_at`, so re-enabling a destination resets a counter rather
      // than proving anything about the configuration.
      //
      // Delivery health is a real condition and it already has a source:
      // `webhook.security_failure`. Reusing that state to answer a question it
      // does not answer would be the category defect one level down, so this
      // stays registered, unemitted, and fail-closed.
      resolutionAuthority: "NO_DIRECT_RESOLUTION",
      activityProbeKey: "NONE",
      recoveryPolicy: "NO_RECOVERY_SIGNAL",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SAFE_DEEP_LINK",
      requiredCapability: "integration.webhook.manage",
      audience: "TENANT_ADVISORY",
      cardinality: "EVENT",
      workspaceApplicability: "ALL_WORKSPACES",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "REFUSE",
      requiresResolutionNote: false,
      rationale:
        "A configuration that remains invalid is an active state; no canonical integration-validation authority can re-check it from a resolve path, so nobody may declare it corrected.",
    },
    {
      sourceId: "job.background_failure",
      category: "WORKER",
      displayLabel: "Background job failure",
      producers: [],
      discoveryState: "NOT_YET_DISCOVERED",
      legacyFingerprints: [],
      resolutionAuthority: "NO_DIRECT_RESOLUTION",
      activityProbeKey: "NONE",
      recoveryPolicy: "NO_RECOVERY_SIGNAL",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "SPECIALIZED_SURFACE",
      requiredCapability: "operations.view",
      // Queue health is process-wide. If it is ever emitted, one drained queue
      // must not appear as a separate problem in every tenant's list.
      audience: "PLATFORM_INTERNAL",
      cardinality: "EVENT",
      workspaceApplicability: "PLATFORM_OBSERVED",
      metricContract: "NONE",
      drillDownContract: "SOURCE_SURFACE",
      notApplicableDisposition: "REFUSE",
      requiresResolutionNote: false,
      rationale:
        "BullMQ queue state is global and owned by the queue console and its replay-safety authority; no workspace can observe or declare its recovery.",
    },
    {
      sourceId: "storage.condition",
      category: "STORAGE",
      displayLabel: "Object storage condition",
      producers: [],
      discoveryState: "NOT_YET_DISCOVERED",
      legacyFingerprints: [],
      resolutionAuthority: "NO_DIRECT_RESOLUTION",
      activityProbeKey: "NONE",
      recoveryPolicy: "NO_RECOVERY_SIGNAL",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "GUIDANCE_ONLY",
      requiredCapability: "operations.view",
      audience: "PLATFORM_INTERNAL",
      cardinality: "EVENT",
      workspaceApplicability: "PLATFORM_OBSERVED",
      metricContract: "NONE",
      drillDownContract: "NONE",
      notApplicableDisposition: "REFUSE",
      requiresResolutionNote: false,
      rationale:
        "Object storage is one global component; a bucket fault is not a per-tenant condition and must not be counted once per workspace.",
    },
    {
      sourceId: "database.condition",
      category: "DATABASE",
      displayLabel: "Database condition",
      producers: [],
      discoveryState: "NOT_YET_DISCOVERED",
      legacyFingerprints: [],
      resolutionAuthority: "NO_DIRECT_RESOLUTION",
      activityProbeKey: "NONE",
      recoveryPolicy: "NO_RECOVERY_SIGNAL",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "GUIDANCE_ONLY",
      requiredCapability: "operations.view",
      audience: "PLATFORM_INTERNAL",
      cardinality: "EVENT",
      workspaceApplicability: "PLATFORM_OBSERVED",
      metricContract: "NONE",
      drillDownContract: "NONE",
      notApplicableDisposition: "REFUSE",
      requiresResolutionNote: false,
      rationale:
        "One PostgreSQL instance serves every workspace; a database fault is a platform fact and duplicating it per tenant would say a hundred things went wrong when one did.",
    },
    {
      sourceId: "ai.condition",
      category: "AI",
      displayLabel: "AI service condition",
      producers: [],
      discoveryState: "NOT_YET_DISCOVERED",
      legacyFingerprints: [],
      resolutionAuthority: "NO_DIRECT_RESOLUTION",
      activityProbeKey: "NONE",
      recoveryPolicy: "NO_RECOVERY_SIGNAL",
      recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
      suppressionPolicy: "SUPPRESSION_PERSISTS",
      remediationDisposition: "GUIDANCE_ONLY",
      requiredCapability: "operations.view",
      audience: "PLATFORM_INTERNAL",
      cardinality: "EVENT",
      workspaceApplicability: "PLATFORM_OBSERVED",
      metricContract: "NONE",
      drillDownContract: "NONE",
      notApplicableDisposition: "REFUSE",
      requiresResolutionNote: false,
      rationale:
        "Provider availability and the global AI budget are platform state; nothing evidential depends on the step and no workspace can observe the provider's recovery.",
    },
  ] as const satisfies readonly OperationsSourceLifecycle[]);

/**
 * THE FAIL-CLOSED CONTRACT FOR A CONDITION NO REGISTERED SOURCE CLAIMS.
 *
 * ---------------------------------------------------------------------------
 * THIS USED TO BE `OPERATOR_DECISION`, AND THAT WAS THE DEFECT
 * ---------------------------------------------------------------------------
 * The reasoning was that an unidentifiable condition is probably a per-record
 * domain failure, those are event-shaped, and a stuck queue is worse than a
 * permissive close. Every step of that is a guess about a row the system has
 * just admitted it cannot identify — and the conclusion was that NOT KNOWING
 * WHAT SOMETHING IS made it MORE closable, which inverts the rule the whole
 * correction exists to establish.
 *
 * It is now NO_DIRECT_RESOLUTION with activity UNKNOWN. An operator can
 * acknowledge it, assign it, and suppress it with a recorded reason. They
 * cannot declare it over, because nothing in the system knows what "over"
 * would mean for it.
 *
 * A stuck row is a real cost and it is the RIGHT cost: the fix is to register
 * the source, which the totality gate now requires before an emitter can ship.
 */
export const UNREGISTERED_CONDITION_LIFECYCLE: OperationsSourceLifecycle =
  Object.freeze({
    sourceId: "unregistered.condition" as const,
    // Carried by the caller; the actual incident's category is what the
    // remediation registry keys on, and this row asserts nothing about it.
    category: "RECONCILIATION",
    displayLabel: "Unrecognised operational condition",
    producers: [],
    discoveryState: "NOT_YET_DISCOVERED" as const,
    legacyFingerprints: [],
    resolutionAuthority: "NO_DIRECT_RESOLUTION",
    activityProbeKey: "NONE",
    recoveryPolicy: "NO_RECOVERY_SIGNAL",
    recurrencePolicy: "REOPEN_SAME_FINGERPRINT",
    suppressionPolicy: "SUPPRESSION_PERSISTS",
    remediationDisposition: "GUIDANCE_ONLY",
    requiredCapability: "operations.view",
    // Conservative: the workspace is told the condition exists and is given no
    // control that would claim more than the platform knows.
    audience: "TENANT_ADVISORY",
    cardinality: "EVENT",
    workspaceApplicability: "ALL_WORKSPACES",
    metricContract: "NONE",
    drillDownContract: "NONE",
    notApplicableDisposition: "REFUSE",
    requiresResolutionNote: false,
    rationale:
      "No registered source claims this condition, so nothing knows what recovery would mean for it; it fails closed rather than becoming closable by assertion.",
  });

/** The bounded diagnostic an unregistered condition emits. Never user-facing. */
export const UNREGISTERED_CONDITION_DIAGNOSTIC =
  "UNREGISTERED_CONDITION_SOURCE" as const;

// ===========================================================================
// LOAD-TIME INVARIANTS
// ===========================================================================

/**
 * Properties the TYPE cannot express, checked once at module load.
 *
 * A throw here is deliberate and is not a runtime risk: it can only fire on a
 * registry a developer just edited, and it fires in every process that imports
 * the module — including the build. The alternative is a silent contradiction
 * that reaches production, which is what every one of these exists to stop.
 */
{
  const ids = OPERATIONS_SOURCE_LIFECYCLES.map((s) => s.sourceId);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    throw new Error(`duplicate operations source ids: ${dupes.join(", ")}`);
  }
  for (const s of OPERATIONS_SOURCE_LIFECYCLES) {
    // SOURCE_TRUTH must name the observation that backs the claim.
    if (s.resolutionAuthority === "SOURCE_TRUTH" && s.activityProbeKey === "NONE") {
      throw new Error(`${s.sourceId}: SOURCE_TRUTH with no probe`);
    }
    if (s.resolutionAuthority !== "SOURCE_TRUTH" && s.activityProbeKey !== "NONE") {
      throw new Error(`${s.sourceId}: declares a probe it does not use`);
    }
    // A human conclusion nobody wrote down is indistinguishable from a click.
    if (s.resolutionAuthority === "OPERATOR_DECISION" && !s.requiresResolutionNote) {
      throw new Error(`${s.sourceId}: OPERATOR_DECISION without a required note`);
    }
    if (s.resolutionAuthority !== "OPERATOR_DECISION" && s.requiresResolutionNote) {
      throw new Error(`${s.sourceId}: requires a note it can never collect`);
    }
    // An ACTIVE source with no producer is the ghost this closure removed.
    if (s.discoveryState === "ACTIVE" && s.producers.length === 0) {
      throw new Error(`${s.sourceId}: ACTIVE with no declared producer`);
    }
    if (s.discoveryState === "NOT_YET_DISCOVERED" && s.producers.length > 0) {
      throw new Error(`${s.sourceId}: NOT_YET_DISCOVERED but names a producer`);
    }
    // THE LABEL MUST NOT CONTAIN A NUMBER.
    //
    // The whole point of moving the value out of the title is that a title is
    // written once and a value changes. A digit here is a value that has been
    // put back where nothing can refresh it — which is how "Report backlog
    // above threshold (26)" outlived the backlog it described by months.
    if (s.displayLabel.trim().length === 0) {
      throw new Error(`${s.sourceId}: empty display label`);
    }
    if (/[0-9]/.test(s.displayLabel)) {
      throw new Error(
        `${s.sourceId}: display label carries a count (${s.displayLabel})`,
      );
    }
    // Only a tenant-actionable source may offer any mutation-shaped action.
    if (s.audience !== "TENANT_ACTIONABLE" && s.resolutionAuthority === "OPERATOR_DECISION") {
      throw new Error(`${s.sourceId}: non-actionable audience offers Resolve`);
    }
  }
  // One legacy fingerprint pattern may belong to exactly one source, or the
  // backfill would have to guess — and a guessed source is a guessed lifecycle.
  const seen = new Map<string, string>();
  for (const s of OPERATIONS_SOURCE_LIFECYCLES) {
    for (const p of s.legacyFingerprints) {
      const key = p.kind === "PREFIX" ? `P:${p.prefix}` : `E:${p.fingerprint}`;
      const other = seen.get(key);
      if (other) {
        throw new Error(
          `legacy fingerprint ${key} claimed by both ${other} and ${s.sourceId}`,
        );
      }
      seen.set(key, s.sourceId);
    }
  }
}

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

/** The source ids a production emitter may legitimately pass. */
export function activeOperationsSourceIds(): string[] {
  return OPERATIONS_SOURCE_LIFECYCLES.filter(
    (s) => s.discoveryState === "ACTIVE",
  ).map((s) => s.sourceId);
}

/**
 * The typed source id a writer must pass.
 *
 * A plain `string` here would let a typo compile, and a typo would resolve to
 * no contract and fail closed — safe, and invisible until somebody noticed a
 * queue nobody could clear.
 */
export type OperationsSourceId = string & { readonly __opsSource?: never };

/** The contract for one source id, or null when it is not registered. */
export function lifecycleForSourceId(
  sourceId: string | null | undefined,
): OperationsSourceLifecycle | null {
  if (!sourceId) return null;
  return BY_ID.get(sourceId) ?? null;
}

/** True when this id names a registered source. For the writer-side guard. */
export function isRegisteredOperationsSource(sourceId: string): boolean {
  return BY_ID.has(sourceId);
}

/** How a condition was traced to its source. Reported, never inferred twice. */
export type SourceMatchKind =
  /** The row carries an explicit, registered `source_id`. */
  | "DECLARED"
  /** Written before the column existed; one legacy fingerprint pattern matched. */
  | "LEGACY_FINGERPRINT"
  /** Nothing identified it. Fails closed. */
  | "UNREGISTERED";

export type ResolvedConditionSource = {
  readonly lifecycle: OperationsSourceLifecycle;
  readonly match: SourceMatchKind;
  /** Set only for UNREGISTERED. A bounded internal diagnostic, never shown. */
  readonly diagnostic: typeof UNREGISTERED_CONDITION_DIAGNOSTIC | null;
};

/**
 * WHICH SOURCE OWNS THIS CONDITION.
 *
 * DECLARED first, legacy fingerprint second, fail closed third. Category is
 * not consulted at any point — it was the first inference this closure
 * removed, and re-admitting it as a third fallback would put it back.
 *
 * Pure. Both hosts call it.
 */
export function resolveConditionSource(condition: {
  sourceId?: string | null;
  category?: string;
  fingerprint?: string;
}): ResolvedConditionSource {
  // 1. The row says what it is.
  const declared = lifecycleForSourceId(condition.sourceId);
  if (declared) {
    return { lifecycle: declared, match: "DECLARED", diagnostic: null };
  }

  // 2. Written before `source_id`. One pattern, one source, or nothing.
  const fingerprint = condition.fingerprint ?? "";
  if (fingerprint) {
    for (const lifecycle of OPERATIONS_SOURCE_LIFECYCLES) {
      for (const p of lifecycle.legacyFingerprints) {
        if (p.kind === "EXACT" && fingerprint === p.fingerprint) {
          return { lifecycle, match: "LEGACY_FINGERPRINT", diagnostic: null };
        }
        // The separator is part of the match, so `report_backlog_v2` cannot
        // inherit `report_backlog`.
        if (p.kind === "PREFIX" && fingerprint.startsWith(`${p.prefix}:`)) {
          return { lifecycle, match: "LEGACY_FINGERPRINT", diagnostic: null };
        }
      }
    }
  }

  // 3. Nothing knows what this is. It does not become closable because of it.
  return {
    lifecycle: UNREGISTERED_CONDITION_LIFECYCLE,
    match: "UNREGISTERED",
    diagnostic: UNREGISTERED_CONDITION_DIAGNOSTIC,
  };
}

/**
 * The source a LEGACY row should be backfilled to, or null.
 *
 * The migration's backfill and the runtime read the same table through this
 * one function, so a row the backfill stamps and a row it leaves NULL resolve
 * identically — which is what makes the backfill an optimisation rather than a
 * second opinion.
 */
export function backfillSourceIdForFingerprint(
  fingerprint: string,
): string | null {
  const r = resolveConditionSource({ fingerprint });
  return r.match === "LEGACY_FINGERPRINT" ? r.lifecycle.sourceId : null;
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

/**
 * THE LABEL A SURFACE RENDERS FOR ONE CONDITION.
 *
 * The count-free sentence from the condition's own source contract, with the
 * STORED title as the fallback for a condition no source claims.
 *
 * That fallback is deliberate and is not a hole. An unregistered row's stored
 * title is the only description of it that exists; substituting a generic
 * placeholder would replace a specific sentence somebody wrote with a vaguer
 * one, which is a loss and not a safety property. What matters for safety is
 * the LIFECYCLE, and an unregistered condition's lifecycle already fails
 * closed regardless of what it is called.
 *
 * NOTHING IS PARSED. No regex picks the number back out of a legacy title, no
 * heuristic strips a trailing parenthesis, and no stored string is rewritten.
 * A legacy row displays its source's label because its source is KNOWN — from
 * the declared `source_id`, or from the one legacy fingerprint pattern that
 * means exactly one source — and the title column keeps saying whatever it
 * said on the day the row was written.
 */
export function conditionDisplayLabel(
  resolved: ResolvedConditionSource,
  storedTitle: string,
): string {
  if (resolved.match === "UNREGISTERED") return storedTitle;
  return resolved.lifecycle.displayLabel;
}

/**
 * Is this condition the tenant's business at all?
 *
 * PLATFORM_INTERNAL conditions are excluded from every tenant surface — list,
 * summary, groups, counts, readiness — because they describe ONE global
 * component and were being written once per workspace. A dead worker is not a
 * hundred problems.
 */
export function isTenantVisibleAudience(
  lifecycle: OperationsSourceLifecycle,
): boolean {
  return lifecycle.audience !== "PLATFORM_INTERNAL";
}

/** Every source id whose conditions must never reach a tenant surface. */
export function platformInternalSourceIds(): string[] {
  return OPERATIONS_SOURCE_LIFECYCLES.filter(
    (s) => s.audience === "PLATFORM_INTERNAL",
  ).map((s) => s.sourceId);
}
