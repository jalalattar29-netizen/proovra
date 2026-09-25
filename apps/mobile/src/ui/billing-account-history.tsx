/**
 * BILLING HISTORY — the web `BillingHistorySection` (StorageAndHistory.tsx):
 * the account-wide provider re-check, and each payment with the actions the
 * SERVER offers on it (Re-check, Cancel payment, Abandon payment attempt).
 *
 * "Resume payment" is not here: it hands the customer a provider checkout,
 * which is the pending distribution-policy decision.
 */
import React from "react";
import { View } from "react-native";

import { theme } from "../theme/theme";
import { ProovraButton, ProovraCard, ProovraLoadingState, ProovraText } from "./index";
import { ProovraEmpty } from "./patterns";
import { BILLING_PAGE_COPY as COPY, billingStatusLabel, billingStatusTone, formatMoney } from "../product/billing-account";
import type { PaymentRow } from "../product/billing";
import { billingDate } from "./billing-account-sections";

export type HistoryState =
  | { kind: "LOADING" }
  | { kind: "READY"; rows: PaymentRow[] }
  | { kind: "DENIED" }
  | { kind: "ERROR" };

export function BillingHistoryCard({
  state,
  accessKind,
  onRetry,
  onRecheckAccount,
  recheckBusy,
  onRecheckPayment,
  onCancelPayment,
  onAbandonPayment,
  rowBusyId,
  notice,
}: {
  state: HistoryState;
  accessKind: string;
  onRetry: () => void;
  onRecheckAccount: () => void;
  recheckBusy: boolean;
  onRecheckPayment: (row: PaymentRow) => void;
  onCancelPayment: (row: PaymentRow) => void;
  onAbandonPayment: (row: PaymentRow) => void;
  rowBusyId: string | null;
  notice: string | null;
}) {
  const title = (
    <ProovraText variant="h3" weight="semibold">
      {COPY.historyTitle}
    </ProovraText>
  );
  if (state.kind === "DENIED") {
    return (
      <ProovraCard testID="billing-history" style={{ gap: theme.space.s2 }}>
        {title}
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          Payment records for this account are visible to its billing owner.
        </ProovraText>
      </ProovraCard>
    );
  }
  if (state.kind === "ERROR") {
    return (
      <ProovraCard testID="billing-history" style={{ gap: theme.space.s2 }}>
        {title}
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          We could not load payment history just now.
        </ProovraText>
        <ProovraButton label="Try again" variant="secondary" fullWidth={false} onPress={onRetry} />
      </ProovraCard>
    );
  }
  const providerBacked = accessKind !== "CONTRACT";
  return (
    <ProovraCard testID="billing-history" style={{ gap: theme.space.s2 }}>
      {title}
      <ProovraText variant="label" color={theme.color.ink.secondary}>
        {providerBacked ? COPY.historyProviderSubtitle : COPY.historyContractSubtitle}
      </ProovraText>
      {providerBacked ? (
        <ProovraButton
          label={recheckBusy ? COPY.rechecking : COPY.recheck}
          accessibilityLabel={COPY.recheck}
          variant="secondary"
          fullWidth={false}
          disabled={recheckBusy}
          onPress={onRecheckAccount}
        />
      ) : null}
      {notice ? (
        <ProovraText variant="label" color={theme.color.ink.primary}>
          {notice}
        </ProovraText>
      ) : null}
      {state.kind === "LOADING" ? (
        <ProovraLoadingState label="Loading payments" />
      ) : state.rows.length === 0 ? (
        <ProovraEmpty presence="inline" title="No payments yet" purpose="Payments for this account will appear here." />
      ) : (
        state.rows.map((p) => {
          const busy = rowBusyId === p.id;
          return (
            <View key={p.id} style={{ gap: 4, paddingVertical: theme.space.s2, borderTopWidth: 1, borderTopColor: theme.color.border.subtle }} testID={`billing-payment-${p.id}`}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}>
                <ProovraText variant="bodySm" weight="semibold" numberOfLines={2} style={{ flex: 1 }}>
                  {p.description}
                </ProovraText>
                <ProovraText variant="label" weight="semibold" color={theme.color.status[billingStatusTone(p.status)].fg}>
                  {billingStatusLabel(p.status)}
                </ProovraText>
              </View>
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {[
                  billingDate(p.occurredAtIso) ?? "Date unavailable",
                  p.providerLabel ?? "—",
                  // Absent is NOT zero: a withheld amount is shown as a dash.
                  formatMoney(p.amountCents, p.currency) ?? "—",
                ].join(" · ")}
              </ProovraText>
              {p.canRecheck || p.canCancel || p.canAbandon ? (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
                  {p.canRecheck ? (
                    <ProovraButton
                      label="Re-check"
                      accessibilityLabel={`Re-check payment: ${p.description}`}
                      variant="secondary"
                      fullWidth={false}
                      loading={busy}
                      disabled={rowBusyId !== null}
                      onPress={() => onRecheckPayment(p)}
                    />
                  ) : null}
                  {p.canCancel ? (
                    <ProovraButton
                      label="Cancel payment"
                      accessibilityLabel={`Cancel payment: ${p.description}`}
                      variant="secondary"
                      fullWidth={false}
                      disabled={rowBusyId !== null}
                      onPress={() => onCancelPayment(p)}
                    />
                  ) : null}
                  {p.canAbandon ? (
                    <ProovraButton
                      label="Abandon payment attempt"
                      accessibilityLabel={`Abandon payment attempt: ${p.description}`}
                      variant="secondary"
                      fullWidth={false}
                      disabled={rowBusyId !== null}
                      onPress={() => onAbandonPayment(p)}
                    />
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        })
      )}
    </ProovraCard>
  );
}
