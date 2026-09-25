/**
 * INTAKE-LINK DELIVERY HISTORY SHEET (T-15) — see src/product/intake-delivery.ts.
 * Touch adaptation: the web drawer becomes a bottom sheet.
 */
import React, { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { describeRelativeTime } from "../lib/relative-time";
import { theme } from "../theme/theme";
import {
  DELIVERY_HISTORY_COPY as COPY,
  DELIVERY_VOCABULARY,
  buildDeliveryRetryPath,
  buildIntakeDeliveriesPath,
  canRetryDelivery,
  deliveryChannelLabel,
  deliveryStateOf,
  deliveryTimeline,
  parseDeliveryMessages,
  providerErrorCodeLabel,
  type DeliveryMessage,
} from "../product/intake-delivery";
import { ProovraBadge, ProovraButton, ProovraText } from "./index";
import { ProovraSheet } from "./patterns";

export function IntakeDeliveryHistory({
  visible,
  teamId,
  linkId,
  onClose,
}: {
  visible: boolean;
  teamId: string;
  linkId: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<DeliveryMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setRows(parseDeliveryMessages(await apiFetch(buildIntakeDeliveriesPath(teamId, linkId))));
    } catch (err) {
      setError(toSafeUserError(err, { message: COPY.loadFailed }).message);
      setRows([]);
    }
  }, [teamId, linkId]);

  useEffect(() => {
    if (visible) void reload();
  }, [visible, reload]);

  const retry = async (id: string) => {
    if (retryBusy) return;
    setRetryBusy(id);
    setError(null);
    try {
      await apiFetch(buildDeliveryRetryPath(id), { method: "POST", body: JSON.stringify({ teamId }) });
      await reload();
    } catch (err) {
      setError(toSafeUserError(err, { message: COPY.retryFailed }).message);
    } finally {
      setRetryBusy(null);
    }
  };

  const rel = (iso: string) => describeRelativeTime(iso);

  return (
    <ProovraSheet visible={visible} title={COPY.title} onClose={onClose}>
      <View style={{ gap: theme.space.s3 }} testID="intake-delivery-history">
        {error ? <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{error}</ProovraText> : null}
        {rows === null ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.loading}</ProovraText>
        ) : rows.length === 0 && !error ? (
          <View style={{ gap: theme.space.s1 }}>
            <ProovraText variant="bodySm" weight="semibold">{COPY.emptyTitle}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.emptyBody}</ProovraText>
          </View>
        ) : (
          rows.map((m) => {
            const vocab = DELIVERY_VOCABULARY[deliveryStateOf(m.status)];
            return (
              <View key={m.id} style={{ gap: theme.space.s1, paddingVertical: theme.space.s2 }} testID={`delivery-${m.id}`}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 }}>
                  <ProovraText variant="bodySm" weight="semibold">{deliveryChannelLabel(m.channel)}</ProovraText>
                  <ProovraBadge tone={vocab.tone} label={vocab.label} />
                  {m.createdAt ? <ProovraText variant="label" color={theme.color.ink.muted}>{rel(m.createdAt)}</ProovraText> : null}
                </View>
                <ProovraText variant="label" color={theme.color.ink.muted}>{vocab.explanation}</ProovraText>
                <ProovraText variant="label" color={theme.color.ink.secondary}>
                  {`To ${m.recipientPreview ?? "—"} · attempt ${m.attemptCount}`}
                </ProovraText>
                {m.errorCode ? (
                  <ProovraText variant="label" color={theme.color.status.risk.fg}>{providerErrorCodeLabel(m.errorCode)}</ProovraText>
                ) : null}
                <ProovraText variant="label" color={theme.color.ink.muted}>{deliveryTimeline(m, rel)}</ProovraText>
                {canRetryDelivery(m.status) ? (
                  <ProovraButton
                    label={retryBusy === m.id ? COPY.retrying : COPY.retry}
                    accessibilityLabel={`${COPY.retry}: ${deliveryChannelLabel(m.channel)} to ${m.recipientPreview ?? "recipient"}`}
                    variant="secondary"
                    fullWidth={false}
                    disabled={retryBusy !== null}
                    onPress={() => void retry(m.id)}
                  />
                ) : null}
              </View>
            );
          })
        )}
      </View>
    </ProovraSheet>
  );
}
