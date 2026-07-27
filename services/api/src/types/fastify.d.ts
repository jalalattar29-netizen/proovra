import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    user?: {
      sub: string;
      provider: string;
      email?: string | null;
      role?: string | null;
      // Phase 2.4 — `sessionIdHash` is the SHA-256 of the JWT `sid`
      // claim. The middleware computes it once per request so route
      // handlers can identify "the current session" without duplicating
      // the JWT verification or hashing logic. Optional because
      // pre-Phase-19 tokens (and tests that build a minimal stub req.user)
      // may not have a `sid`.
      sessionIdHash?: string | null;
      // PHASE 10 §10.2 — the server-VERIFIED authentication provenance carried
      // by the session token. `requireAuth` only sets `req.user` when this is a
      // SUPPORTED provenance (missing/UNKNOWN/legacy is rejected at the door →
      // reauthenticate), so downstream org/session-policy gates can trust it.
      authMethod?: string | null;
      /** Epoch seconds of the primary authentication ceremony (never reset on refresh). */
      authAt?: number | null;
      /** ORG-BOUND SSO: the exact verified SsoConnection.id (SAML/OIDC only). */
      ssoConnId?: string | null;
      /** Epoch seconds MFA was satisfied (augments the primary method). */
      mfaAt?: number | null;
    };
    apiCredential?: {
      credentialId: string;
      teamId: string;
      scopes: string[];
      // Phase 17 — service account hardening fields. Optional in the
      // type for back-compat with callers that build a minimal stub in
      // tests; the middleware always populates them.
      ipAllowlist?: ReadonlyArray<string>;
      rotationRequired?: boolean;
      environment?: string | null;
      expiresAtUtc?: Date | null;
    };
  }
}
