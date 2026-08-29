"use client";

/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the Billing page, rebuilt
 * around the billing ACCOUNT.
 *
 * What the page this replaces did
 * ---------------------------------------------------------------------------
 * It rendered nine full-width panels in one flat column, spanning every payer
 * the viewer touched at once: a four-card summary strip that summed ACROSS
 * accounts, a Teams card whose "Current usage: N of M" compared a Collaboration
 * Team membership count against the account's Owned Workspace cap, an
 * always-expanded Checkout Console with three separate workspace pickers, a
 * personal card showing storage five different ways, one card per owned
 * workspace printing internal resolver outputs ("Effective capability view",
 * "Billing ownership: Not assigned"), and a payment list merging personal and
 * workspace payments together.
 *
 * What it does now
 * ---------------------------------------------------------------------------
 * ONE account at a time, chosen in a selector that only appears when there is
 * more than one to choose. Everything below it — plan, usage, collaboration,
 * add-ons, history, actions — comes from a single account-scoped server
 * projection, so the sections cannot disagree about who is paying. Checkout is
 * a drawer that opens on intent.
 *
 * The browser renders; it does not decide. Every capability, limit, price and
 * lifecycle state on this page was resolved by the server for THIS viewer on
 * THIS account.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { PageShell, PageHeader, PageSection, Skeleton, useToast } from "../../../components/ui";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { EmptyState } from "../../../components/ui/EmptyState";
import { useConfirmAction } from "../../../components/ui/ConfirmActionModal";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
// The app's icon set, already the source of every other glyph in the shell.
import { LifeBuoy } from "lucide-react";
import { captureException } from "../../../lib/sentry";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";
import { useTenantGuard } from "../../../lib/platform-context";
import {
  listBillingAccounts,
  readBillingAccount,
  readBillingHistory,
  requestCancellation,
  changePlan,
  reconcileAccount,
  recheckPayment,
  cancelPayment,
  abandonPayment,
  retryStorageCancellation,
  type BillingAccountProjection,
  type BillingAccountRef,
  type BillingHistoryEntry,
  type PlanOffer,
} from "../../../lib/api/billing-accounts";
import { AccountSelector } from "./_sections/AccountSelector";
import {
  ActionRequiredBanner,
  EnterpriseContractCard,
} from "./_sections/PlanAndUsage";
import {
  BillingOverview,
  EvidenceDetailCard,
  PlanCapabilitiesCard,
} from "./_sections/BillingOverview";
import {
  BillingHistorySection,
  StorageAddonsSection,
} from "./_sections/StorageAndHistory";
import { CheckoutDrawer, type CheckoutIntent } from "./_sections/CheckoutDrawer";
import { ManagePlanDrawer } from "./_sections/ManagePlanDrawer";
import { formatDate } from "./_sections/format";
import { apiFetch } from "../../../lib/api";
// Route-owned presentation. Everything shared — the header, the panels, the
// responsive table, the action tiers — stays on the canonical app-* set.
import "./billing.css";
import {
  buildBillingHref,
  parseBillingWorkspaceLocator,
  type BillingWorkspaceLocator,
} from "../../../lib/navigation/billingWorkspaceLocator";

/**
 * The URL names the selected account through the CANONICAL billing locator —
 * the same `?workspace=` vocabulary Pricing and the team pages already build
 * with `buildBillingHref`. A private `?account=` param would have been a second
 * parser for one question, which is exactly what that module exists to prevent.
 */
function toLocator(a: BillingAccountRef): BillingWorkspaceLocator {
  if (a.type === "ORGANIZATION") return { kind: "organization", organizationId: a.id };
  return { kind: "personal" };
}

/**
 * Resolve a locator against the accounts the SERVER said this viewer may see.
 *
 * A locator naming an account that is not in that list resolves to `null` and
 * the page falls back to the first one: a URL can name a subject, but it can
 * never grant one.
 */
function accountFromLocator(
  locator: BillingWorkspaceLocator,
  accounts: BillingAccountRef[],
): BillingAccountRef | null {
  if (locator.kind === "personal") {
    return accounts.find((a) => a.type === "PERSONAL") ?? null;
  }
  if (locator.kind === "organization") {
    return (
      accounts.find(
        (a) => a.type === "ORGANIZATION" && a.id === locator.organizationId,
      ) ?? null
    );
  }
  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — a `?workspace=` link
  // naming a team resolves to NOTHING, and the page falls back to Personal.
  //
  // The locator vocabulary is shared with pages that legitimately name a
  // workspace, so the parser still understands the shape; what changed is that
  // no workspace is a billing account, so none can be selected. Returning null
  // rather than throwing keeps an old bookmark working — it lands on the
  // account the customer actually has, instead of an error about a subject
  // they never had.
  return null;
}

