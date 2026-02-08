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
    const text = await res.text();
    throw new Error(text || "API error");
  }
  return res.json();
}
