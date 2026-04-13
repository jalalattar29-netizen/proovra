import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db.js";
import { AppError, ErrorCode } from "../errors.js";
import { getEmailService } from "./email.service.js";

const createDemoRequestSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  workEmail: z.string().trim().email().max(320),
  organization: z.string().trim().max(180).optional().nullable(),
  jobTitle: z.string().trim().max(120).optional().nullable(),
  country: z.string().trim().max(120).optional().nullable(),
  teamSize: z.string().trim().max(64).optional().nullable(),
  useCase: z.string().trim().min(10).max(5000),
  message: z.string().trim().max(5000).optional().nullable(),

  source: z.string().trim().max(120).optional().nullable(),
  sourcePath: z.string().trim().max(512).optional().nullable(),
  referrer: z.string().trim().max(2048).optional().nullable(),
  utmSource: z.string().trim().max(160).optional().nullable(),
  utmMedium: z.string().trim().max(160).optional().nullable(),
  utmCampaign: z.string().trim().max(160).optional().nullable(),
  utmTerm: z.string().trim().max(160).optional().nullable(),
  utmContent: z.string().trim().max(160).optional().nullable(),

  website: z.string().trim().max(300).optional().nullable(),
});

export type CreateDemoRequestInput = z.infer<typeof createDemoRequestSchema>;

export type CreateDemoRequestContext = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function containsUrl(text: string): boolean {
  return /(https?:\/\/|www\.)/i.test(text);
}

function countUrls(text: string): number {
  const matches = text.match(/(https?:\/\/|www\.)/gi);
  return matches ? matches.length : 0;
}

function countUppercaseRatio(text: string): number {
  const letters = text.match(/[A-Za-z]/g) ?? [];
  if (letters.length === 0) return 0;
  const upper = letters.filter((c) => c === c.toUpperCase()).length;
  return upper / letters.length;
}

function inferPriority(input: {
  teamSize?: string | null;
  organization?: string | null;
  jobTitle?: string | null;
  useCase: string;
}): "LOW" | "NORMAL" | "HIGH" {
  const teamSize = (input.teamSize ?? "").toLowerCase();
  const org = (input.organization ?? "").toLowerCase();
  const job = (input.jobTitle ?? "").toLowerCase();
  const useCase = input.useCase.toLowerCase();

  const highSignals = [
    "enterprise",
    "legal",
    "compliance",
    "claims",
    "investigation",
    "insurer",
    "insurance",
    "audit",
    "forensics",
  ];

  if (
    teamSize.includes("100") ||
    teamSize.includes("200") ||
    teamSize.includes("500") ||
    teamSize.includes("1000") ||
    highSignals.some((s) => org.includes(s) || job.includes(s) || useCase.includes(s))
  ) {
    return "HIGH";
  }

  return "NORMAL";
}

