/**
 * Phase E1 — AI advisory-record retention.
 *
 * Copilot runs (+ observation reviews via cascade) are ADVISORY work-product:
 * they expire per the workspace policy's retentionDays and never inherit
 * forensic immutability. Usage/cost rollups are billing records and are kept.
 * Cleanup is opportunistic + idempotent; failures never block AI responses.
 */
import { prisma } from "../../db.js";

export const DEFAULT_AI_RETENTION_DAYS = 365;

export function retentionCutoff(retentionDays: number, now: Date): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

/** Delete Copilot runs older than the workspace's retention window. */
export async function cleanupExpiredCopilotRuns(
  workspaceId: string,
  now = new Date(),
): Promise<number> {
  try {
    const policy = await prisma.workspaceAiPolicy.findUnique({
      where: { teamId: workspaceId },
      select: { retentionDays: true },
    });
    const days = policy?.retentionDays ?? DEFAULT_AI_RETENTION_DAYS;
    const cutoff = retentionCutoff(days, now);
    const res = await prisma.aiCopilotRun.deleteMany({
      where: { workspaceId, generatedAt: { lt: cutoff } },
    });
    return res.count;
  } catch {
    return 0; // schema not applied / DB unavailable — never blocks
  }
}

/** Tenant deletion support: purge ALL AI advisory records for a workspace. */
export async function purgeWorkspaceAiRecords(workspaceId: string): Promise<void> {
  try {
    await prisma.aiCopilotRun.deleteMany({ where: { workspaceId } });
    await prisma.aiUsageEvent.deleteMany({ where: { workspaceId } });
    await prisma.aiUsageDaily.deleteMany({ where: { workspaceId } });
    await prisma.aiUsageMonthly.deleteMany({ where: { workspaceId } });
  } catch {
    /* best-effort */
  }
}
