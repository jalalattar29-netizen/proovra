import { TRASH_KEEPS_PLAN_CAPACITY_COPY } from "@proovra/shared";

/**
 * What moving a record to trash does — the body of the trash confirmation.
 *
 * EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — this said only that trash "is
 * operational retention handling and must not be confused with technical
 * integrity failure", which told the user what trash is NOT and nothing about
 * what it does. It now says what happens, in the order a person about to click
 * needs it: nothing is deleted, the record comes back, and any retention on it
 * still applies.
 *
 * ET-COM-02 (2026-09-30) — and it releases no plan capacity: trash is
 * reversible, so the record keeps its place in the allowance. The sentence is
 * the shared one the native app and the bulk dialog also show.
 */
export function EvidenceTrashConsequence() {
  return (
    <>
      <p>
        Nothing is deleted. The record leaves Active evidence and can be
        restored from Trash; its content, custody history and verification
        state are unchanged.
      </p>
      <p>
        Any retention or legal hold on this record continues to apply in Trash
        — moving it here does not shorten either.
      </p>
      <p data-evidence-trash-capacity-note>{TRASH_KEEPS_PLAN_CAPACITY_COPY}</p>
    </>
  );
}
