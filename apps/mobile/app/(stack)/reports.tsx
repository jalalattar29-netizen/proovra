/**
 * REPORTS & ARTIFACTS — the native port of the canonical Reports index
 * (`apps/web/components/reports-experience/ReportsIndex.tsx`).
 *
 * Reports is one of the nine canonical primary-navigation destinations. The
 * superseded native contract excluded it with the line "Report actions live on
 * Evidence; standalone Reports web-only" — a decision Native made about the
 * product's scope, which is exactly what it is not allowed to own.
 *
 * Browsing is side-effect-free, as on the web: `/v1/reports/artifacts` is a
 * read-only aggregator. The six workspace counters are read ONCE per workspace
 * (`limit=1`); the list asks with `summary=0`, so a filter or a search never
 * pays for aggregations it cannot change. Downloads are minted per row, on tap.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
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
  ProovraPageHeader,
  ProovraPageSection,
  ProovraFilterChips,
  ProovraFilterSearch,
  ProovraCursorPager,
  ProovraKpiGrid,
  ProovraEmpty,
  ProovraAsyncView,
} from "../../src/ui";
import { ReportArtifactRow } from "../../src/ui/report-artifact-row";
import {
  REPORTS_DESCRIPTION,
  REPORTS_EYEBROW,
  REPORTS_FILTERS,
  REPORTS_FOOTNOTE,
  REPORTS_LIST_UNAVAILABLE,
  REPORTS_METRICS,
  REPORTS_SUMMARY_UNAVAILABLE,
  REPORTS_TITLE,
  USER_REPORTS_PATH,
  buildReportsPath,
  buildReportsSummaryPath,
  formatRelativeTime,
  parseArtifacts,
  parseGeneratedAt,
  parseReportsSummary,
  parseUserScopedReports,
  reportsEmptyCopy,
  type ArtifactPage,
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
  const [summaryLoaded, setSummaryLoaded] = useState(false);
  const [items, setItems] = useState<ArtifactRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [listUnavailable, setListUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<SafeError | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const generation = useRef(0);
  /** True while the list on screen came from the user-scoped fallback. */
  const fromFallback = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchText.trim()), 300);
    return () => clearTimeout(t);
  }, [searchText]);

  /** The six counters, once per workspace, in their own request (ReportsIndex.tsx:325). */
  useEffect(() => {
    if (!teamId) return;
    let alive = true;
    apiFetch(buildReportsSummaryPath(teamId))
      .then((data) => {
        if (alive) setSummary(parseReportsSummary(data));
      })
      .catch(() => {
        // Its own failure, said in its own section; the list is unaffected.
        if (alive) setSummary(null);
      })
      .finally(() => {
        if (alive) setSummaryLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [teamId]);

  const apply = useCallback((page: ArtifactPage, existing: ArtifactRow[] | null) => {
    setItems(existing ? [...existing, ...page.items] : page.items);
    setCursor(page.nextCursor);
    setTotal(page.total);
    setListUnavailable(page.unavailable);
  }, []);

  const load = useCallback(
    async (nextCursor: string | null, existing: ArtifactRow[]) => {
      const path = buildReportsPath({ teamId, filter, cursor: nextCursor, search, summary: false });
      if (!path) {
        setLoading(false);
        return;
      }
      const mine = (generation.current += 1);
      if (nextCursor) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      setPermissionDenied(false);
      // The user-scoped fallback is a BOOTSTRAP probe for the unfiltered
      // default view only (ReportsIndex.tsx:381-420): it carries neither the
      // search nor the lifecycle, so running it for a filtered query would
      // hand back the unfiltered list.
      const unfilteredFirstPage = filter === "all" && !search && !nextCursor;
      const fallback = async (): Promise<boolean> => {
        try {
          const recovered = parseUserScopedReports(await apiFetch(USER_REPORTS_PATH));
          if (mine !== generation.current) return true;
          fromFallback.current = true;
          apply(recovered, null);
          return true;
        } catch {
          return false;
        }
      };
      try {
        // A fallback list pages with ITS cursor, on ITS route — an aggregator
        // cursor and a /v1/reports cursor are not interchangeable.
        if (nextCursor && fromFallback.current) {
          const more = parseUserScopedReports(
            await apiFetch(`${USER_REPORTS_PATH}?cursor=${encodeURIComponent(nextCursor)}`),
          );
          if (mine !== generation.current) return;
          apply(more, existing);
          return;
        }
        if (!nextCursor) fromFallback.current = false;
        const data = await apiFetch(path);
        if (mine !== generation.current) return;
        const page = parseArtifacts(data);
        setGeneratedAt(parseGeneratedAt(data));
        if (unfilteredFirstPage && !page.unavailable && page.items.length === 0 && (await fallback())) return;
        apply(page, nextCursor ? existing : null);
      } catch (err) {
        if (mine !== generation.current) return;
        const status = (err as { statusCode?: unknown })?.statusCode;
        // 404 = not a member of the supplied workspace — the personal-bootstrap gap.
        if (status === 404 && !nextCursor && (await fallback())) return;
        if (status === 403) setPermissionDenied(true);
        else setError(toSafeUserError(err, { message: "Unable to load artifacts." }));
      } finally {
        if (mine === generation.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [teamId, filter, search, apply],
  );

  useEffect(() => {
    void load(null, []);
  }, [load]);

  const empty = reportsEmptyCopy(filter, search);

  return (
    <ProovraScreen shell testID="reports">
      <ProovraPageHeader
        title={REPORTS_TITLE}
        eyebrow={REPORTS_EYEBROW}
        subtitle={REPORTS_DESCRIPTION}
        contextStrip={
          generatedAt ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {`Refreshed ${formatRelativeTime(generatedAt)}`}
            </ProovraText>
          ) : undefined
        }
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

      {!teamId && !platform.loading ? (
        <ProovraEmpty
          framed
          title="Workspace setup pending"
          purpose="We're finishing workspace setup, or you haven't picked one yet. Reports + verification packages are scoped to a workspace — pick one to continue."
          action={
            <ProovraButton label="Open workspaces" variant="primary" fullWidth={false} onPress={() => router.push("/spaces")} />
          }
        />
      ) : permissionDenied ? (
        <ProovraEmpty
          framed
          title="You don't have access to this workspace's reports"
          purpose="Your role doesn't include report and verification-package access for this workspace. An admin can grant it, or you can switch to a workspace you have access to."
          action={
            <ProovraButton label="Switch workspace" variant="primary" fullWidth={false} onPress={() => router.push("/spaces")} />
          }
        />
      ) : (
        <>
          <ProovraPageSection title="Operational summary">
            {summary ? (
              <ProovraKpiGrid
                items={REPORTS_METRICS.map((m) => ({
                  key: m.key,
                  label: m.label,
                  value: summary[m.key] === null ? "—" : String(summary[m.key]),
                  tone: m.tone,
                }))}
              />
            ) : summaryLoaded ? (
              <ProovraCard>
                <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                  {REPORTS_SUMMARY_UNAVAILABLE}
                </ProovraText>
              </ProovraCard>
            ) : null}
          </ProovraPageSection>

          <ProovraPageSection title="Filters">
            <ProovraFilterSearch
              value={searchText}
              onChange={(t) => setSearchText(t.slice(0, 80))}
              placeholder="Search by evidence title"
              testID="reports-search"
            />
            <View accessibilityLabel="Artifact lifecycle filters">
              <ProovraFilterChips
                label="Lifecycle"
                value={filter}
                onChange={setFilter}
                options={REPORTS_FILTERS.map((f) => ({ value: f.value, label: f.label }))}
                disabled={!teamId}
              />
            </View>
          </ProovraPageSection>

          <ProovraPageSection title={`Artifacts · ${total ?? items.length}`}>
            {listUnavailable ? (
              <ProovraCard>
                <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                  {REPORTS_LIST_UNAVAILABLE}
                </ProovraText>
              </ProovraCard>
            ) : (
              <ProovraAsyncView
                loading={loading}
                error={error ? { title: error.title, message: error.message } : null}
                onRetry={() => void load(null, [])}
                items={items}
                empty={
                  <ProovraEmpty
                    framed
                    title={empty.title}
                    purpose={empty.body}
                    action={
                      empty.offerEvidence ? (
                        <ProovraButton
                          label="Open evidence"
                          variant="primary"
                          fullWidth={false}
                          onPress={() => router.push("/evidence")}
                        />
                      ) : null
                    }
                  />
                }
              >
                <View style={{ gap: theme.space.s2 }}>
                  {items.map((row) => (
                    <ReportArtifactRow key={row.evidenceId} row={row} teamId={teamId} />
                  ))}
                  <ProovraCursorPager
                    hasMore={!!cursor}
                    loading={loadingMore}
                    onLoadMore={() => void load(cursor, items)}
                  />
                </View>
              </ProovraAsyncView>
            )}
          </ProovraPageSection>

          <ProovraText variant="label" color={theme.color.ink.muted}>
            {REPORTS_FOOTNOTE}
          </ProovraText>
        </>
      )}
    </ProovraScreen>
  );
}
