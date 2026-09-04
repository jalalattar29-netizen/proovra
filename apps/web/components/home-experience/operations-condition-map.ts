/**
 * OPERATIONS CONDITIONS → HOME PRIORITIES. ONE EXHAUSTIVE MAPPING.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS
 * =============================================================================
 * `mayAssertAllClear` is refused whenever the workspace has ANY unresolved
 * operational condition — the gate counts every open row, from any of the 37
 * registered sources. Home's `buildWorkspacePriorities` reads trust, pipeline,
 * submissions, collection, report, matter and storage signals and has no input
 * from operational conditions at all.
 *
 * So a workspace whose only open conditions came from a source Home cannot see
 * rendered an empty priority list beside a refused all-clear, and the card said
 * so in the vaguest possible terms. Reproduced on a FREE personal workspace:
 * three open conditions — a delayed telemetry sampler, a queue retry storm and
 * an unclassified security signal — none of which Home's vocabulary contained.
 *
 * This file is that missing vocabulary. Every source in the canonical registry
 * has an entry, and the entry says what the customer should see.
 *
 * =============================================================================
 * THE IDENTITY IS `sourceId`, NEVER THE TITLE
 * =============================================================================
 * `GET /v1/ops/summary` groups conditions by `sourceId`, the stable id the
 * registry persists on every row. Titles are display text — the runtime's own
 * lifecycle contract records that older rows still carry count-bearing titles
 * like "Report backlog above threshold (26)" — so matching on them would be
 * matching on a frozen string. Grouping, dedupe and representation here all key
 * on `sourceId`.
 *
 * =============================================================================
 * HOW A REPRESENTATION IS CHOSEN
 * =============================================================================
 * Three kinds, and which one a source gets is decided by its own lifecycle
 * contract rather than by taste:
 *
 *   MERGE     Home already derives this fact from a canonical aggregate. The
 *             Home row wins — it is uncapped, it carries the real count, and
 *             it already has the right action. The condition contributes
 *             nothing extra except the knowledge that it is accounted for.
 *
 *   ROW       Home has no other way to know. The condition becomes a priority
 *             row in the same model as every other, so ordering, styling and
 *             actions stay consistent.
 *
 *   PLATFORM  `audience: PLATFORM_INTERNAL`. The lifecycle contract states
 *             these are global infrastructure telemetry that "belongs on the
 *             platform observability surface and nowhere else", because the
 *             same fault would otherwise be duplicated into every workspace.
 *             They are NOT hidden: they collapse into ONE advisory row that
 *             says the platform is degraded in customer language, with no
 *             worker names, queue ids or service internals, and no action the
 *             tenant cannot take.
 *
 * A `TENANT_ADVISORY` source is a ROW like any other; what its audience changes
 * is the WORDING and the absence of a repair action, not its visibility. The
 * workspace is affected by it, so the workspace is told.
 *
 * =============================================================================
 * WHAT MAKES A FUTURE OMISSION IMPOSSIBLE TO MISS
 * =============================================================================
 * `HOME_CONDITION_REPRESENTATION` is a `Record` over a closed union, so a new
 * id added to `HOME_OPERATIONS_SOURCE_IDS` without a representation does not
 * compile. And `home-operations-condition-coverage.test.ts` asserts that union
 * equals the server registry's ids exactly, so a source added to the registry
 * and forgotten here fails a test rather than silently disappearing from Home.
 *
 * There is no `default: ignore` and no `unknown => null`. The only unknown path
 * is `UNRECOGNISED_SOURCE`, which exists solely for version skew — a deployed
 * web build meeting a server that already knows a newer source — and says so.
 */

/*
 * No import from the view model on purpose: the view model imports THIS file,
 * and a type cycle between them would make either one hard to move. The two
 * fields borrowed below are narrow enough to state once here.
 */
export type ConditionSeverity = "critical" | "warning" | "info";

/** The shape of a Home priority, minus the parts derived at build time. */
export type ConditionPriorityTemplate = {
  readonly key: string;
  readonly severity: ConditionSeverity;
  readonly domains: readonly string[];
  readonly label: string;
  readonly whyItMatters: string;
  readonly recommendedAction: string;
  readonly actionLabel: string;
  readonly href: string;
};

