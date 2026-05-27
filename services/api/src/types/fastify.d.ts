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
