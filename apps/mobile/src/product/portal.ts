/**
 * EXTERNAL REVIEWER PORTAL — pure projections.
 *
 * Ports `apps/web/app/portal/*` over `POST /v1/portal/auth`,
 * `GET /v1/portal/dashboard`, the per-review legs, and
 * `POST /v1/external-review/access/:token` for invitation acceptance, and the
 * emailed-code step (masked destination, resend cooldown, attempts remaining,
 * "Send a new code" = the same token exchange without a code).
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

/**
 * The denials answered by the emailed-code step.
 *
 * The server's vocabulary is MFA_REQUIRED, and verifyPortalMfaCode's
 * MFA_INVALID / MFA_CODE_EXHAUSTED (portal-session.service.ts,
 * portal-mfa-challenge.service.ts); `portal_mfa_required` is the accept
 * route's refusal of an MFA invitation (external-review.routes.ts). Only the
 * MFA_CODE_* spellings were here before, so a mistyped code (MFA_INVALID)
 * dead-ended the reviewer on "could not be opened".
 */
export const PORTAL_MFA_DENIALS = [
  "MFA_REQUIRED",
  "MFA_INVALID",
  "MFA_CODE_EXHAUSTED",
  "PORTAL_MFA_REQUIRED",
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
  // TOKEN_INVALID is the server's 401 for an unknown token: the link is not valid.
  if (status === 404 || code.includes("NOT_FOUND") || code === "TOKEN_INVALID") return "NOT_FOUND";
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
// The emailed-code step — port of apps/web/components/external-portal/PortalMfaCodeStep.tsx
// ---------------------------------------------------------------------------

/**
 * What the auth leg says about the emailed code. POST /v1/portal/auth answers
 * 401 `{ denial, ...mfa }` with these four keys at the TOP level
 * (external-portal.routes.ts:854; built in portal-session.service.ts:261-291).
 * `destination` is the server's masked address; the full one never arrives.
 * A 429 RATE_LIMITED / 503 MFA_UNAVAILABLE carries none of them.
 */
export interface PortalMfaDetail {
  codeSent: boolean;
  destination: string | null;
  resendAvailableInSeconds: number | null;
  attemptsRemaining: number | null;
}

const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** The web's readMfaDetail, reading the parsed body publicFetch keeps on `err.body`. */
export function readPortalMfaDetail(err: unknown): PortalMfaDetail | null {
  const b = obj(obj(err).body);
  if (!("codeSent" in b) && !("attemptsRemaining" in b) && !("resendAvailableInSeconds" in b)) {
    return null;
  }
  return {
    codeSent: b.codeSent === true,
    destination: str(b.destination),
    resendAvailableInSeconds: finite(b.resendAvailableInSeconds),
    attemptsRemaining: finite(b.attemptsRemaining),
  };
}

/** The server's denial word as sent (`{ denial }`), or null. */
export function readPortalDenialCode(err: unknown): string | null {
  const e = obj(err);
  return str(obj(e.body).denial) ?? str(obj(e.details).denial) ?? null;
}

/**
 * The denials the web answers with the code step on the token exchange
 * (portal-client.ts PORTAL_MFA_DENIALS). MFA_UNAVAILABLE is here — and not in
 * PORTAL_MFA_DENIALS above — because only the code step can say "we can't send
 * or check codes right now"; elsewhere it is simply "unavailable".
 */
export const PORTAL_MFA_STEP_DENIALS = [
  "MFA_REQUIRED",
  "MFA_INVALID",
  "MFA_CODE_EXHAUSTED",
  "MFA_UNAVAILABLE",
] as const;

export function isPortalMfaStepDenial(denial: string | null): boolean {
  return denial !== null && (PORTAL_MFA_STEP_DENIALS as readonly string[]).includes(denial);
}

/** The web's problemCopy (PortalMfaCodeStep.tsx:43-66), word for word. */
export function portalMfaProblemMessage(
  denial: string | null,
  attemptsRemaining: number | null,
  fallback?: string,
): string {
  switch (denial) {
    case "MFA_INVALID":
      return attemptsRemaining !== null && attemptsRemaining > 0
        ? `That code is not correct. You have ${attemptsRemaining} ${
            attemptsRemaining === 1 ? "try" : "tries"
          } left.`
        : "That code is not valid any more. Send a new code and use the newest email.";
    case "MFA_CODE_EXHAUSTED":
      return "Too many incorrect codes. That code no longer works. Send a new code to try again.";
    case "MFA_UNAVAILABLE":
      return "We can't send or check sign-in codes right now, so the portal stays closed. Try again in a few minutes.";
    case "RATE_LIMITED":
      return "Too many codes were requested for this invitation. Wait 15 minutes, then send a new code.";
    case "MFA_REQUIRED":
      return "Enter the six-digit code from your email to open the portal.";
    case "TOKEN_INVALID":
    case "TOKEN_EXPIRED":
    case "TOKEN_REVOKED":
      return "This invitation link no longer works. Ask the person who invited you for a new one.";
    default:
      return fallback ?? "We couldn't check your code. Try again.";
  }
}

/** The web's step status line: "we emailed" only when the server says a code is live. */
export function portalMfaStatusMessage(codeSent: boolean, destination: string | null): string {
  if (!codeSent) return "This invitation needs a six-digit code sent to the invited email address.";
  return destination
    ? `We emailed a six-digit code to ${destination}. It expires in 10 minutes and works once.`
    : "We emailed a six-digit code to the address this invitation was sent to. It expires in 10 minutes and works once.";
}

/** Whole seconds until another code may be requested; 0 when it may. */
export function portalMfaSecondsLeft(cooldownUntilMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((cooldownUntilMs - nowMs) / 1000));
}

