import { workspaceIncludesReviewerOperations } from "../billing-enforcement.service.js";
import { evaluateAccess, loadMemberAccessSnapshot } from "../identity/access-policy.service.js";

/**
 * B6-F-30 (free audit 0ea0) — the copilot offered every SIGNED record's
 * reader (a Free owner included) a link into the paid reviewer-assignment
 * surface. Offered only when the plan includes reviewer operations and the
 * caller holds `review.assign`; any failure withholds the suggestion.
 */
export async function copilotMayOfferReviewerAssignment(teamId: string, userId: string): Promise<boolean> {
  try {
    if (!(await workspaceIncludesReviewerOperations(teamId))) return false;
    const member = await loadMemberAccessSnapshot({ teamId, userId });
    return evaluateAccess(member ? { kind: "MEMBER", member } : null, { permission: "review.assign" }).allowed;
  } catch {
    return false;
  }
}
