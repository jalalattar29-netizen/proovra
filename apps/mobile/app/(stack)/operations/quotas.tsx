/**
 * QUOTAS & USAGE — the native port of `apps/web/app/(app)/operations/quotas`.
 *
 * Two canonical sources, read independently: `GET /v1/quotas` for the four
 * allowance lines and `GET /v1/usage-stats` for the analysis counters, costs,
 * active services and evidence-type breakdown. They fail independently too — a
 * usage read that fails must not blank the quota lines, which are the reason
 * the page exists.
 *
 * The web's composition, in its order: usage cards, quota cards, the Current
 * Quotas bars with the reset date, Cost Overview beside Active Services, and
 * Evidence Types Analyzed.
 *
 * Self-service, reached contextually. The web keeps it out of every nav
 * surface (`sidebarEligible: false`, `commandPaletteVisible: false`), so
 * native does not add a tab for it either.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../../../src/api";
import { formatUserDate } from "../../../src/lib/date";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
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
import {
  QUOTAS_COPY as COPY,
  QUOTA_BAR_LABEL,
  QUOTA_CARD_LABEL,
  formatCost,
  parseUsageExtras,
  type UsageExtras,
} from "../../../src/product/operations-quotas";

type Section<T> = { phase: "loading" } | { phase: "loaded"; data: T } | { phase: "failed" };
type Usage = { stats: UsageStats | null; extras: UsageExtras };

function QuotaBar({ line }: { line: QuotaLine }) {
  const tone = quotaTone(line.percent);
  const palette = theme.color.status[tone];
  const label = QUOTA_BAR_LABEL[line.key] ?? line.label;

  return (
    <View style={{ gap: theme.space.s1 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: theme.space.s2 }}>
        <ProovraText variant="bodySm" weight="bold">
          {label}
        </ProovraText>
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {`${line.used} / ${line.limit} used · ${line.remaining} remaining`}
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
            accessibilityLabel={`${label}: ${line.percent}% used`}
            style={{
              height: 10,
              borderRadius: 999,
              backgroundColor: theme.color.surface.muted,
              overflow: "hidden",
            }}
          >
            <View
              style={{
                width: `${line.percent}%`,
                height: "100%",
                borderRadius: 999,
                backgroundColor: palette.solid,
              }}
            />
          </View>
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {`${line.percent}% used`}
          </ProovraText>
        </>
      )}
    </View>
  );
}

/** One of the web's soft metric tiles inside the Cost Overview / Active Services cards. */
function SoftMetric({ label, value, center }: { label: string; value: string; center?: boolean }) {
  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: 130,
        padding: theme.space.s3,
        borderRadius: theme.radius.lg,
        backgroundColor: theme.color.surface.muted,
        gap: 4,
        alignItems: center ? "center" : "flex-start",
      }}
    >
      {center ? null : <ProovraText variant="label" color={theme.color.ink.muted}>{label}</ProovraText>}
      <ProovraText variant="h2" weight="bold">{value}</ProovraText>
      {center ? <ProovraText variant="label" color={theme.color.ink.secondary}>{label}</ProovraText> : null}
    </View>
  );
}

