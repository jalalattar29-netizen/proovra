"use client";

/**
 * PROOVRA Phase 2B — Portal client.
 *
 * Token-authenticated fetcher used by the External Reviewer Portal
 * pages. Stores the bearer token + session id in memory (and the
 * session id additionally in sessionStorage so an accidental refresh
 * keeps the inactivity window).
 *
 * Hard rules:
 *   * NEVER persists the raw token to localStorage / cookies. The
 *     bearer is held in-memory; the session id is sessionStorage so
 *     it is dropped when the tab closes.
 *   * Every request adds the Authorization + x-portal-session headers
 *     when present.
 */

import type {
  ExternalPortalProjection,
  ExternalDecisionVerdict,
} from "@proovra/shared";

import { apiBaseUrl } from "../api";

const SS_SESSION_KEY = "proovra.portal.session.v1";

let bearerToken: string | null = null;

export function setBearer(token: string): void {
  bearerToken = token;
}

export function clearBearer(): void {
  bearerToken = null;
}

export function getSessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(SS_SESSION_KEY);
  } catch {
    return null;
  }
}

export function setSessionId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SS_SESSION_KEY, id);
  } catch {
    /* swallow */
  }
}

export function clearSessionId(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SS_SESSION_KEY);
  } catch {
    /* swallow */
  }
}

async function portalFetch(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  // D51 — a JSON content type is declared only when there is a body. It was
  // sent on every request, and the API refuses an empty body that claims to be
  // JSON, so body-less POSTs (opening a review, signing out) answered 400.
  const headers: Record<string, string> = {
    ...(init.body !== undefined && init.body !== null ? { "content-type": "application/json" } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (bearerToken) {
    headers["Authorization"] = `Bearer ${bearerToken}`;
  }
  const sid = getSessionId();
  if (sid) headers["x-portal-session"] = sid;

  // The API is a different origin, and next.config has no /v1 rewrite: a
  // relative path resolves against the WEB origin and 404s (AUDIT-002). The
  // origin comes from the one authority.
  const res = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers });
  if (!res.ok) {
    let denial: string | null = null;
    try {
      const body = await res.json();
      denial = body?.denial ?? null;
    } catch {
      /* swallow */
    }
    const err = new Error(`portal request failed (${res.status})`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err as any).status = res.status;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err as any).denial = denial;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

export type AuthResult = {
  sessionId: string;
  newLogin: boolean;
  reviewerEmail: string;
  role: string;
  expiresAtUtc: string;
};

export async function authenticate(input: {
  token: string;
  mfaToken?: string;
  existingSessionId?: string | null;
}): Promise<AuthResult> {
  setBearer(input.token);
  const res = (await portalFetch("/v1/portal/auth", {
    method: "POST",
    body: JSON.stringify({
      token: input.token,
      mfaToken: input.mfaToken,
      existingSessionId: input.existingSessionId ?? undefined,
    }),
  })) as AuthResult;
  setSessionId(res.sessionId);
  return res;
}

export async function logout(): Promise<void> {
  try {
    await portalFetch("/v1/portal/logout", { method: "POST" });
  } finally {
    clearBearer();
    clearSessionId();
  }
}

export async function fetchPortalDashboard(): Promise<
  ExternalPortalProjection
> {
  const res = (await portalFetch("/v1/portal/dashboard", {
    method: "GET",
  })) as { portal: ExternalPortalProjection };
  return res.portal;
}

export async function markReviewOpened(workflowId: string): Promise<void> {
  await portalFetch(`/v1/portal/work/${workflowId}/view`, { method: "POST" });
}

export type PortalComment = {
  id: string;
  parentCommentId: string | null;
  body: string;
  authorEmail: string;
  authorDisplay: string | null;
  createdAt: string;
  resolvedAtUtc: string | null;
};

export async function fetchComments(workflowId: string): Promise<PortalComment[]> {
  const res = (await portalFetch(
    `/v1/portal/work/${workflowId}/comments`,
    { method: "GET" },
  )) as { comments: PortalComment[] };
  return res.comments;
}

export async function postComment(input: {
  workflowId: string;
  body: string;
  parentCommentId?: string;
}): Promise<string> {
  const res = (await portalFetch(
    `/v1/portal/work/${input.workflowId}/comments`,
    {
      method: "POST",
      body: JSON.stringify({
        body: input.body,
        parentCommentId: input.parentCommentId,
      }),
    },
  )) as { commentId: string };
  return res.commentId;
}

export async function submitDecision(input: {
  workflowId: string;
  verdict: ExternalDecisionVerdict;
  rationale?: string;
}): Promise<{ decisionId: string; replaced: boolean }> {
  const res = (await portalFetch(
    `/v1/portal/work/${input.workflowId}/decision`,
    {
      method: "POST",
      body: JSON.stringify({
        verdict: input.verdict,
        rationale: input.rationale,
      }),
    },
  )) as { decisionId: string; replaced: boolean };
  return res;
}

/**
 * Batch J — the decision this reviewer recorded for a workflow.
 *
 *   GET /v1/portal/work/:workflowId/decisions  (portal.decide | portal.history.read)
 *
 * The server scopes the list to the session grant, so it only ever holds
 * this reviewer's own row (one per grant + workflow; a resubmission
 * replaces it).
 */
export type PortalDecision = {
  id: string;
  workflowId: string;
  verdict: ExternalDecisionVerdict;
  rationale: string | null;
  submittedAtUtc: string;
};

export async function fetchDecisions(workflowId: string): Promise<PortalDecision[]> {
  const res = (await portalFetch(
    `/v1/portal/work/${encodeURIComponent(workflowId)}/decisions`,
    { method: "GET" },
  )) as { decisions?: PortalDecision[] } | null;
  return Array.isArray(res?.decisions) ? res.decisions : [];
}

// ---------------------------------------------------------------------------
// Phase 2B Closure — SSO federation client helpers.
// ---------------------------------------------------------------------------

const SS_RAW_TOKEN_KEY = "proovra.portal.raw-token.v1";

/**
 * Stash the raw token in sessionStorage so the post-SSO callback can
 * resume the bounded portal session. NEVER persisted to localStorage —
 * the value is dropped the moment the tab is closed.
 */
export function stashRawTokenForSso(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SS_RAW_TOKEN_KEY, token);
  } catch {
    /* swallow */
  }
}

