/**
 * Runtime legal-gate interceptor (Phase 4). When any authorized call returns
 * HTTP 428 LEGAL_REACCEPT_REQUIRED, the API layer calls triggerLegalGate, which
 * routes to the legal-acceptance screen carrying the interrupted destination so
 * the action can resume after acceptance. Idempotent — re-entry while already
 * on the legal screen is ignored so a status re-check cannot loop.
 */
import { router } from "expo-router";

/**
 * NAT-LEGAL-04 (Free audit 0ea0, SN-0051) — where the gate may send the person
 * once it is done: an in-app path only, and never the gate itself. A `next`
 * naming the gate re-opened it on every pass (status ok → replace → status ok
 * …); a `//host` or `/\host` is not an in-app path. Null means "no
 * destination": the gate then returns to the screen beneath it.
 */
export function safeLegalGateNext(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;
  const path = raw.split(/[?#]/)[0] ?? "";
  const segments = path.split("/").filter((s) => s && !(s.startsWith("(") && s.endsWith(")")));
  if (segments[0] === "legal-acceptance") return null;
  return raw;
}

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
