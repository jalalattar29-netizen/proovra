/**
 * AUD-32 (2026-10-20) — THE PRESENTATION CONTRACT BETWEEN THE API AND ITS CLIENTS.
 *
 * The web app computes much of its presentation locally from what the API
 * serves (statuses, matrix rows, qualifiers). Web, API and worker deploy
 * separately, so for a while an open browser tab can run an OLDER web build
 * against a NEWER API — and read a new status or field through old rules.
 * Nothing said so.
 *
 * Every API response now carries this contract version. A client built for an
 * older contract tells its user to reload instead of silently interpreting a
 * response it was not written for. Bump the number whenever a response shape a
 * client interprets changes incompatibly.
 */
export const PRESENTATION_CONTRACT_VERSION = 1;
export const PRESENTATION_CONTRACT_HEADER = "x-proovra-contract";

export type PresentationContractSkew = "CURRENT" | "CLIENT_OLDER" | "CLIENT_NEWER" | "UNKNOWN";

/** How the served contract compares with the one this build was written for. */
export function presentationContractSkew(
  served: string | null | undefined,
  own: number = PRESENTATION_CONTRACT_VERSION,
): PresentationContractSkew {
  if (served === null || served === undefined || String(served).trim() === "") return "UNKNOWN";
  const n = Number(String(served).trim());
  if (!Number.isInteger(n) || n < 1) return "UNKNOWN";
  if (n === own) return "CURRENT";
  return n > own ? "CLIENT_OLDER" : "CLIENT_NEWER";
}
