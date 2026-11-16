import * as shared from "@proovra/shared";
import { presentationContractSkew } from "@proovra/shared";

/**
 * AUD-32 (2026-10-20) — an open tab running an OLDER web build against a newer
 * API. Every API response states its presentation contract
 * (`x-proovra-contract`); when it is newer than the one this build was written
 * for, the user is told once to reload instead of reading a response through
 * rules that no longer describe it.
 *
 * OPS-015 — the other direction. The web deploys on its own and normally leads
 * the API, so a page can call routes the live API does not have yet. Reloading
 * does not help then: the user is told an update is finishing.
 */
export const CONTRACT_SKEW_EVENT = "proovra:contract-skew";
export type ContractSkewDetail = { direction: "CLIENT_OLDER" | "CLIENT_NEWER" };

let announced = false;

export function observeContractHeader(served: string | null | undefined): void {
  if (announced || typeof window === "undefined") return;
  const skew = presentationContractSkew(served);
  if (skew !== "CLIENT_OLDER" && skew !== "CLIENT_NEWER") return;
  announced = true;
  window.dispatchEvent(
    new CustomEvent<ContractSkewDetail>(CONTRACT_SKEW_EVENT, { detail: { direction: skew } }),
  );
}

/**
 * B8-F-402 (free-audit 0ea0) — the ROUTE table, not just the presentation
 * contract. Every API response now also carries `x-proovra-route-epoch`
 * (bumped whenever the API's route table changes). A page built against a
 * newer route table than the live API's (`routeEpochSkew` CLIENT_NEWER) may
 * call routes the API does not serve yet: the same "an update is finishing"
 * notice as OPS-015. An absent or malformed header (an older API) is UNKNOWN
 * and changes nothing; an older page (CLIENT_OLDER) is left to the contract
 * header, so a route ADDITION never asks anyone to reload.
 *
 * The build's own epoch is `PRESENTATION_CONTRACT_ROUTE_EPOCH` from
 * @proovra/shared when the package exports it, else 1 (the first epoch).
 */
export const ROUTE_EPOCH_HEADER = "x-proovra-route-epoch";

export function webRouteEpoch(): number {
  let value: unknown;
  try {
    value = (shared as Record<string, unknown>).PRESENTATION_CONTRACT_ROUTE_EPOCH;
  } catch {
    // A module double that does not define the export throws on access.
    value = undefined;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}

function positiveIntegerHeader(served: string | null | undefined): number | null {
  if (served === null || served === undefined) return null;
  const raw = String(served).trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** Mirrors @proovra/shared `routeEpochSkew` (main tree). */
export function routeEpochSkew(
  served: string | null | undefined,
  own: number = webRouteEpoch(),
): "UNKNOWN" | "CURRENT" | "CLIENT_OLDER" | "CLIENT_NEWER" {
  const n = positiveIntegerHeader(served);
  if (n === null) return "UNKNOWN";
  if (n === own) return "CURRENT";
  return n > own ? "CLIENT_OLDER" : "CLIENT_NEWER";
}

export function observeRouteEpochHeader(
  served: string | null | undefined,
  own: number = webRouteEpoch(),
): void {
  if (announced || typeof window === "undefined") return;
  if (routeEpochSkew(served, own) !== "CLIENT_NEWER") return;
  announced = true;
  window.dispatchEvent(
    new CustomEvent<ContractSkewDetail>(CONTRACT_SKEW_EVENT, {
      detail: { direction: "CLIENT_NEWER" },
    }),
  );
}

/** Tests only. */
export function resetContractSkewForTests(): void {
  announced = false;
}
