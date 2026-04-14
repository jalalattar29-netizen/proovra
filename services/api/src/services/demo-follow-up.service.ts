import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import { getEmailService } from "./email.service.js";
import { getDemoRequestQuickLinks } from "./demo-request-links.service.js";

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

  await emailService.sendDemoRequestFollowUp({
    to: item.workEmail,
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