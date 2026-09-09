/**
 * The words this surface uses for an assignment's enums, in one place.
 *
 * These lived inside `AssignmentsTab` while the create dialog also lived
 * there. The dialog is a shared launcher now — the Work tab and the team
 * header both open the SAME one — so the labels it prints have to be reachable
 * from outside the tab, and duplicating them into the dialog is how "Evidence
 * review" becomes "Access review" again on one of the two surfaces.
 *
 * Labels only. Tone (the semantic colour) stays with the table that scans by
 * it, and the enums themselves stay in `@proovra/shared`.
 */

import type {
  CollaborationTeamAssignmentPriority,
  CollaborationTeamAssignmentStatus,
  CollaborationTeamAssignmentTarget,
} from "@proovra/shared";

import type { CollaborationTeamMember } from "../../../../../lib/api/collaboration-teams";

export const STATUS_LABELS: Record<CollaborationTeamAssignmentStatus, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  REASSIGNED: "Reassigned",
  CANCELLED: "Cancelled",
};

export const PRIORITY_LABELS: Record<
  CollaborationTeamAssignmentPriority,
  string
> = {
  LOW: "Low",
  NORMAL: "Normal",
  HIGH: "High",
  URGENT: "Urgent",
};

/**
 * "Access review" was WRONG, and wrong in a way that matters in an evidence
 * product: a REVIEW target is an `EvidenceReviewWorkflow` — the review of a
 * record — and an access review is a governance campaign over who holds
 * permissions. The label named the wrong domain entirely, and the row it sat
 * on linked to a reviewer console.
 */
export const TARGET_LABELS: Record<CollaborationTeamAssignmentTarget, string> = {
  CASE: "Case",
  EVIDENCE: "Evidence",
  REVIEW: "Evidence review",
};

export function statusLabel(status: CollaborationTeamAssignmentStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export function priorityLabel(
  priority: CollaborationTeamAssignmentPriority,
): string {
  return PRIORITY_LABELS[priority] ?? priority;
}

export function targetLabel(
  target: CollaborationTeamAssignmentTarget,
): string {
  return TARGET_LABELS[target] ?? target;
}

/** The person, named the way every other Collaboration Team surface names them. */
export function memberLabel(member: CollaborationTeamMember): string {
  return (
    member.user.displayName ||
    [member.user.firstName, member.user.lastName].filter(Boolean).join(" ") ||
    member.user.email ||
    member.userId.slice(0, 8)
  );
}
