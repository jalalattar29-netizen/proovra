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

export async function apiFetch(path: string, init: RequestInit = {}) {
  const token =
    typeof window !== "undefined"
      ? localStorage.getItem("proovra-token")
      : null;

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

  // ---- SAFE ERROR HANDLING WITH requestId ----
  if (!res.ok) {
    const headerReqId = res.headers.get("x-request-id") ?? undefined;

    let raw = "";
    try {
      raw = await res.text();
    } catch {
      raw = "";
    }

    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    // Case 1: Standard API error shape
    if (parsed && parsed.error && parsed.error.code && parsed.error.message) {
      const normalized: ApiErrorResponse = {
        error: {
          code: String(parsed.error.code),
          message: String(parsed.error.message),
          requestId: parsed.error.requestId ?? headerReqId,
          timestamp:
            parsed.error.timestamp ?? new Date().toISOString(),
          details: parsed.error.details,
        },
      };

      throw new ApiError(normalized, res.status);
    }

    // Case 2: Non-standard shape or plain text
    const message =
      (parsed && typeof parsed.message === "string" && parsed.message) ||
      (raw && raw.trim()) ||
      `HTTP ${res.status}: API error`;

    const requestId =
      (parsed &&
        parsed.error &&
        parsed.error.requestId) ||
      (parsed && parsed.requestId) ||
      headerReqId;

    const error: GenericApiError = new Error(
      requestId ? `${message} (requestId: ${requestId})` : message
    );

    error.code =
      (parsed &&
        parsed.error &&
        parsed.error.code) ||
      "API_ERROR";

    error.statusCode = res.status;
    error.requestId = requestId;

    if (
      parsed &&
      parsed.error &&
      parsed.error.details &&
      typeof parsed.error.details === "object"
    ) {
      error.details = parsed.error.details;
    }

    throw error;
  }

  // ---- SUCCESS PATH ----
  try {
    return await res.json();
  } catch {
    const error: GenericApiError = new Error("Invalid response format");
    error.code = "PARSE_ERROR";
    throw error;
  }
}