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
import { conditionSourceLabel, fillOperationsCopy, operationsCopyFor } from "@proovra/shared";

import { formatOpsNumber } from "../../app/(app)/operations/_lib/format";

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
  "evidence_integrity.ots_initialization_stalled",
  "pipeline.report_backlog",
  "pipeline.package_backlog",
  "pipeline.signed_without_report_aged",
  "review.stale_workflows",
  "coordination.backlog_stale",
  "queue.retry_storm",
  "platform.telemetry_stale",
  "platform.worker_heartbeat_stale",
  "platform.bitcoin_verifier_unavailable",
  "intake.delivery_failed",
  "capture.upload_stalled",
  "capture.legacy_upload_session_signal",
  "communications.provider_failure",
  "webhook.security_failure",
  "integration.webhook_destination_disabled",
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
  "pipeline.package_generation_failed",
  "review.escalation",
  "review.escalation_storm",
  "security.unclassified_signal",
  "identity.idp_outage",
  "identity.runtime_block",
  "identity.high_risk_session_surge",
  "governance.destruction_executed",
  "governance.retention_unverified",
  "governance.archive_restore_failed",
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
      /**
       * Where the row's action goes. Its WORDS are not here: the title is the
       * source's catalogue label and the rest is the canonical Operations copy,
       * in the reader's language (`operationsRowText`).
       */
      readonly href: string;
    }
  | {
      readonly kind: "PLATFORM";
      /** Recorded so the refusal to show internals is auditable, not silent. */
      readonly because: string;
    }
  | {
      /**
       * OPS-001 / OPS-002 — a source that was a FALSE signal and is no longer
       * produced. A stored row of it says nothing true about anything, so it
       * reaches Home as nothing at all — not even the platform advisory.
       */
      readonly kind: "RETIRED";
      readonly because: string;
    }
  | {
      /**
       * A registered source NOTHING produces (NOT_YET_DISCOVERED). It is not an
       * operational capability of this product, so it is advertised nowhere:
       * no row, no action, no count. A stray historical row reaches Home as
       * nothing at all.
       */
      readonly kind: "NOT_PRODUCED";
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
  /*
   * RELIABILITY CLOSURE (2026-09-09) — never started, not merely slow.
   *
   * NOT merged into `ots_pending`, which is where its aged-pending sibling
   * goes. That row is built from `trust.otsPending` — records that HAVE a
   * proof and are waiting on the calendar — and this condition is the opposite
   * fact: no proof was ever made, because the handoff from finalize to the
   * anchoring queue did not survive. Folding it in would hide a broken handoff
   * inside a count of healthy waiting.
   */
  "evidence_integrity.ots_initialization_stalled": {
    kind: "ROW",
    severity: "warning",
    domains: ["integrity"],
    href: "/evidence",
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
    kind: "RETIRED",
    because:
      "RETIRED: counted a status no writer sets, so it could never be observed (OPS-13). Signed records awaiting a report are the report backlog.",
  },
  "pipeline.report_generation_failed": {
    kind: "ROW",
    severity: "critical",
    domains: ["report"],
    href: "/reports",
  },
  "pipeline.package_generation_denied": {
    kind: "ROW",
    severity: "warning",
    domains: ["package"],
    href: "/reports",
  },
  /*
   * RELIABILITY CLOSURE (2026-09-09) — a technical failure, not a refusal.
   *
   * Its sibling above is a GOVERNANCE denial, and the distinction is the whole
   * point: a policy decision is not an outage, and an outage is not a policy
   * decision. The operator does different things about them.
   */
  "pipeline.package_generation_failed": {
    kind: "ROW",
    severity: "warning",
    domains: ["package"],
    href: "/reports",
  },

  // ---- Review --------------------------------------------------------------
  "review.stale_workflows": {
    kind: "ROW",
    severity: "warning",
    domains: ["review"],
    href: "/review/queues",
  },
  "review.escalation": {
    kind: "ROW",
    severity: "warning",
    domains: ["review"],
    href: "/reviewer-ops/escalations",
  },
  "review.escalation_storm": {
    kind: "ROW",
    severity: "critical",
    domains: ["review"],
    href: "/reviewer-ops/escalations",
  },

  // ---- Coordination / intake ----------------------------------------------
  "coordination.backlog_stale": {
    kind: "ROW",
    severity: "warning",
    domains: ["matter"],
    href: "/operations",
  },
  // NOT AN INTAKE DELIVERY (2026-10-14): its producers are the upload service
  // failing to start or resume an upload. The person uploading already saw
  // the error; Home does not ask anyone to act on it.
  "intake.delivery_failed": {
    kind: "ROW",
    severity: "warning",
    domains: ["evidence"],
    href: "/operations",
  },
  // ONE stalled upload of a record that is still uploading.
  "capture.upload_stalled": {
    kind: "ROW",
    severity: "warning",
    domains: ["evidence"],
    href: "/evidence",
  },

  // ---- Queue / processing --------------------------------------------------
  // OPS-001 / OPS-002 — RETIRED. Neither source is produced any more; a stored
  // row of either is platform history, never a workspace's Home attention.
  // 2026-10-14 — HISTORICAL: rows from the old per-workspace upload-session
  // bridge. Nothing produces it again; its rows are Operations history, never
  // Home attention. Genuine stalls are capture.upload_stalled.
  "capture.legacy_upload_session_signal": {
    kind: "NOT_PRODUCED",
    because: "HISTORICAL: never produced again; its rows are Operations history only.",
  },
  "queue.retry_storm": {
    kind: "RETIRED",
    because: "RETIRED: counted re-observed conditions, not job retries (OPS-002).",
  },
  "platform.telemetry_stale": {
    kind: "RETIRED",
    because: "RETIRED: measured Home page visits, not workers (OPS-001).",
  },

  // ---- Security / identity -------------------------------------------------
  "security.unclassified_signal": {
    kind: "RETIRED",
    because:
      "RETIRED: the bridge's unclosable default row; unrecognised security events are counted, never written into a workspace (OPS-13).",
  },
  "identity.security_condition": {
    kind: "ROW",
    severity: "warning",
    domains: ["governance"],
    href: "/security-center",
  },
  "identity.idp_outage": {
    kind: "ROW",
    severity: "critical",
    domains: ["governance"],
    href: "/security-center/sso",
  },
  "identity.runtime_block": {
    kind: "ROW",
    severity: "warning",
    domains: ["governance"],
    href: "/security-center",
  },
  "identity.high_risk_session_surge": {
    kind: "ROW",
    severity: "warning",
    domains: ["governance"],
    href: "/security-center",
  },
  "integration.webhook_destination_disabled": {
    kind: "ROW",
    severity: "warning",
    domains: ["governance"],
    href: "/operations/automation",
  },
  "webhook.security_failure": {
    kind: "ROW",
    severity: "warning",
    domains: ["governance"],
    href: "/integrations",
  },

  // ---- Governance ----------------------------------------------------------
  "governance.policy_condition": {
    kind: "NOT_PRODUCED",
    because: "NOT_YET_DISCOVERED: no emitter writes this source.",
  },
  "governance.destruction_executed": {
    kind: "ROW",
    severity: "info",
    domains: ["governance"],
    href: "/governance/destruction",
  },
  "governance.retention_unverified": {
    kind: "ROW",
    severity: "warning",
    domains: ["governance"],
    href: "/evidence/archive",
  },
  "governance.archive_restore_failed": {
    kind: "ROW",
    severity: "warning",
    domains: ["governance"],
    href: "/evidence/archive",
  },
  "governance.notification_escalated": {
    kind: "ROW",
    severity: "warning",
    domains: ["governance"],
    href: "/governance/notifications",
  },
  "storage.immutable_drift": {
    kind: "ROW",
    severity: "critical",
    domains: ["governance", "storage"],
    href: "/governance/retention",
  },

  // ---- Communications / integrations / search ------------------------------
  "communications.provider_failure": {
    kind: "ROW",
    severity: "warning",
    domains: ["collection"],
    href: "/operations",
  },
  "integration.configuration_failure": {
    kind: "NOT_PRODUCED",
    because: "NOT_YET_DISCOVERED: no stored configuration verdict exists to observe.",
  },
  "search.indexing_failure": {
    kind: "ROW",
    severity: "info",
    domains: ["evidence"],
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
  "platform.bitcoin_verifier_unavailable": {
    kind: "PLATFORM",
    because: "PLATFORM_INTERNAL: the platform's Bitcoin verifier node; no workspace caused it and recorded attestations stay recorded.",
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
    href: "/operations",
  },

  // ---- Fixtures ------------------------------------------------------------
  "platform.operational_seed": {
    kind: "ROW",
    severity: "info",
    domains: ["governance"],
    href: "/operations",
  },
};

/** The one row every PLATFORM_INTERNAL condition collapses into. */
export const PLATFORM_ADVISORY_PRIORITY: ConditionPriorityTemplate = {
  key: "platform_service_degraded",
  severity: "info",
  domains: ["report"],
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

/**
 * WHAT A HOME OPERATIONS ROW STANDS FOR (2026-10-14) — identities only. The
 * row's words are derived from it at render time, in the reader's language, so
 * a locale change or a workspace switch can never leave stale copy behind.
 */
export type HomeOperationsRowSubject =
  | {
      readonly kind: "SOURCE";
      readonly sourceId: string;
      /** The group's category as the summary projects it; null when absent. */
      readonly category: string | null;
      readonly count: number;
    }
  | { readonly kind: "PLATFORM_ADVISORY" }
  | { readonly kind: "UNRECOGNISED" };

export type HomeOperationsRowText = {
  label: string;
  whyItMatters: string;
  recommendedAction: string;
  actionLabel: string;
};

/**
 * A Home Operations row's words, from the ONE catalogue the Operations page
 * reads: the title is the source's catalogue label (the Operations group
 * title), the area its category label (the drawer's "Source"), the count the
 * Operations count phrase, the action the Operations "Open details". Nothing
 * here is keyed on a locale, and nothing renders an id: an unlabelled source
 * reads as the catalogue's unrecognised-condition label.
 */
export function operationsRowText(subject: HomeOperationsRowSubject, locale: string): HomeOperationsRowText {
  const copy = operationsCopyFor(locale);
  if (subject.kind === "PLATFORM_ADVISORY") {
    return {
      label: copy.home.platformAdvisoryTitle,
      whyItMatters: copy.home.platformAdvisoryBody,
      recommendedAction: copy.home.platformAdvisoryAction,
      actionLabel: copy.openDetails,
    };
  }
  const unrecognised = conditionSourceLabel(locale, "unregistered.condition") ?? copy.home.unrecognisedBody;
  if (subject.kind === "UNRECOGNISED") {
    return {
      label: unrecognised,
      whyItMatters: copy.home.unrecognisedBody,
      recommendedAction: copy.home.unrecognisedAction,
      actionLabel: copy.openDetails,
    };
  }
  const label = conditionSourceLabel(locale, subject.sourceId) ?? unrecognised;
  const area = subject.category ? ((copy.category as Record<string, string | undefined>)[subject.category] ?? null) : null;
  const count =
    subject.count === 1
      ? copy.resultConditionOne
      : fillOperationsCopy(copy.resultConditions, { n: formatOpsNumber(subject.count, locale) });
  return {
    label,
    whyItMatters: area ? fillOperationsCopy(copy.home.rowSummary, { area, count }) : count,
    recommendedAction: copy.openDetails,
    actionLabel: copy.openDetails,
  };
}
