import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { formatUserDateTime } from "../../src/lib/date";
import { theme, statusTone } from "../../src/theme/theme";
import {
  ProovraShell,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraInput,
  ProovraSection,
  ProovraEmptyState,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../src/ui";
import { evidenceStatusDisplay, evidenceTypeLabel, EVIDENCE_TYPES, humanizeEnum } from "../../src/product/domain-display";
import {
  buildLibraryQuery,
  projectLibraryMetrics,
  hasActiveFilters,
  nextSort,
  sortLabel,
  STATUS_FILTERS,
  SOURCE_FILTERS,
  REPORT_FILTERS,
  type LibrarySort,
  type LibraryMetric,
} from "../../src/product/evidence-library";

type Scope = "active" | "archived" | "trash" | "locked";
type EvidenceItem = {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  statusLabel?: string | null;
  displayTitle?: string | null;
  title?: string | null;
  displaySubtitle?: string | null;
  displayFileName?: string | null;
  originalFileName?: string | null;
};
type PageInfo = { nextCursor?: string | null; hasMore?: boolean };

const SCOPES: Array<{ key: Scope; label: string }> = [
  { key: "active", label: "Active" },
  { key: "archived", label: "Archived" },
  { key: "trash", label: "Trash" },
  { key: "locked", label: "Locked" },
];

function rowTitle(item: EvidenceItem): string {
  return (
    item.displayTitle?.trim() ||
    item.title?.trim() ||
    item.displayFileName?.trim() ||
    item.originalFileName?.trim() ||
    evidenceTypeLabel(item.type)
  );
}

/** A single filter chip. */
function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.smallChip, { backgroundColor: active ? theme.color.accent.a050 : theme.color.surface.card, borderColor: active ? theme.color.accent.a500 : theme.color.border.default }]}
    >
      <ProovraText variant="label" weight="semibold" color={active ? theme.color.accent.a600 : theme.color.ink.secondary}>
        {label}
      </ProovraText>
    </Pressable>
  );
}

