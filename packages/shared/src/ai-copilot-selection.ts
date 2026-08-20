/**
 * Copilot selection — ONE authority for what may be analyzed, and for how a
 * request identifies itself.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * TWO DEFECTS, ONE SHAPE. Both were the client deciding something the server
 * also decides, and the two never being reconciled.
 *
 *   1. THE IDEMPOTENCY KEY. The Case Copilot panel built
 *      `${caseId}:${sortedIds.join(",")}` and the route validated it with
 *      `z.string().max(80)`. A case id plus ONE evidence id is 73 characters
 *      and passes. Plus a SECOND is 110 and does not — so selecting two
 *      records, which is the entire point of a cross-record copilot, always
 *      failed schema validation. The user saw:
 *
 *          Invalid selection. (INVALID_INPUT)
 *
 *      Nothing about the selection was invalid. The key describing it was too
 *      long. The Reviewer panel built the same unbounded shape and failed at
 *      even one selection.
 *
 *      A key is an IDENTITY, not a payload. It is now a bounded digest.
 *
 *   2. ELIGIBILITY. The panel listed every linked record — including ones
 *      still uploading — with no statement about whether they could be
 *      analyzed, and the route enforced no rule at all. So a record could be
 *      selected, priced into "Before you run", and sent, with the product
 *      having no opinion until the provider saw metadata that was not settled
 *      yet. Eligibility is now derived from persisted fields, once, and BOTH
 *      sides read it.
 *
 * Nothing here decides authorization, policy or cost. Those are the server's
 * and stay the server's; this decides only whether a record is in a state the
 * copilot can meaningfully compare.
 */

// ---------------------------------------------------------------------------
// 1. Selection size
// ---------------------------------------------------------------------------

/**
 * How many records one copilot run may consider.
 *
 * Stated once so the panel's "Select all", its disabled state and the route's
 * schema cannot disagree — a client that offers more than the server accepts is
 * a client that produces a rejection it could have prevented.
 */
export const COPILOT_SELECTION_MIN = 1;
export const COPILOT_SELECTION_MAX = 50;

// ---------------------------------------------------------------------------
// 2. The idempotency key
// ---------------------------------------------------------------------------

/**
 * The longest key any copilot route accepts.
 *
 * Mirrors `z.string().max(80)` on every AI route. Declared here so the builder
 * is bounded BY the contract rather than by a guess about it.
 */
export const COPILOT_IDEMPOTENCY_KEY_MAX = 80;

/**
 * FNV-1a, 32-bit, run twice over different seeds for a 64-bit digest.
 *
 * Deliberately not `crypto`: this module is imported by the browser bundle and
 * by the API, and a Node-only import would fork it into two modules. The digest
 * is an identity for de-duplication, never a security boundary — a collision
 * costs one deduplicated retry inside a 20-second window, not a wrong answer.
 */
