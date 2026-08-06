/**
 * Macro-Wave A2 — durable Organization-invite delivery.
 *
 * Completes the enterprise-provisioning product journey: an org invite is
 * no longer "created and hopefully copied by the admin" — every invite gets
 * a DURABLE delivery record (outbox) committed in the SAME transaction as
 * the invite row, an inline-first email attempt, and a worker-driven retry
 * sweep for stranded/failed deliveries.
 *
 * REUSE, NOT REBUILD:
 *   - Outbox rows are the EXISTING Phase-8 `NotificationDelivery` model
 *     (no new table, no migration). Rows are identified by
 *     eventType = "org_invite_delivery" and carry ONLY safe ids in
 *     `metadata` ({ inviteId, organizationId }).
 *   - Email goes through the EXISTING canonical Resend wrapper
 *     (`sendCustomEmailViaResend`) + branded shell (`renderEmailShell`)
 *     — the exact transport the collaboration-team invite path uses.
 *   - Accept URLs are composed by the canonical tenant-url builders
 *     (`absoluteInternalUrl` + `internalNavPath` from @proovra/shared),
 *     targeting the canonical web accept route
 *     `/org-invites/{token}/accept`.
 *   - Retry policy reuses the shared notification retry contract
 *     (`NOTIFICATION_RETRY_MAX_ATTEMPTS`, `notificationRetryDelaySeconds`,
 *     `classifyNotificationProviderError`).
 *
 * TOKEN-ROTATION RETRY DESIGN (the keystone):
 *   Invite tokens are stored ONLY as SHA-256 hashes (Stage 6). The raw
 *   token therefore CANNOT be re-derived for a retry — and persisting the
 *   raw accept URL in a durable outbox row would violate the hashing
 *   contract. So:
 *
 *     - The outbox row stores ONLY ids and bounded digests — never a
 *       token, never a token hash, never an accept URL.
 *     - The FIRST attempt happens inline at create time using the raw
 *       token that exists in memory in the creating request.
 *     - A ROTATION mints a new token: the sweeper rotates the invite's
 *       tokenHash (+ refreshes expiry), builds the accept URL from the
 *       fresh raw token IN MEMORY, sends, and discards it. The previous
 *       accept URL dies on rotation — replay denial for free — and no raw
 *       token ever touches a durable row, audit metadata, or a log line.
 *
 * PHASE 12 POINT 5 — RETRY IS NOT ROTATION:
 *   Those two used to be the same operation on one durable intent, which
 *   made "retry" send DIFFERENT content under an UNCHANGED provider
 *   idempotency key — so a provider still holding an ambiguous first
 *   attempt could suppress the rotated one, leaving the recipient with a
 *   link the rotation had already killed. They are now distinct:
 *
 *     RETRY     same content, same durable intent, same provider key. Only
 *               the attempt counter moves.
 *     ROTATION  new content. The current intent is SUPERSEDED (CANCELLED,
 *               `superseded_by_rotation`) and a SUCCESSOR intent is created
 *               with its own id, its own minted key and `contentVersion + 1`.
 *
 *   Content identity is a bounded fingerprint over (inviteId, tokenHash,
 *   expiry) — derived from the STORED HASH, so it distinguishes a rotated
 *   invitation from an unrotated one without exposing the token.
 *
 *   The supersede is a conditional UPDATE and doubles as the concurrency
 *   claim, so two callers rotating the same invitation mint one token and
 *   send one email.
 *
 * STATUS DISCIPLINE:
 *   Rows managed here use ONLY PENDING → SENT / FAILED / CANCELLED.
 *   CANCELLED carries two meanings, distinguished by `errorCode`: the
 *   invite itself died (accepted / revoked / missing), or the intent was
 *   superseded by a rotation. Either way the row is unreachable by the
 *   sweeper, which claims PENDING only — which is exactly why a superseded
 *   intent can never send again.
 *
 *   We deliberately NEVER use RETRY_SCHEDULED: the generic Phase-8
 *   notification sweeper (`processDueNotificationRetries`) claims
 *   RETRY_SCHEDULED rows and re-renders from `templateContextJson` —
 *   which for org invites cannot contain the accept URL. Keeping our
 *   retryable rows in PENDING (+ nextAttemptAtUtc) makes them invisible
 *   to the generic sweeper and owned exclusively by this service.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  absoluteInternalUrl,
  classifyNotificationProviderError,
  internalNavPath,
  NOTIFICATION_RETRY_MAX_ATTEMPTS,
  notificationRetryDelaySeconds,
} from "@proovra/shared";

import {
  STORED_IDEMPOTENCY_KEY_FIELD,
  mintEmailIdempotencyKey,
  readStoredIdempotencyKey,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
import {
  escapeEmailHtml,
  getEmailBrandName,
  getEmailFromHeader,
  getEmailWebBaseUrl,
  renderEmailShell,
  sendCustomEmailViaResend,
} from "../email.service.js";
import { emitOrgAuditEvent } from "./org-audit.service.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Discriminator on NotificationDelivery rows owned by this service. */
export const ORG_INVITE_DELIVERY_EVENT_TYPE = "org_invite_delivery";

