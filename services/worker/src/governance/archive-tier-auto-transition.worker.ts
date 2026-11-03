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
 * Each team is capped at 100 transitions per scheduler tick. Every workspace
 * holding a record old enough to tier is swept: a cap on teams, taken oldest
 * first, meant the same workspaces every tick and none of the later ones, ever.
 *
 * Within a team the walk is oldest record first, in pages, until the cap is met
 * or the records run out. It used to read 400 rows in no order and stop there, so
 * a team whose first 400 were already at their tier never reached the rest.
 * A tag that failed is left for a day: a storage outage writes one FAILED row
 * per attempt, so attempts are capped too, and without the pause the same failing
 * rows would use that cap on every tick.
 *
 * Hard rules:
 *   - One team failure must never abort the remaining sweep.
 *   - A tier is recorded by tagging the exact sealed version, and only a tag
 *     that landed writes a COMPLETED row. Bucket lifecycle rules move the bytes
 *     (GOV-016); nothing here claims they have moved.
 */

import { GetObjectTaggingCommand, PutObjectTaggingCommand } from "@aws-sdk/client-s3";
import { ARCHIVE_TIER_OBJECT_TAG } from "@proovra/shared";
import { s3 } from "../storage.js";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { workspaceEvidenceWhere } from "@proovra/shared-runtime";

/** A PENDING claim this old was abandoned by a crash. */
const AUTO_CLAIM_LEASE_MS = 60 * 60 * 1000;

// Archive tier ordering for age-based promotion.
type ArchiveTier = "HOT" | "WARM" | "COLD" | "DEEP_ARCHIVE";

const HOT_TO_WARM_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WARM_TO_COLD_CUMULATIVE_DAYS = 120;
const COLD_TO_DEEP_CUMULATIVE_DAYS = 485;
const MAX_PER_TEAM = 100;
/** Every tag attempted in one tick, successful or not. */
const MAX_ATTEMPTS_PER_TEAM = MAX_PER_TEAM * 4;
const PAGE_SIZE = MAX_PER_TEAM * 4;
const FAILED_TAG_RETRY_MS = MS_PER_DAY;

const TIER_RANK: Record<ArchiveTier, number> = {
  HOT: 0,
  WARM: 1,
  COLD: 2,
  DEEP_ARCHIVE: 3,
};

