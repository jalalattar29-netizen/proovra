/**
 * THE OPERATIONS REMEDIATION REGISTRY.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * ONE server-owned table mapping a canonical incident identity to what an
 * operator may actually DO about it. It is the only place in the product that
 * answers "is there an action here, and who may take it" — the API projects
 * from it, the executor dispatches from it, and the browser renders what the
 * projection returned.
 *
 * The alternative, which this exists to prevent, is an incident-type switch in
 * the route, a second one in the page, a third in the inspector and a fourth
 * in the tests — four copies of an authorization decision, drifting.
 *
 * ---------------------------------------------------------------------------
 * THE CLIENT IS NOT AN AUTHORITY
 * ---------------------------------------------------------------------------
 * `resolveRemediations` returns actions that are ALREADY authorized and
 * eligible for this caller, this workspace and this incident snapshot. The
 * browser never reconstructs eligibility from a label, a severity, a plan name
 * or a workspace name — it has no input that would let it.
 *
 * Executing still re-checks. A projection is a convenience; it is not a
 * permission, and a caller who posts an action id they were never offered is
 * refused by the same predicate that declined to offer it.
 *
 * ---------------------------------------------------------------------------
 * FAIL CLOSED
 * ---------------------------------------------------------------------------
 * An incident type absent from this table yields NO actions. Adding a new
 * `IncidentCategory` without adding a disposition here does not silently
 * inherit somebody else's remediation — it produces an incident an operator
 * can read and cannot act on, which is the safe direction to be wrong in.
 */

import { isPermanentOtsProofFailureReason, parseOtsBudgetExhaustedFingerprint } from "@proovra/shared";
import type { IncidentCategory } from "@proovra/shared";
import { resolveConditionSource } from "@proovra/shared-runtime";

// ===========================================================================
// VOCABULARY
// ===========================================================================

/**
 * What the product is prepared to do about a class of condition.
 *
 * Every incident type carries exactly one of these. "We have not decided" is
 * not a value — an undecided type is absent from the table and therefore
 * offers nothing.
 */
export const REMEDIATION_DISPOSITIONS = [
  /** A real, domain-authorized action exists and may be executed from here. */
  "DIRECT_REMEDIATION",
  /** The fix lives on another authorized surface; Operations links to it. */
  "SAFE_DEEP_LINK",
  /** Nothing the tenant can do. Say so plainly rather than offer a control. */
  "READ_ONLY_GUIDANCE",
  /**
   * A remediation is imaginable and CANNOT be built safely. Recorded by name
   * so the absence is a decision on the record rather than an oversight.
   */
  "NO_SAFE_REMEDIATION_AUTHORITY",
] as const;
export type RemediationDisposition =
  (typeof REMEDIATION_DISPOSITIONS)[number];

/** Stable ids. The browser posts these; they never change meaning. */
export const REMEDIATION_ACTION_IDS = [
  "ots.resume_anchoring",
  "report.regenerate_artifacts",
  "report.supersede_failed_generation",
] as const;
export type RemediationActionId = (typeof REMEDIATION_ACTION_IDS)[number];

/** Which canonical permission the executor demands. */
/**
 * WHICH PERMISSION AUTHORIZES A REMEDIATION.
 *
 * The DOMAIN's own, never a generic Operations one. This is not a preference:
 * `packages/shared/src/permissions.ts` states it as a rule, under
 * "WHAT IS DELIBERATELY ABSENT" —
 *
 *   "There is no `operations.retry`. Retrying a report, re-anchoring a record
 *    or re-sending a message is a DOMAIN action, authorized by that domain's
 *    own permission (`evidence.generate_report`, …). Operations may link to
 *    it; it does not acquire the right to perform it. A generic retry
 *    permission would be Operations quietly becoming a second authority over
 *    every domain it displays."
 *
 * Re-anchoring is named in that sentence. So the earlier mapping — OTS behind
 * `operations.acknowledge` — was wrong twice over: it used an Operations
 * permission for a domain action, and it used the WEAKEST one, so anybody who
 * could say "I've seen this" could also spend real work and change the
 * record's proof state.
 *
 * `operations.view` is still required to reach the route at all, so the
 * effective rule is: be an operator here AND hold the domain right.
 */
export type RemediationPermission =
  | "evidence.publish_verify"
  | "evidence.generate_report";

