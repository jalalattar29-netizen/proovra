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

/**
 * PHASE 13 §4 (2026-08-17) — tenant destruction: remove every AI record a
 * workspace owns.
 *
 * WHY THIS EXISTS AT ALL, GIVEN THE DATABASE HAS CASCADES
 * ---------------------------------------------------------------------------
 * It exists because these particular tables do NOT have one. `WorkspaceAiPolicy`
 * carries `team Team @relation(..., onDelete: Cascade)` and disappears with the
 * Team row; `AiCopilotObservationReview` cascades off its parent run. Every
 * table below instead carries a BARE `workspace_id` / `team_id` UUID column with
 * no foreign key, so `DELETE FROM teams` leaves each of them behind — rows that
 * name a tenant that no longer exists, holding prompt/response artifacts,
 * per-user attribution and spend history, and which no tenant-scoped query will
 * ever surface again to be found and removed.
 *
 * WHAT IS PURGED, AND WHY EACH ONE
 * ---------------------------------------------------------------------------
 *   - `AiCopilotRun`        advisory work-product: the selected object versions,
 *                           the bounded result and the validated citations.
 *                           Cascades to `AiCopilotObservationReview`.
 *   - `AiUsageEvent`        the durable per-request usage/cost ledger, which
 *                           carries `userId` — personal data, not just a number.
 *   - `AiUsageDaily`        }  pre-aggregated spend rollups. Deleting the events
 *   - `AiUsageMonthly`      }  without these would leave the totals standing.
 *   - `SemanticUsageDaily`  embedding spend for the same workspace, written by
 *                           the semantic budget ledger rather than the AI one.
 *   - `ProviderUsageEvent`  }  per-provider cost governance, keyed `team_id`.
 *   - `ProviderBudget`      }  `ProviderBudgetAlert` cascades off the budget.
 *
 * These are NOT under a retention authority that would keep them: the billing
 * records this system must retain are `Subscription` / `Payment`, which the team
 * -deletion route already refuses to orphan (it blocks on an active
 * subscription). A destroyed tenant's *AI spend telemetry* has no such
 * obligation, and the workspace-scoped budget ceilings it holds are meaningless
 * once the workspace is gone.
 *
 * WHY IT NO LONGER SWALLOWS ITS ERRORS
 * ---------------------------------------------------------------------------
 * The previous revision wrapped the whole body in `catch {}` and returned void.
 * On a destruction path that is the worst possible shape: the purge fails, the
 * caller proceeds to delete the Team, and the rows it was supposed to remove are
 * now unreachable forever with nothing having been reported. It throws now, and
 * the caller runs it BEFORE the Team row is deleted, so a failure aborts the
 * destruction with the tenant — and therefore its AI rows — still intact and
 * still reachable by a retry.
 *
 * Accepts a client so the caller may run it inside its own transaction.
 */
export async function purgeWorkspaceAiRecords(
  workspaceId: string,
  client: Pick<
    typeof prisma,
    | "aiCopilotRun"
    | "aiUsageEvent"
    | "aiUsageDaily"
    | "aiUsageMonthly"
    | "semanticUsageDaily"
    | "providerUsageEvent"
    | "providerBudget"
  > = prisma,
): Promise<{ purged: number }> {
  const results = [
    await client.aiCopilotRun.deleteMany({ where: { workspaceId } }),
    await client.aiUsageEvent.deleteMany({ where: { workspaceId } }),
    await client.aiUsageDaily.deleteMany({ where: { workspaceId } }),
    await client.aiUsageMonthly.deleteMany({ where: { workspaceId } }),
    await client.semanticUsageDaily.deleteMany({ where: { workspaceId } }),
    // The provider-cost tables spell the same tenant `teamId`. A workspace IS
    // a Team in this model, so the identifier is one value under two names.
    await client.providerUsageEvent.deleteMany({ where: { teamId: workspaceId } }),
    await client.providerBudget.deleteMany({ where: { teamId: workspaceId } }),
  ];
  return { purged: results.reduce((sum, r) => sum + r.count, 0) };
}
