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

import { operationsDict, type OperationsCopy } from "@proovra/shared/i18n";

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

    // Overdue is a TIMING fact, not a failure: the work is late against a
    // promise this workspace made, and nothing has broken. Blue is the
    // informational tone. Changed HERE rather than on the card, because this
    // table is the only reason the SLA badge and the Overdue card agree — the
    // header above records what happened last time they did not.
    OVERDUE: "blue",
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

/**
 * D10 (2026-10-12) — the WORDS come from the shared dictionary; this module
 * owns only tone and rank. `severityVocabulary(copy)` is the localized table
 * every component reads; the constant below is its English instance, kept for
 * the non-React callers and the tests that pin the English vocabulary.
 */
const SEVERITY_RANK: Readonly<Record<IncidentSeverity, number>> = Object.freeze({
  CRITICAL: 4,
  HIGH: 3,
  WARNING: 2,
  INFO: 1,
});

export function severityVocabulary(
  copy: OperationsCopy = operationsDict.en,
): Readonly<Record<IncidentSeverity, SeverityEntry>> {
  const entry = (k: IncidentSeverity): SeverityEntry => ({
    label: copy.severity[k].label,
    tone: OPERATIONS_TONE[k],
    rank: SEVERITY_RANK[k],
    explanation: copy.severity[k].explanation,
  });
  return {
    CRITICAL: entry("CRITICAL"),
    HIGH: entry("HIGH"),
    WARNING: entry("WARNING"),
    INFO: entry("INFO"),
  };
}

export const SEVERITY_VOCABULARY: Readonly<
  Record<IncidentSeverity, SeverityEntry>
> = Object.freeze(severityVocabulary());

/** One severity entry, falling back to Info for a value this build does not know. */
export function severityEntry(raw: string, copy: OperationsCopy = operationsDict.en): SeverityEntry {
  const table = severityVocabulary(copy);
  return (table as Record<string, SeverityEntry | undefined>)[raw] ?? table.INFO;
}

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
export function statusVocabulary(
  copy: OperationsCopy = operationsDict.en,
): Readonly<Record<IncidentStatus, StatusEntry>> {
  const entry = (k: IncidentStatus): StatusEntry => ({
    label: copy.status[k].label,
    tone: OPERATIONS_TONE[k],
    explanation: copy.status[k].explanation,
  });
  return {
    OPEN: entry("OPEN"),
    ACKNOWLEDGED: entry("ACKNOWLEDGED"),
    RESOLVED: entry("RESOLVED"),
    SUPPRESSED: entry("SUPPRESSED"),
  };
}

export const STATUS_VOCABULARY: Readonly<Record<IncidentStatus, StatusEntry>> =
  Object.freeze(statusVocabulary());

/** One status entry, falling back to Open for a value this build does not know. */
export function statusEntry(raw: string, copy: OperationsCopy = operationsDict.en): StatusEntry {
  const table = statusVocabulary(copy);
  return (table as Record<string, StatusEntry | undefined>)[raw] ?? table.OPEN;
}

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
  Object.freeze({ ...operationsDict.en.category });

/**
 * A category the server knows and this build does not still renders.
 *
 * Falling back to a humanised token keeps the row visible and readable. The
 * alternative, filtering unknown categories out, would hide exactly the
 * conditions a newly-deployed writer produces, which is when hiding them is
 * most expensive.
 */