function digest(input: string): string {
  const fnv = (seed: number): number => {
    let h = seed;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  const a = fnv(0x811c9dc5);
  const b = fnv(0x0f4b39c7);
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * A stable, bounded identity for one copilot request.
 *
 * DETERMINISTIC: the same scope and the same set of ids produce the same key,
 * whatever order the user clicked them in, so a double submission is
 * recognised as a duplicate rather than billed twice.
 *
 * BOUNDED: the selection is digested rather than concatenated, so the key's
 * length does not grow with the selection. That growth is exactly what broke
 * the two-record case.
 */
export function buildCopilotIdempotencyKey(input: {
  /** Which copilot. Short and stable, e.g. `case`, `reviewer`. */
  scope: string;
  /** The subject the run is about — a case id, a review id. */
  scopeId: string;
  /** Every selected record. Order-independent; duplicates collapse. */
  selection: ReadonlyArray<string>;
  /** Anything else that changes the MEANING of the run (a criteria set). */
  qualifier?: string | null;
}): string {
  const canonical = [...new Set(input.selection)].sort().join(",");
  const key = `${input.scope}:${input.scopeId}:${digest(
    `${input.qualifier ?? ""}|${canonical}`,
  )}`;
  // A scope of ~10 + a uuid of 36 + two colons + a 16-char digest is 64. The
  // slice is a guarantee, not an expectation: a caller passing a long scope
  // must still produce a key the route accepts.
  return key.slice(0, COPILOT_IDEMPOTENCY_KEY_MAX);
}

// ---------------------------------------------------------------------------
// 3. Eligibility
// ---------------------------------------------------------------------------

/**
 * Why a record cannot be analyzed.
 *
 * A CLOSED set, and every member is derived from a persisted field. Each maps
 * to a short operator-facing sentence in `copilotIneligibilityReason` — the UI
 * never composes its own, so the panel and the route's refusal say the same
 * thing.
 */
export type CopilotIneligibility =
  /** Bytes are not in place yet, so the metadata to compare is not settled. */
  | "still_uploading"
  /** Recorded and stored, but preservation state is not resolved yet. */
  | "processing_incomplete"
  /** The recomputed digest disagreed with what completion recorded. */
  | "integrity_failed"
  /** Governance has scheduled or completed destruction. */
  | "record_unavailable"
  /** Not linked to the case being analyzed. */
  | "not_linked_to_case"
  /** The listed version is no longer the record's version. */
  | "changed_since_listed";

export type CopilotEligibility =
  | { eligible: true }
  | { eligible: false; reason: CopilotIneligibility };

/**
 * The persisted facts eligibility is derived from.
 *
 * Deliberately narrow, and deliberately NOT a plan, a role or a capability:
 * those decide whether the FEATURE runs, which is the server's call. This
 * decides whether a RECORD is in a state worth comparing.
 */
export type CopilotEvidenceFacts = {
  /** `EvidenceStatus`. */
  status: string | null | undefined;
  /** `EvidenceLifecycleState`. */
  lifecycleState?: string | null;
  /** Whether the record is linked to the case under analysis. */
  caseLinked?: boolean;
  /** True when the listed version no longer matches the record's. */
  stale?: boolean;
};

/** Statuses whose bytes and preservation state are settled enough to compare. */
const ANALYZABLE_STATUS = new Set(["UPLOADED", "SIGNED", "REPORTED"]);

/** Statuses that mean the upload itself has not finished. */
const UPLOADING_STATUS = new Set(["CREATED", "UPLOADING"]);

/** Lifecycle states in which the record is going away or already gone. */
const UNAVAILABLE_LIFECYCLE = new Set(["PENDING_DESTRUCTION", "DESTROYED"]);

/**
 * May this record be analyzed?
 *
 * ORDER MATTERS, and it is the order an operator would reason in: what is
 * true of the RECORD first, then what is true of its relationship to this
 * case, then what is true of this particular listing.
 */
export function evaluateCopilotEvidenceEligibility(
  facts: CopilotEvidenceFacts,
): CopilotEligibility {
  const status = (facts.status ?? "").toUpperCase();
  const lifecycle = (facts.lifecycleState ?? "ACTIVE").toUpperCase();

  // Governance decided this record is going or gone. Nothing else matters.
  if (UNAVAILABLE_LIFECYCLE.has(lifecycle)) {
    return { eligible: false, reason: "record_unavailable" };
  }
  // A failed integrity check is terminal: the record never produces a report or
  // a package, so the preservation metadata the copilot compares is absent by
  // construction.
  if (status === "FAILED_HASH_MISMATCH") {
    return { eligible: false, reason: "integrity_failed" };
  }
  if (UPLOADING_STATUS.has(status)) {
    return { eligible: false, reason: "still_uploading" };
  }
  if (!ANALYZABLE_STATUS.has(status)) {
    // An unrecognised status is not assumed safe. Failing closed here is what
    // keeps a new lifecycle state from silently becoming analyzable.
    return { eligible: false, reason: "processing_incomplete" };
  }
  // A CASE copilot compares the evidence OF A CASE. A record that is no longer
  // linked is not part of that population, whatever the client last rendered.
  if (facts.caseLinked === false) {
    return { eligible: false, reason: "not_linked_to_case" };
  }
  // Last: the listing itself is out of date. This is recoverable by refreshing,
  // which is why it is checked after the facts that are not.
  if (facts.stale === true) {
    return { eligible: false, reason: "changed_since_listed" };
  }
  return { eligible: true };
}

/**
 * The one operator-facing sentence for each refusal.
 *
 * Short enough to sit under a filename in a right rail, and free of any
 * mechanism: no table, no column, no status code, and nothing that would tell
 * an unauthorized reader what exists in another workspace.
 */
export function copilotIneligibilityReason(reason: CopilotIneligibility): string {
  switch (reason) {
    case "still_uploading":
      return "Still uploading";
    case "processing_incomplete":
      return "Processing not finished";
    case "integrity_failed":
      return "Integrity check failed";
    case "record_unavailable":
      return "No longer available";
    case "not_linked_to_case":
      return "Not linked to this case";
    case "changed_since_listed":
      return "Changed — refresh to re-select";
    default:
      return "Unavailable";
  }
}

/**
 * The message shown when the SERVER refuses a selection the client thought was
 * fine.
 *
 * That disagreement is always the client's list being out of date, so the copy
 * names the recovery rather than the fault. It never carries the record id: at
 * this point the actor may have lost access to it.
 */
export const COPILOT_SELECTION_REFRESH_MESSAGE =
  "Some selected records are no longer available for analysis. The list has been refreshed — review the selection and try again.";
