const DEFAULT_API_BASE = "https://api.proovra.com";
const RAW_API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? DEFAULT_API_BASE;
const API_BASE = RAW_API_BASE.replace(/\/+$/, "");

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    requestId?: string;
    timestamp: string;
    details?: Record<string, unknown>;
  };
}

export class ApiError extends Error {
  code: string;
  statusCode: number;
  requestId?: string;
  details?: Record<string, unknown>;

  constructor(response: ApiErrorResponse, statusCode: number) {
    super(response.error.message);
    this.code = response.error.code;
    this.statusCode = statusCode;
    this.requestId = response.error.requestId;
    this.details = response.error.details;
    this.name = "ApiError";
  }
}

type GenericApiError = Error & {
  code?: string;
  statusCode?: number;
  requestId?: string;
  details?: Record<string, unknown>;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

type ApiFetchOpts = {
  auth?: boolean;
  retryAuthOnce?: boolean;
};

/**
 * In-memory only. The web app authenticates via the HttpOnly `proovra_session`
 * cookie that the backend sets after login/register/OAuth. We retain a short-
 * lived in-memory token slot for two reasons:
 *   1. immediate post-OAuth requests where the cookie may still be in flight,
 *   2. the guest-evidence-claim flow that needs to forward the guest JWT.
 *
 * NEVER persist this value to localStorage / sessionStorage / IndexedDB.
 */
let inMemoryToken: string | null = null;

export function setApiToken(token: string | null): void {
  inMemoryToken = token && token.trim() ? token : null;
}

export function readApiToken(): string | null {
  return inMemoryToken;
}

function readToken(): string | null {
  return inMemoryToken;
}

async function fetchWithAuthRetry(
  url: string,
  init: RequestInit,
  opts: Required<Pick<ApiFetchOpts, "auth" | "retryAuthOnce">>
) {
  const makeHeaders = () => {
    const headers = new Headers(init.headers);

    if (!headers.has("content-type") && init.body) {
      headers.set("content-type", "application/json");
    }

    if (typeof window !== "undefined") {
      headers.set("x-web-client", "1");
    }

    const token = readToken();
    if (opts.auth && token) {
      headers.set("authorization", `Bearer ${token}`);
    } else {
      headers.delete("authorization");
    }

    return headers;
  };

  const first = await fetch(url, {
    ...init,
    headers: makeHeaders(),
    credentials: "include",
    cache: "no-store",
  });

  if (first.status !== 401 || !opts.retryAuthOnce) {
    return first;
  }

  const second = await fetch(url, {
    ...init,
    headers: makeHeaders(),
    credentials: "include",
    cache: "no-store",
  });

  return second;
}

export async function apiFetch(
  path: string,
  init: RequestInit = {},
  opts?: ApiFetchOpts
) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${API_BASE}${normalizedPath}`;

  const finalOpts = {
    auth: opts?.auth !== false,
    retryAuthOnce: opts?.retryAuthOnce !== false,
  };

  let res: Response;
  try {
    res = await fetchWithAuthRetry(url, init, finalOpts);
  } catch (err: unknown) {
    const e: GenericApiError = new Error(
      err instanceof Error ? err.message : "Network error while calling API"
    );
    e.code = "NETWORK_ERROR";
    e.statusCode = 0;
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

    const hasStandardShape =
      !!errObj &&
      typeof errObj["code"] === "string" &&
      typeof errObj["message"] === "string";

    if (hasStandardShape) {
      const requestIdFromBody =
        typeof errObj["requestId"] === "string"
          ? (errObj["requestId"] as string)
          : undefined;

      const timestampFromBody =
        typeof errObj["timestamp"] === "string"
          ? (errObj["timestamp"] as string)
          : undefined;

      const detailsFromBodyRaw = errObj["details"];
      const detailsFromBody =
        detailsFromBodyRaw && typeof detailsFromBodyRaw === "object"
          ? (detailsFromBodyRaw as Record<string, unknown>)
          : undefined;

      const normalized: ApiErrorResponse = {
        error: {
          code: String(errObj["code"]),
          message: String(errObj["message"]),
          requestId: requestIdFromBody ?? headerReqId,
          timestamp: timestampFromBody ?? new Date().toISOString(),
          details: detailsFromBody,
        },
      };

      throw new ApiError(normalized, res.status);
    }

    const messageFromBody =
      obj && typeof obj["message"] === "string"
        ? (obj["message"] as string)
        : "";

    const codeFromBody =
      obj && typeof obj["code"] === "string" ? (obj["code"] as string) : "";

    const detailsFromBody =
      obj && typeof obj["details"] === "object" && obj["details"] !== null
        ? (obj["details"] as Record<string, unknown>)
        : undefined;

    const billingWall =
      obj && typeof obj["billingWall"] === "object" && obj["billingWall"] !== null
        ? (obj["billingWall"] as Record<string, unknown>)
        : undefined;

    // Evidence Lifecycle REAL FIX — some legacy routes return denial info at
    // TOP LEVEL of the error body (e.g. `{denial: "ENTITLEMENT_REQUIRED",
    // entitlement: "FEATURE_X"}`) instead of nesting it under `details`.
    // Pre-fix, `error.details` was undefined for these responses, so the
    // frontend's denial mapper never matched and rendered a generic error
    // instead of the entitlement panel. We now treat the whole body as
    // `details` when no explicit `details` field is present AND the body
    // contains canonical denial fields. This is additive — routes already
    // sending `details` are unaffected.
    const topLevelDenialFields = ["denial", "entitlement", "requiredTier", "requiredEntitlement"];
    const bodyHasTopLevelDenial =
      obj &&
      !detailsFromBody &&
      topLevelDenialFields.some((k) => typeof obj[k] === "string");
    const promotedDetails = bodyHasTopLevelDenial
      ? (obj as Record<string, unknown>)
      : undefined;

    const message =
      messageFromBody || (raw && raw.trim()) || `HTTP ${res.status}: API error`;

    const requestIdFromBody =
      obj && typeof obj["requestId"] === "string"
        ? (obj["requestId"] as string)
        : undefined;

    const requestId = requestIdFromBody ?? headerReqId;

    const error: GenericApiError = new Error(
      requestId ? `${message} (requestId: ${requestId})` : message
    );

    error.code =
      codeFromBody ||
      (typeof obj?.["denial"] === "string" ? (obj["denial"] as string) : "") ||
      (res.status === 401 ? "UNAUTHORIZED" : "API_ERROR");
    error.statusCode = res.status;
    error.requestId = requestId;
    error.details = detailsFromBody ?? promotedDetails ?? billingWall;

    throw error;
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  try {
    return await res.json();
  } catch {
    const error: GenericApiError = new Error("Invalid response format");
    error.code = "PARSE_ERROR";
    error.statusCode = res.status;
    throw error;
  }
}