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

import type {
  IncidentCategory,
  IncidentSeverity,
  IncidentStatus,
} from "./types";

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
    tone: "red",
    rank: 4,
    explanation: "Records or delivery are affected now.",
  },
  HIGH: {
    label: "High",
    tone: "orange",
    rank: 3,
    explanation: "Needs an operator before it becomes critical.",
  },
  WARNING: {
    label: "Warning",
    tone: "amber",
    rank: 2,
    explanation: "Worth attention; nothing is blocked yet.",
  },
  INFO: {
    label: "Info",
    tone: "blue",
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
      tone: "blue",
      explanation: "Nobody has taken this on yet.",
    },
    ACKNOWLEDGED: {
      label: "Acknowledged",
      tone: "indigo",
      explanation:
        "An operator has seen this and taken it on. It does not mean the underlying problem is fixed.",
    },
    RESOLVED: {
      label: "Resolved",
      tone: "green",
      explanation:
        "Closed. If the same condition happens again it reopens with its history intact.",
    },
    SUPPRESSED: {
      label: "Suppressed",
      tone: "slate",
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
  | "overdue"
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

export const QUEUE_METRIC_ORDER: readonly QueueMetricKey[] = Object.freeze([
  "open",
  "critical",
  "high",
  "overdue",
  "assignedToMe",
  "unassigned",
]);

/**
 * Matches UNATTENDED_OVERDUE_HOURS in the canonical summary service.
 *
 * Named and exported so the copy under the card and the server threshold
 * cannot drift into saying two different numbers. This is AGE, not an SLA:
 * see the SLA note in page.tsx.
 */
export const UNATTENDED_OVERDUE_HOURS = 48;

export const QUEUE_METRIC_VOCABULARY: Readonly<
  Record<QueueMetricKey, QueueMetricEntry>
> = Object.freeze({
  open: {
    label: "Unresolved",
    tone: "blue",
    note: "Open or acknowledged.",
    collaborative: false,
  },
  critical: {
    label: "Critical",
    tone: "red",
    note: "Affecting records now.",
    collaborative: false,
  },
  high: {
    label: "High",
    tone: "orange",
    note: "Needs an operator soon.",
    collaborative: false,
  },
  overdue: {
    label: "Overdue",
    tone: "red",
    note: `Open and untouched for over ${UNATTENDED_OVERDUE_HOURS} hours.`,
    collaborative: false,
  },
  assignedToMe: {
    label: "Assigned to me",
    tone: "indigo",
    note: "You own these.",
    collaborative: true,
  },
  unassigned: {
    label: "Unassigned",
    tone: "amber",
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
  occurrences: "Most occurrences",
});
