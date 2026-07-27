/**
 * Operations Center — digest scheduler.
 *
 * Sends HOURLY / DAILY / WEEKLY email digests of unread Operations Center
 * items, driven by the user's per-category EMAIL frequency preferences and
 * their quiet-hours/timezone schedule.
 *
 * SOURCE OF TRUTH: at execution time the scheduler runs the CANONICAL
 * Operations Center aggregation (`buildInboxAggregation` — the exact
 * function behind the page, the Bell summary, and bulk read) for each
 * recipient. Digests therefore NEVER depend on a prior UI visit: a user
 * who has never opened PROOVRA still receives their authorized items,
 * with current membership/role/policy checks applied at send time. The
 * aggregation results are also upserted into the persistent snapshot
 * store (`syncInboxSnapshots`) so history accrues for inactive users too.
 * There is no second aggregator.
 *
 * Invoked by POST /v1/notifications/run-digests (cron-secret protected —
 * the same trigger pattern as run-reminders / process-retries; no second
 * worker architecture is introduced).
 *
 * Correctness properties:
 *   * Tenant/user safety — items come from the recipient's own
 *     membership-scoped aggregation; the batch is further narrowed to the
 *     digest group's workspace (context.teamId). No cross-user or
 *     cross-tenant reads exist.
 *   * Idempotency — the per-(user, workspace, cadence) bookkeeping
 *     timestamp is CLAIMED with a conditional updateMany BEFORE sending;
 *     a concurrent cron run that loses the claim skips the bucket, so a
 *     digest bucket can never send twice. If the send fails after a
 *     claim, that bucket is skipped (never duplicated) and the failure is
 *     recorded in the existing NotificationDelivery pipeline, which owns
 *     retries.
 *   * Exclusions — read, dismissed, actively-snoozed items never appear;
 *     resolved items cannot appear (a resolved source no longer emits
 *     into the aggregation).
 *   * Quiet hours — computed in the recipient's IANA timezone; a digest
 *     due during quiet hours is DEFERRED (the claim is not taken) unless
 *     the schedule allows critical override AND the batch contains a
 *     critical item (PROOVRA-critical tones only — routine mentions and
 *     collaboration never bypass quiet hours because their tone is never
 *     "critical").
 *   * Content safety — item TITLES + categories only (already
 *     user-visible when surfaced); never raw evidence content, never
 *     other users' data.
 */
import type { FastifyRequest } from "fastify";

import { prisma } from "../../db.js";
import { processAccountDataExports } from "../identity/account-data-export.service.js";
import { processAccountClosures } from "../identity/account-closure.service.js";
import { processOrganizationClosures } from "../organization/org-closure.service.js";
import { processWorkspaceClosures } from "../workspace/workspace-closure.service.js";
import {
  buildInboxAggregation,
  syncInboxSnapshots,
  type InboxItem,
} from "../../routes/me-inbox.routes.js";
import { safeSendEmailNotification } from "./index.js";
import {
  PREFERENCE_CATEGORY_MAP,
  isWithinQuietHours,
  type NotificationPreferenceType,
} from "./notification-preferences.service.js";
// PHASE 11 — canonical internal URL builder.
import { absoluteInternalUrl, internalNavPath } from "@proovra/shared";

const CADENCES = ["HOURLY", "DAILY", "WEEKLY"] as const;
type DigestCadence = (typeof CADENCES)[number];

const CADENCE_MS: Record<DigestCadence, number> = {
  HOURLY: 60 * 60 * 1000,
  DAILY: 24 * 60 * 60 * 1000,
  WEEKLY: 7 * 24 * 60 * 60 * 1000,
};

const CADENCE_LABEL: Record<DigestCadence, string> = {
  HOURLY: "Hourly",
  DAILY: "Daily",
  WEEKLY: "Weekly",
};

const LAST_FIELD: Record<
  DigestCadence,
  "lastHourlyDigestAt" | "lastDailyDigestAt" | "lastWeeklyDigestAt"
> = {
  HOURLY: "lastHourlyDigestAt",
  DAILY: "lastDailyDigestAt",
  WEEKLY: "lastWeeklyDigestAt",
};

const NOOP_LOG = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
} as unknown as FastifyRequest["log"];

export type DigestRunSummary = {
  groupsConsidered: number;
  digestsSent: number;
  deferredQuietHours: number;
  skippedEmpty: number;
  skippedNotDue: number;
  skippedClaimLost: number;
  failures: number;
  /** Operational-history retention — snapshots pruned by this run. */
  snapshotsPruned: number;
  /**
   * Migration-order safety — set when the run REFUSED to execute
   * because the schedule schema (migration 20270916) is missing.
   * A refused run sends nothing, advances no watermarks, and creates
   * no delivery records; the cron endpoint surfaces it as a 503.
   */
  unavailableReason?: "schedule_schema_missing";
};

