/**
 * Stage D (team remediation, T-085 / T-086) — ONE way to name a reviewer.
 *
 * The picker said "Reviewer ref 1a2b3c" for a member without a display name,
 * the lineage showed the e-mail, the queue showed a name only after the picker
 * had been opened, and Monitoring tables showed `userId.slice(0, 12)…`. Every
 * Review surface now names a person the same way, from what the API projects
 * (`displayName`, `maskedEmail`):
 *
 *   the viewer            "You"
 *   a display name        the display name
 *   a masked e-mail       "j***@example.com"
 *   nothing projected     "Workspace member"   (never an id fragment)
 */

export type ReviewerIdentity = {
  userId?: string | null;
  displayName?: string | null;
  /** Already masked by the API (`maskEmail`): "j***@example.com". */
  maskedEmail?: string | null;
};

export const UNNAMED_REVIEWER = "Workspace member";

export function reviewerIdentityLabel(
  identity: ReviewerIdentity | null | undefined,
  viewerUserId?: string | null,
): string {
  if (!identity) return UNNAMED_REVIEWER;
  if (viewerUserId && identity.userId && identity.userId === viewerUserId) return "You";
  const name = identity.displayName?.trim();
  if (name) return name;
  const email = identity.maskedEmail?.trim();
  if (email) return email;
  return UNNAMED_REVIEWER;
}

/** The assignee cell: "Unassigned" when nobody holds the review. */
export function assigneeLabel(
  assignedToUserId: string | null | undefined,
  identity: ReviewerIdentity | null | undefined,
  viewerUserId?: string | null,
): string {
  if (!assignedToUserId) return "Unassigned";
  return reviewerIdentityLabel({ ...(identity ?? {}), userId: assignedToUserId }, viewerUserId);
}
