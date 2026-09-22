/**
 * GLOBAL SEARCH (Native Convergence §10, N1) — a real product surface. Query the
 * workspace-scoped GET /v1/search, render typed cross-entity results, and route
 * to the native detail surface for the types native has (Evidence, Case). Pure
 * query/route logic lives in src/product/search.ts; this is the thin RN shell.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { formatUserDateTime } from "../../src/lib/date";
import { usePlatformContext } from "../../src/product/platform-context";
import {
  buildSearchPath,
  parseSearchResponse,
  resolveSearchResultRoute,
  documentTypeDisplay,
  searchRowKey,
  type SearchRow,
  type SearchDocumentType,
  NATIVE_SEARCH_FILTERS,
  filterToDocumentTypes,
  buildSuggestPath,
  parseSuggestions,
} from "../../src/product/search";
import { theme } from "../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraButton,
  ProovraBadge,
  ProovraInput,
  ProovraListRow,
  ProovraEmptyState,
  ProovraFilterChips,
  ProovraResultCount,
  ProovraCursorPager,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../src/ui";

type Phase = "idle" | "loading" | "ready" | "error";

export default function SearchScreen() {
  const router = useRouter();
  const { loading: ctxLoading, context } = usePlatformContext();
  const teamId = context?.activeTeamId ?? null;

  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"ALL" | SearchDocumentType>("ALL");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [debounced, setDebounced] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<SafeError | null>(null);
  const reqSeq = useRef(0);

  // Debounce the query so we don't fire a request per keystroke.
  useEffect(() => {
    const h = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(h);
  }, [q]);

  const run = useCallback(
    async (query: string, existing: SearchRow[], nextCursor: string | null) => {
      const path = buildSearchPath({
        teamId,
        q: query,
        cursor: nextCursor,
        documentTypes: filterToDocumentTypes(filter),
      });
      if (!path) {
        setPhase("idle");
        setRows([]);
        setCursor(null);
        return;
      }
      const seq = ++reqSeq.current;
      if (nextCursor) setLoadingMore(true);
      else setPhase("loading");
      setError(null);
      try {
        const data = await apiFetch(path);
        if (seq !== reqSeq.current) return; // a newer query superseded this one
        const parsed = parseSearchResponse(data);
        setRows(nextCursor ? [...existing, ...parsed.rows] : parsed.rows);
        setCursor(parsed.nextCursor);
        setTotal(parsed.total ?? null);
        setPhase("ready");
      } catch (err) {
        if (seq !== reqSeq.current) return;
        setError(toSafeUserError(err));
        setPhase("error");
      } finally {
        if (seq === reqSeq.current) setLoadingMore(false);
      }
    },
    [teamId, filter],
  );

  useEffect(() => {
    void run(debounced, [], null);
  }, [debounced, run]);

  /*
   * Typeahead. A failure here yields NO suggestions rather than an error state:
   * this is a convenience above the field, and a user who is already typing a
   * working query should not be told something went wrong because the
   * suggestion service is down.
   */
  useEffect(() => {
    let alive = true;
    const path = buildSuggestPath({ teamId, q: debounced });
    if (!path) {
      setSuggestions([]);
      return;
    }
    void apiFetch(path)
      .then((d) => alive && setSuggestions(parseSuggestions(d)))
      .catch(() => alive && setSuggestions([]));
    return () => {
      alive = false;
    };
  }, [debounced, teamId]);

  const open = useCallback(
    (row: SearchRow) => {
      const route = resolveSearchResultRoute(row);
      if (route) router.push(route);
    },
    [router],
  );

  const workspaceReady = !ctxLoading && !!teamId;

  return (
    <ProovraScreen>
      <ProovraSection title="Search">
        <ProovraInput
          value={q}
          onChangeText={setQ}
          placeholder="Search evidence, cases…"
          autoCapitalize="none"
          editable={workspaceReady}
          testID="search-input"
        />
        {suggestions.length > 0 && phase !== "loading" ? (
          <View style={styles.suggestions}>
            {suggestions.map((sug) => (
              <ProovraButton
                key={sug}
                label={sug}
                variant="ghost"
                fullWidth={false}
                onPress={() => setQ(sug)}
              />
            ))}
          </View>
        ) : null}
        {/* Result families, as the web filter bar offers them. */}
        <ProovraFilterChips
          label="Type"
          value={filter}
          onChange={setFilter}
          options={NATIVE_SEARCH_FILTERS.map((f) => ({ value: f.value, label: f.label }))}
          disabled={!workspaceReady}
        />
      </ProovraSection>

      {ctxLoading ? (
        <ProovraLoadingState label="Preparing search" />
      ) : !teamId ? (
        <ProovraEmptyState
          title="Search isn’t ready yet"
          message="Your workspace is still setting up. Try again in a moment."
        />
      ) : phase === "loading" ? (
        <ProovraLoadingState label="Searching" />
      ) : phase === "error" && error ? (
        <ProovraErrorState message={error.message} onRetry={() => void run(debounced, [], null)} />
      ) : phase === "idle" ? (
        <ProovraEmptyState
          title="Search your workspace"
          message="Find evidence and cases by title, type, or keyword."
        />
      ) : rows.length === 0 ? (
        <ProovraEmptyState title="No results" message={`Nothing matched “${debounced}”.`} />
      ) : (
        <>
          <View style={styles.count}>
            <ProovraResultCount count={rows.length} total={total} noun="result" />
          </View>
          <ProovraCard>
            {rows.map((row) => {
              const type = documentTypeDisplay(row.documentType);
              const navigable = !!resolveSearchResultRoute(row);
              return (
                <ProovraListRow
                  key={searchRowKey(row)}
                  title={row.title?.trim() || type.label}
                  subtitle={
                    [row.subtitle?.trim(), row.updatedAtUtc ? formatUserDateTime(row.updatedAtUtc) : null]
                      .filter(Boolean)
                      .join(" · ") || undefined
                  }
                  trailing={<ProovraBadge tone={type.tone} label={type.label} />}
                  onPress={navigable ? () => open(row) : undefined}
                  testID={`search-result-${searchRowKey(row)}`}
                />
              );
            })}
          </ProovraCard>
          <ProovraCursorPager
            hasMore={!!cursor}
            loading={loadingMore}
            onLoadMore={() => void run(debounced, rows, cursor)}
          />
        </>
      )}
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  more: { marginTop: theme.space.s4 },
  count: { marginBottom: theme.space.s2 },
  suggestions: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginTop: theme.space.s2 },
});