/**
 * How the caller learns what happened.
 *
 * `QUEUED` is the one that matters. Asynchronous work that reports itself as
 * completed is the single most misleading thing an operations surface can do,
 * so accepted-and-queued is a distinct terminal answer to the REQUEST even
 * though the WORK has not finished.
 */
export const REMEDIATION_RESULTS = [
  "QUEUED",
  "ALREADY_IN_PROGRESS",
  "ALREADY_SATISFIED",
  "REFUSED",
  "NOT_ELIGIBLE",
  "QUEUE_UNAVAILABLE",
  "FAILED",
] as const;
export type RemediationResult = (typeof REMEDIATION_RESULTS)[number];

/**
 * THE AUDIT OUTCOME OF A REMEDIATION ANSWER (ET-REC-07, 2026-09-29) — one
 * mapping for the workspace and the platform paths.
 *
 * They disagreed: the platform path recorded "success" for NOT_ELIGIBLE,
 * REFUSED and QUEUE_UNAVAILABLE, and the workspace path recorded
 * ALREADY_SATISFIED / ALREADY_IN_PROGRESS as "error". The result code was in
 * metadata, but the outcome column an access review filters on was wrong.
 *
 *   success — the intent is met or being met (queued, already running,
 *             already satisfied);
 *   denied  — we said no (refused, not eligible);
 *   error   — the work could not be accepted (queue unavailable, failed).
 */
export function remediationAuditOutcome(result: RemediationResult): "success" | "denied" | "error" {
  switch (result) {
    case "QUEUED":
    case "ALREADY_IN_PROGRESS":
    case "ALREADY_SATISFIED":
      return "success";
    case "REFUSED":
    case "NOT_ELIGIBLE":
      return "denied";
    case "QUEUE_UNAVAILABLE":
    case "FAILED":
      return "error";
  }
}

// ===========================================================================
// DESCRIPTORS
// ===========================================================================

export type RemediationAction = {
  actionId: RemediationActionId;
  /** Operator-facing. Never a verb the product cannot honour — see TSA. */
  label: string;
  description: string;
  permission: RemediationPermission;
  /** Confirm before executing? Reserved for actions that spend real work. */
  confirm: boolean;
  /** Asynchronous work reports QUEUED, never a completion. */
  async: boolean;
  /** The canonical audit family the executor appends under. */
  auditFamily: string;
  /**
   * An Operations capability required IN ADDITION to `operations.view` and the
   * domain permission — for actions that override a decision the pipeline
   * made (superseding an exhausted failure), not merely request work.
   */
  operatorPermission?: "operations.resolve";
  /** The operator must state why; the reason is audited. */
  requiresReason?: boolean;
  /**
   * What the browser should re-read once the request settles. The queue and
   * the summary are always refreshed; the detail carries the timeline.
   */
  refresh: ReadonlyArray<"queue" | "summary" | "detail">;
};

export type RemediationDeepLink = {
  /** In-product destination. Relative; never a platform-admin console. */
  href: string;
  label: string;
  /**
   * OPS-031 — the link names the condition's OWN record. When the condition
   * carries a related evidence id, the projection appends it (`/evidence/<id>`)
   * so the reader lands on the record, not on a library to search through.
   */
  recordScoped?: boolean;
  /**
   * The CANONICAL PERMISSION the destination requires, in the vocabulary
   * `evaluateMemberAccess` already evaluates. A capability-key gate here would
   * need a second mapping maintained beside the permission model, and the two
   * would drift.
   *
   * A link the reader cannot open is the defect this redesign removed from the
   * page header, so the projection WITHHOLDS it rather than rendering a
   * control that resolves to a refusal.
   */
  requiredPermission: string | null;
};

export type RemediationEntry = {
  disposition: RemediationDisposition;
  /** Present only for DIRECT_REMEDIATION. */
  action?: RemediationAction;
  /** A second, stronger action for the same condition (operator override). */
  secondaryAction?: RemediationAction;
  /** Present for SAFE_DEEP_LINK, and permitted alongside a direct action. */
  deepLink?: RemediationDeepLink;
  /** Shown when there is nothing to do, or nothing safe to do. */
  guidance?: string;
  /** Why no safe authority exists. Required for NO_SAFE_REMEDIATION_AUTHORITY. */
  unsafeReason?: string;
};