/**
 * Cheap probe for the schedule table. Distinguishes ONLY Prisma's
 * missing-table/column codes; any other error (connection loss etc.)
 * propagates so real failures stay observable.
 */
async function scheduleSchemaAvailable(): Promise<boolean> {
  try {
    await prisma.notificationScheduleSetting.findFirst({
      select: { userId: true },
    });
    return true;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "P2021" || code === "P2022") return false;
    throw err;
  }
}

/**
 * Operational-history retention rule (documented, simple): a snapshot
 * is an attention record, not legal evidence — it is kept for
 * OPERATIONS_SNAPSHOT_RETENTION_DAYS after it was last seen live, then
 * deleted. The sweep piggybacks on the digest cron (no extra
 * scheduler), is bounded per run, and no-ops on environments where the
 * snapshot table is not provisioned yet.
 */
export const OPERATIONS_SNAPSHOT_RETENTION_DAYS = 180;
const SNAPSHOT_PRUNE_BATCH = 500;

export async function pruneOperationsSnapshots(now: Date): Promise<number> {
  const cutoff = new Date(
    now.getTime() - OPERATIONS_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  try {
    const stale = await prisma.operationsInboxSnapshot.findMany({
      where: { lastSeenAtUtc: { lt: cutoff } },
      select: { id: true },
      take: SNAPSHOT_PRUNE_BATCH,
    });
    if (stale.length === 0) return 0;
    const r = await prisma.operationsInboxSnapshot.deleteMany({
      where: { id: { in: stale.map((s) => s.id) } },
    });
    return r.count;
  } catch {
    // Table not provisioned (P2021) or transient failure — retention
    // is best-effort per run; the next cron firing retries.
    return 0;
  }
}

export async function runDigestScheduler(
  opts: {
    now?: Date;
    maxGroups?: number;
    log?: FastifyRequest["log"];
  } = {},
): Promise<DigestRunSummary> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? NOOP_LOG;
  const maxGroups = Math.min(Math.max(opts.maxGroups ?? 500, 1), 2000);
  const summary: DigestRunSummary = {
    groupsConsidered: 0,
    digestsSent: 0,
    deferredQuietHours: 0,
    skippedEmpty: 0,
    skippedNotDue: 0,
    skippedClaimLost: 0,
    failures: 0,
    snapshotsPruned: 0,
  };

  // Migration-order safety — refuse the ENTIRE run when the schedule
  // schema is missing. Refusing (rather than "treating the table as
  // empty") is deliberate: a run without schedule rows would bypass
  // quiet hours, misread cadence watermarks, and could double-send
  // once the migration lands. Zero sends, zero watermark writes.
  if (!(await scheduleSchemaAvailable())) {
    log.error(
      {},
      "digest.run_refused_schedule_schema_missing (apply migration 20270916)",
    );
    summary.unavailableReason = "schedule_schema_missing";
    return summary;
  }

  // Retention first — bounded, best-effort, independent of digest state.
  summary.snapshotsPruned = await pruneOperationsSnapshots(now);

  // Lifecycle Phase 4 — personal account data exports piggyback on the
  // same cron firing (identical pattern to snapshot pruning above; no
  // parallel job infrastructure). Generates pending export packages and
  // securely expires stale ones. Best-effort: an export failure never
  // blocks digest delivery.
  try {
    await processAccountDataExports(now);
  } catch {
    /* isolated — digests continue */
  }

  // Lifecycle Phase 5 — due account-closure requests execute on the same
  // cron firing. The processor re-runs the closure preflight before
  // touching anything and isolates every failure to its own request row.
  try {
    await processAccountClosures(now);
  } catch {
    /* isolated — digests continue */
  }

  // Lifecycle Phase 6 — due organization closures execute on the same
  // cron firing (re-preflighted, per-row failure isolation).
  try {
    await processOrganizationClosures(now);
  } catch {
    /* isolated — digests continue */
  }

  // Lifecycle Phase 7 — due workspace closures execute on the same cron
  // firing (re-preflighted, per-row failure isolation).
  try {
    await processWorkspaceClosures(now);
  } catch {
    /* isolated — digests continue */
  }

  // 1. Every enabled EMAIL preference on a digest cadence.
  const prefRows = await prisma.workspaceNotificationPreference.findMany({
    where: {
      channel: "EMAIL",
      enabled: true,
      frequency: { in: [...CADENCES] },
    },
    select: {
      userId: true,
      teamId: true,
      preferenceType: true,
      frequency: true,
    },
    take: 10_000,
  });

  // 2. Group by (user, team, cadence) → the preference types it covers.
  const groups = new Map<
    string,
    {
      userId: string;
      teamId: string;
      cadence: DigestCadence;
      types: NotificationPreferenceType[];
    }
  >();
  for (const row of prefRows) {
    const cadence = row.frequency as DigestCadence;
    const key = `${row.userId}|${row.teamId}|${cadence}`;
    const g = groups.get(key) ?? {
      userId: row.userId,
      teamId: row.teamId,
      cadence,
      types: [],
    };
    g.types.push(row.preferenceType as NotificationPreferenceType);
    groups.set(key, g);
  }

  // Canonical aggregation cache — one run per RECIPIENT per scheduler
  // pass, shared across that user's workspaces/cadences.
  const aggregationByUser = new Map<string, InboxItem[] | null>();
  async function itemsForUser(userId: string): Promise<InboxItem[] | null> {
    if (aggregationByUser.has(userId)) {
      return aggregationByUser.get(userId) ?? null;
    }
    const agg = await buildInboxAggregation(userId, log);
    if (!agg.ok) {
      aggregationByUser.set(userId, null);
      return null;
    }
    // Persist snapshots for inactive users too — history must not
    // depend on the user opening the app.
    await syncInboxSnapshots(userId, agg.allItems, now, log);
    aggregationByUser.set(userId, agg.allItems);
    return agg.allItems;
  }

  for (const group of [...groups.values()].slice(0, maxGroups)) {
    summary.groupsConsidered += 1;
    const lastField = LAST_FIELD[group.cadence];
    const periodMs = CADENCE_MS[group.cadence];

    // Schedule row (defaults when absent).
    const sched = await prisma.notificationScheduleSetting.findUnique({
      where: {
        userId_teamId: { userId: group.userId, teamId: group.teamId },
      },
    });
    const lastAt = sched?.[lastField] ?? null;
    if (lastAt && now.getTime() - lastAt.getTime() < periodMs) {
      summary.skippedNotDue += 1;
      continue;
    }

    // 3. CANONICAL aggregation for the recipient — authorization,
    //    membership, and per-user state are evaluated NOW, not at some
    //    earlier UI visit.
    const allItems = await itemsForUser(group.userId);
    if (allItems === null) {
      summary.skippedEmpty += 1;
      continue;
    }
    const categories = new Set(
      group.types.flatMap((t) => PREFERENCE_CATEGORY_MAP[t] ?? []),
    );
    if (categories.size === 0) {
      summary.skippedEmpty += 1;
      continue;
    }
    const nowMs = now.getTime();
    const batch = allItems
      .filter((it) => {
        // Workspace-scoped digest group: only this team's items.
        if (it.context?.teamId !== group.teamId) return false;
        if (!categories.has(it.category)) return false;
        if (it.isRead) return false;
        if (it.dismissedAt != null) return false;
        if (
          it.snoozedUntil != null &&
          new Date(it.snoozedUntil).getTime() > nowMs
        ) {
          return false;
        }
        // Cadence window: only items that fired since the last digest.
        if (lastAt && new Date(it.occurredAt).getTime() < lastAt.getTime()) {
          return false;
        }
        return true;
      })
      .slice(0, 50);

    if (batch.length === 0) {
      // Nothing to send — advance the bookkeeping so the next window
      // starts now (empty digests are never sent).
      await upsertLast(group.userId, group.teamId, lastField, now);
      summary.skippedEmpty += 1;
      continue;
    }

    // 4. Quiet hours (recipient-local). Deferred digests keep their
    //    bucket un-claimed so they send after the window ends.
    //
    // TIMEZONE PRECEDENCE (2026-07-16, single source of truth):
    //   1. explicit per-workspace notification-schedule override
    //   2. the account timezone (User.timezone — the canonical account
    //      default edited in /settings/preferences)
    //   3. UTC
    // Previously the account timezone was stored but NEVER consulted, so
    // the profile field silently disagreed with digest delivery. The user
    // row is queried only when no explicit override exists. Evidence /
    // custody / audit source timestamps are untouched — this affects
    // recipient-local scheduling presentation only.
    const accountTz = sched?.timezone
      ? null
      : ((
          await prisma.user.findUnique({
            where: { id: group.userId },
            select: { timezone: true },
          })
        )?.timezone ?? null);
    const schedule = {
      quietHoursEnabled: sched?.quietHoursEnabled ?? false,
      quietStartMinute: sched?.quietStartMinute ?? 1320,
      quietEndMinute: sched?.quietEndMinute ?? 420,
      quietCriticalOverride: sched?.quietCriticalOverride ?? true,
      timezone: sched?.timezone ?? accountTz ?? "UTC",
    };
    // Critical override is governed by BOTH the user's schedule AND the
    // ORGANIZATION policy for the categories involved: a critical item
    // bypasses quiet hours only when the user allows it AND no org
    // policy row for its preference type forbids the override. Routine
    // items can never bypass (their tone is never "critical").
    const hasCritical = batch.some((i) => i.tone === "critical");
    let orgAllowsOverride = true;
    if (hasCritical) {
      try {
        const team = await prisma.team.findUnique({
          where: { id: group.teamId },
          select: { isPersonal: true, organizationId: true },
        });
        if (team && !team.isPersonal && team.organizationId) {
          const policyRows =
            await prisma.organizationNotificationPolicy.findMany({
              where: {
                organizationId: team.organizationId,
                category: { in: group.types },
              },
              select: { quietHoursCriticalOverride: true },
            });
          orgAllowsOverride = policyRows.every(
            (p) => p.quietHoursCriticalOverride,
          );
        }
      } catch {
        /* policy table not migrated — user schedule governs */
      }
    }
    if (
      isWithinQuietHours(schedule, now) &&
      !(schedule.quietCriticalOverride && hasCritical && orgAllowsOverride)
    ) {
      summary.deferredQuietHours += 1;
      continue;
    }

    // 5. CLAIM the bucket before sending (idempotency across concurrent
    //    runs).
    const claimed = await claimBucket(
      group.userId,
      group.teamId,
      lastField,
      lastAt,
      now,
      periodMs,
    );
    if (!claimed) {
      summary.skippedClaimLost += 1;
      continue;
    }

    // 6. Recipient + workspace labels, then send through the EXISTING
    //    delivery pipeline (records the NotificationDelivery row; the
    //    pipeline owns retries).
    const [user, team] = await Promise.all([
      prisma.user.findUnique({
        where: { id: group.userId },
        select: { email: true, displayName: true },
      }),
      prisma.team.findUnique({
        where: { id: group.teamId },
        select: { name: true },
      }),
    ]);
    if (!user?.email) {
      summary.skippedEmpty += 1;
      continue;
    }
    const appBase = process.env.APP_BASE_URL?.trim() || null;
    try {
      await safeSendEmailNotification({
        eventType: "OPERATIONS_DIGEST",
        teamId: group.teamId,
        recipientEmail: user.email,
        recipientName: user.displayName ?? null,
        recipientUserId: group.userId,
        template: {
          kind: "OperationsDigest",
          data: {
            workspaceName: team?.name ?? "your workspace",
            cadenceLabel: CADENCE_LABEL[group.cadence],
            items: batch.map((i) => ({
              title: i.title,
              category: i.category,
              severity: i.tone,
            })),
            totalUnread: batch.length,
            operationsCenterUrl: appBase
              ? absoluteInternalUrl(appBase, internalNavPath("/inbox"))
              : null,
          },
        },
      });
      summary.digestsSent += 1;
    } catch {
      summary.failures += 1;
    }
  }

  return summary;
}

