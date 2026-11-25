/**
 * Stage D (team remediation, T-069 / T-070 / T-071) — HOW A REVIEW STATUS READS.
 *
 * One module for every Review surface (Inbox, Review page, focus mode,
 * Monitoring). It only maps values the API already sends to words and to a
 * tone of the canonical plain status text (`AppStatusText`, `.app-status-text`
 * — no capsule, no border, no radius; user direction 9). It never scores,
 * ranks or recomputes: the server's projections stay the authority.
 *
 *   - `priorityTone` / `priorityLabel` — THE priority map (T-070). The enum is
 *     LOW · NORMAL · HIGH · URGENT (schema `ReviewWorkflowPriority`); Low and
 *     Normal are neutral, High amber, Urgent red. There is no CRITICAL or
 *     MEDIUM priority.
 *   - `escalationSeverityTone` — Critical red, High orange, Warning amber,
 *     Info neutral (T-069: a Warning escalation is never painted red).
 *   - `reviewLifecycleLabel` / `reviewLifecycleTone` — the lifecycle word.
 *   - `attentionReasons` — the Inbox's one sentence "Needs attention because
 *     …" (T-069): the SLA signal, the governing escalation, one collapsed
 *     governance blocker and a stall, each with its severity tone; no band
 *     enum, no duplicates.
 */

import type { AppTone } from "../../components/app-primitives/AppStatusBadge";
import { escalationSummaryText, formatSpan } from "./sla-presentation";

export type ReviewStatusTone = AppTone;

// ---------------------------------------------------------------------------
// Priority (T-070)
// ---------------------------------------------------------------------------

export const REVIEW_PRIORITY_LABELS: Readonly<Record<string, string>> = {
  LOW: "Low",
  NORMAL: "Normal",
  HIGH: "High",
  URGENT: "Urgent",
};

/** THE priority tone: Low / Normal neutral, High amber, Urgent red. */
export function priorityTone(priority: string | null | undefined): ReviewStatusTone {
  switch ((priority ?? "").trim().toUpperCase()) {
    case "URGENT":
      return "red";
    case "HIGH":
      return "amber";
    default:
      return "slate";
  }
}

/** "High priority"; an unknown value reads "Normal priority" never a raw code. */
export function priorityLabel(priority: string | null | undefined): string {
  const word = REVIEW_PRIORITY_LABELS[(priority ?? "").trim().toUpperCase()] ?? "Normal";
  return `${word} priority`;
}

/** Only High and Urgent are worth a word in a dense row; Normal says nothing. */
export function isNotablePriority(priority: string | null | undefined): boolean {
  const p = (priority ?? "").trim().toUpperCase();
  return p === "HIGH" || p === "URGENT";
}

// ---------------------------------------------------------------------------
// Escalation severity
// ---------------------------------------------------------------------------

export function escalationSeverityTone(severity: string | null | undefined): ReviewStatusTone {
  switch ((severity ?? "").trim().toUpperCase()) {
    case "CRITICAL":
      return "red";
    case "HIGH":
      return "orange";
    case "WARNING":
    case "MEDIUM":
      return "amber";
    default:
      return "slate";
  }
}

const SEVERITY_WORDS: Readonly<Record<string, string>> = {
  CRITICAL: "Critical",
  HIGH: "High",
  WARNING: "Warning",
  MEDIUM: "Medium",
  LOW: "Low",
  INFO: "Info",
};

export function escalationSeverityLabel(severity: string | null | undefined): string {
  return SEVERITY_WORDS[(severity ?? "").trim().toUpperCase()] ?? "Active";
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const LIFECYCLE_WORDS: Readonly<Record<string, string>> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  QUEUED: "Waiting for a reviewer",
  ASSIGNED: "Assigned",
  IN_REVIEW: "In review",
  NEEDS_INFORMATION: "Waiting for information",
  ESCALATED: "Escalated",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  ARCHIVED: "Archived",
  CANCELLED: "Cancelled",
  CLOSED: "Closed",
};

export function reviewLifecycleLabel(state: string | null | undefined): string {
  return LIFECYCLE_WORDS[(state ?? "").trim().toUpperCase()] ?? "Unknown status";
}

export function reviewLifecycleTone(state: string | null | undefined): ReviewStatusTone {
  switch ((state ?? "").trim().toUpperCase()) {
    case "APPROVED":
      return "green";
    case "REJECTED":
      return "red";
    case "ESCALATED":
    case "NEEDS_INFORMATION":
      return "amber";
    case "ASSIGNED":
    case "IN_REVIEW":
      return "blue";
    default:
      return "slate";
  }
}

// ---------------------------------------------------------------------------
// SLA words (Review page header, Monitoring)
// ---------------------------------------------------------------------------

