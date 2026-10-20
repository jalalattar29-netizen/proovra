/**
 * The public Verify "Record" tab: which record-metadata fields it shows, by label.
 *
 * Converged 2026-10-18: the tab states record metadata only. The record's
 * verification reference, report issuance, stored-file recheck and identity
 * are recordFacts (stated by the Record facts card); every verification
 * status is a matrix row. So the tab never carries "Evidence ID", a MIME
 * "File Type", a client-derived status or an identity field. Every label here
 * must be a label the page actually produces.
 */
export const RECORD_TAB_FIELD_LABELS: readonly string[] = [
  "Evidence Title",
  "Evidence Type",
  "Evidence Structure",
  "Acquisition",
  "Created At",
  "Server received at",
  "Uploaded At",
  "Signed At",
  "Last meaningful verification",
  "Last public verify page view",
  "Current public verify page view",
];

export function selectRecordTabFields<T extends { label: string }>(fields: readonly T[]): T[] {
  return fields.filter((field) => RECORD_TAB_FIELD_LABELS.includes(field.label));
}

/** AUD-17 (2026-10-20) — a claim of a token nobody validated is labelled as one. */
export function tsaClaimLabel(label: string, basis: string | null | undefined): string {
  return basis === "CLAIMED_BY_UNVALIDATED_TOKEN" ? `${label} (claimed by the token; not validated)` : label;
}