async function upsertLast(
  userId: string,
  teamId: string,
  field: "lastHourlyDigestAt" | "lastDailyDigestAt" | "lastWeeklyDigestAt",
  now: Date,
): Promise<void> {
  await prisma.notificationScheduleSetting.upsert({
    where: { userId_teamId: { userId, teamId } },
    create: { userId, teamId, [field]: now },
    update: { [field]: now },
  });
}

/**
 * Conditional claim: only one concurrent runner can advance the
 * bookkeeping timestamp for a due bucket. When no schedule row exists we
 * create it (a create race loses to the unique constraint and is treated
 * as claim-lost).
 */
async function claimBucket(
  userId: string,
  teamId: string,
  field: "lastHourlyDigestAt" | "lastDailyDigestAt" | "lastWeeklyDigestAt",
  lastAt: Date | null,
  now: Date,
  periodMs: number,
): Promise<boolean> {
  if (lastAt === null) {
    try {
      const res = await prisma.notificationScheduleSetting.updateMany({
        where: { userId, teamId, [field]: null },
        data: { [field]: now },
      });
      if (res.count > 0) return true;
      await prisma.notificationScheduleSetting.create({
        data: { userId, teamId, [field]: now },
      });
      return true;
    } catch {
      return false; // unique-violation race — another runner claimed it
    }
  }
  const res = await prisma.notificationScheduleSetting.updateMany({
    where: {
      userId,
      teamId,
      [field]: { lte: new Date(now.getTime() - periodMs) },
    },
    data: { [field]: now },
  });
  return res.count > 0;
}
