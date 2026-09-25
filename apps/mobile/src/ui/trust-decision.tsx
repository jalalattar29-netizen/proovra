/**
 * TRUST DECISION (T-14) — the touch port of the web TrustDecisionSummary on
 * the Technical tab: the verdict facts, signal totals, primary reason,
 * reviewer next step, the product's boundary summary, and each signal with its
 * outcome and its weighted "x / y" points.
 */
import React from "react";
import { View } from "react-native";

import { TRUST_POINTS_BOUNDARY, trustSignalState, type TrustDecision } from "../product/trust-decision";
import { theme } from "../theme/theme";
import { ProovraBadge, ProovraCard, ProovraText } from "./index";

export function TrustDecisionCard({ trust }: { trust: TrustDecision | null }) {
  if (!trust) {
    return (
      <ProovraText variant="bodySm" color={theme.color.ink.muted}>
        Trust decision is not yet available for this record.
      </ProovraText>
    );
  }
  return (
    <ProovraCard testID="trust-decision">
      <View style={{ gap: theme.space.s2 }}>
        <ProovraText variant="h3" weight="semibold">Trust decision summary</ProovraText>
        {trust.facts.map((f) => (
          <View key={f.label} style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}>
            <ProovraText variant="label" color={theme.color.ink.secondary}>{f.label}</ProovraText>
            <ProovraText variant="label" weight="semibold">{f.value}</ProovraText>
          </View>
        ))}
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {trust.totals.map((t) => `${t.label} ${t.value == null ? "Not reported" : t.value}`).join(" · ")}
        </ProovraText>
        {trust.primaryReason ? (
          <View>
            <ProovraText variant="label" weight="semibold">Primary reason</ProovraText>
            <ProovraText variant="bodySm">{trust.primaryReason}</ProovraText>
          </View>
        ) : null}
        {trust.reviewerAction ? (
          <View>
            <ProovraText variant="label" weight="semibold">Reviewer next step</ProovraText>
            <ProovraText variant="bodySm">{trust.reviewerAction}</ProovraText>
          </View>
        ) : null}
        {trust.summary ? <ProovraText variant="label" color={theme.color.ink.muted}>{trust.summary}</ProovraText> : null}

        {trust.signals.length > 0 ? (
          <View style={{ gap: theme.space.s2 }} testID="trust-signals">
            <ProovraText variant="bodySm" weight="semibold">Per-signal detail</ProovraText>
            {trust.totalPoints > 0 ? (
              <ProovraText variant="label" weight="semibold">{`Weighting: ${trust.totalPoints} points`}</ProovraText>
            ) : null}
            <ProovraText variant="label" color={theme.color.ink.muted}>{TRUST_POINTS_BOUNDARY}</ProovraText>
            {trust.signals.map((s) => {
              const state = trustSignalState(s.status);
              return (
                <View key={s.key} style={{ gap: 2 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: theme.space.s2 }}>
                    <ProovraText variant="bodySm" weight="semibold">{s.label}</ProovraText>
                    <View style={{ flexDirection: "row", gap: theme.space.s1, alignItems: "center" }}>
                      <ProovraBadge label={state.label} tone={state.tone} />
                      <ProovraText variant="label">{`${s.points} / ${s.maxPoints}`}</ProovraText>
                    </View>
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
      </View>
    </ProovraCard>
  );
}
