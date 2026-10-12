import type { CanonicalFactsFinding } from "@proovra/shared";

/**
 * A refused output: what was rendered or sealed does not state the record's
 * facts, or is not a usable artifact. Deterministic — the same inputs fail the
 * same way — so it is never retried. Kept free of the database client so the
 * renderer can raise it too (report-v2/render-pdf.ts, the layout audit).
 */
export class OutputVerificationError extends Error {
  readonly retriable = false;
  constructor(
    readonly code:
      | "REPORT_RENDER_INPUT_INCONSISTENT"
      | "REPORT_OUTPUT_INCONSISTENT"
      | "PACKAGE_OUTPUT_INCONSISTENT"
      /** The rendered PDF could not be read back at all, so it was not checked and is never issued. */
      | "REPORT_PDF_VERIFICATION_FAILED",
    readonly findings: CanonicalFactsFinding[],
  ) {
    super(`${code}: ${findings.slice(0, 5).map((f) => `${f.check} (${f.detail})`).join("; ")}`);
    this.name = "OutputVerificationError";
  }
}
