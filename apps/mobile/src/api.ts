import { triggerLegalGate } from "./auth/legal-gate";

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
  const base = process.env.EXPO_PUBLIC_API_BASE ?? "http://localhost:8081";
  const headers = new Headers(init.headers);

  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }

  if (authToken) {
    headers.set("authorization", `Bearer ${authToken}`);
  }

  const res = await fetch(`${base}${path}`, { ...init, headers });

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