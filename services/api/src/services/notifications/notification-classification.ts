/**
 * CANONICAL NOTIFICATION CLASSIFICATION (Attention Architecture, Phase 1).
 *
 * WHAT THIS TABLE IS FOR
 * ----------------------
 * One domain event can legitimately produce more than one thing. A TSA
 * anchoring failure is BOTH a message the record's owner should see AND
 * unresolved work the workspace has to deal with. Before this table, those two
 * outcomes were the same row in one list, which is why archiving a
 * notification could plausibly be read as "the work is done".
 *
 *   DOMAIN EVENT
 *         |
 *         +-- personal notification         (per-user, archivable)
 *         |
 *         +-- shared operational condition  (per-workspace, adjudicated)
 *
 * Those are SEPARATE PROJECTIONS of the same event, and this module is the
 * single place that says which projections a category produces.
 *
 * THE CHANNELS
 * ------------
 *   N  notification            personal awareness; belongs in the feed
 *   O  operational condition   shared unresolved work; belongs in Operations
 *   T  assigned task           addressed to a specific person to act on
 *   G  guidance                onboarding / getting-started; belongs to Home
 *   S  security-specialized    a security decision; Security Center owns it
 *
 * `H` in the audit ("hybrid") is not a channel — it is what you call a
 * category that emits BOTH N and O. Encoding it as a flag would have created a
 * fourth vocabulary; encoding it as "two channels" is the same information
 * with no new concept.
 *
 * WHAT THIS TABLE DELIBERATELY DOES NOT DO
 * ----------------------------------------
 * It does not force every O/H category into `OperationalIncident`. Several
 * domains already own a lifecycle for their own work — reviewer escalation
 * has a review workflow, intake has EvidenceRequest statuses, access review
 * has its own decision record. Giving one truth two competing state machines
 * is precisely the invariant this program forbids. So each category names its
 * CONDITION AUTHORITY: the system that already owns "is this resolved?".
 * Operations may PROJECT that authority; it never replaces it.
 */

/** The five channels a domain event can be projected onto. */
export type AttentionChannel =
  | "notification"
  | "operational_condition"
  | "assigned_task"
  | "guidance"
  | "security_specialized";

/**
 * Who owns the answer to "is this resolved?".
 *
 * `operations` means `OperationalIncident` is the lifecycle authority.
 * Everything else names a domain that already had one before Operations
 * existed, and keeps it.
 */
export type ConditionAuthority =
  | "operations"
  | "evidence"
  | "review"
  | "intake"
  | "identity_security"
  | "communications"
  | "governance"
  | "collaboration"
  | "organization"
  /** No shared condition at all — this category is purely personal. */
  | "none";

export type NotificationClassification = {
  channels: readonly AttentionChannel[];
  /**
   * The system that owns lifecycle truth for the shared condition, when this
   * category produces one. `none` when it does not.
   */
  conditionAuthority: ConditionAuthority;
  /**
   * Which workspace/account tier the notification is addressed at. Phase 2
   * consumes this; it is declared here because scope is a property of the
   * category, not of the request that happens to read it.
   */
  scope: "ACCOUNT" | "WORKSPACE" | "ORGANIZATION";
  /** One line, for the register and for anyone reading the table cold. */
  rationale: string;
};

/**
 * THE AUDITED CLASSIFICATION, encoded.
 *
 * Keys are `InboxCategory` values verbatim. The suite asserts this map is
 * TOTAL over that union, so adding a category without classifying it is a red
 * test rather than a silent default.
 */