export default function QuotasScreen() {
  const router = useRouter();
  const [quotas, setQuotas] = useState<Section<QuotaLine[]>>({ phase: "loading" });
  const [usage, setUsage] = useState<Section<Usage>>({ phase: "loading" });

  const load = useCallback(async () => {
    setQuotas({ phase: "loading" });
    setUsage({ phase: "loading" });

    await Promise.all([
      apiFetch(QUOTA_PATH)
        .then((d) => setQuotas({ phase: "loaded", data: parseQuotas(d) }))
        .catch(() => setQuotas({ phase: "failed" })),
      apiFetch(USAGE_STATS_PATH)
        .then((d) => setUsage({ phase: "loaded", data: { stats: parseUsageStats(d), extras: parseUsageExtras(d) } }))
        .catch(() => setUsage({ phase: "failed" })),
    ]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = usage.phase === "loaded" ? usage.data.stats : null;
  const extras = usage.phase === "loaded" ? usage.data.extras : null;
  const lines = quotas.phase === "loaded" ? quotas.data : [];
  const resetIso = lines.find((l) => l.key === "analyses")?.resetIso ?? null;

  return (
    <ProovraScreen shell testID="operations-quotas">
      <ProovraPageHeader
        title={COPY.title}
        eyebrow={COPY.eyebrow}
        subtitle={COPY.subtitle}
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

      {/* Usage cards — the web's first row (Today / This Week / This Month / Average Per Analysis). */}
      {usage.phase === "loading" ? <ProovraLoadingState label="Loading usage" /> : null}
      {usage.phase === "failed" ? (
        // Stated, not silently rendered as zeroes. "We could not read this"
        // and "there was none" are different answers.
        <ProovraErrorState message="Usage could not be loaded." onRetry={() => void load()} />
      ) : null}
      {usage.phase === "loaded" && stats === null ? (
        <ProovraEmpty presence="inline" title="No usage has been recorded." />
      ) : null}
      {stats ? (
        <ProovraKpiGrid
          items={[
            { key: "today", label: "Today", value: String(stats.today), caption: "Analyses processed today" },
            { key: "week", label: "This Week", value: String(stats.thisWeek), caption: "Analyses processed this week" },
            { key: "month", label: "This Month", value: String(stats.thisMonth), caption: "Analyses processed this month" },
            {
              key: "avgCost",
              label: "Average Per Analysis",
              value: formatCost(stats.averageCostPerAnalysis, 4),
              caption: "Average AI analysis cost",
            },
          ]}
        />
      ) : null}

      {/* Quota cards, then the Current Quotas bars. */}
      {quotas.phase === "loading" ? <ProovraLoadingState label="Loading allowances" /> : null}
      {quotas.phase === "failed" ? (
        <ProovraErrorState message="Allowances could not be loaded." onRetry={() => void load()} />
      ) : null}
      {quotas.phase === "loaded" && lines.length === 0 ? (
        <ProovraEmpty presence="inline" title="No allowances are published for this account." />
      ) : null}
      {lines.length > 0 ? (
        <>
          <ProovraKpiGrid
            items={lines.map((line) => ({
              key: `card-${line.key}`,
              label: QUOTA_CARD_LABEL[line.key] ?? line.label,
              value: `${line.used} / ${line.limit}`,
              caption: `${line.remaining} remaining`,
            }))}
          />
          <ProovraPageSection title={COPY.currentQuotas}>
            <ProovraCard testID="current-quotas">
              <View style={{ gap: theme.space.s4 }}>
                {lines.map((line) => (
                  <QuotaBar key={line.key} line={line} />
                ))}
                {/* resetDate is sent on `analyses` only (enterprise.routes.ts getRealQuotas). */}
                {resetIso ? (
                  <View style={{ borderTopWidth: 1, borderTopColor: theme.color.border.subtle, paddingTop: theme.space.s3 }}>
                    <ProovraText variant="label" color={theme.color.ink.secondary}>
                      {`Quotas reset on ${formatUserDate(resetIso)}`}
                    </ProovraText>
                  </View>
                ) : null}
              </View>
            </ProovraCard>
          </ProovraPageSection>
        </>
      ) : null}

      {extras && stats ? (
        <>
          <ProovraPageSection title={COPY.costOverview}>
            <ProovraCard testID="cost-overview">
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s3 }}>
                <SoftMetric label="Total Cost" value={formatCost(extras.totalCost)} />
                <SoftMetric label="This Month" value={formatCost(extras.thisMonthCost)} />
              </View>
            </ProovraCard>
          </ProovraPageSection>

          <ProovraPageSection title={COPY.activeServices}>
            <ProovraCard testID="active-services">
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s3 }}>
                <SoftMetric label="Active API Keys" value={extras.activeApiKeys === null ? "—" : String(extras.activeApiKeys)} />
                <SoftMetric label="Active Batch Jobs" value={extras.activeBatches === null ? "—" : String(extras.activeBatches)} />
              </View>
            </ProovraCard>
          </ProovraPageSection>

          {/* The web renders this card only when at least one type was analysed. */}
          {extras.evidenceTypes.length > 0 ? (
            <ProovraPageSection title={COPY.evidenceTypes}>
              <ProovraCard testID="evidence-types">
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s3 }}>
                  {extras.evidenceTypes.map((e) => (
                    <SoftMetric key={e.type} label={e.type} value={String(e.count)} center />
                  ))}
                </View>
              </ProovraCard>
            </ProovraPageSection>
          ) : null}
        </>
      ) : null}
    </ProovraScreen>
  );
}
