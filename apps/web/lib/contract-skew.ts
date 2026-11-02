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

/** Tests only. */
export function resetContractSkewForTests(): void {
  announced = false;
}
