/**
 * F-16 (independent forward audit, 2026-10-21) — THE MAPPING of a record's
 * canonical output state (deriveEvidenceOutputState) onto the Reports list's
 * row vocabulary. It existed three times — the workspace aggregator, the web
 * Reports page (for its fallback) and the mobile Reports screen — and they
 * disagreed: the web mapped a BLOCKED package to "not_requested", mobile mapped
 * ARTIFACT_MISSING and ENTITLEMENT_UNAVAILABLE to "not_requested". One mapping
 * now, total over EvidenceOutputState (a new state is a compile error), read by
 * the server and both clients.
 */
import { EVIDENCE_OUTPUT_STATES, type EvidenceOutputState } from "./evidence-output-lifecycle.js";

export type OutputRowLifecycle =
  | "not_requested"
  | "pending"
  | "ready"
  /** ET-RPT-02 — blocked (stale policy, policy block, or a package gate). */
  | "blocked"
  | "failed"
  | "unavailable";

export function outputRowLifecycle(state: EvidenceOutputState): OutputRowLifecycle {
  switch (state) {
    case "READY":
      return "ready";
    case "QUEUED":
    case "GENERATING":
      return "pending";
    // AUD-011 — an issued file proven gone is a failure to hold the output.
    case "RETRYABLE_FAILURE":
    case "TERMINAL_FAILURE":
    case "ARTIFACT_MISSING":
      return "failed";
    case "NOT_INCLUDED":
    case "ENTITLEMENT_UNAVAILABLE":
      return "unavailable";
    // P1-3 — "this record cannot carry the output yet" is not a commercial
    // answer: nothing has been asked for. Consumers that need the distinction
    // read outputs.*.state.
    case "NOT_APPLICABLE":
    case "ELIGIBLE_NOT_GENERATED":
      return "not_requested";
    case "BLOCKED":
      return "blocked";
  }
}

/**
 * The same mapping for a value read off the wire: a state this client does not
 * know is "unavailable" — never "not requested", never ready.
 */
export function outputRowLifecycleOf(value: unknown): OutputRowLifecycle {
  return typeof value === "string" && (EVIDENCE_OUTPUT_STATES as readonly string[]).includes(value)
    ? outputRowLifecycle(value as EvidenceOutputState)
    : "unavailable";
}
