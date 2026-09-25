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
 * provider re-check, a payment's re-check / stop / abandon, cancelling the
 * subscription or a storage add-on, and retrying an outstanding add-on
 * cancellation. PURCHASE is not: starting or changing a plan, buying storage
 * or credits and resuming a provider checkout wait on the distribution-policy
 * decision (src/product/billing.ts). Prices and plans are shown read-only in
 * the pricing sheet.
 */
import { useCallback, useEffect, useState } from "react";
import { Linking, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { useRouter } from "expo-router";

import { apiFetch } from "../../src/api";
import { checkoutApprovalUrl, checkoutRequest, externalCheckoutEnabled, type PurchaseIntent, type PurchaseProvider } from "../../src/product/billing-purchase";
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
  abandonConfirmation,
  abandonMessage,
  buildAbandonBody,
  buildPaymentAbandonPath,
  buildReconcilePath,
  parseBillingProjection,
  reconcileMessage,
  retryStorageMessage,
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
import { BillingHistoryCard, type HistoryState } from "../../src/ui/billing-account-history";
import { ManagePlanSheet, PricingSheet } from "../../src/ui/billing-plan-sheets";

type Phase = { kind: "LOADING" } | { kind: "NO_ACCOUNTS" } | { kind: "READY" } | { kind: "ERROR"; error: SafeError };

type Confirm =
  | { kind: "subscription" }
  | { kind: "addon"; addon: ActiveAddonModel }
  | { kind: "payment-cancel"; row: PaymentRow }
  | { kind: "payment-abandon"; row: PaymentRow; message: string }
  | null;

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
  const privateCheckout = externalCheckoutEnabled();
  const [manageOpen, setManageOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recheckBusy, setRecheckBusy] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [addonBusyId, setAddonBusyId] = useState<string | null>(null);

  const loadProjection = useCallback(async (account: BillingAccountRef) => {
    setProjection(null);
    try {
      setProjection(parseBillingProjection(await apiFetch(buildBillingAccountPath(account.type, account.id))));
    } catch (err) {
      setPhase({ kind: "ERROR", error: toSafeUserError(err, { message: "This billing account could not be loaded." }) });
    }
  }, []);

  const loadHistory = useCallback(async (account: BillingAccountRef) => {
    setHistory({ kind: "LOADING" });
    try {
      setHistory({ kind: "READY", rows: parsePaymentHistory(await apiFetch(buildBillingHistoryPath(account.type, account.id))) });
    } catch (err) {
      // A missing capability is a DENIAL, never an empty list.
      setHistory({ kind: (err as { statusCode?: number } | null)?.statusCode === 403 ? "DENIED" : "ERROR" });
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
    void loadProjection(selected);
    void loadHistory(selected);
  }, [selected, loadProjection, loadHistory]);

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

  /** CHOOSE is the plan chooser — a purchase — so it opens the read-only pricing instead. */
  const openPlanManagement = useCallback(() => {
    if (!projection) return;
    if (projection.actions.planManagement.mode === "CHOOSE") setPricingOpen(true);
    else setManageOpen(true);
  }, [projection]);

  const offerPurchase = useCallback((intent: PurchaseIntent) => {
    if (!privateCheckout || selected?.type !== "PERSONAL" || !projection) return;
    if (intent.kind === "CREDITS" && !projection.actions.canBuyEvidenceCredits) return;
    if (intent.kind === "STORAGE" && !projection.storageAddons?.offers.some(offer => offer.key === intent.addonKey)) return;
    if (intent.kind === "PLAN" && !projection.hasPlanOffers) return;
    setPricingOpen(false);
    setStorageOpen(false);
    setManageOpen(false);
    setPurchase(intent);
    setNotice(null);
  }, [privateCheckout, selected, projection]);

  const choosePlan = useCallback((plan: "PRO" | "TEAM") => {
    if (!projection || !selected || selected.type !== "PERSONAL") return;
    // The server still makes the final transition decision; granted access is not provider-backed.
    offerPurchase({ kind: "PLAN", plan, transition: projection.plan.accessKind === "SUBSCRIPTION" });
  }, [projection, selected, offerPurchase]);

  const executePurchase = useCallback(async (provider: PurchaseProvider) => {
    if (!purchase || !selected || selected.type !== "PERSONAL" || !privateCheckout || purchaseBusy) return;
    setPurchaseBusy(true);
    setNotice(null);
    try {
      const request = checkoutRequest(purchase, provider, catalogue?.currency);
      let response: unknown;
      try {
        response = await apiFetch(request.path, { method: "POST", body: JSON.stringify(request.body) });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (purchase.kind === "PLAN" && !purchase.transition && code === "SUBSCRIPTION_ALREADY_ACTIVE") {
          response = await apiFetch("/v1/billing/subscription/plan", { method: "POST", body: JSON.stringify({ plan: purchase.plan, ...(request.body.currency ? { currency: request.body.currency } : {}) }) });
        } else if (purchase.kind === "PLAN" && purchase.transition && code === "CHECKOUT_REQUIRED") {
          const fresh = checkoutRequest({ ...purchase, transition: false }, provider, catalogue?.currency);
          response = await apiFetch(fresh.path, { method: "POST", body: JSON.stringify(fresh.body) });
        } else { throw err; }
      }
      const result = response as { outcome?: string; approvalUrl?: string | null } | null;
      if (result?.outcome === "NO_CHANGE") { setNotice("Your plan is already active."); setPurchase(null); refresh(); return; }
      if (result?.outcome === "PROVIDER_TRANSITION_IN_PROGRESS") { setNotice("Your plan change is pending provider confirmation."); setPurchase(null); refresh(); return; }
      const url = result?.approvalUrl
        ? checkoutApprovalUrl({ subscription: { links: [{ rel: "approve", href: result.approvalUrl }] } }, "paypal")
        : checkoutApprovalUrl(response, provider);
      if (url) {
        setPurchase(null);
        await WebBrowser.openBrowserAsync(url);
        setNotice("Payment may still be pending. Refresh billing to check its confirmed status.");
        refresh();
      } else {
        setPurchase(null);
        setNotice(result?.outcome ? `Plan change: ${result.outcome}. Refresh billing to check the confirmed status.` : "Checkout was created, but no verified approval link was returned. Check payment history before trying again.");
        refresh();
      }
    } catch (err) {
      setNotice(toSafeUserError(err, { message: "Checkout could not be started. No purchase was confirmed. Check pending payments before retrying." }).message);
      setPurchase(null);
    } finally { setPurchaseBusy(false); }
  }, [purchase, selected, privateCheckout, purchaseBusy, catalogue, refresh]);

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
      setNotice(toSafeUserError(err, { message: "We could not reach your payment provider. Nothing has changed — please try again shortly." }).message);
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

  /* ------------------------------------------------------------ render */

  const pricingRelevant = phase.kind !== "NO_ACCOUNTS" && selected !== null && projection?.plan.accessKind !== "CONTRACT";

  return (
    <ProovraScreen shell testID="billing">
      <ProovraPageHeader
        title={COPY.title}
        subtitle={COPY.subtitle}
        primaryAction={
          pricingRelevant ? <ProovraButton label={COPY.viewPricing} fullWidth={false} onPress={() => setPricingOpen(true)} /> : undefined
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

              <BillingActionRequired projection={projection} onRetry={() => void retryStorageCancellation()} onSupport={() => router.push("/support")} busy={busy} />

              <BillingOverviewCard projection={projection} onManagePlan={openPlanManagement} />

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
        catalogue={catalogue}
        addons={addonOffers}
        credit={credit}
        currentPlan={projection?.plan.planKey ?? null}
        onTalkToSales={openSales}
        onChoosePlan={privateCheckout && selected?.type === "PERSONAL" && projection?.hasPlanOffers ? choosePlan : undefined}
      />

      {privateCheckout && selected?.type === "PERSONAL" && projection?.storageAddons?.offers.length ? (
        <ProovraSheet visible={storageOpen && !purchase} title="Available storage" onClose={() => setStorageOpen(false)}>
          <View style={{ gap: theme.space.s2 }}>
            {projection.storageAddons.offers.map(offer => {
              const published = addonOffers.find(a => a.key === offer.key);
              return <ProovraButton key={offer.key} label={`Buy ${offer.label}${published?.priceCents != null ? ` · ${(published.priceCents / 100).toFixed(2)} ${catalogue?.currency ?? ""}/month` : ""}`} variant="secondary" onPress={() => offerPurchase({ kind: "STORAGE", addonKey: offer.key })} />;
            })}
          </View>
        </ProovraSheet>
      ) : null}
      <ProovraSheet visible={purchase !== null} title="Choose payment method" onClose={() => { if (!purchaseBusy) setPurchase(null); }}>
        <View style={{ gap: theme.space.s3 }}>
          <ProovraText variant="bodySm">You will complete payment with your selected provider. Access changes only after PROOVRA confirms the payment.</ProovraText>
          <ProovraButton label="Pay with Stripe" loading={purchaseBusy} onPress={() => void executePurchase("stripe")} />
          <ProovraButton label="Pay with PayPal" loading={purchaseBusy} onPress={() => void executePurchase("paypal")} />
          <ProovraButton label="Cancel" variant="ghost" onPress={() => { if (!purchaseBusy) setPurchase(null); }} />
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
                  : undefined
        }
        confirmLabel={
          confirm?.kind === "subscription"
            ? "Cancel subscription"
            : confirm?.kind === "addon"
              ? ADDON_CANCEL_COPY.confirm
              : confirm?.kind === "payment-cancel"
                ? PAYMENT_CANCEL_COPY.confirm
                : "Abandon local attempt"
        }
        cancelLabel={
          confirm?.kind === "subscription"
            ? "Keep subscription"
            : confirm?.kind === "addon"
              ? ADDON_CANCEL_COPY.cancel
              : confirm?.kind === "payment-cancel"
                ? PAYMENT_CANCEL_COPY.cancel
                : "Keep pending"
        }
        // An abandonment is a warning, not a destruction: nothing is deleted and no money moves.
        tone={confirm?.kind === "payment-abandon" ? "warning" : "danger"}
        busy={busy || rowBusyId !== null}
        onConfirm={() => {
          const c = confirm;
          if (!c) return;
          if (c.kind === "subscription") void cancelSubscription();
          else if (c.kind === "addon") void cancelAddon(c.addon);
          else if (c.kind === "payment-cancel") void stopPayment(c.row);
          else void abandonPayment(c.row, true);
        }}
        onCancel={() => setConfirm(null)}
      />
    </ProovraScreen>
  );
}
