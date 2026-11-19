/**
 * Phase 8.5 — Evidence Request reminder scheduler.
 *
 * Scans live evidence requests and sends one reminder email per request
 * within a configurable cooldown. Conservative by design:
 *   - only OPEN / SENT / VIEWED / IN_PROGRESS requests
 *   - dueAtUtc must be near or past
 *   - recipient must be external (EXTERNAL_CONTRIBUTOR — anonymous/
 *     pseudonymous have no destination address)
 *   - recipient email must be set
 *   - no reminder sent within the last NOTIFICATION_REMINDER_INTERVAL_HOURS
 *   - notifications feature must be enabled
 *   - reminder feature itself must be enabled (NOTIFICATION_REMINDERS_ENABLED)
 *
 * The scheduler is API-side. It can be invoked manually via an admin
 * route (Part F) or wired into a setInterval at process start. It never
 * blocks any business workflow; failures are absorbed.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { acquireLease } from "../rate-limit.js";
import {
  isNotificationsFeatureEnabled,
  safeSendEmailNotification,
  deliveryReinvitationRefusal,
} from "./index.js";

const REMINDERS_FLAG = "NOTIFICATION_REMINDERS_ENABLED";
const REMINDERS_INTERVAL_HOURS = "NOTIFICATION_REMINDER_INTERVAL_HOURS";

export function isReminderSchedulerEnabled(): boolean {
  return (
    process.env[REMINDERS_FLAG] === "true" && isNotificationsFeatureEnabled()
  );
}

export function reminderCooldownMs(): number {
  const raw = process.env[REMINDERS_INTERVAL_HOURS];
  const hours = raw ? Number.parseInt(raw, 10) : 24;
  if (!Number.isFinite(hours) || hours <= 0) return 24 * 3600 * 1000;
  // Hard ceiling so a misconfigured env doesn't pin the cooldown to
  // months.
  return Math.min(hours, 24 * 30) * 3600 * 1000;
}

const ELIGIBLE_REQUEST_STATUSES = [
  "OPEN",
  "SENT",
  "VIEWED",
  "IN_PROGRESS",
] as const;

export type ReminderSchedulerSummary = {
  scanned: number;
  reminded: number;
  skippedRecent: number;
  skippedNoEmail: number;
  skippedFeatureDisabled: number;
  /** B2B-F-14 — another run holds this request's reminder claim. */
  skippedClaimed: number;
  /** B2B-F-14 — no live upload link can be given, so no reminder is sent. */
  skippedNoLink: number;
  /** PRO-N1Z-02 — the workspace's plan no longer includes secure intake. */
  skippedPlan: number;
};

/** B2B-F-14 — per-request reminder claim TTL (bounds a crashed holder). */
export const REMINDER_CLAIM_TTL_MS = 2 * 60 * 1000;

/**
 * B2B-F-14 — the actionable link a reminder can carry. The scheduler cannot
 * rebuild the intake URL (only the token HASH is stored), but the original
 * EVIDENCE_REQUEST_SENT delivery persisted the exact URL it sent to this
 * recipient. It is reused ONLY while the request is still bound to the same
 * intake link and that link is ACTIVE, unexpired and has uses left; otherwise
 * null, and the reminder is not sent (a reminder the recipient cannot act on
 * is noise, and pointing at a dead link is worse).
 */
async function liveReminderIntakeUrl(
  req: {
    id: string;
    recipientEmail: string | null;
    intakeLinkId: string | null;
    intakeLink: {
      status: string;
      expiresAtUtc: Date;
      maxUses: number;
      usedCount: number;
    } | null;
  },
  now: Date,
  client: PrismaClient,
): Promise<string | null> {
  const link = req.intakeLink;
  if (!req.intakeLinkId || !link) return null;
  if (link.status !== "ACTIVE") return null;
  if (link.expiresAtUtc.getTime() <= now.getTime()) return null;
  if (link.usedCount >= link.maxUses) return null;
  const original = await client.notificationDelivery.findFirst({
    where: {
      evidenceRequestId: req.id,
      intakeLinkId: req.intakeLinkId,
      eventType: "EVIDENCE_REQUEST_SENT",
      recipient: req.recipientEmail ?? undefined,
    },
    orderBy: { createdAt: "desc" },
    select: { templateContextJson: true },
  });
  const ctx = original?.templateContextJson as
    | { kind?: string; data?: { intakeUrl?: unknown } }
    | null
    | undefined;
  const url = ctx?.kind === "EvidenceRequest" ? ctx.data?.intakeUrl : null;
  return typeof url === "string" && /^https?:\/\//.test(url) ? url : null;
}

