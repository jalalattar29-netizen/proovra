import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import {
  ensureEntitlement,
  recordPayment,
  setPersonalPlan,
  activateTeamPlan,
  cancelTeamPlan,
  upsertSubscription,
  upsertWorkspaceStorageAddon,
} from "../services/billing.service.js";
// BILLING COMMERCIAL CORRECTNESS (2026-08-27) — evidence credits are granted
// through the canonical wallet, which writes the auditable ledger entry in the
// same transaction as the balance and is idempotent on the provider payment id.
import { grantEvidenceCredits } from "../services/billing/evidence-credits.service.js";
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
import {
  verifyPayPalWebhook,
  getPayPalSubscription,
} from "../services/paypal.service.js";
import { parsePayPalCustomId } from "../services/paypal-checkout-policy.service.js";
import { auditWebhookSignatureVerification } from "../services/security/webhook-signature-audit.service.js";
// PHASE 9 §12 — canonical commercial decision (no raw plan literals).
// PHASE 9 §9.4 — the ONE subscription-active rule, consumed directly from
// the canonical pure policy (api delegate deleted).
import {
  EVIDENCE_CREDIT_PRODUCT,
  isWorkspaceSubscriptionActive as isPaidTeamSubscriptionActive,
} from "@proovra/shared-billing";

// BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the credit grant per purchase
// is a property of the PRODUCT, read from the canonical catalog, not a literal
// maintained beside the webhook handler.
const PAYG_CREDITS_PER_PURCHASE =
  EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase;

function parsePlan(value: unknown): prismaPkg.PlanType | null {
  if (
    value === prismaPkg.PlanType.FREE ||
    value === prismaPkg.PlanType.PAYG ||
    value === prismaPkg.PlanType.PRO ||
    value === prismaPkg.PlanType.TEAM
  ) {
    return value;
  }
  return null;
}

function parseStorageAddonKey(
  value: unknown
): prismaPkg.StorageAddonKey | null {
  if (
    value === prismaPkg.StorageAddonKey.PERSONAL_10_GB ||
    value === prismaPkg.StorageAddonKey.PERSONAL_50_GB ||
    value === prismaPkg.StorageAddonKey.PERSONAL_200_GB ||
    value === prismaPkg.StorageAddonKey.TEAM_100_GB ||
    value === prismaPkg.StorageAddonKey.TEAM_500_GB ||
    value === prismaPkg.StorageAddonKey.TEAM_1_TB
  ) {
    return value;
  }
  return null;
}

function parseStorageAddonBillingCycle(
  value: unknown
): prismaPkg.StorageAddonBillingCycle | null {
  if (value === prismaPkg.StorageAddonBillingCycle.ONE_TIME) {
    return prismaPkg.StorageAddonBillingCycle.ONE_TIME;
  }
  return null;
}

function parseStripeSubscriptionStatus(
  status?: string
): prismaPkg.SubscriptionStatus {
  const normalized = (status ?? "").trim().toLowerCase();

  if (normalized === "active") return prismaPkg.SubscriptionStatus.ACTIVE;
  if (normalized === "trialing") return prismaPkg.SubscriptionStatus.TRIALING;
  if (normalized === "past_due") return prismaPkg.SubscriptionStatus.PAST_DUE;
  if (normalized === "unpaid") return prismaPkg.SubscriptionStatus.PAST_DUE;
  if (normalized === "canceled" || normalized === "incomplete_expired") {
    return prismaPkg.SubscriptionStatus.CANCELED;
  }

  return prismaPkg.SubscriptionStatus.CANCELED;
}

function parsePayPalSubscriptionStatus(
  status?: string
): prismaPkg.SubscriptionStatus {
  const normalized = (status ?? "").trim().toUpperCase();

  if (normalized === "ACTIVE") return prismaPkg.SubscriptionStatus.ACTIVE;
  if (normalized === "APPROVAL_PENDING") {
    return prismaPkg.SubscriptionStatus.TRIALING;
  }
  if (normalized === "APPROVED") return prismaPkg.SubscriptionStatus.TRIALING;
  if (normalized === "CREATED") return prismaPkg.SubscriptionStatus.TRIALING;
  if (normalized === "SUSPENDED") return prismaPkg.SubscriptionStatus.PAST_DUE;
  if (normalized === "EXPIRED") return prismaPkg.SubscriptionStatus.CANCELED;
  if (normalized === "CANCELLED") return prismaPkg.SubscriptionStatus.CANCELED;
  if (normalized === "CANCELLED_BY_SYSTEM") {
    return prismaPkg.SubscriptionStatus.CANCELED;
  }

  return prismaPkg.SubscriptionStatus.CANCELED;
}

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

function parseAmountCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function assertWebhookStorageAddonAllowed(params: {
  userId: string;
  addonKey: prismaPkg.StorageAddonKey;
  teamId?: string | null;
}) {
  if (params.teamId) {
    const team = await prisma.team.findUnique({
      where: { id: params.teamId },
      select: {
        id: true,
        ownerUserId: true,
        billingPlan: true,
        billingStatus: true,
      },
    });

    if (!team) {
      const err: Error & { statusCode?: number } = new Error("Team not found");
      err.statusCode = 404;
      throw err;
    }

    if (team.ownerUserId !== params.userId) {
      const err: Error & { statusCode?: number } = new Error(
        "Storage add-on team ownership mismatch"
      );
      err.statusCode = 403;
      throw err;
    }

    const isTeamAddon =
      params.addonKey === prismaPkg.StorageAddonKey.TEAM_100_GB ||
      params.addonKey === prismaPkg.StorageAddonKey.TEAM_500_GB ||
      params.addonKey === prismaPkg.StorageAddonKey.TEAM_1_TB;

    if (!isTeamAddon) {
      const err: Error & { statusCode?: number } = new Error(
        "Personal storage add-on cannot be attached to a team workspace"
      );
      err.statusCode = 400;
      throw err;
    }

    // PHASE 9 §12 — canonical commercial decision (no raw plan literals).
    const effectiveTeamActive = isPaidTeamSubscriptionActive({
      billingPlan: team.billingPlan,
      billingStatus: team.billingStatus,
    });

    if (!effectiveTeamActive) {
      const err: Error & { statusCode?: number } = new Error(
        "Team storage add-ons require an active TEAM workspace"
      );
      err.statusCode = 409;
      throw err;
    }

    return;
  }

  const entitlement = await ensureEntitlement(params.userId);

  const isPersonalAddon =
    params.addonKey === prismaPkg.StorageAddonKey.PERSONAL_10_GB ||
    params.addonKey === prismaPkg.StorageAddonKey.PERSONAL_50_GB ||
    params.addonKey === prismaPkg.StorageAddonKey.PERSONAL_200_GB;

  if (!isPersonalAddon) {
    const err: Error & { statusCode?: number } = new Error(
      "Team storage add-on cannot be attached to a personal workspace"
    );
    err.statusCode = 400;
    throw err;
  }

  if (entitlement.plan === prismaPkg.PlanType.FREE) {
    const err: Error & { statusCode?: number } = new Error(
      "FREE plan cannot receive storage add-ons"
    );
    err.statusCode = 409;
    throw err;
  }

  if (
    entitlement.plan === prismaPkg.PlanType.PAYG &&
    params.addonKey !== prismaPkg.StorageAddonKey.PERSONAL_10_GB &&
    params.addonKey !== prismaPkg.StorageAddonKey.PERSONAL_50_GB
  ) {
    const err: Error & { statusCode?: number } = new Error(
      "PAYG supports only PERSONAL_10_GB and PERSONAL_50_GB"
    );
    err.statusCode = 400;
    throw err;
  }
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
function storageAddonStatusFromSubscription(
  status: prismaPkg.SubscriptionStatus,
): prismaPkg.WorkspaceStorageAddonStatus {
  switch (status) {
    case prismaPkg.SubscriptionStatus.ACTIVE:
      return prismaPkg.WorkspaceStorageAddonStatus.ACTIVE;
    case prismaPkg.SubscriptionStatus.TRIALING:
      return prismaPkg.WorkspaceStorageAddonStatus.PENDING;
    case prismaPkg.SubscriptionStatus.PAST_DUE:
      return prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE;
    case prismaPkg.SubscriptionStatus.CANCELED:
      return prismaPkg.WorkspaceStorageAddonStatus.CANCELED;
  }
}

async function syncPlanForSubscription(params: {
  userId: string;
  plan: prismaPkg.PlanType;
  teamId?: string | null;
  provider: prismaPkg.PaymentProvider;
  providerSubId: string;
  status: prismaPkg.SubscriptionStatus;
  currentPeriodEnd?: Date | null;
}) {
  await upsertSubscription({
    userId: params.userId,
    provider: params.provider,
    providerSubId: params.providerSubId,
    status: params.status,
    plan: params.plan,
    currentPeriodEnd: params.currentPeriodEnd ?? null,
    teamId: params.teamId ?? null,
  });

  if (params.plan === prismaPkg.PlanType.TEAM) {
    if (!params.teamId) return;

    if (params.status === prismaPkg.SubscriptionStatus.CANCELED) {
      await cancelTeamPlan({
        teamId: params.teamId,
        ownerUserId: params.userId,
      });
      return;
    }

    if (params.status === prismaPkg.SubscriptionStatus.ACTIVE) {
      await activateTeamPlan({
        teamId: params.teamId,
        ownerUserId: params.userId,
        plan: prismaPkg.PlanType.TEAM,
        status: prismaPkg.TeamBillingStatus.ACTIVE,
      });
      return;
    }

    if (params.status === prismaPkg.SubscriptionStatus.PAST_DUE) {
      const existingTeam = await prisma.team.findUnique({
        where: { id: params.teamId },
        select: {
          billingPlan: true,
          billingStatus: true,
        },
      });

      // PHASE 9 §12 — canonical commercial decision (no raw plan literals).
      const alreadyActivated = existingTeam
        ? isPaidTeamSubscriptionActive({
            billingPlan: existingTeam.billingPlan,
            billingStatus: existingTeam.billingStatus,
          })
        : false;

      if (alreadyActivated) {
        await activateTeamPlan({
          teamId: params.teamId,
          ownerUserId: params.userId,
          plan: prismaPkg.PlanType.TEAM,
          status: prismaPkg.TeamBillingStatus.PAST_DUE,
        });
      }

      return;
    }

    return;
  }

  if (params.status === prismaPkg.SubscriptionStatus.CANCELED) {
    await setPersonalPlan(params.userId, prismaPkg.PlanType.FREE);
    return;
  }

  if (params.status === prismaPkg.SubscriptionStatus.TRIALING) {
    return;
  }

  if (params.status === prismaPkg.SubscriptionStatus.ACTIVE) {
    await setPersonalPlan(params.userId, params.plan);
  }
}

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
        return reply
          .code(200)
          .send({ ok: true, deduplicated: true, eventId: event.id });
      }
      throw err;
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as {
        id: string;
        subscription?: string | null;
        mode?: string;
        amount_total?: number;
        currency?: string;
        metadata?: {
          userId?: string;
          plan?: string;
          teamId?: string;
          storageAddonKey?: string;
          billingCycle?: string;
          currency?: string;
          amountCents?: string;
          productKey?: string;
        };
      };

      const userId = session.metadata?.userId;
      const plan = parsePlan(session.metadata?.plan);
      const teamId = session.metadata?.teamId ?? null;
      const storageAddonKey = parseStorageAddonKey(
        session.metadata?.storageAddonKey
      );

      // BILLING PRODUCTION CLOSURE (2026-08-27) — identify the PRODUCT, not a
      // plan.
      //
      // This asked whether the session's metadata named the PAYG plan, so a
      // legacy recurring-plan row carried the identity of a one-time product
      // and no other product could ever be added without another plan row.
      // The server now stamps `productKey` at checkout and it is read first.
      //
      // The `plan === PAYG` arm is retained DELIBERATELY and only as a
      // compatibility path: a customer who opened checkout before this deploy
      // has a live Stripe session whose metadata carries no `productKey`, and
      // refusing to settle it would take money without granting the credit.
      const isEvidenceCreditPurchase =
        session.metadata?.productKey === "EVIDENCE_CREDIT" ||
        plan === prismaPkg.PlanType.PAYG;

      if (userId && isEvidenceCreditPurchase) {
        await ensureEntitlement(userId);
        await grantEvidenceCredits({
          userId,
          credits: PAYG_CREDITS_PER_PURCHASE,
          provider: prismaPkg.PaymentProvider.STRIPE,
          providerRef: session.id,
        });

        await recordPayment({
          userId,
          provider: prismaPkg.PaymentProvider.STRIPE,
          providerPaymentId: session.id,
          amountCents: session.amount_total ?? 0,
          currency: (
            session.currency ??
            session.metadata?.currency ??
            "usd"
          ).toUpperCase(),
          status: prismaPkg.PaymentStatus.SUCCEEDED,
          teamId: null,
        });
      }

      if (userId && storageAddonKey) {
        try {
          await assertWebhookStorageAddonAllowed({
            userId,
            addonKey: storageAddonKey,
            teamId,
          });

          const storageAddonBillingCycle = parseStorageAddonBillingCycle(
            session.metadata?.billingCycle
          );

          const effectiveCurrency = (
            session.currency ??
            session.metadata?.currency ??
            "usd"
          ).toUpperCase();

          const effectiveAmountCents =
            session.amount_total ??
            parseAmountCents(session.metadata?.amountCents) ??
            0;

          await recordPayment({
            userId,
            provider: prismaPkg.PaymentProvider.STRIPE,
            providerPaymentId: session.id,
            amountCents: effectiveAmountCents,
            currency: effectiveCurrency,
            status: prismaPkg.PaymentStatus.SUCCEEDED,
            teamId,
          });

          /**
           * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — a storage add-on is
           * a recurring subscription, so the SUBSCRIPTION id is its durable
           * identity and the branch that required its ABSENCE is gone.
           *
           * The previous condition was `!session.subscription && cycle ===
           * ONE_TIME`, which is now unreachable by construction: the checkout
           * runs in subscription mode. Keeping it would have meant a completed
           * add-on purchase activating nothing at all.
           */
          if (session.subscription) {
            await upsertWorkspaceStorageAddon({
              ownerUserId: userId,
              teamId,
              addonKey: storageAddonKey,
              billingCycle:
                storageAddonBillingCycle ??
                prismaPkg.StorageAddonBillingCycle.MONTHLY,
              status: prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
              paymentProvider: prismaPkg.PaymentProvider.STRIPE,
              // Keyed on the SUBSCRIPTION so every later renewal, failure and
              // cancellation event finds the same row.
              externalSubscriptionId: String(session.subscription),
              externalPaymentId: session.id,
              amountCents: effectiveAmountCents,
              currency: effectiveCurrency,
              metadata: {
                source: "stripe.checkout.session.completed",
                mode: session.mode ?? null,
              },
            });
          } else {
            req.log.warn(
              {
                provider: "STRIPE",
                sessionId: session.id,
                storageAddonKey,
              },
              "stripe.storage_addon_checkout_without_subscription_ignored"
            );
          }
        } catch (err) {
          req.log.warn(
            {
              err,
              provider: "STRIPE",
              sessionId: session.id,
              userId,
              teamId,
              storageAddonKey,
            },
            "stripe.storage_addon_checkout_ignored"
          );
        }
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
        await upsertWorkspaceStorageAddon({
          ownerUserId: userId,
          teamId,
          addonKey: storageAddonKey,
          billingCycle: parsedCycle,
          status: storageAddonStatusFromSubscription(stripeStatus),
          paymentProvider: prismaPkg.PaymentProvider.STRIPE,
          externalSubscriptionId: subscription.id,
          currentPeriodEnd: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000)
            : null,
          metadata: { source: event.type },
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

      let subject:
        | { userId: string; teamId: string | null; plan: prismaPkg.PlanType }
        | null =
        metadataUserId && metadataPlan
          ? {
              userId: metadataUserId,
              teamId: invoice.metadata?.teamId ?? null,
              plan: metadataPlan,
            }
          : null;

      if (!subject) {
        const stripeSubId = stripeSubscriptionIdFromInvoice(invoice);
        if (stripeSubId) {
          subject = await resolveSubjectFromProviderSubscription({
            provider: prismaPkg.PaymentProvider.STRIPE,
            providerSubId: stripeSubId,
          });
        }
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
    // content-addressed fingerprint so that a true duplicate
    // delivery (same id, byte-identical body) is recognised as a
    // dedup hit independent of `processing_status`. A same-id /
    // different-hash arrival is treated as a replay-after-crash and
    // allowed through (the per-side-effect writers are themselves
    // idempotent on their own keys).
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
          select: { processingStatus: true, payloadHash: true },
        });

        // True dedup hit: identical payload hash AND the prior
        // attempt processed successfully OR is still in flight with
        // the same body. Log + 200, do NOT re-run business logic.
        const hashMatches =
          existing?.payloadHash != null &&
          existing.payloadHash === payloadHash;

        if (
          hashMatches &&
          (existing?.processingStatus === "PROCESSED" ||
            existing?.processingStatus === "RECEIVED")
        ) {
          req.log.info(
            {
              provider: "PAYPAL",
              eventId: paypalEventId,
              eventType: event.event_type,
              payloadHash,
            },
            "duplicate paypal webhook event, dedup hit"
          );
          return reply
            .code(200)
            .send({ ok: true, deduplicated: true, eventId: paypalEventId });
        }

        // PROCESSED with no hash on file (legacy row from before the
        // payload-hash column) → still a dedup hit.
        if (
          existing?.processingStatus === "PROCESSED" &&
          existing?.payloadHash == null
        ) {
          req.log.info(
            {
              provider: "PAYPAL",
              eventId: paypalEventId,
              eventType: event.event_type,
              payloadHash,
            },
            "duplicate paypal webhook event, dedup hit (legacy row, no hash)"
          );
          return reply
            .code(200)
            .send({ ok: true, deduplicated: true, eventId: paypalEventId });
        }

        // else (FAILED, or RECEIVED with hash mismatch): PayPal is
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
      if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
        const unit = event.resource.purchase_units?.[0];
        const parsed = parsePayPalCustomId(
          unit?.custom_id ?? event.resource.custom_id
        );
        const addonContext = tryParseAddonContextFromCustomId(
          unit?.custom_id ?? event.resource.custom_id
        );

        if (parsed.userId && parsed.plan === prismaPkg.PlanType.PAYG) {
          await ensureEntitlement(parsed.userId);
          await grantEvidenceCredits({
            userId: parsed.userId,
            credits: PAYG_CREDITS_PER_PURCHASE,
            provider: prismaPkg.PaymentProvider.PAYPAL,
            providerRef: event.resource.id ?? "",
          });

          await recordPayment({
            userId: parsed.userId,
            provider: prismaPkg.PaymentProvider.PAYPAL,
            providerPaymentId: event.resource.id ?? "",
            amountCents: Math.round(Number(unit?.amount?.value ?? 0) * 100),
            currency: (unit?.amount?.currency_code ?? "USD").toUpperCase(),
            status: prismaPkg.PaymentStatus.SUCCEEDED,
            teamId: null,
          });
        }

        if (addonContext.userId && addonContext.storageAddonKey) {
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
              amountCents: Math.round(Number(unit?.amount?.value ?? 0) * 100),
              currency: (unit?.amount?.currency_code ?? "USD").toUpperCase(),
              status: prismaPkg.PaymentStatus.SUCCEEDED,
              teamId: addonContext.teamId ?? null,
            });

            await upsertWorkspaceStorageAddon({
              ownerUserId: addonContext.userId,
              teamId: addonContext.teamId ?? null,
              addonKey: addonContext.storageAddonKey,
              billingCycle: prismaPkg.StorageAddonBillingCycle.ONE_TIME,
              status: prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
              paymentProvider: prismaPkg.PaymentProvider.PAYPAL,
              externalPaymentId: event.resource.id ?? "",
              amountCents: Math.round(Number(unit?.amount?.value ?? 0) * 100),
              currency: (unit?.amount?.currency_code ?? "USD").toUpperCase(),
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
        }

        await markProcessed();
        return reply.code(200).send({ received: true });
      }

      /**
       * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — PayPal RENEWALS.
       *
       * A PayPal subscription renewal arrives as `PAYMENT.SALE.COMPLETED`,
       * which this handler did not implement at all: only
       * `PAYMENT.CAPTURE.COMPLETED` (the one-time order path) was handled, and
       * only when its `custom_id` said PAYG. Every PayPal renewal was
       * therefore invisible in payment history.
       *
       * `billing_agreement_id` on a recurring sale IS the subscription id this
       * platform stored at checkout, so ownership is resolved from the stored
       * row rather than from a payload field PayPal does not populate.
       */
      if (
        event.event_type === "PAYMENT.SALE.COMPLETED" ||
        event.event_type === "PAYMENT.SALE.DENIED"
      ) {
        const sale = event.resource as unknown as {
          id?: string;
          billing_agreement_id?: string;
          amount?: { total?: string; currency?: string };
        };
        const providerSubId = paypalSubscriptionIdFromSale(sale);
        const saleSubject = providerSubId
          ? await resolveSubjectFromProviderSubscription({
              provider: prismaPkg.PaymentProvider.PAYPAL,
              providerSubId,
            })
          : null;

        if (saleSubject && sale.id) {
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
          });
        } else {
          req.log.warn(
            { provider: "PAYPAL", saleId: sale.id ?? null, providerSubId },
            "paypal.sale.unattributable_no_stored_subscription"
          );
        }

        await markProcessed();
        return reply.code(200).send({ received: true });
      }

      if (
        event.event_type === "BILLING.SUBSCRIPTION.CREATED" ||
        event.event_type === "BILLING.SUBSCRIPTION.ACTIVATED" ||
        event.event_type === "BILLING.SUBSCRIPTION.UPDATED" ||
        event.event_type === "BILLING.SUBSCRIPTION.CANCELLED" ||
        event.event_type === "BILLING.SUBSCRIPTION.SUSPENDED" ||
        event.event_type === "BILLING.SUBSCRIPTION.EXPIRED"
      ) {
        // Phase 10 — TEAM + PRO entitlement transitions are wrapped
        // by the outer paypal_webhook_events idempotency record. The
        // dedup keystone above ensures BILLING.SUBSCRIPTION.UPDATED
        // and BILLING.SUBSCRIPTION.CANCELLED for TEAM and PRO tiers
        // cannot double-fire (the unique index on `paypal_event_id`
        // makes the second delivery a P2002 → 200 no-op).
        const subscriptionId = event.resource.id ?? null;
        if (!subscriptionId) {
          await markProcessed();
          return reply.code(200).send({ received: true });
        }

        let parsed = parsePayPalCustomId(event.resource.custom_id);
        let addonContext = tryParseAddonContextFromCustomId(
          event.resource.custom_id
        );

        const needsPlanRefresh = !parsed.userId || !parsed.plan;
        const needsAddonRefresh =
          !addonContext.userId || !addonContext.storageAddonKey;

        if (needsPlanRefresh || needsAddonRefresh) {
          try {
            const liveSubscription =
              await getPayPalSubscription(subscriptionId);
            parsed = parsePayPalCustomId(
              typeof liveSubscription.custom_id === "string"
                ? liveSubscription.custom_id
                : undefined
            );
            addonContext = tryParseAddonContextFromCustomId(
              liveSubscription.custom_id
            );
          } catch {
            // keep parsed as-is
          }
        }

        const paypalStatus = parsePayPalSubscriptionStatus(
          event.resource.status
        );

        if (parsed.userId && parsed.plan) {
          await syncPlanForSubscription({
            userId: parsed.userId,
            plan: parsed.plan,
            teamId: parsed.teamId,
            provider: prismaPkg.PaymentProvider.PAYPAL,
            providerSubId: subscriptionId,
            status: paypalStatus,
            currentPeriodEnd: event.resource.billing_info?.next_billing_time
              ? new Date(event.resource.billing_info.next_billing_time)
              : null,
          });
        }

        // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — PayPal storage add-on
        // subscriptions follow the same lifecycle as Stripe's. These events
        // were previously logged as "unsupported" and discarded, so a
        // cancelled or lapsed PayPal add-on kept granting capacity.
        if (addonContext.userId && addonContext.storageAddonKey) {
          await upsertWorkspaceStorageAddon({
            ownerUserId: addonContext.userId,
            teamId: addonContext.teamId ?? null,
            addonKey: addonContext.storageAddonKey,
            billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
            status: storageAddonStatusFromSubscription(paypalStatus),
            paymentProvider: prismaPkg.PaymentProvider.PAYPAL,
            externalSubscriptionId: subscriptionId,
            currentPeriodEnd: event.resource.billing_info?.next_billing_time
              ? new Date(event.resource.billing_info.next_billing_time)
              : null,
            metadata: { source: event.event_type },
          }).catch((err: unknown) => {
            req.log.warn(
              { err, provider: "PAYPAL", subscriptionId },
              "paypal.storage_addon_subscription_sync_failed"
            );
          });
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