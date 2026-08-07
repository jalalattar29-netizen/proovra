/**
 * PHASE 12 CORRECTIVE PASS §2 CONTINUATION (ARCH-005, 2026-08-07).
 *
 * THE TRIGGER MAP — every allowlisted trigger, bound to a real source.
 *
 * The eleven triggers in `AUTOMATION_TRIGGER_TYPES` have existed in the
 * database CHECK constraint, in the TypeScript union and in the rule-builder UI
 * since Phase E3. Not one of them was ever emitted. This module is where each
 * one meets the thing that actually happens, and it exists as ONE file so that
 * "which triggers are wired?" has a single answer instead of being a repo-wide
 * grep.
 *
 * TWO KINDS OF SOURCE, AND THE DIFFERENCE MATTERS
 * ---------------------------------------------------------------------------
 * EVENT-SOURCED (6) — EVIDENCE_CREATED, EVIDENCE_FINALIZED, EVIDENCE_REPORTED,
 * REVIEW_ASSIGNED, ESCALATION_CREATED, LEGAL_HOLD_CREATED. Something happened
 * in a transaction. These call `enqueueAutomationTrigger` with the SOURCE
 * TRANSACTION'S client, so the run commits with the change or not at all, and
 * the source event id is the durable id of the thing that happened.
 *
 * DETECTED (5) — REVIEW_OVERDUE, SLA_DUE_SOON, EXTERNAL_ACCESS_EXPIRING,
 * RETENTION_CANDIDATE_FOUND, PACKAGE_READY.
 *
 * Four of those are genuinely TIME-BASED: nothing happens. A due date passes,
 * an access grant nears expiry, a retention clock runs out. There is no event
 * to hook, and manufacturing one — writing a row at midnight so something can
 * react to it — would be inventing a domain fact to satisfy an architecture.
 *
 * PACKAGE_READY is the fifth and is classified honestly rather than
 * conveniently: it IS an event, but its writer is the WORKER, and the worker
 * does not import API modules. Detecting the durable `state = 'READY'` the
 * builder commits costs up to one sweep interval of latency and keeps the
 * producer a single authority; reaching across the process boundary or
 * duplicating the producer worker-side would cost correctness.
 *
 * The honest risk in a detector is that it re-fires every tick. It cannot here:
 * the source event id carries a WINDOW KEY (the UTC day, the target's own due
 * timestamp, or — for a once-only fact like a package becoming READY — the
 * target id alone), so re-detection collapses on the partial unique index and
 * a genuinely new occurrence does not.
 *
 * NOTHING IN THIS FILE DECIDES ANYTHING. It reads durable rows, derives a
 * durable identity, and hands both to the one producer. No tenant is taken
 * from a parameter that a request could influence: every `teamId` below comes
 * off the row being read or the row being written.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import {
  enqueueAutomationTrigger,
  type AutomationOutboxClient,
  type EnqueueAutomationTriggerOutcome,
} from "./automation-outbox.service.js";

// ===========================================================================
// EVENT-SOURCED TRIGGERS
//
// Each takes the SOURCE TRANSACTION'S client as its first argument. That is
// not a convenience — it is the entire durability guarantee, and a call site
// that passes the base client instead has reopened the crash window.
// ===========================================================================

/** EVIDENCE_CREATED — a new evidence row was inserted. */
export function triggerEvidenceCreated(
  tx: AutomationOutboxClient,
  input: { teamId: string; evidenceId: string; context?: Record<string, unknown> },
): Promise<EnqueueAutomationTriggerOutcome> {
  return enqueueAutomationTrigger(tx, {
    teamId: input.teamId,
    triggerType: "EVIDENCE_CREATED",
    targetType: "evidence",
    targetId: input.evidenceId,
    // The evidence id IS the durable identity of its own creation: it is
    // created exactly once.
    sourceEventId: `evidence.created:${input.evidenceId}`,
    context: input.context,
  });
}

/**
 * EVIDENCE_FINALIZED — the lifecycle reached a finalized state.
 *
 * The source event id is the LIFECYCLE EVENT id, not the evidence id: evidence
 * can legitimately re-enter and re-leave a state, and each transition is a
 * distinct occurrence an operator would expect a rule to see.
 */