type EvidencePage = Array<{
  id: string;
  createdAt: Date;
  storageBucket: string | null;
  storageKey: string | null;
  storageVersionId: string | null;
}>;

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
  // WORKSPACE-SCOPE CONVERGENCE — the canonical workspace population,
  // resolved once for every query below. A strict `teamId` equality here
  // omitted a personal workspace's legacy NULL-team rows, and reported the
  // smaller number as if it were the whole population.
  const scope = await workspaceEvidenceWhere(teamId, prisma);
  const dueBefore = new Date(Date.now() - HOT_TO_WARM_DAYS * MS_PER_DAY);
  let scheduled = 0;
  let attempts = 0;
  let after: { createdAt: Date; id: string } | null = null;

  while (scheduled < MAX_PER_TEAM && attempts < MAX_ATTEMPTS_PER_TEAM) {
    // 1. The next page of records old enough for a first tier, oldest first. A
    //    record with no sealed version has nothing to tag and is not read at all.
    const position: { createdAt: Date; id: string } | null = after;
    const page: EvidencePage = await prisma.evidence.findMany({
      where: {
        AND: [
          scope,
          ...(position
            ? [
                {
                  OR: [
                    { createdAt: { gt: position.createdAt } },
                    { createdAt: position.createdAt, id: { gt: position.id } },
                  ],
                },
              ]
            : []),
        ],
        deletedAt: null,
        createdAt: { lte: dueBefore },
        storageBucket: { not: null },
        storageKey: { not: null },
        storageVersionId: { not: null },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        createdAt: true,
        storageBucket: true,
        storageKey: true,
        storageVersionId: true,
      },
      take: PAGE_SIZE,
    });
    if (page.length === 0) break;
    const last = page[page.length - 1]!;
    after = { createdAt: last.createdAt, id: last.id };

    // 2. Resolve the current tier of each row in this page via its last
    //    ArchiveTierTransition, and which of them failed recently.
    const transitions = await prisma.archiveTierTransition.findMany({
      where: {
        teamId,
        evidenceId: { in: page.map((row) => row.id) },
        state: { in: ["COMPLETED", "FAILED"] },
      },
      orderBy: { transitionedAtUtc: "desc" },
      select: { evidenceId: true, toTier: true, state: true, transitionedAtUtc: true },
    });
    const latestByEvidence = new Map<string, ArchiveTier>();
    const recentlyFailed = new Set<string>();
    const retryAfter = Date.now() - FAILED_TAG_RETRY_MS;
    for (const t of transitions) {
      if (t.state === "FAILED") {
        if (t.transitionedAtUtc.getTime() > retryAfter) recentlyFailed.add(t.evidenceId);
        continue;
      }
      if (latestByEvidence.has(t.evidenceId)) continue;
      if (isArchiveTier(t.toTier)) latestByEvidence.set(t.evidenceId, t.toTier);
    }

    const now = Date.now();

    // 3. For each evidence item, determine if a tier downgrade is due.
    for (const ev of page) {
      if (scheduled >= MAX_PER_TEAM || attempts >= MAX_ATTEMPTS_PER_TEAM) break;
      if (recentlyFailed.has(ev.id)) continue;

      const currentTier: ArchiveTier = latestByEvidence.get(ev.id) ?? "HOT";
      const ageDays = (now - ev.createdAt.getTime()) / MS_PER_DAY;

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

      // 4. GOV-016 — record the tier on the exact sealed version. This used to
      //    import the API service from a path that never existed, swallow the
      //    failure, and write a PENDING label nothing ever processed: a record read
      //    WARM after 30 days with no byte moved, and the next step was blocked by
      //    the label itself. A record with no sealed version has nothing to tag, so
      //    no row is written for it rather than one that claims a tier.
      try {
        const sealed = ev;
        if (!sealed.storageBucket || !sealed.storageKey || !sealed.storageVersionId) continue;

        // THE CLAIM, durable before storage is touched: the row exists first, under
        // the evidence lock, so overlapping sweeps tag once and a crash leaves
        // something to reconcile. A row this sweep or an older build left PENDING is
        // taken over; anything else in flight is left alone.
        const claimId = await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ev.id}))`;
          // One statement on purpose. The claim holder finishes outside this lock,
          // so reading "done" and then "active" separately could miss its row in
          // both, between PENDING and COMPLETED, and tag the object a second time.
          const blocking = await tx.archiveTierTransition.findMany({
            where: {
              evidenceId: ev.id,
              OR: [
                { state: "COMPLETED", toTier: targetTier },
                { state: { in: ["PENDING", "EXECUTING", "RESTORE_REQUESTED"] } },
              ],
            },
            select: { id: true, state: true, reason: true, transitionedAtUtc: true },
          });
          if (blocking.some((row) => row.state === "COMPLETED")) return null;
          const active = blocking[0];
          if (active) {
            const abandoned =
              active.state === "PENDING" &&
              (active.reason === "AUTO_TRANSITION_PENDING" ||
                (active.reason === "AUTO_TRANSITION" &&
                  Date.now() - active.transitionedAtUtc.getTime() > AUTO_CLAIM_LEASE_MS));
            if (!abandoned) return null;
            await tx.archiveTierTransition.update({
              where: { id: active.id },
              data: { fromTier: currentTier, toTier: targetTier, reason: "AUTO_TRANSITION" },
            });
            return active.id;
          }
          const created = await tx.archiveTierTransition.create({
            data: {
              teamId,
              evidenceId: ev.id,
              fromTier: currentTier,
              toTier: targetTier,
              reason: "AUTO_TRANSITION",
              costEstimateUsdMicros: 0n,
              initiatedByUserId: null,
              state: "PENDING",
              storageClassBefore: null,
              storageClassAfter: null,
            },
            select: { id: true },
          });
          return created.id;
        });
        if (!claimId) continue;
        attempts += 1;

        try {
          const existing = await s3.send(
            new GetObjectTaggingCommand({
              Bucket: sealed.storageBucket,
              Key: sealed.storageKey,
              VersionId: sealed.storageVersionId,
            }),
          );
          await s3.send(
            new PutObjectTaggingCommand({
              Bucket: sealed.storageBucket,
              Key: sealed.storageKey,
              VersionId: sealed.storageVersionId,
              Tagging: {
                TagSet: [
                  ...(existing.TagSet ?? []).filter((t) => t.Key !== ARCHIVE_TIER_OBJECT_TAG),
                  { Key: ARCHIVE_TIER_OBJECT_TAG, Value: targetTier },
                ],
              },
            }),
          );
        } catch (err) {
          await prisma.archiveTierTransition.update({
            where: { id: claimId },
            data: {
              state: "FAILED",
              failureReason: (err instanceof Error ? err.name : "TAGGING_FAILED").slice(0, 200),
            },
          });
          continue;
        }
        await prisma.archiveTierTransition.update({
          where: { id: claimId },
          data: { state: "COMPLETED", executedAtUtc: new Date() },
        });
        scheduled += 1;
      } catch {
        // One evidence failure must not abort the remaining batch.
      }
    }
    if (page.length < PAGE_SIZE) break;
  }

  return scheduled;
}

export async function runArchiveTierAutoTransitions(opts: {
  trigger: string;
}): Promise<{ teamsProcessed: number; totalScheduled: number }> {
  // PHASE 12 POINT 5 — a database failure is not an empty workspace list.
  //
  // This read used to end in `.catch(() => [])`, which turned any connection
  // or schema error into "there are no workspaces to sweep". The tick then
  // logged `sweep_completed` with zero teams and zero transitions — a total
  // outage of retention tiering that is indistinguishable, in every log and
  // metric, from a healthy run with nothing to do. The error now propagates
  // to the scheduler, which records a failed tick.
  //
  // A workspace with nothing past the first threshold has nothing to tier, so
  // only those with such a record are visited. Each is still bounded by
  // MAX_PER_TEAM, and the scheduler's cron lock stops ticks overlapping.
  const dueBefore = new Date(Date.now() - HOT_TO_WARM_DAYS * MS_PER_DAY);
  const withDueRecords = await prisma.evidence.groupBy({
    by: ["teamId"],
    where: { teamId: { not: null }, deletedAt: null, createdAt: { lte: dueBefore } },
  });
  const teams = await prisma.team.findMany({
    where: {
      isPersonal: false,
      id: { in: withDueRecords.flatMap((row) => (row.teamId ? [row.teamId] : [])) },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

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
