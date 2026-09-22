/**
 * BILLING — the sections a customer can actually act on.
 *
 * Everything here is either a READ or the cancellation of something already
 * bought. No store takes a position on letting a customer stop paying, and no
 * repository evidence says a payment history may not be shown, so none of it
 * is withheld. The three purchase transactions are named on their own, beside
 * the catalogue, rather than used to justify removing the surface.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { formatUserDateTime } from "../lib/date";
import { toSafeUserError } from "../errors/safe-error";
import { theme } from "../theme/theme";
import {
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraSection,
  ProovraLoadingState,
  ProovraEmpty,
  ProovraConfirmSheet,
} from "./index";
import {
  BILLING_OVERVIEW_PATH,
  PURCHASE_PENDING_NOTE,
  STORAGE_ADDON_CANCEL_PATH,
  SUBSCRIPTION_CANCEL_PATH,
  buildBillingHistoryPath,
  buildRetryStorageCancellationPath,
  buildStorageAddonCancelBody,
  formatPaymentAmount,
  isCancellableAddon,
  parseBillingOverview,
  parsePaymentHistory,
  paymentStatusTone,
  type BillingOverview,
  type PaymentRow,
  type StorageAddon,
} from "../product/billing";

type Pending =
  | { kind: "subscription" }
  | { kind: "addon"; addon: StorageAddon }
  | null;

export function BillingSections({
  accountType,
  accountId,
  onChanged,
}: {
  accountType: string | null;
  accountId: string | null;
  onChanged: () => void;
}) {
  const [overview, setOverview] = useState<BillingOverview | null>(null);
  const [payments, setPayments] = useState<PaymentRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    // The two reads are independent: a history that fails must not hide what
    // the customer is currently paying for, which is the more urgent fact.
    await Promise.all([
      apiFetch(BILLING_OVERVIEW_PATH)
        .then((d) => setOverview(parseBillingOverview(d)))
        .catch(() => setOverview(null)),
      accountType && accountId
        ? apiFetch(buildBillingHistoryPath(accountType, accountId))
            .then((d) => setPayments(parsePaymentHistory(d)))
            .catch(() => setPayments([]))
        : Promise.resolve(),
    ]);
  }, [accountType, accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Retry a storage cancellation the provider did not confirm.
   *
   * The route takes the ACCOUNT and nothing else — no add-on id, no provider
   * reference — because "the server resolves the obligations IT recorded and
   * retries exactly those — never the base subscription, and never an add-on
   * whose cancellation the provider has already confirmed". So this passes no
   * add-on, and does not offer a per-row retry that would imply otherwise.
   */
  const retryStorageCancellation = useCallback(async () => {
    if (!accountType || !accountId) return;
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch(buildRetryStorageCancellationPath(accountType, accountId), {
        method: "POST",
        body: JSON.stringify({}),
      });
      setMessage("We have asked the provider again. This can take a few minutes.");
      await load();
      onChanged();
    } catch (err) {
      setMessage(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [accountType, accountId, load, onChanged]);

  const cancel = useCallback(async () => {
    const target = pending;
    if (!target) return;
    setPending(null);
    setBusy(true);
    setMessage(null);
    try {
      if (target.kind === "subscription") {
        await apiFetch(SUBSCRIPTION_CANCEL_PATH, { method: "POST", body: JSON.stringify({}) });
        setMessage("Your subscription will not renew.");
      } else {
        await apiFetch(STORAGE_ADDON_CANCEL_PATH, {
          method: "POST",
          body: JSON.stringify(buildStorageAddonCancelBody(target.addon.id)),
        });
        setMessage("That storage add-on will not renew.");
      }
      await load();
      onChanged();
    } catch (err) {
      setMessage(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [pending, load, onChanged]);

  return (
    <>
      {overview ? (
        <ProovraSection title="What you are paying for">
          <ProovraCard>
            <View style={{ flexDirection: "row", gap: theme.space.s2, flexWrap: "wrap" }}>
              {overview.plan ? <ProovraBadge label={overview.plan} tone="info" /> : null}
              {overview.credits !== null ? (
                <ProovraBadge label={`${overview.credits} credits`} tone="neutral" />
              ) : null}
            </View>
            {overview.storageLabel ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {overview.storageLimitLabel
                  ? `${overview.storageLabel} of ${overview.storageLimitLabel} used`
                  : `${overview.storageLabel} used`}
              </ProovraText>
            ) : null}

            {/*
              Cancelling is managing something already bought. No store takes a
              position on letting a customer stop paying, so it is here.
            */}
            {overview.plan && overview.plan.toUpperCase() !== "FREE" ? (
              <ProovraButton
                label="Cancel subscription"
                variant="ghost"
                fullWidth={false}
                loading={busy}
                onPress={() => setPending({ kind: "subscription" })}
              />
            ) : null}
          </ProovraCard>

          {overview.activeAddons.length > 0 ? (
            <ProovraCard>
              <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
                Storage add-ons
              </ProovraText>
              {/*
                Offered when an add-on is stuck mid-cancellation. It is ONE
                control for the account, not one per row, because the route
                resolves which obligations to retry itself.
              */}
              {overview.activeAddons.some((a) => !isCancellableAddon(a)) ? (
                <ProovraButton
                  label="Ask the provider again"
                  variant="ghost"
                  fullWidth={false}
                  loading={busy}
                  onPress={() => void retryStorageCancellation()}
                />
              ) : null}
              {overview.activeAddons.map((a) => (
                <View
                  key={a.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: theme.space.s2,
                  }}
                >
                  <ProovraText variant="bodySm">{a.label}</ProovraText>
                  {isCancellableAddon(a) ? (
                    <ProovraButton
                      label="Cancel"
                      variant="ghost"
                      fullWidth={false}
                      loading={busy}
                      onPress={() => setPending({ kind: "addon", addon: a })}
                    />
                  ) : (
                    // Already ending: offering "cancel" again would be an
                    // action with nothing to do.
                    <ProovraBadge label={a.status} tone="neutral" />
                  )}
                </View>
              ))}
            </ProovraCard>
          ) : null}
        </ProovraSection>
      ) : null}

      <ProovraSection title="Payments">
        {payments === null ? (
          <ProovraLoadingState label="Loading payments" />
        ) : payments.length === 0 ? (
          <ProovraEmpty presence="inline" title="No payments have been recorded." />
        ) : (
          <ProovraCard>
            {payments.map((p) => (
              <View key={p.id} style={{ gap: 2, paddingVertical: theme.space.s2 }}>
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    gap: theme.space.s2,
                  }}
                >
                  <ProovraText variant="bodySm" numberOfLines={2}>
                    {p.description}
                  </ProovraText>
                  <ProovraBadge label={p.status} tone={paymentStatusTone(p.status)} />
                </View>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {[
                    p.occurredAtIso ? formatUserDateTime(p.occurredAtIso) : null,
                    p.providerLabel,
                    // Absent is NOT zero: showing a payment as costing nothing
                    // is worse than showing it without a figure.
                    formatPaymentAmount(p),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </ProovraText>
              </View>
            ))}
          </ProovraCard>
        )}
      </ProovraSection>

      {message ? (
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {message}
        </ProovraText>
      ) : null}

      <ProovraCard>
        {/*
          Named on its own, beside the catalogue — not used to justify removing
          reads, history or cancellation.
        */}
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {PURCHASE_PENDING_NOTE}
        </ProovraText>
      </ProovraCard>

      <ProovraConfirmSheet
        visible={pending !== null}
        title={
          pending?.kind === "subscription"
            ? "Cancel your subscription?"
            : pending
              ? `Cancel ${pending.addon.label}?`
              : ""
        }
        consequence={
          pending?.kind === "subscription"
            ? "Your plan stays active until the end of the period you have paid for, and will not renew after that. Your evidence is not deleted."
            : "This add-on stays active until the end of the period you have paid for, and will not renew. Storage already in use is not deleted."
        }
        confirmLabel={
          pending?.kind === "subscription" ? "Do not renew" : "Cancel this add-on"
        }
        tone="danger"
        busy={busy}
        onConfirm={() => void cancel()}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