export const NOTIFICATION_CLASSIFICATION = {
  // ---------------------------------------------------------------- G
  onboarding: {
    channels: ["guidance"],
    conditionAuthority: "none",
    scope: "WORKSPACE",
    rationale:
      "Getting-started guidance. Nothing happened and nobody is waiting; " +
      "rendering it as attention manufactures a workload out of an empty " +
      "workspace. Home owns it.",
  },

  // ---------------------------------------------------------------- N/T
  org_invite: {
    channels: ["notification", "assigned_task"],
    conditionAuthority: "organization",
    scope: "ORGANIZATION",
    rationale:
      "Addressed to one person by email, and only that person can accept. " +
      "Account-tier delivery with organization context.",
  },

  // ---------------------------------------------------------------- O
  org_admin: {
    channels: ["operational_condition"],
    conditionAuthority: "organization",
    scope: "ORGANIZATION",
    rationale:
      "Pending-invite rollup for org admins. Shared administrative backlog " +
      "— any admin clearing it clears it for all of them.",
  },

  // ---------------------------------------------------------------- H
  governance: {
    channels: ["notification", "operational_condition"],
    conditionAuthority: "governance",
    scope: "WORKSPACE",
    rationale:
      "Retention / legal-hold / destruction events are both a thing admins " +
      "should know and shared governance work. GovernanceNotification keeps " +
      "lifecycle truth.",
  },

  // ---------------------------------------------------------------- O/T
  review_decision: {
    channels: ["notification", "operational_condition", "assigned_task"],
    conditionAuthority: "review",
    scope: "WORKSPACE",
    rationale:
      "Conflict adjudication is shared work with a named adjudicator; " +
      "awaiting-second is awareness. The review workflow owns resolution.",
  },

  // ---------------------------------------------------------------- N
  discussion_mention: {
    channels: ["notification"],
    conditionAuthority: "none",
    scope: "WORKSPACE",
    rationale:
      "Somebody said your name. Purely personal — a second admin has no " +
      "stake in your mention.",
  },

  // ---------------------------------------------------------------- T + N
  discussion_assigned: {
    channels: ["notification", "assigned_task"],
    conditionAuthority: "collaboration",
    scope: "WORKSPACE",
    rationale:
      "A thread was assigned to you specifically. Task for you, notification " +
      "to you; the thread owns its own assignment state.",
  },

  // ---------------------------------------------------------------- H
  review_escalation: {
    channels: ["notification", "operational_condition", "assigned_task"],
    conditionAuthority: "review",
    scope: "WORKSPACE",
    rationale:
      "An escalation is shared unresolved review work AND a message to the " +
      "escalation target. ReviewEscalation owns resolution.",
  },

  // ---------------------------------------------------------------- S/T
  access_review_pending: {
    channels: ["security_specialized", "assigned_task"],
    conditionAuthority: "identity_security",
    scope: "WORKSPACE",
    rationale:
      "An access decision. Security Center owns the decision surface; " +
      "Operations may link to it and must not adjudicate it.",
  },

  // ---------------------------------------------------------------- S
  mfa_recovery_pending: {
    channels: ["security_specialized"],
    conditionAuthority: "identity_security",
    scope: "WORKSPACE",
    rationale:
      "Identity recovery approval. A security-specialized decision, never a " +
      "generic operational ticket.",
  },

  // ---------------------------------------------------------------- O/H
  communication_failure: {
    channels: ["notification", "operational_condition"],
    conditionAuthority: "communications",
    scope: "WORKSPACE",
    rationale:
      "A message did not reach a recipient. Shared operational failure with " +
      "a real retry path; CommunicationMessage owns delivery truth.",
  },

  // ---------------------------------------------------------------- N/S
  security_event_high: {
    channels: ["notification", "security_specialized"],
    conditionAuthority: "identity_security",
    scope: "ACCOUNT",
    rationale:
      "HIGH-severity events for the caller's own account. Personal by " +
      "construction — cross-user inspection is the Security Center.",
  },

  // ---------------------------------------------------------------- H
  report_failure: {
    channels: ["notification", "operational_condition"],
    conditionAuthority: "operations",
    scope: "WORKSPACE",
    rationale:
      "Already an OperationalIncident. Operations is the lifecycle authority; " +
      "the notification is a projection of it.",
  },

  // ---------------------------------------------------------------- H
  verification_package_failure: {
    channels: ["notification", "operational_condition"],
    conditionAuthority: "operations",
    scope: "WORKSPACE",
    rationale:
      "Already an OperationalIncident. Same relationship as report_failure.",
  },

  // ---------------------------------------------------------------- H
  ots_failure: {
    channels: ["notification", "operational_condition"],
    conditionAuthority: "evidence",
    scope: "WORKSPACE",
    rationale:
      "Per-Evidence anchoring failure. Evidence.otsStatus is the resolution " +
      "authority; the operational condition tracks it and never overrides it.",
  },

  // ---------------------------------------------------------------- H
  tsa_failure: {
    channels: ["notification", "operational_condition"],
    conditionAuthority: "evidence",
    scope: "WORKSPACE",
    rationale:
      "Per-Evidence timestamping failure. Evidence.tsaStatus is the " +
      "resolution authority; the operational condition tracks it.",
  },

  // ---------------------------------------------------------------- O/T
  intake_submission_pending_review: {
    channels: ["operational_condition", "assigned_task"],
    conditionAuthority: "intake",
    scope: "WORKSPACE",
    rationale:
      "An unclaimed submission is shared work until somebody claims it, at " +
      "which point it is that person's task. EvidenceRequest owns status.",
  },

  // ---------------------------------------------------------------- O
  intake_required_items_missing: {
    channels: ["operational_condition"],
    conditionAuthority: "intake",
    scope: "WORKSPACE",
    rationale:
      "The submission is incomplete and the workspace has to chase it. " +
      "Shared; no single addressee.",
  },

  // ---------------------------------------------------------------- O
  intake_link_expiring: {
    channels: ["operational_condition"],
    conditionAuthority: "intake",
    scope: "WORKSPACE",
    rationale:
      "A shared deadline on a shared artifact. Renewing or revoking is an " +
      "admin action anybody with the capability can take.",
  },

  // ---------------------------------------------------------------- N
  collaboration: {
    channels: ["notification"],
    conditionAuthority: "collaboration",
    scope: "WORKSPACE",
    rationale:
      "CollaborationTeamNotification rows are addressed to one user and " +
      "carry their own readAt. Purely personal.",
  },

  // ---------------------------------------------------------------- T + N
  case_assignment: {
    channels: ["notification", "assigned_task"],
    conditionAuthority: "collaboration",
    scope: "WORKSPACE",
    rationale:
      "A real CaseAssignment addressed to the caller. Task plus notification; " +
      "CaseAssignment.status owns the lifecycle.",
  },
} as const satisfies Record<string, NotificationClassification>;