export default function BillingPage() {
  return (
    <PageRouteGate routeId="account.billing">
      <BillingPageInner />
    </PageRouteGate>
  );
}

type Phase =
  | { kind: "LOADING" }
  | { kind: "NO_ACCOUNTS" }
  | { kind: "READY" }
  | { kind: "ERROR"; title: string; message: string };

function BillingPageInner() {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const { stamp, isStale } = useTenantGuard();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [phase, setPhase] = useState<Phase>({ kind: "LOADING" });
  const [accounts, setAccounts] = useState<BillingAccountRef[]>([]);
  const [selected, setSelected] = useState<BillingAccountRef | null>(null);
  const [projection, setProjection] = useState<BillingAccountProjection | null>(null);

  const [history, setHistory] = useState<BillingHistoryEntry[]>([]);
  const [historyState, setHistoryState] =
    useState<"LOADING" | "READY" | "DENIED" | "ERROR">("LOADING");

  const [checkout, setCheckout] = useState<CheckoutIntent | null>(null);
  /*
   * THE ONE plan-management surface.
   *
   * Which one it is comes from the server (`actions.planManagement.mode`):
   * an account with no subscription is CHOOSING, one that has a subscription
   * is MANAGING it. The page opens whichever the server named rather than
   * inferring it from the plan.
   */
  const [managePlanOpen, setManagePlanOpen] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  // The plan key being changed to, so only that one button spins and a
  // second change cannot be started while the first is with the provider.
  const [changeBusyPlan, setChangeBusyPlan] = useState<string | null>(null);
  const [cancelAddonBusy, setCancelAddonBusy] = useState<string | null>(null);
  const [recheckBusy, setRecheckBusy] = useState(false);

  const requestedLocator = useMemo(
    () => parseBillingWorkspaceLocator(searchParams),
    [searchParams],
  );

  // ---- Accounts ----------------------------------------------------------
  useEffect(() => {
    const captured = stamp();
    let cancelled = false;

    listBillingAccounts()
      .then((list) => {
        if (cancelled || isStale(captured)) return;
        setAccounts(list);
        if (list.length === 0) {
          setPhase({ kind: "NO_ACCOUNTS" });
          return;
        }
        setSelected(accountFromLocator(requestedLocator, list) ?? list[0]!);
        setPhase({ kind: "READY" });
      })
      .catch((err) => {
        if (cancelled || isStale(captured)) return;
        captureException(err, { feature: "billing_accounts" });
        const safe = toSafeUserError(err, {
          message: "Billing could not be loaded just now.",
        });
        setPhase({ kind: "ERROR", title: safe.title, message: safe.message });
      });

    return () => {
      cancelled = true;
    };
    // `requestedLocator` intentionally excluded: it seeds the INITIAL
    // selection only. Re-running on every URL change would fight the selector.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, isStale]);

  // ---- The selected account's projection ----------------------------------
  const loadProjection = useCallback(
    async (account: BillingAccountRef) => {
      const captured = stamp();
      setProjection(null);
      try {
        const next = await readBillingAccount({
          type: account.type,
          id: account.id,
        });
        if (isStale(captured)) return;
        setProjection(next);
      } catch (err) {
        if (isStale(captured)) return;
        captureException(err, { feature: "billing_account_projection" });
        const safe = toSafeUserError(err, {
          message: "This billing account could not be loaded.",
        });
        setPhase({ kind: "ERROR", title: safe.title, message: safe.message });
      }
    },
    [stamp, isStale],
  );

  const loadHistory = useCallback(
    async (account: BillingAccountRef) => {
      const captured = stamp();
      setHistoryState("LOADING");
      try {
        const items = await readBillingHistory({
          type: account.type,
          id: account.id,
        });
        if (isStale(captured)) return;
        setHistory(items);
        setHistoryState("READY");
      } catch (err) {
        if (isStale(captured)) return;
        const status = (err as { statusCode?: number })?.statusCode;
        // A missing capability is a DENIAL, never an empty list — otherwise it
        // reads as "you have no payments".
        setHistoryState(status === 403 ? "DENIED" : "ERROR");
        if (status !== 403) {
          captureException(err, { feature: "billing_account_history" });
        }
      }
    },
    [stamp, isStale],
  );

  useEffect(() => {
    if (!selected) return;
    void loadProjection(selected);
    void loadHistory(selected);
  }, [selected, loadProjection, loadHistory]);

  const selectAccount = useCallback(
    (account: BillingAccountRef) => {
      setSelected(account);
      // The ONE sanctioned builder for a billing link that names a subject.
      router.replace(buildBillingHref(toLocator(account)), { scroll: false });
    },
    [router],
  );

  const refresh = useCallback(() => {
    if (!selected) return;
    void loadProjection(selected);
    void loadHistory(selected);
  }, [selected, loadProjection, loadHistory]);

  // ---- Outstanding storage add-on cancellations ---------------------------
  //
  // Its own action, not the base Cancel button shown again. The plan is
  // already cancelled; what is outstanding is the add-ons, and a control
  // offering to cancel the plan again would be offering to do something that
  // has already happened.
  const [addonRetryBusy, setAddonRetryBusy] = useState(false);
  const handleRetryStorageCancellation = useCallback(async () => {
    if (!selected || addonRetryBusy) return;
    setAddonRetryBusy(true);
    try {
      const result = await retryStorageCancellation(selected);
      addToast(
        result.outcome === "UPDATED"
          ? "Your storage add-ons are stopped. Nothing further will be charged for them."
          : result.supportRequired
            ? "We still could not stop every add-on. Support has been notified and is looking at it."
            : "We asked your payment provider again. We will keep retrying until it confirms.",
        result.outcome === "UPDATED" ? "success" : "info",
      );
      refresh();
    } catch (err) {
      captureException(err, { feature: "billing_addon_cancel_retry" });
      const safe = toSafeUserError(err, {
        message:
          "We could not reach your payment provider. Nothing has changed — we will keep retrying automatically.",
      });
      addToast(safe.message, "error");
    } finally {
      setAddonRetryBusy(false);
    }
  }, [selected, addonRetryBusy, addToast, refresh]);

  // ---- Cancellation ------------------------------------------------------
  const handleCancel = useCallback(async () => {
    if (!selected || !projection) return;

    // The copy states what the PROVIDER will actually do. The dialog this
    // replaces promised "ends at the current period" while the route called
    // Stripe's immediate DELETE.
    //
    // BILLING SURFACE CORRECTION (2026-08-29) — and it now states the whole
    // consequence, not just the part about the plan.
    //
    // Cancelling a subscription also cancels the RECURRING STORAGE ADD-ONS
    // that hang off it (`cancelDependentRecurringAddons`, in the same
    // transaction as the plan). A customer who is not told that finds out when
    // the capacity goes. And the fear this dialog actually raises is not about
    // the add-ons at all — it is whether the evidence survives. It does, and
    // saying so is the difference between a decision and a gamble.
    const recurringAddons = (projection.storageAddons?.active ?? []).filter(
      (addon) => !addon.legacyOneTime && addon.status === "ACTIVE",
    );
    const paidUntil = formatDate(projection.plan.currentPeriodEndUtc);

    const ok = await confirm({
      title: `Cancel ${projection.plan.displayName} for ${selected.displayName}?`,
      description: (
        <div style={{ display: "grid", gap: 10 }} data-billing-cancel-consequences>
          <p style={{ margin: 0 }}>
            We will ask your payment provider to stop renewing it.{" "}
            {paidUntil
              ? `You have paid through ${paidUntil}; where the provider supports it you keep ${projection.plan.displayName} until then, and we will confirm the exact date after they answer.`
              : "Where the provider supports it you keep your current plan until the end of the period you have already paid for, and we will confirm the exact date after they answer."}{" "}
            Nothing is charged again.
          </p>
          <ul style={{ margin: 0, paddingInlineStart: 20, display: "grid", gap: 6 }}>
            <li>
              Your evidence is not deleted. Records, custody history, hashes,
              signatures and verification packages all stay exactly as they are.
            </li>
            <li>
              {recurringAddons.length > 0
                ? `${recurringAddons.length} recurring storage add-on${
                    recurringAddons.length === 1 ? "" : "s"
                  } will be cancelled with it, so that extra capacity ends too.`
                : "You have no recurring storage add-ons, so nothing else is cancelled."}
            </li>
            <li>
              Your account moves to Free. You can subscribe again at any time.
            </li>
          </ul>
        </div>
      ),
      confirmLabel: "Cancel subscription",
      cancelLabel: "Keep subscription",
      tone: "danger",
      testId: "billing-cancel-subscription",
    });
    if (!ok) return;

    setCancelBusy(true);
    try {
      const outcome = await requestCancellation();
      const ends = formatDate(outcome.accessEndsAtUtc);
      addToast(
        outcome.result === "ACTION_REQUIRED"
          ? "Your plan is cancelled, but a storage add-on could not be stopped. Please contact support — it may still be charging."
          : outcome.mode === "PERIOD_END" && ends
            ? `Cancelled. You keep access until ${ends}.`
            : "Cancelled with your payment provider.",
        outcome.result === "ACTION_REQUIRED" ? "error" : "success",
      );
      refresh();
    } catch (err) {
      captureException(err, { feature: "billing_cancel" });
      const safe = toSafeUserError(err, {
        message:
          "We could not reach your payment provider. Nothing has changed — please try again shortly.",
      });
      addToast(safe.message, "error");
    } finally {
      setCancelBusy(false);
    }
  }, [selected, projection, confirm, addToast, refresh]);

  /**
   * Open whichever plan surface the SERVER says this account has.
   *
   * CHOOSE — no subscription yet, so the chooser: pick a tier and pay.
   * MANAGE / REVIEW_SCHEDULED — a subscription exists, so the manager: what it
   * is, how to move it, and how to end it.
   */
  const openPlanManagement = useCallback(() => {
    if (!projection) return;
    if (projection.actions.planManagement.mode === "CHOOSE") {
      setCheckout({ kind: "PLAN" });
      return;
    }
    setManagePlanOpen(true);
  }, [projection]);

  // ---- One payment's own lifecycle ---------------------------------------
  //
  // BILLING SURFACE CORRECTION (2026-08-29) — a pending row had no way to end.
  // These two ask the SERVER, which asks the provider; neither decides
  // anything here, and neither can present a local guess as a provider fact.
  const [paymentBusyId, setPaymentBusyId] = useState<string | null>(null);
  const [resumeUrls, setResumeUrls] = useState<Record<string, string>>({});

  const handleRecheckPayment = useCallback(
    async (entry: BillingHistoryEntry) => {
      if (!selected || paymentBusyId) return;
      setPaymentBusyId(entry.id);
      try {
        const result = await recheckPayment(selected, entry.id);

        setResumeUrls((current) => {
          const next = { ...current };
          if (result.resumeUrl) next[entry.id] = result.resumeUrl;
          // A link that is no longer offered is REMOVED, not left behind. A
          // stale "Resume payment" is worse than none: it sends a paying
          // customer to a page the provider has already closed.
          else delete next[entry.id];
          return next;
        });

        switch (result.outcome) {
          case "UPDATED":
            addToast("We checked with your provider and updated this payment.", "success");
            void loadHistory(selected);
            refresh();
            break;
          /*
           * WHY it failed decides what a customer should do about it, and
           * three of these four are not outages. Telling someone to try again
           * shortly when the provider has never heard of the reference, or
           * when it is refusing our credentials, sends them round a loop that
           * has no exit — which is the loop the abandon action exists to
           * break, and it is named here.
           */
          case "PROVIDER_UNAVAILABLE":
            addToast(
              "We couldn't verify this payment with your payment provider. Its status is still pending and nothing was changed in PROOVRA.",
              "error",
            );
            break;
          case "PROVIDER_REFERENCE_NOT_FOUND":
            addToast(
              "Your payment provider could not find this payment attempt. It stays pending in PROOVRA until you re-check it or abandon the local attempt.",
              "info",
            );
            break;
          case "PROVIDER_REFERENCE_INVALID":
            addToast(
              "This older payment attempt cannot be matched with your payment provider automatically. You can remove it from your active Billing view.",
              "info",
            );
            break;
          case "PROVIDER_AUTHORIZATION_FAILED":
            // An operator problem, not the customer's — and not one more
            // pressing of this button can fix. Support has been signalled by
            // the server; the customer is told plainly that waiting is not the
            // remedy.
            addToast(
              "We could not verify this payment because our connection to the payment provider needs attention. Our team has been notified. Nothing was changed in PROOVRA.",
              "error",
            );
            break;
          default:
            addToast(
              result.resumeUrl
                ? "This payment is still open with your provider. Use Resume payment to finish it."
                : "Your provider reports no change to this payment.",
              "info",
            );
        }
      } catch (err) {
        captureException(err, { feature: "billing_payment_recheck" });
        const safe = toSafeUserError(err, {
          message:
            "We could not check this payment with your provider. Nothing has changed — try again in a moment.",
        });
        addToast(safe.message, "error");
      } finally {
        setPaymentBusyId(null);
      }
    },
    [selected, paymentBusyId, addToast, loadHistory, refresh],
  );

  const handleCancelPayment = useCallback(
    async (entry: BillingHistoryEntry) => {
      if (!selected || paymentBusyId) return;

      const ok = await confirm({
        title: "Stop this payment?",
        description:
          // A provider CANCELLATION only reaches this dialog when the
          // provider really supports one, and it only succeeds on an
          // unsettled payment — so "nothing was taken" is a precondition the
          // server enforces, not a guess.
          "We will ask your payment provider to close it. It has not been paid, so nothing is being reversed. The record stays in your billing history.",
        confirmLabel: "Stop payment",
        cancelLabel: "Leave it open",
        tone: "danger",
        testId: "billing-cancel-payment",
      });
      if (!ok) return;

      setPaymentBusyId(entry.id);
      try {
        const result = await cancelPayment(selected, entry.id);
        setResumeUrls((current) => {
          const next = { ...current };
          delete next[entry.id];
          return next;
        });
        addToast(
          result.outcome === "ALREADY_FINISHED"
            ? "Your provider reports this payment had already finished. Nothing was changed."
            : "Your provider has closed this payment. Nothing was charged.",
          result.outcome === "ALREADY_FINISHED" ? "info" : "success",
        );
        void loadHistory(selected);
      } catch (err) {
        captureException(err, { feature: "billing_payment_cancel" });
        const safe = toSafeUserError(err, {
          message:
            "We could not reach your payment provider, so this payment is unchanged in PROOVRA.",
        });
        addToast(safe.message, "error");
      } finally {
        setPaymentBusyId(null);
      }
    },
    [selected, paymentBusyId, confirm, addToast, loadHistory],
  );

  /**
   * What the customer is told about an abandonment, by OUTCOME.
   *
   * Never "nothing has been charged": where the provider could not be asked,
   * that is a claim about money made from ignorance. What is always true is
   * what PROOVRA did.
   */
  const announceAbandonOutcome = useCallback(
    (outcome: string) => {
      switch (outcome) {
        case "ABANDONED":
        case "ALREADY_ABANDONED":
          addToast(
            "This payment attempt was removed from your active Billing view. Nothing was canceled or changed at your payment provider.",
            "success",
          );
          break;
        case "PROVIDER_ANSWERED":
          addToast(
            "Your payment provider told us what actually happened to this payment, so we recorded that instead.",
            "info",
          );
          break;
        case "ALREADY_FINISHED":
          addToast("This payment had already finished. Nothing was changed.", "info");
          break;
        default:
          addToast("This payment attempt is unchanged.", "info");
      }
    },
    [addToast],
  );


  /**
   * Give up on an attempt the provider cannot be asked to stop.
   *
   * TWO STEPS, and the second one only when the server asks for it.
   *
   * The first request lets the SERVER reconcile: if the provider proves the
   * payment settled, failed, was cancelled or expired, that truth is recorded
   * and the customer is told what actually happened. Only when the provider
   * cannot be asked at all does the server answer
   * ABANDON_CONFIRMATION_REQUIRED — and then the customer is shown exactly
   * what abandoning does and does not mean before they decide.
   *
   * What this replaces: one dialog that promised "no completed charge is
   * reversed, because there is none" before anyone had asked the provider,
   * followed by a 503 whenever the provider was unreachable — which is the one
   * case the action exists for.
   */
  const handleAbandonPayment = useCallback(
    async (entry: BillingHistoryEntry) => {
      if (!selected || paymentBusyId) return;

      setPaymentBusyId(entry.id);
      try {
        const first = await abandonPayment(selected, entry.id);

        if (first.outcome === "ABANDON_CONFIRMATION_REQUIRED") {
          // The server could not get an answer. Ask the customer the honest
          // question, with the server's own wording for what it could not
          // verify.
          const ok = await confirm({
            title: "Abandon this payment attempt?",
            description:
              (first.warning ??
                "Your payment provider could not be reached. This will remove the attempt from your active Billing view only.") +
              " If your provider later confirms a completed payment, PROOVRA will record it.",
            confirmLabel: "Abandon local attempt",
            cancelLabel: "Keep pending",
            // A warning, not a destruction: nothing is deleted and no money
            // moves. Red would be telling the customer something untrue to
            // discourage a legitimate choice.
            tone: "warning",
            testId: "billing-abandon-payment",
          });
          if (!ok) {
            setPaymentBusyId(null);
            return;
          }

          const confirmed = await abandonPayment(selected, entry.id, {
            confirmed: true,
          });
          announceAbandonOutcome(confirmed.outcome);
          void loadHistory(selected);
          return;
        }

        announceAbandonOutcome(first.outcome);
        void loadHistory(selected);
      } catch (err) {
        captureException(err, { feature: "billing_payment_abandon" });
        const safe = toSafeUserError(err, {
          message:
            "We could not complete that just now. This payment attempt is unchanged in PROOVRA.",
        });
        addToast(safe.message, "error");
      } finally {
        setPaymentBusyId(null);
      }
    },
    [selected, paymentBusyId, confirm, addToast, loadHistory, announceAbandonOutcome],
  );

  /**
   * "Re-check purchases and billing" — the ACCOUNT-wide provider sweep.
   *
   * Distinct from a row's own re-check: this asks about every binding the
   * server stored for this account. It was written inline in the JSX, which is
   * why the history panel could not be compact.
   */
  const handleAccountRecheck = useCallback(async () => {
    if (!selected || recheckBusy) return;
    setRecheckBusy(true);
    try {
      const result = await reconcileAccount(selected);
      switch (result.outcome) {
        case "UPDATED":
          addToast(
            "Your provider had something we had not recorded. Your billing is now up to date.",
            "success",
          );
          refresh();
          break;
        case "PENDING":
          addToast(
            "Your provider is still settling a payment. Check again in a few minutes — nothing is charged twice.",
            "info",
          );
          break;
        case "ACTION_REQUIRED":
          addToast(
            "Something on this account needs our help. Please contact support.",
            "error",
          );
          break;
        case "PROVIDER_UNAVAILABLE":
          addToast(
            "We could not reach your payment provider just now. Your billing records are unchanged.",
            "error",
          );
          break;
        default:
          addToast(
            "Everything on this account already matches your payment provider.",
            "success",
          );
      }
    } catch (err) {
      captureException(err, { feature: "billing_restore" });
      const safe = toSafeUserError(err, {
        message:
          "We could not check with your payment provider. Your billing records are unchanged — try again in a moment.",
      });
      addToast(safe.message, "error");
    } finally {
      setRecheckBusy(false);
    }
  }, [selected, recheckBusy, addToast, refresh]);

  // ---- Plan change -------------------------------------------------------
  //
  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — moving between tiers on
  // the subscription that already exists.
  //
  // The confirmation text is the SERVER's `effectSummary`, not a sentence
  // assembled here from the plan names. What a change does — charged pro rata
  // now, or taking effect when the paid period ends — depends on the
  // subscription and the provider, neither of which the browser can see. The
  // one thing this page adds is the promise that nothing is deleted, and even
  // that comes from the server string.
  const handleChangePlan = useCallback(
    async (offer: PlanOffer) => {
      if (changeBusyPlan) return;

      const ok = await confirm({
        title: offer.actionLabel + "?",
        description: offer.effectSummary,
        confirmLabel: offer.actionLabel,
        cancelLabel: "Keep current plan",
        // A downgrade is a WARNING, not a danger: nothing is destroyed by it,
        // and dressing it in the same red as "cancel my subscription" would be
        // telling the customer something untrue to discourage a legitimate
        // choice. An upgrade needs no colour at all.
        tone: offer.action === "DOWNGRADE" ? "warning" : "neutral",
        testId: "billing-change-plan",
      });
      if (!ok) return;

      setChangeBusyPlan(offer.planKey);
      try {
        const result = await changePlan({ plan: offer.planKey });

        // PayPal cannot revise an agreement without the buyer's authorisation,
        // so it hands back a link instead of a done deal. Saying "changed"
        // here would be claiming something the provider has not agreed to.
        if (result.approvalUrl) {
          window.location.assign(result.approvalUrl);
          return;
        }

        const on = formatDate(result.effectiveAtUtc ?? null);
        addToast(
          result.outcome === "UPGRADE"
            ? `You are on ${offer.displayName}.`
            : on
              ? `You will move to ${offer.displayName} on ${on}. Nothing changes until then.`
              : `You will move to ${offer.displayName} at the end of this billing period.`,
          "success",
        );
        refresh();
      } catch (err) {
        captureException(err, { feature: "billing_change_plan" });
        const safe = toSafeUserError(err, {
          message:
            "We could not reach your payment provider. Your plan has not changed — please try again shortly.",
        });
        addToast(safe.message, "error");
      } finally {
        setChangeBusyPlan(null);
      }
    },
    [changeBusyPlan, confirm, addToast, refresh],
  );

  const handleCancelAddon = useCallback(
    async (addonId: string) => {
      const ok = await confirm({
        title: "Cancel this storage add-on?",
        description:
          "It stops renewing at your provider. Evidence already stored is never deleted by cancelling an add-on — but if you are over your remaining capacity you will not be able to record new evidence until you free space or add capacity back.",
        confirmLabel: "Cancel add-on",
        cancelLabel: "Keep add-on",
        tone: "danger",
        testId: "billing-cancel-addon",
      });
      if (!ok) return;

      setCancelAddonBusy(addonId);
      try {
        await apiFetch("/v1/billing/storage-addons/cancel", {
          method: "POST",
          body: JSON.stringify({ addonId }),
        });
        addToast("Storage add-on cancelled", "success");
        refresh();
      } catch (err) {
        captureException(err, { feature: "billing_cancel_addon" });
        const safe = toSafeUserError(err, {
          message: "We could not cancel that add-on. Nothing has changed.",
        });
        addToast(safe.message, "error");
      } finally {
        setCancelAddonBusy(null);
      }
    },
    [confirm, addToast, refresh],
  );

  const header = useMemo(
    () => (
      <PageHeader
        title={
          /*
            BILLING UI REFINEMENT (2026-09-01) — a SPAN, not an <h1>.

            `PageHeader` renders its own <h1> around whatever `title` is given
            (its own contract says so: "header renders a single <h1>"). Passing
            an <h1> produced <h1><h1>Billing</h1></h1> — invalid heading
            structure, a hydration error logged on every load of this page, and
            two level-1 headings for anyone navigating by heading.

            Fixed at the CONSUMER rather than by relaxing the shell: the shell
            is right that a page has one <h1>, and other pages depend on it.
            The class and the probe attribute are kept so the styling and the
            existing contract tests are unaffected.
          */
          <span className="cc-title" data-billing-title>
            Billing
          </span>
        }
        subtitle={
          <span className="cc-subtitle" data-billing-subtitle>
            Your plan, what you have used, and what you have paid.
          </span>
        }
        primaryAction={
          /*
           * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — Pricing opens in
           * a NEW TAB.
           *
           * It is a reference page read WHILE deciding, not a destination. In
           * the same tab it replaced the Billing page, so anyone who followed
           * it to compare tiers lost their usage, their renewal date and any
           * half-finished checkout, and came back by pressing Back.
           *
           * `rel` is not optional with `target="_blank"`: without
           * `noopener` the opened page gets a `window.opener` handle back
           * into this one.
           */
          <a
            href="/pricing"
            target="_blank"
            rel="noopener noreferrer"
            className="app-header-primary-action"
            data-billing-view-pricing
          >
            <span>View pricing</span>
          </a>
        }
      />
    ),
    [],
  );

  if (phase.kind === "LOADING") {
    return (
      <PageShell data-billing-page header={header}>
        <PageSection>
          <div style={{ display: "grid", gap: 16 }}>
            <Skeleton width="100%" height="180px" />
            <Skeleton width="100%" height="160px" />
          </div>
        </PageSection>
      </PageShell>
    );
  }

  if (phase.kind === "ERROR") {
    return (
      <PageShell data-billing-page header={header}>
        <PageSection>
          <Card variant="status" tone="risk" role="alert" data-billing-error title={phase.title}>
            <p style={{ margin: 0, color: "var(--text-muted, #475569)" }}>{phase.message}</p>
            <div style={{ marginTop: 14 }}>
              <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
                Try again
              </Button>
            </div>
          </Card>
        </PageSection>
      </PageShell>
    );
  }

  if (phase.kind === "NO_ACCOUNTS" || !selected) {
    // A managed enterprise identity has no personal account and may hold no
    // billing authority anywhere. Saying so plainly beats an empty page.
    return (
      <PageShell data-billing-page header={header}>
        <PageSection>
          <div data-billing-no-accounts>
            <EmptyState
              framed
              title="Billing is managed for you"
              purpose="Your organization looks after billing for this account. Your administrator can make changes."
            />
          </div>
        </PageSection>
      </PageShell>
    );
  }

  return (
    <PageShell data-billing-page header={header}>
      {accounts.length > 1 ? (
        <PageSection>
          <AccountSelector
            accounts={accounts}
            selected={selected}
            onSelect={selectAccount}
          />
        </PageSection>
      ) : null}

      {!projection ? (
        <PageSection>
          <Skeleton width="100%" height="200px" />
        </PageSection>
      ) : (
        <>
          {/*
            THE COMPOSITION.

            What this replaces: seven full-width panels stacked down the page —
            plan, usage, credits, workspaces-and-teams, storage, history,
            support — each the width of the page and the height of a paragraph.
            The page was two and a half screens tall and almost none of it was
            information.

            One dominant overview answers the page's question. Below it a
            two-column grid puts the wide things (the evidence detail, the
            history table) beside the narrow ones (credits, storage,
            capabilities), so a fact the size of "0 of 2" occupies a row rather
            than a card. Support is a line.
          */}
          <div className="bill-page" data-billing-layout>
            <ActionRequiredBanner
              projection={projection}
              onRetryStorageCancellation={handleRetryStorageCancellation}
              retryBusy={addonRetryBusy}
            />

            <BillingOverview
              projection={projection}
              onManagePlan={() => openPlanManagement()}
              /*
                A granted account's way OUT of a tier it was given.

                It opens the ordinary new-subscription checkout on the plan the
                SERVER named — the same drawer, the same payment selector, the
                same request body as any other purchase. Deliberately not the
                plan-transition route: there is no provider subscription to
                transition, and a failed, cancelled or abandoned checkout
                therefore leaves the granted access exactly as it was.
              */
              onStartSubscription={(planKey) =>
                setCheckout({ kind: "PLAN", planKey })
              }
              changeBusyPlan={changeBusyPlan}
            />

            {/*
              BILLING UI REFINEMENT (2026-09-01) — the row order follows what a
              customer came to find out.

              The two-column grid put the billing-history TABLE in a column of
              its own, which made the longest, least-asked-about thing on the
              page the widest and tallest thing on it, while Evidence and
              Storage — the two allowances anyone actually opens Billing to
              check — were stacked one under the other in a narrow column
              beside it.

              They are the same KIND of fact and they are now the same row:
              two equal columns that align heading, value, track and action.
              History spans the full width beneath them, where a wide table
              belongs and where its width is a feature rather than a claim
              about its importance.
            */}
            <div className="bill-row" data-billing-row="allowances">
              <EvidenceDetailCard
                projection={projection}
                onBuyCredits={
                  projection.actions.canBuyEvidenceCredits
                    ? () => setCheckout({ kind: "CREDITS" })
                    : undefined
                }
                onChoosePlan={() => openPlanManagement()}
              />

              <StorageAddonsSection
                projection={projection}
                onManageStorage={() => setCheckout({ kind: "STORAGE" })}
                onChoosePlan={() => openPlanManagement()}
                onCancelAddon={(id) => void handleCancelAddon(id)}
                cancelBusyId={cancelAddonBusy}
              />
            </div>

            {/* The tier facts that are not meters, and the agreement, keep the
                same compact row treatment rather than becoming full-width
                cards carrying one value each. */}
            <div className="bill-row" data-billing-row="details">
              <PlanCapabilitiesCard projection={projection} />
              <EnterpriseContractCard projection={projection} />
            </div>

            <BillingHistorySection
              entries={history}
              state={historyState}
              onRetry={() => selected && void loadHistory(selected)}
              recheckBusy={recheckBusy}
              onRecheckPayment={(entry) => void handleRecheckPayment(entry)}
              onCancelPayment={(entry) => void handleCancelPayment(entry)}
              onAbandonPayment={(entry) => void handleAbandonPayment(entry)}
              rowBusyId={paymentBusyId}
              resumeUrls={resumeUrls}
              onRecheck={() => void handleAccountRecheck()}
            />

            {/*
              BILLING UI REFINEMENT (2026-09-01) — the way out, made visible.

              It was grey text on a grey surface with a grey link, at the bottom
              of the one page people reach when nothing above it answered their
              question. The link did not look like a control, and the sentence
              beside it — "Your billing records are the ones we act on" — was a
              vague reassurance about money rather than an offer of help.

              Still a STRIP and not a card: one compact row on desktop, stacking
              on a narrow screen. A support prompt at the same visual weight as
              the allowances above it would be the opposite mistake.
            */}
            <div className="bill-support-strip" data-billing-support>
              <span className="bill-support-strip__icon" aria-hidden="true">
                <LifeBuoy size={17} strokeWidth={2} />
              </span>
              <p className="bill-support-strip__copy">
                {projection.actions.contactAccountManager
                  ? "Changes to your agreement go through your account manager."
                  : "Something here not matching what you expected? We can look at it with you."}
              </p>
              <a
                /*
                 * "/support" is the destination the rest of the app already
                 * uses for exactly this — the error boundaries, the not-found
                 * page and the MFA challenge all send people there.
                 *
                 * It opens in a NEW TAB, and that is what stops it signing the
                 * customer out: `/support` lives OUTSIDE the `(app)` route
                 * group, so following it in the same tab tore down the
                 * authenticated shell — and the session token is held in
                 * MEMORY ONLY (lib/api.ts: "In-memory only … NEVER persist"),
                 * so that navigation destroyed the only copy of it.
                 */
                href={
                  projection.actions.contactAccountManager
                    ? "/contact-sales"
                    : "/support"
                }
                target="_blank"
                rel="noopener noreferrer"
                /* The Billing secondary treatment, on an ANCHOR: this must stay
                   a real link so the new tab, the middle-click and the context
                   menu all behave as a link, while looking like the button it
                   functionally is. */
                className="bill-support-strip__action ui-button bill-secondary-action"
                data-billing-support-action
              >
                {projection.actions.contactAccountManager
                  ? "Contact your account manager"
                  : "Get help"}
              </a>
            </div>
          </div>

          <ManagePlanDrawer
            open={managePlanOpen}
            projection={projection}
            onClose={() => setManagePlanOpen(false)}
            onChangePlan={(offer) => void handleChangePlan(offer)}
            onCancel={() => void handleCancel()}
            changeBusyPlan={changeBusyPlan}
            cancelBusy={cancelBusy}
          />

          <CheckoutDrawer
            open={checkout !== null}
            /* No plan is preselected: the chooser opens with nothing chosen
               and checkout refuses until the customer picks. */
            intent={checkout ?? { kind: "PLAN" }}
            projection={projection}
            onClose={() => setCheckout(null)}
            onCompleted={refresh}
            onError={(title, message) => addToast(`${title}: ${message}`, "error")}
          />
        </>
      )}
    </PageShell>
  );
}
