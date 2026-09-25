/**
 * HOME — the Analytics view (web SelfServeHomeDashboard "analytics" tab,
 * "Workspace analytics"): records by type, evidence activity and the recent
 * activity feed. Workspace health moved to Overview with the web
 * (`home-overview.tsx` HomeWorkspaceHealthCard).
 *
 * Nothing here draws a chart the data cannot support: the records-by-type
 * counts are the server's aggregate over every record in scope, and the
 * activity series reports when it is working from a sample.
 */
import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { theme } from "../theme/theme";
import { ProovraCard, ProovraText, ProovraSection, ProovraFilterChips } from "./index";
import { formatUserDateTime } from "../lib/date";
import {
  ACTIVITY_RANGES,
  ACTIVITY_SAMPLE_NOTE,
  activityBucketCaption,
  type ActivityRangeId,
  type ActivityGroup,
  type ActivitySeries,
  type TypeDistribution,
} from "../product/home-operations";

export function HomeAnalyticsSections({
  distribution: recordsDistribution,
  filesDistribution = null,
  series: fixedSeries,
  seriesByRange,
  activity,
}: {
  distribution: TypeDistribution | null;
  /** The web's "Preserved files" view (EvidencePart rows), when the server sent it. */
  filesDistribution?: TypeDistribution | null;
  series: ActivitySeries | null;
  /** When given, the reader chooses the period (the web's "Activity period"). */
  seriesByRange?: Record<ActivityRangeId, ActivitySeries> | null;
  activity: ActivityGroup[];
}) {
  const router = useRouter();
  const [typeMode, setTypeMode] = useState<"records" | "files">("records");
  const isFilesMode = typeMode === "files" && filesDistribution !== null;
  const distribution = isFilesMode ? filesDistribution : recordsDistribution;
  const [rangeId, setRangeId] = useState<ActivityRangeId>("14d");
  const series = seriesByRange ? (seriesByRange[rangeId] ?? fixedSeries) : fixedSeries;
  const hasSeriesData = (series?.total ?? 0) > 0;

  return (
    <>
      {distribution !== null || filesDistribution !== null ? (
        <ProovraSection title="Records by type">
          <ProovraCard>
            {filesDistribution ? (
              <ProovraFilterChips<"records" | "files">
                label="Records or preserved files"
                value={typeMode}
                onChange={setTypeMode}
                options={[
                  { value: "records", label: "Records" },
                  { value: "files", label: "Preserved files" },
                ]}
              />
            ) : null}
            {!distribution || distribution.slices.length === 0 ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {isFilesMode ? "No files have been preserved yet." : "The distribution of your evidence types appears after the first capture."}
              </ProovraText>
            ) : null}
            {(distribution?.slices ?? []).map((s) => (
              <View key={s.key} style={{ gap: 4, paddingVertical: theme.space.s2 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}>
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
                  accessibilityLabel={`${s.label}: ${s.count} of ${distribution?.total ?? 0}`}
                  style={{ height: 6, borderRadius: 3, backgroundColor: theme.color.surface.muted, overflow: "hidden" }}
                >
                  <View style={{ width: `${s.percent}%`, height: "100%", backgroundColor: theme.color.accent.a500 }} />
                </View>
              </View>
            ))}
            {distribution && distribution.slices.length > 0 ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {isFilesMode
                  ? `${distribution.total} file${distribution.total === 1 ? "" : "s"} preserved · inside evidence records`
                  : `${distribution.total} record${distribution.total === 1 ? "" : "s"} in this workspace`}
              </ProovraText>
            ) : null}
          </ProovraCard>
        </ProovraSection>
      ) : null}

      {series ? (
        <ProovraSection title="Evidence activity">
          <ProovraCard>
            {seriesByRange ? (
              <ProovraFilterChips
                label="Activity period"
                value={rangeId}
                onChange={(v) => setRangeId(v as ActivityRangeId)}
                options={ACTIVITY_RANGES.map((r) => ({ value: r.id, label: r.label }))}
              />
            ) : null}
            {hasSeriesData ? (
              <>
                <ProovraText variant="label" color={theme.color.ink.secondary}>
                  {activityBucketCaption(series.bucketDays)}
                </ProovraText>
                <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 4, height: 72 }}>
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
                            backgroundColor: b.count > 0 ? theme.color.accent.a500 : theme.color.surface.muted,
                          }}
                        />
                      </View>
                    );
                  })}
                </View>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {`${series.total} record${series.total === 1 ? "" : "s"} in the last ${series.days} days`}
                </ProovraText>
                {/* Reported, never hidden: a chart that silently covers part of a window is worse than one that says it is a sample. */}
                {series.sampled ? (
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {ACTIVITY_SAMPLE_NOTE}
                  </ProovraText>
                ) : null}
              </>
            ) : (
              <ProovraText variant="label" color={theme.color.ink.muted}>
                Activity appears here as evidence is captured and reports are generated.
              </ProovraText>
            )}
          </ProovraCard>
        </ProovraSection>
      ) : null}

      <ProovraSection title="Recent activity">
        <ProovraCard testID="home-activity">
          {activity.length === 0 ? (
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              Activity appears when evidence is captured, reports are generated, or intake submissions are received.
            </ProovraText>
          ) : (
            <>
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                Complete history of workspace updates and evidence reports
              </ProovraText>
              {activity.map((group) => (
                <View key={group.id} style={{ gap: 2, paddingVertical: theme.space.s2 }}>
                  <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
                    {group.label}
                  </ProovraText>
                  {group.events.map((e) => (
                    <ProovraText
                      key={e.id}
                      variant="label"
                      color={e.href ? theme.color.ink.primary : theme.color.ink.muted}
                      accessibilityRole={e.href ? "link" : undefined}
                      accessibilityLabel={e.title}
                      onPress={e.href ? () => router.push(e.href as never) : undefined}
                    >
                      {[e.title, e.detail, formatUserDateTime(e.atIso)].filter(Boolean).join(" · ")}
                    </ProovraText>
                  ))}
                </View>
              ))}
            </>
          )}
        </ProovraCard>
      </ProovraSection>
    </>
  );
}
