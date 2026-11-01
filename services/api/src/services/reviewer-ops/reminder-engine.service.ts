/**
 * Phase 25.5 — Reviewer-ops reminder engine.
 *
 * Single writer of `reviewer_ops_reminders`. Owns:
 *   - DUE_SOON reminders for upcoming workflow deadlines
 *   - ESCALATION_WARNING reminders for open escalations approaching SLA
 *   - REVIEWER_INACTIVE reminders for stalled assignees
 *   - REASSIGNMENT_SUGGESTION reminders surfaced to admins
 *
 * Hard rules:
 *   - Idempotency via the unique `(teamId, kind, dedup_key)` constraint.
 *     The service catches the duplicate-row error and treats it as
 *     "already scheduled" — bumping `reviewer_reminder_duplicate_blocked_total`.
 *   - `safeSummary` is bounded (400 chars) and scrubbed against the
 *     forbidden-overclaim phrase catalog.
 *   - `deliverScheduledReminders` is the dispatcher (WORKFLOW-010): a due
 *     SCHEDULED row is claimed once, sent through the review notification path,
 *     and ends DELIVERED, SUPPRESSED or FAILED. A reminder is best-effort like the
 *     other review mail, and the rows are readable at
 *     `GET /v1/reviewer-ops/reminders`, so a person who has not opted in to email
 *     still has it on the SLA page.
 *   - No private reviewer note text in any field. No legal-hold
 *     reason. No raw evidence content.
 */

import { createHash } from "node:crypto";

