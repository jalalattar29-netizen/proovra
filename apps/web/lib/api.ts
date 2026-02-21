const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8081";

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

export async function apiFetch(path: string, init: RequestInit = {}) {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("proovra-token") : null;

  const headers = new Headers(init.headers);

  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }

  if (typeof window !== "undefined") {
    headers.set("x-web-client", "1");
  }

  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });

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
          details: detailsFromBody,
        },
      };

      throw new ApiError(normalized, res.status);
    }

    // Case 2: { message: "..." } OR plain text/HTML/empty body
    const messageFromBody = obj && typeof obj["message"] === "string" ? (obj["message"] as string) : "";
    const message = messageFromBody || (raw && raw.trim()) || `HTTP ${res.status}: API error`;

    const requestIdFromBody = obj && typeof obj["requestId"] === "string" ? (obj["requestId"] as string) : undefined;
    const requestId = requestIdFromBody ?? headerReqId;

    const error: GenericApiError = new Error(
      requestId ? `${message} (requestId: ${requestId})` : message
    );
    error.code = "API_ERROR";
    error.statusCode = res.status;
    error.requestId = requestId;

    throw error;
  }

  try {
    return await res.json();
  } catch {
    const error: GenericApiError = new Error("Invalid response format");
    error.code = "PARSE_ERROR";
    throw error;
  }
}