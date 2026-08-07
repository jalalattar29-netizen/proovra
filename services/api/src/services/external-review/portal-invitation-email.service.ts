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
// PHASE 12 REMEDIATION §4.3 (2026-08-06) — server-owned successor token.
// Delivery NEVER accepts token truth from a caller; it mints it here.
import { rotateExternalReviewGrantToken } from "./external-review-grant.service.js";

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

  // Which MESSAGE this is: the grant's current content generation, and the
  // resend sequence within it. See `resolveDeliveryIntentCoordinates`.
  const { contentVersion, resendSeq } = await resolveDeliveryIntentCoordinates(
    prisma,
    input.teamId,
    input.grantId,
    input.isResend === true,
  );
  // The physical attempt number a NEW intent starts at. A repeat of an
  // existing intent increments it inside `reserveDeliveryIntent`.
  const attempt = 1;

  // Create the delivery row up front so even a provider crash is
  // observable in the operator console.
  //
  // PHASE 12 CORRECTIVE PASS §3 (2026-08-06) — REUSE, DO NOT RE-MINT.
  //
  // This was an unconditional `create`. Because the provider idempotency key
  // below is derived from the delivery intent, a fresh row meant a fresh key,
  // and a fresh key meant the provider had no way to recognise a repeat. A
  // retry of the same logical send therefore delivered the invitation TWICE,
  // and four concurrent sends delivered it four times — each copy carrying a
  // live bearer-token link to an external reviewer.
  //
  // The intent is keyed by (grant, contentVersion, resendSeq) — see
  // `reserveDeliveryIntent` for why `attempt` could not carry that meaning.
  //
  // The unique indexes added in
  // `20271122000000_external_review_invitation_authority_contract` are what
  // make this correct under concurrency — the check-then-insert below would
  // still race without them, and the `P2002` branch is the loser's re-read.
  const delivery = await reserveDeliveryIntent(prisma, {
    teamId: input.teamId,
    grantId: input.grantId,
    contentVersion,
    resendSeq,
    attempt,
    recipientEmail: input.recipientEmail.slice(0, 320),
    subject: subject.slice(0, 200),
    bulkBatchId: input.bulkBatchId ?? null,
  });

  const res = await sendCustomEmailViaResend({
    from,
    to: input.recipientEmail,
    subject,
    html,
    text,
    // Minted from the DURABLE intent key, not from the row's surrogate id.
    // Two callers who independently decide to send the same message compute
    // the same key without having seen each other's row, which is what makes
    // a retry recognisable as a retry. A resend or a token rotation produces
    // a different intent and therefore a different key.
    idempotencyKey: mintEmailIdempotencyKey(
      "external_review_invitation",
      delivery.intentKey,
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
// PHASE 12 REMEDIATION §4.3 (2026-08-06) — CANONICAL INVITATION DELIVERY.
//
// The ONE production path for "send this invitation's link to its reviewer".
//
// The defect this removes (SEC-001, second half): the send-email route took a
// `rawToken` STRING FROM THE REQUEST BODY and mailed it. The caller therefore
// decided what credential the reviewer received — the server neither minted
// it, nor knew it, nor could relate it to the grant it was mailing. A caller
// could mail an arbitrary string, or a token belonging to a different grant.
//
// The corrected chain — every step server-owned:
//
//   authorized caller
//     -> load invitation from DB, scoped to the authorized workspace
//     -> verify the grant's workspace and live state
//     -> MINT a successor token server-side (the predecessor is hash-only
//        and unrecoverable by construction, so there is nothing to "reuse")
//     -> persist only the canonical token HASH (atomic supersede)
//     -> construct the acceptance URL server-side
//     -> persist a durable delivery intent (the delivery row)
//     -> send through the canonical email transport, keyed by a durable,
//        delivery-row-derived idempotency key
//     -> record acknowledged / retryable / ambiguous outcome
//
// Retry semantics, unchanged and inherited from `sendInvitationEmail`: a
// retry of THIS attempt reuses the same delivery row and therefore the same
// durable idempotency key. A deliberate resend is a DIFFERENT intent — it
// rotates the token, mints a new delivery row, and so takes a new key.
// ---------------------------------------------------------------------------

export type DeliverInvitationInput = {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  /** The authorized operator; recorded on the rotation security event. */
  actorUserId: string;
  inviterDisplayName: string;
  workspaceName: string;
  /** Bounded justification recorded with the token rotation. */
  reason: string;
  bulkBatchId?: string | null;
  isResend?: boolean;
};

export type DeliverInvitationResult =
  | {
      ok: true;
      deliveryId: string;
      providerMessageId: string | null;
      status: InvitationDeliveryStatus;
    }
  | {
      ok: false;
      denial: "INVITE_NOT_FOUND" | "POLICY_REJECTED";
      deliveryId?: string;
      failureReason?: string;
    };

export async function deliverInvitationEmail(
  input: DeliverInvitationInput,
): Promise<DeliverInvitationResult> {
  const prisma = input.prisma ?? defaultPrisma;

  // 1. Load the invitation, scoped to the AUTHORIZED workspace. A grant in
  //    another workspace is indistinguishable from one that does not exist.
  const role = await prisma.externalReviewerRoleAssignment.findFirst({
    where: { teamId: input.teamId, id: input.grantId },
    select: {
      role: true,
      mfaRequired: true,
      inviteEmail: true,
      externalEmail: true,
      ssoConnectionId: true,
    },
  });
  if (!role) return { ok: false, denial: "INVITE_NOT_FOUND" };

  // 2. Verify the grant itself exists in this workspace and read the expiry
  //    the reviewer will be shown. Same concealment rule.
  const grantRows = await prisma.$queryRaw<Array<{ expires_at_utc: Date }>>`
    SELECT "expires_at_utc"
      FROM "external_review_grants"
     WHERE "id" = ${input.grantId}::uuid
       AND "team_id" = ${input.teamId}::uuid
     LIMIT 1
  `;
  const grant = grantRows[0];
  if (!grant) return { ok: false, denial: "INVITE_NOT_FOUND" };

  // 3. Mint the successor token SERVER-SIDE. The guarded UPDATE inside also
  //    re-proves workspace ownership and live state, so a grant revoked or
  //    expired between step 2 and here mints nothing and mails nothing.
  const minted = await rotateExternalReviewGrantToken(
    {
      grantId: input.grantId,
      teamId: input.teamId,
      actorUserId: input.actorUserId,
      reason: input.reason,
    },
    prisma,
  );
  if (!minted.ok) {
    // `token_unknown` covers missing / foreign / revoked / expired — all
    // concealed as one outcome, exactly as step 1 and 2 conceal.
    return {
      ok: false,
      denial:
        minted.reason === "token_unknown"
          ? "INVITE_NOT_FOUND"
          : "POLICY_REJECTED",
    };
  }

  // 4-7. Durable delivery intent + canonical transport + bounded outcome.
  const sent = await sendInvitationEmail({
    prisma,
    teamId: input.teamId,
    grantId: input.grantId,
    rawToken: minted.rawToken,
    recipientEmail: role.inviteEmail ?? role.externalEmail,
    inviterDisplayName: input.inviterDisplayName,
    workspaceName: input.workspaceName,
    role: role.role ?? "REVIEWER",
    expiresAtUtc: grant.expires_at_utc.toISOString(),
    mfaRequired: role.mfaRequired ?? false,
    ssoEnabled: role.ssoConnectionId !== null,
    bulkBatchId: input.bulkBatchId ?? null,
    isResend: input.isResend === true,
  });

  if (!sent.ok) {
    return {
      ok: false,
      denial: "POLICY_REJECTED",
      deliveryId: sent.deliveryId,
      failureReason: sent.failureReason,
    };
  }
  if (input.isResend === true) {
    await prisma.externalReviewerRoleAssignment.update({
      where: { id: input.grantId },
      data: { inviteResentAtUtc: new Date() },
    });
  }
  return {
    ok: true,
    deliveryId: sent.deliveryId,
    providerMessageId: sent.providerMessageId,
    status: sent.status,
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

/**
 * PHASE 12 CORRECTIVE PASS §3 (NEW-004, 2026-08-06) — THE DURABLE INTENT.
 *
 * The identity of a message
 * ---------------------------------------------------------------------------
 * A message to an external reviewer is identified by WHAT IT CONTAINS and WHY
 * it was sent, not by which row happened to be created:
 *
 *   grantId          which invitation;
 *   contentVersion   which generation of the link — the grant's token version
 *                    at send time. A rotation changes the content, so it is a
 *                    different message;
 *   resendSeq        0 for the original send of that content, N for the Nth
 *                    deliberate operator resend of it.
 *
 * `intentKey` is that triple rendered as a string, and it is what the provider
 * idempotency key is minted from. Two callers who independently decide to send
 * the SAME message therefore compute the SAME key without having to have seen
 * each other's row — which is what makes a retry a retry.
 *
 * The previous shape keyed on `(team, grant, attempt)` and minted the key from
 * the row's surrogate id. Two consequences it did not survive:
 *
 *   * a ROTATION kept attempt = 1, collapsed onto the superseded message's
 *     intent, and presented the provider a key it had already acknowledged.
 *     The provider acknowledges again and sends nothing — so the reviewer is
 *     left holding a dead link with no successor. A lockout, produced by the
 *     de-duplication fix itself.
 *   * `deriveAttemptCounter` computed `count() + 1`, a read-then-write. Two
 *     concurrent resends both read N and both computed N+1; the loser adopted
 *     the winner's row, so the second deliberate resend was silently never
 *     sent and its caller was told it succeeded.
 *
 * Insert-first rather than read-first: read-then-insert is exactly the race the
 * unique index exists to lose safely, and the insert-first path is one round
 * trip in the common case. A `P2002` means another caller won this intent, so
 * we adopt theirs — the winner's row IS the intent.
 */
async function reserveDeliveryIntent(
  prisma: PrismaClient,
  input: {
    teamId: string;
    grantId: string;
    contentVersion: number;
    resendSeq: number;
    attempt: number;
    recipientEmail: string;
    subject: string;
    bulkBatchId: string | null;
  },
): Promise<{ id: string; intentKey: string }> {
  const intentKey = deliveryIntentKey(
    input.grantId,
    input.contentVersion,
    input.resendSeq,
  );
  try {
    const created = await prisma.externalReviewInvitationDelivery.create({
      data: {
        teamId: input.teamId,
        grantId: input.grantId,
        status: "PENDING",
        provider: "RESEND_API",
        recipientEmail: input.recipientEmail,
        subject: input.subject,
        attempt: input.attempt,
        contentVersion: input.contentVersion,
        resendSeq: input.resendSeq,
        intentKey,
        bulkBatchId: input.bulkBatchId,
      },
      select: { id: true },
    });
    return { id: created.id, intentKey };
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code ?? "")
        : "";
    if (code !== "P2002") throw err;
    const existing = await prisma.externalReviewInvitationDelivery.findFirst({
      where: { teamId: input.teamId, intentKey },
      select: { id: true },
    });
    if (!existing) {
      // The constraint fired but the row is not visible. That is not a state
      // this function can reconcile, and inventing a second intent here would
      // reintroduce the very duplication it exists to prevent — so it fails
      // loudly rather than sending an unattributable message.
      throw err;
    }
    // A repeat of an intent that already exists is a RETRY. Record that it was
    // attempted again — the physical attempt count is genuinely higher — while
    // the intent, and therefore the provider key, stays the same.
    await prisma.externalReviewInvitationDelivery.update({
      where: { id: existing.id },
      data: { attempt: { increment: 1 } },
    });
    return { id: existing.id, intentKey };
  }
}

/** The durable identity of a message. Never derived from a row id. */
export function deliveryIntentKey(
  grantId: string,
  contentVersion: number,
  resendSeq: number,
): string {
  return `${grantId}:${contentVersion}:${resendSeq}`;
}

/**
 * Which message this send IS.
 *
 * `contentVersion` comes from the grant, so a rotation is automatically a new
 * message with no caller having to remember to say so.
 *
 * `resendSeq` for an ordinary send is always 0, so repeats collapse. For a
 * deliberate resend it is allocated by the DATABASE — `MAX(resend_seq) + 1`
 * computed inside the statement that also has to win the unique index — rather
 * than by a `count()` in the application, which two concurrent resends would
 * both read identically.
 */
async function resolveDeliveryIntentCoordinates(
  prisma: PrismaClient,
  teamId: string,
  grantId: string,
  isResend: boolean,
): Promise<{ contentVersion: number; resendSeq: number }> {
  const grantRows = await prisma.$queryRaw<Array<{ token_version: number }>>`
    SELECT "token_version"
      FROM "external_review_grants"
     WHERE "id" = ${grantId}::uuid AND "team_id" = ${teamId}::uuid
     LIMIT 1
  `;
  const contentVersion = Number(grantRows[0]?.token_version ?? 1);
  if (!isResend) return { contentVersion, resendSeq: 0 };

  // The highest resend of THIS content version, read and incremented in one
  // statement. A concurrent resend that reads the same maximum will lose the
  // unique index and be handled as a retry of that intent rather than
  // vanishing — which is the honest outcome for two simultaneous clicks.
  const rows = await prisma.$queryRaw<Array<{ next: number }>>`
    SELECT COALESCE(MAX("resend_seq"), 0) + 1 AS next
      FROM "external_review_invitation_deliveries"
     WHERE "team_id" = ${teamId}::uuid
       AND "grant_id" = ${grantId}::uuid
       AND "content_version" = ${contentVersion}
  `;
  return { contentVersion, resendSeq: Number(rows[0]?.next ?? 1) };
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
