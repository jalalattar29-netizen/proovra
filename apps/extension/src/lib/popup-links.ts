/**
 * Where the popup may send the user after a capture — pure, so it is tested.
 *
 * Free audit F-27b / F-11b. A quota or plan refusal said "add evidence credits
 * or upgrade" and offered only "Try again", which cannot change a plan; a
 * success said "Preserved" with no way to open the record. Both now link to
 * the PROOVRA web app — but only to two fixed paths on the CONFIGURED web
 * origin (build-time PROOVRA_WEB_ORIGIN). Nothing from a page or a server
 * message is ever part of the URL; the record id is the server's own id,
 * path-encoded. With no web origin configured there is no link at all.
 */
import type { CaptureStatus } from "./capture-registry.js";
import { sharedCommercialCopy } from "./denial-copy.js";

/**
 * Refusals a plan, credit or billing change resolves (denial-copy.ts). A retry
 * cannot fix any of them, so the popup offers the plans page instead of
 * "Try again". RATE_LIMITED is not here: waiting and retrying does fix it.
 */
export const COMMERCIAL_DENIALS: ReadonlySet<string> = new Set([
  "FREE_LIMIT_REACHED",
  "EVIDENCE_RECORD_LIMIT_REACHED",
  "EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED",
  "INSUFFICIENT_CREDITS",
  "INSUFFICIENT_EVIDENCE_CREDITS",
  "STORAGE_LIMIT_REACHED",
  "SUBSCRIPTION_INACTIVE",
  "TEAM_PLAN_REQUIRED",
  "ENTITLEMENT_REQUIRED",
  "UPGRADE_REQUIRED",
  // B4-F-100 — the lapsed-plan allowance and the no-allowance credit refusal.
  "PLAN_LAPSED_ALLOWANCE_EXHAUSTED",
  "CREDIT_REQUIRED_NONE_AVAILABLE",
]);

/**
 * B4-F-100 — also any refusal the shared registry routes to billing, so a
 * commercial code added there is never offered a Retry here.
 */
export function isCommercialDenial(denial: string | null | undefined): boolean {
  return typeof denial === "string" && (COMMERCIAL_DENIALS.has(denial) || sharedCommercialCopy(denial) !== null);
}

/**
 * Refusals no retry can change and no plan resolves: the terms gate (A1-06,
 * accepted in PROOVRA) and the managed-identity personal-space refusal
 * (choose an organization workspace instead).
 */
export const TERMS_DENIAL = "LEGAL_REACCEPT_REQUIRED";
const NOT_RETRYABLE_DENIALS: ReadonlySet<string> = new Set([
  TERMS_DENIAL,
  "MANAGED_IDENTITY_NO_PERSONAL_SPACE",
  "PERSONAL_SPACE_UNAVAILABLE",
]);

/** PURE — the configured web origin as an http(s) origin, or null. */
export function safeWebOrigin(configured: string | null | undefined): string | null {
  if (!configured) return null;
  try {
    const u = new URL(configured);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export type FollowUpLink = { label: string; url: string };

export const OPEN_RECORD_LABEL = "Open the record in PROOVRA";
export const VIEW_PLANS_LABEL = "View plans in PROOVRA";
export const ACCEPT_TERMS_LABEL = "Accept the updated terms in PROOVRA";
export const CHECK_LIBRARY_LABEL = "Check your Evidence library in PROOVRA";

/** PURE — the one follow-up link for a finished capture, or null. */
export function followUpLink(s: CaptureStatus | null, configuredWebOrigin: string | null | undefined): FollowUpLink | null {
  const origin = safeWebOrigin(configuredWebOrigin);
  if (!origin || !s) return null;
  if (s.state === "SUCCEEDED" && s.evidenceId) {
    return { label: OPEN_RECORD_LABEL, url: `${origin}/evidence/${encodeURIComponent(s.evidenceId)}` };
  }
  if (s.state === "FAILED" && s.outcome === "UNKNOWN") {
    // B4-F-107 — the seal may have happened: send the person to look first,
    // to the reserved record when its id is known (the server's own id).
    return s.evidenceId
      ? { label: CHECK_LIBRARY_LABEL, url: `${origin}/evidence/${encodeURIComponent(s.evidenceId)}` }
      : { label: CHECK_LIBRARY_LABEL, url: `${origin}/evidence` };
  }
  if (s.state === "FAILED" && s.reason === "DENIED" && isCommercialDenial(s.denial)) {
    return { label: VIEW_PLANS_LABEL, url: `${origin}/billing` };
  }
  if (s.state === "FAILED" && s.denial === TERMS_DENIAL) {
    // B4-F-106 — any signed-in PROOVRA page opens the acceptance step.
    return { label: ACCEPT_TERMS_LABEL, url: `${origin}/home` };
  }
  return null;
}

/** PURE — whether "Try again" is offered for a capture status. */
export function retryOffered(s: CaptureStatus | null, hasWorkspaces: boolean): boolean {
  if (!s || s.state !== "FAILED" || !hasWorkspaces) return false;
  if (s.reason === "SIGNED_OUT") return false;
  // B4-F-107 — the first attempt may have sealed (a record, and a Free slot):
  // a new attempt could record the page twice. The library is checked first.
  if (s.outcome === "UNKNOWN") return false;
  // A plan, credit or storage refusal is not fixed by trying again.
  if (s.reason === "DENIED" && isCommercialDenial(s.denial)) return false;
  // B4-F-106 / B4-F-100 — the terms gate and the personal-space refusal neither.
  if (s.denial && NOT_RETRYABLE_DENIALS.has(s.denial)) return false;
  return true;
}