// ===========================================================================
// THE ACTIONS
// ===========================================================================

const RESUME_OTS: RemediationAction = {
  actionId: "ots.resume_anchoring",
  label: "Resume OTS anchoring",
  description:
    "Re-runs the OpenTimestamps upgrade for this record. Anchoring completes on Bitcoin's schedule, not ours, so this asks the pipeline to try again — it cannot make an anchor appear.",
  permission: "evidence.publish_verify",
  confirm: false,
  async: true,
  auditFamily: "ots.upgrade",
  refresh: ["queue", "summary", "detail"],
};

const REGENERATE_ARTIFACTS: RemediationAction = {
  actionId: "report.regenerate_artifacts",
  label: "Recover report or package",
  description:
    "Rebuilds exactly what is missing or failed for this record: only the verification package when the report exists (built from the stored report after its hash is verified), or the report and its package together when there is no report. Existing versions are never replaced.",
  permission: "evidence.generate_report",
  confirm: true,
  async: true,
  auditFamily: "report.generation",
  refresh: ["queue", "summary", "detail"],
};

/**
 * D3 — the ONE path out of an exhausted technical failure.
 *
 * After the retry budget is spent, the customer is told the issue was routed
 * here and is offered no button: another click would only collapse onto the
 * failed request. An operator who can resolve conditions in this workspace,
 * AND holds the domain permission, may start a NEW request identity beside the
 * failed one, stating why. It never overrides an integrity failure, a legal
 * hold, a workspace restriction or tenancy — the writer supersedes only a
 * TECHNICAL terminal, and the worker re-checks everything at claim time.
 */
const SUPERSEDE_FAILED_GENERATION: RemediationAction = {
  actionId: "report.supersede_failed_generation",
  label: "Retry after exhausted failure",
  description:
    "Automatic retries for this record's report or package were exhausted. This starts a new, audited attempt beside the failed one, which is kept as history. It does not override integrity checks, legal holds or workspace restrictions.",
  permission: "evidence.generate_report",
  operatorPermission: "operations.resolve",
  requiresReason: true,
  confirm: true,
  async: true,
  auditFamily: "report.generation",
  refresh: ["queue", "summary", "detail"],
};

// ===========================================================================
// THE TABLE
// ===========================================================================

/**
 * Evidence-integrity conditions are keyed per RECORD, and the two classes have
 * opposite dispositions — which is the clearest possible demonstration that
 * disposition is a property of the CONDITION and not of its category.
 */
/**
 * GOVERNANCE CLOSURE (2026-09-09) — the two OTS RECOVERY conditions get their
 * own guidance instead of the category fallback.
 *
 * They were never actionless: `entryForIncident` falls through to
 * `CATEGORY_ENTRIES.EVIDENCE_INTEGRITY`, so both already returned
 * READ_ONLY_GUIDANCE with a deep link. What they inherited was the GENERIC
 * sentence — "open the record to see which proof is missing" — and for these
 * two that is the wrong thing to tell an operator.
 *
 * Nothing is missing that the platform is not already repairing. A stalled
 * initialization is picked up by the scheduled lifecycle-recovery sweep; an
 * aged PENDING anchor is still inside the 30-day upgrade budget and the ladder
 * is still running. Sending someone to hunt for a missing proof invites a
 * manual "fix" for a condition that resolves itself, and the only manual fix
 * available for a timestamp would be the one thing this platform must never do.
 *
 * So both are stated as what they are: automatic, in progress, no action
 * required. Neither offers an action, because offering one would be a lie.
 */
export type IntegrityClass =
  | "tsa_failure"
  | "ots_failure"
  | "ots_pending_aged"
  | "ots_initialization_stalled";

const TSA_UNSAFE_REASON =
  "A timestamp proves a record existed at a moment. Re-contacting the authority now would mint a token whose genTime is later than the evidence it certifies, and presenting that as the record's timestamp would assert something untrue. The provider is therefore never re-contacted for finalized evidence: `tsaStatus` is written inside the finalize claim, and there is no TSA queue or job in the canonical registry to re-run. The one later writer is the operator validation CLI (repair-tsa-failed-with-token), which never contacts the provider: it only validates the token already kept, with the same validator as issuance.";

const OTS_PROOF_INVALID_GUIDANCE =
  "The recorded OpenTimestamps proof does not match this record or could not be read, so re-running anchoring cannot repair it and none is offered. The evidence, its signature and its RFC 3161 timestamp are unaffected; the record is reported without a Bitcoin anchor.";