/**
 * Every source id in `services/api/src/services/operations/operations-source-registry.ts`.
 *
 * Kept in this order so the two lists can be diffed by eye; the coverage test
 * compares them as sets, so order is a convenience rather than a contract.
 */
export const HOME_OPERATIONS_SOURCE_IDS = [
  "evidence_integrity.tsa_failed",
  "evidence_integrity.ots_failed",
  "evidence_integrity.ots_pending_aged",
  "pipeline.report_backlog",
  "pipeline.package_backlog",
  "pipeline.signed_without_report_aged",
  "review.stale_workflows",
  "coordination.backlog_stale",
  "queue.retry_storm",
  "platform.telemetry_stale",
  "platform.worker_heartbeat_stale",
  "intake.delivery_failed",
  "communications.provider_failure",
  "webhook.security_failure",
  "search.indexing_failure",
  "job.background_failure",
  "integration.configuration_failure",
  "identity.security_condition",
  "governance.policy_condition",
  "storage.condition",
  "ai.condition",
  "database.condition",
  "evidence_integrity.ots_budget_exhausted",
  "pipeline.report_generation_failed",
  "pipeline.package_generation_denied",
  "review.escalation",
  "review.escalation_storm",
  "security.unclassified_signal",
  "identity.idp_outage",
  "identity.runtime_block",
  "identity.high_risk_session_surge",
  "governance.destruction_executed",
  "governance.notification_escalated",
  "billing.dependent_cancellation_failed",
  "billing.provider_authorization",
  "storage.immutable_drift",
  "platform.operational_seed",
  /*
   * The 38th, and it is NOT one of the registry's discovery sources.
   *
   * `UNREGISTERED_CONDITION_LIFECYCLE` is the server's fail-closed contract for
   * a condition no registered source claims. Its audience is TENANT_ADVISORY —
   * "the workspace is told the condition exists and is given no control that
   * would claim more than the platform knows" — so it must be represented, and
   * it reached a real fixture workspace, which is how it was found here.
   *
   * It is a KNOWN contract. Representing it as version skew would be a lie
   * about a state the server deliberately produces.
   */
  "unregistered.condition",
] as const;

export type HomeOperationsSourceId = (typeof HOME_OPERATIONS_SOURCE_IDS)[number];

/** Priority keys Home already produces, and which a condition may merge into. */
export type MergeTargetKey =
  | "tsa_failures"
  | "anchoring_terminal"
  | "ots_pending"
  | "resolve_integrity"
  | "complete_packages"
  | "matters_need_reports"
  | "review_submissions"
  | "storage_pressure";

export type HomeConditionRepresentation =
  | {
      readonly kind: "MERGE";
      /** The Home priority that already states this fact. */
      readonly into: MergeTargetKey;
      /** Why the Home row is the better statement of the two. */
      readonly because: string;
    }
  | {
      readonly kind: "ROW";
      readonly severity: ConditionSeverity;
      readonly domains: readonly string[];
      /** Customer-facing. No worker names, queue ids or service internals. */
      readonly label: string;
      readonly whyItMatters: string;
      readonly recommendedAction: string;
      readonly actionLabel: string;
      readonly href: string;
    }
  | {
      readonly kind: "PLATFORM";
      /** Recorded so the refusal to show internals is auditable, not silent. */
      readonly because: string;
    };

/**
 * THE MAPPING.
 *
 * Each entry answers one question: when this condition is open, what should the
 * person using the workspace see?
 */
export const HOME_CONDITION_REPRESENTATION: Record<
  HomeOperationsSourceId,
  HomeConditionRepresentation
