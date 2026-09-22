/**
 * EXTERNAL REVIEWER PORTAL — pure projections.
 *
 * Ports `apps/web/app/portal/*` over `POST /v1/portal/auth`,
 * `GET /v1/portal/dashboard`, the per-review legs, and
 * `POST /v1/external-review/access/:token` for invitation acceptance.
 *
 * ===========================================================================
 * THE READER IS NOT A PROOVRA USER
 * ===========================================================================
 * An external reviewer has no account. Their credential is the portal token
 * from their invitation, exchanged for a portal session; the app's own
 * `authToken` must never be attached, because a review decision attributed to
 * whichever account happens to be signed in on the device is a false custody
 * record.
 *
 * So every call in this family goes through `publicFetch` with the portal's
 * OWN bearer and its `x-portal-session` header, and never through `apiFetch`.
 *
 * ===========================================================================
 * DENIALS ARE THE PRODUCT, NOT ERRORS
 * ===========================================================================
 * The auth leg answers with a `denial` for an expired, revoked, throttled or
 * MFA-pending token. Those are states a reviewer must be able to read and act
 * on — "your access expired on the 3rd" is useful; "something went wrong" is
 * not. They are classified here, not swallowed.
 *
 * Pure: no React, no react-native, no fetch.
 */
import type { ProovraStatusTone } from "@proovra/ui";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export const PORTAL_AUTH_PATH = "/v1/portal/auth";
export const PORTAL_DASHBOARD_PATH = "/v1/portal/dashboard";
export const PORTAL_LOGOUT_PATH = "/v1/portal/logout";

export function buildPortalViewPath(workflowId: string): string {
  return `/v1/portal/work/${encodeURIComponent(workflowId)}/view`;
}

export function buildPortalCommentsPath(workflowId: string): string {
  return `/v1/portal/work/${encodeURIComponent(workflowId)}/comments`;
}

export function buildPortalDecisionPath(workflowId: string): string {
  return `/v1/portal/work/${encodeURIComponent(workflowId)}/decision`;
}

export function buildGrantAcceptPath(token: string): string {
  return `/v1/external-review/access/${encodeURIComponent(token)}`;
}

/** The headers a portal call carries. The app's own session is never one. */
export function portalCredential(
  token: string | null,
  sessionId: string | null,
): { bearer: string | null; headers: Record<string, string> } {
  return {
    bearer: token,
    headers: sessionId ? { "x-portal-session": sessionId } : {},
  };
}

export function buildPortalAuthBody(input: {
  token: string;
  mfaToken?: string | null;
  existingSessionId?: string | null;
}) {
  const body: Record<string, unknown> = { token: input.token };
  if (input.mfaToken) body.mfaToken = input.mfaToken;
  if (input.existingSessionId) body.existingSessionId = input.existingSessionId;
  return body;
}

// ---------------------------------------------------------------------------
// Denials
// ---------------------------------------------------------------------------

/** The MFA denials the web client enumerates, kept in step with it. */
export const PORTAL_MFA_DENIALS = [
  "MFA_REQUIRED",
  "MFA_CODE_REQUIRED",
  "MFA_CODE_INVALID",
  "MFA_CODE_EXPIRED",
] as const;

export type PortalDenial =
  | "MFA"
  | "EXPIRED"
  | "REVOKED"
  | "NOT_FOUND"
  | "THROTTLED"
  | "UNAVAILABLE"
  | "UNKNOWN";

export function classifyPortalDenial(err: unknown): PortalDenial {
  const e = obj(err);
  const code = (str(e.code) ?? str(obj(e.details).denial) ?? "").toUpperCase();
  const status = typeof e.statusCode === "number" ? e.statusCode : null;

  if ((PORTAL_MFA_DENIALS as readonly string[]).includes(code)) return "MFA";
  if (code.includes("EXPIRED")) return "EXPIRED";
  if (code.includes("REVOKED")) return "REVOKED";
  if (status === 429) return "THROTTLED";
  if (status === 503) return "UNAVAILABLE";
  if (status === 404 || code.includes("NOT_FOUND")) return "NOT_FOUND";
  return "UNKNOWN";
}

