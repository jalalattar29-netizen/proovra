/**
 * TEAM-SPEC R4 / §2.11 (2026-11-23) — WHO MAY ISSUE AND REVOKE AN
 * EXTERNAL-REVIEW GRANT. One predicate for every door.
 *
 * Before this module the doors disagreed:
 *   POST /v1/external-review/grants                 governance.legal_hold.manage
 *   POST /v1/external-review/grants/:id/revoke      governance.legal_hold.manage
 *   POST /v1/external-review/invitations/bulk       review.assign + OWNER/ADMIN tier
 *   POST /v1/external-review/invitations/:id/revoke review.assign + OWNER/ADMIN tier
 *   POST /v1/external-review/invitations/bulk/revoke review.assign + OWNER/ADMIN tier
 * (the single-issue route named "a dedicated permission" as a follow-up).
 *
 * THE PREDICATE is the INTERSECTION of what those doors already enforced, so no
 * role gains power through any of them:
 *
 *   proven role OWNER or ADMIN
 *   ∧ the proven capability set holds `review.assign`
 *   ∧ the proven capability set holds `governance.legal_hold.manage`
 *
 * By the role matrix (packages/shared permissions.ts) this is exactly OWNER and
 * ADMIN: both hold both permissions by role; MEMBER (canonical REVIEWER) holds
 * review.assign but not legal_hold.manage; VIEWER holds neither. The only
 * narrowing is theoretical: a member who held ONE of the two through a
 * capability grant could pass one door before and passes none now.
 *
 * Commercial and step-up gates stay where they were: issuing needs the
 * workspace's External Review entitlement and a fresh step-up; revoking needs
 * neither (a workspace that lost the entitlement must still be able to close a
 * door it opened).
 *
 * The list routes project `viewerCanIssue` / `viewerCanRevoke` from THIS
 * predicate, so the panel and console offer issue/revoke only where the API
 * accepts them.
 */
import type { FastifyRequest } from "fastify";

import {
  assertMintedAuthorizedWorkspaceContext,
  contextHasCapability,
  evaluateCurrentWorkspace,
  type AuthorizedWorkspaceContext,
} from "../../middleware/authorize.js";
import { workspaceIncludesExternalReview } from "../billing-enforcement.service.js";
import { quarantinedStepUpSessionId } from "../identity-security/step-up-middleware.js";

/** The primary permission every issue/revoke door authorizes with. */
export const EXTERNAL_REVIEW_MANAGE_PERMISSION = "review.assign" as const;
/** The second permission of the intersection (the single-issue route's former gate). */
export const EXTERNAL_REVIEW_MANAGE_SECONDARY_PERMISSION = "governance.legal_hold.manage" as const;

/**
 * THE predicate. Reads only the PROVEN context, bound to the workspace the
 * caller is acting on (a genuine context minted for another workspace is
 * refused by the binding check, never read).
 */
export function externalReviewManageAllowed(
  candidate: AuthorizedWorkspaceContext,
  expectedWorkspaceId: string,
): boolean {
  const ctx = assertMintedAuthorizedWorkspaceContext(candidate, { workspaceId: expectedWorkspaceId });
  return (
    (ctx.workspaceRole === "OWNER" || ctx.workspaceRole === "ADMIN") &&
    contextHasCapability(ctx, EXTERNAL_REVIEW_MANAGE_PERMISSION) &&
    contextHasCapability(ctx, EXTERNAL_REVIEW_MANAGE_SECONDARY_PERMISSION)
  );
}

/** A grant the revoke service would still move to REVOKED. */
export function externalReviewGrantRevocableNow(grant: { state: string | null }): boolean {
  return grant.state === "INVITED" || grant.state === "ACTIVE" || grant.state === "BLOCKED_BY_POLICY";
}

export type ExternalReviewViewerActions = {
  /** The workspace issue/revoke act on for this caller (the request's active workspace). */
  actionsWorkspaceId: string | null;
  /** The listed workspace is the one issue/revoke would act on. */
  sameWorkspace: boolean;
  /** Issue would pass every gate but the step-up challenge itself. */
  canIssue: boolean;
  /** Revoke would pass the permission gate (per-grant state is applied by the caller). */
  canManage: boolean;
};

/**
 * What THIS caller may do to grants of `listedTeamId` through the issue/revoke
 * doors. Those doors act on the request's ACTIVE workspace
 * (`authorizeCurrentWorkspaceOrFail`), so a list read for a different
 * workspace offers nothing: acting there would land on another workspace.
 * Never sends a response and never throws: a failed decision is "nothing".
 */
export async function viewerExternalReviewActions(
  req: FastifyRequest,
  listedTeamId: string,
): Promise<ExternalReviewViewerActions> {
  const none = (actionsWorkspaceId: string | null, sameWorkspace: boolean): ExternalReviewViewerActions => ({
    actionsWorkspaceId,
    sameWorkspace,
    canIssue: false,
    canManage: false,
  });
  try {
    const outcome = await evaluateCurrentWorkspace(req, {
      permission: EXTERNAL_REVIEW_MANAGE_PERMISSION,
      antiEnumeration: false,
    });
    if (!outcome.allowed) return none(null, false);
    const ctx = outcome.context;
    const sameWorkspace = ctx.workspaceId === listedTeamId;
    if (!sameWorkspace) return none(ctx.workspaceId, false);
    if (!externalReviewManageAllowed(ctx, ctx.workspaceId)) return none(ctx.workspaceId, true);
    const canIssue =
      (await workspaceIncludesExternalReview(ctx.workspaceId)) &&
      !(await quarantinedStepUpSessionId(req, ctx.userId));
    return { actionsWorkspaceId: ctx.workspaceId, sameWorkspace: true, canIssue, canManage: true };
  } catch {
    return none(null, false);
  }
}

/**
 * The clear refusal for a request that names a workspace other than the active
 * one the issue/revoke doors act on. Optional on every door (older clients send
 * no `teamId`); when sent it must match.
 */
export const EXTERNAL_REVIEW_WORKSPACE_MISMATCH_BODY = {
  error: {
    code: "EXTERNAL_REVIEW_WORKSPACE_MISMATCH",
    message:
      "This action applies to your active workspace, which is not the workspace named in the request. Switch workspace and try again.",
  },
} as const;
