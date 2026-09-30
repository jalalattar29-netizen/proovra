import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
// BILLING RECONCILIATION (2026-08-27) — `setPersonalPlan`, `activateTeamPlan`,
// `cancelTeamPlan` and `upsertSubscription` are no longer imported here. Every
// one of them was called only by `syncPlanForSubscription`, which moved to
// `services/billing/subscription-lifecycle.handlers.ts` so the verified webhook
// and the polled reconciliation share one implementation of what a provider
// subscription state MEANS. This route now applies that meaning rather than
// deciding it.
import {
  recordPayment,
  upsertWorkspaceStorageAddon,
} from "../services/billing.service.js";
// Evidence credits are granted through the canonical wallet by the shared
// Stripe/PayPal settlement services (idempotent on the provider payment id).
import { syncPlanForSubscription } from "../services/billing/subscription-lifecycle.handlers.js";
// BILLING COMMERCIAL CORRECTNESS (2026-08-27) — renewal ownership comes from
// the AUTHORITATIVE STORED subscription row, not from provider metadata that
// providers do not in fact put on renewal events.
import {
  paypalSubscriptionIdFromSale,
  resolveSubjectFromProviderSubscription,
  stripeSubscriptionIdFromInvoice,
} from "../services/billing/provider-subscription-binding.service.js";
import {
  parseStripeEvent,
  verifyStripeSignature,
} from "../services/stripe.service.js";
import { verifyPayPalWebhook } from "../services/paypal.service.js";
import { parsePayPalStorageAddonCustomId } from "../services/paypal-checkout-policy.service.js";
// PAYPAL END-TO-END (2026-09-25) — orders, captures and subscriptions are
// settled by ONE service shared with the authenticated return routes, from
// PayPal's live server-side state.
import {
  applyPayPalDispute,
  applyPayPalRefundOrReversal,
  applyPayPalSubscriptionState,
  assertWebhookStorageAddonAllowed,
  handlePayPalCaptureWebhook,
  isPayPalResourceId,
  settlePayPalEvidenceCreditOrder,
} from "../services/billing/paypal-settlement.service.js";
import { applyStorageSubscriptionObservation } from "../services/billing/storage-activation.service.js";
import { auditWebhookSignatureVerification } from "../services/security/webhook-signature-audit.service.js";
// PHASE 9 §12 / §9.4 — the ONE subscription-active rule is consumed by the
// storage add-on guard, which now lives in paypal-settlement.service.ts
// (assertWebhookStorageAddonAllowed, imported above) and imports it from
// @proovra/shared-billing directly.
import { webhookDuplicateDisposition } from "../services/billing/webhook-delivery-lease.js";
// STRIPE SETTLEMENT (2026-09-28) — the session handler and its parsers are
// shared with provider-first recovery, so both apply a session identically.
import {
  dateFromUnixSeconds,
  parsePlan,
  parseStorageAddonBillingCycle,
  parseStorageAddonKey,
  parseStripeSubscriptionStatus,
  recordStripeSessionAttemptOutcome,
  applyStripeChargeAdverseEvent,
  settleStripeCheckoutSession,
  type StripeCheckoutSession,
} from "../services/billing/stripe-settlement.service.js";


function tryParseAddonContextFromCustomId(raw: unknown): {
  userId?: string;
  teamId?: string | null;
  storageAddonKey?: prismaPkg.StorageAddonKey | null;
  billingCycle?: prismaPkg.StorageAddonBillingCycle | null;
} {
  if (typeof raw !== "string" || !raw.trim()) {
    return {};
  }

  const text = raw.trim();

  // Compact v1 context (`sa1|…`, origin/main b9b8b54); legacy JSON and
  // key=value formats remain supported. ONE sa1 parser, shared with the
  // settlement service, so the webhook and the return route cannot disagree.
  if (text.startsWith("sa1|")) {
    const sa1 = parsePayPalStorageAddonCustomId(text);
    if (!sa1) return {};
    return {
      userId: sa1.userId,
      teamId: sa1.teamId,
      storageAddonKey: sa1.storageAddonKey,
      billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
    };
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      userId: typeof parsed.userId === "string" ? parsed.userId : undefined,
      teamId:
        typeof parsed.teamId === "string"
          ? parsed.teamId
          : parsed.teamId === null
            ? null
            : undefined,
      storageAddonKey: parseStorageAddonKey(parsed.storageAddonKey),
      billingCycle:
        parsed.billingCycle === prismaPkg.StorageAddonBillingCycle.ONE_TIME
          ? prismaPkg.StorageAddonBillingCycle.ONE_TIME
          : null,
    };
  } catch {
    // continue
  }

  const out: Record<string, string> = {};
  for (const part of text.split(/[|;&]/g)) {
    const [rawKey, rawValue] = part.split(/[=:]/, 2);
    const key = rawKey?.trim();
    const value = rawValue?.trim();
    if (key && value) {
      out[key] = value;
    }
  }

  return {
    userId: out.userId,
    teamId: out.teamId ?? null,
    storageAddonKey: parseStorageAddonKey(out.storageAddonKey),
    billingCycle:
      out.billingCycle === prismaPkg.StorageAddonBillingCycle.ONE_TIME
        ? prismaPkg.StorageAddonBillingCycle.ONE_TIME
        : null,
  };
}


