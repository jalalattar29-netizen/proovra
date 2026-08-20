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

import { SHA256_BASE64URL_LENGTH, sha256Base64Url } from "./canonical-digest.js";

// ---------------------------------------------------------------------------
// 1. Selection size
// ---------------------------------------------------------------------------

/**
 * The copilot REQUEST CONTRACT version.
 *
 * Part of every idempotency key's canonical input, so that changing what a
 * request MEANS — a new field, a different comparison — cannot let a new
 * request be served an old request's answer. Bump it when the contract
 * changes, not when an implementation detail does.
 */
export const COPILOT_REQUEST_CONTRACT_VERSION = "2";

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
 * The digest length this builder spends on identity.
 *
 * The key must fit `z.string().max(80)` alongside a scope and a uuid, so the
 * digest is the part that can be sized. 32 base64url characters carry 192 bits
 * — vastly stronger than the 64-bit FNV-1a this replaced, and enough that two
 * genuinely different requests colliding inside a 20-second dedupe window is
 * not a thing that happens.
 */
const IDEMPOTENCY_DIGEST_LENGTH = 32;

/**
 * A stable, bounded identity for one copilot request.
 *
 * WHAT THE KEY IS FOR. Two submissions of the SAME request must be recognised
 * as one, so a double-click is not billed twice and does not run the model
 * twice. Two submissions of DIFFERENT requests must not be, or the second gets
 * the first's answer.
 *
 * THE DEFECT THIS REPLACES. The key was built from the case id and the sorted
 * evidence ids. Those identify a SELECTION, not an OPERATION — so once the
 * guard could detect that a record's metadata had changed, the key still could
 * not: retrying after a real change produced the SAME key and could be served
 * the result computed from the OLD snapshot. A stale answer about evidence is
 * worse than no answer.
 *
 * So the canonical input now carries everything that changes the MEANING of the
 * run: the operation kind, the context it runs in, which records, WHICH
 * REVISION of each of those records, the mode that shapes the output, and the
 * request-contract version. Change any of them and the key changes.
 *
 * ORDER-INDEPENDENT: ids are de-duplicated and sorted, and each id travels with
 * its own revision, so clicking the same two records in the other order is the
 * same request.
 *
 * BOUNDED: the canonical input is digested, never concatenated. Concatenation
 * is what broke this originally — a case id plus two evidence ids is 110
 * characters against a `max(80)` schema, so selecting two records, the entire
 * point of a cross-record copilot, always failed validation with
 * "Invalid selection." Fifty records each carrying a revision would be some
 * 4,000 characters.
 *
 * The persisted key therefore contains no uuid list and no revision list.
 */
