/**
 * BILLING — the native port of `apps/web/app/(app)/billing/page.tsx`, rebuilt
 * around the billing ACCOUNT as the web page is.
 *
 * ONE account at a time, chosen in a selector that only appears when there is
 * more than one. Everything below it — plan, usage, evidence, storage,
 * capabilities, agreement, history, actions — comes from the single
 * account-scoped projection (`GET /v1/billing/accounts/:type/:id`), so the
 * sections cannot disagree about who is paying. The legacy `/v1/billing/overview`
 * read the previous screen mixed in is gone: it described the caller, not the
 * selected account.
 *
 * READ and MANAGE are here in full: plan, usage, payments, the account-wide
 * provider re-check, a payment's re-check / stop / abandon, checking or
 * abandoning an open purchase, cancelling the subscription or a storage add-on,
 * and retrying an outstanding add-on cancellation. PURCHASE is not, in a store
 * build: starting or changing a plan, buying storage or credits and continuing
 * a provider checkout wait on the
 * distribution-policy decision (src/product/billing.ts). They exist only behind
 * `externalCheckoutEnabled()`, a private-distribution build flag. Prices and
 * plans are otherwise shown read-only in the pricing sheet.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { useFocusEffect, useRouter } from "expo-router";

import { apiFetch } from "../../src/api";
import { checkoutApprovalUrl, checkoutRequest, externalCheckoutEnabled, payPalReturnConfirmation, payPalReturnNotice, verifiedCheckoutUrl, type PurchaseIntent, type PurchaseProvider } from "../../src/product/billing-purchase";
import { ProovraSheet } from "../../src/ui/patterns";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { theme } from "../../src/theme/theme";
import {
  BILLING_ACCOUNTS_PATH,
  BILLING_ACCOUNT_KIND_LABEL,
  BILLING_MANAGED_COPY,
  STORAGE_ADDON_CANCEL_PATH,
  SUBSCRIPTION_CANCEL_PATH,
  buildBillingAccountPath,
  buildBillingHistoryPath,
  buildPaymentCancelPath,
  buildPaymentRecheckPath,
  buildRetryStorageCancellationPath,
  buildStorageAddonCancelBody,
  parseBillingAccounts,
  parsePaymentHistory,
  paymentCancelMessage,
  paymentRecheckMessage,
  PAYMENT_CANCEL_COPY,
  type BillingAccountRef,
  type PaymentRow,
} from "../../src/product/billing";
import {
  ADDON_CANCEL_COPY,
  BILLING_PAGE_COPY as COPY,
  CANCELLATION_UNCONFIRMED_COPY,
  abandonConfirmation,
  abandonMessage,
  attemptAbandonConfirmation,
  billingRefusalMessage,
  buildAbandonBody,
  buildAttemptAbandonPath,
  buildAttemptRecheckPath,
  buildPaymentAbandonPath,
  buildReconcilePath,
  cancellationOutcomeUnknown,
  describeAttemptAbandon,
  describeAttemptCheck,
  formatMoney,
  parseBillingProjection,
  reconcileMessage,
  parseBillingActivity,
  retryStorageMessage,
  storageAdditionalPrompt,
  storageRecoveryIntroduction,
  storageRefusalAction,
  subscriptionCancelConsequence,
  subscriptionCancelMessage,
  type ActiveAddonModel,
  type BillingProjection,
} from "../../src/product/billing-account";
import {
  buildPricingPath,
  parseEvidenceCreditOffer,
  parsePricingCatalogue,
  parseStorageAddons,
  type EvidenceCreditOffer,
  type PricingCatalogue,
  type StorageAddonOffer,
} from "../../src/product/pricing";
import { CONTACT_SALES_PATH } from "../../src/product/support";
import { webOrigin } from "../../src/product/intake-create";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraPageHeader,
  ProovraLoadingState,
  ProovraEmpty,
  ProovraFilterChips,
  ProovraConfirmSheet,
} from "../../src/ui";
import {
  BillingActionRequired,
  BillingCapabilitiesCard,
  BillingContractCard,
  BillingEvidenceCard,
  BillingOverviewCard,
  BillingStorageCard,
  BillingSupportStrip,
  billingDate,
} from "../../src/ui/billing-account-sections";
import { BillingAttemptActions, BillingHistoryCard, type AttemptNotice, type HistoryState } from "../../src/ui/billing-account-history";
import { ManagePlanSheet, PricingSheet } from "../../src/ui/billing-plan-sheets";

type Phase = { kind: "LOADING" } | { kind: "NO_ACCOUNTS" } | { kind: "READY" } | { kind: "ERROR"; error: SafeError };

type Confirm =
  | { kind: "subscription" }
  | { kind: "addon"; addon: ActiveAddonModel }
  | { kind: "payment-cancel"; row: PaymentRow }
  | { kind: "payment-abandon"; row: PaymentRow; message: string }
  | { kind: "attempt-abandon"; attemptId: string; warning: string; cancelsAtProvider: boolean }
  | null;

/** A refused storage purchase whose way forward is the attempt it names. */
type StorageRecovery = { attemptId: string; pendingProvider: string; createdAtUtc: string | null };