const INTEGRITY_ENTRIES: Readonly<Record<IntegrityClass, RemediationEntry>> =
  Object.freeze({
    ots_failure: {
      disposition: "DIRECT_REMEDIATION",
      action: RESUME_OTS,
      deepLink: {
        href: "/evidence",
        label: "Open evidence record",
        requiredPermission: "evidence.read",
        recordScoped: true,
      },
    },
    ots_initialization_stalled: {
      disposition: "READ_ONLY_GUIDANCE",
      guidance:
        "OpenTimestamps initialization has not started successfully for this record. PROOVRA retries this automatically on a scheduled sweep; no manual timestamp creation is required and none is offered. The evidence, its signature and its RFC 3161 timestamp are unaffected.",
      deepLink: {
        href: "/evidence",
        label: "Open evidence record",
        requiredPermission: "evidence.read",
        recordScoped: true,
      },
    },
    ots_pending_aged: {
      disposition: "READ_ONLY_GUIDANCE",
      guidance:
        "OpenTimestamps anchoring is taking longer than expected. Bitcoin anchoring is inherently slow and the upgrade ladder is still running inside its budget, so this resolves on its own. No manual action is available and none is required.",
      deepLink: {
        href: "/evidence",
        label: "Open evidence record",
        requiredPermission: "evidence.read",
        recordScoped: true,
      },
    },
    tsa_failure: {
      disposition: "NO_SAFE_REMEDIATION_AUTHORITY",
      unsafeReason: TSA_UNSAFE_REASON,
      guidance:
        // Evidence-output incident (2026-10-05): the old copy said the timestamp
        // "could not be obtained" and "cannot be corrected" for EVERY failure.
        // When the authority answered and only validation failed (e.g. no trust
        // anchor configured), the reply is kept and the operator CLI can validate
        // that kept token once trust is configured — still never re-contacting
        // the authority. Both cases are stated; neither is promised away.
        "This record's RFC 3161 timestamp was not validated when it was finalized, so it is not presented as a trusted timestamp. The timestamp authority is never contacted again for a finalized record. If the authority's reply was kept and only its validation failed (for example, no trust anchor was configured), an operator can validate that kept reply once timestamp trust is configured. If no reply was received, a timestamp cannot be added after the fact. The record remains valid evidence either way.",
      deepLink: {
        href: "/evidence",
        label: "Open evidence record",
        requiredPermission: "evidence.read",
        recordScoped: true,
      },
    },
  });

/**
 * Category-level dispositions.
 *
 * TOTAL over `IncidentCategory`: TypeScript will not compile a new category
 * into the enum without an entry here, which is what makes "fail closed" a
 * property of the build rather than of somebody remembering.
 */
