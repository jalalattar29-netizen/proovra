/**
 * Team remediation T-085 / T-086 (stage D) — ONE identity projection for a
 * reviewer on every Review read.
 *
 * The picker showed "Reviewer ref 1a2b3c" for a member without a display name,
 * the Inbox named an assignee only after the picker had loaded, and the
 * Monitoring tables printed `userId.slice(0, 12)…` because the workload,
 * suggestion and performance projections carried ids only. Every Review read
 * now carries, beside the id, what the web renders the one way
 * (`reviewerIdentityLabel`): the display name, else the e-mail MASKED with the
 * shared `maskEmail` ("j***@example.com"). A full address is never projected
 * here.
 *
 * One batched read per call; callers pass their own client (registry-default
 * shared-runtime rule).
 */

import { maskEmail } from "@proovra/shared";
import type { PrismaClient } from "@prisma/client";

export type ReviewerIdentityProjection = {
  displayName: string | null;
  maskedEmail: string | null;
};

export async function loadReviewerIdentities(
  userIds: ReadonlyArray<string | null | undefined>,
  client: PrismaClient,
): Promise<Map<string, ReviewerIdentityProjection>> {
  const ids = Array.from(new Set(userIds.filter((id): id is string => typeof id === "string" && id.length > 0)));
  const out = new Map<string, ReviewerIdentityProjection>();
  if (ids.length === 0) return out;
  const users = await client.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, displayName: true, email: true },
  });
  for (const u of users) {
    const name = typeof u.displayName === "string" && u.displayName.trim().length > 0 ? u.displayName.trim() : null;
    out.set(u.id, { displayName: name, maskedEmail: maskEmail(u.email ?? null) });
  }
  return out;
}

/** `{ reviewerDisplayName, reviewerMaskedEmail }` beside a `reviewerUserId`. */
export function withReviewerIdentity<T extends { reviewerUserId: string }>(
  row: T,
  identities: ReadonlyMap<string, ReviewerIdentityProjection>,
): T & { reviewerDisplayName: string | null; reviewerMaskedEmail: string | null } {
  const identity = identities.get(row.reviewerUserId);
  return {
    ...row,
    reviewerDisplayName: identity?.displayName ?? null,
    reviewerMaskedEmail: identity?.maskedEmail ?? null,
  };
}
