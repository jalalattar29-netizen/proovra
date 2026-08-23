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

import type { IncidentCategory } from "@proovra/shared";

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
] as const;
export type RemediationActionId = (typeof REMEDIATION_ACTION_IDS)[number];

/** Which canonical permission the executor demands. */
export type RemediationPermission =
  | "operations.acknowledge"
  | "operations.resolve";

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
  permission: "operations.acknowledge",
  confirm: false,
  async: true,
  auditFamily: "ots.upgrade",
  refresh: ["queue", "summary", "detail"],
};

const REGENERATE_ARTIFACTS: RemediationAction = {
  actionId: "report.regenerate_artifacts",
  label: "Regenerate report & verification package",
  description:
    "Re-runs the artifact pipeline for this record. The report and the verification package are produced by ONE job, so this is one action; previous versions are preserved.",
  permission: "operations.resolve",
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
export type IntegrityClass = "tsa_failure" | "ots_failure";

const TSA_UNSAFE_REASON =
  "A timestamp proves a record existed at a moment. Re-contacting the authority now would mint a token whose genTime is later than the evidence it certifies, and presenting that as the record's timestamp would assert something untrue. The provider is therefore never re-contacted for finalized evidence: `tsaStatus` is written once, inside the finalize claim, and there is no TSA queue or job in the canonical registry to re-run.";

const INTEGRITY_ENTRIES: Readonly<Record<IntegrityClass, RemediationEntry>> =
  Object.freeze({
    ots_failure: {
      disposition: "DIRECT_REMEDIATION",
      action: RESUME_OTS,
      deepLink: {
        href: "/evidence",
        label: "Open evidence record",
        requiredPermission: "evidence.read",
      },
    },
    tsa_failure: {
      disposition: "NO_SAFE_REMEDIATION_AUTHORITY",
      unsafeReason: TSA_UNSAFE_REASON,
      guidance:
        "This record's timestamp could not be obtained when it was finalized, and that cannot be corrected after the fact. The record remains valid evidence; its RFC3161 timestamp is simply absent. Contact support if you need the failure investigated.",
      deepLink: {
        href: "/evidence",
        label: "Open evidence record",
        requiredPermission: "evidence.read",
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
      },
    },
    REPORT: {
      disposition: "DIRECT_REMEDIATION",
      action: REGENERATE_ARTIFACTS,
    },
    PACKAGE: {
      // The SAME action. The verification package is produced inside the
      // report job, so offering a separate "retry package" would be two
      // buttons for one pipeline — and one of them would be a lie.
      disposition: "DIRECT_REMEDIATION",
      action: REGENERATE_ARTIFACTS,
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
// RESOLUTION
// ===========================================================================

/** Parse an evidence-integrity fingerprint back into its class, or null. */
export function integrityClassOf(fingerprint: string): IntegrityClass | null {
  const colon = fingerprint.indexOf(":");
  if (colon < 1) return null;
  const head = fingerprint.slice(0, colon);
  return head === "tsa_failure" || head === "ots_failure" ? head : null;
}

/** The registry entry governing one incident. Never throws; never guesses. */
export function entryForIncident(input: {
  category: string;
  fingerprint: string;
}): RemediationEntry | null {
  if (input.category === "EVIDENCE_INTEGRITY") {
    const cls = integrityClassOf(input.fingerprint);
    if (cls) return INTEGRITY_ENTRIES[cls];
  }
  const entry = (
    CATEGORY_ENTRIES as Record<string, RemediationEntry | undefined>
  )[input.category];
  // An unregistered category offers NOTHING rather than inheriting a
  // neighbour's remediation.
  return entry ?? null;
}

export type RemediationContext = {
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
  incident: { category: string; fingerprint: string },
  ctx: RemediationContext,
): ProjectedRemediation {
  const entry = entryForIncident(incident);
  if (!entry) {
    return {
      disposition: "READ_ONLY_GUIDANCE",
      actions: [],
      deepLink: null,
      guidance: null,
      unsafeReason: null,
    };
  }

  // A resolved or suppressed condition is not remediated. Acting on one would
  // spend real work to change a record nobody is waiting on.
  const openForAction =
    ctx.incidentStatus === "OPEN" || ctx.incidentStatus === "ACKNOWLEDGED";

  const actions =
    entry.action &&
    openForAction &&
    ctx.workspaceCanMutate &&
    ctx.can(entry.action.permission)
      ? [
          {
            actionId: entry.action.actionId,
            label: entry.action.label,
            description: entry.action.description,
            confirm: entry.action.confirm,
            async: entry.action.async,
          },
        ]
      : [];

  // A destination the reader cannot open is withheld, not rendered and
  // refused.
  const deepLink =
    entry.deepLink &&
    (entry.deepLink.requiredPermission === null ||
      ctx.hasPermission(entry.deepLink.requiredPermission))
      ? entry.deepLink
      : null;

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
  return null;
}

/** Every category the table governs — for the coverage gate. */
export function registeredCategories(): ReadonlyArray<string> {
  return Object.keys(CATEGORY_ENTRIES);
}
