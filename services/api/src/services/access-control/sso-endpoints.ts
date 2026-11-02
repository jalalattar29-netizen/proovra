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
import { absoluteInternalUrl, internalNavPath } from "@proovra/shared";

import { isSealedText, openSealedText } from "../security/sealed-text.js";

/**
 * The SAML AssertionConsumerService URL (HTTP-POST binding endpoint the IdP
 * POSTs the SAMLResponse to).
 */
export function samlAcsUrl(req: FastifyRequest): string {
  // OPS-014 — the same names, in the same order, as the boot guard, so the value
  // it validates is the value used here.
  const env = process.env["SAML_SP_ACS_URL"] || process.env["SAML_ACS_URL"];
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
    // IDENT-021 — sealed at rest. A key stored before sealing is read as it is
    // until it is next rotated.
    return isSealedText(connectionPrivateKey)
      ? openSealedText(connectionPrivateKey)
      : connectionPrivateKey;
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

/**
 * IDENT-003 — where a person lands after an SSO callback. The callbacks run on
 * the API host, which has no pages, so every redirect out of them is absolute on
 * the web host.
 */
export function webPageUrl(path: string): string {
  return absoluteInternalUrl(
    process.env["WEB_BASE_URL"] || "https://www.proovra.com",
    internalNavPath(path),
  );
}

/** The sign-in page, carrying a sanitised reason and the page they were after. */
export function signInErrorUrl(
  param: "sso_error" | "saml_error",
  reason: string,
  destination: string,
): string {
  const params = new URLSearchParams();
  params.set(param, reason.slice(0, 64));
  if (destination !== "/") params.set("next", destination);
  return `${webPageUrl("/login")}?${params.toString()}`;
}