async function calculateSpamAssessment(
  input: CreateDemoRequestInput,
  context: CreateDemoRequestContext
): Promise<{
  spamScore: number;
  isSpam: boolean;
  spamReasons: string[];
}> {
  let spamScore = 0;
  const reasons: string[] = [];

  if (input.website && input.website.trim()) {
    spamScore += 100;
    reasons.push("honeypot_filled");
  }

  const email = normalizeEmail(input.workEmail);
  const emailDomain = email.split("@")[1] ?? "";

  const disposableDomains = [
    "mailinator.com",
    "guerrillamail.com",
    "10minutemail.com",
    "temp-mail.org",
    "yopmail.com",
    "trashmail.com",
  ];

  if (disposableDomains.includes(emailDomain)) {
    spamScore += 40;
    reasons.push("disposable_email_domain");
  }

  const combinedText = `${input.fullName} ${input.organization ?? ""} ${input.useCase} ${input.message ?? ""}`.trim();

  if (containsUrl(combinedText)) {
    const links = countUrls(combinedText);
    if (links >= 2) {
      spamScore += 25;
      reasons.push("multiple_links");
    } else {
      spamScore += 10;
      reasons.push("contains_link");
    }
  }

  if (countUppercaseRatio(combinedText) > 0.65 && combinedText.length > 30) {
    spamScore += 15;
    reasons.push("excessive_uppercase");
  }

  if (/bitcoin|casino|forex|seo|backlinks|viagra|gambling|loan/i.test(combinedText)) {
    spamScore += 35;
    reasons.push("spam_keywords");
  }

  const duplicateWindowHours = envNumber("DEMO_REQUEST_DUPLICATE_WINDOW_HOURS", 24);
  const duplicateSince = new Date(Date.now() - duplicateWindowHours * 60 * 60 * 1000);

  const duplicateCount = await prisma.demoRequest.count({
    where: {
      workEmail: email,
      createdAt: { gte: duplicateSince },
    },
  });

  if (duplicateCount >= 1) {
    spamScore += 25;
    reasons.push("recent_duplicate_email");
  }

  if (context.ipAddress) {
    const rateLimitWindowMs = envNumber("DEMO_REQUEST_RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000);
    const recentSince = new Date(Date.now() - rateLimitWindowMs);

    const recentByIp = await prisma.demoRequest.count({
      where: {
        ipAddress: context.ipAddress,
        createdAt: { gte: recentSince },
      },
    });

    const maxPerIp = envNumber("DEMO_REQUEST_RATE_LIMIT_MAX_PER_IP", 5);

    if (recentByIp >= maxPerIp) {
      spamScore += 60;
      reasons.push("ip_rate_limit_exceeded");
    } else if (recentByIp >= Math.max(2, Math.floor(maxPerIp / 2))) {
      spamScore += 20;
      reasons.push("high_recent_ip_activity");
    }
  }

  const isSpam = spamScore >= 60;
  return { spamScore, isSpam, spamReasons: reasons };
}

async function sendWebhookIfConfigured(payload: Record<string, unknown>): Promise<boolean> {
  const url = envString("DEMO_REQUEST_WEBHOOK_URL");
  if (!url) return false;

  const secret = envString("DEMO_REQUEST_WEBHOOK_SECRET");
  const body = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (secret) {
    headers["x-demo-request-signature"] = sha256(`${secret}.${body}`);
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    throw new Error(`Demo request webhook failed with status ${response.status}`);
  }

  return true;
}

export async function createDemoRequest(
  rawInput: unknown,
  context: CreateDemoRequestContext = {}
) {
  const parsed = createDemoRequestSchema.safeParse(rawInput);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      firstIssue?.message || "Invalid demo request payload"
    );
  }

  const input = parsed.data;

  if (!input.fullName || !input.workEmail || !input.useCase) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Missing required fields");
  }

  const spam = await calculateSpamAssessment(input, context);
  const priority = inferPriority(input);

  const created = await prisma.demoRequest.create({
    data: {
      fullName: input.fullName.trim(),
      workEmail: normalizeEmail(input.workEmail),
      organization: normalizeText(input.organization),
      jobTitle: normalizeText(input.jobTitle),
      country: normalizeText(input.country),
      teamSize: normalizeText(input.teamSize),
      useCase: input.useCase.trim(),
      message: normalizeText(input.message),

      source: normalizeText(input.source),
      sourcePath: normalizeText(input.sourcePath),
      referrer: normalizeText(input.referrer),
      utmSource: normalizeText(input.utmSource),
      utmMedium: normalizeText(input.utmMedium),
      utmCampaign: normalizeText(input.utmCampaign),
      utmTerm: normalizeText(input.utmTerm),
      utmContent: normalizeText(input.utmContent),

      priority,
      spamScore: spam.spamScore,
      spamReasons: spam.spamReasons,
      isSpam: spam.isSpam,

      ipAddress: normalizeText(context.ipAddress),
      userAgent: normalizeText(context.userAgent),
    },
  });

  const emailService = getEmailService();
  const notificationEmail =
    envString("DEMO_REQUEST_NOTIFICATION_EMAIL") ??
    envString("SUPPORT_EMAIL") ??
    "support@proovra.com";

  let emailSentAt: Date | null = null;
  let autoReplySentAt: Date | null = null;
  let webhookSentAt: Date | null = null;

  if (emailService.isConfigured()) {
    await emailService.sendDemoRequestNotification({
      to: notificationEmail,
      requestId: created.id,
      fullName: created.fullName,
      workEmail: created.workEmail,
      organization: created.organization,
      jobTitle: created.jobTitle,
      country: created.country,
      teamSize: created.teamSize,
      useCase: created.useCase,
      message: created.message,
      source: created.source,
      sourcePath: created.sourcePath,
      referrer: created.referrer,
      utmSource: created.utmSource,
      utmMedium: created.utmMedium,
      utmCampaign: created.utmCampaign,
      utmTerm: created.utmTerm,
      utmContent: created.utmContent,
      spamScore: created.spamScore,
      isSpam: created.isSpam,
    });
    emailSentAt = new Date();

    const autoReplyEnabled = (envString("DEMO_REQUEST_AUTO_REPLY_ENABLED") ?? "true").toLowerCase() === "true";
    if (autoReplyEnabled && !created.isSpam) {
      await emailService.sendDemoRequestAutoReply({
        to: created.workEmail,
        fullName: created.fullName,
      });
      autoReplySentAt = new Date();
    }
  }

  const webhookPayload = {
    id: created.id,
    fullName: created.fullName,
    workEmail: created.workEmail,
    organization: created.organization,
    jobTitle: created.jobTitle,
    country: created.country,
    teamSize: created.teamSize,
    useCase: created.useCase,
    message: created.message,
    source: created.source,
    sourcePath: created.sourcePath,
    referrer: created.referrer,
    utmSource: created.utmSource,
    utmMedium: created.utmMedium,
    utmCampaign: created.utmCampaign,
    utmTerm: created.utmTerm,
    utmContent: created.utmContent,
    priority: created.priority,
    spamScore: created.spamScore,
    isSpam: created.isSpam,
    createdAt: created.createdAt.toISOString(),
  };

  try {
    const webhookDelivered = await sendWebhookIfConfigured(webhookPayload);
    if (webhookDelivered) webhookSentAt = new Date();
  } catch {
    webhookSentAt = null;
  }

  const updated = await prisma.demoRequest.update({
    where: { id: created.id },
    data: {
      emailSentAt,
      autoReplySentAt,
      webhookSentAt,
    },
  });

  return {
    ok: true,
    message: "Demo request received.",
    data: {
      id: updated.id,
      status: updated.status,
      priority: updated.priority,
      isSpam: updated.isSpam,
      createdAt: updated.createdAt,
    },
  };
}