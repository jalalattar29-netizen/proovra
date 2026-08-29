"use client";

/**
 * Capture — "can I proceed?", answered once, immediately above the answer.
 *
 * THE INVARIANT THIS EXISTS TO HOLD
 * ---------------------------------------------------------------------------
 * `CaptureBottomBar` disables Review & Sign on
 * `finishDisabled = busy || !sessionReadiness.canFinalize`. Before this
 * component, that verdict reached the operator only as a greyed-out button:
 * the page knew precisely why it could not finalize and said so nowhere.
 *
 * So this takes THE SAME TWO VALUES the bottom bar takes — `canFinalize` and
 * `busy` — and renders the sentence. It cannot disagree with the button
 * because it is not a second opinion: there is no rule evaluated here, no
 * threshold, no re-reading of items. `readiness` arrives already decided by
 * `computeSessionReadiness`, the one authority, and this file's whole job is
 * choosing which of its fields to put on screen.
 *
 * The reasons are the authority's own: `readiness.blockers[0].label` is the
 * same string `session-workflow.ts` exposes as `finishReason`. Nothing here
 * invents a reason, and when the authority offers none the copy says only
 * that the session is not ready — never a guess at why.
 *
 * It also carries the outstanding required steps by name. That list used to
 * sit in `CaptureBottomBar`, directly below this component, under a second
 * headline drawn from the same first blocker — the operator read one verdict
 * twice and had to notice the two boxes agreed. The bar now carries the
 * actions and the progress; the sentence is here, once.
 *
 * The server stays authoritative. A green verdict here is the CLIENT's
 * projection of client-side readiness; finalization still validates
 * server-side and may still refuse.
 */

import { CircleAlert, CircleCheck, Loader } from "lucide-react";

import type { SessionReadiness } from "./session-readiness";

/**
 * The supporting line for a session that CAN finalize.
 *
 * Facts the authority already counted — never a claim about the evidence
 * itself, and never the word "verified" about anything the platform has not
 * verified.
 */
function readyDetail(readiness: SessionReadiness): string {
  const { totalItems, requiredTotal, requiredCompleted } = readiness.summary;
  const materials = `${totalItems} material${totalItems === 1 ? "" : "s"} added`;
  const mapped =
    requiredTotal > 0
      ? `${requiredCompleted}/${requiredTotal} required items mapped`
      : "No required items outstanding";
  return `${materials} · ${mapped}`;
}

/**
 * The supporting line for a session that CANNOT.
 *
 * Strictly the authority's first blocker. `busy` is surfaced separately
 * because it is transient work, not an unmet requirement — telling an
 * operator that an in-flight upload is a "blocker" would send them looking
 * for something to fix.
 */
function notReadyDetail(readiness: SessionReadiness, busy: boolean): string {
  if (busy) return "Finishing the current operation.";
  const first = readiness.blockers[0];
  if (first) return first.detail?.trim() || first.label;
  const outstanding =
    readiness.summary.requiredTotal - readiness.summary.requiredCompleted;
  if (outstanding > 0) {
    return `${outstanding} required item${outstanding === 1 ? "" : "s"} still ${
      outstanding === 1 ? "needs" : "need"
    } evidence.`;
  }
  return "This session cannot be finalized yet.";
}

export function CaptureFinalReadiness({
  readiness,
  busy,
}: {
  readiness: SessionReadiness;
  /** The SAME flag `finishDisabled` folds in. Passed, never recomputed. */
  busy: boolean;
}) {
  // Byte-for-byte the bottom bar's own predicate. If this line and
  // `finishDisabled` ever drift, they drift together.
  const ready = !busy && readiness.canFinalize;
  const extra = readiness.blockers.length > 1 ? readiness.blockers.length - 1 : 0;
  // The complete list, which the bottom bar used to print underneath this in a
  // second verdict of its own. One statement, and it is this one.
  const missing = readiness.missingRequiredSteps.map((step) => step.title);

  return (
    <section
      className="capture-final-readiness"
      data-capture-final-readiness={ready ? "ready" : "not_ready"}
      data-capture-can-finalize={readiness.canFinalize ? "true" : "false"}
      data-capture-busy={busy ? "true" : "false"}
      aria-live="polite"
    >
      <span className="capture-final-readiness__icon" aria-hidden="true">
        {busy ? (
          <Loader size={18} strokeWidth={2.2} />
        ) : ready ? (
          <CircleCheck size={18} strokeWidth={2.2} />
        ) : (
          <CircleAlert size={18} strokeWidth={2.2} />
        )}
      </span>

      <div className="capture-final-readiness__copy">
        {/* The verdict as WORDS. Colour repeats it; it never carries it. */}
        <strong>{ready ? "Ready to finalize" : "Not ready to finalize"}</strong>
        <p>
          {ready ? readyDetail(readiness) : notReadyDetail(readiness, busy)}
          {!ready && extra > 0 ? ` (+${extra} more)` : ""}
        </p>
        {!ready && missing.length > 0 ? (
          <small className="capture-final-readiness__missing">
            Still unmapped: {missing.join(", ")}
          </small>
        ) : null}
      </div>
    </section>
  );
}

export default CaptureFinalReadiness;
