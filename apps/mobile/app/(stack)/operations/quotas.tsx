/**
 * QUOTAS & USAGE — the native port of `apps/web/app/(app)/operations/quotas`.
 *
 * Two canonical sources, read independently: `GET /v1/quotas` for the four
 * allowance lines and `GET /v1/usage-stats` for the analysis counters. They
 * fail independently too — a usage read that fails must not blank the quota
 * lines, which are the reason the page exists.
 *
 * Self-service, reached contextually. The web keeps it out of every nav
 * surface (`sidebarEligible: false`, `commandPaletteVisible: false`), so
 * native does not add a tab for it either.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../../../src/api";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraPageHeader,
  ProovraPageSection,
  ProovraKpiGrid,
  ProovraLoadingState,
  ProovraErrorState,
  ProovraEmpty,
} from "../../../src/ui";
import {
  QUOTA_PATH,
  USAGE_STATS_PATH,
  parseQuotas,
  parseUsageStats,
  quotaTone,
  type QuotaLine,
  type UsageStats,
} from "../../../src/product/operations";

type Section<T> = { phase: "loading" } | { phase: "loaded"; data: T } | { phase: "failed" };

function QuotaBar({ line }: { line: QuotaLine }) {
  const tone = quotaTone(line.percent);
  const palette = theme.color.status[tone];

  return (
    <View style={{ gap: theme.space.s1 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <ProovraText variant="body" weight="semibold">
          {line.label}
        </ProovraText>
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {`${line.used} / ${line.limit}`}
        </ProovraText>
      </View>

      {/*
        A bar is only drawn when a percentage could actually be computed. With
        no usable limit the counts stand on their own rather than a bar of
        invented width.
      */}
      {line.percent === null ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>
          No limit is published for this allowance.
        </ProovraText>
      ) : (
        <>
          <View
            accessibilityRole="progressbar"
            accessibilityLabel={`${line.label}: ${line.percent}% used`}
            style={{
              height: 8,
              borderRadius: 4,
              backgroundColor: theme.color.surface.muted,
              overflow: "hidden",
            }}
          >
            <View
              style={{
                width: `${line.percent}%`,
                height: "100%",
                backgroundColor: palette.solid,
              }}
            />
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {`${line.percent}% used`}
            </ProovraText>
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {`${line.remaining} remaining`}
            </ProovraText>
          </View>
        </>
      )}

      {line.resetIso ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {`Resets ${line.resetIso.slice(0, 10)}`}
        </ProovraText>
      ) : null}
    </View>
  );
}

export default function QuotasScreen() {
  const router = useRouter();
  const [quotas, setQuotas] = useState<Section<QuotaLine[]>>({ phase: "loading" });
  const [usage, setUsage] = useState<Section<UsageStats | null>>({ phase: "loading" });

  const load = useCallback(async () => {
    setQuotas({ phase: "loading" });
    setUsage({ phase: "loading" });

    await Promise.all([
      apiFetch(QUOTA_PATH)
        .then((d) => setQuotas({ phase: "loaded", data: parseQuotas(d) }))
        .catch(() => setQuotas({ phase: "failed" })),
      apiFetch(USAGE_STATS_PATH)
        .then((d) => setUsage({ phase: "loaded", data: parseUsageStats(d) }))
        .catch(() => setUsage({ phase: "failed" })),
    ]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ProovraScreen testID="operations-quotas">
      <ProovraPageHeader
        title="Quotas & usage"
        eyebrow="Operations"
        subtitle="Account allowances, usage breakdown, and reset windows."
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

      <ProovraPageSection title="Allowances">
        {quotas.phase === "loading" ? <ProovraLoadingState label="Loading allowances" /> : null}
        {quotas.phase === "failed" ? (
          <ProovraErrorState message="Allowances could not be loaded." onRetry={() => void load()} />
        ) : null}
        {quotas.phase === "loaded" && quotas.data.length === 0 ? (
          <ProovraEmpty presence="inline" title="No allowances are published for this account." />
        ) : null}
        {quotas.phase === "loaded" && quotas.data.length > 0 ? (
          <ProovraCard>
            <View style={{ gap: theme.space.s4 }}>
              {quotas.data.map((line) => (
                <QuotaBar key={line.key} line={line} />
              ))}
            </View>
          </ProovraCard>
        ) : null}
      </ProovraPageSection>

      <ProovraPageSection title="Analyses">
        {usage.phase === "loading" ? <ProovraLoadingState label="Loading usage" /> : null}
        {usage.phase === "failed" ? (
          // Stated, not silently rendered as zeroes. "We could not read this"
          // and "there was none" are different answers.
          <ProovraErrorState message="Usage could not be loaded." onRetry={() => void load()} />
        ) : null}
        {usage.phase === "loaded" && usage.data === null ? (
          <ProovraEmpty presence="inline" title="No usage has been recorded." />
        ) : null}
        {usage.phase === "loaded" && usage.data ? (
          <>
            <ProovraKpiGrid
              items={[
                { key: "today", label: "Today", value: String(usage.data.today) },
                { key: "week", label: "This week", value: String(usage.data.thisWeek) },
                { key: "month", label: "This month", value: String(usage.data.thisMonth) },
                {
                  key: "avgCost",
                  label: "Average cost",
                  value:
                    usage.data.averageCostPerAnalysis === null
                      ? "—"
                      : `$${usage.data.averageCostPerAnalysis.toFixed(4)}`,
                },
              ]}
            />
            {usage.data.totalCost !== null ? (
              <ProovraBadge label={`Total $${usage.data.totalCost.toFixed(2)}`} tone="neutral" />
            ) : null}
          </>
        ) : null}
      </ProovraPageSection>
    </ProovraScreen>
  );
}