const CATEGORY_ENTRIES: Readonly<Record<IncidentCategory, RemediationEntry>> =
  Object.freeze({
    EVIDENCE_INTEGRITY: {
      // Overridden per integrity class above; this is the fallback for an
      // integrity condition whose fingerprint we cannot parse.
      disposition: "READ_ONLY_GUIDANCE",
      guidance:
        "This record has an unresolved integrity condition. Open the record to see which proof is missing.",
      deepLink: {
        href: "/evidence",
        label: "Open evidence record",
        requiredPermission: "evidence.read",
        recordScoped: true,
      },
    },
    REPORT: {
      disposition: "DIRECT_REMEDIATION",
      action: REGENERATE_ARTIFACTS,
      secondaryAction: SUPERSEDE_FAILED_GENERATION,
    },
    PACKAGE: {
      // The SAME action: the server decides what the record needs (the
      // package alone beside an existing report), so there is still one
      // recovery button, and it never mints a report to get a package.
      disposition: "DIRECT_REMEDIATION",
      action: REGENERATE_ARTIFACTS,
      secondaryAction: SUPERSEDE_FAILED_GENERATION,
    },
    UPLOAD: {
      disposition: "SAFE_DEEP_LINK",
      deepLink: {
        href: "/evidence",
        label: "Open evidence library",
        requiredPermission: "evidence.read",
      },
      guidance: "A capture or upload did not complete. Re-capture from the record.",
    },
    WEBHOOK: {
      disposition: "SAFE_DEEP_LINK",
      deepLink: {
        href: "/integrations",
        label: "Open integrations",
        requiredPermission: "integration.webhook.manage",
      },
      guidance:
        "A webhook delivery failed. The integrations surface owns delivery history and its own retry.",
    },
    INTEGRATION: {
      disposition: "SAFE_DEEP_LINK",
      deepLink: {
        href: "/integrations",
        label: "Open integrations",
        requiredPermission: "integration.webhook.manage",
      },
      guidance: "An integration reported a failure. Its own surface owns the retry.",
    },
    COMMUNICATIONS: {
      disposition: "SAFE_DEEP_LINK",
      deepLink: {
        href: "/communications",
        label: "Open communications",
        requiredPermission: null,
      },
      guidance: "A message could not be delivered. Delivery history lives with the message.",
    },
    GOVERNANCE: {
      disposition: "SAFE_DEEP_LINK",
      deepLink: {
        href: "/governance",
        label: "Open governance",
        requiredPermission: "governance.policy.read",
      },
      guidance: "A governance condition needs review on the governance surface.",
    },
    IDENTITY_SECURITY: {
      // Security Center is the canonical authority for these. Operations
      // SHOWS the condition and never adjudicates it — two surfaces deciding
      // one security posture is worse than one surface being incomplete.
      disposition: "SAFE_DEEP_LINK",
      deepLink: {
        href: "/security-center",
        label: "Open Security Center",
        requiredPermission: "audit.read",
      },
      guidance:
        "Security Center owns this condition. Operations shows it so the workspace's unresolved work is in one place.",
    },
    STORAGE: {
      disposition: "READ_ONLY_GUIDANCE",
      guidance:
        "Storage reported a fault. This is platform infrastructure — no workspace action will change it, and it is being handled by the platform.",
    },
    DATABASE: {
      disposition: "READ_ONLY_GUIDANCE",
      guidance:
        "A database fault was recorded. This is platform infrastructure and needs no workspace action.",
    },
    WORKER: {
      disposition: "READ_ONLY_GUIDANCE",
      guidance:
        "Background processing reported a fault. The platform owns the queue; the affected records recover when it does.",
    },
    AI: {
      disposition: "READ_ONLY_GUIDANCE",
      guidance:
        "An AI-assisted step did not complete. Nothing evidential depends on it, and the record is unaffected.",
    },
    RECONCILIATION: {
      disposition: "READ_ONLY_GUIDANCE",
      guidance:
        "A reconciliation sweep reported a discrepancy. It re-runs on its own schedule.",
    },
  });

// ===========================================================================
// SOURCE-KEYED ENTRIES (OPS-031)
// ===========================================================================

const EVIDENCE_RECORD_LINK: RemediationDeepLink = {
  href: "/evidence",
  label: "Open evidence record",
  requiredPermission: "evidence.read",
  recordScoped: true,
};

/**
 * OPS-031 — GUIDANCE BELONGS TO THE SOURCE, NOT TO ITS CATEGORY.
 *
 * Twenty-odd sources write fourteen categories, and the category table above
 * told each of them its NEIGHBOUR's story: a personal storage add-on that is
 * still billing was "platform infrastructure — no workspace action will change
 * it" (category STORAGE); a review backlog was "background processing reported
 * a fault" (category WORKER); a report backlog with no record offered a
 * per-record Recover button the executor then refused; an intake link that
 * never reached its recipient told the operator to "re-capture from the
 * record". Each entry here names the surface that OWNS the source and what
 * closes the condition. The category table remains only as the fallback for a
 * source with no entry, and the coverage test pins which sources fall back.
 */