export function consumeStashedRawTokenForSso(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const t = window.sessionStorage.getItem(SS_RAW_TOKEN_KEY);
    if (t) window.sessionStorage.removeItem(SS_RAW_TOKEN_KEY);
    return t;
  } catch {
    return null;
  }
}

export type StartPortalSsoResult = {
  redirectUrl: string;
  requestId: string;
  relayState: string;
  connectionId: string;
};

export async function startPortalSso(input: {
  grantId: string;
  spEntityId: string;
  acsUrl: string;
  ssoConnectionId?: string;
}): Promise<StartPortalSsoResult> {
  const res = (await portalFetch(
    `/v1/portal/sso/start/${encodeURIComponent(input.grantId)}`,
    {
      method: "POST",
      body: JSON.stringify({
        acsUrl: input.acsUrl,
        spEntityId: input.spEntityId,
        ssoConnectionId: input.ssoConnectionId,
      }),
    },
  )) as StartPortalSsoResult;
  return res;
}

export async function fetchPortalActivity(): Promise<
  Array<{
    id: string;
    code: string;
    sessionId: string | null;
    payload: unknown;
    occurredAtUtc: string;
  }>
> {
  const res = (await portalFetch("/v1/portal/activity", {
    method: "GET",
  })) as {
    activity: Array<{
      id: string;
      code: string;
      sessionId: string | null;
      payload: unknown;
      occurredAtUtc: string;
    }>;
  };
  return res.activity;
}
