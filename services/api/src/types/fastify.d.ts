import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    user?: {
      sub: string;
      provider: string;
      email?: string | null;
      role?: string | null;
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
