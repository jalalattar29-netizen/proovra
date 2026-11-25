/**
 * Stage C (team remediation) — what a review's deadlines and escalations SAY.
 *
 * One module for the Review page (`/reviewer-ops/[id]`) and focus mode
 * (`/review/workspace`), built on the shared server-side semantics
 * (`presentReviewSlaDimensions`, `governingReviewDeadline`,
 * `reviewSlaDimensionOutcome`):
 *
 *   - T-043  "Met" only when the fact happened by the deadline, shown with the
 *            fact's date ("Met · 02 Nov 2026"); a late fact is "Missed by 3 d".
 *   - T-045  an escalation is not a deadline state: no "Escalation Met", no
 *            "Overdue (escalated)", and "overdue" only after the deadline.
 *   - T-046  a dimension with no deadline is not listed.
 *   - T-048  the governing deadline is the earliest one still open.
 *   - T-049  the escalation line names the highest active severity and how many
 *            escalations are active.
 *
 * Wording only: visual treatment (badges, layout) is stage D's.
 */

import {
  governingReviewDeadline,
  presentReviewSlaDimensions,
  reviewSlaDimensionOutcome,
  type ReviewSlaDimensionSnapshot,
} from "@proovra/shared";

import { formatUserDate } from "../date";

/** The projection's dimension as the API sends it (older APIs omit the stage-C fields). */
export type SlaDimensionWire = {
  dimension: string;
  dueAtUtc: string | null;
  dueSoonAtUtc?: string | null;
  state: string;
  timeRemainingMs?: number | null;
  breachDurationMs?: number | null;
  completedAtUtc?: string | null;
  metOnTime?: boolean | null;
};

function toSnapshot(d: SlaDimensionWire): ReviewSlaDimensionSnapshot {
  return {
    dimension: d.dimension as ReviewSlaDimensionSnapshot["dimension"],
    dueAtUtc: d.dueAtUtc,
    dueSoonAtUtc: d.dueSoonAtUtc ?? null,
    state: d.state as ReviewSlaDimensionSnapshot["state"],
    timeRemainingMs: d.timeRemainingMs ?? null,
    breachDurationMs: d.breachDurationMs ?? null,
    completedAtUtc: d.completedAtUtc ?? null,
    metOnTime: d.metOnTime ?? null,
  };
}

const DIMENSION_LABELS: Record<string, string> = {
  ASSIGNMENT: "Assignment",
  FIRST_REVIEW: "First review",
  COMPLETION: "Completion",
};

export function reviewDeadlineLabel(dimension: string): string {
  return DIMENSION_LABELS[dimension] ?? dimension.charAt(0) + dimension.slice(1).toLowerCase().replace(/_/g, " ");
}