/**
 * Operation discriminator for this family's provider idempotency keys.
 *
 * PHASE 12 POINT 5 — THE ROTATION CONTRADICTION, AND HOW IT IS SETTLED
 * ---------------------------------------------------------------------------
 * Two earlier designs were each half right and each wrong on the other half.
 *
 *   `(deliveryId, attempt)` — reasoning that a rotated token makes each
 *   attempt a genuinely different message. True of the message a HUMAN reads.
 *   But `retryCount` is a MUTABLE counter, so a key containing it changes on
 *   every attempt, which is the definition of not having an idempotency key.
 *
 *   `(deliveryId)` alone — a stable key for the life of the intent, which
 *   fixes that. But this family ROTATES THE TOKEN on every sweeper retry, so
 *   the "retry" carried a DIFFERENT accept URL under the SAME key. If the
 *   first attempt ended ambiguously — the provider may or may not hold it —
 *   the provider is entitled to suppress the second as a duplicate. The
 *   recipient then holds a link that the rotation has already killed, and no
 *   further attempt can reach them under that key. A dead invitation,
 *   indistinguishable in every log from a delivered one.
 *
 * The settled contract separates the two things that were being conflated:
 *
 *   * a RETRY is another attempt at the SAME content, and keeps the same
 *     durable intent and therefore the same key. The attempt counter moves;
 *     the key does not.
 *   * a ROTATION is NEW CONTENT — a new token, a new accept URL, a new
 *     expiry. It SUPERSEDES the current intent and creates a SUCCESSOR intent
 *     with its own id and its own minted key.
 *
 * So an ambiguous attempt on the old link can never suppress the new one: they
 * are different intents under different keys. And the superseded intent is
 * CANCELLED with `superseded_by_rotation`, so it can never send again — one
 * live invitation per invite, always.
 *
 * Content identity is a bounded FINGERPRINT (see
 * {@link orgInviteContentFingerprint}), never the token or the URL.
 */
export const ORG_INVITE_IDEMPOTENCY_OPERATION = "org_invite_delivery";

/**
 * Error code written on the intent a rotation replaces.
 *
 * CANCELLED rather than a new status value: the sweeper claims PENDING rows
 * only, so a CANCELLED intent is unreachable by construction, and the existing
 * enum already carries the meaning. A new schema for a state the schema can
 * already express would be a migration bought for nothing.
 */
export const ORG_INVITE_SUPERSEDED_ERROR_CODE = "superseded_by_rotation";

/** Metadata field naming the successor intent, written on the predecessor. */
export const SUPERSEDED_BY_FIELD = "supersededByDeliveryId";

/** Metadata field carrying the 1-based content generation. */
export const CONTENT_VERSION_FIELD = "contentVersion";

/** Metadata field carrying the bounded content fingerprint. */
export const CONTENT_FINGERPRINT_FIELD = "contentFingerprint";

/**
 * Domain separator for the content fingerprint.
 *
 * Fixed and versioned: changing what goes into the fingerprint must change
 * this string too, so old and new fingerprints can never be compared as if
 * they meant the same thing.
 */
const CONTENT_FINGERPRINT_DOMAIN = "proovra.org_invite.delivery_content.v1";

/**
 * A bounded identifier for "the exact invitation content a send would carry".
 *
 * It must distinguish a rotated invitation from an unrotated one, and it must
 * NOT expose the token. So it is built from the STORED HASH, not the token:
 * `tokenHash` is already a one-way digest, and hashing it again under a domain
 * separator yields a value from which neither the token nor the hash can be
 * recovered. The expiry is included because a refreshed expiry changes what the
 * recipient is told, and the invite id anchors it to one invitation.
 *
 * 32 hex characters — enough that two live invitations cannot collide, short
 * enough to sit in metadata and a log line without being mistaken for a secret.
 */