/** Why "Send a new code" is disabled, or null when it is not. */
export function portalMfaCooldownMessage(secondsLeft: number): string | null {
  return secondsLeft > 0 ? `You can ask for a new code in ${secondsLeft} seconds.` : null;
}

/** The input keeps digits only, at most six (the web's onChange). */
export function normalizePortalMfaCode(input: string): string {
  return input.replace(/\D/g, "").slice(0, 6);
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
  /** One level of nesting (portal-comments.service.ts); null for a root comment. */
  parentCommentId: string | null;
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
        // The server names the display name `authorDisplay` (portal-comments.service.ts);
        // reading `authorLabel` meant only ever the email was shown.
        authorLabel: str(c.authorDisplay) ?? str(c.authorLabel) ?? str(c.authorEmail) ?? "Someone",
        createdAtIso: str(c.createdAtUtc) ?? str(c.createdAt),
        parentCommentId: str(c.parentCommentId),
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
 * The verdicts an external reviewer may record — the shared
 * EXTERNAL_DECISION_VERDICTS, mirrored here because this module is pure (a
 * guard test pins the two together).
 *
 * THE DEFECT THIS REPLACES: native posted `{ decision: "APPROVED", note }`.
 * POST /v1/portal/work/:id/decision parses `{ verdict: enum, rationale? }`
 * (external-portal.routes.ts SubmitDecisionBody), so every native decision
 * failed validation — and the vocabulary (APPROVED / REJECTED /
 * NEEDS_MORE_INFO) was not the server's at all.
 *
 * Deliberately NOT a verdict about truth or admissibility — the platform's
 * boundary contract forbids that.
 */
export const PORTAL_DECISIONS = ["APPROVE", "REJECT", "REQUEST_CHANGES", "ABSTAIN", "ESCALATE"] as const;
export type PortalDecisionValue = (typeof PORTAL_DECISIONS)[number];

/** The shared identifierLabel wording the web shows ("Request changes"). */
export function portalDecisionLabel(value: string): string {
  const words = value.split(/[_.\s-]+/).filter(Boolean);
  if (words.length === 0) return value;
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(" ");
}

export const PORTAL_RATIONALE_MAX = 600;

/** The server's rule (portal-decisions.service.ts): every verdict but APPROVE needs a rationale; at most 600 chars. */
export function portalDecisionRationaleProblem(verdict: PortalDecisionValue, rationale: string): string | null {
  const r = rationale.trim();
  if (r.length > PORTAL_RATIONALE_MAX) return `Keep the rationale to ${PORTAL_RATIONALE_MAX} characters.`;
  if (verdict !== "APPROVE" && r.length === 0) return "A rationale is required for every verdict except Approve.";
  return null;
}

export function buildPortalDecisionBody(input: { verdict: PortalDecisionValue; rationale?: string }) {
  const body: Record<string, unknown> = { verdict: input.verdict };
  const rationale = (input.rationale ?? "").trim();
  if (rationale.length > 0) body.rationale = rationale;
  return body;
}

export function buildPortalDecisionsPath(workflowId: string): string {
  return `/v1/portal/work/${encodeURIComponent(workflowId)}/decisions`;
}

export interface PortalRecordedDecision {
  id: string;
  verdict: string;
  rationale: string | null;
  submittedAtIso: string | null;
}

/** GET …/decisions is scoped to this reviewer's grant: at most their own row. */
export function parsePortalRecordedDecision(payload: unknown): PortalRecordedDecision | null {
  const list = rows(obj(payload).decisions).map(obj).filter((d) => str(d.id) && str(d.verdict));
  const d = list[0];
  if (!d) return null;
  return { id: str(d.id) as string, verdict: str(d.verdict) as string, rationale: str(d.rationale), submittedAtIso: str(d.submittedAtUtc) };
}

/** The web's announcement once the re-read shows the decision. */
export function portalDecisionRecordedNotice(verdict: string, replaced: boolean): string {
  return `Decision recorded: ${portalDecisionLabel(verdict)}${replaced ? ". It replaces your previous decision." : "."}`;
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

/** Root comments in order, each with its replies (the server bounds nesting to one level). */
export function threadPortalComments(comments: PortalComment[]): Array<{ root: PortalComment; replies: PortalComment[] }> {
  const roots = comments.filter((c) => !c.parentCommentId);
  return roots.map((root) => ({ root, replies: comments.filter((c) => c.parentCommentId === root.id) }));
}