export async function runReminderScheduler(
  input: { now?: Date; batchSize?: number } = {},
  client: PrismaClient = defaultPrisma,
): Promise<ReminderSchedulerSummary> {
  const summary: ReminderSchedulerSummary = {
    scanned: 0,
    reminded: 0,
    skippedRecent: 0,
    skippedNoEmail: 0,
    skippedFeatureDisabled: 0,
    skippedClaimed: 0,
    skippedNoLink: 0,
    skippedPlan: 0,
  };

  if (!isReminderSchedulerEnabled()) {
    summary.skippedFeatureDisabled = 1;
    return summary;
  }

  const now = input.now ?? new Date();
  const cooldownMs = reminderCooldownMs();
  const cooldownThreshold = new Date(now.getTime() - cooldownMs);
  const batchSize = Math.min(Math.max(input.batchSize ?? 100, 1), 500);

  const candidates = await client.evidenceRequest.findMany({
    where: {
      status: { in: ELIGIBLE_REQUEST_STATUSES as unknown as string[] as never[] },
      // Only nudge when there's a due date AND it's within a 7-day pre/post
      // window. Avoids spamming about distant future deadlines.
      dueAtUtc: {
        not: null,
        lte: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        gte: new Date(now.getTime() - 90 * 24 * 3600 * 1000),
      },
      recipientMode: "EXTERNAL_CONTRIBUTOR",
      recipientEmail: { not: null },
    },
    take: batchSize,
    orderBy: { dueAtUtc: "asc" },
    include: {
      deliverables: true,
      intakeLink: true,
    },
  });

  for (const req of candidates) {
    summary.scanned += 1;

    if (!req.recipientEmail) {
      summary.skippedNoEmail += 1;
      continue;
    }

    // B2B-F-14 — CLAIM, then check, then send. The cooldown used to be a
    // read (findFirst) followed by a send, so two overlapping runs could both
    // read "no recent reminder" and both send. The per-request lease makes the
    // check-and-send exclusive across processes (Redis); the delivery row the
    // send writes is what the next holder's cooldown read then sees. The lease
    // REFUSES when the configured store errors (AUD-50, B8-F-004): a skipped
    // reminder is retried by the next run, a duplicate cannot be recalled.
    const lease = await acquireLease(
      `evidence_request_reminder:${req.id}`,
      REMINDER_CLAIM_TTL_MS,
      { onStoreError: "refuse" },
    );
    if (!lease.acquired) {
      summary.skippedClaimed += 1;
      continue;
    }
    try {
      const lastReminder = await client.notificationDelivery.findFirst({
        where: {
          evidenceRequestId: req.id,
          eventType: "EVIDENCE_REQUEST_REMINDER",
          createdAt: { gte: cooldownThreshold },
        },
        orderBy: { createdAt: "desc" },
      });
      if (lastReminder) {
        summary.skippedRecent += 1;
        continue;
      }

      const intakeUrl = await liveReminderIntakeUrl(req, now, client);
      if (!intakeUrl) {
        summary.skippedNoLink += 1;
        continue;
      }
      // PRO-N1Z-02 — the same re-invitation gate every resend asks: no
      // reminder invites a contributor to a link the first upload would be
      // refused on (downgraded / lapsed workspace).
      if (
        await deliveryReinvitationRefusal(
          { eventType: "EVIDENCE_REQUEST_REMINDER", teamId: req.teamId, evidenceRequestId: req.id, intakeLinkId: req.intakeLinkId },
          client,
        )
      ) {
        summary.skippedPlan += 1;
        continue;
      }

      const team = await client.team.findUnique({
        where: { id: req.teamId },
        select: { name: true, evidenceWorkspaceLabel: true },
      });

      await safeSendEmailNotification(
        {
          eventType: "EVIDENCE_REQUEST_REMINDER",
          teamId: req.teamId,
          recipientEmail: req.recipientEmail,
          recipientName: req.recipientLabel ?? null,
          evidenceRequestId: req.id,
          evidenceId: req.evidenceId ?? null,
          intakeLinkId: req.intakeLinkId ?? null,
          template: {
            kind: "EvidenceRequest",
            data: {
              workspaceName:
                team?.evidenceWorkspaceLabel ?? team?.name ?? "Your workspace",
              requestTitle: req.title,
              requestInstructions: req.instructions || null,
              dueAtUtcIso: req.dueAtUtc?.toISOString() ?? null,
              intakeUrl,
              deliverableSummaries: (req.deliverables ?? []).map((d) => ({
                title: d.title,
                required: d.required,
              })),
            },
          },
        },
        client,
      );
      summary.reminded += 1;
    } finally {
      await lease.release();
    }
  }

  return summary;
}
