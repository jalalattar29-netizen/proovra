import * as prismaPkg from "@prisma/client";
import {
  AMBIGUOUS_ERROR_CODE,
  AMBIGUOUS_RETRY_BACKOFF_MS,
  outcomeCode,
  type EmailDeliveryOutcome,
} from "@proovra/shared-runtime";

import { prisma } from "../db.js";
import { getEmailService } from "./email.service.js";
import { getDemoRequestQuickLinks } from "./demo-request-links.service.js";

/** `eventType` under which demo follow-up attempts are recorded. */
export const DEMO_FOLLOW_UP_EVENT_TYPE = "demo_request_follow_up";

export type InitialRoutingResult = {
  routingTarget: prismaPkg.DemoRoutingTarget;
  routingReason: string;
  routedAt: Date;
};

export type InitialFollowUpResult = {
  followUpStatus: prismaPkg.DemoFollowUpStatus;
  followUpStep: number;
  nextFollowUpAt: Date | null;
};

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function firstNameFromFullName(fullName: string): string {
  const trimmed = fullName.trim();
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

export function buildInitialDemoRouting(input: {
  leadTrack: prismaPkg.DemoLeadTrack;
  recommendedAction: prismaPkg.DemoRecommendedAction;
  sourcePath?: string | null;
}): InitialRoutingResult {
  const sourcePath = (input.sourcePath ?? "").toLowerCase();

  if (
    input.leadTrack === prismaPkg.DemoLeadTrack.ENTERPRISE ||
    input.recommendedAction ===
      prismaPkg.DemoRecommendedAction.route_enterprise ||
    sourcePath.includes("/contact-sales")
  ) {
    return {
      routingTarget: prismaPkg.DemoRoutingTarget.ENTERPRISE_DESK,
      routingReason: "enterprise_routing",
      routedAt: new Date(),
    };
  }

  if (
    input.recommendedAction === prismaPkg.DemoRecommendedAction.offer_demo &&
    input.leadTrack === prismaPkg.DemoLeadTrack.SALES
  ) {
    return {
      routingTarget: prismaPkg.DemoRoutingTarget.AUTO_BOOKING,
      routingReason: "high_intent_auto_booking",
      routedAt: new Date(),
    };
  }

  if (input.recommendedAction === prismaPkg.DemoRecommendedAction.offer_demo) {
    return {
      routingTarget: prismaPkg.DemoRoutingTarget.MANUAL_SALES,
      routingReason: "qualified_demo_offer",
      routedAt: new Date(),
    };
  }

  return {
    routingTarget: prismaPkg.DemoRoutingTarget.AUTO_RESOURCES,
    routingReason: "resource_only_routing",
    routedAt: new Date(),
  };
}

export function buildInitialDemoFollowUp(input: {
  isSpam: boolean;
  recommendedAction: prismaPkg.DemoRecommendedAction;
}): InitialFollowUpResult {
  if (input.isSpam) {
    return {
      followUpStatus: prismaPkg.DemoFollowUpStatus.STOPPED,
      followUpStep: 0,
      nextFollowUpAt: null,
    };
  }

  if (
    input.recommendedAction ===
    prismaPkg.DemoRecommendedAction.route_enterprise
  ) {
    return {
      followUpStatus: prismaPkg.DemoFollowUpStatus.ACTIVE,
      followUpStep: 0,
      nextFollowUpAt: addHours(new Date(), 48),
    };
  }

  return {
    followUpStatus: prismaPkg.DemoFollowUpStatus.ACTIVE,
    followUpStep: 0,
    nextFollowUpAt: addHours(new Date(), 24),
  };
}

function nextFollowUpAtForStep(step: 1 | 2 | 3): Date | null {
  if (step === 1) return addHours(new Date(), 72);
  if (step === 2) return addHours(new Date(), 24 * 7);
  return null;
}

function templateKeyForStep(step: 1 | 2 | 3): string {
  if (step === 1) return "followup_day_1";
  if (step === 2) return "followup_day_3";
  return "followup_day_7";
}

function isClosedStatus(status: prismaPkg.DemoRequestStatus): boolean {
  return (
    status === prismaPkg.DemoRequestStatus.QUALIFIED ||
    status === prismaPkg.DemoRequestStatus.REJECTED ||
    status === prismaPkg.DemoRequestStatus.ARCHIVED
  );
}

export async function sendDemoFollowUpById(params: {
  demoRequestId: string;
  actorUserId?: string | null;
  forceStep?: 1 | 2 | 3;
}) {
  const item = await prisma.demoRequest.findUnique({
    where: { id: params.demoRequestId },
    select: {
      id: true,
      fullName: true,
      workEmail: true,
      status: true,
      isSpam: true,
      followUpStatus: true,
      followUpStep: true,
      reviewedAt: true,
      reviewedByUserId: true,
      contactedAt: true,
      contactedByUserId: true,
      firstRespondedAt: true,
    },
  });

  if (!item) {
    throw new Error("DEMO_REQUEST_NOT_FOUND");
  }

  if (item.isSpam) {
    throw new Error("DEMO_REQUEST_SPAM_BLOCKED");
  }

  if (isClosedStatus(item.status)) {
    throw new Error("FOLLOW_UP_NOT_ALLOWED_FOR_CLOSED_STATUS");
  }

  if (
    item.followUpStatus === prismaPkg.DemoFollowUpStatus.STOPPED ||
    item.followUpStatus === prismaPkg.DemoFollowUpStatus.COMPLETED ||
    item.followUpStatus === prismaPkg.DemoFollowUpStatus.REPLIED
  ) {
    throw new Error("FOLLOW_UP_NOT_ALLOWED");
  }

  const computedStep = params.forceStep ?? ((item.followUpStep ?? 0) + 1);

  if (computedStep < 1 || computedStep > 3) {
    throw new Error("FOLLOW_UP_STEP_INVALID");
  }

  const nextStep = computedStep as 1 | 2 | 3;

  if ((item.followUpStep ?? 0) > 0 && nextStep < (item.followUpStep as number)) {
    throw new Error("FOLLOW_UP_STEP_BACKWARD_NOT_ALLOWED");
  }

  const emailService = getEmailService();
  if (!emailService.isConfigured()) {
    throw new Error("EMAIL_NOT_CONFIGURED");
  }

  const quickLinks = getDemoRequestQuickLinks(item.workEmail);

  // PHASE 12 POINT 5 — the durable delivery-attempt record.
  //
  // Created BEFORE the provider call so a crash mid-send is observable rather
  // than invisible, and so an ambiguous outcome has somewhere honest to live.
  // A DemoRequest is a PROSPECT record with no workspace, so `teamId` is null:
  // there is no tenant to attribute the attempt to and none is invented.
  const attemptRow = await prisma.notificationDelivery.create({
    data: {
      teamId: null,
      eventType: DEMO_FOLLOW_UP_EVENT_TYPE,
      channel: "EMAIL",
      provider: "RESEND",
      recipient: item.workEmail,
      status: "PENDING",
      templateKey: templateKeyForStep(nextStep),
      nextAttemptAtUtc: new Date(Date.now() + FOLLOW_UP_CLAIM_LEASE_MS),
      metadata: {
        demoRequestId: item.id,
        step: nextStep,
      },
    },
    select: { id: true },
  });

  const outcome = await emailService.sendDemoRequestFollowUp({
    to: item.workEmail,
    demoRequestId: item.id,
    fullName: firstNameFromFullName(item.fullName),
    step: nextStep,
    sampleReportUrl: quickLinks.sampleReportUrl,
    verificationDemoUrl: quickLinks.verificationDemoUrl,
    methodologyUrl: quickLinks.methodologyUrl,
    pricingUrl: quickLinks.pricingUrl,
    bookingUrl: quickLinks.bookingUrl,
    requestDemoUrl: quickLinks.requestDemoUrl,
    contactSalesUrl: quickLinks.contactSalesUrl,
  });

  // PHASE 12 POINT 5 — the outcome now DECIDES whether the step advanced.
  //
  // It used to be discarded. The old code awaited the send and advanced the
  // step unconditionally, and the send itself returned the provider SDK's
  // `{ data, error }` shape — so a rejected message resolved successfully and
  // the prospect was recorded as having received a follow-up they never got.
  // Only an acknowledged send may advance the step; everything else leaves the
  // request retryable behind its lease.
  //
  // The retry is not a blind resend. `sendDemoRequestFollowUp` derives its
  // provider idempotency key from (durable request id, step), both unchanged
  // across attempts, so a retry after an ambiguous outcome reaches the
  // provider as the SAME message and is collapsed rather than delivered twice.
  await recordFollowUpAttemptOutcome(attemptRow.id, outcome);
  if (outcome.kind !== "acknowledged") {
    throw new Error(`FOLLOW_UP_NOT_ACKNOWLEDGED:${outcomeCode(outcome)}`);
  }

  const now = new Date();
  const nextAt = nextFollowUpAtForStep(nextStep);
  const completed = nextStep >= 3 || nextAt == null;

  const nextStatus =
    item.status === prismaPkg.DemoRequestStatus.NEW ||
    item.status === prismaPkg.DemoRequestStatus.REVIEWED
      ? prismaPkg.DemoRequestStatus.CONTACTED
      : item.status;

  const updated = await prisma.demoRequest.update({
    where: { id: item.id },
    data: {
      followUpStep: nextStep,
      lastFollowUpSentAt: now,
      lastFollowUpTemplateKey: templateKeyForStep(nextStep),
      nextFollowUpAt: completed ? null : nextAt,
      followUpStatus: completed
        ? prismaPkg.DemoFollowUpStatus.COMPLETED
        : prismaPkg.DemoFollowUpStatus.ACTIVE,
      contactedAt: item.contactedAt ?? now,
      contactedByUserId: item.contactedByUserId ?? params.actorUserId ?? null,
      firstRespondedAt: item.firstRespondedAt ?? now,
      reviewedAt: item.reviewedAt ?? now,
      reviewedByUserId: item.reviewedByUserId ?? params.actorUserId ?? null,
      status: nextStatus,
    },
    select: {
      id: true,
      status: true,
      // PHASE 5 — the caller audits this send, and an audit row whose target
      // is only a UUID is one an operator cannot act on. `organization` is the
      // account name; `workEmail` is deliberately NOT selected, because the
      // audit trail is append-only and must not accumulate addresses.
      organization: true,
      followUpStep: true,
      followUpStatus: true,
      nextFollowUpAt: true,
      lastFollowUpSentAt: true,
      lastFollowUpTemplateKey: true,
      contactedAt: true,
      contactedByUserId: true,
      firstRespondedAt: true,
      reviewedAt: true,
      reviewedByUserId: true,
      updatedAt: true,
    },
  });

  return updated;
}

/**
 * Project one transport outcome onto the durable attempt row.
 *
 * The same five-way mapping the MFA digest uses, for the same reason: an
 * ambiguous outcome must be storable as ambiguous. `RETRY_SCHEDULED` carrying
 * the canonical `provider_ack_unknown` code says "the provider may hold this
 * message" — which is neither delivered nor failed, and is the only truthful
 * thing to write.
 */
async function recordFollowUpAttemptOutcome(
  attemptId: string,
  outcome: EmailDeliveryOutcome,
): Promise<void> {
  const now = new Date();
  switch (outcome.kind) {
    case "acknowledged":
      await prisma.notificationDelivery.update({
        where: { id: attemptId },
        data: {
          status: "SENT",
          providerMessageId: outcome.providerMessageId,
          sentAtUtc: now,
          nextAttemptAtUtc: null,
        },
      });
      return;
    case "not_configured":
      await prisma.notificationDelivery.update({
        where: { id: attemptId },
        data: {
          status: "SKIPPED",
          errorCode: "not_configured",
          nextAttemptAtUtc: null,
        },
      });
      return;
    case "permanent":
      await prisma.notificationDelivery.update({
        where: { id: attemptId },
        data: {
          status: "FAILED",
          errorCode: outcome.errorCode,
          failedAtUtc: now,
          nextAttemptAtUtc: null,
        },
      });
      return;
    case "retryable":
      await prisma.notificationDelivery.update({
        where: { id: attemptId },
        data: {
          status: "RETRY_SCHEDULED",
          errorCode: outcome.errorCode,
          nextAttemptAtUtc: now,
        },
      });
      return;
    case "ambiguous":
      await prisma.notificationDelivery.update({
        where: { id: attemptId },
        data: {
          status: "RETRY_SCHEDULED",
          errorCode: AMBIGUOUS_ERROR_CODE,
          errorMessage: outcome.errorCode,
          nextAttemptAtUtc: new Date(now.getTime() + AMBIGUOUS_RETRY_BACKOFF_MS),
        },
      });
      return;
  }
}

/**
 * How long a claimed follow-up is held before another tick may retry it.
 *
 * Ten minutes: long enough that a slow provider call cannot be double-sent,
 * short enough that a crashed sender does not park the prospect until their
 * next scheduled step.
 */
export const FOLLOW_UP_CLAIM_LEASE_MS = 10 * 60 * 1000;

export async function processDueDemoFollowUps(params?: {
  limit?: number;
  actorUserId?: string | null;
}) {
  const limit = Math.max(1, Math.min(params?.limit ?? 25, 100));

  const dueItems = await prisma.demoRequest.findMany({
    where: {
      isSpam: false,
      followUpStatus: prismaPkg.DemoFollowUpStatus.ACTIVE,
      nextFollowUpAt: { lte: new Date() },
      status: {
        in: [
          prismaPkg.DemoRequestStatus.NEW,
          prismaPkg.DemoRequestStatus.REVIEWED,
          prismaPkg.DemoRequestStatus.CONTACTED,
        ],
      },
    },
    orderBy: [{ nextFollowUpAt: "asc" }, { createdAt: "asc" }],
    take: limit,
    select: { id: true },
  });

  const results: Array<{
    id: string;
    ok: boolean;
    error?: string;
  }> = [];

  for (const item of dueItems) {
    // PHASE 12 POINT 5 — THE CLAIM.
    //
    // This loop had none. Two ticks — the worker's interval scheduler and an
    // operator-triggered run, or two API instances — both selected the same
    // due request and both called the provider, so a prospect received the
    // same follow-up twice. The row's own `nextFollowUpAt` is the lease: the
    // conditional UPDATE pushes it forward, and only the caller that matches
    // exactly one row may send.
    //
    // The lease is deliberately short relative to the follow-up cadence: a
    // caller that dies mid-send leaves the request recoverable on the next
    // tick rather than stranded until its next scheduled step.
    const claim = await prisma.demoRequest.updateMany({
      where: {
        id: item.id,
        followUpStatus: prismaPkg.DemoFollowUpStatus.ACTIVE,
        nextFollowUpAt: { lte: new Date() },
      },
      data: {
        nextFollowUpAt: new Date(Date.now() + FOLLOW_UP_CLAIM_LEASE_MS),
      },
    });
    if (claim.count !== 1) continue;

    try {
      await sendDemoFollowUpById({
        demoRequestId: item.id,
        actorUserId: params?.actorUserId ?? null,
      });

      results.push({ id: item.id, ok: true });
    } catch (error) {
      results.push({
        id: item.id,
        ok: false,
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      });
    }
  }

  return {
    processed: results.length,
    sent: results.filter((x) => x.ok).length,
    failed: results.filter((x) => !x.ok).length,
    items: results,
  };
}