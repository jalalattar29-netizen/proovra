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

/**
 * B8-F-401 / B8-F-402 (free-audit 0ea0) — A DERIVED COMPATIBILITY SIGNAL.
 *
 * ROUTE EPOCH — increments every time the API's route table changes. It is
 * derived, not remembered: `scripts/presentation-contract-manifest.mjs`
 * records the route table beside it, and the API unit suite fails when the
 * table and the epoch disagree. Sent on every response as
 * `x-proovra-route-epoch`. A client built for a HIGHER epoch than the API
 * serves is ahead of the API (web ships to production on every merge; the API
 * deploys by hand), so it may call routes the live API does not have yet.
 *
 * MINIMUM CLIENT CONTRACT — the oldest presentation contract this API still
 * serves correctly, sent as `x-proovra-min-client-contract`. A native or
 * extension build whose own PRESENTATION_CONTRACT_VERSION is below it must
 * ask the person to update instead of misreading responses.
 *
 * Both headers are ADDITIVE: an older client ignores them, and a newer client
 * reading an older API (which sends neither) gets UNKNOWN and changes nothing.
 */
export const PRESENTATION_CONTRACT_ROUTE_EPOCH = 1;
export const PRESENTATION_CONTRACT_ROUTE_EPOCH_HEADER = "x-proovra-route-epoch";
export const PRESENTATION_CONTRACT_MIN_CLIENT = 1;
export const PRESENTATION_CONTRACT_MIN_CLIENT_HEADER = "x-proovra-min-client-contract";

function positiveIntegerHeader(served: string | null | undefined): number | null {
  if (served === null || served === undefined) return null;
  const raw = String(served).trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * How the API's route epoch compares with the one this client was built for.
 * CLIENT_NEWER = the client is ahead of the API (it may call routes the API
 * lacks); CLIENT_OLDER = the API added routes since (harmless on its own).
 */
export function routeEpochSkew(
  served: string | null | undefined,
  own: number = PRESENTATION_CONTRACT_ROUTE_EPOCH,
): PresentationContractSkew {
  const n = positiveIntegerHeader(served);
  if (n === null) return "UNKNOWN";
  if (n === own) return "CURRENT";
  return n > own ? "CLIENT_OLDER" : "CLIENT_NEWER";
}

/**
 * True only when the API states a minimum client contract and this client's
 * own contract is below it — the "update required" gate for native and the
 * extension. An absent or malformed header never blocks (older APIs).
 */
export function clientBelowMinimumContract(
  servedMinimum: string | null | undefined,
  own: number = PRESENTATION_CONTRACT_VERSION,
): boolean {
  const n = positiveIntegerHeader(servedMinimum);
  return n !== null && own < n;
}
