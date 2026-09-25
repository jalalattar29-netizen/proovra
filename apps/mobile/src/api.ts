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
  /**
   * The server's parsed error payload, verbatim.
   *
   * Not every field an error carries is `message`/`code`/`details`. A
   * step-up challenge answers { error: { code, methods, message } }, and
   * `methods` decides whether the device asks for a password or an
   * authenticator code. Flattening the payload dropped it, so the client knew
   * a challenge had been raised but not how to answer it.
   */
  body?: Record<string, unknown>;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * The one authenticated request. It returns the RESPONSE, not a body,
 * because not every endpoint answers in JSON: the batch-analysis export
 * answers `text/csv`, and a shared `res.json()` would have turned a correct
 * response into a parse error. Every caller still goes through this single
 * error path — status, request id, code and the 428 legal gate.
 */
async function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
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

    // Nested { error: { code } } first; then the TOP-LEVEL { code } many routes send
    // (e.g. GRANT_NOT_FOUND / INTERNAL_MEMBER), exactly as the web apiFetch reads it.
    // Dropping it turned every such refusal into "API_ERROR".
    const code =
      (errObj && typeof errObj["code"] === "string" ? (errObj["code"] as string) : undefined) ||
      (obj && typeof obj["code"] === "string" ? (obj["code"] as string) : undefined) ||
      "API_ERROR";

    const err: MobileApiError = new Error(
      requestId ? `${message} (requestId: ${requestId})` : message
    );
    err.requestId = requestId;
    err.statusCode = res.status;
    err.code = code;
    if (obj) err.body = obj;

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

  return res;
}

/**
 * A successful JSON body — or null for a reply with none. Ten server routes
 * answer 204 No Content (case delete among them); res.json() threw on the
 * empty body, so a write that SUCCEEDED was reported to the user as failed.
 */
async function readJsonBody(res: Response): ReturnType<Response["json"]> {
  if (res.status === 204 || res.status === 205) return null;
  const raw = await res.text();
  return raw.trim() ? JSON.parse(raw) : null;
}

/** A JSON endpoint. */
export async function apiFetch(path: string, init: RequestInit = {}) {
  const res = await apiRequest(path, init);
  return readJsonBody(res);
}

/**
 * An endpoint that answers in text — today, the batch-analysis CSV export.
 * Kept separate rather than sniffing the content type, so a caller states
 * which shape it expects and a server that changed shape fails loudly.
 */
export async function apiFetchText(path: string, init: RequestInit = {}): Promise<string> {
  const res = await apiRequest(path, init);
  return res.text();
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
      // A top-level { code } too — the same fallback apiFetch reads.
      (obj && typeof obj["code"] === "string" ? (obj["code"] as string) : undefined) ||
      "API_ERROR";
    // The support reference and the refusal's details, as apiFetch keeps them —
    // a public intake fault shows its Support ID, and a 412 SUBMISSION_NOT_READY
    // names the missing steps in details (external-intake.routes.ts:300-307, :755).
    err.requestId =
      (errObj && typeof errObj["requestId"] === "string" ? (errObj["requestId"] as string) : undefined) ||
      (obj && typeof obj["requestId"] === "string" ? (obj["requestId"] as string) : undefined) ||
      res.headers.get("x-request-id") ||
      undefined;
    const detailsRaw = errObj ? errObj["details"] : undefined;
    if (detailsRaw && typeof detailsRaw === "object") err.details = detailsRaw as Record<string, unknown>;
    if (obj && typeof obj["denial"] === "string") {
      err.details = { ...(err.details ?? {}), denial: obj["denial"] };
    }
    // The whole parsed body, as apiFetch keeps it: a public refusal can carry
    // what the next step needs beside its code — the portal MFA step's masked
    // destination, resend wait and attempts remaining (portal-session.service.ts:261-291).
    if (obj) err.body = obj;
    // A public flow never triggers the app's legal-acceptance gate: the caller
    // has no account for that gate to be about.
    throw err;
  }

  return readJsonBody(res);
}
