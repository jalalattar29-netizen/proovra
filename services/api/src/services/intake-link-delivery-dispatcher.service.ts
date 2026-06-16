/**
 * Intake-links-e2e Phase 5 — delivery dispatcher with idempotency.
 *
 * The Phase 4 work landed a working synchronous delivery path
 * (`sendIntakeLinkViaEmail` / `sendIntakeLinkViaSms` called inline from
 * the API route). That's the right baseline for SMB workloads. But the
 * route-level call had two real problems:
 *
 *   1) Double-click sends. A user clicking "Create & send" twice (slow
 *      network, accidental double-click) would create the link once
 *      (the create endpoint is itself idempotent via the unique
 *      `tokenHash`) but THEN dispatch the email/SMS twice, producing
 *      two CommunicationMessage rows + two real provider calls.
 *   2) No clean seam for a future BullMQ migration. Queued delivery is
 *      out of scope for this sprint (the existing worker package has
 *      no `delivery` queue; adding one + a job processor is a
 *      multi-day effort and the user explicitly said "If full queue
 *      migration is too risky in one step, add an abstraction").
 *
 * This module solves both:
 *
 *   - `dispatchIntakeLinkDelivery({linkId, channel, idempotencyKey})`
 *     is the ONE entrypoint route handlers call. It checks for an
 *     in-flight CommunicationMessage with the same (linkId, channel,
 *     idempotencyHash) tuple and returns the prior result instead of
 *     re-sending. Real provider sends happen via the existing
 *     send-via-X helpers — no behaviour change for first-time calls.
 *   - The function is queue-ready: a future BullMQ migration replaces
 *     the inline `await sendIntakeLinkVia*` calls with
 *     `await enqueueOutboundIntakeJob(...)` without changing the call
 *     sites.
 *
 * Why a dedicated `deliveryIdempotencyKey` column:
 *   - The first cut hijacked `providerMessageId` with a synthetic
 *     `intake-idem:<hash>` value. That clobbered the real Twilio SID
 *     (SM…/MM…), so the status webhook could never correlate inbound
 *     delivery callbacks and the operator UI could never show true
 *     state. Production rows landed with provider_message_id =
 *     `intake-idem:<hex>` and the bug was invisible until a DB audit
 *     surfaced it (see migration 20270823000000_communication_message_idem_key_split).
 *   - The fix is a dedicated VARCHAR(128) column. The dispatcher
 *     writes the bare hash into `deliveryIdempotencyKey`; the
 *     underlying send-helpers continue to set `providerMessageId` to
 *     the real provider SID via the existing
 *     `updateAfterProviderAttempt` flow.
 *   - Idempotency keys are scoped to (linkId, channel) so different
 *     channels can be sent independently and a manual resend through
 *     a different channel always works.
 *
 * Retry cap:
 *   - The synchronous path has no built-in retry today (the provider
 *     SDK retries once internally for transient errors). We expose
 *     `MAX_ATTEMPTS = 3` as a constant; if a future queue migration
 *     wires this up it has a single source of truth.
 */

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../db.js";
import {
  sendIntakeLinkViaEmail,
  sendIntakeLinkViaSms,
  type SendIntakeLinkViaEmailResult,
  type SendIntakeLinkViaSmsResult,
} from "./workflow-intake-link.service.js";

/** Cap on retries for a single (linkId, channel, idempotencyKey) tuple. */
export const MAX_INTAKE_DELIVERY_ATTEMPTS = 3;

export type IntakeDeliveryChannel = "EMAIL" | "SMS" | "WHATSAPP";

export type DispatchIntakeDeliveryInput = {
  teamId: string;
  intakeLinkId: string;
  /** Required — the raw token is unrecoverable after creation; the
   *  caller must hold it. */
  rawToken: string;
  /** Full public URL the contributor opens (origin + /intake/<token>). */
  intakeUrl: string;
  channel: IntakeDeliveryChannel;
  actorUserId: string;
  workspaceName: string;
  /**
   * Caller-supplied idempotency key. The dispatcher rejects duplicate
   * sends with the same (linkId, channel, key) tuple. The frontend
   * normally generates this as a per-form-submit nonce; resend buttons
   * use a fresh nonce so they're never blocked.
   */
  idempotencyKey: string;
};

export type DispatchIntakeDeliveryResult =
  | {
      ok: true;
      /** True when this call returned a previously-completed result
       *  (no new provider call was made). */
      deduped: boolean;
      communicationMessageId: string;
      channel: IntakeDeliveryChannel;
      providerMessageId: string | null;
    }
  | {
      ok: false;
      reason:
        | "link_not_found"
        | "link_revoked"
        | "link_expired"
        | "link_missing_email"
        | "link_missing_phone"
        | "provider_unconfigured"
        | "whatsapp_template_unconfigured"
        | "delivery_failed"
        | "delivery_failed_or_skipped"
        | "max_attempts_exceeded";
      deduped: boolean;
      communicationMessageId?: string;
    };

/**
 * Hash a caller-provided idempotency key with the (linkId, channel)
 * tuple. Returned as a bare 32-char hex string written into the
 * dedicated `deliveryIdempotencyKey` VARCHAR(128) column — NEVER into
 * `providerMessageId`, which must hold the real Twilio SID.
 */