export function triggerEvidenceFinalized(
  tx: AutomationOutboxClient,
  input: {
    teamId: string;
    evidenceId: string;
    lifecycleEventId: string;
    context?: Record<string, unknown>;
  },
): Promise<EnqueueAutomationTriggerOutcome> {
  return enqueueAutomationTrigger(tx, {
    teamId: input.teamId,
    triggerType: "EVIDENCE_FINALIZED",
    targetType: "evidence",
    targetId: input.evidenceId,
    sourceEventId: `lifecycle.event:${input.lifecycleEventId}`,
    context: input.context,
  });
}

/** EVIDENCE_REPORTED — a report was requested for this evidence. */
export function triggerEvidenceReported(
  tx: AutomationOutboxClient,
  input: {
    teamId: string;
    evidenceId: string;
    reportId: string;
    context?: Record<string, unknown>;
  },
): Promise<EnqueueAutomationTriggerOutcome> {
  return enqueueAutomationTrigger(tx, {
    teamId: input.teamId,
    triggerType: "EVIDENCE_REPORTED",
    targetType: "evidence",
    targetId: input.evidenceId,
    sourceEventId: `report:${input.reportId}`,
    context: input.context,
  });
}

// PACKAGE_READY has NO emitter here on purpose. Its writer is the worker's
// exchange-package builder, and the worker does not import API modules; it is
// DETECTED below instead, from the durable `state = 'READY'` the builder
// commits. An emitter nobody calls would be precisely the unreachable-module
// shape LEGACY-003 exists to remove.

/**
 * REVIEW_ASSIGNED — a reviewer was assigned to a workflow.
 *
 * Reassignment is a NEW occurrence, so the source event id carries the
 * assignment timestamp: a rule that notifies the assignee must fire again when
 * the assignee changes, and must not fire twice for one assignment.
 */
export function triggerReviewAssigned(
  tx: AutomationOutboxClient,
  input: {
    teamId: string;
    workflowId: string;
    assignedAtUtc: Date;
    context?: Record<string, unknown>;
  },
): Promise<EnqueueAutomationTriggerOutcome> {
  return enqueueAutomationTrigger(tx, {
    teamId: input.teamId,
    triggerType: "REVIEW_ASSIGNED",
    targetType: "review_workflow",
    targetId: input.workflowId,
    sourceEventId: `review.assigned:${input.workflowId}:${input.assignedAtUtc.toISOString()}`,
    context: input.context,
  });
}

/** ESCALATION_CREATED — a review escalation was raised. */
export function triggerEscalationCreated(
  tx: AutomationOutboxClient,
  input: {
    teamId: string;
    escalationId: string;
    context?: Record<string, unknown>;
  },
): Promise<EnqueueAutomationTriggerOutcome> {
  return enqueueAutomationTrigger(tx, {
    teamId: input.teamId,
    triggerType: "ESCALATION_CREATED",
    targetType: "review_escalation",
    targetId: input.escalationId,
    sourceEventId: `escalation.created:${input.escalationId}`,
    context: input.context,
  });
}

/** LEGAL_HOLD_CREATED — a legal hold was placed on evidence. */
export function triggerLegalHoldCreated(
  tx: AutomationOutboxClient,
  input: { teamId: string; holdId: string; context?: Record<string, unknown> },
): Promise<EnqueueAutomationTriggerOutcome> {
  return enqueueAutomationTrigger(tx, {
    teamId: input.teamId,
    triggerType: "LEGAL_HOLD_CREATED",
    targetType: "legal_hold",
    targetId: input.holdId,
    sourceEventId: `legal_hold.created:${input.holdId}`,
    context: input.context,
  });
}

// ===========================================================================
// TIME-SOURCED TRIGGERS
//
// Detected, not received. Each detector is a bounded query over the durable
// table that already holds the date, and each derives a WINDOW KEY so that
// re-detecting the same condition collapses instead of firing every minute.
// ===========================================================================

/** The UTC day, used as the collapse window for a standing condition. */
function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** How far ahead "due soon" looks. Bounded and stated, never configurable per rule. */
export const SLA_DUE_SOON_WINDOW_HOURS = 24;

/** Rows examined per detector per tick. */
const DETECT_LIMIT = 100;

