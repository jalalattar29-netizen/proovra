/**
 * WEBAUTHN RELYING-PARTY CONFIGURATION (2026-10-28).
 *
 * The ONE place the API decides which relying party it is and which origins
 * may answer a ceremony for it. Both registration and assertion verification
 * read it, so a passkey bound here is checked against exactly the same RP id
 * and origin set it was created under.
 *
 *   rpID     WEBAUTHN_RP_ID, else the hostname of APP_BASE_URL.
 *   origins  WEBAUTHN_ORIGINS (comma-separated), else the origin of
 *            APP_BASE_URL.
 *   rpName   "PROOVRA".
 *
 * FAIL CLOSED. An origin that does not parse as an absolute http(s) URL, an
 * rpID that is not a bare host name, or an origin whose host is not the rpID
 * or a subdomain of it (a browser would refuse that pairing anyway) is a
 * configuration error: `resolveWebauthnConfig` throws, and every caller
 * treats that as "passkeys unavailable" rather than guessing an RP. Plain
 * http is accepted only for localhost (the WebAuthn secure-context rule).
 */

export type WebauthnConfig = {
  rpID: string;
  rpName: string;
  origins: string[];
};

export class WebauthnConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebauthnConfigError";
  }
}

const DEFAULT_APP_BASE_URL = "https://app.proovra.com";
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function parseOrigin(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WebauthnConfigError("A WebAuthn origin is not a valid URL.");
  }
  const isLocal = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new WebauthnConfigError("A WebAuthn origin must be https (http only for localhost).");
  }
  return url;
}

function hostMatchesRp(host: string, rpID: string): boolean {
  return host === rpID || host.endsWith(`.${rpID}`);
}

/** Reads the environment on every call (tests and deploys change it). */
export function resolveWebauthnConfig(env: NodeJS.ProcessEnv = process.env): WebauthnConfig {
  // APP_BASE_URL is consulted only for what the explicit settings leave out,
  // so an operator who sets both never depends on it.
  const explicitRp = env.WEBAUTHN_RP_ID?.trim();
  const explicitOrigins = env.WEBAUTHN_ORIGINS?.trim();
  const base = () => parseOrigin(env.APP_BASE_URL?.trim() || DEFAULT_APP_BASE_URL);

  const rpID = (explicitRp || base().hostname).toLowerCase();
  if (!HOST_RE.test(rpID)) {
    throw new WebauthnConfigError("WEBAUTHN_RP_ID must be a bare host name.");
  }

  const rawOrigins = explicitOrigins
    ? explicitOrigins.split(",").map((s) => s.trim()).filter(Boolean)
    : [base().origin];
  if (rawOrigins.length === 0) {
    throw new WebauthnConfigError("WEBAUTHN_ORIGINS names no origin.");
  }
  const origins = rawOrigins.map((raw) => {
    const url = parseOrigin(raw);
    if (!hostMatchesRp(url.hostname, rpID)) {
      throw new WebauthnConfigError("A WebAuthn origin is not within the RP id.");
    }
    return url.origin;
  });

  return { rpID, rpName: "PROOVRA", origins: Array.from(new Set(origins)) };
}

/** The config, or null when it is unusable — for paths that must not throw. */
export function tryResolveWebauthnConfig(env: NodeJS.ProcessEnv = process.env): WebauthnConfig | null {
  try {
    return resolveWebauthnConfig(env);
  } catch {
    return null;
  }
}