export function orgInviteContentFingerprint(input: {
  inviteId: string;
  tokenHash: string;
  expiresAt: Date;
}): string {
  return createHash("sha256")
    .update(
      [
        CONTENT_FINGERPRINT_DOMAIN,
        input.inviteId,
        input.tokenHash,
        input.expiresAt.toISOString(),
      ].join("|"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
}

/** Read the content version off a delivery row's metadata (default 1). */
export function readContentVersion(metadata: Prisma.JsonValue): number {
  if (!metadata || typeof metadata !== "object") return 1;
  const raw = (metadata as Record<string, unknown>)[CONTENT_VERSION_FIELD];
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

/** True when this intent has already been replaced by a rotation. */
export function isSupersededDelivery(metadata: Prisma.JsonValue): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const raw = (metadata as Record<string, unknown>)[SUPERSEDED_BY_FIELD];
  return typeof raw === "string" && raw.length > 0;
}

/** Same ceiling as the shared notification retry contract (= 5). */
export const ORG_INVITE_DELIVERY_MAX_ATTEMPTS = NOTIFICATION_RETRY_MAX_ATTEMPTS;

/** Bounded lastError length persisted on the row (errorMessage column). */
export const ORG_INVITE_DELIVERY_ERROR_BOUND = 300;

/**
 * How long a sweeper claim "leases" a row (nextAttemptAtUtc is pushed this
 * far forward atomically on claim, so a concurrent sweeper cannot pick the
 * same row inside the lease window).
 */
const CLAIM_LEASE_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Token contract — mirrors the canonical Stage 6 single-invite helpers in
// organizations.routes.ts EXACTLY (32 random bytes hex; SHA-256 hex hash;
// 7-day expiry). Kept local so routes → service imports stay one-way.
// ---------------------------------------------------------------------------

export function newOrgInviteToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashOrgInviteToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function orgInviteExpiresAt(now = Date.now()): Date {
  return new Date(now + 7 * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Canonical accept URL — /org-invites/{token}/accept on the web app,
// composed via the shared tenant-url builders (PHASE 11 nav-path family).
// ---------------------------------------------------------------------------

export function buildOrgInviteAcceptUrl(rawToken: string): string {
  return absoluteInternalUrl(
    getEmailWebBaseUrl(),
    internalNavPath(`/org-invites/${encodeURIComponent(rawToken)}/accept`),
  );
}

// ---------------------------------------------------------------------------
// Public projection
// ---------------------------------------------------------------------------

export type OrgInviteDeliveryState = {
  deliveryId: string;
  status: "PENDING" | "SENT" | "FAILED" | "CANCELLED";
  attempts: number;
  /** Bounded, never contains tokens/URLs — errorCode plus a clipped detail. */
  lastError: string | null;
};

type DeliveryRow = {
  id: string;
  status: string;
  retryCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  recipient: string;
  metadata: Prisma.JsonValue;
};

function boundedLastError(
  errorCode: string | null,
  errorMessage: string | null,
): string | null {
  if (!errorCode && !errorMessage) return null;
  const combined = errorMessage
    ? `${errorCode ?? "error"}: ${errorMessage}`
    : String(errorCode);
  return combined.slice(0, ORG_INVITE_DELIVERY_ERROR_BOUND);
}

export function projectOrgInviteDelivery(row: DeliveryRow): OrgInviteDeliveryState {
  const status =
    row.status === "SENT" ||
    row.status === "FAILED" ||
    row.status === "CANCELLED"
      ? row.status
      : ("PENDING" as const);
  return {
    deliveryId: row.id,
    status,
    attempts: row.retryCount,
    lastError: boundedLastError(row.errorCode, row.errorMessage),
  };
}

// ---------------------------------------------------------------------------
// 1. Outbox commit — MUST run inside the SAME transaction as the invite
//    create so a committed invite always has a delivery record (and a
//    rolled-back invite never leaves an orphan outbox row).
// ---------------------------------------------------------------------------

export type RecordOrgInviteDeliveryInput = {
  inviteId: string;
  organizationId: string;
  email: string;
  initiatedByUserId?: string | null;
};

export async function recordOrgInviteDeliveryPending(
  tx: Prisma.TransactionClient,
  input: RecordOrgInviteDeliveryInput,
): Promise<{ deliveryId: string }> {
  // PHASE 12 POINT 5 — the id is minted here rather than by the database so
  // the provider idempotency key can be derived from it and stored in the SAME
  // insert. A key written by a later UPDATE would leave a window in which the
  // row exists with no key, and the first attempt in that window would have to
  // invent one.
  const deliveryId = randomUUID();

  // PHASE 12 POINT 5 — the content fingerprint is read from the invite row in
  // THIS transaction rather than passed in by the caller. Three call sites
  // create invites (single, bulk, provisioning); a parameter would have to be
  // threaded through all three and could be threaded wrongly through one. The
  // row is the authority and it is already committed here.
  const invite = await tx.organizationInvite.findUnique({
    where: { id: input.inviteId },
    select: { tokenHash: true, expiresAt: true },
  });

  const created = await tx.notificationDelivery.create({
    data: {
      id: deliveryId,
      teamId: null,
      eventType: ORG_INVITE_DELIVERY_EVENT_TYPE,
      channel: "EMAIL",
      provider: "RESEND",
      recipient: input.email,
      status: "PENDING",
      templateKey: ORG_INVITE_DELIVERY_EVENT_TYPE,
      // Ids and bounded digests ONLY. Raw tokens, token hashes and accept
      // URLs are NEVER persisted here (see file header — rotation contract).
      metadata: buildIntentMetadata({
        inviteId: input.inviteId,
        organizationId: input.organizationId,
        deliveryId,
        contentVersion: 1,
        contentFingerprint:
          invite?.tokenHash && invite.expiresAt
            ? orgInviteContentFingerprint({
                inviteId: input.inviteId,
                tokenHash: invite.tokenHash,
                expiresAt: invite.expiresAt,
              })
            : null,
      }),
      // If the process dies between commit and the inline first attempt,
      // the sweeper picks the row up after the first retry delay.
      nextAttemptAtUtc: new Date(
        Date.now() + notificationRetryDelaySeconds(2) * 1000,
      ),
      initiatedByUserId: input.initiatedByUserId ?? null,
    },
    select: { id: true },
  });
  return { deliveryId: created.id };
}

/**
 * The metadata every delivery intent carries.
 *
 * One builder so a successor intent cannot be created with a differently
 * shaped record than its predecessor — which is how a version field quietly
 * stops being present on exactly the rows that need it.
 *
 * The key is minted HERE, from the intent's own immutable id, and written in
 * the same insert. A key added by a later UPDATE would leave a window in which
 * the row exists with no key, and an attempt landing in that window would have
 * to invent one.
 */
function buildIntentMetadata(input: {
  inviteId: string;
  organizationId: string;
  deliveryId: string;
  contentVersion: number;
  contentFingerprint: string | null;
}): Prisma.InputJsonValue {
  return {
    inviteId: input.inviteId,
    organizationId: input.organizationId,
    [CONTENT_VERSION_FIELD]: input.contentVersion,
    ...(input.contentFingerprint
      ? { [CONTENT_FINGERPRINT_FIELD]: input.contentFingerprint }
      : {}),
    [STORED_IDEMPOTENCY_KEY_FIELD]: mintEmailIdempotencyKey(
      ORG_INVITE_IDEMPOTENCY_OPERATION,
      input.deliveryId,
    ),
  };
}

// ---------------------------------------------------------------------------
// Rendering — branded shell, mirroring the collaboration-team invite email.
// ---------------------------------------------------------------------------

type RenderContext = {
  organizationName: string;
  role: string;
  inviterDisplay: string | null;
  expiresAt: Date;
  acceptUrl: string;
};

function renderOrgInviteEmail(ctx: RenderContext): {
  subject: string;
  html: string;
  text: string;
} {
  const brand = getEmailBrandName();
  const safeOrg = escapeEmailHtml(ctx.organizationName);
  const safeRole = escapeEmailHtml(ctx.role.replaceAll("_", " ").toLowerCase());
  const inviter = ctx.inviterDisplay?.trim() || null;
  const safeInviter = inviter ? escapeEmailHtml(inviter) : null;
  const expires = ctx.expiresAt.toUTCString();
  const subject = inviter
    ? `${inviter} invited you to join "${ctx.organizationName}" on ${brand}`
    : `You're invited to join "${ctx.organizationName}" on ${brand}`;

  const html = renderEmailShell({
    title: `You're invited to join "${ctx.organizationName}"`,
    preheader: `Join the ${ctx.organizationName} organization on ${brand}.`,
    bodyHtml: `
      <p>Hi,</p>
      <p>${safeInviter ? `${safeInviter} invited you` : "You've been invited"}
      to join the <strong>${safeOrg}</strong> organization on ${brand}
      as <strong>${safeRole}</strong>.</p>
      <p>Organizations are how enterprise teams govern their evidence
      workspaces on ${brand}. Accept the invitation to activate your
      membership.</p>
    `,
    ctaText: "Accept invitation",
    ctaUrl: ctx.acceptUrl,
    noticeTitle: "About this link",
    noticeText:
      `This invitation link expires on ${expires} and stops working if a newer ` +
      `invitation email is sent. If you didn't expect this email you can safely ignore it.`,
  });

  const text = [
    inviter
      ? `${inviter} invited you to join the "${ctx.organizationName}" organization on ${brand}.`
      : `You've been invited to join the "${ctx.organizationName}" organization on ${brand}.`,
    `Role: ${ctx.role}`,
    ``,
    `Accept: ${ctx.acceptUrl}`,
    ``,
    `Expires: ${expires}`,
    `If you didn't expect this email you can safely ignore it.`,
  ].join("\n");

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Attempt core — build URL from an IN-MEMORY raw token, send, persist the
// outcome. The raw token is never written anywhere.
// ---------------------------------------------------------------------------

type AttemptOutcome =
  | { kind: "sent"; providerMessageId: string | null }
  | { kind: "retryable"; errorCode: string; errorMessage: string }
  | { kind: "permanent"; errorCode: string; errorMessage: string };

async function sendInviteEmail(
  to: string,
  ctx: RenderContext,
  intent: { deliveryId: string; metadata: Prisma.JsonValue },
): Promise<AttemptOutcome> {
  let result: Awaited<ReturnType<typeof sendCustomEmailViaResend>>;
  const rendered = renderOrgInviteEmail(ctx);
  try {
    result = await sendCustomEmailViaResend({
      from: getEmailFromHeader(),
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      // LOADED from the durable row, not derived here. Every attempt on one
      // invitation reaches the provider under the key minted when the outbox
      // row was committed — including the attempts that rotate the token.
      //
      // The fallback mints from the immutable delivery id, which covers rows
      // written before this authority existed; it is stable for the life of
      // the row, so a legacy row's retries still agree with each other.
      idempotencyKey:
        readStoredIdempotencyKey(intent.metadata) ??
        mintEmailIdempotencyKey(
          ORG_INVITE_IDEMPOTENCY_OPERATION,
          intent.deliveryId,
        ),
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "unknown_error";
    const cls = classifyNotificationProviderError(null, errorMessage);
    return {
      kind: cls === "transient" ? "retryable" : "permanent",
      errorCode: "provider_threw",
      errorMessage,
    };
  }
  if (result.ok) {
    return { kind: "sent", providerMessageId: result.providerMessageId ?? null };
  }
  // `not_configured` is structural — retry-looping is dishonest (same
  // downgrade contract as the Phase-8 resend provider).
  if (result.errorCode === "not_configured") {
    return {
      kind: "permanent",
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    };
  }
  const cls = classifyNotificationProviderError(
    result.errorCode,
    result.errorMessage,
  );
  return {
    kind: cls === "transient" ? "retryable" : "permanent",
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
  };
}

async function markOutcome(
  client: PrismaClient,
  deliveryId: string,
  currentRetryCount: number,
  outcome: AttemptOutcome,
): Promise<OrgInviteDeliveryState> {
  const attempts = currentRetryCount + 1;
  if (outcome.kind === "sent") {
    const updated = await client.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "SENT",
        sentAtUtc: new Date(),
        retryCount: attempts,
        providerMessageId: outcome.providerMessageId,
        errorCode: null,
        errorMessage: null,
        nextAttemptAtUtc: null,
      },
    });
    return projectOrgInviteDelivery(updated);
  }
  const exhausted = attempts >= ORG_INVITE_DELIVERY_MAX_ATTEMPTS;
  const terminal = outcome.kind === "permanent" || exhausted;
  const updated = await client.notificationDelivery.update({
    where: { id: deliveryId },
    data: terminal
      ? {
          status: "FAILED",
          failedAtUtc: new Date(),
          retryCount: attempts,
          errorCode: outcome.errorCode.slice(0, 80),
          errorMessage: outcome.errorMessage.slice(
            0,
            ORG_INVITE_DELIVERY_ERROR_BOUND,
          ),
          nextAttemptAtUtc: null,
        }
      : {
          // STAYS PENDING (never RETRY_SCHEDULED — see file header).
          status: "PENDING",
          retryCount: attempts,
          errorCode: outcome.errorCode.slice(0, 80),
          errorMessage: outcome.errorMessage.slice(
            0,
            ORG_INVITE_DELIVERY_ERROR_BOUND,
          ),
          nextAttemptAtUtc: new Date(
            Date.now() + notificationRetryDelaySeconds(attempts + 1) * 1000,
          ),
        },
  });
  return projectOrgInviteDelivery(updated);
}

// ---------------------------------------------------------------------------
// 2. Inline first attempt — called by the route/service that just created
//    the invite, AFTER the transaction committed, with the create-time raw
//    token still in memory. Never throws.
// ---------------------------------------------------------------------------

export type AttemptInitialDeliveryInput = {
  deliveryId: string;
  rawToken: string;
  organizationName: string;
  role: string;
  inviterDisplay?: string | null;
  expiresAt: Date;
};

export async function attemptInitialOrgInviteDelivery(
  input: AttemptInitialDeliveryInput,
  client: PrismaClient = defaultPrisma,
): Promise<OrgInviteDeliveryState | null> {
  try {
    const row = await client.notificationDelivery.findUnique({
      where: { id: input.deliveryId },
    });
    if (!row || row.status !== "PENDING") {
      return row ? projectOrgInviteDelivery(row) : null;
    }
    const outcome = await sendInviteEmail(row.recipient, {
      organizationName: input.organizationName,
      role: input.role,
      inviterDisplay: input.inviterDisplay ?? null,
      expiresAt: input.expiresAt,
      acceptUrl: buildOrgInviteAcceptUrl(input.rawToken),
    }, { deliveryId: row.id, metadata: row.metadata });
    return await markOutcome(client, row.id, row.retryCount, outcome);
  } catch {
    // Delivery must NEVER unwind invite creation — the invite is already
    // committed; the sweeper will retry (with rotation) later.
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3. Rotation retry — the sweeper / resend path. Mints a NEW token, updates
//    the invite hash + expiry (killing the old link), sends, discards.
// ---------------------------------------------------------------------------

type RotateAndSendResult =
  | { kind: "delivered"; state: OrgInviteDeliveryState; acceptUrl: string }
  | { kind: "not_delivered"; state: OrgInviteDeliveryState; acceptUrl: string | null }
  | { kind: "cancelled"; state: OrgInviteDeliveryState };

async function rotateAndSend(
  client: PrismaClient,
  delivery: DeliveryRow,
  opts: { actorUserId?: string | null } = {},
): Promise<RotateAndSendResult> {
  const md = (delivery.metadata ?? {}) as Record<string, unknown>;
  const inviteId = typeof md.inviteId === "string" ? md.inviteId : null;
  const organizationId =
    typeof md.organizationId === "string" ? md.organizationId : null;

  const cancel = async (errorCode: string): Promise<RotateAndSendResult> => {
    const updated = await client.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "CANCELLED",
        errorCode,
        errorMessage: null,
        nextAttemptAtUtc: null,
      },
    });
    return { kind: "cancelled", state: projectOrgInviteDelivery(updated) };
  };
  const failHard = async (errorCode: string): Promise<RotateAndSendResult> => {
    const state = await markOutcome(client, delivery.id, delivery.retryCount, {
      kind: "permanent",
      errorCode,
      errorMessage: "",
    });
    return { kind: "not_delivered", state, acceptUrl: null };
  };

  if (!inviteId || !organizationId) return failHard("delivery_metadata_invalid");

  const invite = await client.organizationInvite.findUnique({
    where: { id: inviteId },
    select: {
      id: true,
      organizationId: true,
      email: true,
      role: true,
      acceptedAt: true,
      revokedAt: true,
      invitedByUserId: true,
    },
  });

  // Lifecycle guards — a dead invite must never be re-mailed.
  if (!invite) return await cancel("invite_missing");
  if (invite.acceptedAt) return await cancel("invite_accepted");
  if (invite.revokedAt) return await cancel("invite_revoked");
  // Binding denial — the delivery record is bound to the org + email the
  // invite was created with. A drifted row never sends.
  if (invite.organizationId !== organizationId) {
    return await failHard("organization_binding_mismatch");
  }
  if (invite.email.trim().toLowerCase() !== delivery.recipient.trim().toLowerCase()) {
    return await failHard("recipient_binding_mismatch");
  }

  const org = await client.organization.findUnique({
    where: { id: organizationId },
    select: { name: true },
  });
  const inviter = invite.invitedByUserId
    ? await client.user.findUnique({
        where: { id: invite.invitedByUserId },
        select: { displayName: true, email: true },
      })
    : null;

  // ---------------------------------------------------------------------
  // PHASE 12 POINT 5 — SUPERSEDE FIRST, and make it the concurrency claim.
  //
  // Rotation is new content, so it gets a new intent under a new provider
  // key. Retiring the predecessor is a conditional UPDATE, which does double
  // duty: it is the point past which the old link can never be sent again,
  // AND it is the claim. Two callers rotating the same delivery — the sweeper
  // and an operator resend, or two sweeper instances — produce exactly one
  // winner, so one token is minted and one email is sent.
  //
  // It precedes the token mint deliberately. Minting first would have both
  // callers swap the invite's hash, and whichever committed first would have
  // emailed a link the second had already killed.
  // ---------------------------------------------------------------------
  const supersede = await client.notificationDelivery.updateMany({
    where: { id: delivery.id, status: "PENDING" },
    data: {
      status: "CANCELLED",
      errorCode: ORG_INVITE_SUPERSEDED_ERROR_CODE,
      errorMessage: null,
      nextAttemptAtUtc: null,
    },
  });
  if (supersede.count !== 1) {
    // Another rotation already retired this intent. Report the row as it now
    // stands and do nothing else: no second token, no second email.
    const current = await client.notificationDelivery.findUnique({
      where: { id: delivery.id },
    });
    return {
      kind: "not_delivered",
      state: current
        ? projectOrgInviteDelivery(current)
        : projectOrgInviteDelivery(delivery),
      acceptUrl: null,
    };
  }

  // ROTATE — mint a fresh token, refresh expiry, and commit the SUCCESSOR
  // intent in the same transaction. The old accept URL is dead the instant
  // this commits (replay denial). Audited without the token.
  const rawToken = newOrgInviteToken();
  const newExpiresAt = orgInviteExpiresAt();
  const newTokenHash = hashOrgInviteToken(rawToken);
  const successorId = randomUUID();
  const nextVersion = readContentVersion(delivery.metadata) + 1;

  await client.$transaction(async (tx) => {
    await tx.organizationInvite.update({
      where: { id: invite.id },
      data: {
        token: null,
        tokenHash: newTokenHash,
        expiresAt: newExpiresAt,
      },
    });
    await tx.notificationDelivery.create({
      data: {
        id: successorId,
        teamId: null,
        eventType: ORG_INVITE_DELIVERY_EVENT_TYPE,
        channel: "EMAIL",
        provider: "RESEND",
        recipient: delivery.recipient,
        status: "PENDING",
        templateKey: ORG_INVITE_DELIVERY_EVENT_TYPE,
        // Attempts carry forward, so the max-attempts ceiling bounds the
        // whole chain. Without this a rotation would reset the budget and
        // the sweeper could rotate an undeliverable invite forever.
        retryCount: delivery.retryCount,
        metadata: buildIntentMetadata({
          inviteId: invite.id,
          organizationId,
          deliveryId: successorId,
          contentVersion: nextVersion,
          contentFingerprint: orgInviteContentFingerprint({
            inviteId: invite.id,
            tokenHash: newTokenHash,
            expiresAt: newExpiresAt,
          }),
        }),
        nextAttemptAtUtc: new Date(
          Date.now() +
            notificationRetryDelaySeconds(delivery.retryCount + 2) * 1000,
        ),
        initiatedByUserId: opts.actorUserId ?? null,
      },
    });
    // Point the retired intent at its replacement, so an operator reading the
    // old row can follow the chain rather than conclude the invite died.
    await tx.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        metadata: {
          ...((delivery.metadata ?? {}) as Record<string, unknown>),
          [SUPERSEDED_BY_FIELD]: successorId,
        } as Prisma.InputJsonValue,
      },
    });
    await emitOrgAuditEvent(tx, {
      organizationId,
      actorUserId: opts.actorUserId ?? null,
      eventType: "ORG_INVITE_DELIVERY_ROTATED",
      targetType: "organization_invite",
      targetId: invite.id,
      // Ids, counters and a bounded fingerprint. No token, no accept URL, no
      // provider key — the audit record must be safe to export.
      metadata: {
        inviteId: invite.id,
        deliveryId: delivery.id,
        supersededByDeliveryId: successorId,
        attempt: delivery.retryCount + 1,
        contentVersion: nextVersion,
        newExpiresAt: newExpiresAt.toISOString(),
      },
    });
  });

  const successor = await client.notificationDelivery.findUnique({
    where: { id: successorId },
  });
  if (!successor) return await failHard("successor_intent_missing");

  const acceptUrl = buildOrgInviteAcceptUrl(rawToken);
  const outcome = await sendInviteEmail(
    successor.recipient,
    {
      organizationName: org?.name ?? "your organization",
      role: invite.role,
      inviterDisplay: inviter?.displayName || inviter?.email || null,
      expiresAt: newExpiresAt,
      acceptUrl,
    },
    // The SUCCESSOR's key. A provider that is still holding the predecessor's
    // ambiguous attempt cannot suppress this one, because it is not the same
    // message and no longer claims to be.
    { deliveryId: successor.id, metadata: successor.metadata },
  );
  const state = await markOutcome(
    client,
    successor.id,
    successor.retryCount,
    outcome,
  );
  return outcome.kind === "sent"
    ? { kind: "delivered", state, acceptUrl }
    : { kind: "not_delivered", state, acceptUrl };
}