export function buildIntakeIdempotencyHash(input: {
  intakeLinkId: string;
  channel: IntakeDeliveryChannel;
  idempotencyKey: string;
}): string {
  const h = createHash("sha256");
  h.update(input.intakeLinkId);
  h.update("\x00");
  h.update(input.channel);
  h.update("\x00");
  h.update(input.idempotencyKey);
  // 32 hex chars (16 bytes) — plenty of collision resistance for a
  // per-link nonce, comfortably under our 96-char column with prefix.
  return h.digest("hex").slice(0, 32);
}

/**
 * The single entrypoint route handlers should call instead of
 * sendIntakeLinkViaEmail / sendIntakeLinkViaSms.
 */
export async function dispatchIntakeLinkDelivery(
  input: DispatchIntakeDeliveryInput,
  client: PrismaClient = defaultPrisma,
): Promise<DispatchIntakeDeliveryResult> {
  const idemHash = buildIntakeIdempotencyHash({
    intakeLinkId: input.intakeLinkId,
    channel: input.channel,
    idempotencyKey: input.idempotencyKey,
  });

  // 1) Idempotency lookup. If a prior call with the same nonce
  //    already created a CommunicationMessage row, short-circuit. We
  //    intentionally don't gate on status — even a FAILED prior
  //    attempt is returned as-is so the user sees the SAME outcome
  //    they saw before, not a fresh retry.
  const prior = await client.communicationMessage.findFirst({
    where: {
      relatedIntakeLinkId: input.intakeLinkId,
      channel: input.channel,
      deliveryIdempotencyKey: idemHash,
    },
    select: {
      id: true,
      status: true,
      providerMessageId: true,
    },
  });
  if (prior) {
    if (
      prior.status === "SENT" ||
      prior.status === "DELIVERED" ||
      prior.status === "QUEUED" ||
      prior.status === "RETRY_SCHEDULED"
    ) {
      return {
        ok: true,
        deduped: true,
        communicationMessageId: prior.id,
        channel: input.channel,
        // Echo the REAL provider SID if the prior send produced one.
        // We never echo our internal idempotency hash.
        providerMessageId: prior.providerMessageId ?? null,
      };
    }
    // Prior attempt failed. Return the same failure (don't auto-retry).
    return {
      ok: false,
      reason: "delivery_failed",
      deduped: true,
      communicationMessageId: prior.id,
    };
  }

  // 2) Attempt cap. Count CommunicationMessage rows for this
  //    (linkId, channel) tuple regardless of idempotency. The cap
  //    protects against runaway resends through the operator UI.
  const attemptCount = await client.communicationMessage.count({
    where: {
      relatedIntakeLinkId: input.intakeLinkId,
      channel: input.channel,
    },
  });
  if (attemptCount >= MAX_INTAKE_DELIVERY_ATTEMPTS) {
    return {
      ok: false,
      reason: "max_attempts_exceeded",
      deduped: false,
    };
  }

  // 3) Real provider call. The send-helpers create the
  //    CommunicationMessage row themselves; we patch the
  //    providerMessageId immediately after success so a follow-up
  //    idempotency lookup can find it.
  let result: SendIntakeLinkViaEmailResult | SendIntakeLinkViaSmsResult;
  if (input.channel === "EMAIL") {
    result = await sendIntakeLinkViaEmail(
      {
        teamId: input.teamId,
        intakeLinkId: input.intakeLinkId,
        rawToken: input.rawToken,
        intakeUrl: input.intakeUrl,
        actorUserId: input.actorUserId,
        workspaceName: input.workspaceName,
      },
      client,
    );
  } else {
    result = await sendIntakeLinkViaSms(
      {
        teamId: input.teamId,
        intakeLinkId: input.intakeLinkId,
        rawToken: input.rawToken,
        intakeUrl: input.intakeUrl,
        channel: input.channel,
        actorUserId: input.actorUserId,
        workspaceName: input.workspaceName,
      },
      client,
    );
  }

  if (result.ok) {
    // Tag the row with the bare idempotency hash so a follow-up call
    // with the same nonce finds it and short-circuits. Crucially we
    // write `deliveryIdempotencyKey` — NOT `providerMessageId`. The
    // send-helper has already set `providerMessageId` to the real
    // Twilio SID (SM…/MM…) or Resend message ID via
    // `updateAfterProviderAttempt`, and we must not overwrite it.
    try {
      await client.communicationMessage.update({
        where: { id: result.communicationMessageId },
        data: { deliveryIdempotencyKey: idemHash },
      });
    } catch {
      // Don't fail the user-visible result for a marker patch.
    }
    return {
      ok: true,
      deduped: false,
      communicationMessageId: result.communicationMessageId,
      channel: input.channel,
      providerMessageId:
        "providerMessageId" in result ? result.providerMessageId : null,
    };
  }

  // Failure path — mirror the helper's reason. Best-effort tag the
  // failed row with the idempotency hash (in its own column) so a
  // retry with the same nonce returns the same failure rather than
  // auto-retrying. Provider-id remains untouched on the failed row.
  if ("communicationMessageId" in result && result.communicationMessageId) {
    try {
      await client.communicationMessage.update({
        where: { id: result.communicationMessageId },
        data: { deliveryIdempotencyKey: idemHash },
      });
    } catch {
      /* ignore */
    }
  }
  return {
    ok: false,
    reason: result.reason,
    deduped: false,
    communicationMessageId:
      "communicationMessageId" in result
        ? result.communicationMessageId
        : undefined,
  };
}
