/**
 * Phase 32.8C+++++ — CaseComment dashboard reader.
 *
 * Reader-only for the dashboard. The writer (POST /v1/cases/:id/comments)
 * is owned by a future operator-UI phase; the table is in place so that
 * once the writer ships, the dashboard immediately surfaces backlog
 * counts.
 *
 * Hard rules:
 *   - The dashboard never exposes raw body content; only counts and
 *     bounded summary fields. Body access requires per-case permission
 *     gating (out of scope for the dashboard).
 *   - Visibility filtering is applied at the caller (workspace-scoped).
 */

import { prisma } from "../../db.js";

export async function getWorkspaceCaseCommentBacklog(input: {
  teamId: string;
  staleAfterDays?: number;
}): Promise<{
  openCount: number;
  resolvedCount: number;
  staleOpenCount: number;
}> {
  const staleAfter = Math.min(Math.max(input.staleAfterDays ?? 14, 1), 365);
  const staleCutoff = new Date(Date.now() - staleAfter * 24 * 60 * 60 * 1000);
  try {
    const [openCount, resolvedCount, staleOpenCount] = await Promise.all([
      prisma.caseComment.count({
        where: { teamId: input.teamId, resolvedAtUtc: null },
      }),
      prisma.caseComment.count({
        where: { teamId: input.teamId, resolvedAtUtc: { not: null } },
      }),
      prisma.caseComment.count({
        where: {
          teamId: input.teamId,
          resolvedAtUtc: null,
          createdAt: { lt: staleCutoff },
        },
      }),
    ]);
    return { openCount, resolvedCount, staleOpenCount };
  } catch {
    return { openCount: 0, resolvedCount: 0, staleOpenCount: 0 };
  }
}
