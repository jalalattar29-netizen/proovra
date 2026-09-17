/**
 * Extension configuration. The API origin and OAuth endpoints are injected at
 * build time from environment (PROOVRA_API_ORIGIN etc.) with safe localhost
 * defaults, so the same codebase builds for dev, staging and production without
 * a code change and without a hardcoded secret.
 */

// Replaced at build time by build.mjs via esbuild `define`.
declare const __PROOVRA_API_ORIGIN__: string;
declare const __PROOVRA_AUTH_AUTHORIZE_URL__: string;
declare const __PROOVRA_AUTH_TOKEN_URL__: string;
declare const __PROOVRA_OAUTH_CLIENT_ID__: string;
declare const __PROOVRA_EXTENSION_VERSION__: string;

export const CONFIG = {
  apiOrigin: __PROOVRA_API_ORIGIN__,
  authAuthorizeUrl: __PROOVRA_AUTH_AUTHORIZE_URL__,
  authTokenUrl: __PROOVRA_AUTH_TOKEN_URL__,
  oauthClientId: __PROOVRA_OAUTH_CLIENT_ID__,
  extensionVersion: __PROOVRA_EXTENSION_VERSION__,
} as const;

/** Bounds enforced client-side; the server re-enforces the manifest bounds. */
export const CAPTURE_LIMITS = {
  /** Max full-page tiles before we stop and mark the capture PARTIAL. */
  maxTiles: 40,
  /** Max full-page height (px) we will attempt to tile. */
  maxPageHeightPx: 40000,
  /** Per-capture wall-clock budget (ms). */
  captureTimeBudgetMs: 30000,
  /** Delay after each scroll so lazy content can settle (ms). */
  tileSettleMs: 250,
} as const;