export function categoryLabel(raw: string, copy: OperationsCopy = operationsDict.en): string {
  const known = (copy.category as Record<string, string | undefined>)[raw];
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

const QUEUE_METRIC_SHAPE: Readonly<
  Record<QueueMetricKey, { tone: AppTone; collaborative: boolean }>
> = Object.freeze({
  // The TOTAL, so it wears the total's tone rather than competing with the
  // severities it contains. It counts the canonical UNRESOLVED set — open,
  // acknowledged or suppressed — and its note says so.
  open: { tone: OPERATIONS_TONE.UNRESOLVED, collaborative: false },
  critical: { tone: OPERATIONS_TONE.CRITICAL, collaborative: false },
  high: { tone: OPERATIONS_TONE.HIGH, collaborative: false },
  // THE THIRD SEVERITY: the same summary field, from the same projection.
  warning: { tone: OPERATIONS_TONE.WARNING, collaborative: false },
  slaBreached: { tone: OPERATIONS_TONE.OVERDUE, collaborative: false },
  slaAtRisk: { tone: OPERATIONS_TONE.DUE_SOON, collaborative: false },
  resolved: { tone: OPERATIONS_TONE.RESOLVED, collaborative: false },
  assignedToMe: { tone: OPERATIONS_TONE.OWNED_BY_ME, collaborative: true },
  unassigned: { tone: OPERATIONS_TONE.UNOWNED, collaborative: true },
});

/** The KPI cards' words for a locale, with tone and density from this module. */
export function queueMetricVocabulary(
  copy: OperationsCopy = operationsDict.en,
): Readonly<Record<QueueMetricKey, QueueMetricEntry>> {
  const out = {} as Record<QueueMetricKey, QueueMetricEntry>;
  for (const key of QUEUE_METRIC_ORDER) {
    out[key] = {
      label: copy.metrics[key].label,
      note: copy.metrics[key].note,
      ...QUEUE_METRIC_SHAPE[key],
    };
  }
  return out;
}

export const QUEUE_METRIC_VOCABULARY: Readonly<
  Record<QueueMetricKey, QueueMetricEntry>
> = Object.freeze(queueMetricVocabulary());

/**
 * The summary cards deliberately OVERLAP, and the surface says so.
 *
 * One critical condition assigned to you and open for three days is counted by
 * four of these cards. Letting an operator discover that by adding the numbers
 * up and finding they exceed the queue length is how a surface loses its
 * credibility over a fact that was never a defect.
 */
export const QUEUE_METRIC_OVERLAP_NOTE = operationsDict.en.metricsOverlapNote;

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
  Object.freeze({ ...operationsDict.en.timeline });

export function timelineEventLabel(raw: string, copy: OperationsCopy = operationsDict.en): string {
  const known = (copy.timeline as Record<string, string | undefined>)[raw];
  if (known) return known;
  // An event type the vocabulary does not know yet reads as a generic,
  // localized "Updated" — never its raw type (2026-10-14).
  return copy.timeline.updated;
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
  ...operationsDict.en.sort,
});

// ---------------------------------------------------------------------------
// SLA
//
// Plain language, and deliberately about the COMMITMENT rather than about the
// acronym: an operator reading a queue needs to know whether something is
// late, not to learn a vocabulary first.
// ---------------------------------------------------------------------------

export function slaLabel(posture: SlaPosture, copy: OperationsCopy = operationsDict.en): string {
  // "No SLA recorded" is said plainly, because "—" reads as a loading state
  // and "N/A" reads as a product gap. Neither is what happened.
  return (copy.sla as Record<string, string | undefined>)[posture] ?? copy.sla.NOT_APPLICABLE;
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
export function slaExplanation(sla: IncidentSla, copy: OperationsCopy = operationsDict.en): string {
  const x = copy.slaExplain;
  const ack = sla.obligation === "ACKNOWLEDGEMENT";
  const hours =
    sla.targetHours === null
      ? null
      : sla.targetHours === 1
        ? x.hoursOne
        : x.hoursMany.replace("{n}", String(sla.targetHours));
  const promise =
    hours === null ? "" : " " + (ack ? x.promiseAck : x.promiseRes).replace("{hours}", hours);

  switch (sla.posture) {
    case "BREACHED":
      return (ack ? x.breachedAck : x.breachedRes) + promise;
    case "AT_RISK":
      return (ack ? x.atRiskAck : x.atRiskRes) + promise;
    case "ON_TRACK":
      return (ack ? x.onTrackAck : x.onTrackRes) + promise;
    case "ACKNOWLEDGED":
      return x.acknowledged + promise;
    case "RESOLVED":
      return sla.resolutionBreached ? x.resolvedLate : x.resolvedOnTime;
    case "UNTRACKED_LEGACY":
      // The honest sentence. Applying today's policy to a record from before
      // the policy existed would invent a deadline and whether it was missed.
      return x.untracked;
    case "NOT_APPLICABLE":
    default:
      return x.notApplicable;
  }
}

/**
 * The latched record, when it differs from the posture. Null when there is
 * nothing extra to say, so the drawer does not repeat its own verdict.
 */
export function slaBreachRecord(sla: IncidentSla, copy: OperationsCopy = operationsDict.en): string | null {
  if (sla.posture === "BREACHED") return null;
  const ack = sla.acknowledgementBreached;
  const res = sla.resolutionBreached;
  if (ack && res) return copy.slaExplain.missedBoth;
  if (ack) return copy.slaExplain.missedAck;
  if (res) return copy.slaExplain.missedRes;
  return null;
}
