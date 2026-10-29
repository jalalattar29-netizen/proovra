/**
 * WHAT A JUST-SEALED RECORD LACKS, said at once.
 *
 * Sealing succeeds without a trusted timestamp when the timestamp authority
 * does not answer; the record is still preserved, but the person finishing a
 * capture must not leave believing it carries a timestamp it does not. The
 * direct-capture completion routes do not return the timestamp outcome, so the
 * sealed record's own timestamp facts are read back and handed to THE shared
 * decision (`tsaCompletionNotice`), which picks the wording — a provider's raw
 * reason is never shown. Null means nothing is missing (or not known yet: a
 * pending timestamp is not a failure).
 */
import { tsaCompletionNotice } from "@proovra/shared";

export type SealedTimestampNotice = { tone: "warning"; title: string; message: string };

export function sealedTimestampNotice(evidence: unknown): SealedTimestampNotice | null {
  const e = evidence && typeof evidence === "object" ? (evidence as Record<string, unknown>) : null;
  if (!e) return null;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const notice = tsaCompletionNotice({
    tsaStatus: str(e.tsaStatus),
    tsaFailureCode: str(e.tsaFailureCode),
    tsaTokenPresent: typeof e.tsaTokenPresent === "boolean" ? e.tsaTokenPresent : null,
    tsaValidatedAtUtc: str(e.tsaValidatedAtUtc),
  });
  return notice ? { tone: "warning", title: notice.title, message: notice.message } : null;
}
