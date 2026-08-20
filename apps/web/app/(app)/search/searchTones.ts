/**
 * The Search console's colour semantics — one authority, two vocabularies.
 *
 * Colour was previously decided at each render site, and the two sites
 * disagreed. A result row rendered its document type as a neutral chip while
 * the Inspector rendered the same type as a status badge in a status colour,
 * so one record could be grey in the list and amber in the panel beside it.
 * Nothing reconciled them because nothing owned the mapping.
 *
 * Everything below maps a token to a KIND first, and a kind to a tone second.
 * Two functions share one kind table, so a state cannot be amber in one place
 * and green in another; and a token this console has never seen resolves to
 * neutral rather than to whatever the last branch happened to return.
 *
 * The three vocabularies are deliberately separate because they are separate:
 *
 *   documentType   EVIDENCE | CASE | REPORT | PACKAGE | NOTE — a CLASSIFICATION
 *                  of record. Not a state, so it never wears a state colour.
 *   badge codes    legal-hold, export-restricted, in_trash … — SIGNALS the
 *                  backend attaches to a row.
 *   lifecycle      OPEN | CLOSED | PENDING … — the record's own STATE.
 */

import type { AppTone } from "../../../components/app-primitives/AppStatusBadge";

/**
 * What a token MEANS. Tone is derived from this, never chosen directly, so a
 * new token is classified once and coloured consistently everywhere.
 */
export type SearchStateKind =
  /** The record is live and work can continue. */
  | "open"
  /** The record reached its end state. Distinct from open, never green. */
  | "closed"
  /** Something is in flight or awaited. */
  | "pending"
  /** Something is withheld or limited, but nothing is being destroyed. */
  | "restricted"
  /** Work is BLOCKED by a governance decision. */
  | "blocking"
  /** The record is being or has been destroyed. */
  | "destructive"
  /** A pointer to another record. Informational, never a warning. */
  | "linked"
  /** Unknown, absent, or genuinely neutral. */
  | "neutral";

const KIND_TONE: Record<SearchStateKind, AppTone> = {
  open: "green",
  closed: "slate",
  pending: "amber",
  restricted: "amber",
  blocking: "red",
  destructive: "red",
  linked: "blue",
  neutral: "slate",
};

export function toneForKind(kind: SearchStateKind): AppTone {
  return KIND_TONE[kind];
}

// ---------------------------------------------------------------------------
// 1. Document type — a classification
// ---------------------------------------------------------------------------

/**
 * The tone a record TYPE wears.
 *
 * Keyed by the wire enum, never by array position or DOM order: the chip row
 * and the Inspector iterate different collections, so anything positional
 * would colour the same record differently in each.
 */
const TYPE_TONE: Readonly<Record<string, AppTone>> = {
  CASE: "blue",
  REPORT: "orange",
  EVIDENCE: "orange",
  PACKAGE: "indigo",
  NOTE: "slate",
};

export function searchTypeTone(documentType: string | null | undefined): AppTone {
  if (!documentType) return "slate";
  return TYPE_TONE[documentType] ?? "slate";
}

// ---------------------------------------------------------------------------
// 2. Backend badge codes — signals
// ---------------------------------------------------------------------------

const BADGE_KIND: Readonly<Record<string, SearchStateKind>> = {
  "legal-hold": "blocking",
  "governance-restricted": "blocking",
  "incident-linked": "blocking",
  "export-restricted": "restricted",
  "visibility-restricted": "restricted",
  "review-linked": "pending",
  in_trash: "restricted",
  locked: "restricted",
  archived: "closed",
  "workflow-linked": "linked",
  "communication-linked": "linked",
  "integrity record": "linked",
  "matched metadata": "linked",
  "related evidence": "linked",
  "contributor-scoped": "neutral",
};

export function searchBadgeKind(badge: string): SearchStateKind {
  return BADGE_KIND[badge] ?? "neutral";
}

export function searchBadgeTone(badge: string): AppTone {
  return toneForKind(searchBadgeKind(badge));
}

// ---------------------------------------------------------------------------
// 3. Lifecycle state values — the record's own state
// ---------------------------------------------------------------------------

/**
 * Wire state values arrive in several shapes — `OPEN`, `open`, `IN_REVIEW`,
 * `pending destruction`. Normalise before classifying so one state cannot take
 * two colours because of its casing.
 */
function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

const LIFECYCLE_KIND: Readonly<Record<string, SearchStateKind>> = {
  open: "open",
  active: "open",
  live: "open",
  in_progress: "open",
  closed: "closed",
  complete: "closed",
  completed: "closed",
  done: "closed",
  resolved: "closed",
  sealed: "closed",
  archived: "closed",
  pending: "pending",
  queued: "pending",
  processing: "pending",
  in_review: "pending",
  under_review: "pending",
  review: "pending",
  awaiting_review: "pending",
  on_hold: "restricted",
  restricted: "restricted",
  locked: "restricted",
  in_trash: "restricted",
  deleted: "destructive",
  destroyed: "destructive",
  purged: "destructive",
  pending_destruction: "destructive",
};

export function searchLifecycleKind(
  value: string | null | undefined,
): SearchStateKind {
  if (value == null) return "neutral";
  const key = normalise(value);
  // An empty value and the em-dash placeholder are ABSENCE, not a state. They
  // must never come out green or red — "we do not have this" is not "this is
  // fine" and it is not "this is wrong".
  if (key === "" || key === "—" || key === "-") return "neutral";
  return LIFECYCLE_KIND[key] ?? "neutral";
}

export function searchLifecycleTone(value: string | null | undefined): AppTone {
  return toneForKind(searchLifecycleKind(value));
}

/**
 * A lifecycle value in the words the console shows.
 *
 * The wire says `OPEN` and `PENDING_DESTRUCTION`; both are wire vocabulary.
 * An absent value renders as an em-dash, which is a statement that the field
 * has no value — not an empty cell the reader has to interpret.
 */
export function searchLifecycleLabel(value: string | null | undefined): string {
  if (value == null || value.trim() === "") return "—";
  const words = value.trim().replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Does this value carry a state worth colouring at all?
 *
 * Used to decide whether a row's supporting line is repeating the status badge
 * beside it. The console renders a fact once.
 */
export function isLifecycleValue(value: string | null | undefined): boolean {
  return searchLifecycleKind(value) !== "neutral";
}