/** Canonical Native Evidence Library — one surface, four lifecycle scopes. */
export default function EvidenceLibraryScreen() {
  const router = useRouter();
  const [scope, setScope] = useState<Scope>("active");
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [sourceFilter, setSourceFilter] = useState<string>("ALL");
  const [reportFilter, setReportFilter] = useState<string>("ALL");
  const [sort, setSort] = useState<LibrarySort>("newest");
  const [showFilters, setShowFilters] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<LibraryMetric[] | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchPage = useCallback(
    async (opts: {
      scope: Scope; search: string; type: string; status: string; source: string; report: string; sort: LibrarySort; cursor?: string | null; append: boolean;
    }) => {
      if (!opts.append) setState("loading");
      setError(null);
      try {
        const path = buildLibraryQuery({
          scope: opts.scope, search: opts.search, type: opts.type, status: opts.status,
          source: opts.source, reportReady: opts.report, sort: opts.sort, cursor: opts.cursor,
        });
        const data = await apiFetch(path);
        const page = (data.items ?? []) as EvidenceItem[];
        const info = (data.pageInfo ?? {}) as PageInfo;
        setItems((prev) => (opts.append ? [...prev, ...page] : page));
        setCursor(info.nextCursor ?? null);
        setHasMore(!!info.hasMore && !!info.nextCursor);
        setState("ready");
      } catch (err) {
        setError(toSafeUserError(err));
        setState("error");
      }
    },
    [],
  );

  const reload = useCallback(
    (append = false, nextCursor: string | null = null) =>
      fetchPage({ scope, search: query, type: typeFilter, status: statusFilter, source: sourceFilter, report: reportFilter, sort, cursor: nextCursor, append }),
    [fetchPage, scope, query, typeFilter, statusFilter, sourceFilter, reportFilter, sort],
  );

  // Reload on any filter/scope/sort change (search is debounced separately).
  useEffect(() => {
    // `query` intentionally omitted — search is debounced in onSearch; a scope/
    // filter/sort change reloads with the current query. fetchPage is stable.
    void fetchPage({ scope, search: query, type: typeFilter, status: statusFilter, source: sourceFilter, report: reportFilter, sort, append: false });
  }, [scope, typeFilter, statusFilter, sourceFilter, reportFilter, sort, fetchPage]);

  // Real workspace metrics (library-summary) — refresh on scope change; a failure
  // just hides the strip (never blocks the list).
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = await apiFetch(`/v1/evidence/library-summary?scope=${scope}`);
        if (alive) setMetrics(projectLibraryMetrics(data));
      } catch {
        if (alive) setMetrics(null);
      }
    })();
    return () => { alive = false; };
  }, [scope]);

  const onSearch = useCallback(
    (text: string) => {
      setQuery(text);
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => {
        void fetchPage({ scope, search: text, type: typeFilter, status: statusFilter, source: sourceFilter, report: reportFilter, sort, append: false });
      }, 300);
    },
    [scope, typeFilter, statusFilter, sourceFilter, reportFilter, sort, fetchPage],
  );

  const restore = useCallback(
    (item: EvidenceItem) => {
      const isTrash = scope === "trash";
      Alert.alert(isTrash ? "Restore from Trash" : "Restore from Archive", `Restore this ${evidenceTypeLabel(item.type).toLowerCase()} record?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Restore",
          onPress: () => {
            void (async () => {
              setBusyId(item.id);
              try {
                await apiFetch(`/v1/evidence/${item.id}/${isTrash ? "restore" : "unarchive"}`, { method: "POST", body: isTrash ? JSON.stringify({ restore: true }) : undefined });
                setItems((prev) => prev.filter((i) => i.id !== item.id));
              } catch (err) {
                Alert.alert("Could not restore", toSafeUserError(err).message);
              } finally {
                setBusyId(null);
              }
            })();
          },
        },
      ]);
    },
    [scope],
  );

  const clearFilters = useCallback(() => {
    setTypeFilter("ALL"); setStatusFilter("ALL"); setSourceFilter("ALL"); setReportFilter("ALL");
  }, []);

  const canRestore = scope === "archived" || scope === "trash";
  const filtersActive = hasActiveFilters({ type: typeFilter, status: statusFilter, source: sourceFilter, reportReady: reportFilter });

  return (
    <ProovraShell>
      <ProovraSection title="Evidence">
        <View style={styles.scopeRow}>
          {SCOPES.map((s) => (
            <Chip key={s.key} label={s.label} active={s.key === scope} onPress={() => setScope(s.key)} />
          ))}
        </View>

        {metrics ? (
          <View style={styles.metricStrip}>
            {metrics.map((m) => {
              const c = statusTone(m.tone);
              return (
                <View key={m.key} style={styles.metricTile}>
                  <ProovraText variant="h3" weight="bold" color={c.solid}>{m.value}</ProovraText>
                  <ProovraText variant="label" color={theme.color.ink.secondary} numberOfLines={2}>{m.label}</ProovraText>
                </View>
              );
            })}
          </View>
        ) : null}

        <View style={styles.search}>
          <ProovraInput value={query} onChangeText={onSearch} placeholder="Search evidence" />
        </View>

        <View style={styles.filterRow}>
          <Chip label="All types" active={typeFilter === "ALL"} onPress={() => setTypeFilter("ALL")} />
          {EVIDENCE_TYPES.map((tf) => (
            <Chip key={tf} label={evidenceTypeLabel(tf)} active={tf === typeFilter} onPress={() => setTypeFilter(tf)} />
          ))}
          <Chip label={sortLabel(sort)} active={false} onPress={() => setSort((s) => nextSort(s))} />
          <Chip label={showFilters ? "Filters ▲" : `Filters${filtersActive ? " •" : ""} ▼`} active={filtersActive} onPress={() => setShowFilters((v) => !v)} />
        </View>

        {showFilters ? (
          <ProovraCard style={styles.filterPanel}>
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Status</ProovraText>
            <View style={styles.filterRow}>
              <Chip label="Any" active={statusFilter === "ALL"} onPress={() => setStatusFilter("ALL")} />
              {STATUS_FILTERS.map((st) => (
                <Chip key={st} label={evidenceStatusDisplay(st).label} active={st === statusFilter} onPress={() => setStatusFilter(st)} />
              ))}
            </View>
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Source</ProovraText>
            <View style={styles.filterRow}>
              <Chip label="Any" active={sourceFilter === "ALL"} onPress={() => setSourceFilter("ALL")} />
              {SOURCE_FILTERS.map((sf) => (
                <Chip key={sf} label={humanizeEnum(sf)} active={sf === sourceFilter} onPress={() => setSourceFilter(sf)} />
              ))}
            </View>
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Report</ProovraText>
            <View style={styles.filterRow}>
              <Chip label="Any" active={reportFilter === "ALL"} onPress={() => setReportFilter("ALL")} />
              {REPORT_FILTERS.map((rf) => (
                <Chip key={rf} label={rf === "ready" ? "Report ready" : "Report missing"} active={rf === reportFilter} onPress={() => setReportFilter(rf)} />
              ))}
            </View>
            {filtersActive ? <ProovraButton label="Clear filters" variant="ghost" fullWidth={false} onPress={clearFilters} /> : null}
          </ProovraCard>
        ) : null}

        {state === "loading" ? (
          <ProovraLoadingState label="Loading evidence" />
        ) : state === "error" && error ? (
          <ProovraErrorState message={error.message} onRetry={() => void reload()} />
        ) : items.length === 0 ? (
          <ProovraEmptyState
            title={scope === "active" && !filtersActive && !query ? "No evidence yet" : "No matches"}
            message={scope === "active" && !filtersActive && !query ? "Captured records appear here." : "No records match the current filters."}
            action={scope === "active" && !filtersActive ? <ProovraButton label="+ Capture" fullWidth={false} onPress={() => router.push("/capture")} /> : undefined}
          />
        ) : (
          <>
            <ProovraCard>
              {items.map((item) => {
                const status = evidenceStatusDisplay(item.status);
                return (
                  <ProovraListRow
                    key={item.id}
                    title={rowTitle(item)}
                    subtitle={item.displaySubtitle?.trim() || `${evidenceTypeLabel(item.type)} · ${formatUserDateTime(item.createdAt)}`}
                    onPress={() => router.push(`/evidence/${item.id}`)}
                    trailing={
                      canRestore ? (
                        <ProovraButton label="Restore" variant="secondary" fullWidth={false} loading={busyId === item.id} onPress={() => restore(item)} />
                      ) : (
                        <ProovraBadge tone={status.tone} label={item.statusLabel?.trim() || status.label} />
                      )
                    }
                  />
                );
              })}
            </ProovraCard>
            {hasMore ? (
              <View style={styles.more}>
                <ProovraButton label="Load more" variant="secondary" onPress={() => void reload(true, cursor)} />
              </View>
            ) : null}
          </>
        )}
      </ProovraSection>
    </ProovraShell>
  );
}

const styles = StyleSheet.create({
  scopeRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginBottom: theme.space.s3 },
  metricStrip: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginBottom: theme.space.s3 },
  metricTile: { flexGrow: 1, minWidth: "22%", backgroundColor: theme.color.surface.card, borderRadius: theme.radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.border.default, paddingVertical: theme.space.s3, paddingHorizontal: theme.space.s3, gap: 2 },
  search: { marginBottom: theme.space.s3 },
  filterRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginBottom: theme.space.s3 },
  filterPanel: { marginBottom: theme.space.s3, gap: theme.space.s2 },
  smallChip: { paddingHorizontal: theme.space.s3, paddingVertical: 6, borderRadius: theme.radius.pill, borderWidth: 1, minHeight: 34, justifyContent: "center" },
  more: { marginTop: theme.space.s4 },
});
