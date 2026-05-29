/**
 * Phase 32.8D-frontend-closure — Canonical case mutation permission model.
 *
 * Each route guard for a case mutation calls into a single resolver
 * here so the rules are documented in one place. The rules use ONLY
 * the bounded Prisma `TeamRole` enum (OWNER / ADMIN / MEMBER / VIEWER)
 * plus the bounded `CaseAssignmentRole` enum
 * (OWNER / INVESTIGATOR / REVIEWER / GOVERNANCE / OBSERVER).
 *
 * The previous route guards referenced non-existent `OPERATOR` /
 * `INVESTIGATOR` / `AUDITOR` values on `member.role`. Those values
 * never appeared (TeamRole has only four values) so the dead clauses
 * effectively reduced to "OWNER/ADMIN only" — confusing both
 * frontend and operator. This module replaces that drift with a
 * bounded matrix.
 *
 * Hard rules:
 *
 *   1. Backend is the final authority. Frontend uses
 *      ctx.can("CASE_*") as a UX hint only.
 *   2. Personal cases: the case owner is always allowed.
 *      `requireCaseAccess` returns role="OWNER" for personal owners.
 *   3. Team cases: TeamRole is the primary gate. Per-case
 *      CaseAssignment role can ELEVATE permissions for specific
 *      mutations (e.g. an assigned INVESTIGATOR may change status
 *      even if their workspace role is MEMBER).
 *   4. CaseAssignment role is NEVER confused with TeamRole. Frontend
 *      never sees these synonyms.
 *   5. VIEWER never mutates.
 */

import { prisma } from "../../db.js";

/**
 * The bounded set of case mutation classes the route layer uses to
 * gate access. Adding a class requires updating this enum AND the
 * matrix below.
 *
 * Phase 32.8D-frontend-closure-2 — `EVIDENCE_UNLINK_LEGACY` is a
 * narrower class than `EVIDENCE_LINK`: it covers the audited removal
 * of a legacy `Evidence.caseId` attachment that has no
 * `CaseEvidenceLink` row. The same writers can perform it (matches
 * EVIDENCE_LINK), but the helper exists so future tightening (e.g.
 * "OWNER/ADMIN only for legacy unlink") doesn't require editing all
 * call sites.
 */
export type CaseMutation =
  | "STATUS_CHANGE"
  | "ASSIGN"
  | "COMMENT"
  | "COMMENT_RESOLVE"
  | "EVIDENCE_LINK"
  | "EVIDENCE_UNLINK_LEGACY"
  // Phase O-blockers / A-1 — destructive case mutation. Tighter than
  // every other action in this matrix: ONLY workspace OWNER or ADMIN
  // (or, for personal cases, the synthetic owner returned by
  // `requireCaseAccess`) may delete a case. Reviewer / assigned
  // INVESTIGATOR / MEMBER all receive 403.
  | "DELETE"
  // Phase O-blockers / A-1 sister — rename / settings PATCH carries
  // identical destructive-attribute risk to DELETE (e.g., changing
  // title obscures audit). Reuses the same OWNER/ADMIN gate so the
  // matrix is the single source of truth.
  | "MANAGE_SETTINGS";

/**
 * The narrow role surface this helper accepts. `requireCaseAccess`
 * returns either:
 *   - "OWNER"  (synthetic: case owner)
 *   - "MEMBER" (synthetic: explicit CaseAccess entry)
 *   - one of the real `TeamRole` values (OWNER/ADMIN/MEMBER/VIEWER)
 *     when access came from workspace membership.
 */
export type CaseAccessRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

/**
 * The bounded set of CaseAssignment roles. Mirrors the Prisma
 * `CaseAssignmentRole` enum exactly.
 */
export type CaseAssignmentRole =
  | "OWNER"
  | "INVESTIGATOR"
  | "REVIEWER"
  | "GOVERNANCE"
  | "OBSERVER";

/**
 * Returns the user's ACTIVE CaseAssignment role names for a given
 * case. A user may hold multiple roles (e.g. INVESTIGATOR + REVIEWER).
 * Empty array means no active assignments.
 */