import type { PrismaClient, ReviewerOpsReminder } from "@prisma/client";
import {
  REVIEWER_OPS_REMINDER_KINDS,
  isReviewOpenDbStatus,
  stringContainsForbiddenOverclaim,
  type ReviewerOpsReminderKind,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { sendReviewReminder } from "../review-operations/review-notifications.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { advanceSweepCursor, afterCursor, readSweepCursor } from "./sweep-cursor.js";

// -----------------------------------------------------------------------------
// Projection
// -----------------------------------------------------------------------------

export type ReviewerOpsReminderProjection = {
  id: string;
  kind: ReviewerOpsReminderKind;
  status: "SCHEDULED" | "DELIVERED" | "SUPPRESSED" | "FAILED";
  workflowId: string | null;
  escalationId: string | null;
  reviewerUserId: string | null;
  safeSummary: string;
  dayBucket: string;
  createdAt: string;
};

function projectReminder(row: ReviewerOpsReminder): ReviewerOpsReminderProjection {
  return {
    id: row.id,
    kind: row.kind as ReviewerOpsReminderKind,
    status: row.status as ReviewerOpsReminderProjection["status"],
    workflowId: row.workflowId,
    escalationId: row.escalationId,
    reviewerUserId: row.reviewerUserId,
    safeSummary: row.safeSummary,
    dayBucket: row.dayBucket,
    createdAt: row.createdAt.toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const KIND_SET = new Set<string>(REVIEWER_OPS_REMINDER_KINDS);

function dayBucket(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function buildDedupKey(input: {
  workflowId: string | null;
  reviewerUserId: string | null;
  escalationId: string | null;
  kind: ReviewerOpsReminderKind;
  now: Date;
}): string {
  // dedup_key = SHA-256(`${workflowId|reviewerUserId|escalationId}:${kind}:${dayBucket}`).slice(0, 64)
  const anchor =
    input.workflowId ?? input.escalationId ?? input.reviewerUserId ?? "global";
  const raw = `${anchor}:${input.kind}:${dayBucket(input.now)}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 64);
}

function scrubSummary(summary: string): string {
  const trimmed = summary.trim().slice(0, 400);
  if (stringContainsForbiddenOverclaim(trimmed)) {
    return "[summary withheld — wording violation]";
  }
  return trimmed.length > 0 ? trimmed : "Reviewer-ops reminder.";
}

// -----------------------------------------------------------------------------
// Public — scheduleReminder
// -----------------------------------------------------------------------------

export type ScheduleReminderInput = {
  teamId: string;
  kind: ReviewerOpsReminderKind;
  safeSummary: string;
  workflowId?: string | null;
  escalationId?: string | null;
  reviewerUserId?: string | null;
};

export type ScheduleReminderResult =
  | { ok: true; created: boolean; reminder: ReviewerOpsReminderProjection }
  | { ok: false; reason: "invalid_kind" | "unknown" };

export async function scheduleReminder(
  input: ScheduleReminderInput,
  client: PrismaClient = defaultPrisma,
): Promise<ScheduleReminderResult> {
  if (!KIND_SET.has(input.kind)) {
    return { ok: false, reason: "invalid_kind" };
  }
  const now = new Date();
  const dedupKey = buildDedupKey({
    workflowId: input.workflowId ?? null,
    reviewerUserId: input.reviewerUserId ?? null,
    escalationId: input.escalationId ?? null,
    kind: input.kind,
    now,
  });
  const summary = scrubSummary(input.safeSummary);

  // Pre-check the unique key. If the row exists, return it without
  // attempting an insert (cheaper than catching the unique-violation).
  const existing = await client.reviewerOpsReminder.findUnique({
    where: {
      teamId_kind_dedupKey: {
        teamId: input.teamId,
        kind: input.kind,
        dedupKey,
      },
    },
  });
  if (existing) {
    bump("reviewer_reminder_duplicate_blocked_total");
    return {
      ok: true,
      created: false,
      reminder: projectReminder(existing),
    };
  }

  try {
    const created = await client.reviewerOpsReminder.create({
      data: {
        teamId: input.teamId,
        kind: input.kind,
        dedupKey,
        workflowId: input.workflowId ?? null,
        escalationId: input.escalationId ?? null,
        reviewerUserId: input.reviewerUserId ?? null,
        safeSummary: summary,
        status: "SCHEDULED",
        dayBucket: dayBucket(now),
      },
    });
    bump("reviewer_reminder_scheduled_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "reviewer_reminder_scheduled",
      severity: "INFO",
      details: {
        reminderId: created.id,
        kind: input.kind,
        workflowId: input.workflowId ?? null,
        reviewerUserId: input.reviewerUserId ?? null,
      },
    });
    return { ok: true, created: true, reminder: projectReminder(created) };
  } catch (err) {
    // Race: another sweep won the insert. Re-read.
    const racer = await client.reviewerOpsReminder.findUnique({
      where: {
        teamId_kind_dedupKey: {
          teamId: input.teamId,
          kind: input.kind,
          dedupKey,
        },
      },
    });
    if (racer) {
      bump("reviewer_reminder_duplicate_blocked_total");
      return { ok: true, created: false, reminder: projectReminder(racer) };
    }
    // Unknown failure — bump + return safely.
    bump("reviewer_reminder_failed_total");
    return {
      ok: false,
      reason: err instanceof Error ? "unknown" : "unknown",
    };
  }
}

// -----------------------------------------------------------------------------
// Public — deliverScheduledReminders (WORKFLOW-010).
// -----------------------------------------------------------------------------

/** A reminder older than this describes a state that has moved on. */
const REMINDER_DELIVERY_WINDOW_MS = 24 * 3600 * 1000;

export type ReminderDeliveryResult = {
  delivered: number;
  suppressed: number;
  failed: number;
};

export async function deliverScheduledReminders(
  input: { teamId: string; batchSize?: number; now?: Date },
  client: PrismaClient = defaultPrisma,
): Promise<ReminderDeliveryResult> {
  const now = input.now ?? new Date();
  // Rows scheduled while nothing could deliver them stay in the ledger, closed,
  // rather than reaching a person days late.
  const stale = await client.reviewerOpsReminder.updateMany({
    where: {
      teamId: input.teamId,
      status: "SCHEDULED",
      createdAt: { lt: new Date(now.getTime() - REMINDER_DELIVERY_WINDOW_MS) },
    },
    data: { status: "SUPPRESSED" },
  });
  const rows = await client.reviewerOpsReminder.findMany({
    where: {
      teamId: input.teamId,
      status: "SCHEDULED",
      kind: { in: ["DUE_SOON", "REVIEWER_INACTIVE"] },
    },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(input.batchSize ?? 200, 1), 1000),
  });
  const out: ReminderDeliveryResult = { delivered: 0, suppressed: stale.count, failed: 0 };
  for (const row of rows) {
    // The claim: an overlapping sweep sends nothing.
    const claimed = await client.reviewerOpsReminder.updateMany({
      where: { id: row.id, status: "SCHEDULED" },
      data: { status: "SUPPRESSED" },
    });
    if (claimed.count !== 1) continue;
    const workflow = row.workflowId
      ? await client.evidenceReviewWorkflow.findFirst({
          where: { id: row.workflowId, teamId: input.teamId },
          select: { evidenceId: true, teamId: true, assignedToUserId: true, status: true, slaPausedAtUtc: true },
        })
      : null;
    // Still true? A review finished, paused or handed on since has nothing to say.
    if (
      !workflow ||
      workflow.slaPausedAtUtc ||
      !isReviewOpenDbStatus(String(workflow.status)) ||
      workflow.assignedToUserId !== row.reviewerUserId
    ) {
      out.suppressed += 1;
      continue;
    }
    const sent = await sendReviewReminder(
      { workflow, kind: row.kind as "DUE_SOON" | "REVIEWER_INACTIVE" },
      client,
    ).catch(() => null);
    if (sent?.status === "sent") {
      await client.reviewerOpsReminder.update({ where: { id: row.id }, data: { status: "DELIVERED" } });
      out.delivered += 1;
    } else if (sent?.status === "skipped_recipient_preference") {
      out.suppressed += 1;
    } else {
      await client.reviewerOpsReminder.update({ where: { id: row.id }, data: { status: "FAILED" } });
      bump("reviewer_reminder_failed_total");
      out.failed += 1;
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Public — sweepDueSoonReminders + sweepInactivityReminders.
//
// These are invoked by the reconcile job; they read the current state
// of the workspace and schedule any missing reminders.
// -----------------------------------------------------------------------------

export type ReminderSweepResult = {
  scanned: number;
  scheduled: number;
  duplicates: number;
};

export async function sweepDueSoonReminders(
  input: { teamId: string; batchSize?: number },
  client: PrismaClient = defaultPrisma,
): Promise<ReminderSweepResult> {
  const batchSize = Math.min(Math.max(input.batchSize ?? 200, 1), 1000);
  const cursorKey = `reviewer_due_soon:${input.teamId}`;
  const cursor = await readSweepCursor(client, cursorKey);
  const rows = await client.evidenceReviewWorkflow.findMany({
    where: {
      teamId: input.teamId,
      ...afterCursor(cursor),
      slaStatus: "DUE_SOON",
      assignedToUserId: { not: null },
      status: {
        notIn: ["CLOSED", "REJECTED_INSUFFICIENT", "APPROVED_INTERNAL"],
      },
    },
    orderBy: { id: "asc" },
    take: batchSize,
    select: {
      id: true,
      assignedToUserId: true,
      priority: true,
      dueAt: true,
    },
  });
  await advanceSweepCursor(client, cursorKey, cursor, {
    lastId: rows.at(-1)?.id ?? null,
    pageSize: rows.length,
    limit: batchSize,
  });
  let scheduled = 0;
  let duplicates = 0;
  for (const r of rows) {
    const res = await scheduleReminder(
      {
        teamId: input.teamId,
        kind: "DUE_SOON",
        workflowId: r.id,
        reviewerUserId: r.assignedToUserId,
        safeSummary: `Review due soon — priority ${r.priority.toLowerCase()}.`,
      },
      client,
    );
    if (res.ok && res.created) scheduled += 1;
    else if (res.ok) duplicates += 1;
  }
  return { scanned: rows.length, scheduled, duplicates };
}

export async function sweepInactivityReminders(
  input: { teamId: string; thresholdHours: number; batchSize?: number },
  client: PrismaClient = defaultPrisma,
): Promise<ReminderSweepResult> {
  const batchSize = Math.min(Math.max(input.batchSize ?? 200, 1), 1000);
  const cutoff = new Date(Date.now() - input.thresholdHours * 3600_000);
  const cursorKey = `reviewer_inactive:${input.teamId}`;
  const cursor = await readSweepCursor(client, cursorKey);
  const rows = await client.evidenceReviewWorkflow.findMany({
    where: {
      teamId: input.teamId,
      ...afterCursor(cursor),
      assignedToUserId: { not: null },
      status: {
        notIn: ["CLOSED", "REJECTED_INSUFFICIENT", "APPROVED_INTERNAL"],
      },
      OR: [
        { lastReviewedAt: { lte: cutoff } },
        { lastReviewedAt: null, assignedAtUtc: { lte: cutoff } },
      ],
    },
    orderBy: { id: "asc" },
    take: batchSize,
    select: {
      id: true,
      assignedToUserId: true,
      assignedAtUtc: true,
      lastReviewedAt: true,
    },
  });
  await advanceSweepCursor(client, cursorKey, cursor, {
    lastId: rows.at(-1)?.id ?? null,
    pageSize: rows.length,
    limit: batchSize,
  });
  let scheduled = 0;
  let duplicates = 0;
  for (const r of rows) {
    const res = await scheduleReminder(
      {
        teamId: input.teamId,
        kind: "REVIEWER_INACTIVE",
        workflowId: r.id,
        reviewerUserId: r.assignedToUserId,
        safeSummary: `Reviewer inactive on this assignment for over ${input.thresholdHours}h.`,
      },
      client,
    );
    if (res.ok && res.created) {
      scheduled += 1;
      bump("reviewer_inactivity_detected_total");
    } else if (res.ok) {
      duplicates += 1;
    }
  }
  return { scanned: rows.length, scheduled, duplicates };
}

// -----------------------------------------------------------------------------
// List — used by the UI to surface a reviewer's open reminders.
// -----------------------------------------------------------------------------

export async function listReminders(
  input: {
    teamId: string;
    kind?: ReviewerOpsReminderKind;
    workflowId?: string;
    reviewerUserId?: string;
    limit?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<ReviewerOpsReminderProjection>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
  const rows = await client.reviewerOpsReminder.findMany({
    where: {
      teamId: input.teamId,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      ...(input.reviewerUserId
        ? { reviewerUserId: input.reviewerUserId }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(projectReminder);
}
