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

export async function apiFetch(path: string, init: RequestInit = {}) {
  const token = typeof window !== "undefined" ? localStorage.getItem("proovra-token") : null;
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
    credentials: "include"
  });
  
  if (!res.ok) {
    try {
      const errorData = await res.json() as ApiErrorResponse;
      throw new ApiError(errorData, res.status);
    } catch (e) {
      if (e instanceof ApiError) {
        throw e;
      }
      // Fallback for non-JSON errors
      const text = await res.text();
      const error = new Error(text || `HTTP ${res.status}: API error`) as Error & { code: string; statusCode: number };
      error.code = "NETWORK_ERROR";
      error.statusCode = res.status;
      throw error;
    }
  }

  try {
    return await res.json();
  } catch {
    const error = new Error("Invalid response format") as Error & { code: string };
    error.code = "PARSE_ERROR";
    throw error;
  }
}