export async function getCaseAssignmentRoles(
  caseId: string,
  userId: string,
): Promise<CaseAssignmentRole[]> {
  const rows = await prisma.caseAssignment.findMany({
    where: { caseId, assignedToUserId: userId, status: "ACTIVE" },
    select: { role: true },
  });
  return rows.map((r) => r.role as CaseAssignmentRole);
}

/**
 * Resolve whether a mutation is allowed.
 *
 * Input: the case-access role returned by `requireCaseAccess` plus
 * the user's ACTIVE assignment roles on the case.
 *
 * Output: `{ allowed: true }` or `{ allowed: false, reason }` with a
 * bounded reason code that the route forwards as a 403 detail. The
 * frontend renders the reason verbatim — no extra translation.
 */
export function evaluateCaseMutationPermission(input: {
  mutation: CaseMutation;
  accessRole: CaseAccessRole;
  assignmentRoles: ReadonlyArray<CaseAssignmentRole>;
}): { allowed: true } | { allowed: false; reason: string } {
  const { mutation, accessRole, assignmentRoles } = input;
  const assigned = new Set(assignmentRoles);

  // VIEWER never mutates. Same hard rule for everyone.
  if (accessRole === "VIEWER") {
    return {
      allowed: false,
      reason: "VIEWER role cannot perform case mutations.",
    };
  }

  const isOwnerOrAdmin = accessRole === "OWNER" || accessRole === "ADMIN";
  const isTeamWriter = accessRole === "MEMBER"; // non-viewer team writer
  const assignedAsOwner = assigned.has("OWNER");
  const assignedAsInvestigator = assigned.has("INVESTIGATOR");
  const assignedAsReviewer = assigned.has("REVIEWER");
  const assignedAsGovernance = assigned.has("GOVERNANCE");

  switch (mutation) {
    case "ASSIGN":
      // OWNER/ADMIN at workspace level OR assigned OWNER on the case.
      if (isOwnerOrAdmin || assignedAsOwner) return { allowed: true };
      return {
        allowed: false,
        reason: "Owner or Admin workspace role (or case OWNER assignment) is required to manage assignments.",
      };

    case "STATUS_CHANGE":
      // OWNER/ADMIN at workspace level, OR any team writer, OR an
      // assigned OWNER / INVESTIGATOR on the case.
      if (isOwnerOrAdmin || isTeamWriter) return { allowed: true };
      if (assignedAsOwner || assignedAsInvestigator) return { allowed: true };
      return {
        allowed: false,
        reason: "A non-viewer team role or case OWNER / INVESTIGATOR assignment is required to change status.",
      };

    case "EVIDENCE_LINK":
    case "EVIDENCE_UNLINK_LEGACY":
      // Same gate as STATUS_CHANGE — investigation work. Legacy
      // Evidence.caseId unlinks pass through the same matrix so a
      // future policy tightening only requires editing this branch.
      if (isOwnerOrAdmin || isTeamWriter) return { allowed: true };
      if (assignedAsOwner || assignedAsInvestigator) return { allowed: true };
      return {
        allowed: false,
        reason: "A non-viewer team role or case OWNER / INVESTIGATOR assignment is required to link or unlink evidence.",
      };

    case "COMMENT":
      // Any non-viewer with case access can comment. Assigned
      // reviewers / governance / observers are by definition
      // already past the access gate when they're assigned.
      if (isOwnerOrAdmin || isTeamWriter) return { allowed: true };
      if (
        assignedAsOwner ||
        assignedAsInvestigator ||
        assignedAsReviewer ||
        assignedAsGovernance
      ) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: "A non-viewer team role or an active case assignment is required to comment.",
      };

    case "COMMENT_RESOLVE":
      // Same as comment.
      if (isOwnerOrAdmin || isTeamWriter) return { allowed: true };
      if (
        assignedAsOwner ||
        assignedAsInvestigator ||
        assignedAsReviewer ||
        assignedAsGovernance
      ) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: "A non-viewer team role or an active case assignment is required to resolve comments.",
      };

    case "DELETE":
    case "MANAGE_SETTINGS":
      // Phase O-blockers / A-1 — destructive: workspace OWNER or
      // ADMIN only. The synthetic "OWNER" returned for personal
      // cases by `requireCaseAccess` IS allowed (personal owner can
      // delete their own case). VIEWER was already rejected above.
      // MEMBER and CaseAssignment-only access are explicitly denied.
      if (isOwnerOrAdmin) return { allowed: true };
      return {
        allowed: false,
        reason: "Only workspace OWNER or ADMIN may delete or rename a case.",
      };

    default:
      // Exhaustiveness — TypeScript catches missing cases at build.
      return {
        allowed: false,
        reason: "Unknown case mutation.",
      };
  }
}

