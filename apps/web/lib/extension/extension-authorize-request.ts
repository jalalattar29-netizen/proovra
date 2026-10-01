/**
 * UC-EXT-006 (web half) — the ONE validator for an extension sign-in
 * continuation.
 *
 * The extension's `launchWebAuthFlow` opens GET /v1/oauth/extension/authorize.
 * A signed-out user cannot be served there (the API is not a sign-in surface),
 * so the API redirects the auth window to /auth/extension/continue on the web
 * with the original OAuth parameters. This page makes the user sign in, then
 * sends the auth window BACK to the API's authorize endpoint with exactly the
 * parameters below — re-validated here so the web never forwards an arbitrary
 * redirect target or a malformed PKCE challenge.
 *
 * Anything that fails validation renders an error and goes nowhere. The API
 * re-validates everything (allow-listed redirect, client, PKCE); this is
 * defence in depth and an honest error page, not the authority.
 */

export const EXTENSION_CLIENT_ID = "proovra-extension";

const REDIRECT_URI_RE = /^https:\/\/[a-p]{32}\.chromiumapp\.org\/[A-Za-z0-9._-]*$/;
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const SCOPE_RE = /^[A-Za-z0-9:._ -]{1,256}$/;

export type ExtensionAuthorizeParams = {
  response_type: "code";
  client_id: typeof EXTENSION_CLIENT_ID;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  state: string;
  scope?: string;
};

export type ExtensionAuthorizeValidation =
  | { ok: true; params: ExtensionAuthorizeParams; query: string }
  | { ok: false; reason: string };

function single(query: URLSearchParams, key: string): string | null {
  const all = query.getAll(key);
  if (all.length !== 1) return null;
  return all[0];
}

export function validateExtensionAuthorizeQuery(
  query: URLSearchParams,
): ExtensionAuthorizeValidation {
  const responseType = single(query, "response_type");
  if (responseType !== "code") return { ok: false, reason: "response_type" };

  const clientId = single(query, "client_id");
  if (clientId !== EXTENSION_CLIENT_ID) return { ok: false, reason: "client_id" };

  const redirectUri = single(query, "redirect_uri");
  if (!redirectUri || !REDIRECT_URI_RE.test(redirectUri)) {
    return { ok: false, reason: "redirect_uri" };
  }

  const challenge = single(query, "code_challenge");
  if (!challenge || !CODE_CHALLENGE_RE.test(challenge)) {
    return { ok: false, reason: "code_challenge" };
  }

  const method = single(query, "code_challenge_method");
  if (method !== "S256") return { ok: false, reason: "code_challenge_method" };

  const state = single(query, "state");
  if (!state || state.length < 1 || state.length > 256) {
    return { ok: false, reason: "state" };
  }

  const scopeValues = query.getAll("scope");
  if (scopeValues.length > 1) return { ok: false, reason: "scope" };
  const scope = scopeValues[0];
  if (scope !== undefined && !SCOPE_RE.test(scope)) return { ok: false, reason: "scope" };

  const params: ExtensionAuthorizeParams = {
    response_type: "code",
    client_id: EXTENSION_CLIENT_ID,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    ...(scope !== undefined ? { scope } : {}),
  };
  // Rebuilt from the validated values only — unknown parameters are dropped.
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) out.set(k, v as string);
  return { ok: true, params, query: out.toString() };
}

export function extensionAuthorizeUrl(apiBase: string, query: string): string {
  return `${apiBase.replace(/\/+$/, "")}/v1/oauth/extension/authorize?${query}`;
}
