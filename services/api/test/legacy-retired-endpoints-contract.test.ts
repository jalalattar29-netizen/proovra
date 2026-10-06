/**
 * RETIRED LEGACY ENDPOINTS — the 410 response contract, behaviourally.
 *
 * The production route modules are registered on a real Fastify instance and
 * driven by injected requests. Authentication, the legal gate, the database
 * client and the audit/security-event sinks are substituted at their module
 * boundaries; the ROUTING, status codes and response bodies are the shipped
 * ones.
 *
 * WHAT IT PROVES
 * ---------------------------------------------------------------------------
 * Every retired `/v1/api-keys*` and `/v1/users/me` personal-security call
 * answers 410 with a stable machine code and the canonical replacement, emits
 * the retirement event operators watch for, and never tells the caller about
 * a repository path, a document, a finding id or a phase.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  audits: [] as Array<Record<string, unknown>>,
  securityEvents: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { sub: "user-1" };
  },
}));

vi.mock("../src/middleware/require-legal-acceptance.js", () => ({
  requireLegalAcceptance: async () => undefined,
}));

vi.mock("../src/auth.js", () => ({
  getAuthUserId: () => "user-1",
}));

vi.mock("../src/db.js", () => ({ prisma: {} }));

vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitPlatformAudit: async (input: Record<string, unknown>) => {
    H.audits.push(input);
  },
}));

vi.mock("../src/services/security/security-event.service.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../src/services/security/security-event.service.js",
  );
  return {
    ...actual,
    safeEmitSecurityEvent: (input: Record<string, unknown>) => {
      H.securityEvents.push(input);
    },
  };
});

/** Anything an outside caller must never be shown in a refusal. */
const INTERNAL_LEAK = /docs\/|\.md\b|ledger|audit-closure|Final-|\bPhase\b|\bA-3\b|\bD-5\b/i;

describe("retired legacy endpoints — 410 contract", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    H.audits.length = 0;
    H.securityEvents.length = 0;
    const { enterpriseRoutes } = await import("../src/routes/enterprise.routes.js");
    const { usersRoutes } = await import("../src/routes/users.routes.js");
    app = Fastify();
    await app.register(enterpriseRoutes);
    await app.register(usersRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const apiKeyCalls = [
    { method: "GET", url: "/v1/api-keys" },
    { method: "POST", url: "/v1/api-keys" },
    { method: "DELETE", url: "/v1/api-keys/key-1" },
    { method: "POST", url: "/v1/api-keys/key-1/rotate" },
    { method: "PATCH", url: "/v1/api-keys/key-1/rate-limit" },
  ] as const;

  for (const call of apiKeyCalls) {
    it(`${call.method} ${call.url} answers 410 API_KEYS_LEGACY_RETIRED with the canonical surface`, async () => {
      const res = await app.inject({ method: call.method, url: call.url, payload: call.method === "GET" || call.method === "DELETE" ? undefined : {} });
      expect(res.statusCode).toBe(410);
      const body = res.json() as Record<string, unknown>;
      expect(body.code).toBe("API_KEYS_LEGACY_RETIRED");
      expect(body.canonicalSurface).toBe("/v1/integrations/api-keys");
      expect(typeof body.detail).toBe("string");
      expect(res.body).not.toMatch(INTERNAL_LEAK);
      expect(H.audits.map((a) => a.action)).toContain("enterprise.api_key_legacy_endpoint_called");
    });
  }

  const personalSecurityCalls = [
    { method: "GET", url: "/v1/users/me/sessions" },
    { method: "DELETE", url: "/v1/users/me/sessions/session-1" },
    { method: "POST", url: "/v1/users/me/password/change" },
  ] as const;

  for (const call of personalSecurityCalls) {
    it(`${call.method} ${call.url} answers 410 PERSONAL_SECURITY_LEGACY_RETIRED with the canonical surfaces`, async () => {
      const res = await app.inject({
        method: call.method,
        url: call.url,
        payload: call.method === "POST" ? { currentPassword: "x", newPassword: "y" } : undefined,
      });
      expect(res.statusCode).toBe(410);
      const body = res.json() as Record<string, unknown>;
      expect(body.code).toBe("PERSONAL_SECURITY_LEGACY_RETIRED");
      expect(body.canonicalPassword).toBe("/v1/identity-security/password");
      expect(body.canonicalSessionsList).toBe("/v1/identity-security/my-sessions");
      expect(body.canonicalSessionsRevokeOthers).toBe("/v1/identity-security/my-sessions/revoke-others");
      expect(typeof body.detail).toBe("string");
      expect(res.body).not.toMatch(INTERNAL_LEAK);
      expect(
        H.securityEvents.some(
          (e) =>
            e.eventType === "high_risk_action_blocked" &&
            (e.details as Record<string, unknown>)?.reason === "personal_security_legacy_endpoint_called",
        ),
      ).toBe(true);
    });
  }
});
