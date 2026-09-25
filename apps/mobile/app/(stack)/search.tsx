/**
 * GLOBAL SEARCH (Native Convergence §10, N1) — the touch port of the web
 * search console (apps/web/app/(app)/search/page.tsx).
 *
 * Query the workspace-scoped GET /v1/search, render typed cross-entity
 * results, and open each in the Inspector. The web's three columns become one:
 * header → form (+ typeahead) → "How search works" → scope → filters →
 * readiness → result head → results or a state → guidance. Pure query/route
 * logic lives in src/product/search.ts; this is the thin RN shell.
 *
 * Deliberately NOT here (each gated on the web, see the parity report):
 * the semantic status chip, backfill dry run and index-health chip
 * (isPlatformAdmin), saving / renaming / deleting saved views
 * (isPlatformAdmin), and the investigation pivots (enterprise surfaces).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Switch, View, StyleSheet } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useLocalSearchParams, useRouter } from "expo-router";
import { formatLocalDueInput, parseLocalDueInput } from "../../src/product/team-responsibility";
import { apiFetch } from "../../src/api";
import { toSafeUserError } from "../../src/errors/safe-error";
import { usePlatformContext } from "../../src/product/platform-context";
import {
  SEARCH_DOCUMENT_TYPE_FILTERS,
  SEARCH_EVIDENCE_KIND_FILTERS,
  SEARCH_LIFECYCLE_TOGGLES,
  SEARCH_SORT_OPTIONS,
  buildSearchPath,
  buildSuggestPath,
  classifySearchFailure,
  describeFilterEmpty,
  hasNarrowingFilters,
  inWorkspace,
  mergeSearchPages,
  normalizeSearchQuery,
  parseRecentSearches,
  parseSearchDiagnosticsContext,
  parseSearchModeUsed,
  parseSearchResponse,
  parseSuggestionRows,
  pushRecentSearch,
  searchCountLabel,
  searchFilterSummary,
  searchRankingLabel,
  searchRecentKey,
  searchRowKey,
  searchWithheldSummary,
  toggleSearchValue,
  type SearchDocumentType,
  type SearchEvidenceKind,
  type SearchLifecycleFlag,
  type SearchMode,
  type SearchQueryProbe,
  type SearchResponse,
  type SearchRow,
  type SearchSortMode,
  type SearchSuggestion,
} from "../../src/product/search";
import { parseSavedViews, type SearchSavedView } from "../../src/product/search-saved-views";
import { theme } from "../../src/theme/theme";
import { SearchInspector } from "../../src/ui/search-inspector";
import { SearchActivityPanel } from "../../src/ui/search-activity-panel";
import { SearchResultRow } from "../../src/ui/search-result-row";
import { SearchToggleChips } from "../../src/ui/search-toggle-chips";
import { SearchQueryForm } from "../../src/ui/search-typeahead";
import { SearchGuidancePanel } from "../../src/ui/search-guidance";
import {
  SearchActionError,
  SearchEmptyWorkspaceState,
  SearchHelpDisclosure,
  SearchInitializingState,
  SearchNoResultsState,
  SearchPristineState,
  SearchRestrictedState,
  SearchStalledState,
  SearchUnavailableAlert,
  SearchUnavailableState,
} from "../../src/ui/search-states";
import { searchReadinessHasUsableResults, type SearchReadinessProjection } from "@proovra/shared";
import {
  SEARCH_REBUILD_FAILED,
  SEARCH_RECONCILE_PATH,
  buildSearchDiagnosticsPath,
  parseSearchReadiness,
  reconcileNotice,
  searchReadinessNotice,
} from "../../src/product/search-readiness";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraButton,
  ProovraFormField,
  ProovraInput,
  ProovraEmptyState,
  ProovraFilterChips,
  ProovraText,
  ProovraCursorPager,
  ProovraLoadingState,
} from "../../src/ui";
import { ProovraPageHeader } from "../../src/ui/patterns";

const SUPPORT_ROUTE = "/support";
const DATE_HINT = "Use YYYY-MM-DD HH:MM, in your local time.";

export default function SearchScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ q?: string }>();
  const { loading: ctxLoading, context } = usePlatformContext();
  const teamId = context?.activeTeamId ?? null;

  // The committed search — what the last submit asked for. The web honours
  // `/search?q=…` deep links by seeding both the draft and the live query.
  const initialQ = typeof params.q === "string" ? normalizeSearchQuery(params.q) : "";
  const [qDraft, setQDraft] = useState(initialQ);
  const [query, setQuery] = useState<string>(initialQ);
  const [sort, setSort] = useState<SearchSortMode>("UPDATED_DESC");
  const [documentTypes, setDocumentTypes] = useState<SearchDocumentType[]>([]);
  const [evidenceTypes, setEvidenceTypes] = useState<SearchEvidenceKind[]>([]);
  const [lifecycle, setLifecycle] = useState<Partial<Record<SearchLifecycleFlag, boolean>>>({});
  const [since, setSince] = useState<string | null>(null);
  const [until, setUntil] = useState<string | null>(null);
  const [sinceDraft, setSinceDraft] = useState("");
  const [untilDraft, setUntilDraft] = useState("");
  // Only a saved view can carry a mode; the web offers no mode control.
  const [mode, setMode] = useState<SearchMode | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  const narrowing = useMemo(
    () => ({ documentTypes, evidenceTypes, lifecycle, updatedSinceUtc: since, updatedUntilUtc: until }),
    [documentTypes, evidenceTypes, lifecycle, since, until],
  );
  const sinceDraftIso = parseLocalDueInput(sinceDraft);
  const untilDraftIso = parseLocalDueInput(untilDraft);
  const draftsValid = sinceDraftIso !== undefined && untilDraftIso !== undefined;
  const dateDraftDirty = draftsValid && ((sinceDraftIso ?? null) !== since || (untilDraftIso ?? null) !== until);
  const filtersNonEmpty = hasNarrowingFilters(narrowing) || sinceDraft.length > 0 || untilDraft.length > 0;

  const clearNarrowingFilters = useCallback(() => {
    // Every narrowing dimension, dates included; the query and sort stay.
    setDocumentTypes([]);
    setEvidenceTypes([]);
    setLifecycle({});
    setSinceDraft("");
    setUntilDraft("");
    setSince(null);
    setUntil(null);
  }, []);
  const applyDraftFilters = () => {
    if (!draftsValid) return;
    setSince(sinceDraftIso ?? null);
    setUntil(untilDraftIso ?? null);
  };

  /* ------------------------------------------------ readiness (diagnostics) */
  const [readiness, setReadiness] = useState<SearchReadinessProjection | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [queryProbe, setQueryProbe] = useState<SearchQueryProbe | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const healthSeq = useRef(0);
  const loadReadiness = useCallback(
    async (probeQ?: string) => {
      if (!teamId) return;
      const seq = ++healthSeq.current;
      try {
        const d = await apiFetch(buildSearchDiagnosticsPath(teamId, probeQ));
        if (seq !== healthSeq.current) return;
        setReadiness(parseSearchReadiness(d));
        const ctx = parseSearchDiagnosticsContext(d);
        setWorkspaceName(ctx.workspaceName);
        setQueryProbe(ctx.queryProbe);
      } catch {
        if (seq !== healthSeq.current) return;
        setReadiness(null);
      }
    },
    [teamId],
  );
  // A reading belongs to ONE workspace: dropped at the switch, not on arrival.
  useEffect(() => {
    setReadiness(null);
    setWorkspaceName(null);
    setQueryProbe(null);
    setRecoveryNotice(null);
    setRebuilding(false);
    void loadReadiness();
  }, [loadReadiness]);
  // Poll ONLY while the server says a run is advancing (web: 15s).
  useEffect(() => {
    if (!readiness?.shouldPoll) return;
    const t = setTimeout(() => void loadReadiness(query || undefined), 15_000);
    return () => clearTimeout(t);
  }, [readiness, loadReadiness, query]);
  const rebuildInFlight = useRef(false);
  const rebuildIndex = useCallback(async () => {
    if (rebuildInFlight.current || !teamId || readiness?.canRecover !== true) return;
    rebuildInFlight.current = true;
    setRebuilding(true);
    setRecoveryNotice(null);
    try {
      setRecoveryNotice(reconcileNotice(await apiFetch(SEARCH_RECONCILE_PATH, { method: "POST", body: JSON.stringify({ teamId }) })));
      void loadReadiness(query || undefined);
    } catch (err) {
      setActionError(toSafeUserError(err, { message: SEARCH_REBUILD_FAILED }).message);
    } finally {
      rebuildInFlight.current = false;
      setRebuilding(false);
    }
  }, [teamId, readiness?.canRecover, loadReadiness, query]);

  /* --------------------------------------------------------------- search */
  // Selecting a result opens its Inspector (the web console's right-hand panel).
  const [inspected, setInspected] = useState<SearchRow | null>(null);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<"restricted" | "unavailable" | null>(null);
  const [modeUsed, setModeUsed] = useState<SearchMode | null>(null);
  const reqSeq = useRef(0);
  const probeRef = useRef<SearchQueryProbe | null>(null);
  probeRef.current = queryProbe;

  const pathFor = useCallback(
    (cursor: string | null) =>
      buildSearchPath({
        teamId,
        q: query,
        cursor,
        mode,
        documentTypes,
        evidenceTypes,
        updatedSinceUtc: since,
        updatedUntilUtc: until,
        lifecycle,
        sort,
      }),
    [teamId, query, mode, documentTypes, evidenceTypes, since, until, lifecycle, sort],
  );

  useEffect(() => {
    const path = pathFor(null);
    if (!path) {
      setResults(null);
      return;
    }
    const seq = ++reqSeq.current;
    setLoading(true);
    setActionError(null);
    void (async () => {
      try {
        const data = await apiFetch(path);
        if (seq !== reqSeq.current) return;
        const parsed = parseSearchResponse(data);
        // A 200 with no `rows` is the service not answering, not "no results".
        if (!parsed) throw Object.assign(new Error("Malformed response from search API"), { code: "MALFORMED_RESPONSE" });
        setResults(parsed);
        setModeUsed(parseSearchModeUsed(data));
        setFailure(null);
        // The per-type probe must describe THIS query (describeFilterEmpty).
        if (query && probeRef.current?.q !== query) void loadReadiness(query);
      } catch (err) {
        if (seq !== reqSeq.current) return;
        setFailure(classifySearchFailure(err));
        setResults({ rows: [], nextCursor: null, totalReturned: 0, filteredByGovernance: 0, filteredByVisibility: 0 });
        setInspected(null);
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    })();
    // `nonce` re-issues exactly the request that failed (Retry Connection).
  }, [pathFor, nonce, query, loadReadiness]);

  const loadMore = useCallback(async () => {
    if (!results?.nextCursor || loadingMore) return;
    const path = pathFor(results.nextCursor);
    if (!path) return;
    const seq = reqSeq.current;
    setLoadingMore(true);
    try {
      const next = parseSearchResponse(await apiFetch(path));
      if (seq !== reqSeq.current) return;
      if (!next) throw new Error("Malformed response from search API");
      setResults((prev) => (prev ? mergeSearchPages(prev, next) : next));
    } catch (err) {
      // The rows already on screen stay; the failure is the action's, not the search's.
      if (seq === reqSeq.current) setActionError(toSafeUserError(err, { message: "Could not load more results." }).message);
    } finally {
      setLoadingMore(false);
    }
  }, [results?.nextCursor, loadingMore, pathFor]);

  /* ------------------------------------------------------- recent searches */
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    setRecent([]);
    if (!teamId) return;
    let alive = true;
    AsyncStorage.getItem(searchRecentKey(teamId))
      .then((raw) => alive && setRecent(parseRecentSearches(raw)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [teamId]);
  const writeRecent = useCallback(
    (next: string[]) => {
      setRecent(next);
      if (teamId) void AsyncStorage.setItem(searchRecentKey(teamId), JSON.stringify(next)).catch(() => undefined);
    },
    [teamId],
  );
  const clearRecent = useCallback(() => {
    setRecent([]);
    if (teamId) void AsyncStorage.removeItem(searchRecentKey(teamId)).catch(() => undefined);
  }, [teamId]);

  /** Submit / pick: the query becomes the live search and joins the history. */
  const runQuery = useCallback(
    (text: string) => {
      const q = normalizeSearchQuery(text);
      setQDraft(q);
      setQuery(q);
      if (q) writeRecent(pushRecentSearch(recent, q));
    },
    [recent, writeRecent],
  );
  const applyQuery = (q: string) => {
    setQDraft(q);
    setQuery(normalizeSearchQuery(q));
  };

  /* ----------------------------------------------------------- typeahead */
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  useEffect(() => {
    const path = buildSuggestPath({ teamId, q: qDraft });
    if (!path) {
      setSuggestions([]);
      return;
    }
    let alive = true;
    // Debounced 250ms, as the web; a failure is "no suggestions", never an error.
    const t = setTimeout(() => {
      apiFetch(path)
        .then((d) => alive && setSuggestions(parseSuggestionRows(d)))
        .catch(() => alive && setSuggestions([]));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [qDraft, teamId]);

  /* --------------------------------------------------------- saved views */
  const [savedViews, setSavedViews] = useState<SearchSavedView[] | null>(null);
  useEffect(() => {
    setSavedViews(null);
    if (!teamId) return;
    let alive = true;
    apiFetch(`/v1/search/saved-views?teamId=${encodeURIComponent(teamId)}`)
      .then((d) => alive && setSavedViews(parseSavedViews(d)))
      .catch(() => alive && setSavedViews([]));
    return () => {
      alive = false;
    };
  }, [teamId]);
  const applySavedView = (id: string) => {
    const v = savedViews?.find((x) => x.id === id);
    if (!v) return;
    const f = v.query;
    setQDraft(f.q ?? "");
    setQuery(f.q ?? "");
    setDocumentTypes(f.documentTypes);
    setEvidenceTypes(f.evidenceTypes);
    setLifecycle(f.lifecycle);
    setSince(f.updatedSinceUtc);
    setUntil(f.updatedUntilUtc);
    setSinceDraft(formatLocalDueInput(f.updatedSinceUtc));
    setUntilDraft(formatLocalDueInput(f.updatedUntilUtc));
    if (f.sort) setSort(f.sort);
    setMode(f.mode ?? undefined);
  };

  // Records = the content projection (GET /v1/search); Search activity = the
  // workspace search log (GET /v1/search/audit). Two data domains, one console.
  const [scope, setScope] = useState<"records" | "activity">("records");

  const workspaceReady = !ctxLoading && !!teamId;
  const rows = results?.rows ?? [];

  if (!workspaceReady) {
    // Not an error and not an empty result: nothing to search against yet.
    return (
      <ProovraScreen shell>
        {ctxLoading ? (
          <ProovraLoadingState label="Preparing search" />
        ) : (
          <ProovraEmptyState title="Workspace setup pending — refresh shortly." />
        )}
      </ProovraScreen>
    );
  }

  // Index states are about the WORKSPACE and resolve before any query-shaped
  // explanation; the full panel owns the region when nothing is listed.
  const indexCannotAnswer =
    readiness != null && (readiness.state === "EMPTY_WORKSPACE" || readiness.state === "INITIALIZING" || readiness.state === "STALLED");
  const panelOwnsRegion = rows.length === 0 && !loading && failure == null && indexCannotAnswer;
  const countIsMeaningful = readiness == null || (searchReadinessHasUsableResults(readiness.state) && readiness.state !== "STALLED");
  const readinessNotice = readiness && !loading && !panelOwnsRegion ? searchReadinessNotice(readiness) : null;
  const withheld = searchWithheldSummary(results);
  const contactSupport = () => router.push(SUPPORT_ROUTE);

  let region: ReactNode;
  if (rows.length > 0) {
    region = (
      <>
        <ProovraCard>
          {rows.map((row) => (
            <SearchResultRow key={searchRowKey(row)} row={row} onPress={() => setInspected(row)} testID={`search-result-${searchRowKey(row)}`} />
          ))}
        </ProovraCard>
        <ProovraCursorPager hasMore={!!results?.nextCursor} loading={loadingMore} onLoadMore={() => void loadMore()} />
      </>
    );
  } else if (loading) {
    region = <ProovraLoadingState label="Searching…" />;
  } else if (failure === "restricted") {
    region = <SearchRestrictedState />;
  } else if (failure) {
    region = <SearchUnavailableState onRetry={() => setNonce((n) => n + 1)} retrying={loading} onContactSupport={contactSupport} />;
  } else if (panelOwnsRegion && readiness) {
    region =
      readiness.state === "EMPTY_WORKSPACE" ? (
        <SearchEmptyWorkspaceState workspaceName={workspaceName} />
      ) : readiness.state === "INITIALIZING" ? (
        <SearchInitializingState indexedCount={readiness.indexedCount} eligibleCount={readiness.eligibleCount} />
      ) : (
        <SearchStalledState
          indexedCount={readiness.indexedCount}
          eligibleCount={readiness.eligibleCount}
          canRecover={readiness.canRecover}
          onRecover={() => void rebuildIndex()}
          recovering={rebuilding}
          recoveryNotice={recoveryNotice}
        />
      );
  } else if (!query) {
    region = <SearchPristineState />;
  } else if (hasNarrowingFilters(narrowing)) {
    const hint = describeFilterEmpty({ ...narrowing, q: query }, queryProbe);
    region = <SearchNoResultsState title={inWorkspace(hint.headline, workspaceName)} detail={hint.detail} onClearFilters={clearNarrowingFilters} />;
  } else {
    region = (
      <SearchNoResultsState
        title={inWorkspace("No matches", workspaceName)}
        detail="Try a different filename, case name, report title, note, or record ID."
      />
    );
  }

  return (
    <ProovraScreen shell>
      <ProovraPageHeader
        title="Search"
        subtitle="Search evidence, cases, reports, notes and OCR text across this workspace. Results respect visibility and governance."
        contextStrip={
          <ProovraText variant="label" color={theme.color.ink.muted} testID="search-ranking">
            {searchRankingLabel(modeUsed)}
          </ProovraText>
        }
      />

      <SearchQueryForm
        value={qDraft}
        onChangeText={setQDraft}
        onSubmit={() => runQuery(qDraft)}
        onPick={runQuery}
        suggestions={suggestions}
        recent={recent}
        onRemoveRecent={(q) => writeRecent(recent.filter((r) => r !== q))}
        onClearRecent={clearRecent}
        editable={workspaceReady}
      />

      <View style={styles.gap}>
        <SearchHelpDisclosure />
      </View>

      <ProovraFilterChips<"records" | "activity">
        label="Search console scope"
        options={[
          { value: "records", label: "Records" },
          { value: "activity", label: "Search activity" },
        ]}
        value={scope}
        onChange={setScope}
      />
      {scope === "activity" ? (
        <SearchActivityPanel teamId={teamId} />
      ) : (
        <>
          {actionError ? <SearchActionError message={actionError} /> : null}
          {failure === "unavailable" ? <SearchUnavailableAlert /> : null}

          <ProovraSection title="Filters">
            <ProovraFilterChips
              label="Sort"
              value={sort}
              onChange={(v: string) => setSort(v as SearchSortMode)}
              options={SEARCH_SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
            <SearchToggleChips
              label="Document type"
              options={SEARCH_DOCUMENT_TYPE_FILTERS}
              selected={documentTypes}
              onToggle={(t) => setDocumentTypes((prev) => toggleSearchValue(prev, t))}
            />
            <SearchToggleChips
              label="Evidence kind"
              options={SEARCH_EVIDENCE_KIND_FILTERS}
              selected={evidenceTypes}
              onToggle={(t) => setEvidenceTypes((prev) => toggleSearchValue(prev, t))}
            />
            <View style={{ gap: theme.space.s1 }} testID="search-lifecycle">
              <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Lifecycle</ProovraText>
              {SEARCH_LIFECYCLE_TOGGLES.map(({ flag, label }) => (
                <View key={flag} style={styles.toggleRow}>
                  <ProovraText variant="bodySm">{label}</ProovraText>
                  <Switch
                    value={lifecycle[flag] === true}
                    onValueChange={(v) => setLifecycle((prev) => ({ ...prev, [flag]: v ? true : undefined }))}
                    accessibilityLabel={label}
                  />
                </View>
              ))}
            </View>
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Updated</ProovraText>
            <ProovraFormField label="Since" error={sinceDraftIso === undefined ? DATE_HINT : null}>
              <ProovraInput value={sinceDraft} onChangeText={setSinceDraft} placeholder="YYYY-MM-DD HH:MM" autoCapitalize="none" accessibilityLabel="Since" />
            </ProovraFormField>
            <ProovraFormField label="Until" error={untilDraftIso === undefined ? DATE_HINT : null}>
              <ProovraInput value={untilDraft} onChangeText={setUntilDraft} placeholder="YYYY-MM-DD HH:MM" autoCapitalize="none" accessibilityLabel="Until" />
            </ProovraFormField>
            {dateDraftDirty || filtersNonEmpty ? (
              <View style={styles.row}>
                <ProovraButton label="Apply filters" fullWidth={false} disabled={!dateDraftDirty} onPress={applyDraftFilters} />
                {filtersNonEmpty ? <ProovraButton label="Clear filters" variant="secondary" fullWidth={false} onPress={clearNarrowingFilters} /> : null}
              </View>
            ) : null}
          </ProovraSection>

          {readinessNotice ? (
            <ProovraCard>
              <View style={{ gap: theme.space.s2 }} testID="search-readiness">
                {readinessNotice.heading ? (
                  <ProovraText
                    variant="bodySm"
                    weight="semibold"
                    color={readinessNotice.tone === "danger" ? theme.color.status.risk.fg : readinessNotice.tone === "warn" ? theme.color.status.pending.fg : theme.color.ink.primary}
                  >
                    {readinessNotice.heading}
                  </ProovraText>
                ) : null}
                <ProovraText variant="label" color={theme.color.ink.secondary}>{readinessNotice.body}</ProovraText>
                {readinessNotice.recoverLabel ? (
                  <ProovraButton
                    label={rebuilding ? "Starting…" : readinessNotice.recoverLabel}
                    accessibilityLabel={readinessNotice.recoverLabel}
                    variant="secondary"
                    fullWidth={false}
                    disabled={rebuilding}
                    onPress={() => void rebuildIndex()}
                  />
                ) : readinessNotice.recoverHint ? (
                  <ProovraText variant="label" color={theme.color.ink.muted}>{readinessNotice.recoverHint}</ProovraText>
                ) : null}
                {recoveryNotice ? <ProovraText variant="label" color={theme.color.ink.secondary}>{recoveryNotice}</ProovraText> : null}
              </View>
            </ProovraCard>
          ) : null}

          {/* A count is a claim about a COMPLETED search over a usable index. */}
          {countIsMeaningful ? (
            <View style={styles.head} testID="search-results-head">
              <ProovraText variant="bodySm" weight="semibold">
                {loading ? "Searching…" : failure ? "No results to show" : searchCountLabel(results?.totalReturned ?? 0)}
              </ProovraText>
              {failure ? null : <ProovraText variant="label" color={theme.color.ink.secondary}>{searchFilterSummary(narrowing)}</ProovraText>}
              {withheld && !failure ? <ProovraText variant="label" color={theme.color.ink.secondary}>{withheld}</ProovraText> : null}
            </View>
          ) : null}

          {region}

          {rows.length === 0 && !loading ? (
            <View style={styles.gap}>
              <SearchGuidancePanel
                recent={recent}
                onApplyRecent={applyQuery}
                onClearRecent={clearRecent}
                saved={savedViews ? savedViews.map((v) => ({ id: v.id, name: v.name, visibilityLabel: v.visibilityLabel })) : null}
                onApplySaved={applySavedView}
                onContactSupport={contactSupport}
              />
            </View>
          ) : null}
        </>
      )}
      <SearchInspector row={inspected} teamId={teamId} onClose={() => setInspected(null)} />
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  gap: { marginTop: theme.space.s3 },
  head: { gap: 2, marginBottom: theme.space.s2 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
});
