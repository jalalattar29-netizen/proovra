/**
 * READING THE SERVER'S GENERATION OUTCOME.
 *
 * ===========================================================================
 * RELIABILITY CLOSURE (2026-09-09)
 * ===========================================================================
 * `POST /v1/evidence/:id/reports/regenerate` answers 202 for every outcome —
 * accepted, collapsed, refused, blocked, terminal, or lost to a queue outage —
 * because from the caller's side the REQUEST was made either way. Three
 * surfaces read that response and all three got it wrong in the same direction:
 *
 *   * Evidence Detail mapped every `enqueued: false` except one to "Generation
 *     is already under way for this record.";
 *   * the Reports page did the same;
 *   * the AI Copilot did not read the body at all — it treated the absence of a
 *     thrown error as success and always said the work had been "queued through
 *     the standard audited workflow", including for a request the server had
 *     just refused.
 *
 * So a customer whose record was permanently locked out, and one whose request
 * had been lost to a Redis outage that nothing would reconcile, were both told
 * their report was being generated.
 *
 * The server now returns a typed `outcome` and a safe `message`. This module is
 * how a surface consumes them, and it exists so the three consumers cannot
 * drift again.
 */

import {
  generationOutcomeAcceptedWork,
  GENERATION_REQUEST_OUTCOMES,
  type GenerationRequestOutcome,
} from "@proovra/shared";

/** The shape the regenerate endpoint returns. Every field is optional on the
 *  wire because an older deployment may not send the new ones. */
export type GenerationResponse = {
  enqueued?: boolean;
  reason?: string | null;
  outcome?: string | null;
  message?: string | null;
};

/** Tone for the toast/notice a surface renders. */
export type GenerationOutcomeTone = "success" | "info" | "error";

export type ReadGenerationOutcome = {
  outcome: GenerationRequestOutcome;
  /** Safe, human sentence. The SERVER's when it sent one. */
  message: string;
  tone: GenerationOutcomeTone;
  /** Did this put new work into the system? The question every surface asked wrongly. */
  acceptedWork: boolean;
};

/**
 * The client-side fallback sentences.
 *
 * DELIBERATELY A FALLBACK, NOT THE AUTHORITY. The server sends `message` and it
 * is preferred, so there is one place to change wording. These exist only for a
 * response from a deployment that predates the typed outcome, and they say the
 * same things.
 */
const FALLBACK_MESSAGE: Record<GenerationRequestOutcome, string> = {
  ENQUEUED:
    "Generation requested. The report and verification package will appear here when they complete.",
  SUPERSEDED:
    "Generation requested. The earlier attempt is kept as history; this is a new request.",
  ALREADY_ACTIVE: "Generation is already under way for this record.",
  QUEUE_UNAVAILABLE:
    "We could not schedule generation right now. The request is saved and will be picked up automatically; the record is unaffected.",
  NOT_INCLUDED:
    "Reports and verification packages are not included for this evidence record.",
  RECOVERABLE_BLOCKED:
    "Generation is currently blocked for this record. It becomes possible again when the block is lifted.",
  TERMINAL:
    "The previous generation attempt stopped and cannot be retried in its current state.",
  REQUEST_PERSIST_FAILED:
    "We could not record the request. Please try again; the record is unaffected.",
  EVIDENCE_NOT_FOUND: "This evidence record is not available.",
  // P2-1 (2026-09-10) — this used to be answered with the sentence above, on a
  // record the customer could see, open and download from.
  WORKSPACE_UNRESOLVED:
    "This older evidence record needs a workspace association before new output generation can be requested. Its existing materials are unaffected.",
  REQUESTER_REQUIRED: "This request could not be attributed and was not made.",
};

/**
 * How loudly to say it.
 *
 * `QUEUE_UNAVAILABLE` is INFO rather than ERROR on purpose: nothing was lost,
 * the durable row exists and a reconciler owns it, and the customer's record is
 * untouched. Shouting at them about a transient scheduling failure they cannot
 * act on would be the same overstatement in the opposite direction from the one
 * this closure fixes.
 */
const TONE: Record<GenerationRequestOutcome, GenerationOutcomeTone> = {
  ENQUEUED: "success",
  SUPERSEDED: "success",
  ALREADY_ACTIVE: "info",
  QUEUE_UNAVAILABLE: "info",
  NOT_INCLUDED: "info",
  RECOVERABLE_BLOCKED: "info",
  TERMINAL: "info",
  REQUEST_PERSIST_FAILED: "error",
  EVIDENCE_NOT_FOUND: "error",
  /*
   * P2-1 — INFO, not ERROR. Nothing failed and nothing was lost: the record is
   * intact, its existing artifacts are downloadable, and one field is missing.
   * An error tone here would tell the customer their evidence was damaged.
   */
  WORKSPACE_UNRESOLVED: "info",
  REQUESTER_REQUIRED: "error",
};

function isOutcome(value: unknown): value is GenerationRequestOutcome {
  return (
    typeof value === "string" &&
    (GENERATION_REQUEST_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * Turn a generation response into what to show.
 *
 * THE COMPATIBILITY BRANCH MATTERS. A response with no `outcome` came from a
 * deployment that predates this contract, and the only thing it can be read
 * from is `enqueued`. That is the ambiguous boolean this whole change exists to
 * replace, so it degrades to the two answers it can actually support —
 * ENQUEUED, or ALREADY_ACTIVE — and never invents one of the specific ones it
 * cannot know.
 */
export function readGenerationOutcome(
  response: GenerationResponse | null | undefined,
): ReadGenerationOutcome {
  const outcome: GenerationRequestOutcome = isOutcome(response?.outcome)
    ? response.outcome
    : response?.enqueued === true
      ? "ENQUEUED"
      : "ALREADY_ACTIVE";

  const serverMessage =
    typeof response?.message === "string" && response.message.trim().length > 0
      ? response.message.trim()
      : null;

  return {
    outcome,
    message: serverMessage ?? FALLBACK_MESSAGE[outcome],
    tone: TONE[outcome],
    acceptedWork: generationOutcomeAcceptedWork(outcome),
  };
}
