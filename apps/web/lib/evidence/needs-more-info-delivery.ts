/**
 * PRO-I1-01 (release order) — what the API that answered does with a
 * needs-more-info reviewer note.
 *
 * The web deploys before the API. The API that fixes PRO-I1-01 keeps the
 * reviewer note inside the workspace and emails only the separate
 * `contributorMessage`; it says so with `needsMoreInfoDelivery` on every
 * request projection. An API without that field (the one still deployed when
 * this web build ships) REQUIRES the note, emails it to the request's email
 * recipient as the reason, and silently drops `contributorMessage`.
 *
 * So the surfaces promise "stays internal" and offer the contributor field
 * only on the confirmed answer; anything else is treated as the older API and
 * the copy says the note is emailed. Unknown never reads as internal.
 */
export type NeedsMoreInfoDelivery = {
  reviewerNote?: string | null;
  contributorMessage?: boolean | null;
} | null;

export type NeedsMoreInfoDeliveryCarrier = {
  needsMoreInfoDelivery?: NeedsMoreInfoDelivery;
};

/** True only when the server confirmed the note is not sent to the contributor. */
export function reviewerNoteStaysInternal(
  request: NeedsMoreInfoDeliveryCarrier | null | undefined,
): boolean {
  const delivery = request?.needsMoreInfoDelivery;
  return (
    !!delivery &&
    typeof delivery === "object" &&
    delivery.reviewerNote === "INTERNAL" &&
    delivery.contributorMessage === true
  );
}

/** Copy for an API that still emails the note (shared by both web surfaces). */
export const LEGACY_NEEDS_MORE_INFO_COPY = {
  explanation:
    "When the request has an email recipient, the note below is emailed to them as the reason more is needed. Write only what the contributor may read. The note is also attached to the audit event.",
  noteLabel: "Note (emailed to the contributor, required)",
} as const;
