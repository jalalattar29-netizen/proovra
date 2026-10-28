/**
 * 2026-10-28 — the SP-side endpoint identities of SAML and OIDC sign-in, in ONE
 * place. The SAML login/ACS routes, the OIDC initiate/callback routes and the
 * IDP_REAUTH step-up round trip must address the IdP with byte-identical
 * values (the ACS URL is signed into every assertion's Destination/Recipient,
 * the redirect URI is compared by the IdP at the code exchange), so they are
 * computed here rather than copied. Behaviour is unchanged from the route-local
 * helpers these replaced.
 */
import type { FastifyRequest } from "fastify";

/**
 * The SAML AssertionConsumerService URL (HTTP-POST binding endpoint the IdP
 * POSTs the SAMLResponse to).
 */
export function samlAcsUrl(req: FastifyRequest): string {
  const env = process.env["SAML_ACS_URL"];
  if (env) return env;
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = req.headers["host"] ?? "";
  return `${proto}://${host}/v1/auth/saml/acs`;
}

/** The SP entityID for a connection: {apiBaseUrl}/saml/sp/{connectionId}. */
export function samlSpEntityId(connectionId: string): string {
  const base = process.env["API_BASE_URL"] ?? "https://api.proovra.com";
  return `${base.replace(/\/$/, "")}/saml/sp/${connectionId}`;
}

/**
 * The SP private signing key (PEM) for AuthnRequest signing. Prefers the
 * per-connection key; falls back to the platform-wide SAML_SP_PRIVATE_KEY env.
 * Null when no key material is available (the request is left unsigned).
 * Never logged.
 */
export function samlSpSigningKey(connectionPrivateKey: string | null | undefined): string | null {
  if (connectionPrivateKey && connectionPrivateKey.trim().length > 0) {
    return connectionPrivateKey;
  }
  const envKey = process.env["SAML_SP_PRIVATE_KEY"];
  if (envKey && envKey.trim().length > 0) {
    // Support newline-escaped env values (common in container secrets).
    return envKey.includes("\\n") ? envKey.replace(/\\n/g, "\n") : envKey;
  }
  return null;
}

/** The OIDC redirect URI registered with the IdP (the callback route). */
export function oidcRedirectUri(req: FastifyRequest): string {
  // Production: build from request host. Dev: env override allowed.
  const env = process.env["SSO_CALLBACK_REDIRECT_URI"];
  if (env) return env;
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = req.headers["host"] ?? "";
  return `${proto}://${host}/v1/auth/sso/callback`;
}