/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — a storage add-on's status
 * FOLLOWS its subscription's.
 *
 * ONE mapping, so a lapsed add-on cannot keep granting capacity on one provider
 * while it stops on the other. PAST_DUE deliberately still grants: the canonical
 * usage aggregate counts ACTIVE and PAST_DUE add-ons, which is the same bounded
 * grace the base subscription gets rather than an instant cliff on a failed card.
 */
/**
 * BILLING RECONCILIATION (2026-08-27) — `storageAddonStatusFromSubscription`
 * and `syncPlanForSubscription` MOVED to
 * `services/billing/subscription-lifecycle.handlers.ts`.
 *
 * They were fine here while a verified webhook was the only way a provider
 * fact could reach the domain. Reconciliation now learns the same facts by
 * polling, and a second copy of "what an ACTIVE TEAM subscription means" is
 * exactly how the two paths would come to disagree about a customer's plan.
 * The behaviour is unchanged; this file imports it and calls it as before.
 */

export async function webhooksRoutes(app: FastifyInstance) {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    }
  );

  app.post("/stripe", async (req: FastifyRequest, reply) => {
    const sig = req.headers["stripe-signature"];
    const rawBody = req.body as Buffer;

    // Phase A3 — every signature failure becomes an auditable
    // `webhook_signature_failure` SecurityEvent + bumped metric +
    // structured log. The wrapper classifies the failure into a
    // bounded reason category WITHOUT exposing the secret, the raw
    // signature, or the payload bytes anywhere durable.
    const sigCheck = await auditWebhookSignatureVerification({
      provider: "stripe",
      request: req,
      presentSignature: typeof sig === "string",
      verify: () => {
        verifyStripeSignature(rawBody, sig as string);
      },
    });
    if (!sigCheck.ok) {
      return reply.code(400).send({
        message:
          sigCheck.reason === "missing_signature"
            ? "Missing signature"
            : "Invalid webhook signature",
      });
    }

    const event = parseStripeEvent(rawBody);

    // Phase E10.1 — DEF-038 closure. Stripe webhook event idempotency.
    // The unique index on `stripe_event_id` makes the "seen?" check
    // atomic — a duplicate insert raises Prisma P2002 which we
    // translate into a safe no-op 200. The row stays in the table as
    // the durable audit of what was acted on.
    try {
      await prisma.stripeWebhookEvent.create({
        data: {
          stripeEventId: event.id,
          eventType: event.type,
          processingStatus: "RECEIVED",
        },
      });
    } catch (err: unknown) {
      // P2002 = unique constraint violation = duplicate delivery.
      // Any other error: propagate (signature already verified, so
      // failure here is a real DB problem we want to surface).
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code?: string }).code
          : undefined;
      if (code === "P2002") {
        const existing = await prisma.stripeWebhookEvent.findUnique({
          where: { stripeEventId: event.id },
          select: { processingStatus: true, receivedAt: true },
        });
        const disposition = webhookDuplicateDisposition(existing ?? {});
        if (disposition === "DEDUPLICATE") {
          return reply
            .code(200)
            .send({ ok: true, deduplicated: true, eventId: event.id });
        }
        if (disposition === "RETRY_LATER") {
          // Do not acknowledge an event whose first handler may still be
          // running. A non-2xx makes Stripe redeliver; once the lease expires,
          // one delivery reclaims the row and completes the side effects.
          return reply.code(503).send({ ok: false, retryable: true });
        }

        const reclaimedAt = new Date();
        const reclaimed = await prisma.stripeWebhookEvent.updateMany({
          where: {
            stripeEventId: event.id,
            processingStatus: existing?.processingStatus,
            receivedAt: existing?.receivedAt,
          },
          data: {
            processingStatus: "RECEIVED",
            receivedAt: reclaimedAt,
            processedAt: null,
            errorReason: null,
          },
        });
        if (reclaimed.count === 0) {
          return reply.code(503).send({ ok: false, retryable: true });
        }
      } else {
        throw err;
      }
    }

    if (event.type === "checkout.session.completed") {
      // One settlement path for the webhook and for recovery. Credits are
      // granted only for a PAID session at the server price; storage is
      // activated from the session's subscription; the attempt that started
      // the session is updated either way.
      const settled = await settleStripeCheckoutSession({
        session: event.data.object as StripeCheckoutSession,
        log: req.log,
      });
      req.log.info(
        { provider: "STRIPE", eventId: event.id, product: settled.product, outcome: settled.outcome, reason: settled.reason ?? null },
        "stripe.checkout_session_settled",
      );
    }

    // ET-COM-03 — a refunded or lost-disputed credit purchase takes its
    // credits back (PayPal's refunds already did; Stripe's were never read).
    if (event.type === "charge.refunded" || event.type === "charge.dispute.closed") {
      const adverse = await applyStripeChargeAdverseEvent({
        eventType: event.type,
        object: event.data.object,
        log: req.log,
      });
      req.log.info(
        { provider: "STRIPE", eventId: event.id, eventType: event.type, outcome: adverse.outcome },
        "stripe.charge_adverse_event",
      );
    }

    if (event.type === "checkout.session.expired") {
      // The payment page closed unpaid. Nothing was charged; the attempt
      // records the provider's own terminal answer.
      const session = event.data.object as StripeCheckoutSession;
      const userId = session.metadata?.userId;
      if (userId) {
        const credit =
          session.metadata?.productKey === "EVIDENCE_CREDIT" ||
          parsePlan(session.metadata?.plan) === prismaPkg.PlanType.PAYG;
        await recordStripeSessionAttemptOutcome({
          session,
          userId,
          product: credit
            ? prismaPkg.BillingCheckoutProduct.EVIDENCE_CREDIT
            : parseStorageAddonKey(session.metadata?.storageAddonKey)
              ? prismaPkg.BillingCheckoutProduct.STORAGE_ADDON
              : prismaPkg.BillingCheckoutProduct.PLAN,
          status: prismaPkg.BillingCheckoutAttemptStatus.EXPIRED,
          checkoutState: "PROVIDER_EXPIRED",
        });
      }
    }

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const subscription = event.data.object as {
        id: string;
        status?: string;
        current_period_end?: number;
        currency?: string;
        items?: { data?: Array<{ price?: { unit_amount?: number | null; currency?: string } }> };
        metadata?: {
          userId?: string;
          plan?: string;
          teamId?: string;
          storageAddonKey?: string;
          billingCycle?: string;
          currency?: string;
          amountCents?: string;
        };
      };

      const userId = subscription.metadata?.userId;
      const plan = parsePlan(subscription.metadata?.plan);
      const teamId = subscription.metadata?.teamId ?? null;
      const storageAddonKey = parseStorageAddonKey(
        subscription.metadata?.storageAddonKey
      );
      const stripeStatus = parseStripeSubscriptionStatus(subscription.status);
      const stripeObservedAt = dateFromUnixSeconds(
        (event as { created?: unknown }).created,
      );

      if (userId && plan) {
        await syncPlanForSubscription({
          userId,
          plan,
          teamId,
          provider: prismaPkg.PaymentProvider.STRIPE,
          providerSubId: subscription.id,
          status: stripeStatus,
          currentPeriodEnd: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000)
            : null,
          observedAtUtc: stripeObservedAt,
          // What Stripe bills: the subscription's currency and its price's
          // unit amount — provider facts, never the display currency.
          billedCurrency: subscription.currency ? subscription.currency.toUpperCase() : null,
          billedUnitAmountCents:
            typeof subscription.items?.data?.[0]?.price?.unit_amount === "number"
              ? subscription.items.data[0].price.unit_amount
              : null,
        });
      }

      /**
       * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — a storage add-on
       * subscription HAS a lifecycle now: renewal, payment failure and
       * cancellation all reach this handler, and all three used to be logged
       * as "unsupported" and dropped.
       */
      const parsedCycle = parseStorageAddonBillingCycle(
        subscription.metadata?.billingCycle
      );
      if (userId && storageAddonKey && parsedCycle !== null) {
        // BILLING PAYPAL INTEGRITY (2026-09-28) — the ONE storage activation
        // decision; a first activation is checked exactly as every other
        // path checks it.
        await applyStorageSubscriptionObservation({
          provider: prismaPkg.PaymentProvider.STRIPE,
          subscriptionId: subscription.id,
          status: stripeStatus,
          planId: null,
          claimed: { userId, teamId, addonKey: storageAddonKey, attemptId: null },
          currentPeriodEnd: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000)
            : null,
          observedAtUtc: stripeObservedAt,
          source: event.type,
        }).catch((err: unknown) => {
          req.log.warn(
            { err, provider: "STRIPE", subscriptionId: subscription.id },
            "stripe.storage_addon_subscription_sync_failed"
          );
        });
      }
    }

    if (
      event.type === "invoice.paid" ||
      event.type === "invoice.payment_failed"
    ) {
      const invoice = event.data.object as {
        id: string;
        status?: string;
        amount_paid?: number;
        amount_due?: number;
        currency?: string;
        subscription?: unknown;
        parent?: unknown;
        metadata?: {
          userId?: string;
          plan?: string;
          teamId?: string;
          storageAddonKey?: string;
          billingCycle?: string;
        };
      };

      const storageAddonKey = parseStorageAddonKey(
        invoice.metadata?.storageAddonKey
      );
      const parsedCycle = parseStorageAddonBillingCycle(
        invoice.metadata?.billingCycle
      );

      /**
       * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — RENEWALS ARE NOW
       * RECORDED.
       *
       * This block used to require `invoice.metadata.userId`. Stripe does not
       * copy `subscription_data[metadata]` onto an invoice's top-level
       * `metadata` — that metadata lands on the SUBSCRIPTION — so the field was
       * empty on every renewal and the guard silently skipped the write. A
       * customer's payment history therefore contained their first checkout and
       * nothing else, for the life of the subscription.
       *
       * Ownership now resolves from the stored `Subscription` row keyed by the
       * provider's own subscription id, which every invoice carries. Metadata
       * is still honoured when present (the first invoice of a checkout does
       * carry it) but is no longer required.
       *
       * An invoice this platform cannot bind to a stored subscription is NOT
       * attributed: an unattributable provider event is a real state, and
       * guessing an owner writes a guess into someone's financial history.
       */
      const metadataUserId = invoice.metadata?.userId;
      const metadataPlan = parsePlan(invoice.metadata?.plan);

      const stripeSubId = stripeSubscriptionIdFromInvoice(invoice);
      let subject:
        | {
            userId: string;
            teamId: string | null;
            product: "PLAN" | "STORAGE_ADDON";
          }
        | null =
        metadataUserId && (metadataPlan || storageAddonKey)
          ? {
              userId: metadataUserId,
              teamId: invoice.metadata?.teamId ?? null,
              product: storageAddonKey ? "STORAGE_ADDON" : "PLAN",
            }
          : null;

      if (!subject && stripeSubId) {
        subject = await resolveSubjectFromProviderSubscription({
          provider: prismaPkg.PaymentProvider.STRIPE,
          providerSubId: stripeSubId,
        });
      }

      if (storageAddonKey && parsedCycle !== null) {
        req.log.warn(
          {
            provider: "STRIPE",
            invoiceId: invoice.id,
            userId: subject?.userId ?? null,
            teamId: subject?.teamId ?? null,
            storageAddonKey,
            parsedCycle,
          },
          "stripe.storage_addon_invoice_recorded_as_payment"
        );
      }

      if (subject) {
        const paid = invoice.status === "paid";
        await recordPayment({
          userId: subject.userId,
          provider: prismaPkg.PaymentProvider.STRIPE,
          providerPaymentId: invoice.id,
          // A failed invoice has no `amount_paid`; report what was DUE so the
          // history row states the amount the customer was charged for rather
          // than a zero that reads as "free".
          amountCents: paid
            ? invoice.amount_paid ?? 0
            : invoice.amount_due ?? invoice.amount_paid ?? 0,
          currency: (invoice.currency ?? "usd").toUpperCase(),
          status: paid
            ? prismaPkg.PaymentStatus.SUCCEEDED
            : prismaPkg.PaymentStatus.FAILED,
          teamId: subject.teamId,
          product: subject.product,
          providerResourceId: stripeSubId,
        });
      } else {
        // Deliberately visible: an unbindable invoice is an operational signal,
        // not something to silently drop.
        req.log.warn(
          { provider: "STRIPE", invoiceId: invoice.id },
          "stripe.invoice.unattributable_no_stored_subscription"
        );
      }
    }

    // Phase E10.1 — DEF-038 closure. Mark the event PROCESSED. Best
    // effort: a failure here does NOT roll back the side-effects above
    // (Stripe will retry; the unique-index guard turns the retry into
    // a no-op even if this update silently fails).
    await prisma.stripeWebhookEvent
      .update({
        where: { stripeEventId: event.id },
        data: { processedAt: new Date(), processingStatus: "PROCESSED" },
      })
      .catch(() => null);

    return reply.code(200).send({ received: true });
  });

  app.post("/paypal", async (req: FastifyRequest, reply) => {
    const rawBody = (req.body as Buffer).toString("utf8");

    // Phase A3 — same wrapper as Stripe. PayPal's verifier returns
    // `{ verification_status }` instead of throwing on failure, so
    // the audit wrapper sees a "thrown" verifier only when the
    // status is not SUCCESS — we adapt the contract by throwing on
    // a non-success status inside the `verify` closure.
    let verification:
      | Awaited<ReturnType<typeof verifyPayPalWebhook>>
      | null = null;
    const sigCheck = await auditWebhookSignatureVerification({
      provider: "paypal",
      request: req,
      presentSignature: true,
      verify: async () => {
        verification = await verifyPayPalWebhook(req.headers, rawBody);
        if (verification.verification_status !== "SUCCESS") {
          throw new Error(
            `PayPal signature invalid: status=${verification.verification_status}`,
          );
        }
      },
    });
    if (!sigCheck.ok || !verification) {
      return reply.code(400).send({ message: "Invalid webhook" });
    }

    const event = JSON.parse(rawBody) as {
      id?: string;
      event_type: string;
      resource: {
        id?: string;
        status?: string;
        custom_id?: string;
        billing_info?: {
          next_billing_time?: string;
        };
        purchase_units?: Array<{
          custom_id?: string;
          amount?: { value?: string; currency_code?: string };
        }>;
      };
    };

    // Phase 10 — PayPal webhook idempotency. Direct mirror of
    // Phase E10.1 / DEF-038 (Stripe). The unique index on
    // `paypal_event_id` makes the "seen?" check atomic — a duplicate
    // insert raises Prisma P2002 which we translate into a safe
    // no-op 200. The row stays in the table as the durable audit of
    // what was acted on. NOTE: we deliberately log the event id +
    // event_type only — never the raw payload, never any provider
    // secret.
    const paypalEventId = typeof event.id === "string" ? event.id : null;
    if (!paypalEventId) {
      // PayPal events should always carry a top-level `id`. Missing
      // id means malformed delivery — treat as 200 no-op to avoid
      // retry storms but log for visibility. We deliberately log
      // only the event_type — never the raw payload, never any
      // provider secret.
      req.log.warn(
        { provider: "PAYPAL", eventType: event.event_type },
        "paypal.webhook_missing_event_id"
      );
      return reply.code(200).send({ received: true });
    }

    // Phase 10 — payload-hash strengthening. sha256(rawBody) gives a
    // content-addressed fingerprint for diagnostics and in-flight replay
    // detection. The provider event id remains the durable idempotency key:
    // once an event is PROCESSED, a same-id delivery must never run business
    // logic again, even if its byte representation differs.
    const payloadHash = createHash("sha256")
      .update(rawBody)
      .digest("hex");

    try {
      await prisma.paypalWebhookEvent.create({
        data: {
          paypalEventId,
          eventType: event.event_type,
          payloadHash,
          processingStatus: "RECEIVED",
        },
      });
    } catch (err: unknown) {
      // P2002 = unique constraint violation = duplicate delivery.
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code?: string }).code
          : undefined;
      if (code === "P2002") {
        const existing = await prisma.paypalWebhookEvent.findUnique({
          where: { paypalEventId },
          select: { processingStatus: true, payloadHash: true, receivedAt: true },
        });

        // PROCESSED is final by provider event id. A hash mismatch is useful
        // security telemetry, but it must not reopen the event and risk
        // applying a second payload to a different account.
        const hashMatches =
          existing?.payloadHash != null &&
          existing.payloadHash === payloadHash;

        if (webhookDuplicateDisposition(existing ?? {}) === "DEDUPLICATE") {
          req.log.info(
            {
              provider: "PAYPAL",
              eventId: paypalEventId,
              eventType: event.event_type,
              payloadHash,
              payloadHashMismatch:
                existing?.payloadHash != null && !hashMatches,
            },
            "duplicate paypal webhook event, dedup hit"
          );
          return reply
            .code(200)
            .send({ ok: true, deduplicated: true, eventId: paypalEventId });
        }

        // BILLING CHECKOUT ATTEMPTS (2026-09-28) — an ACTIVE lease defers
        // every redelivery of this event id, whatever its bytes. Gating this
        // on a matching hash let a byte-different redelivery fall through to
        // the reclaim below while the first delivery was still running, so
        // two processes applied the same provider event concurrently.
        if (webhookDuplicateDisposition(existing ?? {}) === "RETRY_LATER") {
          return reply.code(503).send({ ok: false, retryable: true });
        }

        const reclaimedAt = new Date();
        const reclaimed = await prisma.paypalWebhookEvent.updateMany({
          where: {
            paypalEventId,
            processingStatus: existing?.processingStatus,
            receivedAt: existing?.receivedAt,
          },
          data: {
            processingStatus: "RECEIVED",
            receivedAt: reclaimedAt,
            processedAt: null,
            errorReason: null,
            payloadHash,
          },
        });
        if (reclaimed.count === 0) {
          return reply.code(503).send({ ok: false, retryable: true });
        }

        // FAILED or an expired RECEIVED lease: PayPal is
        // redelivering after a prior crash / replay; we let it
        // through so the side-effects get a chance to land. The
        // wrapping branch logic is idempotent on its own —
        // recordPayment + upsert are keyed; setPersonalPlan /
        // activateTeamPlan converge.
        req.log.info(
          {
            provider: "PAYPAL",
            eventId: paypalEventId,
            eventType: event.event_type,
            payloadHash,
            priorStatus: existing?.processingStatus ?? null,
            hashMatches,
          },
          "paypal webhook event retry, reprocessing"
        );
      } else {
        throw err;
      }
    }

    // Wrap processing so we can mark the row PROCESSED on success or
    // FAILED on error. Errors bubble to PayPal as 5xx → PayPal retries
    // and the dedup check above re-enters with a fresh shot. We also
    // refresh `payloadHash` on every transition so the dedup-by-hash
    // check sees the body that was actually acted on (covers the
    // retry-after-crash + legacy-row paths above).
    const markProcessed = async () => {
      await prisma.paypalWebhookEvent
        .update({
          where: { paypalEventId },
          data: {
            processedAt: new Date(),
            processingStatus: "PROCESSED",
            payloadHash,
          },
        })
        .catch(() => null);
    };
    const markFailed = async (reason: string) => {
      const trimmed = reason.length > 400 ? reason.slice(0, 400) : reason;
      await prisma.paypalWebhookEvent
        .update({
          where: { paypalEventId },
          data: {
            processingStatus: "FAILED",
            errorReason: trimmed,
            payloadHash,
          },
        })
        .catch(() => null);
    };

    try {
      /**
       * PAYPAL END-TO-END (2026-09-25) — a buyer approved an evidence-credit
       * order. Capture it server-side here too, so credits arrive even when
       * the buyer closes the tab before returning to PROOVRA. The capture is
       * idempotent (PayPal-Request-Id + the wallet's capture-id key), so the
       * return route and this webhook racing grant once.
       */
      if (event.event_type === "CHECKOUT.ORDER.APPROVED") {
        const orderId = event.resource.id ?? null;
        if (isPayPalResourceId(orderId)) {
          const result = await settlePayPalEvidenceCreditOrder({
            orderId,
            capture: true,
          });
          req.log.info(
            { provider: "PAYPAL", eventId: paypalEventId, orderId, outcome: result.outcome },
            "paypal.order_approved_settled"
          );
        }
        await markProcessed();
        return reply.code(200).send({ received: true });
      }

      if (
        event.event_type === "PAYMENT.CAPTURE.COMPLETED" ||
        event.event_type === "PAYMENT.CAPTURE.PENDING" ||
        event.event_type === "PAYMENT.CAPTURE.DENIED" ||
        event.event_type === "PAYMENT.CAPTURE.DECLINED"
      ) {
        // A capture resource has NO purchase_units and often no custom_id.
        // The purchase is recovered from the related order, read live.
        const settlement = await handlePayPalCaptureWebhook(event.resource);
        if (settlement) {
          req.log.info(
            {
              provider: "PAYPAL",
              eventId: paypalEventId,
              eventType: event.event_type,
              outcome: settlement.outcome,
              reason: "reason" in settlement ? settlement.reason : null,
            },
            "paypal.capture_settled"
          );
          await markProcessed();
          return reply.code(200).send({ received: true });
        }

        // LEGACY one-time storage add-on orders (JSON custom_id). No new such
        // order can be created; this keeps a late capture of an old one
        // attributable.
        const unit = event.resource.purchase_units?.[0];
        const captureAmount = (event.resource as { amount?: { value?: string; currency_code?: string } }).amount;
        const amount = unit?.amount ?? captureAmount;
        const addonContext = tryParseAddonContextFromCustomId(
          unit?.custom_id ?? event.resource.custom_id
        );

        if (
          event.event_type === "PAYMENT.CAPTURE.COMPLETED" &&
          addonContext.userId &&
          addonContext.storageAddonKey
        ) {
          try {
            await assertWebhookStorageAddonAllowed({
              userId: addonContext.userId,
              addonKey: addonContext.storageAddonKey,
              teamId: addonContext.teamId ?? null,
            });

            await recordPayment({
              userId: addonContext.userId,
              provider: prismaPkg.PaymentProvider.PAYPAL,
              providerPaymentId: event.resource.id ?? "",
              amountCents: Math.round(Number(amount?.value ?? 0) * 100),
              currency: (amount?.currency_code ?? "USD").toUpperCase(),
              status: prismaPkg.PaymentStatus.SUCCEEDED,
              teamId: addonContext.teamId ?? null,
              product: "STORAGE_ADDON_ONE_TIME",
            });

            await upsertWorkspaceStorageAddon({
              ownerUserId: addonContext.userId,
              teamId: addonContext.teamId ?? null,
              addonKey: addonContext.storageAddonKey,
              billingCycle: prismaPkg.StorageAddonBillingCycle.ONE_TIME,
              status: prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
              paymentProvider: prismaPkg.PaymentProvider.PAYPAL,
              externalPaymentId: event.resource.id ?? "",
              amountCents: Math.round(Number(amount?.value ?? 0) * 100),
              currency: (amount?.currency_code ?? "USD").toUpperCase(),
              metadata: {
                source: event.event_type,
              },
            });
          } catch (err) {
            req.log.warn(
              {
                err,
                provider: "PAYPAL",
                resourceId: event.resource.id ?? "",
                userId: addonContext.userId,
                teamId: addonContext.teamId ?? null,
                storageAddonKey: addonContext.storageAddonKey,
              },
              "paypal.storage_addon_checkout_ignored"
            );
          }
        } else {
          req.log.warn(
            { provider: "PAYPAL", eventId: paypalEventId, eventType: event.event_type },
            "paypal.capture_unattributable"
          );
        }

        await markProcessed();
        return reply.code(200).send({ received: true });
      }

      /**
       * BILLING PAYPAL INTEGRITY (2026-09-28) — refunds, reversals
       * (chargebacks) and disputes. None of these reached PROOVRA: a refunded
       * credit purchase kept its credit and its payment row kept saying
       * SUCCEEDED. The policy lives in the settlement service; here the
       * verified event is only routed to it.
       */
      if (
        event.event_type === "PAYMENT.CAPTURE.REFUNDED" ||
        event.event_type === "PAYMENT.CAPTURE.REVERSED" ||
        event.event_type === "PAYMENT.SALE.REFUNDED" ||
        event.event_type === "PAYMENT.SALE.REVERSED"
      ) {
        const adverse = await applyPayPalRefundOrReversal({
          eventType: event.event_type,
          resource: event.resource,
        });
        req.log.info(
          { provider: "PAYPAL", eventId: paypalEventId, eventType: event.event_type, outcome: adverse.outcome, product: adverse.product },
          "paypal.refund_or_reversal_applied"
        );
        await markProcessed();
        return reply.code(200).send({ received: true });
      }

      if (
        event.event_type === "CUSTOMER.DISPUTE.CREATED" ||
        event.event_type === "CUSTOMER.DISPUTE.UPDATED" ||
        event.event_type === "CUSTOMER.DISPUTE.RESOLVED"
      ) {
        const dispute = await applyPayPalDispute({
          eventType: event.event_type,
          resource: event.resource,
        });
        req.log.info(
          { provider: "PAYPAL", eventId: paypalEventId, eventType: event.event_type, outcome: dispute.outcome },
          "paypal.dispute_recorded"
        );
        await markProcessed();
        return reply.code(200).send({ received: true });
      }

      /**
       * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — PayPal RENEWALS.
       *
       * A PayPal subscription renewal arrives as `PAYMENT.SALE.COMPLETED`.
       * `billing_agreement_id` on a recurring sale IS the subscription id this
       * platform stored at checkout, so ownership is resolved from the stored
       * row rather than from a payload field PayPal does not populate.
       *
       * BILLING PAYPAL INTEGRITY (2026-09-28) — a recurring STORAGE add-on is
       * resolved too (it has no `subscriptions` row), so storage renewals
       * reach payment history instead of being "unattributable".
       */
      if (
        event.event_type === "PAYMENT.SALE.COMPLETED" ||
        event.event_type === "PAYMENT.SALE.DENIED"
      ) {
        const sale = event.resource as unknown as {
          id?: string;
          billing_agreement_id?: string;
          amount?: { total?: string; currency?: string };
          create_time?: string;
          update_time?: string;
        };
        const providerSubId = paypalSubscriptionIdFromSale(sale);
        const saleSubject = providerSubId
          ? await resolveSubjectFromProviderSubscription({
              provider: prismaPkg.PaymentProvider.PAYPAL,
              providerSubId,
            })
          : null;

        if (saleSubject && sale.id) {
          const saleTime = sale.update_time ?? sale.create_time;
          await recordPayment({
            userId: saleSubject.userId,
            provider: prismaPkg.PaymentProvider.PAYPAL,
            providerPaymentId: sale.id,
            amountCents: Math.round(Number(sale.amount?.total ?? 0) * 100),
            currency: (sale.amount?.currency ?? "USD").toUpperCase(),
            status:
              event.event_type === "PAYMENT.SALE.COMPLETED"
                ? prismaPkg.PaymentStatus.SUCCEEDED
                : prismaPkg.PaymentStatus.FAILED,
            teamId: saleSubject.teamId,
            product: saleSubject.product,
            providerResourceId: providerSubId,
            observedAtUtc: saleTime && !Number.isNaN(new Date(saleTime).getTime()) ? new Date(saleTime) : null,
          });
          // A renewal (or a failed one) is when a scheduled plan change lands,
          // a lapsed subscription recovers, or one starts failing: re-read it.
          if (providerSubId && isPayPalResourceId(providerSubId)) {
            await applyPayPalSubscriptionState({
              subscriptionId: providerSubId,
              source: event.event_type,
              log: req.log,
            });
          }
        } else {
          req.log.warn(
            { provider: "PAYPAL", saleId: sale.id ?? null, providerSubId },
            "paypal.sale.unattributable_no_stored_subscription"
          );
          // BILLING PAYPAL INTEGRITY (2026-09-28) — a billing subscription
          // with no local record (its workspace row was deleted, or it was
          // never recorded) is still PayPal's to describe: the live read
          // routes it through the settlement authorities, which record it and,
          // for storage that cannot be granted, stop it and open a review.
          if (providerSubId && isPayPalResourceId(providerSubId)) {
            await applyPayPalSubscriptionState({
              subscriptionId: providerSubId,
              source: event.event_type,
              log: req.log,
            }).catch((err: unknown) => {
              req.log.warn({ err, provider: "PAYPAL", providerSubId }, "paypal.sale.orphan_subscription_read_failed");
            });
          }
        }

        await markProcessed();
        return reply.code(200).send({ received: true });
      }

      if (
        event.event_type === "BILLING.SUBSCRIPTION.CREATED" ||
        event.event_type === "BILLING.SUBSCRIPTION.ACTIVATED" ||
        event.event_type === "BILLING.SUBSCRIPTION.UPDATED" ||
        event.event_type === "BILLING.SUBSCRIPTION.RE-ACTIVATED" ||
        event.event_type === "BILLING.SUBSCRIPTION.CANCELLED" ||
        event.event_type === "BILLING.SUBSCRIPTION.SUSPENDED" ||
        event.event_type === "BILLING.SUBSCRIPTION.EXPIRED" ||
        event.event_type === "BILLING.SUBSCRIPTION.PAYMENT.FAILED"
      ) {
        // The LIVE subscription decides (the event body is only the
        // fallback), so a duplicate or out-of-order event converges on
        // PayPal's current state. Plans and storage add-ons alike pass
        // through the ONE settlement service; storage activation through the
        // ONE storage decision. A failed renewal payment is applied as the
        // subscription's own state (PayPal suspends after its retry policy).
        const subscriptionId = event.resource.id ?? null;
        if (!subscriptionId) {
          await markProcessed();
          return reply.code(200).send({ received: true });
        }
        const settlement = await applyPayPalSubscriptionState({
          subscriptionId,
          fallbackResource: event.resource,
          source: event.event_type,
          log: req.log,
        });
        if (settlement.outcome === "REJECTED") {
          req.log.warn(
            { provider: "PAYPAL", subscriptionId, reason: settlement.reason },
            "paypal.subscription_event_not_applied"
          );
        }

        await markProcessed();
        return reply.code(200).send({ received: true });
      }

      await markProcessed();
      return reply.code(200).send({ received: true });
    } catch (err) {
      const reason =
        err instanceof Error
          ? `${err.name}: ${err.message}`
          : "unknown_paypal_handler_error";
      await markFailed(reason);
      throw err;
    }
  });
}
