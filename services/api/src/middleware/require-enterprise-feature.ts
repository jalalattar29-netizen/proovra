import type { FastifyRequest, FastifyReply } from "fastify";
import {
  assertWorkspaceAllowsEnterpriseFeature,
} from "../services/billing-enforcement.service.js";
import type { EnterpriseFeatureFlags } from "../services/plan-catalog.service.js";
import { getPersonalWorkspaceScope } from "../services/workspace-billing.service.js";

type AuthedRequest = FastifyRequest & { user?: { sub?: string } };

/**
 * Fastify preHandler factory that gates a route on an Enterprise
 * governance feature. Returns 402 with `code: "ENTERPRISE_FEATURE_REQUIRED"`
 * when the caller's plan does not include the feature.
 *
 * Usage at route registration:
 *
 *   app.post("/v1/legal-holds", {
 *     preHandler: [requireAuth, requireEnterpriseFeature("legalHold")],
 *   }, handler);
 *
 * Use this on every route that maps to a capability advertised as
 * Enterprise-only on the public Pricing page (SAML SSO, SCIM, MFA
 * enforcement administration, legal hold mutations, custom retention
 * policies, organization audit log export, Object Lock mutations,
 * access reviews, session governance).
 */
export function requireEnterpriseFeature(
  feature: keyof EnterpriseFeatureFlags,
) {
  return async function preHandler(
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
    const userId = (req as AuthedRequest).user?.sub;
    if (!userId) {
      // Auth middleware should have run first; defensive 401.
      return reply
        .code(401)
        .send({ code: "UNAUTHORIZED", message: "Authentication required" });
    }

    let scope;
    try {
      scope = await getPersonalWorkspaceScope(userId);
    } catch {
      return reply
        .code(500)
        .send({ code: "SCOPE_RESOLUTION_FAILED", message: "Internal error" });
    }

    try {
      assertWorkspaceAllowsEnterpriseFeature(scope, feature);
    } catch (err) {
      const code =
        (err as { code?: string }).code ?? "ENTERPRISE_FEATURE_REQUIRED";
      const status = (err as { statusCode?: number }).statusCode ?? 402;
      return reply.code(status).send({
        code,
        message:
          (err as Error).message ??
          `Feature requires Enterprise plan: ${feature}`,
        upgradeCta: "/contact-sales",
      });
    }
  };
}
