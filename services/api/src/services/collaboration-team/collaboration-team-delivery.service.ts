/**
 * PROOVRA Phase 5 — Collaboration Team invite delivery wrapper.
 *
 * Thin orchestration layer that takes a CreatedInvite from
 * `collaboration-team.service.ts` and ships the raw token via the
 * appropriate channel:
 *
 *   - EMAIL → Resend, branded email shell (existing email.service.ts)
 *   - SMS   → Twilio messaging provider (existing twilio-provider.ts)
 *   - LINK  → no delivery; the route handler returns the rawToken/
 *             acceptUrl to the operator for copy-paste.
 *
 * Critical security rules:
 *
 *   1. The raw token NEVER touches a log, a metric, or an audit row.
 *      Only the masked email / masked phone preview is logged.
 *   2. The delivery result is persisted via
 *      `recordInviteDeliveryResult` (in collaboration-team.service.ts)
 *      so the dashboard can show SENT / FAILED / BOUNCED.
 *   3. On delivery failure, the invite remains PENDING — operators
 *      can `resend` from the UI.
 */

import { renderCollaborationTeamInvitationSmsBody } from "@proovra/shared";

import {
  deterministicEmailKey,
  getEmailFromHeader,
  sendCustomEmailViaResend,
  renderEmailShell,
  escapeEmailHtml,
  getEmailBrandName,
} from "../email.service.js";
import { enqueueOutboundMessage } from "../communications/communication.service.js";
import {
  recordInviteDeliveryResult,
  type CreatedInvite,
} from "./collaboration-team.service.js";

export type DeliveryContext = {
  invite: CreatedInvite;
  teamId: string;
  workspaceId: string;
  teamName: string;
  workspaceName: string;
  inviterDisplay: string;
  inviterEmail: string | null;
  inviterUserId: string;
  email?: string | null;
  phone?: string | null;
};

/**
 * Send the invite email via Resend. Returns true on apparent success.
 * Records delivery result on the invite row (best-effort; never throws).
 */
export async function sendCollaborationTeamInviteEmail(
  ctx: DeliveryContext,
): Promise<boolean> {
  if (!ctx.email) return false;
  const brand = getEmailBrandName();
  const subject = `${ctx.inviterDisplay} invited you to the "${ctx.teamName}" team`;
  const safeTeam = escapeEmailHtml(ctx.teamName);
  const safeWorkspace = escapeEmailHtml(ctx.workspaceName);
  const safeInviter = escapeEmailHtml(ctx.inviterDisplay);
  const expires = ctx.invite.expiresAtUtc.toUTCString();
  const html = renderEmailShell({
    title: `You're invited to join "${ctx.teamName}"`,
    preheader: `${ctx.inviterDisplay} invited you to the ${ctx.teamName} team on ${brand}.`,
    bodyHtml: `
      <p>Hi,</p>
      <p>${safeInviter} invited you to join the
      <strong>${safeTeam}</strong> team inside the
      <strong>${safeWorkspace}</strong> workspace on ${brand}.</p>
      <p>Teams are how investigators, lawyers, and other collaborators
      share evidence and case work on ${brand}. You can accept this
      invite at any time before it expires.</p>
      <p style="color:#5d6d71;font-size:0.92rem;">
        This invite expires on <strong>${escapeEmailHtml(expires)}</strong>.
        If you didn't expect this email you can safely ignore it.
      </p>
    `,
    ctaText: "Accept invitation",
    ctaUrl: ctx.invite.acceptUrl,
    secondaryText:
      "Proovra — secure custody and verification of digital evidence.",
  });

  const text = [
    `${ctx.inviterDisplay} invited you to the "${ctx.teamName}" team`,
    `in the "${ctx.workspaceName}" workspace on ${brand}.`,
    ``,
    `Accept: ${ctx.invite.acceptUrl}`,
    ``,
    `Expires: ${expires}`,
    `If you didn't expect this email you can safely ignore it.`,
  ].join("\n");

  const result = await sendCustomEmailViaResend({
    to: ctx.email,
    from: getEmailFromHeader(),
    subject,
    html,
    text,
    // The durable invite id ALONE. A re-issued invitation is a new invite row
    // and therefore a new key; a retry of this one is the same message and
    // deduplicates at the provider.
    //
    // The accept URL is deliberately NOT in the preimage: it carries a live
    // invitation token, and the key it derives travels in an HTTP header into
    // the provider's request logs.
    idempotencyKey: deterministicEmailKey(
      "collaboration_team_invite",
      ctx.invite.id,
    ),
  });
  if (result.ok) {
    await recordInviteDeliveryResult({
      inviteId: ctx.invite.id,
      status: "SENT",
    });
    return true;
  }
  await recordInviteDeliveryResult({
    inviteId: ctx.invite.id,
    status: "FAILED",
    errorPreview: `${result.errorCode}: ${result.errorMessage}`.slice(0, 280),
  });
  return false;
}

/**
 * Send the invite via SMS using the canonical Twilio adapter. Returns
 * true on apparent success.
 */
export async function sendCollaborationTeamInviteSms(
  ctx: DeliveryContext,
): Promise<boolean> {
  if (!ctx.phone) return false;
  const body = renderCollaborationTeamInvitationSmsBody({
    teamName: ctx.teamName,
    workspaceName: ctx.workspaceName,
    inviterDisplay: ctx.inviterDisplay,
    acceptUrl: ctx.invite.acceptUrl,
  });
  try {
    // Phase 5 — route the SMS via the canonical communications queue
    // (Phase 18). This gets us rate limiting, STOP-opt-out, audit, and
    // provider abstraction for free.
    //
    // PHASE 6 DEBT — the CommunicationPurpose enum does not yet have a
    // dedicated `COLLABORATION_TEAM_INVITE` value (it lives in shared
    // COMMUNICATION_PURPOSES + Prisma's `CommunicationPurpose` enum,
    // both of which would need an additive migration to extend). We
    // reuse `INTAKE_LINK` here as the closest semantic neighbour
    // ("invite someone with a secure link to participate"). The body
    // text itself clearly identifies the team invite. Phase 6 should
    // add the dedicated purpose value.
    const result = await enqueueOutboundMessage({
      teamId: ctx.workspaceId,
      channel: "SMS",
      purpose: "INTAKE_LINK",
      recipientPhone: ctx.phone,
      body,
      createdByUserId: ctx.inviterUserId,
    });
    if (
      result.status === "sent" ||
      result.status === "queued" ||
      result.status === "retry_scheduled"
    ) {
      // For "queued" / "retry_scheduled" we mark SENT (the queue will
      // process it asynchronously); the invite record stays PENDING
      // until the user accepts.
      await recordInviteDeliveryResult({
        inviteId: ctx.invite.id,
        status: "SENT",
      });
      return true;
    }
    await recordInviteDeliveryResult({
      inviteId: ctx.invite.id,
      status: "FAILED",
      errorPreview: `status:${result.status}`,
    });
    return false;
  } catch (err) {
    await recordInviteDeliveryResult({
      inviteId: ctx.invite.id,
      status: "FAILED",
      errorPreview: previewError(err),
    });
    return false;
  }
}

function previewError(err: unknown): string {
  if (!err) return "Unknown error";
  if (err instanceof Error) return err.message.slice(0, 280);
  try {
    return JSON.stringify(err).slice(0, 280);
  } catch {
    return "Unknown error";
  }
}