/**
 * Phase 32.8D-frontend-closure-2 — Canonical per-case capability map.
 *
 * Computes the full set of mutation gates for a viewer/case pair so
 * the matter-workspace envelope can surface them to the frontend.
 * The frontend then disables buttons on `viewer.canChangeStatus ===
 * false` etc. — the SAME helper that runs in the route guard so
 * there is no drift between display and enforcement.
 *
 * `disabledReasons` is keyed by camelCase action name and only
 * populated when the action is denied; the frontend uses it for
 * tooltip text.
 */
export type CaseViewerCapabilities = {
  canMutate: boolean;
  canManage: boolean;
  canAssign: boolean;
  canChangeStatus: boolean;
  canLinkEvidence: boolean;
  canUnlinkEvidence: boolean;
  canUnlinkLegacyEvidence: boolean;
  canComment: boolean;
  canResolveComment: boolean;
  disabledReasons: Partial<{
    assign: string;
    changeStatus: string;
    linkEvidence: string;
    unlinkEvidence: string;
    unlinkLegacyEvidence: string;
    comment: string;
    resolveComment: string;
  }>;
};

/**
 * Phase O-blockers / A-1 + A-2 — single helper that resolves the
 * caller's CaseAccessRole for a `Case` row AND runs the destructive
 * mutation gate in one shot. Used by `DELETE /v1/cases/:id` and
 * `PATCH /v1/cases/:id` to enforce OWNER/ADMIN-only access.
 *
 * Returns the resolved `accessRole` so the audit log can record the
 * caller's actual privilege level (helps the security team trace
 * REVIEWER / MEMBER attempts).
 */
export type CaseRowForGate = {
  id: string;
  ownerUserId: string | null;
  teamId: string | null;
};

export type DestructiveGateResult =
  | { allowed: true; accessRole: CaseAccessRole }
  | { allowed: false; reason: string; accessRole: CaseAccessRole | "NONE" };

export async function resolveCaseDestructiveGate(input: {
  caseRow: CaseRowForGate;
  userId: string;
  mutation: "DELETE" | "MANAGE_SETTINGS";
}): Promise<DestructiveGateResult> {
  const { caseRow, userId, mutation } = input;

  // Personal case (no teamId): only the case owner is privileged
  // (synthetic OWNER). Anyone else is denied with no access role.
  if (!caseRow.teamId) {
    if (caseRow.ownerUserId === userId) {
      const result = evaluateCaseMutationPermission({
        mutation,
        accessRole: "OWNER",
        assignmentRoles: [],
      });
      if (result.allowed) {
        return { allowed: true, accessRole: "OWNER" };
      }
      return {
        allowed: false,
        reason: result.reason,
        accessRole: "OWNER",
      };
    }
    return {
      allowed: false,
      reason: "Personal cases can only be modified by their owner.",
      accessRole: "NONE",
    };
  }

  // Team case: look up the caller's workspace role.
  const member = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId: caseRow.teamId, userId } },
  });
  if (!member) {
    return {
      allowed: false,
      reason: "Caller is not a member of the case's workspace.",
      accessRole: "NONE",
    };
  }
  const accessRole = member.role as CaseAccessRole;
  const result = evaluateCaseMutationPermission({
    mutation,
    accessRole,
    assignmentRoles: [],
  });
  if (result.allowed) {
    return { allowed: true, accessRole };
  }
  return { allowed: false, reason: result.reason, accessRole };
}

