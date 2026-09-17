/**
 * D16 — per-row bulk invitation outcomes as product sentences.
 *
 * `portal-bulk-invitations.service.ts` answers each row with an `outcome`
 * (INVITED / FAILED / DUPLICATE / INVALID_EMAIL / POLICY_DENIED) and a
 * bounded `denial` code. The grant service folds every refusal it makes
 * (a scope target outside this workspace, a missing target, an expiry
 * outside 15 minutes to 30 days) into POLICY_REJECTED, so that code is
 * explained by what it can mean, not by a guess at which one it was.
 */

export type BulkOutcomeRowLike = {
  outcome: string;
  grantId: string | null;
  denial: string | null;
};

const DENIAL_SENTENCES: Readonly<Record<string, string>> = {
  POLICY_REJECTED:
    "Not issued. The chosen record can't be shared from this workspace, or the invitation settings are outside policy (the link must expire between 15 minutes and 30 days from now).",
  invalid_email_shape: "Not issued. This is not a valid email address.",
  duplicate_in_batch: "Not issued. This email appears more than once in this batch.",
  NOT_PERMITTED: "Not issued. You do not have permission to invite external reviewers.",
  STEP_UP_CANCELLED: "Not issued. Identity confirmation was cancelled, so nothing was sent.",
  RATE_LIMITED: "Not issued. Too many requests — wait a moment and try again.",
};

/** The sentence an operator reads for a row, or null when it was issued. */
export function bulkOutcomeReason(row: BulkOutcomeRowLike): string | null {
  if (row.outcome === "INVITED") return null;
  // A FAILED row that carries a grant id: the grant exists, the email did not go.
  if (row.outcome === "FAILED" && row.grantId) {
    return "Access was created, but the invitation email could not be sent. Resend it from the invitation list.";
  }
  if (row.denial && DENIAL_SENTENCES[row.denial]) return DENIAL_SENTENCES[row.denial];
  switch (row.outcome) {
    case "POLICY_DENIED":
      return DENIAL_SENTENCES.POLICY_REJECTED;
    case "INVALID_EMAIL":
      return DENIAL_SENTENCES.invalid_email_shape;
    case "DUPLICATE":
      return DENIAL_SENTENCES.duplicate_in_batch;
    default:
      return "Not issued. Try again; if it keeps failing, contact support with the code shown.";
  }
}

export type BulkIssueTally = {
  total: number;
  /** Rows whose grant was written AND whose invitation email was sent. */
  issued: number;
  /** Rows whose grant was written but whose email failed. */
  undelivered: number;
  /** Rows with no grant written. */
  notIssued: number;
};

export function tallyBulkOutcome(rows: ReadonlyArray<BulkOutcomeRowLike>): BulkIssueTally {
  let issued = 0;
  let undelivered = 0;
  let notIssued = 0;
  for (const r of rows) {
    if (r.outcome === "INVITED") issued += 1;
    else if (r.grantId) undelivered += 1;
    else notIssued += 1;
  }
  return { total: rows.length, issued, undelivered, notIssued };
}

/** The console banner for a completed batch. Counts only issued rows as sent. */
export function bulkIssueBannerText(tally: BulkIssueTally, listReloaded: boolean): string {
  const parts = [
    `Issued ${tally.issued} of ${tally.total} invitation${tally.total === 1 ? "" : "s"}.`,
  ];
  if (tally.undelivered > 0) {
    parts.push(
      `${tally.undelivered} ${tally.undelivered === 1 ? "was" : "were"} created but the email could not be sent — resend from the list.`,
    );
  }
  if (tally.notIssued > 0) {
    parts.push(
      `${tally.notIssued} ${tally.notIssued === 1 ? "was" : "were"} not issued — see the reason on each row.`,
    );
  }
  if (!listReloaded) {
    parts.push("The invitation list could not be reloaded; refresh the page to see the current list.");
  }
  return parts.join(" ");
}