> = {
  // ---- Evidence integrity — Home already derives all four from trust totals -
  "evidence_integrity.tsa_failed": {
    kind: "MERGE",
    into: "tsa_failures",
    because:
      "Home reads `trust.tsaFailed`, the uncapped workspace aggregate. The condition is a bounded scan of the same fact.",
  },
  "evidence_integrity.ots_failed": {
    kind: "MERGE",
    into: "anchoring_terminal",
    because: "Home reads `trust.otsFailed` for the same records.",
  },
  "evidence_integrity.ots_budget_exhausted": {
    kind: "MERGE",
    into: "anchoring_terminal",
    because:
      "An abandoned anchor is terminal for the same records the anchoring row already lists.",
  },
  "evidence_integrity.ots_pending_aged": {
    kind: "MERGE",
    into: "ots_pending",
    because: "Home already lists aged pending anchors from `trust.otsPending`.",
  },

  // ---- Pipeline ------------------------------------------------------------
  "pipeline.report_backlog": {
    kind: "MERGE",
    into: "matters_need_reports",
    because:
      "Home derives the same backlog from the command-centre pipeline projection, with the real count.",
  },
  "pipeline.package_backlog": {
    kind: "MERGE",
    into: "complete_packages",
    because: "Home derives the package backlog from the same pipeline projection.",
  },
  "pipeline.signed_without_report_aged": {
    kind: "MERGE",
    into: "matters_need_reports",
    because:
      "Signed-but-unreported records are the same deliverable gap the matters row already reports.",
  },
  "pipeline.report_generation_failed": {
    kind: "ROW",
    severity: "critical",
    domains: ["report"],
    label: "A report could not be generated",
    whyItMatters:
      "The record has no report to share or file, and the attempt failed rather than being retried.",
    recommendedAction: "Open Reports and retry generation for the affected record.",
    actionLabel: "Open reports",
    href: "/reports",
  },
  "pipeline.package_generation_denied": {
    kind: "ROW",
    severity: "warning",
    domains: ["package"],
    label: "A verification package was refused",
    whyItMatters:
      "Governance refused to build the package, so the record cannot be handed to an external reviewer yet.",
    recommendedAction: "Open Reports to see which rule refused it.",
    actionLabel: "Open reports",
    href: "/reports",
  },

  // ---- Review --------------------------------------------------------------
  "review.stale_workflows": {
    kind: "ROW",
    severity: "warning",
    domains: ["review"],
    label: "Reviews have stopped progressing",
    whyItMatters:
      "Review work has sat without movement long enough that it is unlikely to resume on its own.",
    recommendedAction: "Open the review queue and pick the stalled items back up.",
    actionLabel: "Open review queue",
    href: "/review/queues",
  },
  "review.escalation": {
    kind: "ROW",
    severity: "warning",
    domains: ["review"],
    label: "A review was escalated",
    whyItMatters: "Someone asked for a decision above the reviewer handling it.",
    recommendedAction: "Open escalations and resolve the request.",
    actionLabel: "Open escalations",
    href: "/reviewer-ops/escalations",
  },
  "review.escalation_storm": {
    kind: "ROW",
    severity: "critical",
    domains: ["review"],
    label: "Reviews are being escalated repeatedly",
    whyItMatters:
      "A burst of escalations usually means one underlying problem, not many separate ones.",
    recommendedAction: "Open escalations and look for the common cause.",
    actionLabel: "Open escalations",
    href: "/reviewer-ops/escalations",
  },

  // ---- Coordination / intake ----------------------------------------------
  "coordination.backlog_stale": {
    kind: "ROW",
    severity: "warning",
    domains: ["matter"],
    label: "Coordination work has gone quiet",
    whyItMatters:
      "Items waiting on someone else have sat untouched past the point where they usually move.",
    recommendedAction: "Open Operations to see what is waiting and on whom.",
    actionLabel: "Open operations",
    href: "/operations",
  },
  "intake.delivery_failed": {
    kind: "MERGE",
    into: "review_submissions",
    because:
      "Home already surfaces intake state from the submissions and collection projections.",
  },

  // ---- Queue / processing --------------------------------------------------
  "queue.retry_storm": {
    kind: "ROW",
    severity: "warning",
    domains: ["report"],
    label: "Background processing is retrying repeatedly",
    whyItMatters:
      "Work such as report generation and anchoring is being retried instead of completing, so results may be delayed.",
    recommendedAction: "Open Operations to see which work is affected.",
    actionLabel: "Open operations",
    href: "/operations",
  },
  "platform.telemetry_stale": {
    kind: "ROW",
    severity: "info",
    domains: ["report"],
    label: "Processing status is reporting late",
    whyItMatters:
      "Progress figures for background work may lag behind reality for a while. Your evidence is unaffected.",
    recommendedAction: "No action needed — this clears on its own.",
    actionLabel: "Open operations",
    href: "/operations",
  },

  // ---- Security / identity -------------------------------------------------
  "security.unclassified_signal": {
    kind: "ROW",
    severity: "info",
    domains: ["governance"],
    label: "A security signal needs review",
    whyItMatters:
      "Something was recorded that did not match a known pattern, so it has been kept for a person to look at.",
    recommendedAction: "Open Operations to review the signal.",
    actionLabel: "Open operations",
    href: "/operations",
  },
  "identity.security_condition": {
    kind: "ROW",
    severity: "warning",
    domains: ["governance"],
    label: "A sign-in security condition was recorded",
    whyItMatters: "Account access behaviour crossed a threshold worth checking.",
    recommendedAction: "Open the security centre to review recent access.",
    actionLabel: "Open security centre",
    href: "/security-center",
  },
  "identity.idp_outage": {
    kind: "ROW",
    severity: "critical",
    domains: ["governance"],
    label: "Your sign-in provider is unreachable",
    whyItMatters: "People in this workspace may not be able to sign in.",
    recommendedAction: "Open the security centre to check the connection.",
    actionLabel: "Open security centre",
    href: "/security-center/sso",
  },
  "identity.runtime_block": {
    kind: "ROW",
    severity: "warning",
    domains: ["governance"],
    label: "A sign-in was blocked",
    whyItMatters:
      "Access was refused because it looked risky. A real person may be locked out.",
    recommendedAction: "Open the security centre to review the block.",
    actionLabel: "Open security centre",
    href: "/security-center",
  },
  "identity.high_risk_session_surge": {
    kind: "ROW",
    severity: "warning",
    domains: ["governance"],
    label: "Unusual sign-in activity",
    whyItMatters: "More risky sessions than usual were seen in a short window.",
    recommendedAction: "Open the security centre and review active sessions.",
    actionLabel: "Open security centre",
    href: "/security-center",
  },
  "webhook.security_failure": {
    kind: "ROW",
    severity: "warning",
    domains: ["governance"],
    label: "A webhook delivery was rejected",
    whyItMatters:
      "An outbound notification failed its security check, so the receiving system did not get it.",
    recommendedAction: "Open Integrations to check the endpoint's signing settings.",
    actionLabel: "Open integrations",
    href: "/integrations",
  },

  // ---- Governance ----------------------------------------------------------
  "governance.policy_condition": {
    kind: "ROW",
    severity: "warning",
    domains: ["governance"],
    label: "A governance policy needs attention",
    whyItMatters:
      "A retention, hold or disposal rule is in a state that stops it being applied as written.",
    recommendedAction: "Open Governance to review the policy.",
    actionLabel: "Open governance",
    href: "/governance/policy",
  },
  "governance.destruction_executed": {
    kind: "ROW",
    severity: "info",
    domains: ["governance"],
    label: "Evidence was destroyed under policy",
    whyItMatters:
      "A disposal ran and completed. The certificate is the record of what was removed.",
    recommendedAction: "Open Governance to read the destruction record.",
    actionLabel: "Open governance",
    href: "/governance/destruction",
  },
  "governance.notification_escalated": {
    kind: "ROW",
    severity: "warning",
    domains: ["governance"],
    label: "A governance notice was escalated",
    whyItMatters: "A notice went unanswered long enough to be raised.",
    recommendedAction: "Open Governance to answer it.",
    actionLabel: "Open governance",
    href: "/governance/notifications",
  },
  "storage.immutable_drift": {
    kind: "ROW",
    severity: "critical",
    domains: ["governance", "storage"],
    label: "Immutable storage protection has drifted",
    whyItMatters:
      "Stored evidence is meant to be write-protected and the protection no longer matches the policy.",
    recommendedAction: "Open Governance to review retention protection.",
    actionLabel: "Open governance",
    href: "/governance/retention",
  },

  // ---- Communications / integrations / search ------------------------------
  "communications.provider_failure": {
    kind: "ROW",
    severity: "warning",
    domains: ["collection"],
    label: "Messages could not be delivered",
    whyItMatters:
      "Invitations and evidence requests sent from this workspace are not reaching people.",
    recommendedAction: "Open Operations to see the failing deliveries.",
    actionLabel: "Open operations",
    href: "/operations",
  },
  "integration.configuration_failure": {
    kind: "ROW",
    severity: "warning",
    domains: ["governance"],
    label: "An integration is misconfigured",
    whyItMatters: "A connected system cannot be reached with its current settings.",
    recommendedAction: "Open Integrations and check the connection.",
    actionLabel: "Open integrations",
    href: "/integrations",
  },
  "search.indexing_failure": {
    kind: "ROW",
    severity: "info",
    domains: ["evidence"],
    label: "Search results may be incomplete",
    whyItMatters:
      "Indexing is behind, so recent records may not appear in search yet. Nothing is lost.",
    recommendedAction: "Open Search once indexing catches up.",
    actionLabel: "Open search",
    href: "/search",
  },

  // ---- Billing -------------------------------------------------------------
  "billing.dependent_cancellation_failed": {
    kind: "MERGE",
    into: "storage_pressure",
    because:
      "Home already states the storage and plan position from the billing overview, which is the same subject with the real numbers.",
  },
  "billing.provider_authorization": {
    kind: "PLATFORM",
    because:
      "PLATFORM_INTERNAL: our own credentials at the payment provider. Nothing in the workspace caused it and nothing there can fix it.",
  },

  // ---- Platform infrastructure --------------------------------------------
  "platform.worker_heartbeat_stale": {
    kind: "PLATFORM",
    because: "PLATFORM_INTERNAL: worker fleet health, identical across every workspace.",
  },
  "job.background_failure": {
    kind: "PLATFORM",
    because: "PLATFORM_INTERNAL: a platform job, not this workspace's work.",
  },
  "storage.condition": {
    kind: "PLATFORM",
    because: "PLATFORM_INTERNAL: object-storage infrastructure.",
  },
  "database.condition": {
    kind: "PLATFORM",
    because: "PLATFORM_INTERNAL: database infrastructure.",
  },
  "ai.condition": {
    kind: "PLATFORM",
    because: "PLATFORM_INTERNAL: AI service infrastructure.",
  },

  // ---- The condition nothing claims ---------------------------------------
  "unregistered.condition": {
    kind: "ROW",
    severity: "info",
    domains: ["governance"],
    label: "An operational condition is under investigation",
    whyItMatters:
      "Something was recorded that we have not finished classifying. Your evidence and its integrity records are unaffected.",
    recommendedAction: "No action is needed here — Operations shows what is known.",
    actionLabel: "Open operations",
    href: "/operations",
  },

  // ---- Fixtures ------------------------------------------------------------
  "platform.operational_seed": {
    kind: "ROW",
    severity: "info",
    domains: ["governance"],
    label: "Demonstration condition",
    whyItMatters:
      "A seeded example used to show how Operations behaves. It is not a real problem.",
    recommendedAction: "Open Operations to clear it.",
    actionLabel: "Open operations",
    href: "/operations",
  },
};

