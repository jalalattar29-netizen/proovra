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
 * The walk reads only records that are DUE (capacity, 2026-11-03): one statement
 * per page picks the records whose age has passed the threshold of their current
 * tier, oldest first, with their sealed version. Walking every record of a
 * 300,000-record workspace to find a hundred due ones was 750 pages and 1,500
 * statements per tick per team; on the capacity fixture the earlier unordered
 * shape took 699 s and 194,591 statements for one tick across 628 workspaces.
 * Pages per team are bounded too, so a team whose due records are all claimed
 * elsewhere cannot hold the tick.
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
/** Due-record pages read for one team in one tick. */
const MAX_PAGES_PER_TEAM = 5;
const FAILED_TAG_RETRY_MS = MS_PER_DAY;

const TIER_RANK: Record<ArchiveTier, number> = {
  HOT: 0,
  WARM: 1,
  COLD: 2,
  DEEP_ARCHIVE: 3,
};

type DueRecord = {
  id: string;
  createdAt: Date;
  /** The latest COMPLETED transition naming a known tier, or null (HOT). */
  currentTier: string | null;
  storageBucket: string;
  storageKey: string;
  storageVersionId: string;
};

/**
 * One page of a team's due records after `after`, oldest first. A record is due
 * when its age has passed the threshold of its current tier; one that failed a tag
 * within FAILED_TAG_RETRY_MS, or has no sealed version, is not read.
 *
 * The sweep visits ORGANIZATION and OWNED workspaces only (`isPersonal: false`),
 * whose canonical evidence scope is exactly `team_id = workspace`; that is
 * asserted, not assumed, before the raw read.
 */
async function dueRecordsPage(
  teamId: string,
  after: { createdAt: Date; id: string } | null,
): Promise<DueRecord[]> {
  const now = Date.now();
  const hot = new Date(now - HOT_TO_WARM_DAYS * MS_PER_DAY);
  const warm = new Date(now - WARM_TO_COLD_CUMULATIVE_DAYS * MS_PER_DAY);
  const cold = new Date(now - COLD_TO_DEEP_CUMULATIVE_DAYS * MS_PER_DAY);
  const failedSince = new Date(now - FAILED_TAG_RETRY_MS);
  const afterCreatedAt = after?.createdAt ?? new Date(0);
  const afterId = after?.id ?? "00000000-0000-0000-0000-000000000000";
  return prisma.$queryRaw<DueRecord[]>`
    SELECT e.id::text AS "id", e.created_at AS "createdAt", cur.to_tier AS "currentTier",
           e.storage_bucket AS "storageBucket", e.storage_key AS "storageKey",
           e.storage_version_id AS "storageVersionId"
      FROM evidence e
      LEFT JOIN LATERAL (
        SELECT t.to_tier
          FROM archive_tier_transitions t
         WHERE t.team_id = ${teamId}::uuid
           AND t.evidence_id = e.id
           AND t.state = 'COMPLETED'
           AND t.to_tier IN ('HOT', 'WARM', 'COLD', 'DEEP_ARCHIVE')
         ORDER BY t.transitioned_at_utc DESC
         LIMIT 1
      ) cur ON true
     WHERE e.team_id = ${teamId}::uuid
       AND e.deleted_at IS NULL
       AND e.created_at <= ${hot}
       AND e.storage_bucket IS NOT NULL
       AND e.storage_key IS NOT NULL
       AND e.storage_version_id IS NOT NULL
       AND (e.created_at, e.id) > (${afterCreatedAt}, ${afterId}::uuid)
       AND (
             cur.to_tier IS NULL OR cur.to_tier = 'HOT'
          OR (cur.to_tier = 'WARM' AND e.created_at <= ${warm})
          OR (cur.to_tier = 'COLD' AND e.created_at <= ${cold})
       )
       AND NOT EXISTS (
         SELECT 1 FROM archive_tier_transitions f
          WHERE f.team_id = ${teamId}::uuid
            AND f.evidence_id = e.id
            AND f.state = 'FAILED'
            AND f.transitioned_at_utc > ${failedSince}
       )
     ORDER BY e.created_at ASC, e.id ASC
     LIMIT ${PAGE_SIZE}
  `;
}

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
  if (JSON.stringify(scope) !== JSON.stringify({ teamId })) {
    throw new Error("archive tier sweep: a workspace whose scope is not its own team id");
  }
  let scheduled = 0;
  let attempts = 0;
  let pages = 0;
  let after: { createdAt: Date; id: string } | null = null;

  while (scheduled < MAX_PER_TEAM && attempts < MAX_ATTEMPTS_PER_TEAM && pages < MAX_PAGES_PER_TEAM) {
    // 1. The next page of DUE records, oldest first, each with its current tier.
    const page = await dueRecordsPage(teamId, after);
    pages += 1;
    if (page.length === 0) break;
    const last = page[page.length - 1]!;
    after = { createdAt: last.createdAt, id: last.id };

    const now = Date.now();

    // 3. For each evidence item, determine if a tier downgrade is due.
    for (const ev of page) {
      if (scheduled >= MAX_PER_TEAM || attempts >= MAX_ATTEMPTS_PER_TEAM) break;
      const currentTier: ArchiveTier =
        ev.currentTier && isArchiveTier(ev.currentTier) ? ev.currentTier : "HOT";
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
