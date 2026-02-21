let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

export function getAuthToken() {
  return authToken;
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

    const raw = await res.text();
    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    const msg =
      (typeof parsed?.error?.message === "string" && parsed.error.message) ||
      (typeof parsed?.message === "string" && parsed.message) ||
      (typeof raw === "string" && raw.trim()) ||
      `HTTP ${res.status}: API error`;

    const reqId = parsed?.error?.requestId ?? parsed?.requestId ?? headerReqId;

    const err = new Error(reqId ? `${msg} (requestId: ${reqId})` : msg) as Error & {
      requestId?: string;
      statusCode?: number;
      code?: string;
      details?: Record<string, unknown>;
    };
    err.requestId = reqId;
    err.statusCode = res.status;
    err.code = parsed?.error?.code ?? "API_ERROR";
    if (parsed?.error?.details && typeof parsed.error.details === "object") {
      err.details = parsed.error.details;
    }
    throw err;
  }  return res.json();
}
