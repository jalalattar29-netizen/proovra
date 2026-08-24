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
import { lifecycleToneOrNull } from "../../../lib/status-tone/lifecycleTone";

/**
 * What a token MEANS. Tone is derived from this, never chosen directly, so a
 * new token is classified once and coloured consistently everywhere.
 */
/**
 * INTERNAL to this module.
 *
 * Exported once, consumed by nothing outside this file. An export with no
 * consumer is an invitation to grow a second tone authority beside the one
 * the console actually reads — which is what the shared `searchTypeTone` /
 * `searchBadgeTone` / `searchLifecycleTone` trio exists to prevent.
 */
type SearchStateKind =
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

/**
 * INTERNAL to this module.
 *
 * Exported once, consumed by nothing outside this file. An export with no
 * consumer is an invitation to grow a second tone authority beside the one
 * the console actually reads — which is what the shared `searchTypeTone` /
 * `searchBadgeTone` / `searchLifecycleTone` trio exists to prevent.
 */
function toneForKind(kind: SearchStateKind): AppTone {
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
/**
 * EVIDENCE and CASE share ONE token, deliberately.
 *
 * Evidence used to wear the REPORT orange, which made a piece of evidence and
 * the report ABOUT it read as the same kind of thing. They are the two halves
 * of a record's life, not one category. Evidence now takes the same blue as a
 * Case — the same constant, not a second blue that happens to match, so the two
 * cannot drift apart later.
 *
 * The labels stay distinguishable by their WORDS. Colour here says "this is a
 * primary record"; the word says which one. Orange is left to REPORT alone,
 * where it now means one thing.
 */
const CLASSIFICATION_BLUE: AppTone = "blue";

const TYPE_TONE: Readonly<Record<string, AppTone>> = {
  CASE: CLASSIFICATION_BLUE,
  EVIDENCE: CLASSIFICATION_BLUE,
  REPORT: "orange",
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

/**
 * INTERNAL to this module.
 *
 * Exported once, consumed by nothing outside this file. An export with no
 * consumer is an invitation to grow a second tone authority beside the one
 * the console actually reads — which is what the shared `searchTypeTone` /
 * `searchBadgeTone` / `searchLifecycleTone` trio exists to prevent.
 */
function searchBadgeKind(badge: string): SearchStateKind {
  return BADGE_KIND[badge] ?? "neutral";
}

export function searchBadgeTone(badge: string): AppTone {
  // A badge code that IS a lifecycle value takes the app-wide lifecycle
  // colour. `archived` arrives on this surface as a badge and on the Cases
  // surfaces as a status; before this delegation it was slate here and red
  // there, which is exactly the disagreement the shared mapping exists to
  // end. Codes this console owns alone — `legal-hold`, `in_trash`, `locked` —
  // are SIGNALS, not lifecycle, and keep their own classification below.
  const canonical = lifecycleToneOrNull(badge);
  if (canonical) return canonical;
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

/**
 * The states this console owns ALONE.
 *
 * open / active / live / in_progress / investigating / on_hold / resolved /
 * closed / complete / completed / done / sealed / archived were all removed
 * from this table when the shared lifecycle mapping took them over. They are
 * not absent — they are OWNED ELSEWHERE, and leaving a shadowed copy here
 * would be a second answer that nothing reads today and that the next edit
 * would silently start reading again.
 *
 * What remains is the wider operational vocabulary the Search index carries
 * and the lifecycle table deliberately does not: things in flight, things
 * withheld, and things being destroyed.
 */
const LIFECYCLE_KIND: Readonly<Record<string, SearchStateKind>> = {
  pending: "pending",
  queued: "pending",
  processing: "pending",
  in_review: "pending",
  under_review: "pending",
  review: "pending",
  awaiting_review: "pending",
  restricted: "restricted",
  locked: "restricted",
  in_trash: "restricted",
  deleted: "destructive",
  destroyed: "destructive",
  purged: "destructive",
  pending_destruction: "destructive",
};

/**
 * INTERNAL to this module.
 *
 * Exported once, consumed by nothing outside this file. An export with no
 * consumer is an invitation to grow a second tone authority beside the one
 * the console actually reads — which is what the shared `searchTypeTone` /
 * `searchBadgeTone` / `searchLifecycleTone` trio exists to prevent.
 */
function searchLifecycleKind(
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
  // The shared lifecycle mapping LEADS. It owns open / investigating /
  // on_hold / resolved / archived / closed, and it owns them for every
  // surface; this console must not paint a case's status differently from the
  // Cases list that the same operator just came from. `null` back means "not a
  // lifecycle value I own", so the wider vocabulary below — pending,
  // in_review, locked, pending_destruction — still answers for its own states.
  const canonical = lifecycleToneOrNull(value);
  if (canonical) return canonical;
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
  // BOTH vocabularies, or the answer changed the moment the shared mapping
  // took the lifecycle states over: `Open` would have stopped counting as a
  // lifecycle value, and the result row's subtitle would have started
  // repeating the status beside it again.
  return (
    lifecycleToneOrNull(value) !== null || searchLifecycleKind(value) !== "neutral"
  );
}

// ---------------------------------------------------------------------------
// 4. Match reasons — why the backend says a row matched
// ---------------------------------------------------------------------------

/**
 * A match reason's presentation tone.
 *
 * A FOURTH vocabulary, and separate from the other three for the same reason
 * they are separate from each other: "matched title" is neither a record
 * classification nor a lifecycle state nor a governance signal. It says which
 * part of the record the query hit.
 *
 * Keyed by the operator-readable sentence the backend emits
 * (`buildMatchReasonsForRow`), because that string IS the contract — there is
 * no separate code. Every reason resolves through this one table, and one it
 * has never seen resolves to `neutral` rather than to whatever the last branch
 * returned.
 */
export type SearchMatchTone = "title" | "summary" | "workflow" | "semantic" | "neutral";

const MATCH_REASON_TONE: Readonly<Record<string, SearchMatchTone>> = {
  "Matched title": "title",
  "Matched summary": "summary",
  "Workflow-linked": "workflow",
  "Semantically similar": "semantic",
};

/**
 * The tone for one match reason.
 *
 * Never derived from array position: the row and the Inspector iterate the same
 * list but a positional rule would still colour a one-reason row differently
 * from a two-reason row. Never derived from the rendered text either — the
 * lookup is exact, and anything unrecognised is neutral.
 */
export function searchMatchReasonTone(reason: string | null | undefined): SearchMatchTone {
  if (!reason) return "neutral";
  return MATCH_REASON_TONE[reason] ?? "neutral";
}
