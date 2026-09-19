/**
 * Runtime legal-gate interceptor (Phase 4). When any authorized call returns
 * HTTP 428 LEGAL_REACCEPT_REQUIRED, the API layer calls triggerLegalGate, which
 * routes to the legal-acceptance screen carrying the interrupted destination so
 * the action can resume after acceptance. Idempotent — re-entry while already
 * on the legal screen is ignored so a status re-check cannot loop.
 */
import { router } from "expo-router";

let navigating = false;

export function triggerLegalGate(missingPolicies: string[]): void {
  if (navigating) return;
  navigating = true;
  try {
    router.push({
      pathname: "/legal-acceptance",
      params: missingPolicies.length ? { policies: missingPolicies.join(",") } : {},
    });
  } catch {
    /* router not ready (pre-mount) — the bootstrap legal-status check covers it */
  } finally {
    // release shortly after so a later, legitimate gate can fire again
    setTimeout(() => {
      navigating = false;
    }, 1500);
  }
}