const SOURCE_ENTRIES: Readonly<Record<string, RemediationEntry>> = Object.freeze({
  "billing.dependent_cancellation_failed": {
    disposition: "SAFE_DEEP_LINK",
    deepLink: { href: "/billing", label: "Open Billing", requiredPermission: "billing.manage" },
    guidance:
      "Billing owns this. The payment provider has not yet confirmed that this storage add-on is stopped. PROOVRA retries automatically; from Billing, the account holder who pays for the add-on can retry now or contact support. This closes on its own when the provider confirms the add-on is stopped — it cannot be closed by hand while the add-on may still be charging.",
  },
  "pipeline.report_generation_failed": {
    disposition: "DIRECT_REMEDIATION",
    action: REGENERATE_ARTIFACTS,
    secondaryAction: SUPERSEDE_FAILED_GENERATION,
    deepLink: EVIDENCE_RECORD_LINK,
  },
  "pipeline.package_generation_failed": {
    disposition: "DIRECT_REMEDIATION",
    action: REGENERATE_ARTIFACTS,
    secondaryAction: SUPERSEDE_FAILED_GENERATION,
    deepLink: EVIDENCE_RECORD_LINK,
  },
  "pipeline.package_generation_denied": {
    disposition: "SAFE_DEEP_LINK",
    deepLink: EVIDENCE_RECORD_LINK,
    guidance:
      "This record's governance (for example a legal hold, a destruction review or unresolved storage drift) does not allow a verification package to be built. The record's governance panel shows which. This closes when the record becomes eligible or a package exists.",
  },
  "pipeline.report_backlog": {
    disposition: "READ_ONLY_GUIDANCE",
    deepLink: { href: "/evidence", label: "Open evidence library", requiredPermission: "evidence.read" },
    guidance:
      "More reports are waiting to be generated than the backlog threshold. They are processed in order; this closes when the waiting count falls below the threshold.",
  },
  "pipeline.package_backlog": {
    disposition: "READ_ONLY_GUIDANCE",
    deepLink: { href: "/evidence", label: "Open evidence library", requiredPermission: "evidence.read" },
    guidance:
      "More verification packages are waiting to be built than the backlog threshold. They are processed in order; this closes when the waiting count falls below the threshold.",
  },
  "pipeline.signed_without_report_aged": {
    disposition: "SAFE_DEEP_LINK",
    deepLink: { href: "/evidence", label: "Open evidence library", requiredPermission: "evidence.read" },
    guidance:
      "Signed records have gone longer than expected without a report. Generate their reports from the records; this closes when the count falls below the threshold.",
  },
  "review.stale_workflows": {
    disposition: "SAFE_DEEP_LINK",
    deepLink: { href: "/review", label: "Open Review", requiredPermission: "review.decide" },
    guidance:
      "Reviews have been waiting longer than the review window. Assign or complete them in Review; this closes when the waiting count falls below the threshold.",
  },
  "review.escalation": {
    disposition: "SAFE_DEEP_LINK",
    deepLink: { href: "/review", label: "Open Review", requiredPermission: "review.decide" },
    guidance: "A review was escalated. This closes when the escalated review is completed.",
  },
  "coordination.backlog_stale": {
    disposition: "READ_ONLY_GUIDANCE",
    guidance:
      "Comments and annotations have stayed unresolved longer than the coordination window. Resolve them on their records and cases; this closes when the unresolved count falls below the threshold.",
  },
  "storage.immutable_drift": {
    disposition: "SAFE_DEEP_LINK",
    deepLink: EVIDENCE_RECORD_LINK,
    guidance:
      "The immutable-storage protection on this record's stored object did not match its retention or legal-hold state at the last reconciliation. The platform reconciler re-checks it; this closes when a reconciliation finds the protection in place. Packages for the record are withheld until then.",
  },
  "identity.idp_outage": {
    disposition: "SAFE_DEEP_LINK",
    deepLink: { href: "/security-center/sso/health", label: "Open SSO health", requiredPermission: "identity.sso.read" },
    guidance:
      "Sign-ins through this identity provider have been failing. This closes on the first successful sign-in through it.",
  },
  "intake.delivery_failed": {
    disposition: "SAFE_DEEP_LINK",
    deepLink: { href: "/intake-links", label: "Open intake links", requiredPermission: null },
    guidance:
      "An intake link could not be delivered to its recipient. Resend it or copy the link from Intake links.",
  },
  "security.unclassified_signal": {
    disposition: "SAFE_DEEP_LINK",
    deepLink: { href: "/security-center", label: "Open Security Center", requiredPermission: "audit.read" },
    guidance:
      "A security signal that matched no known pattern was kept for a person to review. Security Center owns it.",
  },
  "search.indexing_failure": {
    disposition: "READ_ONLY_GUIDANCE",
    guidance:
      "Search indexing for this workspace is failing or behind. Records are unaffected; search results may be incomplete until indexing catches up, which the platform retries automatically.",
  },
});

/** Every source with its own entry — for the coverage gate. */
export function sourceKeyedRemediationIds(): ReadonlyArray<string> {
  return Object.keys(SOURCE_ENTRIES);
}

