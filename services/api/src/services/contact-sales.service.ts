// Contact Sales lead capture — sibling to demo-request.service.ts.
//
// Flow:
//   1. Validate the payload server-side (separate schema from the
//      browser-facing one).
//   2. Light spam scoring (honeypot + disposable email + recent dup).
//   3. Create the row in `contact_sales_requests`. The row is NEVER
//      deleted if email or webhook sends fail.
//   4. Best-effort operator notification + visitor auto-reply via Resend.
//      Emails are gated by `getEmailService().isConfigured()`; when not
//      configured the row is still saved with `emailSentAt = null` so
//      operators can replay later.
//   5. Update `emailSentAt` / `webhookSentAt` timestamps on success.
//   6. Return a structured response with the new record id.

import { createHash } from "node:crypto";
import * as prismaPkg from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { AppError, ErrorCode } from "../errors.js";
import { getEmailService } from "./email.service.js";
import { getDemoRequestQuickLinks } from "./demo-request-links.service.js";

const createContactSalesSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  workEmail: z.string().trim().email().max(320),
  organization: z.string().trim().min(1).max(180),
  jobTitle: z.string().trim().max(120).optional().nullable(),
  country: z.string().trim().max(120).optional().nullable(),
  teamSize: z.string().trim().max(64).optional().nullable(),

  discussionTopic: z.string().trim().min(1).max(64),
  stage: z.string().trim().min(1).max(64),
  currentChallenge: z.string().trim().min(10).max(5000),
  deploymentTimeline: z.string().trim().max(64).optional().nullable(),
  estimatedUsers: z.string().trim().max(64).optional().nullable(),
  additionalDetails: z.string().trim().max(5000).optional().nullable(),

  source: z.string().trim().max(120).optional().nullable(),
  sourcePage: z.string().trim().max(120).optional().nullable(),
  sourcePath: z.string().trim().max(512).optional().nullable(),
  referrer: z.string().trim().max(2048).optional().nullable(),
  utmSource: z.string().trim().max(160).optional().nullable(),
  utmMedium: z.string().trim().max(160).optional().nullable(),
  utmCampaign: z.string().trim().max(160).optional().nullable(),
  utmTerm: z.string().trim().max(160).optional().nullable(),
  utmContent: z.string().trim().max(160).optional().nullable(),

  website: z.string().trim().max(300).optional().nullable(),
});

export type CreateContactSalesInput = z.infer<typeof createContactSalesSchema>;

export type CreateContactSalesContext = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