/** "3 d", "5 h", "20 min" — a duration, never a date. */
export function formatSpan(ms: number): string {
  const abs = Math.abs(ms);
  const minutes = Math.round(abs / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

export type PresentedDeadline = {
  dimension: string;
  label: string;
  /** What the row says: "Met · 02 Nov 2026", "Overdue 13 d · due 11 Nov 2026". */
  text: string;
  /** The outcome word alone ("Met", "Missed", "Overdue", "Due soon", "On track"). */
  word: string;
  /** The rest of the sentence, after the word. */
  detail: string;
  /** For tone only. */
  kind: ReturnType<typeof reviewSlaDimensionOutcome>["kind"];
  /** A StatusBadge tone key with the same meaning as `kind`. */
  toneKey: "COMPLETED" | "BREACHED" | "DUE_SOON" | "HEALTHY" | "PAUSED";
};

const OUTCOME_WORD: Record<PresentedDeadline["kind"], [string, PresentedDeadline["toneKey"]]> = {
  met: ["Met", "COMPLETED"],
  missed: ["Missed", "BREACHED"],
  done: ["Completed", "COMPLETED"],
  overdue: ["Overdue", "BREACHED"],
  due_soon: ["Due soon", "DUE_SOON"],
  paused: ["Paused", "PAUSED"],
  open: ["On track", "HEALTHY"],
};

/** The dimensions a reader is shown, each with its truthful sentence. */
export function presentDeadlines(dimensions: ReadonlyArray<SlaDimensionWire>): PresentedDeadline[] {
  return presentReviewSlaDimensions(dimensions.map(toSnapshot)).map((s) => {
    const o = reviewSlaDimensionOutcome(s);
    let text: string;
    switch (o.kind) {
      case "met":
        text = `Met · ${formatUserDate(o.completedAtUtc)}`;
        break;
      case "missed":
        text = `Missed by ${formatSpan(o.lateByMs)} · completed ${formatUserDate(o.completedAtUtc)}`;
        break;
      case "done":
        text = `Completed · ${formatUserDate(o.completedAtUtc)}`;
        break;
      case "overdue":
        text = `Overdue ${formatSpan(o.overdueByMs)} · due ${formatUserDate(o.dueAtUtc)}`;
        break;
      case "due_soon":
        text = `Due soon · in ${formatSpan(o.timeRemainingMs)} (${formatUserDate(o.dueAtUtc)})`;
        break;
      case "paused":
        text = "Paused";
        break;
      default:
        text = `Due ${formatUserDate(o.dueAtUtc)} · in ${formatSpan(o.timeRemainingMs)}`;
    }
    const [word, toneKey] = OUTCOME_WORD[o.kind];
    const detail = text.startsWith(word) ? text.slice(word.length).replace(/^ ?· ?/, "").trim() : text;
    return { dimension: s.dimension, label: reviewDeadlineLabel(s.dimension), text, word, detail, kind: o.kind, toneKey };
  });
}

export type GoverningDeadlineText = {
  text: string;
  /** For tone only: overdue / due soon / open / paused / met / none. */
  kind: "overdue" | "due_soon" | "open" | "paused" | "all_met" | "none";
};

/**
 * T-043 / T-048 — the ONE line the Review page header and focus mode show:
 * the governing deadline ("Completion due 11 Nov 2026 · overdue 13 d"), "All
 * deadlines met", or "No deadline".
 */
export function governingDeadlineText(dimensions: ReadonlyArray<SlaDimensionWire>): GoverningDeadlineText {
  const g = governingReviewDeadline(dimensions.map(toSnapshot));
  if (g.kind === "none") return { text: "No deadline", kind: "none" };
  if (g.kind === "all_met") {
    return g.missed > 0
      ? { text: `All deadlines reached (${g.missed} missed)`, kind: "all_met" }
      : { text: "All deadlines met", kind: "all_met" };
  }
  const o = reviewSlaDimensionOutcome(g.dimension);
  const label = reviewDeadlineLabel(g.dimension.dimension);
  switch (o.kind) {
    case "overdue":
      return { text: `${label} due ${formatUserDate(o.dueAtUtc)} · overdue ${formatSpan(o.overdueByMs)}`, kind: "overdue" };
    case "due_soon":
      return { text: `${label} due ${formatUserDate(o.dueAtUtc)} · in ${formatSpan(o.timeRemainingMs)}`, kind: "due_soon" };
    case "paused":
      return { text: `${label} deadline paused`, kind: "paused" };
    case "open":
      return { text: `${label} due ${formatUserDate(o.dueAtUtc)} · in ${formatSpan(o.timeRemainingMs)}`, kind: "open" };
    default:
      return { text: "All deadlines met", kind: "all_met" };
  }
}

const SEVERITY_WORDS: Record<string, string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  WARNING: "Warning",
  INFO: "Info",
};

/**
 * T-049 — "Escalation: High (2 active)". The severity is the governing
 * (highest) active escalation's; the count is escalations, not reviews.
 */
export function escalationSummaryText(severity: string | null | undefined, activeCount: number | null | undefined): string | null {
  const count = typeof activeCount === "number" ? activeCount : severity ? 1 : 0;
  if (count <= 0) return null;
  const word = SEVERITY_WORDS[String(severity ?? "").toUpperCase()] ?? "Active";
  return `Escalation: ${word} (${count} active)`;
}