export type ClassifiedCategory = keyof typeof NOTIFICATION_CLASSIFICATION;

export function classifyCategory(
  category: string,
): NotificationClassification | null {
  return (
    (NOTIFICATION_CLASSIFICATION as Record<
      string,
      NotificationClassification | undefined
    >)[category] ?? null
  );
}

function hasChannel(category: string, channel: AttentionChannel): boolean {
  return classifyCategory(category)?.channels.includes(channel) ?? false;
}

/** Does this category belong in the personal notification feed? */
export function producesPersonalNotification(category: string): boolean {
  return (
    hasChannel(category, "notification") ||
    hasChannel(category, "assigned_task") ||
    hasChannel(category, "security_specialized")
  );
}

/** Does this category produce shared unresolved work? */
export function producesOperationalCondition(category: string): boolean {
  return hasChannel(category, "operational_condition");
}

/** Is this category a Security-owned decision rather than generic ops work? */
export function isSecuritySpecialized(category: string): boolean {
  return hasChannel(category, "security_specialized");
}

/**
 * Is this pure guidance?
 *
 * PHASE 1.6 — guidance is REMOVED from the conceptual Notifications /
 * Operations workload. "Nothing needs doing, here is how to start" rendered as
 * attention is the fastest way to teach an operator that the attention surface
 * lies to them.
 */
export function isGuidance(category: string): boolean {
  const classification = classifyCategory(category);
  if (!classification) return false;
  return (
    classification.channels.length === 1 &&
    classification.channels[0] === "guidance"
  );
}

/**
 * The population that counts as WORKLOAD — the thing an operator is on the
 * hook for. Guidance is excluded, permanently and by name.
 */
export function countsAsWorkload(category: string): boolean {
  if (isGuidance(category)) return false;
  return (
    producesOperationalCondition(category) ||
    hasChannel(category, "assigned_task") ||
    hasChannel(category, "security_specialized")
  );
}

/** Declared addressing scope for the category. */
export function scopeForCategory(
  category: string,
): "ACCOUNT" | "WORKSPACE" | "ORGANIZATION" {
  return classifyCategory(category)?.scope ?? "WORKSPACE";
}