/**
 * Phase O-blockers / A-2 — Cross-team evidence attach guard. Returns
 * `{ allowed: false, reason }` when the evidence row's `teamId` does
 * not match the case row's `teamId`. The handler emits a
 * `CROSS_TEAM_ATTACH_BLOCKED` audit event on rejection so the
 * security team can investigate. Personal-case attachment (case has
 * `teamId === null`) is allowed only when the evidence is also
 * personal (`teamId === null`) — otherwise we'd leak team-scoped
 * evidence into a personal case.
 */
export function evaluateCrossTeamAttach(input: {
  caseTeamId: string | null;
  evidenceTeamId: string | null;
}): { allowed: true } | { allowed: false; reason: string; code: string } {
  if (input.caseTeamId === input.evidenceTeamId) {
    return { allowed: true };
  }
  // The strict UUID equality above means null-vs-uuid is also blocked.
  if (input.caseTeamId === null) {
    return {
      allowed: false,
      reason:
        "Cannot attach team-scoped evidence to a personal case. Personal cases may only hold personal evidence.",
      code: "CROSS_TEAM_ATTACH_BLOCKED",
    };
  }
  if (input.evidenceTeamId === null) {
    return {
      allowed: false,
      reason:
        "Cannot attach personal evidence to a team case. Move the evidence into the workspace first.",
      code: "CROSS_TEAM_ATTACH_BLOCKED",
    };
  }
  return {
    allowed: false,
    reason:
      "Evidence and case belong to different workspaces. Cross-workspace attachment is not permitted.",
    code: "CROSS_TEAM_ATTACH_BLOCKED",
  };
}

export function resolveCaseViewerCapabilities(input: {
  accessRole: CaseAccessRole;
  assignmentRoles: ReadonlyArray<CaseAssignmentRole>;
}): CaseViewerCapabilities {
  const evaluate = (mutation: CaseMutation) =>
    evaluateCaseMutationPermission({
      mutation,
      accessRole: input.accessRole,
      assignmentRoles: input.assignmentRoles,
    });
  const assign = evaluate("ASSIGN");
  const changeStatus = evaluate("STATUS_CHANGE");
  const linkEvidence = evaluate("EVIDENCE_LINK");
  const unlinkLegacy = evaluate("EVIDENCE_UNLINK_LEGACY");
  const comment = evaluate("COMMENT");
  const resolveComment = evaluate("COMMENT_RESOLVE");
  const disabledReasons: CaseViewerCapabilities["disabledReasons"] = {};
  if (!assign.allowed) disabledReasons.assign = assign.reason;
  if (!changeStatus.allowed) disabledReasons.changeStatus = changeStatus.reason;
  if (!linkEvidence.allowed) {
    disabledReasons.linkEvidence = linkEvidence.reason;
    disabledReasons.unlinkEvidence = linkEvidence.reason;
  }
  if (!unlinkLegacy.allowed)
    disabledReasons.unlinkLegacyEvidence = unlinkLegacy.reason;
  if (!comment.allowed) disabledReasons.comment = comment.reason;
  if (!resolveComment.allowed)
    disabledReasons.resolveComment = resolveComment.reason;
  // canMutate / canManage are coarse hints used by older callers.
  // `canManage` is "OWNER/ADMIN team role or assigned OWNER on case"
  // (same as `canAssign`); `canMutate` is "any allowed mutation".
  const canManage = assign.allowed;
  const canMutate =
    changeStatus.allowed ||
    linkEvidence.allowed ||
    comment.allowed ||
    resolveComment.allowed;
  return {
    canMutate,
    canManage,
    canAssign: assign.allowed,
    canChangeStatus: changeStatus.allowed,
    canLinkEvidence: linkEvidence.allowed,
    canUnlinkEvidence: linkEvidence.allowed,
    canUnlinkLegacyEvidence: unlinkLegacy.allowed,
    canComment: comment.allowed,
    canResolveComment: resolveComment.allowed,
    disabledReasons,
  };
}