// ===========================================================================
// RESOLUTION
// ===========================================================================

/** Parse an evidence-integrity fingerprint back into its class, or null. */
export function integrityClassOf(fingerprint: string): IntegrityClass | null {
  const colon = fingerprint.indexOf(":");
  if (colon < 1) return null;
  const head = fingerprint.slice(0, colon);
  return head === "tsa_failure" ||
    head === "ots_failure" ||
    head === "ots_pending_aged" ||
    head === "ots_initialization_stalled"
    ? head
    : null;
}

/** The registry entry governing one incident. Never throws; never guesses. */
export function entryForIncident(input: {
  /** OPS-031 — the declared source; resolved from the fingerprint when absent. */
  sourceId?: string | null;
  category: string;
  fingerprint: string;
}): RemediationEntry | null {
  if (input.category === "EVIDENCE_INTEGRITY") {
    const cls = integrityClassOf(input.fingerprint);
    if (cls) return INTEGRITY_ENTRIES[cls];
  }
  // ET-REC-02 — the Worker's OTS budget-exhausted bridge is category WORKER,
  // whose generic guidance says records "recover when it does" — false for a
  // terminal state. It is an OTS failure of one record, and gets that entry.
  if (parseOtsBudgetExhaustedFingerprint(input.fingerprint)) return INTEGRITY_ENTRIES.ots_failure;
  // The SOURCE, by its declared id or — for a row written before the column
  // existed — by the same fingerprint resolution the lifecycle uses.
  const resolved = resolveConditionSource({
    sourceId: input.sourceId ?? null,
    category: input.category,
    fingerprint: input.fingerprint,
  });
  if (resolved.match !== "UNREGISTERED") {
    const bySource = SOURCE_ENTRIES[resolved.lifecycle.sourceId];
    if (bySource) return bySource;
  }
  const entry = (
    CATEGORY_ENTRIES as Record<string, RemediationEntry | undefined>
  )[input.category];
  // An unregistered category offers NOTHING rather than inheriting a
  // neighbour's remediation.
  return entry ?? null;
}

export type RemediationContext = {
  /**
   * ET-REC-06 — facts about the affected record the static entry cannot
   * know. A permanently invalid OTS proof (PROOF_HASH_MISMATCH /
   * MALFORMED_PROOF) is never offered "Resume OTS anchoring".
   */
  record?: { otsStatus: string | null; otsFailureReason: string | null } | null;
  /** Server-resolved permissions for THIS caller in THIS workspace. */
  can: (permission: RemediationPermission) => boolean;
/** Server-resolved permission check for deep-link destinations. */
  hasPermission: (permission: string) => boolean;
  /** False for a suspended or otherwise non-operational workspace. */
  workspaceCanMutate: boolean;
  /** Incident lifecycle: a closed condition is not remediated. */
  incidentStatus: string;
};

export type ProjectedRemediation = {
  disposition: RemediationDisposition;
  actions: ReadonlyArray<{
    actionId: RemediationActionId;
    label: string;
    description: string;
    confirm: boolean;
    async: boolean;
    /** The operator must enter a reason before submitting. */
    requiresReason: boolean;
  }>;
  deepLink: RemediationDeepLink | null;
  guidance: string | null;
  unsafeReason: string | null;
};

/**
 * What this caller may see and do about this incident, right now.
 *
 * Every branch that removes an action removes it from the PROJECTION — the
 * browser is never handed a disabled control and asked not to press it.
 */