/** The one row every PLATFORM_INTERNAL condition collapses into. */
export const PLATFORM_ADVISORY_PRIORITY: ConditionPriorityTemplate = {
  key: "platform_service_degraded",
  severity: "info",
  domains: ["report"],
  label: "A platform service is degraded",
  whyItMatters:
    "Part of our infrastructure is not running normally. Your evidence and its integrity records are unaffected.",
  recommendedAction: "No action needed here — we are working on it.",
  actionLabel: "Open operations",
  href: "/operations",
};

/**
 * The row shown when the SERVER reports a source this build has never heard of.
 *
 * This is the only unknown path, and it is a version-skew statement rather than
 * a product state: a deployed web build meeting an API that already knows a
 * newer condition. It must never be the representation of a known source, which
 * is what the exhaustive record above and its coverage test guarantee.
 */
export const UNRECOGNISED_SOURCE_PRIORITY: ConditionPriorityTemplate = {
  key: "operations_condition_unrecognised",
  severity: "info",
  domains: ["report"],
  label: "An operational condition needs the newest app version",
  whyItMatters:
    "Operations is reporting something this version of the app does not know how to describe yet.",
  recommendedAction: "Open Operations to see it in full, or reload to pick up the latest version.",
  actionLabel: "Open operations",
  href: "/operations",
};

export function representationFor(
  sourceId: string,
): HomeConditionRepresentation | null {
  return (
    (HOME_CONDITION_REPRESENTATION as Record<string, HomeConditionRepresentation>)[
      sourceId
    ] ?? null
  );
}
