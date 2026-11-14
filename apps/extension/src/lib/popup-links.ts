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
]);

export function isCommercialDenial(denial: string | null | undefined): boolean {
  return typeof denial === "string" && COMMERCIAL_DENIALS.has(denial);
}

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

/** PURE — the one follow-up link for a finished capture, or null. */
export function followUpLink(s: CaptureStatus | null, configuredWebOrigin: string | null | undefined): FollowUpLink | null {
  const origin = safeWebOrigin(configuredWebOrigin);
  if (!origin || !s) return null;
  if (s.state === "SUCCEEDED" && s.evidenceId) {
    return { label: OPEN_RECORD_LABEL, url: `${origin}/evidence/${encodeURIComponent(s.evidenceId)}` };
  }
  if (s.state === "FAILED" && s.reason === "DENIED" && isCommercialDenial(s.denial)) {
    return { label: VIEW_PLANS_LABEL, url: `${origin}/billing` };
  }
  return null;
}

/** PURE — whether "Try again" is offered for a capture status. */
export function retryOffered(s: CaptureStatus | null, hasWorkspaces: boolean): boolean {
  if (!s || s.state !== "FAILED" || !hasWorkspaces) return false;
  if (s.reason === "SIGNED_OUT") return false;
  // A plan, credit or storage refusal is not fixed by trying again.
  if (s.reason === "DENIED" && isCommercialDenial(s.denial)) return false;
  return true;
}
