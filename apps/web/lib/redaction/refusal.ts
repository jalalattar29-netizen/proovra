import { identifierLabel } from "@proovra/shared";
import { toSafeUserError } from "../feedback/toSafeUserError";

/**
 * B5B-F-200 — THE redaction refusal sentence.
 *
 * The redaction routes refuse with a flat `{ denial }`, which `apiFetch`
 * carries on `error.details.denial` (lib/api.ts) — never on `error.denial`.
 * Several surfaces read `err.denial`, found nothing, and printed
 * "Refused: POLICY_REJECTED" for every refusal (a VIEWER's NOT_PERMITTED, a
 * plan refusal, terms 428, VERSION_LOCKED). This is the one reader, the
 * pattern `[projectId]/page.tsx` already used.
 */
export function redactionDenialOf(err: unknown): string | null {
  const e = err as { details?: { denial?: unknown }; denial?: unknown } | null;
  const denial = e?.details?.denial ?? e?.denial;
  return typeof denial === "string" && denial.length > 0 ? denial : null;
}

export function redactionRefusalMessage(err: unknown, fallback: string): string {
  const denial = redactionDenialOf(err);
  return denial ? `Refused: ${identifierLabel(denial)}` : toSafeUserError(err, { message: fallback }).message;
}

/** A read the workspace refused (403): a permission state, not "loading" or "empty". */
export function isRedactionReadDenied(err: unknown): boolean {
  return (err as { statusCode?: unknown } | null)?.statusCode === 403;
}

export const REDACTION_READ_DENIED_MESSAGE =
  "Your role in this workspace does not include redaction. Ask a workspace administrator for access.";

/** B5B-F-200 — a region the server refused to add is said, not silently dropped. */
export function regionAddFailureMessage(err: unknown): string {
  const denial = redactionDenialOf(err);
  if (denial === "VERSION_LOCKED") {
    return "This version is no longer a draft (it may have been submitted in another tab), so the region was not added. Create a new version to make further edits.";
  }
  if (denial === "NOT_PERMITTED") return "You don't have permission to add regions on this project.";
  return redactionRefusalMessage(err, "The region could not be added.");
}
