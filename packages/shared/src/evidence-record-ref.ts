/**
 * THE SHORT RECORD REFERENCE — one definition, and it is searchable.
 *
 * PROOVRA prints things like:
 *
 *   "RFC3161 timestamp missing for record 76b5d6ac"
 *
 * on the Operations surface, in incident titles, in the activity timeline. It
 * is the first eight hex characters of the Evidence UUID, used as a label
 * whenever the record has no title of its own. An operator reads it, types it
 * into the search box, and gets nothing — because it was a display fallback
 * that no search surface had ever been told about.
 *
 * That is the whole defect: the product gives a person an identifier and then
 * does not accept it. Either it is a reference or it is decoration, and a
 * string printed as "record X" is a reference.
 *
 * ---------------------------------------------------------------------------
 * WHY A RANGE AND NOT A SUBSTRING
 * ---------------------------------------------------------------------------
 * The obvious implementation — `id::text LIKE '%76b5d6ac%'` — is wrong three
 * times over. It cannot use the primary key index, so it is a sequential scan
 * of the workspace; it matches the prefix in the MIDDLE of an unrelated UUID,
 * which is a false positive an operator cannot explain; and it turns the
 * search box into an enumeration oracle for arbitrary fragments.
 *
 * A reference is a PREFIX, and a UUID's canonical text is its bytes in hex
 * order, so every UUID beginning with `76b5d6ac` lies in the closed interval
 *
 *   76b5d6ac-0000-0000-0000-000000000000
 *   76b5d6ac-ffff-ffff-ffff-ffffffffffff
 *
 * which Postgres answers from the primary key. Exact, bounded, and indexed.
 *
 * ---------------------------------------------------------------------------
 * COLLISIONS
 * ---------------------------------------------------------------------------
 * Eight hex characters is 2^32 values, so two records in one workspace CAN
 * share a reference. Both surfaces that accept it are LISTS, so the defined
 * behaviour is to return every match rather than to fail as ambiguous: a
 * search that shows two rows is honest, and a resolver that picks one would
 * not be. Nothing in the product treats this reference as unique, and nothing
 * should start.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not decide scope. Every caller applies its own workspace predicate
 * in the same `where`, exactly as with the intake identity arms, so a
 * reference from one workspace can never surface a record in another. And it
 * refuses anything that is not a whole reference or a whole UUID — seven
 * characters is not a shorter reference, it is a fragment, and answering it
 * would let a caller walk the space one character at a time.
 */

/** How many hex characters the product prints as a record reference. */
export const EVIDENCE_RECORD_REF_LENGTH = 8;

/**
 * The reference PROOVRA prints for a record, from its id.
 *
 * The one place this is derived. Every surface that shows "record 76b5d6ac"
 * should call this, so that what is displayed and what is accepted by search
 * cannot drift apart — which is exactly how they came to disagree.
 */
export function evidenceRecordRef(evidenceId: string): string {
  return evidenceId.slice(0, EVIDENCE_RECORD_REF_LENGTH).toLowerCase();
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_RE = new RegExp(`^[0-9a-f]{${EVIDENCE_RECORD_REF_LENGTH}}$`, "i");

/** What a needle turned out to be, if it was an identifier at all. */
export type EvidenceIdNeedle =
  /** The whole thing. One record, matched exactly. */
  | { kind: "uuid"; id: string }
  /**
   * The printed reference. A closed id interval, so the match is a primary
   * key range rather than a scan, and cannot hit the middle of another id.
   */
  | { kind: "ref"; ref: string; gte: string; lte: string };

/**
 * Read a search needle as a record identifier, or decide it is not one.
 *
 * Returns null for everything else — a Customer ID, a name, a phone number, a
 * filename — so a caller adds an identifier arm only when the operator
 * actually typed an identifier.
 */
export function parseEvidenceIdNeedle(
  needle: string,
): EvidenceIdNeedle | null {
  const trimmed = needle.trim();
  if (UUID_RE.test(trimmed)) {
    return { kind: "uuid", id: trimmed.toLowerCase() };
  }
  if (REF_RE.test(trimmed)) {
    const ref = trimmed.toLowerCase();
    return {
      kind: "ref",
      ref,
      gte: `${ref}-0000-0000-0000-000000000000`,
      lte: `${ref}-ffff-ffff-ffff-ffffffffffff`,
    };
  }
  return null;
}
