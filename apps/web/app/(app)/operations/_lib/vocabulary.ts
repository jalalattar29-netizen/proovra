/**
 * Operations workbench — wire value to label, tone and explanation, once.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The previous console rendered the raw enum: screaming tokens
 * (ACKNOWLEDGED, EVIDENCE_INTEGRITY) inside a badge, with the tone decided by
 * a severityTone() helper defined in the page file. Two places deciding what
 * red means is how a surface ends up calling the same condition High in one
 * column and Warning in another.
 *
 * Every mapping a component needs is here, and nothing here reads the network.
 *
 * ---------------------------------------------------------------------------
 * COLOUR IS NEVER THE CARRIER
 * ---------------------------------------------------------------------------
 * Every entry has a label. The tone is an accelerant for someone scanning a
 * long queue, never the meaning itself: remove all colour and the surface
 * still says which conditions are critical, who owns them and what state they
 * are in.
 */

import type { AppTone } from "../../../../components/app-primitives/AppStatusBadge";
import type { IncidentSla, SlaPosture } from "./types";

import type {
  IncidentCategory,
  IncidentSeverity,
  IncidentStatus,
} from "./types";

// ---------------------------------------------------------------------------
// THE ONE TONE TABLE
// ---------------------------------------------------------------------------

/**
 * Every semantic value this route paints, and the tone it wears — once.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The tone for a value used to be decided in whichever table happened to need
 * it, and the tables disagreed. The severity vocabulary painted CRITICAL red
 * and HIGH orange; the summary cards painted the Critical card ORANGE and the
 * High card RED. Same two words, opposite colours, one scroll apart. An
 * operator who learned the colour on the cards read the queue below them
 * backwards.
 *
 * The same divergence sat on the commitment axis: the SLA badge painted
 * "Overdue" red while the Overdue card painted itself blue.
 *
 * So this is not a list of preferences. It is the reason a semantic value
 * cannot change colour by moving between the cards, Grouped, All conditions,
 * the filter chips and the Inspector — every one of those reads a table below,
 * and every one of those tables reads THIS.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE COLOURS MEAN
 * ---------------------------------------------------------------------------
 * SEVERITY descends in visual strength, so a queue scanned at speed puts the
 * worst thing first: CRITICAL red, then HIGH orange, then WARNING purple.
 * Warning is deliberately the brand accent rather than amber — amber already
 * means "waiting for an owner" on this surface, and one colour cannot carry
 * two meanings in adjacent columns.
 *
 * UNRESOLVED is black because it is a TOTAL: the count of everything still
 * open, not one category within it. Spending a semantic colour on it would
 * rank it against the severities it contains.
 *
 * DUE_SOON is silver — a clock, not a caution. OVERDUE is red because a missed
 * commitment IS a failure, and it is the same red the row badge has always
 * used for it.
 *
 * OPEN and ACKNOWLEDGED keep their own colours. They are lifecycle STATES, and
 * neither of them is the Unresolved total: a status column that turned black
 * because a card above it counts a superset of it would be a third meaning for
 * one colour.
 */
export type OperationsSemantic =
  // Severity
  | "CRITICAL"
  | "HIGH"
  | "WARNING"
  | "INFO"
  // Lifecycle
  | "OPEN"
  | "ACKNOWLEDGED"
  | "RESOLVED"
  | "SUPPRESSED"
  // Aggregate
  | "UNRESOLVED"
  // Commitment
  | "OVERDUE"
  | "DUE_SOON"
  | "ON_TIME"
  | "NO_COMMITMENT"
  // Ownership
  | "OWNED_BY_ME"
  | "UNOWNED";

export const OPERATIONS_TONE: Readonly<Record<OperationsSemantic, AppTone>> =
  Object.freeze({
    CRITICAL: "red",
    HIGH: "orange",
    WARNING: "purple",
    INFO: "blue",

    OPEN: "blue",
    ACKNOWLEDGED: "indigo",
    RESOLVED: "green",
    SUPPRESSED: "slate",

    UNRESOLVED: "black",

    OVERDUE: "red",
    DUE_SOON: "silver",
    ON_TIME: "blue",
    // An absent promise is not a warning. Treating it as one would push every
    // legacy condition to the top of a queue sorted by urgency it was never
    // measured for.
    NO_COMMITMENT: "slate",

    OWNED_BY_ME: "indigo",
    UNOWNED: "amber",
  });

/**
 * Severity, ranked by visual strength.
 *
 * Stated as data so the ordering is checkable rather than implied by which
 * colours somebody happened to pick. Lower index = stronger.
 */
export const SEVERITY_TONE_STRENGTH: readonly OperationsSemantic[] =
  Object.freeze(["CRITICAL", "HIGH", "WARNING", "INFO"]);

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