export function buildCopilotIdempotencyKey(input: {
  /** Which copilot. Short and stable, e.g. `case`, `reviewer`. */
  scope: string;
  /** The subject the run is about — a case id, a review id. */
  scopeId: string;
  /** Every selected record. Order-independent; duplicates collapse. */
  selection: ReadonlyArray<string>;
  /**
   * The analysis revision for each selected record, by id.
   *
   * A record whose revision is absent contributes `~none` rather than being
   * skipped: "I could not determine this record's revision" is itself part of
   * the request's identity and must not silently collide with a request that
   * knew it.
   */
  revisions?: Readonly<Record<string, EvidenceAnalysisRevision | undefined>>;
  /** The processing mode, where it changes the output. */
  mode?: string | null;
  /** Anything else that changes the MEANING of the run (a criteria set). */
  qualifier?: string | null;
}): string {
  const ids = [...new Set(input.selection)].sort();
  const canonical = [
    `k=${input.scope}`,
    `c=${input.scopeId}`,
    `m=${input.mode ?? ""}`,
    `q=${input.qualifier ?? ""}`,
    `x=${COPILOT_REQUEST_CONTRACT_VERSION}`,
    `s=${ids.map((id) => `${id}@${input.revisions?.[id] ?? "~none"}`).join(",")}`,
  ].join("|");
  const key = `${input.scope}:${input.scopeId}:${sha256Base64Url(canonical).slice(
    0,
    IDEMPOTENCY_DIGEST_LENGTH,
  )}`;
  // A scope of ~10 + a uuid of 36 + two colons + 32 digest characters is 80.
  // The slice is a guarantee, not an expectation: a caller passing a long scope
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
  | "changed_since_listed"
  /**
   * The projection carried no analysis revision, so nothing can be compared.
   *
   * FAIL CLOSED. The alternative — defaulting to `0` — is precisely what made
   * every case record arrive as `v0` and be refused as stale.
   */
  | "no_analysis_revision";

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
  /** True when the listed revision no longer matches the record's. */
  stale?: boolean;
  /**
   * The canonical analysis revision, as projected.
   *
   * `undefined` means the projection did not carry one — which is a refusal,
   * not a default.
   */
  analysisRevision?: EvidenceAnalysisRevision | undefined;
  /** Whether the caller is able to supply `analysisRevision` at all. */
  analysisRevisionKnown?: boolean;
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
  // The projection must be able to answer "has this changed". If it cannot,
  // the record is refused rather than sent with a fabricated version — the
  // defect this whole module exists to end. A MALFORMED revision is treated as
  // no revision: a token this product did not issue answers nothing.
  if (
    facts.analysisRevisionKnown === true &&
    !isEvidenceAnalysisRevision(facts.analysisRevision)
  ) {
    return { eligible: false, reason: "no_analysis_revision" };
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
    case "no_analysis_revision":
      return "Record state unavailable — refresh";
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

// ---------------------------------------------------------------------------
// 4. The analysis revision — one comprehensive concurrency authority
// ---------------------------------------------------------------------------

/**
 * "Has this evidence changed since the operator selected it?"
 *
 * WHAT THIS REPLACED, AND WHY IT HAD TO BE REPLACED TWICE
 *
 * The AI routes first answered that question with
 * `Evidence.verificationPackageVersion`, read through a cast that could only
 * ever produce `undefined` and defaulted with `?? 0`. Every record arrived as
 * `v0` — including records the same page called "Package ready" — and the
 * server compared that fabricated 0 against a real 2 and refused. Fixing the
 * projection ended the false rejections but left the deeper problem: a package
 * counter is not a concurrency authority.
 *
 * The fields a Copilot actually sees are fixed by the server's context
 * allowlists, and only ONE of them moves the package version. Renaming a
 * record, correcting its MIME type, completing its integrity check, unlinking
 * it from the case, publishing a report, adding a part, archiving it or sending
 * it to trash all changed what the model would be told while the guard reported
 * no change whatsoever.
 *
 * So the authority is now an OPAQUE, SERVER-COMPUTED REVISION over the whole
 * relevant snapshot — `ear1_<43-character base64url SHA-256>` — built in
 * `@proovra/shared-runtime`, a package the browser bundle cannot import.
 *
 * The client CARRIES it and never interprets it. There is nothing here that
 * parses a revision into fields, compares them, or reasons about ordering:
 * revisions are equal or they are not, and only the server decides what a
 * revision means.
 *
 * Three states, still deliberately distinct:
 *
 *   string     the projection carried a revision, and this is it
 *   undefined  the projection carried none, so nothing is known — a REFUSAL,
 *              never a default
 *
 * There is no third "zero" state, because there is no arithmetic. That is the
 * point: `?? 0` is not expressible against an opaque token.
 */
export type EvidenceAnalysisRevision = string;

/** The schema prefix every revision this product accepts must carry. */
export const EVIDENCE_ANALYSIS_REVISION_PREFIX = "ear1_";

/**
 * The exact length of a well-formed revision: the prefix plus the FULL
 * base64url SHA-256. Stated so a truncated token is a shape error rather than
 * a silently weaker comparison.
 */
export const EVIDENCE_ANALYSIS_REVISION_LENGTH =
  EVIDENCE_ANALYSIS_REVISION_PREFIX.length + SHA256_BASE64URL_LENGTH;

/**
 * Is this the SHAPE of a revision this product issued?
 *
 * A shape check only. It says nothing about whether the revision is current,
 * whether it belongs to this record, or whether the actor may see the record —
 * the server answers all three by RECOMPUTING the revision from persisted state
 * and comparing. A well-formed forgery therefore gets exactly as far as a
 * malformed one, and no further.
 */
export function isEvidenceAnalysisRevision(value: unknown): value is EvidenceAnalysisRevision {
  return (
    typeof value === "string" &&
    value.length === EVIDENCE_ANALYSIS_REVISION_LENGTH &&
    value.startsWith(EVIDENCE_ANALYSIS_REVISION_PREFIX) &&
    /^[A-Za-z0-9_-]{43}$/.test(value.slice(EVIDENCE_ANALYSIS_REVISION_PREFIX.length))
  );
}

/**
 * Do a captured snapshot and the freshly recomputed revision agree?
 *
 * `undefined` on either side never matches: not knowing is not agreement. That
 * is the branch `?? 0` used to remove, and it is why a record whose revision
 * the projection failed to carry is refused rather than analyzed against a
 * guess.
 *
 * The comparison is a plain equality on opaque strings — there is nothing to
 * coerce, nothing to round, and no way to be "close enough".
 */
export function evidenceAnalysisRevisionsMatch(
  snapshot: EvidenceAnalysisRevision | undefined,
  current: EvidenceAnalysisRevision | undefined,
): boolean {
  if (snapshot === undefined || current === undefined) return false;
  if (!isEvidenceAnalysisRevision(snapshot) || !isEvidenceAnalysisRevision(current)) {
    return false;
  }
  return snapshot === current;
}

// ---------------------------------------------------------------------------
// 5. Package version — PRESENTATION ONLY
// ---------------------------------------------------------------------------

/**
 * How a verification-package version reads to an operator.
 *
 * DISPLAY ONLY. `verificationPackageVersion` remains a truthful thing to show —
 * "Package v2" is a real fact an operator wants — but it is no longer what
 * decides whether a selection is stale. Those two jobs were the same value for
 * a long time and that is exactly how a package counter ended up guarding a
 * fourteen-field prompt.
 *
 * Nothing in the concurrency path calls this, and nothing here returns anything
 * comparable.
 */
export function evidencePackageVersionLabel(
  version: number | null | undefined,
): string {
  if (version === undefined) return "Package state unavailable";
  if (version === null) return "No package recorded";
  return `Package v${version}`;
}