export function resolveRemediations(
  incident: {
    category: string;
    fingerprint: string;
    sourceId?: string | null;
    /** OPS-031 — a record-scoped link names this record. */
    relatedEvidenceId?: string | null;
  },
  ctx: RemediationContext,
): ProjectedRemediation {
  const entry = entryForIncident(incident);
  // The destination, made specific to this condition and withheld when the
  // reader cannot open it — a link that resolves to a refusal is not offered.
  const linkFor = (link: RemediationDeepLink | undefined): RemediationDeepLink | null => {
    if (!link) return null;
    if (link.requiredPermission !== null && !ctx.hasPermission(link.requiredPermission)) return null;
    const recordId = incident.relatedEvidenceId ?? null;
    return link.recordScoped && recordId && /^[0-9a-f-]{36}$/i.test(recordId)
      ? { ...link, href: `${link.href}/${recordId}` }
      : link;
  };
  if (!entry) {
    return {
      disposition: "READ_ONLY_GUIDANCE",
      actions: [],
      deepLink: null,
      guidance: null,
      unsafeReason: null,
    };
  }

  if (
    entry.action?.actionId === RESUME_OTS.actionId &&
    ctx.record?.otsStatus === "FAILED" &&
    isPermanentOtsProofFailureReason(ctx.record.otsFailureReason)
  ) {
    return {
      disposition: "READ_ONLY_GUIDANCE",
      actions: [],
      deepLink: linkFor(entry.deepLink),
      guidance: OTS_PROOF_INVALID_GUIDANCE,
      unsafeReason: null,
    };
  }

  // A resolved or suppressed condition is not remediated. Acting on one would
  // spend real work to change a record nobody is waiting on.
  const openForAction =
    ctx.incidentStatus === "OPEN" || ctx.incidentStatus === "ACKNOWLEDGED";

  const offered = (a: RemediationAction | undefined) =>
    a &&
    openForAction &&
    ctx.workspaceCanMutate &&
    ctx.can(a.permission) &&
    (!a.operatorPermission || ctx.hasPermission(a.operatorPermission))
      ? [
          {
            actionId: a.actionId,
            label: a.label,
            description: a.description,
            confirm: a.confirm,
            async: a.async,
            requiresReason: a.requiresReason === true,
          },
        ]
      : [];
  const actions = [...offered(entry.action), ...offered(entry.secondaryAction)];

  // A destination the reader cannot open is withheld, not rendered and
  // refused.
  const deepLink = linkFor(entry.deepLink);

  return {
    disposition: entry.disposition,
    actions,
    deepLink,
    guidance: entry.guidance ?? null,
    unsafeReason: entry.unsafeReason ?? null,
  };
}

/** The action descriptor for an id the caller posted. Null if unregistered. */
export function actionById(id: string): RemediationAction | null {
  if (id === RESUME_OTS.actionId) return RESUME_OTS;
  if (id === REGENERATE_ARTIFACTS.actionId) return REGENERATE_ARTIFACTS;
  if (id === SUPERSEDE_FAILED_GENERATION.actionId) return SUPERSEDE_FAILED_GENERATION;
  return null;
}

/** Every category the table governs — for the coverage gate. */
export function registeredCategories(): ReadonlyArray<string> {
  return Object.keys(CATEGORY_ENTRIES);
}

// ===========================================================================
// WHO MAY DECLARE A CONDITION RESOLVED — NOT HERE, AND NOT BY CATEGORY
// ===========================================================================

/**
 * THIS FILE NO LONGER ANSWERS THAT QUESTION, AND THAT IS THE CORRECTION.
 *
 * `OPERATOR_RESOLUTION_AUTHORITY` used to live here: a `Record` keyed by
 * `IncidentCategory` deciding whether an operator could declare a condition
 * over. It was total over the enum, which made it look complete, and it was
 * wrong in a way totality could not catch — there are fourteen categories and
 * twenty-two SOURCES, four of which write category WORKER and three of which
 * write REPORT. A rule stated per category was a rule about a set nobody had
 * enumerated.
 *
 * What it cost: `pipeline.report_backlog` inherited
 * `REPORT -> OPERATOR_MAY_RESOLVE` and an operator could close
 * "Report backlog above threshold (26)" while all twenty-six records were
 * still above the threshold.
 *
 * Resolution authority is now declared per SOURCE in
 * `@proovra/shared-runtime`'s `OPERATIONS_SOURCE_LIFECYCLES` and resolved for
 * a condition by `resolveConditionSource`, which reads the FINGERPRINT first.
 * There is no compatibility shim here: a derived export would be a second name
 * for the authority and therefore a second thing to keep in step.
 *
 * What this file still owns is unchanged and deliberately separate:
 * `disposition` says what an operator may DO about a condition. The two come
 * apart in both directions — the report backlog has a real remediation AND is
 * source-truth; a TSA failure has no safe remediation AND is source-truth —
 * and reading one as the other is the conflation the closure removed.
 */
export const RESOLUTION_AUTHORITY_OWNER =
  "@proovra/shared-runtime -> OPERATIONS_SOURCE_LIFECYCLES" as const;
