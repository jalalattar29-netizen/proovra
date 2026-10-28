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

/**
 * Bounded reason codes — what startup validation and readiness report. Never a
 * value: the variable NAME and one of these is the whole diagnosis.
 */
export type WebauthnConfigIssue =
  | "webauthn_origin_not_url"
  | "webauthn_origin_insecure"
  | "webauthn_rp_not_host"
  | "webauthn_origins_empty"
  | "webauthn_origin_outside_rp";

export type WebauthnConfigEnvName = "WEBAUTHN_RP_ID" | "WEBAUTHN_ORIGINS" | "APP_BASE_URL";

export class WebauthnConfigError extends Error {
  constructor(
    message: string,
    readonly code: WebauthnConfigIssue,
    readonly envName: WebauthnConfigEnvName,
  ) {
    super(message);
    this.name = "WebauthnConfigError";
  }
}

const DEFAULT_APP_BASE_URL = "https://app.proovra.com";
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function parseOrigin(raw: string, envName: WebauthnConfigEnvName): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WebauthnConfigError("A WebAuthn origin is not a valid URL.", "webauthn_origin_not_url", envName);
  }
  const isLocal = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new WebauthnConfigError(
      "A WebAuthn origin must be https (http only for localhost).",
      "webauthn_origin_insecure",
      envName,
    );
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
  const base = () => parseOrigin(env.APP_BASE_URL?.trim() || DEFAULT_APP_BASE_URL, "APP_BASE_URL");

  const rpID = (explicitRp || base().hostname).toLowerCase();
  if (!HOST_RE.test(rpID)) {
    throw new WebauthnConfigError(
      "WEBAUTHN_RP_ID must be a bare host name.",
      "webauthn_rp_not_host",
      explicitRp ? "WEBAUTHN_RP_ID" : "APP_BASE_URL",
    );
  }

  const rawOrigins = explicitOrigins
    ? explicitOrigins.split(",").map((s) => s.trim()).filter(Boolean)
    : [base().origin];
  if (rawOrigins.length === 0) {
    throw new WebauthnConfigError("WEBAUTHN_ORIGINS names no origin.", "webauthn_origins_empty", "WEBAUTHN_ORIGINS");
  }
  const origins = rawOrigins.map((raw) => {
    const originsFrom: WebauthnConfigEnvName = explicitOrigins ? "WEBAUTHN_ORIGINS" : "APP_BASE_URL";
    const url = parseOrigin(raw, originsFrom);
    if (!hostMatchesRp(url.hostname, rpID)) {
      throw new WebauthnConfigError(
        "A WebAuthn origin is not within the RP id.",
        "webauthn_origin_outside_rp",
        originsFrom,
      );
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

/**
 * WHAT STARTUP VALIDATION AND READINESS READ (2026-10-28 release follow-up).
 *
 * Every caller above treats an unusable config as "passkeys unavailable" — the
 * right answer for one ceremony, and a silent one for the deployment: a passkey
 * holder's step-up then quietly falls to the next authenticator on the ladder.
 * So the same parser is consulted at boot, and a config it refuses is a
 * production config violation (boot refused, `/readyz` 503) — the contract
 * every other refused-by-construction setting already has.
 *
 * `basis` says where each half came from, because an RP id DERIVED from
 * APP_BASE_URL changes when that URL does, and changing the RP id orphans
 * every enrolled passkey. The values are public host names, never secrets.
 */
export type WebauthnConfigInspection =
  | {
      ok: true;
      config: WebauthnConfig;
      basis: { rpID: "explicit" | "app_base_url"; origins: "explicit" | "app_base_url" };
    }
  | { ok: false; issue: WebauthnConfigIssue; envName: WebauthnConfigEnvName };

export function inspectWebauthnConfig(env: NodeJS.ProcessEnv = process.env): WebauthnConfigInspection {
  try {
    const config = resolveWebauthnConfig(env);
    return {
      ok: true,
      config,
      basis: {
        rpID: env.WEBAUTHN_RP_ID?.trim() ? "explicit" : "app_base_url",
        origins: env.WEBAUTHN_ORIGINS?.trim() ? "explicit" : "app_base_url",
      },
    };
  } catch (err) {
    if (err instanceof WebauthnConfigError) return { ok: false, issue: err.code, envName: err.envName };
    throw err;
  }
}
