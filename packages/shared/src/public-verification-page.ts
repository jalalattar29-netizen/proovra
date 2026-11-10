/**
 * THE verification page of a record, as Public Verify would answer it.
 *
 * Every finalized record has a page, on every plan; the owner can withdraw it,
 * and an operator can suspend it. This is a fact about the record's own access
 * state — never about an anchoring or timestamping setting, which is shown
 * separately. One function for every surface (web inspector, native
 * inspector), so the row cannot say "Not configured" on one app while the page
 * opens on the other (AUD-0027; web OPS-001).
 */
export type PublicVerificationPageState = {
  state: "available" | "restricted" | "pending" | "missing";
  detail: string;
};

export function publicVerificationPageState(
  evidence: {
    status?: string | null;
    verificationAccessState?: string | null;
    verificationDisclosureMode?: string | null;
  } | null,
): PublicVerificationPageState {
  if (!evidence) return { state: "missing", detail: "The record could not be read." };
  const access = String(evidence.verificationAccessState ?? "AVAILABLE");
  if (access === "WITHDRAWN") return { state: "restricted", detail: "The owner withdrew this record's verification page." };
  if (access === "SUSPENDED") return { state: "restricted", detail: "This record's verification page is suspended." };
  const status = String(evidence.status ?? "");
  if (status !== "SIGNED" && status !== "REPORTED") {
    return { state: "pending", detail: "The verification page opens when the record is sealed." };
  }
  return {
    state: "available",
    detail:
      evidence.verificationDisclosureMode === "CONTENT_PREVIEW"
        ? "Open to anyone with its reference, with a content preview."
        : "Open to anyone with its reference, verification only.",
  };
}
