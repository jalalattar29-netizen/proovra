/**
 * HOME — Operations, Analytics and Activity.
 *
 * Ports the three views `SelfServeHomeDashboard` puts beside Overview:
 * workspace health, records-by-type, the evidence activity series and the
 * activity feed.
 *
 * WHY THESE ARE SECTIONS, NOT TABS
 * The web uses a segmented control because Overview would otherwise carry
 * eleven modules on one desktop page. A phone scrolls: splitting four short
 * sections behind a control adds a decision the reader did not need to make,
 * and hides the health matrix behind a tap on the one surface whose job is to
 * say whether anything is wrong. The CONTENT is the web's; the arrangement is
 * the responsive adaptation the product law allows.
 *
 * Nothing here draws a chart the data cannot support: the records-by-type
 * counts are the server's aggregate over every record in scope, and the
 * activity series reports when it is working from a sample.
 */
import { View } from "react-native";

import { theme } from "../theme/theme";
import { ProovraCard, ProovraText, ProovraBadge, ProovraSection } from "./index";
import { formatUserDateTime } from "../lib/date";
import {
  ACTIVITY_SAMPLE_NOTE,
  healthToneBadge,
  workspaceHealthOverall,
  type ActivityGroup,
  type ActivitySeries,
  type HealthMetric,
  type TypeDistribution,
} from "../product/home-operations";

const OVERALL_LABEL: Record<string, string> = {
  healthy: "Nothing needs attention",
  needs_attention: "Some things need attention",
  action_required: "Something needs action",
};

export function HomeOperationsSections({
  health,
  distribution,
  series,
  activity,
}: {
  health: HealthMetric[];
  distribution: TypeDistribution | null;
  series: ActivitySeries | null;
  activity: ActivityGroup[];
}) {
  const overall = workspaceHealthOverall(health);

  return (
    <>
      <ProovraSection title="Workspace health">
        <ProovraCard>
          <ProovraText variant="body" weight="semibold">
            {OVERALL_LABEL[overall] ?? "Workspace health"}
          </ProovraText>
          {health.map((m) => (
            <View
              key={m.key}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: theme.space.s2,
                paddingVertical: 2,
              }}
            >
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                {m.label}
              </ProovraText>
              {/*
                An unknown reads as "—" and stays neutral. A workspace whose
                cases could not be read has not been told it has none.
              */}
              <ProovraBadge label={m.value} tone={healthToneBadge(m.tone)} />
            </View>
          ))}
        </ProovraCard>
      </ProovraSection>

      {distribution && distribution.slices.length > 0 ? (
        <ProovraSection title="Records by type">
          <ProovraCard>
            {distribution.slices.map((s) => (
              <View key={s.key} style={{ gap: 4, paddingVertical: theme.space.s2 }}>
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    gap: theme.space.s2,
                  }}
                >
                  <ProovraText variant="label">{s.label}</ProovraText>
                  {/*
                    The COUNT is what the row states. Whole percents can sum to
                    99 or 101, so the percent only sizes the bar.
                  */}
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {`${s.count} · ${s.percent}%`}
                  </ProovraText>
                </View>
                <View
                  accessibilityRole="progressbar"
                  accessibilityLabel={`${s.label}: ${s.count} of ${distribution.total}`}
                  style={{
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: theme.color.surface.muted,
                    overflow: "hidden",
                  }}
                >
                  <View
                    style={{
                      width: `${s.percent}%`,
                      height: "100%",
                      backgroundColor: theme.color.accent.a500,
                    }}
                  />
                </View>
              </View>
            ))}
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {`${distribution.total} record${distribution.total === 1 ? "" : "s"} in this workspace`}
            </ProovraText>
          </ProovraCard>
        </ProovraSection>
      ) : null}

      {series && series.total > 0 ? (
        <ProovraSection title="Recent activity">
          <ProovraCard>
            <View
              style={{
                flexDirection: "row",
                alignItems: "flex-end",
                gap: 4,
                height: 72,
              }}
            >
              {series.buckets.map((b, i) => {
                const peak = Math.max(...series.buckets.map((x) => x.count), 1);
                return (
                  <View
                    key={`${b.label}-${i}`}
                    accessibilityRole="progressbar"
                    accessibilityLabel={`${b.label}: ${b.count}`}
                    style={{ flex: 1, justifyContent: "flex-end" }}
                  >
                    <View
                      style={{
                        height: Math.max(2, Math.round((b.count / peak) * 64)),
                        borderRadius: 2,
                        backgroundColor:
                          b.count > 0 ? theme.color.accent.a500 : theme.color.surface.muted,
                      }}
                    />
                  </View>
                );
              })}
            </View>
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {`${series.total} record${series.total === 1 ? "" : "s"} in the last ${series.buckets.length} days`}
            </ProovraText>
            {/*
              Reported, never hidden. A chart that silently covers part of a
              window is worse than one that says it is a sample.
            */}
            {series.sampled ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {ACTIVITY_SAMPLE_NOTE}
              </ProovraText>
            ) : null}
          </ProovraCard>
        </ProovraSection>
      ) : null}

      {activity.length > 0 ? (
        <ProovraSection title="What happened">
          <ProovraCard>
            {activity.map((group) => (
              <View key={group.id} style={{ gap: 2, paddingVertical: theme.space.s2 }}>
                <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
                  {group.label}
                </ProovraText>
                {group.events.map((e) => (
                  <ProovraText key={e.id} variant="label" color={theme.color.ink.muted}>
                    {[e.title, e.detail, formatUserDateTime(e.atIso)].filter(Boolean).join(" · ")}
                  </ProovraText>
                ))}
              </View>
            ))}
          </ProovraCard>
        </ProovraSection>
      ) : null}
    </>
  );
}
