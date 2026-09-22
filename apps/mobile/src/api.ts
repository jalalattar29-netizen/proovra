import { triggerLegalGate } from "./auth/legal-gate";
import { reportNetworkOffline, reportNetworkOnline } from "./network/network-state";

/** Canonical API origin — the ONE place the base URL is resolved. */
export function apiBaseUrl(): string {
  return process.env.EXPO_PUBLIC_API_BASE ?? "http://localhost:8081";
}

let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

export function getAuthToken() {
  return authToken;
}

type MobileApiError = Error & {
  requestId?: string;
  statusCode?: number;
  code?: string;
  details?: Record<string, unknown>;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export async function apiFetch(path: string, init: RequestInit = {}) {
  const base = apiBaseUrl();
  const headers = new Headers(init.headers);

  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }

  if (authToken) {
    headers.set("authorization", `Bearer ${authToken}`);
  }

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, headers });
    reportNetworkOnline(); // a completed response ⇒ we are online
  } catch (e) {
    reportNetworkOffline(); // transport failure ⇒ offline (NOT invalid creds)
    throw e;
  }

  if (!res.ok) {
    const headerReqId = res.headers.get("x-request-id") ?? undefined;

    let raw = "";
    try {
      raw = await res.text();
    } catch {
      raw = "";
    }

    let parsed: unknown = null;
    try {
      parsed = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      parsed = null;
    }

    const obj = asObject(parsed);
    const errObj = obj ? asObject(obj["error"]) : null;

    const message =
      (errObj && typeof errObj["message"] === "string" ? (errObj["message"] as string) : "") ||
      (obj && typeof obj["message"] === "string" ? (obj["message"] as string) : "") ||
      (raw && raw.trim()) ||
      `HTTP ${res.status}: API error`;

    const requestId =
      (errObj && typeof errObj["requestId"] === "string" ? (errObj["requestId"] as string) : undefined) ||
      (obj && typeof obj["requestId"] === "string" ? (obj["requestId"] as string) : undefined) ||
      headerReqId;

    const code =
      (errObj && typeof errObj["code"] === "string" ? (errObj["code"] as string) : undefined) ||
      "API_ERROR";

    const err: MobileApiError = new Error(
      requestId ? `${message} (requestId: ${requestId})` : message
    );
    err.requestId = requestId;
    err.statusCode = res.status;
    err.code = code;

    const detailsRaw = errObj ? errObj["details"] : undefined;
    if (detailsRaw && typeof detailsRaw === "object") {
      err.details = detailsRaw as Record<string, unknown>;
    }

    // Runtime legal-acceptance gate: a 428 (or the LEGAL_REACCEPT_REQUIRED code)
    // routes the user to the acceptance screen before the throw propagates, so
    // gated actions (e.g. POST /v1/evidence) recover instead of dead-ending.
    if (res.status === 428 || code === "LEGAL_REACCEPT_REQUIRED") {
      const raw = err.details?.["missingPolicies"];
      const missing = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
      triggerLegalGate(missing);
    }

    throw err;
  }

  return res.json();
}
// ---------------------------------------------------------------------------
// Unauthenticated / alternate-credential requests
// ---------------------------------------------------------------------------

/**
 * A request that must NOT carry the signed-in user's session.
 *
 * The external intake and reviewer-portal flows are for people who are not
 * PROOVRA users. Their web pages say so in their own headers — "It does not
 * call any authenticated endpoint. Every fetch passes `auth: false` so the
 * user's session (if any) is not attached" — and the reason is not stylistic:
 * a contributor's upload must be attributed to the intake token, not to
 * whichever account happens to be signed in on the device that opened the
 * link. Attaching the session would silently change who the platform records
 * as the actor.
 *
 * `credential` lets a caller supply the flow's OWN bearer (the portal token)
 * plus any extra headers that flow defines, without touching `authToken`.
 */
export async function publicFetch(
  path: string,
  init: RequestInit = {},
  credential?: { bearer?: string | null; headers?: Record<string, string> },
) {
  const headers = new Headers(init.headers);

  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }
  if (credential?.bearer) {
    headers.set("authorization", `Bearer ${credential.bearer}`);
  }
  for (const [k, v] of Object.entries(credential?.headers ?? {})) {
    headers.set(k, v);
  }
  // Deliberately absent: the app's own `authToken`. See the note above.

  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers });
    reportNetworkOnline();
  } catch (e) {
    reportNetworkOffline();
    throw e;
  }

  if (!res.ok) {
    let raw = "";
    try {
      raw = await res.text();
    } catch {
      raw = "";
    }
    let parsed: unknown = null;
    try {
      parsed = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      parsed = null;
    }
    const obj = asObject(parsed);
    const errObj = obj ? asObject(obj["error"]) : null;

    const err: MobileApiError = new Error(
      (errObj && typeof errObj["message"] === "string" ? (errObj["message"] as string) : "") ||
        (obj && typeof obj["message"] === "string" ? (obj["message"] as string) : "") ||
        `HTTP ${res.status}`,
    );
    err.statusCode = res.status;
    err.code =
      (errObj && typeof errObj["code"] === "string" ? (errObj["code"] as string) : undefined) ||
      (obj && typeof obj["denial"] === "string" ? (obj["denial"] as string) : undefined) ||
      "API_ERROR";
    if (obj && typeof obj["denial"] === "string") {
      err.details = { denial: obj["denial"] };
    }
    // A public flow never triggers the app's legal-acceptance gate: the caller
    // has no account for that gate to be about.
    throw err;
  }

  return res.json();
}