function envString(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeText(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function firstNameFromFullName(fullName: string): string {
  const trimmed = fullName.trim();
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

function inferPriority(input: {
  teamSize?: string | null;
  organization: string;
  stage: string;
  estimatedUsers?: string | null;
  deploymentTimeline?: string | null;
  isSpam: boolean;
}): prismaPkg.ContactSalesPriority {
  if (input.isSpam) return prismaPkg.ContactSalesPriority.LOW;

  const teamSize = (input.teamSize ?? "").toLowerCase();
  const estimated = (input.estimatedUsers ?? "").toLowerCase();
  const timeline = (input.deploymentTimeline ?? "").toLowerCase();
  const stage = input.stage.toLowerCase();
  const org = input.organization.toLowerCase();

  // Procurement / ready-to-deploy / 250+ user signals all bump to HIGH.
  if (
    stage.includes("procurement") ||
    stage.includes("ready") ||
    stage.includes("security-review") ||
    timeline.includes("this month") ||
    timeline.includes("1-3-months") ||
    estimated.includes("251") ||
    estimated.includes("1000") ||
    teamSize.includes("201") ||
    teamSize.includes("1000")
  ) {
    return prismaPkg.ContactSalesPriority.HIGH;
  }

  // Long-tail or planning stage → LOW.
  if (
    stage.includes("exploring") ||
    timeline.includes("6plus") ||
    timeline.includes("planning")
  ) {
    return prismaPkg.ContactSalesPriority.LOW;
  }

  // Enterprise org name signals → HIGH.
  const highSignals = [
    "enterprise",
    "global",
    "inc.",
    "ag",
    "holding",
    "corp.",
    "international",
  ];
  if (highSignals.some((s) => org.includes(s))) {
    return prismaPkg.ContactSalesPriority.HIGH;
  }

  return prismaPkg.ContactSalesPriority.NORMAL;
}

async function calculateSpam(
  input: CreateContactSalesInput,
  context: CreateContactSalesContext
): Promise<boolean> {
  if (input.website && input.website.trim()) return true;

  const email = normalizeEmail(input.workEmail);
  const emailDomain = email.split("@")[1] ?? "";
  const disposable = [
    "mailinator.com",
    "guerrillamail.com",
    "10minutemail.com",
    "temp-mail.org",
    "yopmail.com",
    "trashmail.com",
  ];
  if (disposable.includes(emailDomain)) return true;

  // Duplicate-window: count submissions from the same email in the
  // last 1h. Bumping this above 3 is treated as spam (auto-resubmit
  // from a script).
  const sinceMs = Date.now() - 60 * 60 * 1000;
  const recent = await prisma.contactSalesRequest.count({
    where: {
      workEmail: email,
      createdAt: { gte: new Date(sinceMs) },
    },
  });
  if (recent >= 3) return true;

  // IP-based hammer protection.
  if (context.ipAddress) {
    const sinceIpMs = Date.now() - 15 * 60 * 1000;
    const recentIp = await prisma.contactSalesRequest.count({
      where: {
        ipAddress: context.ipAddress,
        createdAt: { gte: new Date(sinceIpMs) },
      },
    });
    if (recentIp >= 5) return true;
  }

  return false;
}

function resolveNotificationEmail(): string {
  return (
    envString("CONTACT_SALES_NOTIFICATION_EMAIL") ??
    envString("DEMO_REQUEST_NOTIFICATION_EMAIL") ??
    envString("SUPPORT_EMAIL") ??
    "support@proovra.com"
  );
}

async function sendWebhookIfConfigured(
  payload: Record<string, unknown>
): Promise<boolean> {
  const url = envString("CONTACT_SALES_WEBHOOK_URL");
  if (!url) return false;

  const secret = envString("CONTACT_SALES_WEBHOOK_SECRET");
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret) {
    headers["x-contact-sales-signature"] = createHash("sha256")
      .update(`${secret}.${body}`)
      .digest("hex");
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
  });
  if (!response.ok) {
    throw new Error(`Contact-sales webhook failed: ${response.status}`);
  }
  return true;
}

export async function createContactSalesRequest(
  rawInput: unknown,
  context: CreateContactSalesContext = {}
) {
  const parsed = createContactSalesSchema.safeParse(rawInput);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      firstIssue?.message || "Invalid contact-sales payload"
    );
  }

  const input = parsed.data;
  const isSpam = await calculateSpam(input, context);

  const priority = inferPriority({
    teamSize: input.teamSize,
    organization: input.organization,
    stage: input.stage,
    estimatedUsers: input.estimatedUsers,
    deploymentTimeline: input.deploymentTimeline,
    isSpam,
  });

  // Persist FIRST. Email + webhook are best-effort downstream.
  const created = await prisma.contactSalesRequest.create({
    data: {
      fullName: input.fullName.trim(),
      workEmail: normalizeEmail(input.workEmail),
      organization: input.organization.trim(),
      jobTitle: normalizeText(input.jobTitle),
      country: normalizeText(input.country),
      teamSize: normalizeText(input.teamSize),
      discussionTopic: input.discussionTopic.trim(),
      stage: input.stage.trim(),
      currentChallenge: input.currentChallenge.trim(),
      deploymentTimeline: normalizeText(input.deploymentTimeline),
      estimatedUsers: normalizeText(input.estimatedUsers),
      additionalDetails: normalizeText(input.additionalDetails),

      source: normalizeText(input.source),
      sourcePage: normalizeText(input.sourcePage),
      sourcePath: normalizeText(input.sourcePath),
      referrer: normalizeText(input.referrer),
      utmSource: normalizeText(input.utmSource),
      utmMedium: normalizeText(input.utmMedium),
      utmCampaign: normalizeText(input.utmCampaign),
      utmTerm: normalizeText(input.utmTerm),
      utmContent: normalizeText(input.utmContent),

      status: prismaPkg.ContactSalesStatus.NEW,
      priority,
      isSpam,

      ipAddress: normalizeText(context.ipAddress),
      userAgent: normalizeText(context.userAgent),
    },
  });

  let emailSentAt: Date | null = null;
  let webhookSentAt: Date | null = null;

  const emailService = getEmailService();
  if (emailService.isConfigured()) {
    try {
      await emailService.sendContactSalesNotification({
        to: resolveNotificationEmail(),
        requestId: created.id,
        fullName: created.fullName,
        workEmail: created.workEmail,
        organization: created.organization,
        jobTitle: created.jobTitle,
        country: created.country,
        teamSize: created.teamSize,
        discussionTopic: created.discussionTopic,
        stage: created.stage,
        currentChallenge: created.currentChallenge,
        deploymentTimeline: created.deploymentTimeline,
        estimatedUsers: created.estimatedUsers,
        additionalDetails: created.additionalDetails,
        source: created.source,
        sourcePath: created.sourcePath,
        referrer: created.referrer,
        utmSource: created.utmSource,
        utmMedium: created.utmMedium,
        utmCampaign: created.utmCampaign,
        utmTerm: created.utmTerm,
        utmContent: created.utmContent,
        priority: created.priority,
      });
      emailSentAt = new Date();

      const autoReplyEnabled =
        (envString("CONTACT_SALES_AUTO_REPLY_ENABLED") ?? "true").toLowerCase() ===
        "true";
      if (autoReplyEnabled && !created.isSpam) {
        try {
          const quickLinks = getDemoRequestQuickLinks(created.workEmail);
          await emailService.sendContactSalesAutoReply({
            to: created.workEmail,
            fullName: firstNameFromFullName(created.fullName),
            sampleReportUrl: quickLinks.sampleReportUrl,
            verificationDemoUrl: quickLinks.verificationDemoUrl,
            methodologyUrl: quickLinks.methodologyUrl,
            pricingUrl: quickLinks.pricingUrl,
          });
        } catch (err) {
          // Auto-reply failure is non-fatal — operator email already sent.
          console.warn(
            JSON.stringify({
              tag: "contact_sales_auto_reply_failed",
              requestId: created.id,
              error:
                err instanceof Error ? err.message : String(err),
            })
          );
        }
      }
    } catch (err) {
      // Operator email failed. Row IS still persisted; ops can replay.
      console.warn(
        JSON.stringify({
          tag: "contact_sales_email_failed",
          requestId: created.id,
          error: err instanceof Error ? err.message : String(err),
        })
      );
      emailSentAt = null;
    }
  } else {
    console.warn(
      JSON.stringify({
        tag: "contact_sales_email_skipped",
        requestId: created.id,
        reason: "RESEND_API_KEY_not_configured",
      })
    );
  }

  try {
    const webhookDelivered = await sendWebhookIfConfigured({
      id: created.id,
      fullName: created.fullName,
      workEmail: created.workEmail,
      organization: created.organization,
      jobTitle: created.jobTitle,
      country: created.country,
      teamSize: created.teamSize,
      discussionTopic: created.discussionTopic,
      stage: created.stage,
      currentChallenge: created.currentChallenge,
      deploymentTimeline: created.deploymentTimeline,
      estimatedUsers: created.estimatedUsers,
      additionalDetails: created.additionalDetails,
      status: created.status,
      priority: created.priority,
      isSpam: created.isSpam,
      createdAt: created.createdAt.toISOString(),
      source: created.source,
      sourcePath: created.sourcePath,
    });
    if (webhookDelivered) webhookSentAt = new Date();
  } catch (err) {
    console.warn(
      JSON.stringify({
        tag: "contact_sales_webhook_failed",
        requestId: created.id,
        error: err instanceof Error ? err.message : String(err),
      })
    );
    webhookSentAt = null;
  }

  const updated = await prisma.contactSalesRequest.update({
    where: { id: created.id },
    data: {
      emailSentAt,
      webhookSentAt,
    },
  });

  return {
    ok: true,
    message: "Contact-sales inquiry received.",
    data: {
      id: updated.id,
      status: updated.status,
      priority: updated.priority,
      isSpam: updated.isSpam,
      emailDispatched: emailSentAt !== null,
      createdAt: updated.createdAt,
    },
  };
}
