/**
 * THE canonical lifecycle status -> tone mapping.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * "Open", "Archived" and "Closed" are rendered by Cases, by Evidence and by
 * Search. Each of those surfaces used to decide the colour itself, and they
 * disagreed: a case that was ARCHIVED read grey in the Search results and grey
 * on the Cases list while ARCHIVED is the one lifecycle state this product
 * treats as consequential, and RESOLVED shared a colour with OPEN so a
 * finished case and a live one looked identical.
 *
 * Nothing reconciled them because nothing owned the mapping. This does. A
 * surface may choose the SHAPE of its status label — `AppStatusBadge` for a
 * state a dense row is scanned by, `AppStatusText` for a state that is one
 * labelled fact among many — but not its colour.
 *
 * DOMAIN-SPECIFIC VOCABULARIES STAY SEPARATE. This owns the record's own
 * LIFECYCLE. It is deliberately not the authority for record TYPE (a
 * classification), for governance SIGNALS (legal hold, export-restricted) or
 * for review/verification outcomes — those are different vocabularies and
 * collapsing them onto one table is how "archived" and "legal hold" ended up
 * the same colour. Callers with such a vocabulary keep their own table and
 * delegate to this one for the values it owns.
 */

import type { AppTone } from "../../components/app-primitives/AppStatusBadge";

/**
 * Wire values arrive in several shapes — `ON_HOLD`, `on hold`, `On Hold`.
 * Normalise before looking up, so one state cannot take two colours because of
 * its casing or its separator.
 */
export function normaliseLifecycleKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * The mapping, as the product's semantics — not as a colour preference.
 *
 *   green  OPEN            work can continue on this record
 *   indigo INVESTIGATING   active, attended processing
 *   indigo ON_HOLD         deliberately paused BY someone; the same attended
 *                          colour as INVESTIGATING because a hold is a
 *                          decision a person made and still owns, not a
 *                          warning the system is raising
 *   orange RESOLVED        an outcome was reached, and the record is still
 *                          live enough to act on. Distinct from CLOSED
 *   red    ARCHIVED        removed from the working set. The one lifecycle
 *                          transition here with real consequences
 *   ink    CLOSED          terminal, settled, and not a caution
 *
 * ORANGE IS A CLASSIFICATION TONE, NOT A CAUTION — see the `AppTone`
 * contract. `amber` is the tone that means "needs attention"; RESOLVED does
 * not need attention, so the two must not be swapped for looking similar.
 */
const LIFECYCLE_TONE: Readonly<Record<string, AppTone>> = {
  open: "green",
  active: "green",
  live: "green",
  in_progress: "green",
  investigating: "indigo",
  on_hold: "indigo",
  resolved: "orange",
  archived: "red",
  closed: "ink",
  complete: "ink",
  completed: "ink",
  done: "ink",
  sealed: "ink",
};

/**
 * The tone for one lifecycle value, or `null` if this vocabulary does not own
 * it.
 *
 * `null` rather than a fallback tone on purpose: a caller with its own wider
 * state vocabulary (Search classifies `pending`, `locked`, `deleted` too) must
 * be able to tell "this is not a lifecycle value I own" from "this is a
 * lifecycle value that happens to be neutral". Returning `slate` here would
 * silently swallow every state this table has not been taught.
 */
export function lifecycleToneOrNull(
  value: string | null | undefined,
): AppTone | null {
  if (value == null) return null;
  const key = normaliseLifecycleKey(value);
  // Absence is not a state. An empty value and the em-dash placeholder must
  // never resolve to a colour — "we do not have this" is not "this is fine".
  if (key === "" || key === "—" || key === "-") return null;
  return LIFECYCLE_TONE[key] ?? null;
}

/**
 * The tone for one lifecycle value, falling back to the neutral tone.
 *
 * For callers whose ONLY vocabulary is lifecycle (the Cases surfaces). A value
 * this table has never seen resolves to `slate` rather than to whatever the
 * last branch returned, so a new backend state arrives legible instead of
 * unstyled.
 */
export function lifecycleTone(value: string | null | undefined): AppTone {
  return lifecycleToneOrNull(value) ?? "slate";
}

/** The lifecycle values this module owns, for tests and for exhaustiveness. */
export const LIFECYCLE_STATES = Object.keys(LIFECYCLE_TONE);