export type SeverityEntry = {
  label: string;
  tone: AppTone;
  /** Ordering weight. Higher sorts first under "Most severe first". */
  rank: number;
  explanation: string;
};

export const SEVERITY_VOCABULARY: Readonly<
  Record<IncidentSeverity, SeverityEntry>
> = Object.freeze({
  CRITICAL: {
    label: "Critical",
    tone: OPERATIONS_TONE.CRITICAL,
    rank: 4,
    explanation: "Records or delivery are affected now.",
  },
  HIGH: {
    label: "High",
    tone: OPERATIONS_TONE.HIGH,
    rank: 3,
    explanation: "Needs an operator before it becomes critical.",
  },
  WARNING: {
    label: "Warning",
    tone: OPERATIONS_TONE.WARNING,
    rank: 2,
    explanation: "Worth attention; nothing is blocked yet.",
  },
  INFO: {
    label: "Info",
    tone: OPERATIONS_TONE.INFO,
    rank: 1,
    explanation: "Recorded for context, no action expected.",
  },
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type StatusEntry = {
  label: string;
  tone: AppTone;
  /** What this state MEANS. Shown in the inspector, not in every row. */
  explanation: string;
};

/**
 * The four lifecycle states, described in terms of what an operator did.
 *
 * ACKNOWLEDGED is the one worth reading twice. It records that a person has
 * SEEN this and taken it on. It explicitly does not claim the underlying
 * problem is fixed, because only the source domain can say that, and the copy
 * says so: an operations queue where "acknowledged" quietly reads as "handled"
 * is a queue that hides unfinished work.
 */
export const STATUS_VOCABULARY: Readonly<Record<IncidentStatus, StatusEntry>> =
  Object.freeze({
    OPEN: {
      label: "Open",
      tone: OPERATIONS_TONE.OPEN,
      explanation: "Nobody has taken this on yet.",
    },
    ACKNOWLEDGED: {
      label: "Acknowledged",
      tone: OPERATIONS_TONE.ACKNOWLEDGED,
      explanation:
        "An operator has seen this and taken it on. It does not mean the underlying problem is fixed.",
    },
    RESOLVED: {
      label: "Resolved",
      tone: OPERATIONS_TONE.RESOLVED,
      explanation:
        "Closed. If the same condition happens again it reopens with its history intact.",
    },
    SUPPRESSED: {
      label: "Suppressed",
      tone: OPERATIONS_TONE.SUPPRESSED,
      explanation:
        "This workspace decided to stop being told about it. Repeat occurrences are still recorded, and it resolves on its own when the source recovers.",
    },
  });

// ---------------------------------------------------------------------------
// Category: which part of the product produced the condition
// ---------------------------------------------------------------------------

/**
 * Plain-language names for the source domains.
 *
 * The enum tokens are internal vocabulary. EVIDENCE_INTEGRITY tells an
 * engineer where the writer lives and tells an investigator nothing;
 * "Evidence integrity" tells them which of their records is affected.
 */
export const CATEGORY_LABEL: Readonly<Record<IncidentCategory, string>> =
  Object.freeze({
    UPLOAD: "Capture and upload",
    REPORT: "Report generation",
    PACKAGE: "Verification packages",
    WEBHOOK: "Webhook delivery",
    COMMUNICATIONS: "Communications",
    IDENTITY_SECURITY: "Identity and access",
    GOVERNANCE: "Governance",
    STORAGE: "Storage",
    AI: "AI processing",
    INTEGRATION: "Integrations",
    DATABASE: "Database",
    WORKER: "Background processing",
    RECONCILIATION: "Reconciliation",
    EVIDENCE_INTEGRITY: "Evidence integrity",
  });

/**
 * A category the server knows and this build does not still renders.
 *
 * Falling back to a humanised token keeps the row visible and readable. The
 * alternative, filtering unknown categories out, would hide exactly the
 * conditions a newly-deployed writer produces, which is when hiding them is
 * most expensive.
 */
export function categoryLabel(raw: string): string {
  const known = (CATEGORY_LABEL as Record<string, string | undefined>)[raw];
  if (known) return known;
  const lower = raw.replace(/_/g, " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// ---------------------------------------------------------------------------
// The compact queue summary
// ---------------------------------------------------------------------------

export type QueueMetricKey =
  | "open"
  | "critical"
  | "high"
  | "warning"
  | "slaBreached"
  | "slaAtRisk"
  | "resolved"
  | "assignedToMe"
  | "unassigned";

export type QueueMetricEntry = {
  label: string;
  tone: AppTone;
  note: string;
  /**
   * Whether this metric means anything in a workspace with one operator.
   *
   * "Assigned to me" and "Unassigned" partition work between PEOPLE. With one
   * person there is nothing to partition, and rendering the pair invites the
   * sole operator to assign conditions to themselves to make a number move.
   */
  collaborative: boolean;
};

/**
 * The order the cards are read in, and the ONLY authority on how many there
 * are.
 *
 * Severity descends — Critical, High, Warning — after the Unresolved total
 * that contains them all. Nothing may assert a card COUNT against a literal:
 * a test that says "seven cards" pins a number, not a contract, and it is
 * wrong the moment a card is added on purpose.
 */
export const QUEUE_METRIC_ORDER: readonly QueueMetricKey[] = Object.freeze([
  "open",
  "critical",
  "high",
  "warning",
  "slaBreached",
  "slaAtRisk",
  "resolved",
  "assignedToMe",
  "unassigned",
]);

/**
 * REMOVED (Phase B closure): `UNATTENDED_OVERDUE_HOURS`.
 *
 * The Overdue card counted conditions open for more than a fixed 48 hours,
 * which was a SECOND authority on lateness competing with the workspace's own
 * SLA promise. A row could read BREACHED against a four-hour commitment while
 * this card called it fine, and a workspace that promised a week saw its
 * conditions called overdue on day two.
 *
 * Lateness is now counted in exactly one place — the persisted SLA cycle —
 * and the two cards below read the SAME projection the row badge does.
 */

export const QUEUE_METRIC_VOCABULARY: Readonly<
  Record<QueueMetricKey, QueueMetricEntry>
> = Object.freeze({
  open: {
    label: "Unresolved",
    // The TOTAL, so it wears the total's tone rather than competing with the
    // severities it contains.
    tone: OPERATIONS_TONE.UNRESOLVED,
    note: "Open or acknowledged.",
    collaborative: false,
  },
  critical: {
    label: "Critical",
    tone: OPERATIONS_TONE.CRITICAL,
    note: "Affecting records now.",
    collaborative: false,
  },
  high: {
    label: "High",
    tone: OPERATIONS_TONE.HIGH,
    note: "Needs an operator soon.",
    collaborative: false,
  },
  /**
   * THE THIRD SEVERITY, which the strip was missing.
   *
   * The field has been in the server summary the whole time — the same scan
   * that produces Critical and High produces it — and the strip simply did
   * not render it. So a tenant whose queue held nothing but Warning conditions
   * read a summary saying Critical 0, High 0 and concluded there was nothing
   * to look at.
   *
   * Not a new counter, not a second authority, and nothing counted in the
   * browser: the same field, from the same projection, finally shown.
   */
  warning: {
    label: "Warning",
    tone: OPERATIONS_TONE.WARNING,
    note: "Worth attention; nothing is blocked yet.",
    collaborative: false,
  },
  slaBreached: {
    label: "Overdue",
    tone: OPERATIONS_TONE.OVERDUE,
    // Names the AUTHORITY rather than a number: the promise differs per
    // workspace and, for a historical condition, differs from today's.
    note: "Past the time this workspace committed to.",
    collaborative: false,
  },
  slaAtRisk: {
    label: "Due soon",
    tone: OPERATIONS_TONE.DUE_SOON,
    note: "Approaching the committed time.",
    collaborative: false,
  },
  resolved: {
    label: "Resolved",
    tone: OPERATIONS_TONE.RESOLVED,
    note: "Closed operational conditions.",
    collaborative: false,
  },
  assignedToMe: {
    label: "Assigned to me",
    tone: OPERATIONS_TONE.OWNED_BY_ME,
    note: "You own these.",
    collaborative: true,
  },
  unassigned: {
    label: "Unassigned",
    tone: OPERATIONS_TONE.UNOWNED,
    note: "Waiting for an owner.",
    collaborative: true,
  },
});

/**
 * The summary cards deliberately OVERLAP, and the surface says so.
 *
 * One critical condition assigned to you and open for three days is counted by
 * four of these cards. Letting an operator discover that by adding the numbers
 * up and finding they exceed the queue length is how a surface loses its
 * credibility over a fact that was never a defect.
 */
export const QUEUE_METRIC_OVERLAP_NOTE =
  "A condition can be counted by more than one card. These are filters, not a breakdown.";

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

/**
 * Event-type tokens the incident authority writes, in plain language.
 *
 * Unknown types render their raw token: the history of a condition is what an
 * operator uses to decide whether to touch it, and dropping an entry this
 * build does not recognise would silently shorten that history.
 */
export const TIMELINE_EVENT_LABEL: Readonly<Record<string, string>> =
  Object.freeze({
    opened: "Opened",
    reopened: "Reopened",
    occurrence: "Happened again",
    acknowledged: "Acknowledged",
    resolved: "Resolved",
    suppressed: "Suppressed",
    assigned: "Owner changed",
  });

export function timelineEventLabel(raw: string): string {
  const known = TIMELINE_EVENT_LABEL[raw];
  if (known) return known;
  const lower = raw.replace(/[_.]/g, " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

export const SORT_VALUES = [
  "recent",
  "severity",
  "oldest",
  "occurrences",
] as const;
export type SortValue = (typeof SORT_VALUES)[number];

export const SORT_LABEL: Readonly<Record<SortValue, string>> = Object.freeze({
  recent: "Most recent activity",
  severity: "Most severe first",
  oldest: "Oldest first",
  // The same phrase the queue row and the Inspector use. "Most occurrences"
  // named nothing; this says which of the row's three numbers it sorts by.
  occurrences: "Most source observations",
});

// ---------------------------------------------------------------------------
// SLA
//
// Plain language, and deliberately about the COMMITMENT rather than about the
// acronym: an operator reading a queue needs to know whether something is
// late, not to learn a vocabulary first.
// ---------------------------------------------------------------------------

export function slaLabel(posture: SlaPosture): string {
  switch (posture) {
    case "BREACHED":
      return "Overdue";
    case "AT_RISK":
      return "Due soon";
    case "ON_TRACK":
      return "On time";
    case "ACKNOWLEDGED":
      return "Owned";
    case "RESOLVED":
      return "Resolved";
    case "UNTRACKED_LEGACY":
      // Said plainly, because "—" reads as a loading state and "N/A" reads as
      // a product gap. Neither is what happened: nobody recorded a promise.
      return "No SLA recorded";
    case "NOT_APPLICABLE":
    default:
      return "No SLA applies";
  }
}

export function slaTone(posture: SlaPosture): AppTone {
  switch (posture) {
    case "BREACHED":
      return OPERATIONS_TONE.OVERDUE;
    case "AT_RISK":
      return OPERATIONS_TONE.DUE_SOON;
    case "RESOLVED":
      return OPERATIONS_TONE.RESOLVED;
    case "ACKNOWLEDGED":
      return OPERATIONS_TONE.ACKNOWLEDGED;
    case "ON_TRACK":
      return OPERATIONS_TONE.ON_TIME;
    case "UNTRACKED_LEGACY":
    case "NOT_APPLICABLE":
    default:
      // Neutral, deliberately. An absent promise is not a warning; treating
      // it as one would push every legacy condition to the top of a queue
      // sorted by urgency it was never measured for.
      return OPERATIONS_TONE.NO_COMMITMENT;
  }
}

/**
 * What the posture MEANS, in one sentence, for the drawer.
 *
 * States the obligation and the promise, because "Overdue" alone leaves the
 * reader to guess whether the workspace promised four hours or four days.
 */
export function slaExplanation(sla: IncidentSla): string {
  const duty =
    sla.obligation === "ACKNOWLEDGEMENT"
      ? "for someone to take this on"
      : "for this to be resolved";
  const promise =
    sla.targetHours === null
      ? ""
      : ` This workspace allowed ${sla.targetHours} ${sla.targetHours === 1 ? "hour" : "hours"} ${duty}.`;

  switch (sla.posture) {
    case "BREACHED":
      return `Past the time this workspace allowed ${duty}.${promise}`;
    case "AT_RISK":
      return `Approaching the time this workspace allowed ${duty}.${promise}`;
    case "ON_TRACK":
      return `Within the time this workspace allowed ${duty}.${promise}`;
    case "ACKNOWLEDGED":
      return `Someone has taken this on and no commitment has been missed.${promise}`;
    case "RESOLVED":
      return sla.resolutionBreached
        ? "This was resolved, but after the time this workspace allowed."
        : "This was resolved within the time this workspace allowed.";
    case "UNTRACKED_LEGACY":
      // The honest sentence. Applying today's policy to a record from before
      // the policy existed would invent a deadline and then invent whether it
      // was missed.
      return "No historical SLA was recorded for this incident, so no commitment can be reported for it.";
    case "NOT_APPLICABLE":
    default:
      return "No time commitment applies to this condition.";
  }
}

/**
 * The latched record, when it differs from the posture.
 *
 * A condition can be RESOLVED and still have missed its promise, and a
 * suppressed one can carry a breach nobody should be able to erase. Returning
 * null when there is nothing extra to say keeps the drawer from repeating the
 * verdict it just rendered.
 */
export function slaBreachRecord(sla: IncidentSla): string | null {
  const missed: string[] = [];
  if (sla.acknowledgementBreached) missed.push("was not taken on in time");
  if (sla.resolutionBreached) missed.push("was not resolved in time");
  if (missed.length === 0) return null;
  if (sla.posture === "BREACHED") return null;
  return `Recorded: this condition ${missed.join(" and ")}.`;
}
