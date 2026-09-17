/**
 * OAuth 2.0 Authorization Code + PKCE (S256) for the extension.
 *
 * No embedded secret, no long-lived API key, no cookie scraping: the extension
 * opens the PROOVRA authorization page in `chrome.identity.launchWebAuthFlow`,
 * receives a code bound to a PKCE verifier it generated, and exchanges it for a
 * short-lived access token stored in `chrome.storage.session` (cleared when the
 * browser closes). The token authorizes API calls; the server reauthorizes
 * every sensitive operation.
 *
 * The token endpoint contract (authorize/token URLs, client id) is injected by
 * the build. The server-side registration of this public client + redirect URI
 * is the one wiring step recorded as pending in the UC-1 doc.
 */
import { CONFIG } from "./config.js";

const TOKEN_KEY = "proovra.session.token";

type StoredToken = { accessToken: string; expiresAtMs: number; account?: string | null };

function base64UrlEncode(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function pkceChallenge(): Promise<{ verifier: string; challenge: string }> {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64UrlEncode(random.buffer);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(digest) };
}

async function storageGet<T>(area: "session" | "local", key: string): Promise<T | null> {
  const store = area === "session" ? chrome.storage.session : chrome.storage.local;
  const out = await store.get(key);
  return (out?.[key] as T) ?? null;
}

async function storageSet(area: "session" | "local", key: string, value: unknown): Promise<void> {
  const store = area === "session" ? chrome.storage.session : chrome.storage.local;
  await store.set({ [key]: value });
}

export async function getStoredToken(): Promise<StoredToken | null> {
  const t = await storageGet<StoredToken>("session", TOKEN_KEY);
  if (!t) return null;
  if (t.expiresAtMs <= Date.now()) {
    await clearToken();
    return null;
  }
  return t;
}

export async function clearToken(): Promise<void> {
  await chrome.storage.session.remove(TOKEN_KEY);
}

export async function isSignedIn(): Promise<boolean> {
  return (await getStoredToken()) !== null;
}

/** Interactive sign-in via PKCE. Resolves with the account label on success. */
export async function signIn(): Promise<{ account: string | null }> {
  const redirectUri = chrome.identity.getRedirectURL("oauth2");
  const { verifier, challenge } = await pkceChallenge();
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const authUrl = new URL(CONFIG.authAuthorizeUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CONFIG.oauthClientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "capture.direct offline");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  const redirect = await chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true });
  if (!redirect) throw new Error("sign-in was cancelled");
  const returned = new URL(redirect);
  if (returned.searchParams.get("state") !== state) throw new Error("sign-in state mismatch");
  const code = returned.searchParams.get("code");
  if (!code) throw new Error("no authorization code returned");

  const res = await fetch(CONFIG.authTokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CONFIG.oauthClientId,
      code_verifier: verifier,
    }),
    credentials: "omit",
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const body = (await res.json()) as { access_token: string; expires_in?: number; account?: string };
  const token: StoredToken = {
    accessToken: body.access_token,
    expiresAtMs: Date.now() + (body.expires_in ?? 3600) * 1000,
    account: body.account ?? null,
  };
  await storageSet("session", TOKEN_KEY, token);
  return { account: token.account ?? null };
}

export async function signOut(): Promise<void> {
  await clearToken();
}
