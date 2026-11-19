/**
 * PRO-K1-03 (WS-ENT, RG-13) — the server half of the web's Enterprise route
 * policy for the investigation graph, investigation diagnostics and SIU APIs.
 *
 * The web hides /investigation/** and the SIU tab from every workspace that is
 * not an Enterprise organization (tiers.ts, ENTERPRISE_ONLY_ROUTE_IDS,
 * MatterWorkspace `flags.isEnterpriseWorkspace`), while the API served and
 * mutated for any member of any workspace — a Pro owner could write manual
 * relationships, enqueue a whole-workspace graph reconcile and store SIU
 * export bundles from their personal workspace.
 *
 * This asks the SAME authority the envelope and the audit-transparency route
 * ask (`workspaceIsEnterpriseOrganization`, B2A-F-08), for the workspace the
 * caller was just authorized in, AFTER membership is proven (a non-member
 * still gets the concealed 404). The refusal is an actionable plan refusal
 * (DEC-11), the shape the audit-transparency route already answers. It is
 * evaluated per request, so a contract that becomes ACTIVE opens the routes
 * without a redeploy, and one that lapses closes new use.
 */
import type { FastifyReply } from "fastify";

import { workspaceIsEnterpriseOrganization } from "../services/platform-context/enterprise-authority.js";

export const ENTERPRISE_ORGANIZATION_REFUSAL = {
  denial: "ENTITLEMENT_REQUIRED",
  requirement: "ENTERPRISE_ORGANIZATION_WORKSPACE",
  message: "Investigation and SIU tools are part of an Enterprise organization workspace.",
} as const;

/**
 * PRO-A2-09 (WS-ENT) — the same question for the identity-administration
 * GRANTS the web offers only inside /security-center (tier ENTERPRISE): a new
 * per-member capability grant and a new delegated-administration scope. Reads
 * and every reduction (revoke, suspend, disable, shorten) stay answered by
 * role alone, so a workspace that stops being Enterprise can still take
 * standing authority away (DEC-10).
 */
export const ENTERPRISE_IDENTITY_ADMIN_REFUSAL = {
  denial: "ENTITLEMENT_REQUIRED",
  requirement: "ENTERPRISE_ORGANIZATION_WORKSPACE",
  message:
    "Per-member capability grants and delegated administration are part of an Enterprise organization workspace. Existing grants can still be read and revoked.",
} as const;

/** True when the refusal was sent (the caller returns). Fails closed. */
export async function refuseUnlessEnterpriseOrganization(
  reply: FastifyReply,
  teamId: string,
  refusal: { denial: string; requirement: string; message: string } = ENTERPRISE_ORGANIZATION_REFUSAL,
): Promise<boolean> {
  let enterprise = false;
  try {
    enterprise = await workspaceIsEnterpriseOrganization(teamId);
  } catch {
    enterprise = false;
  }
  if (enterprise) return false;
  reply.code(403).send(refusal);
  return true;
}
