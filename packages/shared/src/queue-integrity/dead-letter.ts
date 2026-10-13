/**
 * DEAD-LETTER QUEUES ARE SINKS, NOT BACKLOG (2026-10-13).
 *
 * `report-dlq` and `media-intelligence-dlq` have no worker by design: an entry
 * is a triage record of a failure that already went terminal. BullMQ keeps
 * every entry in `waiting` forever, so the raw count only grows, and every
 * reader treated it like a work queue — production showed `waiting=19`,
 * `hasBacklog=true` and an ever-older `oldestPendingAgeSeconds` for history
 * that nobody had to process.
 *
 * An entry's state is not its BullMQ state. It is the state of the condition
 * it records, read from the canonical Operations incident lifecycle (an
 * operator acknowledges or resolves the incident; a probe auto-resolves it when
 * the record recovers) — or, when the record has since produced its output, it
 * is resolved by that fact. No second incident system, no deletion of history:
 * the retained count stays visible as what it is.
 */
import { QUEUE_NAMES } from "./names.js";

export const DEAD_LETTER_QUEUE_NAMES: ReadonlySet<string> = new Set([
  QUEUE_NAMES.REPORT_DLQ,
  QUEUE_NAMES.MEDIA_INTELLIGENCE_DLQ,
  // The worker's telemetry rows spell queues with dots.
  "report.dlq",
  "media.intelligence.dlq",
]);

export function isDeadLetterQueue(name: string): boolean {
  return DEAD_LETTER_QUEUE_NAMES.has(name);
}

export type DeadLetterResolution = "UNRESOLVED" | "ACKNOWLEDGED" | "RESOLVED";

/** An unresolved entry younger than this is NEW — the one that needs eyes now. */
export const DEAD_LETTER_NEW_WINDOW_MS = 24 * 60 * 60 * 1000;

export type DeadLetterSummary = {
  /** Every entry the sink still holds — history, never backlog. */
  retained: number;
  /** Unresolved and recorded within DEAD_LETTER_NEW_WINDOW_MS. */
  unresolvedNew: number;
  /** Unresolved and older than the window (never acknowledged). */
  unresolvedOlder: number;
  acknowledged: number;
  resolved: number;
  /** Age of the oldest UNRESOLVED entry; null when there is none. */
  oldestUnresolvedAgeSeconds: number | null;
  /** True when entries beyond the bounded page were not classified. */
  truncated: boolean;
};

export function summarizeDeadLetterEntries(
  entries: ReadonlyArray<{ addedAtMs: number; resolution: DeadLetterResolution }>,
  input: { nowMs: number; retained: number },
): DeadLetterSummary {
  let unresolvedNew = 0;
  let unresolvedOlder = 0;
  let acknowledged = 0;
  let resolved = 0;
  let oldest: number | null = null;
  for (const e of entries) {
    if (e.resolution === "RESOLVED") resolved += 1;
    else if (e.resolution === "ACKNOWLEDGED") acknowledged += 1;
    else {
      if (input.nowMs - e.addedAtMs <= DEAD_LETTER_NEW_WINDOW_MS) unresolvedNew += 1;
      else unresolvedOlder += 1;
      oldest = oldest === null ? e.addedAtMs : Math.min(oldest, e.addedAtMs);
    }
  }
  return {
    retained: input.retained,
    unresolvedNew,
    unresolvedOlder,
    acknowledged,
    resolved,
    oldestUnresolvedAgeSeconds: oldest === null ? null : Math.max(0, Math.floor((input.nowMs - oldest) / 1000)),
    truncated: entries.length < input.retained,
  };
}

/** The entry's state from its incident's lifecycle status. */
export function deadLetterResolutionFromIncident(status: string | null | undefined): DeadLetterResolution {
  switch (status) {
    case "RESOLVED":
    case "SUPPRESSED":
      return "RESOLVED";
    case "ACKNOWLEDGED":
      return "ACKNOWLEDGED";
    default:
      return "UNRESOLVED";
  }
}

/** Unresolved entries are the only part of a sink an operator still owes. */
export function deadLetterNeedsAttention(s: Pick<DeadLetterSummary, "unresolvedNew" | "unresolvedOlder">): boolean {
  return s.unresolvedNew + s.unresolvedOlder > 0;
}
