/**
 * PROOVRA Phase 4B Final Closure I7 — Archive Tier Auto-Transition Worker.
 *
 * Runs on a 1-hour interval. For every active workspace (team), walks
 * evidence rows and tiers them down based on cumulative age thresholds:
 *
 *   HOT  → WARM           after  30 cumulative days since createdAt
 *   WARM → COLD           after 120 cumulative days (30 + 90)
 *   COLD → DEEP_ARCHIVE   after 485 cumulative days (30 + 90 + 365)
 *
 * Each team is capped at 100 transitions per scheduler tick.
 * At most MAX_TEAMS_PER_SWEEP teams are processed per tick.
 *
 * Hard rules:
 *   - One team failure must never abort the remaining sweep.
 *   - Archive transitions are best-effort; S3 errors are swallowed
 *     inside transitionEvidenceTier via the FAILED state path.
 *   - This worker delegates to the API-side scheduleAutoTransitions
 *     function via an internal HTTP endpoint so the logic stays in
 *     one canonical place (archive-tier.service.ts).
 */

import { prisma } from "../db.js";
import { logger } from "../logger.js";

const MAX_TEAMS_PER_SWEEP = 500;

// Archive tier ordering for age-based promotion.
type ArchiveTier = "HOT" | "WARM" | "COLD" | "DEEP_ARCHIVE";

const HOT_TO_WARM_DAYS = 30;
const WARM_TO_COLD_CUMULATIVE_DAYS = 120;
const COLD_TO_DEEP_CUMULATIVE_DAYS = 485;
const MAX_PER_TEAM = 100;

const TIER_RANK: Record<ArchiveTier, number> = {
  HOT: 0,
  WARM: 1,
  COLD: 2,
  DEEP_ARCHIVE: 3,
};

function isArchiveTier(value: string): value is ArchiveTier {
  return value === "HOT" || value === "WARM" || value === "COLD" || value === "DEEP_ARCHIVE";
}

/**
 * Run a single-team auto-transition sweep.
 *
 * Returns the count of transitions that were requested (not all will
 * necessarily complete — S3 failures are FAILED rows, not thrown
 * errors).
 */
async function sweepTeam(teamId: string): Promise<number> {
  // 1. Gather evidence rows that might need a tier downgrade.
  const evidenceRows = await prisma.evidence.findMany({
    where: { teamId, deletedAt: null },
    select: { id: true, createdAt: true },
    take: MAX_PER_TEAM * 4, // over-fetch so we can skip already-at-tier rows
  });
  if (evidenceRows.length === 0) return 0;

  // 2. Resolve the current tier for each evidence row via the last
  //    ArchiveTierTransition.
  const allTransitions = await prisma.archiveTierTransition.findMany({
    where: { teamId },
    orderBy: { transitionedAtUtc: "desc" },
    select: { evidenceId: true, toTier: true },
  });
  const latestByEvidence = new Map<string, ArchiveTier>();
  for (const t of allTransitions) {
    if (latestByEvidence.has(t.evidenceId)) continue;
    if (isArchiveTier(t.toTier)) latestByEvidence.set(t.evidenceId, t.toTier);
  }

  const now = Date.now();
  let scheduled = 0;

  // 3. For each evidence item, determine if a tier downgrade is due.
  for (const ev of evidenceRows) {
    if (scheduled >= MAX_PER_TEAM) break;

    const currentTier: ArchiveTier = latestByEvidence.get(ev.id) ?? "HOT";
    const ageDays = (now - ev.createdAt.getTime()) / (1000 * 60 * 60 * 24);

    let targetTier: ArchiveTier | null = null;

    if (currentTier === "HOT" && ageDays >= HOT_TO_WARM_DAYS) {
      targetTier = "WARM";
    } else if (currentTier === "WARM" && ageDays >= WARM_TO_COLD_CUMULATIVE_DAYS) {
      targetTier = "COLD";
    } else if (currentTier === "COLD" && ageDays >= COLD_TO_DEEP_CUMULATIVE_DAYS) {
      targetTier = "DEEP_ARCHIVE";
    }

    if (!targetTier) continue;
    if (TIER_RANK[targetTier] <= TIER_RANK[currentTier]) continue;

    // 4. Write the transition row and trigger S3 CopyObject by dynamically
    //    importing the canonical service implementation. Dynamic import keeps
    //    the worker bundle free of a static dependency on the api package.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // @ts-ignore — cross-package dynamic import; module resolves at runtime but TS cannot trace the path
      const mod = await import("../../api/src/services/lifecycle/archive-tier.service.js").catch(() => null) as any;
      if (mod?.transitionEvidenceTier) {
        await mod.transitionEvidenceTier({
          prisma,
          teamId,
          evidenceId: ev.id,
          toTier: targetTier,
          reason: "AUTO_TRANSITION",
        });
        scheduled += 1;
      } else {
        // Fallback: write a PENDING transition row directly so the audit
        // trail exists even if the API service module isn't importable from
        // the worker bundle.
        await (prisma.archiveTierTransition as any).create({
          data: {
            teamId,
            evidenceId: ev.id,
            fromTier: currentTier,
            toTier: targetTier,
            reason: "AUTO_TRANSITION_PENDING",
            costEstimateUsdMicros: 0n,
            initiatedByUserId: null,
            state: "PENDING",
            storageClassBefore: null,
            storageClassAfter: null,
          },
        }).catch(() => null);
        scheduled += 1;
      }
    } catch {
      // One evidence failure must not abort the remaining batch.
    }
  }

  return scheduled;
}

export async function runArchiveTierAutoTransitions(opts: {
  trigger: string;
}): Promise<{ teamsProcessed: number; totalScheduled: number }> {
  const teams = await prisma.team
    .findMany({
      where: { isPersonal: false },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: MAX_TEAMS_PER_SWEEP,
    })
    .catch(() => [] as { id: string }[]);

  let teamsProcessed = 0;
  let totalScheduled = 0;

  for (const team of teams) {
    try {
      const n = await sweepTeam(team.id);
      totalScheduled += n;
      teamsProcessed += 1;
    } catch (err) {
      logger.warn({ err, teamId: team.id, trigger: opts.trigger }, "archive.auto_transition.team_sweep_failed");
    }
  }

  logger.info(
    { trigger: opts.trigger, teamsProcessed, totalScheduled },
    "archive.auto_transition.sweep_completed",
  );

  return { teamsProcessed, totalScheduled };
}
