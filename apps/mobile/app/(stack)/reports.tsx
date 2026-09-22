/**
 * REPORTS & ARTIFACTS — the native port of the canonical Reports index
 * (`apps/web/components/reports-experience/ReportsIndex.tsx`).
 *
 * Reports is one of the nine canonical primary-navigation destinations. The
 * superseded native contract excluded it with the line "Report actions live on
 * Evidence; standalone Reports web-only" — a decision Native made about the
 * product's scope, which is exactly what it is not allowed to own.
 *
 * Read-only, as the web page is: `/v1/reports/artifacts` is a side-effect-free
 * aggregator. Row-level generation and download are gated by the backend and
 * live on Evidence detail; this surface is the deliverables index.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "expo-router";

import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { usePlatformContext } from "../../src/product/platform-context";
import { theme } from "../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraPageHeader,
  ProovraFilterChips,
  ProovraResultCount,
  ProovraCursorPager,
  ProovraKpiGrid,
  ProovraEmpty,
  ProovraAsyncView,
} from "../../src/ui";
import { evidenceTypeLabel } from "../../src/product/domain-display";
import {
  buildReportsPath,
  parseReportsSummary,
  parseArtifacts,
  artifactRowState,
  REPORTS_METRICS,
  REPORTS_FILTERS,
  type ArtifactRow,
  type LifecycleFilter,
  type ReportsSummary,
} from "../../src/product/reports";

export default function ReportsScreen() {
  const router = useRouter();
  const platform = usePlatformContext();
  const teamId = platform.context?.activeTeamId ?? null;

  const [filter, setFilter] = useState<LifecycleFilter>("all");
  const [summary, setSummary] = useState<ReportsSummary | null>(null);
  const [items, setItems] = useState<ArtifactRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [listUnavailable, setListUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<SafeError | null>(null);

  const load = useCallback(
    async (nextCursor: string | null, existing: ArtifactRow[]) => {
      const path = buildReportsPath({ teamId, filter, cursor: nextCursor });
      if (!path) {
        setLoading(false);
        return;
      }
      if (nextCursor) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const data = await apiFetch(path);
        const page = parseArtifacts(data);
        // The summary is a SECTION of the same envelope and can be unavailable
        // on its own; a dead counter strip must not blank the list.
        setSummary(parseReportsSummary(data));
        setItems(nextCursor ? [...existing, ...page.items] : page.items);
        setCursor(page.nextCursor);
        setTotal(page.total);
        setListUnavailable(page.unavailable);
      } catch (err) {
        setError(toSafeUserError(err));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [teamId, filter],
  );

  useEffect(() => {
    void load(null, []);
  }, [load]);

  return (
    <ProovraScreen testID="reports">
      <ProovraPageHeader
        title="Reports & packages"
        eyebrow="Outputs"
        subtitle="Signed reports and verification packages produced from your evidence."
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

      {summary ? (
        <ProovraKpiGrid
          items={REPORTS_METRICS.map((m) => ({
            key: m.key,
            label: m.label,
            value: summary[m.key] === null ? "—" : String(summary[m.key]),
            tone: m.tone,
          }))}
        />
      ) : null}

      <ProovraFilterChips
        label="Lifecycle"
        value={filter}
        onChange={setFilter}
        options={REPORTS_FILTERS.map((f) => ({ value: f.value, label: f.label }))}
        disabled={!teamId}
      />

      <ProovraAsyncView
        loading={loading}
        error={error ? { title: error.title, message: error.message } : null}
        onRetry={() => void load(null, [])}
        items={items}
        empty={
          listUnavailable ? (
            <ProovraEmpty
              title="Deliverables are unavailable"
              purpose="This list could not be loaded. The counters above are unaffected."
            />
          ) : (
            <ProovraEmpty
              title={filter === "all" ? "No reports or packages yet" : "Nothing matches this filter"}
              purpose={
                filter === "all"
                  ? "Generate a report from an evidence record and it appears here."
                  : "Clear the filter to see every deliverable."
              }
              action={
                filter === "all" ? null : (
                  <ProovraButton
                    label="Clear filter"
                    variant="secondary"
                    fullWidth={false}
                    onPress={() => setFilter("all")}
                  />
                )
              }
            />
          )
        }
      >
        <>
          <ProovraResultCount count={items.length} total={total} noun="deliverable" />
          <ProovraCard>
            {items.map((row) => {
              const state = artifactRowState(row);
              return (
                <ProovraListRow
                  key={row.evidenceId}
                  title={row.displayTitle}
                  subtitle={
                    [evidenceTypeLabel(row.type), row.caseTitle ? `Case: ${row.caseTitle}` : null]
                      .filter(Boolean)
                      .join(" · ")
                  }
                  trailing={<ProovraBadge label={state.label} tone={state.tone} />}
                  onPress={() => router.push(`/evidence/${row.evidenceId}`)}
                />
              );
            })}
          </ProovraCard>
          <ProovraCursorPager
            hasMore={!!cursor}
            loading={loadingMore}
            onLoadMore={() => void load(cursor, items)}
          />
          <ProovraText variant="label" color={theme.color.ink.muted}>
            Generation and download live on each evidence record, where the backend gates them.
          </ProovraText>
        </>
      </ProovraAsyncView>
    </ProovraScreen>
  );
}
