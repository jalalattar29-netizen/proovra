import { presentationContractSkew } from "@proovra/shared";

/**
 * AUD-32 (2026-10-20) — an open tab running an OLDER web build against a newer
 * API. Every API response states its presentation contract
 * (`x-proovra-contract`); when it is newer than the one this build was written
 * for, the user is told once to reload instead of reading a response through
 * rules that no longer describe it.
 */
export const CONTRACT_SKEW_EVENT = "proovra:contract-skew";

let announced = false;

export function observeContractHeader(served: string | null | undefined): void {
  if (announced || typeof window === "undefined") return;
  if (presentationContractSkew(served) !== "CLIENT_OLDER") return;
  announced = true;
  window.dispatchEvent(new CustomEvent(CONTRACT_SKEW_EVENT));
}

/** Tests only. */
export function resetContractSkewForTests(): void {
  announced = false;
}