export type TimeTriggerDetectionOutcome = {
  reviewOverdue: number;
  slaDueSoon: number;
  externalAccessExpiring: number;
  retentionCandidate: number;
  packageReady: number;
};

/**
 * Run every time-based detector once.
 *
 * Called by the automation sweep, before the claim pass, so a condition
 * detected in this tick is executed in this tick. Never throws: a detector
 * that cannot read its table contributes zero rather than stopping the others.
 */
export async function detectTimeBasedAutomationTriggers(input?: {
  prisma?: PrismaClient;
  nowMs?: number;
}): Promise<TimeTriggerDetectionOutcome> {
  const prisma = input?.prisma ?? defaultPrisma;
  const nowMs = input?.nowMs ?? Date.now();
  const now = new Date(nowMs);
  const day = utcDayKey(nowMs);
  const out: TimeTriggerDetectionOutcome = {
    reviewOverdue: 0,
    slaDueSoon: 0,
    externalAccessExpiring: 0,
    retentionCandidate: 0,
    packageReady: 0,
  };

  // -------------------------------------------------------------------------
  // REVIEW_OVERDUE — an open review workflow whose due date has passed.
  //
  // The window key is the DUE DATE itself rather than the day: a workflow that
  // is overdue is overdue permanently until somebody closes it, and keying on
  // the day would fire a fresh run every midnight for as long as it stayed
  // open. Keying on the due date fires exactly once per due date, and again
  // (correctly) if somebody moves the date.
  // -------------------------------------------------------------------------
  try {
    const overdue = await prisma.evidenceReviewWorkflow.findMany({
      where: {
        teamId: { not: null },
        dueAt: { lt: now },
        closedAt: null,
        status: { notIn: ["CLOSED", "REJECTED_INSUFFICIENT"] },
      },
      select: { id: true, teamId: true, dueAt: true, status: true, priority: true },
      orderBy: { dueAt: "asc" },
      take: DETECT_LIMIT,
    });
    for (const w of overdue) {
      if (!w.teamId || !w.dueAt) continue;
      const r = await enqueueAutomationTrigger(prisma, {
        teamId: w.teamId,
        triggerType: "REVIEW_OVERDUE",
        targetType: "review_workflow",
        targetId: w.id,
        sourceEventId: `review.overdue:${w.id}:${w.dueAt.toISOString()}`,
        context: { status: String(w.status), priority: String(w.priority) },
      });
      out.reviewOverdue += r.enqueued;
    }
  } catch {
    /* a detector that cannot read contributes zero; the others still run */
  }

  // -------------------------------------------------------------------------
  // SLA_DUE_SOON — the same workflows, inside the warning window and NOT yet
  // overdue. The two conditions are disjoint by construction, so one workflow
  // never produces both in the same tick.
  // -------------------------------------------------------------------------
  try {
    const horizon = new Date(nowMs + SLA_DUE_SOON_WINDOW_HOURS * 3600 * 1000);
    const soon = await prisma.evidenceReviewWorkflow.findMany({
      where: {
        teamId: { not: null },
        dueAt: { gte: now, lte: horizon },
        closedAt: null,
        status: { notIn: ["CLOSED", "REJECTED_INSUFFICIENT"] },
      },
      select: { id: true, teamId: true, dueAt: true, status: true, priority: true },
      orderBy: { dueAt: "asc" },
      take: DETECT_LIMIT,
    });
    for (const w of soon) {
      if (!w.teamId || !w.dueAt) continue;
      const r = await enqueueAutomationTrigger(prisma, {
        teamId: w.teamId,
        triggerType: "SLA_DUE_SOON",
        targetType: "review_workflow",
        targetId: w.id,
        sourceEventId: `sla.due_soon:${w.id}:${w.dueAt.toISOString()}`,
        context: {
          status: String(w.status),
          priority: String(w.priority),
          dueAt: w.dueAt.toISOString(),
        },
      });
      out.slaDueSoon += r.enqueued;
    }
  } catch {
    /* as above */
  }

  // -------------------------------------------------------------------------
  // EXTERNAL_ACCESS_EXPIRING — an ACTIVE external-review grant inside the
  // warning window.
  //
  // `ExternalReviewGrant` is the SOLE lifecycle authority for external access
  // (INV-001); reading the sidecar's duplicate columns here is exactly the
  // defect that row removed, so this reads the grant.
  // -------------------------------------------------------------------------
  try {
    const horizon = new Date(nowMs + 72 * 3600 * 1000);
    const expiring = await prisma.externalReviewGrant.findMany({
      where: {
        state: "ACTIVE",
        revokedAtUtc: null,
        expiresAtUtc: { gte: now, lte: horizon },
      },
      select: { id: true, teamId: true, expiresAtUtc: true },
      orderBy: { expiresAtUtc: "asc" },
      take: DETECT_LIMIT,
    });
    for (const g of expiring) {
      if (!g.teamId || !g.expiresAtUtc) continue;
      const r = await enqueueAutomationTrigger(prisma, {
        teamId: g.teamId,
        triggerType: "EXTERNAL_ACCESS_EXPIRING",
        targetType: "external_review_grant",
        targetId: g.id,
        sourceEventId: `external_access.expiring:${g.id}:${g.expiresAtUtc.toISOString()}`,
        context: { expiresAtUtc: g.expiresAtUtc.toISOString() },
      });
      out.externalAccessExpiring += r.enqueued;
    }
  } catch {
    /* as above */
  }

  // -------------------------------------------------------------------------
  // RETENTION_CANDIDATE_FOUND — evidence whose retention clock has run out.
  //
  // DETECTION ONLY. This trigger reports a candidate to an operator's rules;
  // it does not, and must not, participate in the destruction decision, which
  // belongs to the retention/destruction authority with its own legal-hold
  // precedence. The window key is the UTC day, because a candidate stays a
  // candidate and a daily reminder is the honest cadence for one.
  // -------------------------------------------------------------------------
  try {
    const candidates = await prisma.evidence.findMany({
      where: {
        deletedAt: null,
        retentionUntilUtc: { lte: now },
        lifecycleState: { notIn: ["PENDING_DESTRUCTION", "DESTROYED"] },
      },
      select: { id: true, teamId: true, lifecycleState: true },
      orderBy: { retentionUntilUtc: "asc" },
      take: DETECT_LIMIT,
    });
    for (const e of candidates) {
      if (!e.teamId) continue;
      const r = await enqueueAutomationTrigger(prisma, {
        teamId: e.teamId,
        triggerType: "RETENTION_CANDIDATE_FOUND",
        targetType: "evidence",
        targetId: e.id,
        sourceEventId: `retention.candidate:${e.id}:${day}`,
        context: { lifecycleState: String(e.lifecycleState) },
      });
      out.retentionCandidate += r.enqueued;
    }
  } catch {
    /* as above */
  }

  // -------------------------------------------------------------------------
  // PACKAGE_READY — DETECTED, and here is why it is not emitted.
  //
  // The writer is `services/worker/src/exchange-package-builder.ts`, and the
  // worker deliberately does not import API modules: every worker→API call in
  // this platform goes over the cron-secret machine boundary. Reaching into
  // the API's producer from the builder would be the first exception, and
  // adding a worker-side copy of the producer would be a second authority for
  // the outbox.
  //
  // So the durable fact the worker committed — `state = 'READY'` on the
  // package row — is read here. This is NOT a timer simulation: a package
  // becomes READY exactly once, so the source identity is the package id with
  // no window key, and re-detection collapses on the unique index. The only
  // cost is up to one sweep interval of latency, which is the same latency the
  // rest of this sweep already has.
  // -------------------------------------------------------------------------
  try {
    const ready = await prisma.evidenceExchangePackage.findMany({
      where: { state: "READY", createdAt: { gte: new Date(nowMs - 7 * 24 * 3600 * 1000) } },
      select: { id: true, teamId: true },
      orderBy: { createdAt: "desc" },
      take: DETECT_LIMIT,
    });
    for (const pkg of ready) {
      if (!pkg.teamId) continue;
      const r = await enqueueAutomationTrigger(prisma, {
        teamId: pkg.teamId,
        triggerType: "PACKAGE_READY",
        targetType: "exchange_package",
        targetId: pkg.id,
        sourceEventId: `package.ready:${pkg.id}`,
        context: { state: "READY" },
      });
      out.packageReady += r.enqueued;
    }
  } catch {
    /* as above */
  }

  return out;
}
