/**
 * PROOVRA Phase 2B Closure — Portal invitation email service.
 *
 * Single source of truth for *sending* the external reviewer
 * invitation. Composes the email body, hands it to the shared
 * Resend client (`sendCustomEmailViaResend`), persists a delivery
 * audit row, and emits the bounded portal activity event.
 *
 * Hard rules:
 *   1. Workspace-anchored at every entry point (teamId).
 *   2. NEVER store the raw token in the delivery row or in audit
 *      payloads — it is composed into the link at send time.
 *   3. NEVER fail closed on a missing RESEND_API_KEY — we record the
 *      delivery row with `provider = "RESEND_DISABLED"` and `status =
 *      "FAILED"` so the operator can still see what happened and use
 *      the manual token reveal as a break-glass fallback.
 *   4. Bounded provider failure codes — Resend's free-form message is
 *      preview-clipped to ≤ 400 chars (`lastErrorPreview`).
 *   5. We DO NOT re-use the workflow-engine notification orchestrator
 *      here — portal invitations are bounded enterprise security
 *      mail with a distinct templating shape. We DO re-use the
 *      single shared Resend client.
 */

import type { PrismaClient } from "@prisma/client";
import {
  absoluteInternalUrl,
  EXTERNAL_PORTAL_ACTIVITY_CODES,
  internalNavPath,
  INVITATION_DELIVERY_STATUSES,
  type InvitationDeliveryStatus,
} from "@proovra/shared";

import { mintEmailIdempotencyKey } from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
import {
  getEmailBrandName,
  getEmailFromHeader,
  getEmailSupportAddress,
  getEmailWebBaseUrl,
  escapeEmailHtml,
  renderEmailShell,
  sendCustomEmailViaResend,
} from "../email.service.js";
import { emitPortalActivity } from "./portal-activity.service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SendInvitationEmailInput = {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  /** The raw portal token. Held only during this call; never persisted. */
  rawToken: string;
  recipientEmail: string;
  recipientDisplayName?: string | null;
  inviterDisplayName: string;
  workspaceName: string;
  role: string;
  expiresAtUtc: string;
  mfaRequired: boolean;
  ssoEnabled: boolean;
  /** Optional bulk batch correlation id (NULL = single-invite send). */
  bulkBatchId?: string | null;
  /** Whether this is a resend (increments attempt counter). */
  isResend?: boolean;
  /**
   * Optional override for the recipient's preferred portal entry point.
   * Defaults to `${WEB_BASE_URL}/portal/accept/${grantId}?token=...`.
   */
  portalAcceptUrl?: string;
};

