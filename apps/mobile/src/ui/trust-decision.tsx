/**
 * TRUST SIGNALS (T-14) — the touch port of the web TrustDecisionSummary on the
 * Technical tab: each signal with its verification status and recorded words,
 * the bounded summary, the reviewer next step and the fixed limitation. No
 * score, no weighted points, no verdict, no reliance level (2026-10-08).
 */
import React from "react";
import { View } from "react-native";

import { TRUST_STATUS_BOUNDARY, verificationStatusBadge, type TrustDecision } from "../product/trust-decision";
import { theme } from "../theme/theme";
import { ProovraBadge, ProovraCard, ProovraText } from "./index";

export function TrustDecisionCard({ trust }: { trust: TrustDecision | null }) {
  if (!trust) {
    return (
      <ProovraText variant="bodySm" color={theme.color.ink.muted}>
        Verification signals are not yet available for this record.
      </ProovraText>
    );
  }
  return (
    <ProovraCard testID="trust-decision">
      <View style={{ gap: theme.space.s2 }}>
        <ProovraText variant="h3" weight="semibold">Verification signals</ProovraText>
        <ProovraText variant="bodySm" testID="trust-summary">{trust.summary}</ProovraText>
        {trust.anchoring ? (
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}>
            <ProovraText variant="label" color={theme.color.ink.secondary}>Anchoring</ProovraText>
            <ProovraText variant="label" weight="semibold">{trust.anchoring}</ProovraText>
          </View>
        ) : null}
        {trust.reviewerAction ? (
          <View>
            <ProovraText variant="label" weight="semibold">Reviewer next step</ProovraText>
            <ProovraText variant="bodySm">{trust.reviewerAction}</ProovraText>
          </View>
        ) : null}

        {trust.signals.length > 0 ? (
          <View style={{ gap: theme.space.s2 }} testID="trust-signals">
            <ProovraText variant="bodySm" weight="semibold">Per-signal detail</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.muted}>{TRUST_STATUS_BOUNDARY}</ProovraText>
            {trust.signals.map((s) => {
              const badge = verificationStatusBadge(s.status);
              return (
                <View key={s.key} style={{ gap: 2 }} testID={`trust-signal-${s.key}`}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: theme.space.s2 }}>
                    <ProovraText variant="bodySm" weight="semibold">{s.label}</ProovraText>
                    <ProovraBadge label={badge.label} tone={badge.tone} />
                  </View>
                  {s.summary ? <ProovraText variant="label" color={theme.color.ink.secondary}>{s.summary}</ProovraText> : null}
                  {s.detail ? <ProovraText variant="label" color={theme.color.ink.muted}>{s.detail}</ProovraText> : null}
                  {!s.summary && !s.detail ? (
                    <ProovraText variant="label" color={theme.color.ink.muted}>No further detail was recorded for this signal.</ProovraText>
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}
        {trust.summary.includes(trust.limitation) ? null : (
          <ProovraText variant="label" color={theme.color.ink.muted}>{trust.limitation}</ProovraText>
        )}
      </View>
    </ProovraCard>
  );
}