export default function BillingScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "LOADING" });
  const [accounts, setAccounts] = useState<BillingAccountRef[]>([]);
  const [selected, setSelected] = useState<BillingAccountRef | null>(null);
  const [projection, setProjection] = useState<BillingProjection | null>(null);
  const [history, setHistory] = useState<HistoryState>({ kind: "LOADING" });

  const [catalogue, setCatalogue] = useState<PricingCatalogue | null>(null);
  const [addonOffers, setAddonOffers] = useState<StorageAddonOffer[]>([]);
  const [credit, setCredit] = useState<EvidenceCreditOffer | null>(null);

  const [pricingOpen, setPricingOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [purchase, setPurchase] = useState<PurchaseIntent | null>(null);
  const [purchaseBusy, setPurchaseBusy] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const pendingPurchase = useRef<PurchaseIntent | null>(null);
  const pendingBrowserUrl = useRef<string | null>(null);
  const pendingReturn = useRef<ReturnType<typeof payPalReturnConfirmation>>(null);
  const checkoutInFlight = useRef(false);
  const privateCheckout = externalCheckoutEnabled();
  const [manageOpen, setManageOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recheckBusy, setRecheckBusy] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [addonBusyId, setAddonBusyId] = useState<string | null>(null);
  const [attemptBusyId, setAttemptBusyId] = useState<string | null>(null);
  const [attemptNotices, setAttemptNotices] = useState<Record<string, AttemptNotice>>({});
  const [recovery, setRecovery] = useState<StorageRecovery | null>(null);
  const [additional, setAdditional] = useState<{ provider: PurchaseProvider; activeCount: number } | null>(null);
  const projectionRead = useRef(0);
  const historyRead = useRef(0);

  /*
   * BILLING REMEDIATION (2026-10-31, AUD-19) — a BACKGROUND read keeps what is on
   * screen. Clearing it unmounted the cards mid-action and collapsed the page
   * behind a recovery answer; only a change of account starts from nothing. The
   * counter drops a slower answer that a newer read has already replaced.
   */
  const loadProjection = useCallback(async (account: BillingAccountRef, background = false) => {
    const read = ++projectionRead.current;
    if (!background) setProjection(null);
    try {
      const next = parseBillingProjection(await apiFetch(buildBillingAccountPath(account.type, account.id)));
      if (read === projectionRead.current) setProjection(next);
    } catch (err) {
      if (read !== projectionRead.current) return;
      if (background) setNotice("We could not refresh Billing just now, so this may be out of date.");
      else setPhase({ kind: "ERROR", error: toSafeUserError(err, { message: "This billing account could not be loaded." }) });
    }
  }, []);

  const loadHistory = useCallback(async (account: BillingAccountRef, background = false) => {
    const read = ++historyRead.current;
    if (!background) setHistory({ kind: "LOADING" });
    try {
      const body = await apiFetch(buildBillingHistoryPath(account.type, account.id));
      if (read !== historyRead.current) return;
      setHistory({ kind: "READY", rows: parsePaymentHistory(body), openPurchases: parseBillingActivity(body) });
    } catch (err) {
      if (read !== historyRead.current) return;
      // A missing capability is a DENIAL, never an empty list.
      const denied = (err as { statusCode?: number } | null)?.statusCode === 403;
      if (denied || !background) setHistory({ kind: denied ? "DENIED" : "ERROR" });
    }
  }, []);

  /*
   * The accounts, then the SELECTED one's projection and history. No accounts
   * means the organization handles billing — say so; never invent "FREE".
   */
  const loadAccounts = useCallback(async () => {
    setPhase({ kind: "LOADING" });
    try {
      const list = parseBillingAccounts(await apiFetch(BILLING_ACCOUNTS_PATH));
      setAccounts(list);
      if (list.length === 0) {
        setSelected(null);
        setPhase({ kind: "NO_ACCOUNTS" });
        return;
      }
      setSelected((prev) => list.find((a) => prev && a.type === prev.type && a.id === prev.id) ?? list[0] ?? null);
      setPhase({ kind: "READY" });
    } catch (err) {
      setPhase({ kind: "ERROR", error: toSafeUserError(err, { message: "Billing could not be loaded just now." }) });
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    if (!selected) return;
    setAttemptNotices({});
    setRecovery(null);
    void loadProjection(selected);
    void loadHistory(selected);
  }, [selected, loadProjection, loadHistory]);

  // The plan catalogue for the pricing sheet; never blocks the account.
  useEffect(() => {
    void apiFetch(buildPricingPath())
      .then((d) => {
        setCatalogue(parsePricingCatalogue(d));
        setAddonOffers(parseStorageAddons(d));
        setCredit(parseEvidenceCreditOffer(d));
      })
      .catch(() => setCatalogue(null));
  }, []);

  const refresh = useCallback(() => {
    if (!selected) return;
    void loadProjection(selected, true);
    void loadHistory(selected, true);
  }, [selected, loadProjection, loadHistory]);

  // Back from another screen: re-read, so an open purchase is where the server
  // says it is. The first focus is the mount, which has already loaded.
  const refreshOnFocus = useRef(refresh);
  refreshOnFocus.current = refresh;
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focused.current) refreshOnFocus.current();
      focused.current = true;
    }, []),
  );

  const openSupport = useCallback(() => {
    if (projection?.actions.contactAccountManager) {
      const origin = webOrigin();
      if (origin) {
        void Linking.openURL(`${origin}${CONTACT_SALES_PATH}`);
        return;
      }
    }
    router.push("/support");
  }, [projection, router]);

  const openSales = (() => {
    const origin = webOrigin();
    return origin ? () => void Linking.openURL(`${origin}${CONTACT_SALES_PATH}`) : null;
  })();

  const openPricingWebsite = useCallback(() => {
    const origin = webOrigin();
    if (!origin) { setNotice("Pricing website is not configured."); return; }
    void WebBrowser.openBrowserAsync(`${origin}/pricing`).catch(() => {
      setNotice("Could not open the pricing website. Please try again.");
    });
  }, []);

  /** Plan selection is distinct from the public pricing website. */
  const openPlanManagement = useCallback(() => {
    if (!projection) return;
    if (projection.actions.planManagement.mode === "CHOOSE") setPricingOpen(true);
    else setManageOpen(true);
  }, [projection]);

  const offerPurchase = useCallback((intent: PurchaseIntent) => {
    if (!privateCheckout || selected?.type !== "PERSONAL" || !projection) return;
    if (intent.kind === "CREDITS" && !projection.actions.canBuyEvidenceCredits) return;
    if (intent.kind === "STORAGE" && !projection.storageAddons?.offers.some(offer => offer.key === intent.addonKey)) return;
    if (
      intent.kind === "PLAN" &&
      !projection.planOffers.some(
        offer => offer.planKey.toUpperCase() === intent.plan
      )
    ) {
      setNotice("This plan is not available for your billing account.");
      return;
    }
    setPurchaseError(null);
    setNotice(null);

    if (pricingOpen || storageOpen || manageOpen) {
      pendingPurchase.current = intent;
      setPricingOpen(false);
      setStorageOpen(false);
      setManageOpen(false);
      return;
    }

    setPurchase(intent);
  }, [
    privateCheckout,
    selected,
    projection,
    pricingOpen,
    storageOpen,
    manageOpen
  ]);

  const finishSourceDismiss = useCallback(() => {
    const next = pendingPurchase.current;
    if (!next) return;

    pendingPurchase.current = null;
    setPurchase(next);
  }, []);

  const finishCheckoutDismiss = useCallback(() => {
    const url = pendingBrowserUrl.current;
    if (!url) return;

    pendingBrowserUrl.current = null;

    const confirmation = pendingReturn.current;
    pendingReturn.current = null;
    void WebBrowser.openBrowserAsync(url)
      .then(async () => {
        // BILLING PAYPAL INTEGRITY (2026-09-28) — the browser closed (returned,
        // cancelled or simply dismissed). Ask the server, which reads PayPal:
        // an approved credit order is captured, a subscription is applied,
        // an unapproved one grants nothing and says so.
        if (confirmation) {
          try {
            const response = await apiFetch(confirmation.path, { method: "POST", body: "{}" });
            setNotice(payPalReturnNotice(confirmation.kind, response));
          } catch (err) {
            const e = err as { code?: unknown; statusCode?: unknown };
            setNotice(payPalReturnNotice(confirmation.kind, null, { code: e.code, statusCode: e.statusCode }));
          }
        } else {
          setNotice("Payment may still be pending. PROOVRA confirms it with your provider automatically; refresh Billing in a few minutes.");
        }
        refresh();
      })
      .catch((err) => {
        console.error("[billing] Browser presentation failed", err);
        setNotice(
          "Could not open the payment provider. Check pending payments before retrying."
        );
        refresh();
      });
  }, [refresh]);

  const choosePlan = useCallback((plan: "PRO" | "TEAM") => {
    if (!projection || !selected || selected.type !== "PERSONAL") return;
    // The server still makes the final transition decision; granted access is not provider-backed.
    offerPurchase({ kind: "PLAN", plan, transition: projection.plan.accessKind === "SUBSCRIPTION" });
  }, [projection, selected, offerPurchase]);

  const executePurchase = useCallback(async (provider: PurchaseProvider, confirmAdditional = false) => {
    if (checkoutInFlight.current) return;

    if (
      !purchase ||
      !selected ||
      selected.type !== "PERSONAL" ||
      !privateCheckout
    ) {
      setPurchaseError(
        "Checkout is unavailable for this billing account."
      );
      return;
    }

    checkoutInFlight.current = true;
    setPurchaseBusy(true);
    setPurchaseError(null);
    setAdditional(null);
    setNotice(null);
    try {
      const request = checkoutRequest(
        purchase.kind === "STORAGE" && confirmAdditional
          ? { ...purchase, confirmAdditional, ...(additional ? { heldCount: additional.activeCount } : {}) }
          : purchase,
        provider,
        catalogue?.currency,
      );
      let response: unknown;
      try {
        response = await apiFetch(request.path, { method: "POST", body: JSON.stringify(request.body) });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (purchase.kind === "PLAN" && !purchase.transition && code === "SUBSCRIPTION_ALREADY_ACTIVE") {
          // BILLING PAYPAL INTEGRITY (2026-09-28) — a refused purchase is not
          // permission to change the existing subscription. A plan change has
          // its own confirmation (timing, provider approval); it is never
          // substituted silently.
          setPurchaseError("You already have a subscription. Use Manage plan to change it instead of buying a second one.");
          refresh();
          return;
        } else if (purchase.kind === "PLAN" && purchase.transition && code === "CHECKOUT_REQUIRED") {
          const fresh = checkoutRequest({ ...purchase, transition: false }, provider, catalogue?.currency);
          response = await apiFetch(fresh.path, { method: "POST", body: JSON.stringify(fresh.body) });
        } else { throw err; }
      }
      const result = response as { outcome?: string; approvalUrl?: string | null } | null;
      if (result?.outcome === "NO_CHANGE") { setNotice("Your plan is already active."); setPurchase(null); refresh(); return; }
      if (result?.outcome === "PROVIDER_TRANSITION_IN_PROGRESS") { setNotice("Your plan change is pending provider confirmation."); setPurchase(null); refresh(); return; }
      const url = result?.approvalUrl
        ? verifiedCheckoutUrl(result.approvalUrl)
        : checkoutApprovalUrl(response, provider);
      if (url) {
        pendingBrowserUrl.current = url;
        pendingReturn.current = payPalReturnConfirmation(response, provider);
        setPurchase(null);
      } else {
        // A provider may have created a pending attempt; never silently retry it.
        setPurchaseError(result?.outcome
          ? `Plan change: ${result.outcome}. Refresh billing to check its confirmed status.`
          : "No verified payment link was returned. Check payment history before trying again.");
        refresh();
      }
    } catch (err) {
      // A storage refusal with a way forward is answered by that way forward.
      const action = purchase.kind === "STORAGE" ? storageRefusalAction(err) : null;
      if (action?.kind === "CONFIRM_ADDITIONAL") {
        setAdditional({ provider, activeCount: action.activeCount });
      } else if (action?.kind === "RECOVER") {
        setRecovery({ attemptId: action.attemptId, pendingProvider: action.pendingProvider, createdAtUtc: action.createdAtUtc });
        setPurchase(null);
        refresh();
      } else {
        setPurchaseError(
          billingRefusalMessage(err) ??
            toSafeUserError(err, { message: "Checkout could not be started. No purchase was confirmed. Check pending payments before retrying." }).message,
        );
        refresh();
      }
    } finally {
      checkoutInFlight.current = false;
      setPurchaseBusy(false);
    }
  }, [purchase, selected, privateCheckout, catalogue, refresh, additional]);

  /* ---------------------------------------------------------- actions */

  const retryStorageCancellation = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await apiFetch(buildRetryStorageCancellationPath(selected.type, selected.id), { method: "POST", body: "{}" });
      setNotice(retryStorageMessage(result).message);
      refresh();
    } catch (err) {
      setNotice(toSafeUserError(err, { message: "We could not reach your payment provider. Nothing has changed — we will keep retrying automatically." }).message);
    } finally {
      setBusy(false);
    }
  }, [selected, refresh]);

  const cancelSubscription = useCallback(async () => {
    setConfirm(null);
    setManageOpen(false);
    setBusy(true);
    setNotice(null);
    try {
      const result = await apiFetch(SUBSCRIPTION_CANCEL_PATH, { method: "POST", body: JSON.stringify({}) });
      setNotice(subscriptionCancelMessage(result, billingDate).message);
      refresh();
    } catch (err) {
      setNotice(
        cancellationOutcomeUnknown(err)
          ? CANCELLATION_UNCONFIRMED_COPY
          : toSafeUserError(err, { message: CANCELLATION_UNCONFIRMED_COPY }).message,
      );
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const cancelAddon = useCallback(
    async (addon: ActiveAddonModel) => {
      setConfirm(null);
      setAddonBusyId(addon.id);
      setNotice(null);
      try {
        await apiFetch(STORAGE_ADDON_CANCEL_PATH, { method: "POST", body: JSON.stringify(buildStorageAddonCancelBody(addon.id)) });
        setNotice(ADDON_CANCEL_COPY.done);
        refresh();
      } catch (err) {
        setNotice(toSafeUserError(err, { message: ADDON_CANCEL_COPY.failed }).message);
      } finally {
        setAddonBusyId(null);
      }
    },
    [refresh],
  );

  const recheckAccount = useCallback(async () => {
    if (!selected || recheckBusy) return;
    setRecheckBusy(true);
    setHistoryNotice(null);
    try {
      const result = reconcileMessage(await apiFetch(buildReconcilePath(selected.type, selected.id), { method: "POST", body: "{}" }));
      setHistoryNotice(result.message);
      if (result.refresh) refresh();
    } catch (err) {
      const status = (err as { statusCode?: unknown }).statusCode;
      if (status === 409 || status === 429) {
        setHistoryNotice(reconcileMessage({ outcome: status === 409 ? "BUSY" : "RATE_LIMITED", summary: null }).message);
        return;
      }
      setHistoryNotice(
        toSafeUserError(err, { message: "We could not check with your payment provider. Your billing records are unchanged — try again in a moment." }).message,
      );
    } finally {
      setRecheckBusy(false);
    }
  }, [selected, recheckBusy, refresh]);

  const recheckPayment = useCallback(
    async (row: PaymentRow) => {
      if (!selected || rowBusyId) return;
      setRowBusyId(row.id);
      setHistoryNotice(null);
      try {
        const result = await apiFetch(buildPaymentRecheckPath(selected.type, selected.id, row.id), { method: "POST", body: "{}" });
        setHistoryNotice(paymentRecheckMessage(result).message);
        if ((result as { outcome?: string } | null)?.outcome === "UPDATED") refresh();
      } catch (err) {
        setHistoryNotice(toSafeUserError(err, { message: "We could not check this payment with your provider. Nothing has changed — try again in a moment." }).message);
      } finally {
        setRowBusyId(null);
      }
    },
    [selected, rowBusyId, refresh],
  );

  const stopPayment = useCallback(
    async (row: PaymentRow) => {
      if (!selected) return;
      setConfirm(null);
      setRowBusyId(row.id);
      setHistoryNotice(null);
      try {
        const result = await apiFetch(buildPaymentCancelPath(selected.type, selected.id, row.id), { method: "POST", body: "{}" });
        setHistoryNotice(paymentCancelMessage(result).message);
        void loadHistory(selected);
      } catch (err) {
        setHistoryNotice(toSafeUserError(err, { message: "We could not reach your payment provider, so this payment is unchanged in PROOVRA." }).message);
      } finally {
        setRowBusyId(null);
      }
    },
    [selected, loadHistory],
  );

  /**
   * TWO STEPS, the second only when the server asks: the first request lets
   * the server reconcile; only ABANDON_CONFIRMATION_REQUIRED asks the customer.
   */
  const abandonPayment = useCallback(
    async (row: PaymentRow, confirmed: boolean) => {
      if (!selected) return;
      setConfirm(null);
      setRowBusyId(row.id);
      setHistoryNotice(null);
      try {
        const result = await apiFetch(buildPaymentAbandonPath(selected.type, selected.id, row.id), {
          method: "POST",
          body: JSON.stringify(buildAbandonBody(confirmed)),
        });
        const outcome = (result as { outcome?: string } | null)?.outcome ?? null;
        if (!confirmed && outcome === "ABANDON_CONFIRMATION_REQUIRED") {
          setConfirm({ kind: "payment-abandon", row, message: abandonConfirmation(result) });
          return;
        }
        setHistoryNotice(abandonMessage(outcome).message);
        void loadHistory(selected);
      } catch (err) {
        setHistoryNotice(toSafeUserError(err, { message: "We could not complete that just now. This payment attempt is unchanged in PROOVRA." }).message);
      } finally {
        setRowBusyId(null);
      }
    },
    [selected, loadHistory],
  );

  const noteAttempt = useCallback((attemptId: string, next: AttemptNotice) => {
    setAttemptNotices((prev) => ({ ...prev, [attemptId]: next }));
  }, []);

  /** A failed action says what went wrong and leaves the last answer's controls alone. */
  const noteAttemptFailure = useCallback((attemptId: string, err: unknown, message: string) => {
    const text = billingRefusalMessage(err) ?? toSafeUserError(err, { message }).message;
    setAttemptNotices((prev) => ({
      ...prev,
      [attemptId]: { ...(prev[attemptId] ?? { state: null, resumeUrl: null, canAbandon: true }), message: text },
    }));
  }, []);

  const checkAttempt = useCallback(
    async (attemptId: string) => {
      if (!selected || attemptBusyId) return;
      setAttemptBusyId(attemptId);
      try {
        const result = await apiFetch(buildAttemptRecheckPath(selected.type, selected.id, attemptId), { method: "POST", body: "{}" });
        const check = describeAttemptCheck(result, { resumeAllowed: privateCheckout });
        noteAttempt(attemptId, { message: check.message, state: check.state, resumeUrl: check.resumeUrl, canAbandon: check.canAbandon });
        if (!check.blocked) {
          setRecovery((prev) => (prev?.attemptId === attemptId ? null : prev));
          setNotice(check.message);
        }
        refresh();
      } catch (err) {
        noteAttemptFailure(attemptId, err, "We could not check this purchase just now. Try again in a moment.");
      } finally {
        setAttemptBusyId(null);
      }
    },
    [selected, attemptBusyId, privateCheckout, noteAttempt, noteAttemptFailure, refresh],
  );

  /** The provider's own page, on a build that may hand one over; then ask the server. */
  const continueAttempt = useCallback(
    (attemptId: string, url: string) => {
      const checked = verifiedCheckoutUrl(url);
      if (!privateCheckout || !checked) return;
      void WebBrowser.openBrowserAsync(checked)
        .then(() => checkAttempt(attemptId))
        .catch(() => setNotice("Could not open the payment provider. Check status before trying again."));
    },
    [privateCheckout, checkAttempt],
  );

  /** TWO STEPS, as for a payment: only the server's answer asks the customer. */
  const abandonAttempt = useCallback(
    async (attemptId: string, confirmed: boolean) => {
      if (!selected) return;
      setConfirm(null);
      setAttemptBusyId(attemptId);
      try {
        const result = await apiFetch(buildAttemptAbandonPath(selected.type, selected.id, attemptId), {
          method: "POST",
          body: JSON.stringify(buildAbandonBody(confirmed)),
        });
        if ((result as { outcome?: string } | null)?.outcome === "ABANDON_CONFIRMATION_REQUIRED") {
          setConfirm({ kind: "attempt-abandon", attemptId, ...attemptAbandonConfirmation(result) });
          return;
        }
        const done = describeAttemptAbandon(result);
        noteAttempt(attemptId, { message: done.message, state: done.state, resumeUrl: null, canAbandon: done.canAbandon });
        if (done.resolved) {
          setRecovery((prev) => (prev?.attemptId === attemptId ? null : prev));
          setNotice(done.message);
        }
        refresh();
      } catch (err) {
        noteAttemptFailure(attemptId, err, "We could not abandon this purchase just now. It is still open.");
      } finally {
        setAttemptBusyId(null);
      }
    },
    [selected, noteAttempt, noteAttemptFailure, refresh],
  );

  const attemptHandlers = {
    onCheckAttempt: (attemptId: string) => void checkAttempt(attemptId),
    onAbandonAttempt: (attemptId: string) => void abandonAttempt(attemptId, false),
    onContinueAttempt: continueAttempt,
    onSupport: openSupport,
    attemptBusyId,
    attemptNotices,
  };
  const recoveryRow = history.kind === "READY" ? history.openPurchases?.find((a) => a.id === recovery?.attemptId) ?? null : null;
  const additionalOffer = purchase?.kind === "STORAGE" ? projection?.storageAddons?.offers.find((o) => o.key === purchase.addonKey) ?? null : null;

  /* ------------------------------------------------------------ render */

  const pricingRelevant = phase.kind !== "NO_ACCOUNTS" && selected !== null && projection?.plan.accessKind !== "CONTRACT";

  return (
    <ProovraScreen shell testID="billing">
      <ProovraPageHeader
        title={COPY.title}
        subtitle={COPY.subtitle}
        primaryAction={
          pricingRelevant ? <ProovraButton label="View Pricing" fullWidth={false} onPress={openPricingWebsite} /> : undefined
        }
        secondaryActions={<ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />}
      />

      {phase.kind === "LOADING" ? <ProovraLoadingState label="Loading billing" /> : null}

      {phase.kind === "ERROR" ? (
        <ProovraCard testID="billing-error" style={{ gap: theme.space.s2 }}>
          <ProovraText variant="body" weight="semibold" color={theme.color.status.risk.fg}>{phase.error.title}</ProovraText>
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{phase.error.message}</ProovraText>
          <ProovraButton label="Try again" variant="secondary" fullWidth={false} onPress={() => void loadAccounts()} />
        </ProovraCard>
      ) : null}

      {phase.kind === "NO_ACCOUNTS" ? <ProovraEmpty title={BILLING_MANAGED_COPY.title} purpose={BILLING_MANAGED_COPY.body} /> : null}

      {phase.kind === "READY" && selected ? (
        <>
          {/* AccountSelector.tsx — only when there is a choice to make. */}
          {accounts.length >= 2 ? (
            <ProovraFilterChips
              label="Billing account"
              value={`${selected.type}:${selected.id}`}
              onChange={(v) => {
                const next = accounts.find((a) => `${a.type}:${a.id}` === v) ?? null;
                if (next) setSelected(next);
              }}
              options={accounts.map((a) => ({
                value: `${a.type}:${a.id}`,
                label: `${a.displayName} · ${BILLING_ACCOUNT_KIND_LABEL[a.type]}`,
              }))}
            />
          ) : null}

          {!projection ? (
            <ProovraLoadingState label="Loading plan" />
          ) : (
            <View style={{ gap: theme.space.s4 }}>
              {notice ? (
                <ProovraText variant="bodySm" color={theme.color.ink.primary} testID="billing-notice">
                  {notice}
                </ProovraText>
              ) : null}

              {recovery ? (
                <ProovraCard testID="billing-storage-recovery" style={{ gap: theme.space.s2 }}>
                  <ProovraText variant="bodySm">
                    {storageRecoveryIntroduction(recovery.pendingProvider, billingDate(recovery.createdAtUtc))}
                  </ProovraText>
                  <BillingAttemptActions
                    attemptId={recovery.attemptId}
                    label="open storage purchase"
                    canRecheck={recoveryRow ? recoveryRow.canRecheck : true}
                    canAbandon={recoveryRow ? recoveryRow.canAbandon : true}
                    state={recoveryRow?.state ?? null}
                    handlers={attemptHandlers}
                  />
                </ProovraCard>
              ) : null}

              <BillingActionRequired projection={projection} onRetry={() => void retryStorageCancellation()} onSupport={() => router.push("/support")} busy={busy} />

              <BillingOverviewCard
                projection={projection}
                onManagePlan={openPlanManagement}
                onUpgradeToTeam={
                  privateCheckout && selected.type === "PERSONAL" &&
                  projection.plan.planKey === "PRO" &&
                  projection.planOffers.some(
                    offer => offer.planKey.toUpperCase() === "TEAM"
                  ) &&
                  projection.actions.planManagement.enabled &&
                  !projection.plan.providerTransition && (!projection.plan.scheduledChange || projection.plan.scheduledChange.awaitingApproval)
                    ? () => choosePlan("TEAM") : undefined
                }
              />

              <BillingEvidenceCard projection={projection} onChoosePlan={openPlanManagement} onOpenReports={() => router.push("/reports" as never)} onBuyCredits={privateCheckout && selected.type === "PERSONAL" && credit ? () => offerPurchase({ kind: "CREDITS" }) : undefined} />

              <BillingStorageCard
                projection={projection}
                onChoosePlan={openPlanManagement}
                onCancelAddon={(addon) => setConfirm({ kind: "addon", addon })}
                cancelBusyId={addonBusyId}
                onBuyStorage={privateCheckout && selected.type === "PERSONAL" ? () => setStorageOpen(true) : undefined}
              />

              <BillingCapabilitiesCard projection={projection} />
              <BillingContractCard projection={projection} />

              <BillingHistoryCard
                state={history}
                accessKind={projection.plan.accessKind}
                onRetry={() => void loadHistory(selected)}
                onRecheckAccount={() => void recheckAccount()}
                recheckBusy={recheckBusy}
                onRecheckPayment={(row) => void recheckPayment(row)}
                onCancelPayment={(row) => setConfirm({ kind: "payment-cancel", row })}
                onAbandonPayment={(row) => void abandonPayment(row, false)}
                rowBusyId={rowBusyId}
                notice={historyNotice}
                attempts={attemptHandlers}
                resumeAllowed={privateCheckout}
              />

              <BillingSupportStrip projection={projection} onPress={openSupport} />

              <ManagePlanSheet
                visible={manageOpen}
                projection={projection}
                onClose={() => setManageOpen(false)}
                onCancelSubscription={() => {
                  setManageOpen(false);
                  setConfirm({ kind: "subscription" });
                }}
                cancelBusy={busy}
                onViewPlans={
                  privateCheckout &&
                  selected.type === "PERSONAL" &&
                  projection.hasPlanOffers &&
                  projection.actions.planManagement.enabled
                    ? () => {
                        setManageOpen(false);
                        setPricingOpen(true);
                      }
                    : undefined
                }
              />
            </View>
          )}
        </>
      ) : null}

      <PricingSheet
        visible={pricingOpen}
        onClose={() => setPricingOpen(false)}
        onDismiss={finishSourceDismiss}
        catalogue={catalogue}
        addons={addonOffers}
        credit={credit}
        currentPlan={projection?.plan.planKey ?? null}
        onTalkToSales={openSales}
        onChoosePlan={privateCheckout && selected?.type === "PERSONAL" && projection?.hasPlanOffers ? choosePlan : undefined}
      />

      {privateCheckout && selected?.type === "PERSONAL" && projection?.storageAddons?.offers.length ? (
        <ProovraSheet
          visible={storageOpen && !purchase}
          title="Available storage"
          onClose={() => setStorageOpen(false)}
          onDismiss={finishSourceDismiss}
        >
          <View style={{ gap: theme.space.s2 }}>
            {projection.storageAddons.offers.map(offer => {
              const published = addonOffers.find(a => a.key === offer.key);
              // The offer's OWN price and currency (the account projection's),
              // falling back to the published catalogue only for the amount.
              const priceCents = offer.priceCents ?? published?.priceCents ?? null;
              const currency = offer.currency ?? null;
              return <ProovraButton key={offer.key} label={`Buy ${offer.label}${priceCents != null && currency ? ` · ${(priceCents / 100).toFixed(2)} ${currency}/month` : ""}`} variant="secondary" onPress={() => offerPurchase({ kind: "STORAGE", addonKey: offer.key, currency })} />;
            })}
          </View>
        </ProovraSheet>
      ) : null}
      <ProovraSheet
        visible={purchase !== null}
        title="Choose payment method"
        onClose={() => {
          if (!purchaseBusy) {
            setPurchase(null);
            setPurchaseError(null);
            setAdditional(null);
          }
        }}
        onDismiss={finishCheckoutDismiss}
      >
        <View style={{ gap: theme.space.s3 }}>
          <ProovraText variant="bodySm">You will complete payment with your selected provider. Access changes only after PROOVRA confirms the payment.</ProovraText>
          {purchaseError ? (
            <ProovraText variant="bodySm" color={theme.color.status.risk.fg} testID="billing-purchase-error">{purchaseError}</ProovraText>
          ) : null}
          {additional ? (
            <>
              <ProovraText variant="bodySm" testID="billing-storage-additional">
                {storageAdditionalPrompt(additional.activeCount, formatMoney(additionalOffer?.priceCents, additionalOffer?.currency))}
              </ProovraText>
              <ProovraButton label="Add another" loading={purchaseBusy} onPress={() => void executePurchase(additional.provider, true)} />
            </>
          ) : (
            <>
              <ProovraButton label="Pay with Stripe" loading={purchaseBusy} onPress={() => void executePurchase("stripe")} />
              <ProovraButton label="Pay with PayPal" loading={purchaseBusy} onPress={() => void executePurchase("paypal")} />
            </>
          )}
          <ProovraButton label="Cancel" variant="ghost" onPress={() => { if (!purchaseBusy) { setPurchase(null); setPurchaseError(null); setAdditional(null); } }} />
        </View>
      </ProovraSheet>
      <ProovraConfirmSheet
        visible={confirm !== null}
        title={
          confirm?.kind === "subscription" && projection && selected
            ? `Cancel ${projection.plan.displayName} for ${selected.displayName}?`
            : confirm?.kind === "addon"
              ? ADDON_CANCEL_COPY.title
              : confirm?.kind === "payment-cancel"
                ? PAYMENT_CANCEL_COPY.title
                : confirm?.kind === "payment-abandon"
                  ? "Abandon this payment attempt?"
                  : confirm?.kind === "attempt-abandon"
                    ? "Abandon this purchase?"
                    : ""
        }
        consequence={
          confirm?.kind === "subscription" && projection
            ? subscriptionCancelConsequence(projection, billingDate(projection.plan.currentPeriodEndUtc)).join("\n\n")
            : confirm?.kind === "addon"
              ? ADDON_CANCEL_COPY.body
              : confirm?.kind === "payment-cancel"
                ? PAYMENT_CANCEL_COPY.body
                : confirm?.kind === "payment-abandon"
                  ? confirm.message
                  : confirm?.kind === "attempt-abandon"
                    ? confirm.warning
                    : undefined
        }
        confirmLabel={
          confirm?.kind === "subscription"
            ? "Cancel subscription"
            : confirm?.kind === "addon"
              ? ADDON_CANCEL_COPY.confirm
              : confirm?.kind === "payment-cancel"
                ? PAYMENT_CANCEL_COPY.confirm
                : confirm?.kind === "attempt-abandon"
                  ? confirm.cancelsAtProvider ? "Close checkout" : "Abandon in PROOVRA"
                  : "Abandon local attempt"
        }
        cancelLabel={
          confirm?.kind === "subscription"
            ? "Keep subscription"
            : confirm?.kind === "addon"
              ? ADDON_CANCEL_COPY.cancel
              : confirm?.kind === "payment-cancel"
                ? PAYMENT_CANCEL_COPY.cancel
                : confirm?.kind === "attempt-abandon"
                  ? "Keep it"
                  : "Keep pending"
        }
        // An abandonment is a warning, not a destruction: nothing is deleted and no money moves.
        tone={confirm?.kind === "payment-abandon" || confirm?.kind === "attempt-abandon" ? "warning" : "danger"}
        busy={busy || rowBusyId !== null || attemptBusyId !== null}
        onConfirm={() => {
          const c = confirm;
          if (!c) return;
          if (c.kind === "subscription") void cancelSubscription();
          else if (c.kind === "addon") void cancelAddon(c.addon);
          else if (c.kind === "payment-cancel") void stopPayment(c.row);
          else if (c.kind === "attempt-abandon") void abandonAttempt(c.attemptId, true);
          else void abandonPayment(c.row, true);
        }}
        onCancel={() => setConfirm(null)}
      />
    </ProovraScreen>
  );
}