/**
 * What the reviewer is told.
 *
 * Each says what happened and what to do. "Your access expired" is actionable;
 * "something went wrong" sends a reviewer to email somebody to find out which
 * of four different things occurred.
 */
export function portalDenialMessage(denial: PortalDenial): string {
  switch (denial) {
    case "MFA":
      return "Enter the code sent to your email address to continue.";
    case "EXPIRED":
      return "This review access has expired. Ask the workspace that invited you for a new link.";
    case "REVOKED":
      return "This review access has been withdrawn. Contact the workspace that invited you.";
    case "NOT_FOUND":
      return "This link is not valid. Open the most recent invitation email and use the link there.";
    case "THROTTLED":
      return "Too many attempts. Wait a few minutes and try again.";
    case "UNAVAILABLE":
      return "The review portal is temporarily unavailable. Try again shortly.";
    case "UNKNOWN":
      return "This review access could not be opened. Try again, or ask for a new link.";
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface PortalSession {
  sessionId: string;
  reviewerEmail: string | null;
  role: string | null;
  expiresAtIso: string | null;
  newLogin: boolean;
}

export function parsePortalAuth(payload: unknown): PortalSession | null {
  const d = obj(payload);
  const sessionId = str(d.sessionId);
  if (!sessionId) return null;
  return {
    sessionId,
    reviewerEmail: str(d.reviewerEmail),
    role: str(d.role),
    expiresAtIso: str(d.expiresAtUtc),
    newLogin: d.newLogin === true,
  };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface PortalAssignment {
  workflowId: string;
  evidenceId: string | null;
  title: string;
  dueAtIso: string | null;
  submittedDecisionAtIso: string | null;
}

export interface PortalDashboard {
  reviewerEmail: string | null;
  reviewerName: string | null;
  organization: string | null;
  role: string | null;
  capabilities: string[];
  scopeKind: string | null;
  scopeLabel: string | null;
  scopeExpiresAtIso: string | null;
  assigned: PortalAssignment[];
  /** The bounded limitations footer the web renders. Never invented here. */
  limitations: string[];
}

export function parsePortalDashboard(payload: unknown): PortalDashboard | null {
  const p = obj(obj(payload).portal ?? payload);
  const reviewer = obj(p.reviewer);
  const scope = obj(p.scope);
  if (Object.keys(p).length === 0) return null;

  return {
    reviewerEmail: str(reviewer.email),
    reviewerName: str(reviewer.displayName),
    organization: str(reviewer.organization),
    role: str(reviewer.role),
    capabilities: rows(reviewer.capabilities).filter(
      (c): c is string => typeof c === "string",
    ),
    scopeKind: str(scope.kind),
    scopeLabel: str(scope.label),
    scopeExpiresAtIso: str(scope.expiresAtUtc),
    assigned: rows(p.assigned)
      .map((raw) => {
        const a = obj(raw);
        const workflowId = str(a.workflowId);
        if (!workflowId) return null;
        return {
          workflowId,
          evidenceId: str(a.evidenceId),
          // A review with no title is still a review to do.
          title: str(a.title) ?? "Untitled review",
          dueAtIso: str(a.dueAt),
          submittedDecisionAtIso: str(a.submittedDecisionAtUtc),
        };
      })
      .filter((a): a is PortalAssignment => a !== null),
    limitations: rows(p.limitations).filter((l): l is string => typeof l === "string"),
  };
}

/** A reviewer may only do what the server says they may. */
export function hasPortalCapability(
  dashboard: PortalDashboard | null,
  capability: string,
): boolean {
  return dashboard?.capabilities.includes(capability) === true;
}

/** Outstanding first: a submitted review is not what a reviewer opened this for. */
export function sortAssignments(assigned: PortalAssignment[]): PortalAssignment[] {
  return [...assigned].sort((a, b) => {
    const ad = a.submittedDecisionAtIso ? 1 : 0;
    const bd = b.submittedDecisionAtIso ? 1 : 0;
    if (ad !== bd) return ad - bd;
    const at = a.dueAtIso ? Date.parse(a.dueAtIso) : Number.MAX_SAFE_INTEGER;
    const bt = b.dueAtIso ? Date.parse(b.dueAtIso) : Number.MAX_SAFE_INTEGER;
    return at - bt;
  });
}

export function assignmentTone(a: PortalAssignment, nowMs = Date.now()): ProovraStatusTone {
  if (a.submittedDecisionAtIso) return "verified";
  if (!a.dueAtIso) return "neutral";
  const due = Date.parse(a.dueAtIso);
  if (!Number.isFinite(due)) return "neutral";
  return due < nowMs ? "risk" : "pending";
}

// ---------------------------------------------------------------------------
// Comments and decisions
// ---------------------------------------------------------------------------

export interface PortalComment {
  id: string;
  body: string;
  authorLabel: string;
  createdAtIso: string | null;
}

export function parsePortalComments(payload: unknown): PortalComment[] {
  return rows(obj(payload).comments ?? payload)
    .map((raw) => {
      const c = obj(raw);
      const id = str(c.id);
      if (!id) return null;
      return {
        id,
        body: typeof c.body === "string" ? c.body : "",
        authorLabel: str(c.authorLabel) ?? str(c.authorEmail) ?? "Someone",
        createdAtIso: str(c.createdAtUtc) ?? str(c.createdAt),
      };
    })
    .filter((c): c is PortalComment => c !== null)
    .sort((a, b) => {
      const at = a.createdAtIso ? Date.parse(a.createdAtIso) : 0;
      const bt = b.createdAtIso ? Date.parse(b.createdAtIso) : 0;
      return at - bt;
    });
}

/**
 * The decisions an external reviewer may record.
 *
 * Deliberately NOT a verdict about truth or admissibility — the platform's
 * boundary contract forbids that, and a reviewer portal is exactly where such
 * a claim would look most authoritative.
 */
export const PORTAL_DECISIONS = ["APPROVED", "REJECTED", "NEEDS_MORE_INFO"] as const;
export type PortalDecisionValue = (typeof PORTAL_DECISIONS)[number];

export function portalDecisionLabel(value: PortalDecisionValue): string {
  switch (value) {
    case "APPROVED":
      return "Accept";
    case "REJECTED":
      return "Reject";
    case "NEEDS_MORE_INFO":
      return "Needs more information";
  }
}

export function buildPortalDecisionBody(input: {
  decision: PortalDecisionValue;
  note?: string;
}) {
  const body: Record<string, unknown> = { decision: input.decision };
  const note = (input.note ?? "").trim();
  if (note.length > 0) body.note = note;
  return body;
}

export function isSendablePortalComment(body: string): boolean {
  const v = body.trim();
  return v.length > 0 && v.length <= 4000;
}

// ---------------------------------------------------------------------------
// Invitation acceptance
// ---------------------------------------------------------------------------

/**
 * `/portal/accept/:grantId?token=…` — the emailed acceptance link.
 *
 * The grant id names the invitation; the token proves it. Both halves are
 * required, and a link missing either is ignored rather than half-attempted:
 * posting an empty token would burn an acceptance attempt on a valid grant.
 */
export function parseGrantAcceptLink(
  input: { grantId?: unknown; token?: unknown } | string,
): { grantId: string; token: string } | null {
  if (typeof input !== "string") {
    const grantId = str(input.grantId);
    const token = str(input.token);
    return grantId && token ? { grantId, token } : null;
  }
  try {
    const url = new URL(input);
    const segments = url.pathname.split("/").filter(Boolean);
    const i = segments.indexOf("accept");
    const grantId = i >= 0 ? decodeURIComponent(segments[i + 1] ?? "") : "";
    const token = (url.searchParams.get("token") ?? "").trim();
    return grantId && token ? { grantId, token } : null;
  } catch {
    return null;
  }
}
