const DEFAULT_API_BASE = "https://api.proovra.com";
const RAW_API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? DEFAULT_API_BASE;

// Normalize once (remove trailing slash)
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
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

type ApiFetchOpts = {
  /** default true: send Authorization if token exists */
  auth?: boolean;

  /** default true: on 401 retry once with latest token from localStorage (helps hydration/race) */
  retryAuthOnce?: boolean;
};

function hasCookieSession(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie.split(";").some((part) => part.trim().startsWith("proovra_session="));
}

function readToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("proovra-token");
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
    cache: "no-store"
  });

if (
  first.status !== 401 ||
  !opts.retryAuthOnce ||
  (!opts.auth && !hasCookieSession())
) {
  return first;
}

  // Retry once after re-reading token (covers fast hydration / token just written)
  const second = await fetch(url, {
    ...init,
    headers: makeHeaders(),
    credentials: "include",
    cache: "no-store"
  });

  return second;
}

export async function apiFetch(path: string, init: RequestInit = {}, opts?: ApiFetchOpts) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${API_BASE}${normalizedPath}`;

  const finalOpts = {
    auth: opts?.auth !== false,
    retryAuthOnce: opts?.retryAuthOnce !== false
  };

  let res: Response;
  try {
    res = await fetchWithAuthRetry(url, init, finalOpts);
  } catch (err: unknown) {
    // Network / DNS / CORS / offline
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
      !!errObj && typeof errObj["code"] === "string" && typeof errObj["message"] === "string";

    // Case 1: { error: { code, message, requestId, timestamp, details } }
    if (hasStandardShape) {
      const requestIdFromBody =
        typeof errObj["requestId"] === "string" ? (errObj["requestId"] as string) : undefined;

      const timestampFromBody =
        typeof errObj["timestamp"] === "string" ? (errObj["timestamp"] as string) : undefined;

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
          details: detailsFromBody
        }
      };

      throw new ApiError(normalized, res.status);
    }

    // Case 2: { message: "..." } OR plain text/HTML/empty body
    const messageFromBody =
      obj && typeof obj["message"] === "string" ? (obj["message"] as string) : "";
    const message = messageFromBody || (raw && raw.trim()) || `HTTP ${res.status}: API error`;

    const requestIdFromBody =
      obj && typeof obj["requestId"] === "string" ? (obj["requestId"] as string) : undefined;

    const requestId = requestIdFromBody ?? headerReqId;

    const error: GenericApiError = new Error(
      requestId ? `${message} (requestId: ${requestId})` : message
    );
    error.code = res.status === 401 ? "UNAUTHORIZED" : "API_ERROR";
    error.statusCode = res.status;
    error.requestId = requestId;

    throw error;
  }

  // Some endpoints might return empty body (204)
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