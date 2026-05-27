"use client";

/**
 * Phase C3 — Reviewer re-request banner.
 *
 * Surfaces the operational "the workspace asked for more" signal
 * (`EvidenceRequest.status === NEEDS_MORE_INFO`) so the contributor
 * understands they need to re-engage with the link.
 *
 * Hard rules:
 *   * Never exposes reviewer notes (the backend's public projection
 *     deliberately omits `reviewerNote`). The banner is intentionally
 *     terse — the contributor sees WHAT to do, not internal
 *     correspondence.
 *   * Points to the specific deliverables still PENDING /
 *     PARTIALLY_FULFILLED / REJECTED so the contributor knows which
 *     items remain.
 */

import type { IntakeDeliverable } from "./IntakeChecklist";

export function IntakeReReviewBanner({
  deliverables,
}: {
  deliverables: ReadonlyArray<IntakeDeliverable>;
}) {
  const blocking = deliverables.filter(
    (d) =>
      d.status === "PENDING" ||
      d.status === "PARTIALLY_FULFILLED" ||
      d.status === "REJECTED",
  );
  const requiredBlocking = blocking.filter((d) => d.required);

  return (
    <section
      data-intake-rerequest-banner
      role="alert"
      style={{
        marginBottom: 16,
        padding: "12px 14px",
        border: "1px solid #fecaca",
        borderRadius: 8,
        background: "#fef2f2",
      }}
    >
      <strong style={{ fontSize: 14, color: "#991b1b" }}>
        The workspace asked for more
      </strong>
      <p style={{ margin: "4px 0 0", fontSize: 13, color: "#7f1d1d" }}>
        A reviewer has marked this request as needing more information. Check
        the checklist below for the items they still need, then upload or
        re-upload as required.
      </p>
      {requiredBlocking.length > 0 ? (
        <ul
          data-intake-rerequest-blocking
          style={{
            margin: "8px 0 0",
            paddingLeft: 20,
            fontSize: 13,
            color: "#7f1d1d",
          }}
        >
          {requiredBlocking.slice(0, 10).map((d) => (
            <li key={d.id}>
              <strong>{d.title}</strong>
              {d.status === "REJECTED"
                ? " — reviewer rejected the previous file. Please upload a replacement."
                : d.status === "PARTIALLY_FULFILLED"
                  ? ` — ${d.fulfilledCount} of ${d.minCount} received so far.`
                  : " — not yet provided."}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