/** The tone of a governing-deadline / deadline-outcome kind. */
export function deadlineKindTone(kind: string | null | undefined): ReviewStatusTone {
  switch (kind) {
    case "overdue":
    case "missed":
    case "BREACHED":
      return "red";
    case "due_soon":
    case "DUE_SOON":
      return "amber";
    case "met":
    case "done":
    case "all_met":
    case "COMPLETED":
      return "green";
    default:
      return "slate";
  }
}

// ---------------------------------------------------------------------------
// The Inbox attention sentence (T-069)
// ---------------------------------------------------------------------------

/** What the queue-intelligence projection sends for one row (the subset read here). */
export type AttentionInput = {
  slaState?: {
    status?: string | null;
    signal?: "OVERDUE" | "DUE_SOON" | "PAUSED" | null;
    dueAtUtc?: string | null;
    breachedAtUtc?: string | null;
  } | null;
  escalationState?: {
    activeEscalationId?: string | null;
    severity?: string | null;
    activeCount?: number;
  } | null;
  governanceBlockers?: Partial<Record<
    "legalHold" | "immutableDrift" | "packageBlocked" | "exportBlocked" | "retentionExpired",
    boolean
  >> | null;
  stuckState?: { isStuck?: boolean; topSeverity?: string | null } | null;
};

export type AttentionReason = {
  key: "sla" | "escalation" | "blocker" | "stalled";
  text: string;
  tone: ReviewStatusTone;
};

function slaSignal(sla: AttentionInput["slaState"]): "OVERDUE" | "DUE_SOON" | "PAUSED" | null {
  if (!sla) return null;
  if (sla.signal !== undefined) return sla.signal ?? null;
  // An older API: the stored status (OVERDUE read as a breach).
  const s = (sla.status ?? "").toUpperCase();
  if (s === "BREACHED" || s === "OVERDUE") return "OVERDUE";
  if (s === "DUE_SOON") return "DUE_SOON";
  if (s === "PAUSED") return "PAUSED";
  return null;
}

/**
 * The reasons a row needs attention, most severe first, each said once:
 *
 *   - the SLA signal: "Overdue 13 d" (red), "Due soon" (amber), "Paused";
 *   - the governing escalation: "Escalation: High (2 active)" in its severity
 *     tone (Warning amber, never red);
 *   - ONE governance blocker: a legal hold already implies the export and
 *     package blocks, so it is the only word shown for them;
 *   - "Stalled" when the stuck detector says so.
 *
 * Empty when nothing needs attention (the caller shows no sentence).
 */
export function attentionReasons(input: AttentionInput | null | undefined, nowMs: number = Date.now()): AttentionReason[] {
  if (!input) return [];
  const out: AttentionReason[] = [];
  const signal = slaSignal(input.slaState);
  if (signal === "OVERDUE") {
    const anchor = input.slaState?.breachedAtUtc ?? input.slaState?.dueAtUtc ?? null;
    const anchorMs = anchor ? new Date(anchor).getTime() : NaN;
    const text = Number.isFinite(anchorMs) && nowMs > anchorMs ? `Overdue ${formatSpan(nowMs - anchorMs)}` : "Overdue";
    out.push({ key: "sla", text, tone: "red" });
  } else if (signal === "DUE_SOON") {
    out.push({ key: "sla", text: "Due soon", tone: "amber" });
  } else if (signal === "PAUSED") {
    out.push({ key: "sla", text: "Paused", tone: "slate" });
  }
  const esc = input.escalationState;
  if (esc?.activeEscalationId) {
    out.push({
      key: "escalation",
      text: escalationSummaryText(esc.severity ?? null, esc.activeCount) ?? "Escalation open",
      tone: escalationSeverityTone(esc.severity),
    });
  }
  const b = input.governanceBlockers ?? {};
  if (b.legalHold) {
    out.push({ key: "blocker", text: "Legal hold", tone: "amber" });
  } else if (b.immutableDrift) {
    out.push({ key: "blocker", text: "Storage drift", tone: "red" });
  } else if (b.retentionExpired) {
    out.push({ key: "blocker", text: "Retention expired", tone: "amber" });
  } else if (b.packageBlocked || b.exportBlocked) {
    out.push({ key: "blocker", text: "Export blocked", tone: "amber" });
  }
  if (input.stuckState?.isStuck) {
    const sev = (input.stuckState.topSeverity ?? "").toUpperCase();
    out.push({ key: "stalled", text: "Stalled", tone: sev === "CRITICAL" || sev === "HIGH" ? "red" : "amber" });
  }
  return out;
}

/** The sentence as plain text (tests, titles, screen-reader summaries). */
export function attentionSentence(reasons: ReadonlyArray<AttentionReason>): string | null {
  if (reasons.length === 0) return null;
  const [first, ...rest] = reasons;
  const lead = first!.text.charAt(0).toLowerCase() + first!.text.slice(1);
  return `Needs attention because ${[lead, ...rest.map((r) => r.text)].join(" · ")}`;
}
