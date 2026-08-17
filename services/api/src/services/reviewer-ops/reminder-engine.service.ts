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
 *   - Reminders are SCHEDULED only. This engine has no dispatcher: no
 *     notification is sent from here, and a scheduled row stays SCHEDULED.
 *     (Corrected 2026-08-17, Phase 13 §4 — the previous wording, "notification
 *     dispatch is best-effort; failure marks the row FAILED", described a
 *     delivery path that was never built.)
 *   - No private reviewer note text in any field. No legal-hold
 *     reason. No raw evidence content.
 */

import { createHash } from "node:crypto";

import type { PrismaClient, ReviewerOpsReminder } from "@prisma/client";
import {
  REVIEWER_OPS_REMINDER_KINDS,
  stringContainsForbiddenOverclaim,
  type ReviewerOpsReminderKind,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

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
// PHASE 13 §4 (2026-08-17) — `markReminderDelivered` and `markReminderFailed`
// were REMOVED here.
//
// The manifest recorded them as waiting on a dispatcher that "does not report
// delivery outcomes back to the reminder engine". Reading the tree, the gap is
// larger than that: there is no dispatcher. Nothing selects due reminders,
// nothing sends one, nothing consumes `communicationMessageId`. The engine
// SCHEDULES — `sweepDueSoonReminders` and `sweepInactivityReminders` create rows
// with status SCHEDULED through `scheduleReminder`, driven for real by the
// cron-secret reconcile route — and the row is never touched again. Three of the
// four values in the status vocabulary (DELIVERED, FAILED, SUPPRESSED) are
// unreachable in production, and the reviewer-ops runtime probe’s status
// `groupBy` will forever report a 100% SCHEDULED distribution.
//
// So these were not two functions one call away from being live; they were the
// outcome half of a delivery mechanism that does not exist. Keeping executable
// writers warm for it makes the reminder engine look like it delivers reminders.
// The capability is recorded as a backlog item in
// `docs/architecture/program-ledger.md` — a due-reminder selector, a
// notification send, and an outcome callback are one unit of work, and when it
// is built these two transitions are the smallest part of it.
// -----------------------------------------------------------------------------

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
  const rows = await client.evidenceReviewWorkflow.findMany({
    where: {
      teamId: input.teamId,
      slaStatus: "DUE_SOON",
      assignedToUserId: { not: null },
      status: {
        notIn: ["CLOSED", "REJECTED_INSUFFICIENT", "APPROVED_INTERNAL"],
      },
    },
    take: batchSize,
    select: {
      id: true,
      assignedToUserId: true,
      priority: true,
      dueAt: true,
    },
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
  const rows = await client.evidenceReviewWorkflow.findMany({
    where: {
      teamId: input.teamId,
      assignedToUserId: { not: null },
      status: {
        notIn: ["CLOSED", "REJECTED_INSUFFICIENT", "APPROVED_INTERNAL"],
      },
      OR: [
        { lastReviewedAt: { lte: cutoff } },
        { lastReviewedAt: null, assignedAtUtc: { lte: cutoff } },
      ],
    },
    take: batchSize,
    select: {
      id: true,
      assignedToUserId: true,
      assignedAtUtc: true,
      lastReviewedAt: true,
    },
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