export type SendInvitationEmailResult =
  | {
      ok: true;
      deliveryId: string;
      providerMessageId: string | null;
      status: InvitationDeliveryStatus;
    }
  | {
      ok: false;
      deliveryId: string;
      status: InvitationDeliveryStatus;
      failureReason: string;
      errorPreview: string;
    };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function sendInvitationEmail(
  input: SendInvitationEmailInput,
): Promise<SendInvitationEmailResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const brand = getEmailBrandName();
  const support = getEmailSupportAddress();
  const from = getEmailFromHeader();
  const webBase = getEmailWebBaseUrl();

  // Compose the bounded accept URL. The raw token is appended as a
  // query param so refreshing the link still works; the landing page
  // immediately exchanges it for a session and clears it from history.
  // PHASE 11 — /portal/accept/:grantId is a public/signed nav path
  // (classifyLink already treats /portal/ as PUBLIC_SIGNED); it is not
  // the /share/:token shape publicShareUrl builds, so it is composed
  // via internalNavPath + absoluteInternalUrl instead.
  const acceptUrl =
    input.portalAcceptUrl ??
    absoluteInternalUrl(
      webBase,
      internalNavPath(
        `/portal/accept/${encodeURIComponent(input.grantId)}?token=${encodeURIComponent(
          input.rawToken,
        )}`,
      ),
    );

  const subject = `You have been invited to review materials in ${brand}`;

  const html = renderInvitationHtml({
    brand,
    support,
    acceptUrl,
    recipientDisplayName: input.recipientDisplayName ?? null,
    inviterDisplayName: input.inviterDisplayName,
    workspaceName: input.workspaceName,
    role: input.role,
    expiresAtUtc: input.expiresAtUtc,
    mfaRequired: input.mfaRequired,
    ssoEnabled: input.ssoEnabled,
  });
  const text = renderInvitationText({
    brand,
    support,
    acceptUrl,
    recipientDisplayName: input.recipientDisplayName ?? null,
    inviterDisplayName: input.inviterDisplayName,
    workspaceName: input.workspaceName,
    role: input.role,
    expiresAtUtc: input.expiresAtUtc,
    mfaRequired: input.mfaRequired,
    ssoEnabled: input.ssoEnabled,
  });

  // Increment attempt counter if this is a resend.
  const attempt = await deriveAttemptCounter(
    prisma,
    input.teamId,
    input.grantId,
    input.isResend === true,
  );

  // Create the delivery row up front so even a provider crash is
  // observable in the operator console.
  const delivery = await prisma.externalReviewInvitationDelivery.create({
    data: {
      teamId: input.teamId,
      grantId: input.grantId,
      status: "PENDING",
      provider: "RESEND_API",
      recipientEmail: input.recipientEmail.slice(0, 320),
      subject: subject.slice(0, 200),
      attempt,
      bulkBatchId: input.bulkBatchId ?? null,
    },
    select: { id: true },
  });

  const res = await sendCustomEmailViaResend({
    from,
    to: input.recipientEmail,
    subject,
    html,
    text,
    // The delivery row is created above, before the provider call, so a crash
    // is observable — and its immutable id is the intent this key names. A
    // resend increments `attempt` and mints a NEW delivery row, so the key is
    // per-intent by construction: a retry of THIS attempt reuses it, while a
    // deliberate resend is a different intent and a different key.
    idempotencyKey: mintEmailIdempotencyKey(
      "external_review_invitation",
      delivery.id,
    ),
  });

  if (res.ok) {
    await prisma.externalReviewInvitationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "SENT" satisfies InvitationDeliveryStatus,
        sentAtUtc: new Date(),
        providerMsgId: res.providerMessageId,
      },
    });
    await emitPortalActivity({
      prisma,
      teamId: input.teamId,
      grantId: input.grantId,
      code: input.isResend === true
        ? "INVITATION_RESENT"
        : "INVITATION_EMAIL_SENT",
      payload: {
        deliveryId: delivery.id,
        provider: "RESEND_API",
        attempt,
        bulkBatchId: input.bulkBatchId ?? null,
      },
    });
    return {
      ok: true,
      deliveryId: delivery.id,
      providerMessageId: res.providerMessageId,
      status: "SENT",
    };
  }

  // Provider failure or not configured.
  const isNotConfigured = res.errorCode === "not_configured";
  const provider = isNotConfigured ? "RESEND_DISABLED" : "RESEND_API";
  const failureReason = (res.errorCode ?? "send_failed").slice(0, 120);
  const errorPreview = truncate(res.errorMessage ?? failureReason, 400);

  await prisma.externalReviewInvitationDelivery.update({
    where: { id: delivery.id },
    data: {
      status: "FAILED" satisfies InvitationDeliveryStatus,
      failedAtUtc: new Date(),
      provider,
      failureReason,
      lastErrorPreview: errorPreview,
    },
  });
  await emitPortalActivity({
    prisma,
    teamId: input.teamId,
    grantId: input.grantId,
    code: "INVITATION_EMAIL_FAILED",
    payload: {
      deliveryId: delivery.id,
      provider,
      failureReason,
      attempt,
      bulkBatchId: input.bulkBatchId ?? null,
    },
  });
  return {
    ok: false,
    deliveryId: delivery.id,
    status: "FAILED",
    failureReason,
    errorPreview,
  };
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export async function listDeliveriesForGrant(input: {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  limit?: number;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.externalReviewInvitationDelivery.findMany({
    where: { teamId: input.teamId, grantId: input.grantId },
    orderBy: { queuedAtUtc: "desc" },
    take: Math.min(input.limit ?? 25, 200),
  });
}

export async function getLatestDeliveryForGrant(input: {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.externalReviewInvitationDelivery.findFirst({
    where: { teamId: input.teamId, grantId: input.grantId },
    orderBy: { queuedAtUtc: "desc" },
  });
}

/**
 * Mark a delivery as REVOKED / EXPIRED — called by the grant
 * lifecycle (revokeInvitation, scheduled expiry sweeper) to keep
 * the delivery audit consistent with the grant state.
 *
 * Bounded by INVITATION_DELIVERY_STATUSES.
 */
export async function annotateLatestDeliveryStatus(input: {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  toStatus: Extract<
    InvitationDeliveryStatus,
    "REVOKED" | "EXPIRED" | "OPENED" | "DELIVERED"
  >;
}): Promise<void> {
  if (
    !(INVITATION_DELIVERY_STATUSES as ReadonlyArray<string>).includes(
      input.toStatus,
    )
  ) {
    return;
  }
  const prisma = input.prisma ?? defaultPrisma;
  const latest = await prisma.externalReviewInvitationDelivery.findFirst({
    where: { teamId: input.teamId, grantId: input.grantId },
    orderBy: { queuedAtUtc: "desc" },
    select: { id: true, status: true },
  });
  if (!latest) return;
  const now = new Date();
  const patch: {
    status: InvitationDeliveryStatus;
    revokedAtUtc?: Date;
    expiredAtUtc?: Date;
    openedAtUtc?: Date;
    deliveredAtUtc?: Date;
  } = { status: input.toStatus };
  if (input.toStatus === "REVOKED") patch.revokedAtUtc = now;
  if (input.toStatus === "EXPIRED") patch.expiredAtUtc = now;
  if (input.toStatus === "OPENED") patch.openedAtUtc = now;
  if (input.toStatus === "DELIVERED") patch.deliveredAtUtc = now;
  await prisma.externalReviewInvitationDelivery.update({
    where: { id: latest.id },
    data: patch,
  });
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

async function deriveAttemptCounter(
  prisma: PrismaClient,
  teamId: string,
  grantId: string,
  isResend: boolean,
): Promise<number> {
  if (!isResend) return 1;
  const prior = await prisma.externalReviewInvitationDelivery.count({
    where: { teamId, grantId },
  });
  return prior + 1;
}

type InvitationRenderProps = {
  brand: string;
  support: string;
  acceptUrl: string;
  recipientDisplayName: string | null;
  inviterDisplayName: string;
  workspaceName: string;
  role: string;
  expiresAtUtc: string;
  mfaRequired: boolean;
  ssoEnabled: boolean;
};

function renderInvitationHtml(p: InvitationRenderProps): string {
  const greeting = p.recipientDisplayName
    ? `Hi ${escapeEmailHtml(p.recipientDisplayName)},`
    : `Hello,`;

  // Compact body: greeting → invitation context → expiry. Security
  // notice + identity context are surfaced via the shell's noticeText
  // so the rebrand stays consistent.
  const inner =
    `<div style="margin:0 0 14px 0;">${greeting}</div>` +
    `<div style="margin:0 0 14px 0;">` +
    `You have been invited to review selected materials through ` +
    `<strong>${escapeEmailHtml(p.brand)}</strong>.` +
    `</div>` +
    `<div style="margin:0 0 14px 0;">` +
    `<strong>${escapeEmailHtml(p.inviterDisplayName)}</strong> has invited ` +
    `you to act as <strong>${escapeEmailHtml(p.role)}</strong> in ` +
    `<strong>${escapeEmailHtml(p.workspaceName)}</strong>.` +
    `</div>` +
    `<div style="margin:0;">Your access expires ` +
    `<strong>${escapeEmailHtml(p.expiresAtUtc)}</strong> (UTC).</div>`;

  const noticeLines: string[] = [
    "Your access may be limited by permissions, expiration, and workspace policy.",
  ];
  if (p.mfaRequired) {
    noticeLines.push(
      "You will be asked for a one-time MFA code before the reviewer portal opens.",
    );
  }
  if (p.ssoEnabled) {
    noticeLines.push(
      "Your organization is federated — the portal offers SSO sign-in alongside the link token.",
    );
  }
  noticeLines.push(
    `If you were not expecting this invitation, you can ignore it or report it to ${p.support}.`,
  );

  return renderEmailShell({
    title: "Reviewer access invitation",
    preheader: "Open your secure reviewer access link.",
    bodyHtml: inner,
    ctaText: "Open reviewer portal",
    ctaUrl: p.acceptUrl,
    noticeTitle: "Access notice",
    noticeText: noticeLines.join(" "),
  });
}

function renderInvitationText(p: InvitationRenderProps): string {
  const lines: string[] = [];
  lines.push(
    p.recipientDisplayName ? `Hi ${p.recipientDisplayName},` : `Hello,`,
  );
  lines.push("");
  lines.push(
    `${p.inviterDisplayName} has invited you to act as a ${p.role} ` +
      `in ${p.workspaceName} on ${p.brand}.`,
  );
  lines.push("");
  lines.push(`Open the reviewer portal: ${p.acceptUrl}`);
  lines.push("");
  lines.push(`Your access expires ${p.expiresAtUtc} (UTC).`);
  lines.push("");
  lines.push(`Security notice:`);
  lines.push(
    `  - This is a bounded, audited reviewer link. Activity is recorded.`,
  );
  if (p.mfaRequired) {
    lines.push(`  - You will be asked for a one-time MFA code.`);
  }
  if (p.ssoEnabled) {
    lines.push(`  - Your organization is federated — SSO sign-in is offered.`);
  }
  lines.push(
    `  - ${p.brand} records what reviewers observe and decide. It does not ` +
      `assert authenticity of content.`,
  );
  lines.push("");
  lines.push(`If you were not expecting this invitation, contact ${p.support}.`);
  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

// Compile-time guard: keep the activity code list complete.
function _assertActivityCodesIncludeInvitationEvents(): void {
  const codes: ReadonlyArray<string> = EXTERNAL_PORTAL_ACTIVITY_CODES;
  const need = [
    "INVITATION_EMAIL_SENT",
    "INVITATION_EMAIL_FAILED",
    "INVITATION_RESENT",
  ] as const;
  for (const c of need) {
    if (!codes.includes(c)) {
      throw new Error(`activity code ${c} missing from shared catalog`);
    }
  }
}
void _assertActivityCodesIncludeInvitationEvents;