// ---------------------------------------------------------------------------
// 4. Sweeper — claims due PENDING rows atomically (lease via
//    nextAttemptAtUtc push-forward) and retries each with rotation.
//    Triggered by POST /v1/org-invite-deliveries/process (cron-secret),
//    which the worker's interval scheduler invokes.
// ---------------------------------------------------------------------------

export type ProcessOrgInviteDeliveriesSummary = {
  pickedUp: number;
  sent: number;
  retried: number;
  failed: number;
  cancelled: number;
};

export async function processDueOrgInviteDeliveries(
  input: { batchSize?: number } = {},
  client: PrismaClient = defaultPrisma,
): Promise<ProcessOrgInviteDeliveriesSummary> {
  const batchSize = Math.min(Math.max(input.batchSize ?? 50, 1), 200);
  const summary: ProcessOrgInviteDeliveriesSummary = {
    pickedUp: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    cancelled: 0,
  };
  const now = new Date();
  const candidates = await client.notificationDelivery.findMany({
    where: {
      eventType: ORG_INVITE_DELIVERY_EVENT_TYPE,
      channel: "EMAIL",
      status: "PENDING",
      retryCount: { lt: ORG_INVITE_DELIVERY_MAX_ATTEMPTS },
      nextAttemptAtUtc: { lte: now },
    },
    orderBy: { nextAttemptAtUtc: "asc" },
    take: batchSize,
  });

  for (const row of candidates) {
    // Atomic claim: push the lease forward ONLY if the row is still due.
    // A concurrent sweeper's updateMany matches 0 rows and skips — one
    // rotation + one email per due row, never two.
    const claim = await client.notificationDelivery.updateMany({
      where: {
        id: row.id,
        status: "PENDING",
        nextAttemptAtUtc: { lte: now },
      },
      data: { nextAttemptAtUtc: new Date(Date.now() + CLAIM_LEASE_MS) },
    });
    if (claim.count !== 1) continue;
    summary.pickedUp += 1;

    try {
      const result = await rotateAndSend(client, row);
      if (result.kind === "delivered") summary.sent += 1;
      else if (result.kind === "cancelled") summary.cancelled += 1;
      else if (result.state.status === "FAILED") summary.failed += 1;
      else summary.retried += 1;
    } catch {
      summary.failed += 1;
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// 5. Operator resend — used by the bulk-invite resend path. Finds (or
//    creates) the invite's delivery record, then rotates + sends
//    immediately. Returns the fresh accept URL so the AUTHORIZED admin can
//    copy it (single-invite display-once parity); it is never persisted.
// ---------------------------------------------------------------------------

export async function resendOrgInviteDelivery(
  input: {
    inviteId: string;
    organizationId: string;
    email: string;
    actorUserId: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ state: OrgInviteDeliveryState; acceptUrl: string | null } | null> {
  try {
    // PHASE 12 POINT 5 — the CURRENT intent, not merely the newest row. A
    // rotation retires its predecessor as CANCELLED, so an invite accumulates
    // a chain; resending must act on the live end of it. Reading the newest
    // row alone would have hit a retired one whenever a successor insert had
    // not yet committed, and the CANCELLED branch below would then have
    // reported the invitation dead when it was not.
    const chain = await client.notificationDelivery.findMany({
      where: {
        eventType: ORG_INVITE_DELIVERY_EVENT_TYPE,
        metadata: { path: ["inviteId"], equals: input.inviteId },
      },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
    let row = chain.find((r) => !isSupersededDelivery(r.metadata)) ?? null;
    if (!row) {
      const deliveryId = randomUUID();
      const invite = await client.organizationInvite.findUnique({
        where: { id: input.inviteId },
        select: { tokenHash: true, expiresAt: true },
      });
      const created = await client.notificationDelivery.create({
        data: {
          id: deliveryId,
          teamId: null,
          eventType: ORG_INVITE_DELIVERY_EVENT_TYPE,
          channel: "EMAIL",
          provider: "RESEND",
          recipient: input.email,
          status: "PENDING",
          templateKey: ORG_INVITE_DELIVERY_EVENT_TYPE,
          // Built by the ONE builder, so an intent minted on this path is
          // shaped exactly like one minted at invite-creation time — and
          // carries a provider key, which this branch previously omitted.
          metadata: buildIntentMetadata({
            inviteId: input.inviteId,
            organizationId: input.organizationId,
            deliveryId,
            contentVersion: 1,
            contentFingerprint:
              invite?.tokenHash && invite.expiresAt
                ? orgInviteContentFingerprint({
                    inviteId: input.inviteId,
                    tokenHash: invite.tokenHash,
                    expiresAt: invite.expiresAt,
                  })
                : null,
          }),
          initiatedByUserId: input.actorUserId,
        },
      });
      row = created;
    } else if (row.status === "FAILED" || row.status === "SENT") {
      // Resurrect for the operator-requested attempt; attempts keep
      // counting monotonically for honest observability.
      row = await client.notificationDelivery.update({
        where: { id: row.id },
        data: { status: "PENDING", initiatedByUserId: input.actorUserId },
      });
    } else if (row.status === "CANCELLED") {
      return { state: projectOrgInviteDelivery(row), acceptUrl: null };
    }

    const result = await rotateAndSend(client, row, {
      actorUserId: input.actorUserId,
    });
    if (result.kind === "cancelled") {
      return { state: result.state, acceptUrl: null };
    }
    return { state: result.state, acceptUrl: result.acceptUrl };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 6. Observability — delivery state per invite for admin surfaces.
// ---------------------------------------------------------------------------

export async function getOrgInviteDeliveryStates(
  inviteIds: string[],
  client: PrismaClient = defaultPrisma,
): Promise<Map<string, OrgInviteDeliveryState>> {
  const map = new Map<string, OrgInviteDeliveryState>();
  const ids = Array.from(new Set(inviteIds)).slice(0, 500);
  if (ids.length === 0) return map;
  const rows = await client.notificationDelivery.findMany({
    where: {
      eventType: ORG_INVITE_DELIVERY_EVENT_TYPE,
      OR: ids.map((id) => ({
        metadata: { path: ["inviteId"], equals: id },
      })),
    },
    orderBy: { createdAt: "asc" },
  });
  for (const row of rows) {
    const md = (row.metadata ?? {}) as Record<string, unknown>;
    const inviteId = typeof md.inviteId === "string" ? md.inviteId : null;
    if (!inviteId) continue;
    // PHASE 12 POINT 5 — a retired intent never represents the invitation.
    // Rotation leaves CANCELLED predecessors behind, and surfacing one would
    // tell an admin an invitation was cancelled when it had in fact just been
    // re-sent with a fresh link.
    if (isSupersededDelivery(row.metadata)) continue;
    // Later rows win (latest live delivery record per invite).
    map.set(inviteId, projectOrgInviteDelivery(row));
  }
  return map;
}
