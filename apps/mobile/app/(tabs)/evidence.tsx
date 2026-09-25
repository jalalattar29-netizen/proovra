import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking, Pressable, Share, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as FileSystem from "expo-file-system";
import { buildEvidenceBulkRequest, type EvidenceBulkActionName } from "@proovra/shared";

import { apiFetch } from "../../src/api";
import { shareFile } from "../../src/lib/share-file";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { formatUserDateTime } from "../../src/lib/date";
import { theme } from "../../src/theme/theme";
import { useToast } from "../../src/toast-context";
import { usePlatformContext } from "../../src/product/platform-context";
import { webOrigin } from "../../src/product/intake-create";
import { publicVerifyUrl } from "../../src/product/public-verify";
import {
  ProovraShell,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraInput,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../src/ui";
import { ProovraEmpty, ProovraFilterChips, ProovraKpiGrid, ProovraPageHeader } from "../../src/ui/patterns";
import { EvidenceLibraryInspector, type InspectorLoadState } from "../../src/ui/evidence-library-inspector";
import { EvidenceLibraryBulkToolbar } from "../../src/ui/evidence-library-bulk";
import { EvidenceLibrarySavedViews, type SavedViewDraft } from "../../src/ui/evidence-library-saved-views";
import { evidenceStatusDisplay, evidenceTypeLabel } from "../../src/product/domain-display";
import {
  DEFAULT_LIBRARY_FILTERS,
  SCOPE_OPTIONS,
  STATUS_OPTIONS,
  TYPE_OPTIONS,
  SOURCE_OPTIONS,
  REVIEW_OPTIONS,
  EXPORT_OPTIONS,
  CASE_OPTIONS,
  RETENTION_OPTIONS,
  SORT_OPTIONS,
  activeTrustChips,
  applyLoadedRowFilters,
  buildLibraryMetrics,
  buildLibraryQuery,
  buildLibrarySummaryPath,
  buildSavedViewBody,
  buildSavedViewDefaultPath,
  buildSavedViewPath,
  buildSavedViewUpdateBody,
  filterPanelActive,
  filtersAreDefault,
  filtersToQuery,
  parseEvidenceBulkResponse,
  parseLibrarySummary,
  parseSavedViews,
  projectInspectorArtifactFacts,
  projectInspectorArtifactState,
  projectInspectorCapabilities,
  projectInspectorEvidence,
  readFilterOverrides,
  recordStatusLabel,
  rowActivityLine,
  safeCsvFilename,
  savedViewTeamOptions,
  savedViewToFilters,
  shortId,
  withDefaultSavedView,
  type EvidenceBulkResponse,
  type InspectorArtifactFacts,
  type InspectorArtifactState,
  type InspectorCapabilities,
  type InspectorEvidence,
  type LibraryFilters,
  type LibraryScope,
  type LibrarySort,
  type LibrarySummary,
  type SavedViewItem,
} from "../../src/product/evidence-library";

/** A row of GET /v1/evidence (mapEvidenceListItem), the fields this surface reads. */
type EvidenceItem = {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  statusLabel?: string | null;
  verificationStatus?: string | null;
  displayTitle?: string | null;
  title?: string | null;
  displayFileName?: string | null;
  originalFileName?: string | null;
  itemCount?: number | null;
  caseId?: string | null;
  reportReady?: boolean | null;
  reviewReadyAtUtc?: string | null;
  acquisition?: { mode?: string | null; category?: string | null; label?: string | null } | null;
  lifecycle?: unknown;
  /** The storage-protection summary; `verified` drives Retention. */
  storage?: { verified?: boolean } | null;
};
type PageInfo = { nextCursor?: string | null; hasMore?: boolean };
type CaseOption = { id: string; name: string };

/** EVIDENCE_LIBRARY_* (evidence-library-formatters.ts), verbatim. */
const LIBRARY_TITLE = "Evidence Library";
const LIBRARY_DESCRIPTION = "Operational workspace for managing, reviewing, and exporting preserved evidence records.";
const LEGAL_BOUNDARY_TITLE = "Legal boundary";
const LEGAL_BOUNDARY =
  "PROOVRA verifies the recorded integrity state of evidence records. It does not independently establish factual truth, authorship, identity, legal admissibility, or evidentiary weight.";

function rowTitle(item: EvidenceItem): string {
  return (
    item.displayTitle?.trim() ||
    item.title?.trim() ||
    item.displayFileName?.trim() ||
    item.originalFileName?.trim() ||
    evidenceTypeLabel(item.type)
  );
}

function parseCases(data: unknown): CaseOption[] {
  const raw = data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items)
    ? ((data as { items: unknown[] }).items)
    : [];
  return raw
    .map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>) : {}))
    .filter((c) => typeof c.id === "string" && typeof c.name === "string" && (c.name as string).trim())
    .map((c) => ({ id: c.id as string, name: (c.name as string).trim() }));
}

/** A checkbox with the canonical touch target. */
function Check({ checked, label, onPress, disabled }: { checked: boolean; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled: !!disabled }}
      hitSlop={8}
      style={styles.checkHit}
    >
      <View style={[styles.box, checked ? styles.boxOn : null, disabled ? styles.boxDisabled : null]}>
        {checked ? (
          <ProovraText variant="label" weight="bold" color={theme.color.ink.inverse}>
            ✓
          </ProovraText>
        ) : null}
      </View>
    </Pressable>
  );
}

/** Canonical Native Evidence Library — the web's /evidence page. */
export default function EvidenceLibraryScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { addToast } = useToast();
  const platform = usePlatformContext();

  const [filters, setFilters] = useState<LibraryFilters>(DEFAULT_LIBRARY_FILTERS);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
  const [summary, setSummary] = useState<LibrarySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<SafeError | null>(null);
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [pageNumber, setPageNumber] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cases, setCases] = useState<CaseOption[]>([]);
  const [savedViews, setSavedViews] = useState<SavedViewItem[]>([]);
  const [viewsLoaded, setViewsLoaded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Inspector selection is deliberately independent from the checkbox/bulk selection.
  const [inspectorId, setInspectorId] = useState<string | null>(null);
  const [inspectorEvidence, setInspectorEvidence] = useState<InspectorEvidence | null>(null);
  const [inspectorOutputs, setInspectorOutputs] = useState<InspectorArtifactState | null>(null);
  const [inspectorFacts, setInspectorFacts] = useState<InspectorArtifactFacts | null>(null);
  const [inspectorCaps, setInspectorCaps] = useState<InspectorCapabilities | null>(null);
  const [inspectorState, setInspectorState] = useState<InspectorLoadState>("idle");
  const [inspectorError, setInspectorError] = useState<SafeError | null>(null);
  const [inspectorBusy, setInspectorBusy] = useState<string | null>(null);

  const listRequest = useRef(0);
  const inspectorRequest = useRef(0);
  const defaultViewApplied = useRef(false);
  const overridesApplied = useRef(false);

  // readUrlFilterOverrides (page.tsx:220) — a deep link lands pre-filtered, once.
  useEffect(() => {
    if (overridesApplied.current) return;
    overridesApplied.current = true;
    const overrides = readFilterOverrides(params as Record<string, unknown>);
    if (Object.keys(overrides).length > 0) setFilters((prev) => ({ ...prev, ...overrides }));
    // Read once on mount, as the web reads window.location once.
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(filters.search), 300);
    return () => clearTimeout(t);
  }, [filters.search]);

  /** Any filter change returns to page 1 and drops the bulk selection (page.tsx:392). */
  const updateFilters = useCallback((next: LibraryFilters) => {
    setFilters(next);
    setCurrentCursor(null);
    setCursorHistory([]);
    setPageNumber(1);
    setSelected(new Set());
  }, []);
  const setFilter = useCallback(
    <K extends keyof LibraryFilters>(key: K, value: LibraryFilters[K]) => updateFilters({ ...filters, [key]: value }),
    [filters, updateFilters],
  );

  const serverFilters = useMemo<LibraryFilters>(() => ({ ...filters, search: debouncedSearch }), [filters, debouncedSearch]);
  const serverKey = JSON.stringify({ ...serverFilters, review: "", retention: "", cursor: currentCursor });

  const loadPage = useCallback(async (f: LibraryFilters, cursor: string | null) => {
    const id = ++listRequest.current;
    setError(null);
    try {
      // List + summary in parallel; a summary failure is soft (honest fallback labels).
      const [data, summaryData] = await Promise.all([
        apiFetch(buildLibraryQuery(filtersToQuery(f, cursor))),
        apiFetch(buildLibrarySummaryPath(f)).catch(() => null),
      ]);
      if (listRequest.current !== id) return;
      setItems(Array.isArray(data?.items) ? (data.items as EvidenceItem[]) : []);
      setPageInfo((data?.pageInfo ?? null) as PageInfo | null);
      setSummary(parseLibrarySummary(summaryData));
    } catch (err) {
      if (listRequest.current !== id) return;
      setError(toSafeUserError(err));
      setItems([]);
      setPageInfo(null);
      setSummary(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadPage(serverFilters, currentCursor).then(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // serverKey captures every server-side input; review/retention are applied locally.
  }, [serverKey, loadPage]);

  const loadSupport = useCallback(async () => {
    const [casesRes, viewsRes] = await Promise.allSettled([apiFetch("/v1/cases"), apiFetch("/v1/evidence/saved-views")]);
    if (casesRes.status === "fulfilled") setCases(parseCases(casesRes.value));
    if (viewsRes.status === "fulfilled") setSavedViews(parseSavedViews(viewsRes.value));
    setViewsLoaded(true);
  }, []);
  useEffect(() => {
    void loadSupport();
  }, [loadSupport]);

  const caseMap = useMemo(() => new Map(cases.map((c) => [c.id, c.name] as const)), [cases]);

  const applyView = useCallback(
    (view: SavedViewItem, announce = true) => {
      updateFilters(savedViewToFilters(view));
      if (announce) addToast(`Loaded saved view: ${view.name}`, "success");
    },
    [updateFilters, addToast],
  );

  // The default saved view applies once, and never over a filter already set (page.tsx:589).
  useEffect(() => {
    if (defaultViewApplied.current || !viewsLoaded) return;
    defaultViewApplied.current = true;
    const view = savedViews.find((v) => v.isDefault);
    if (view && filtersAreDefault(filters)) applyView(view, false);
    // Runs on the first views that arrive, reading the filters as they are then.
  }, [viewsLoaded]);

  const visibleItems = useMemo(() => applyLoadedRowFilters(items, filters), [items, filters]);
  const metrics = useMemo(() => buildLibraryMetrics(summary, visibleItems), [summary, visibleItems]);
  const trustChips = activeTrustChips(filters);
  const allLoadedSelected = visibleItems.length > 0 && visibleItems.every((i) => selected.has(i.id));
  const panelActive = filterPanelActive(filters);

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const toggleAllLoaded = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      const all = visibleItems.every((i) => next.has(i.id));
      for (const i of visibleItems) {
        if (all) next.delete(i.id);
        else next.add(i.id);
      }
      return next;
    });
  }, [visibleItems]);

  /* ------------------------------------------------------------ inspector */

  const loadInspector = useCallback(async (evidenceId: string) => {
    const id = ++inspectorRequest.current;
    setInspectorState("loading");
    setInspectorError(null);
    setInspectorEvidence(null);
    setInspectorOutputs(null);
    setInspectorFacts(null);
    setInspectorCaps(null);
    // Status only: no report or package URL is minted by opening the Inspector.
    const [core, status, workspace] = await Promise.allSettled([
      apiFetch(`/v1/evidence/${evidenceId}`),
      apiFetch(`/v1/evidence/${evidenceId}/artifacts/status`),
      apiFetch(`/v1/evidence/${evidenceId}/review-workspace`),
    ]);
    if (inspectorRequest.current !== id) return;
    const projected = core.status === "fulfilled" ? projectInspectorEvidence(core.value) : null;
    if (!projected) {
      setInspectorError(core.status === "rejected" ? toSafeUserError(core.reason) : null);
      setInspectorState("error");
      return;
    }
    setInspectorEvidence(projected);
    if (status.status === "fulfilled") {
      setInspectorOutputs(projectInspectorArtifactState(status.value));
      setInspectorFacts(projectInspectorArtifactFacts(status.value));
    }
    if (workspace.status === "fulfilled") setInspectorCaps(projectInspectorCapabilities(workspace.value));
    setInspectorState("ready");
  }, []);

  const openInspector = useCallback(
    (evidenceId: string) => {
      setInspectorId(evidenceId);
      void loadInspector(evidenceId);
    },
    [loadInspector],
  );

  const closeInspector = useCallback(() => {
    inspectorRequest.current += 1;
    setInspectorId(null);
    setInspectorState("idle");
    setInspectorBusy(null);
  }, []);

  const downloadReport = useCallback(async () => {
    if (!inspectorId) return;
    setInspectorBusy("report");
    try {
      const data = await apiFetch(`/v1/evidence/${inspectorId}/report/latest`);
      const url = typeof data?.url === "string" && data.url ? data.url : null;
      if (!url) {
        addToast("Report not available", "info");
        return;
      }
      await Linking.openURL(url);
      addToast("Report downloaded", "success");
    } catch {
      addToast("Failed to download report", "error");
    } finally {
      setInspectorBusy(null);
    }
  }, [inspectorId, addToast]);

  const downloadPackage = useCallback(async () => {
    if (!inspectorId) return;
    setInspectorBusy("package");
    try {
      const data = await apiFetch(`/v1/evidence/${inspectorId}/verification-package`);
      const url = typeof data?.url === "string" && data.url ? data.url : null;
      if (!url) {
        addToast("Verification package not available", "info");
        return;
      }
      await Linking.openURL(url);
      addToast("Verification package downloaded", "success");
    } catch {
      addToast("Failed to download verification package", "error");
    } finally {
      setInspectorBusy(null);
    }
  }, [inspectorId, addToast]);

  const verifyUrl = inspectorId ? publicVerifyUrl(webOrigin(), inspectorId) : null;
  const shareVerification = useCallback(async () => {
    if (!verifyUrl) return;
    try {
      await Share.share({ url: verifyUrl, message: `Verify this PROOVRA record: ${verifyUrl}` });
    } catch {
      addToast("Failed to share verification link", "error");
    }
  }, [verifyUrl, addToast]);

  /* ------------------------------------------------------------- refresh */

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.allSettled([loadSupport(), loadPage(serverFilters, currentCursor)]);
    if (inspectorId) await loadInspector(inspectorId);
    setRefreshing(false);
  }, [loadSupport, loadPage, serverFilters, currentCursor, inspectorId, loadInspector]);

  /* ---------------------------------------------------------------- bulk */

  const runBulk = useCallback(
    async (action: EvidenceBulkActionName, caseId?: string): Promise<EvidenceBulkResponse> => {
      const ids = [...selected];
      const response = parseEvidenceBulkResponse(
        await apiFetch("/v1/evidence/bulk", {
          method: "POST",
          body: JSON.stringify(buildEvidenceBulkRequest({ action, evidenceIds: ids, caseId })),
        }),
      );
      if (response.csv && FileSystem.cacheDirectory) {
        const filename = safeCsvFilename(response.fileName);
        const uri = `${FileSystem.cacheDirectory}${filename}`;
        await FileSystem.writeAsStringAsync(uri, response.csv, { encoding: FileSystem.EncodingType.UTF8 });
        await shareFile(uri, { mimeType: "text/csv", dialogTitle: filename, uti: "public.comma-separated-values-text" });
      }
      if (action !== "EXPORT_METADATA_CSV") await loadPage(serverFilters, currentCursor);
      if (inspectorId && ids.includes(inspectorId)) await loadInspector(inspectorId);
      const failed = response.failedCount ?? 0;
      addToast(
        failed > 0 ? `${response.successCount ?? 0} completed, ${failed} failed` : `${response.successCount ?? 0} records updated`,
        failed > 0 ? "warning" : "success",
      );
      return response;
    },
    [selected, loadPage, serverFilters, currentCursor, inspectorId, loadInspector, addToast],
  );

  const restore = useCallback(
    (item: EvidenceItem) => {
      const isTrash = filters.scope === "trash";
      Alert.alert(isTrash ? "Restore from Trash" : "Restore from Archive", `Restore this ${evidenceTypeLabel(item.type).toLowerCase()} record?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Restore",
          onPress: () => {
            void (async () => {
              setBusyId(item.id);
              try {
                await apiFetch(`/v1/evidence/${item.id}/${isTrash ? "restore" : "unarchive"}`, {
                  method: "POST",
                  body: isTrash ? JSON.stringify({ restore: true }) : undefined,
                });
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
    [filters.scope],
  );

  /* --------------------------------------------------------- saved views */

  const createView = useCallback(
    async (draft: SavedViewDraft) => {
      try {
        const res = await apiFetch("/v1/evidence/saved-views", {
          method: "POST",
          body: JSON.stringify(buildSavedViewBody({ ...draft, filters })),
        });
        const created = parseSavedViews({ items: [res?.savedView] })[0];
        if (created) {
          setSavedViews((prev) => {
            const rest = prev.filter((v) => v.id !== created.id);
            return created.isDefault ? [created, ...rest.map((v) => (v.teamId === created.teamId ? { ...v, isDefault: false } : v))] : [created, ...rest];
          });
          addToast("Saved view created", "success");
        }
        return true;
      } catch (err) {
        addToast(toSafeUserError(err).message, "error");
        return false;
      }
    },
    [filters, addToast],
  );

  const updateView = useCallback(
    async (id: string, draft: { name: string; description: string; isDefault: boolean }) => {
      try {
        const res = await apiFetch(buildSavedViewPath(id), { method: "PATCH", body: JSON.stringify(buildSavedViewUpdateBody(draft)) });
        const updated = parseSavedViews({ items: [res?.savedView] })[0];
        if (updated) {
          setSavedViews((prev) =>
            prev.map((v) => {
              if (updated.isDefault && v.id !== updated.id && v.teamId === updated.teamId) return { ...v, isDefault: false };
              return v.id === updated.id ? updated : v;
            }),
          );
          addToast("Saved view updated", "success");
        }
        return true;
      } catch (err) {
        addToast(toSafeUserError(err).message, "error");
        return false;
      }
    },
    [addToast],
  );

  const deleteView = useCallback(
    async (id: string) => {
      try {
        await apiFetch(buildSavedViewPath(id), { method: "DELETE" });
        setSavedViews((prev) => prev.filter((v) => v.id !== id));
        addToast("Saved view deleted", "success");
        return true;
      } catch (err) {
        addToast(toSafeUserError(err).message, "error");
        return false;
      }
    },
    [addToast],
  );

  const setDefaultView = useCallback(
    async (id: string) => {
      try {
        await apiFetch(buildSavedViewDefaultPath(id), { method: "POST" });
        // The server clears the previous default in the same workspace.
        setSavedViews((prev) => {
          const target = prev.find((v) => v.id === id);
          return withDefaultSavedView(prev.filter((v) => v.teamId === target?.teamId), id).concat(
            prev.filter((v) => v.teamId !== target?.teamId),
          );
        });
        addToast("Default saved view updated", "success");
        return true;
      } catch (err) {
        addToast(toSafeUserError(err).message, "error");
        return false;
      }
    },
    [addToast],
  );

  const teamOptions = useMemo(() => savedViewTeamOptions(platform.envelope), [platform.envelope]);

  /* ------------------------------------------------------------ paging */

  const goPrevious = () => {
    if (cursorHistory.length === 0) return;
    const prev = cursorHistory[cursorHistory.length - 1] ?? null;
    setCursorHistory((h) => h.slice(0, -1));
    setCurrentCursor(prev);
    setPageNumber((p) => Math.max(1, p - 1));
  };
  const goNext = () => {
    const next = pageInfo?.nextCursor;
    if (!next) return;
    setCursorHistory((h) => [...h, currentCursor]);
    setCurrentCursor(next);
    setPageNumber((p) => p + 1);
  };
  const hasNext = Boolean(pageInfo?.hasMore && pageInfo?.nextCursor);
  const canRestore = filters.scope === "archived" || filters.scope === "trash";

  const inspectorItem = inspectorId ? items.find((i) => i.id === inspectorId) ?? null : null;
  const inspector = (presentation: "rail" | "modal") => (
    <EvidenceLibraryInspector
      row={
        inspectorItem
          ? {
              id: inspectorItem.id,
              title: rowTitle(inspectorItem),
              type: inspectorItem.type,
              status: inspectorItem.status,
              verificationStatus: inspectorItem.verificationStatus,
              itemCount: inspectorItem.itemCount,
              createdAt: inspectorItem.createdAt,
              reportReady: inspectorItem.reportReady,
            }
          : null
      }
      caseName={inspectorItem?.caseId ? caseMap.get(inspectorItem.caseId) ?? null : null}
      evidence={inspectorEvidence}
      outputs={inspectorOutputs}
      facts={inspectorFacts}
      capabilities={inspectorCaps}
      state={inspectorState}
      error={inspectorError}
      presentation={presentation}
      actionBusy={inspectorBusy}
      verifyUrl={verifyUrl}
      onClose={closeInspector}
      onRetry={() => inspectorId && void loadInspector(inspectorId)}
      onOpenRecord={() => {
        if (!inspectorId) return;
        const evidenceId = inspectorId;
        closeInspector();
        router.push(`/evidence/${evidenceId}`);
      }}
      onOpenPreview={(url) => void Linking.openURL(url)}
      onDownloadReport={() => void downloadReport()}
      onDownloadPackage={() => void downloadPackage()}
      onShareVerification={() => void shareVerification()}
    />
  );

  return (
    <ProovraShell>
      <ProovraPageHeader
        title={LIBRARY_TITLE}
        subtitle={LIBRARY_DESCRIPTION}
        secondaryActions={
          <>
            <ProovraButton label="New Case" variant="secondary" fullWidth={false} onPress={() => router.push("/cases")} />
            <ProovraButton
              label={refreshing ? "Refreshing…" : "Refresh"}
              accessibilityLabel="Refresh"
              variant="secondary"
              fullWidth={false}
              disabled={refreshing}
              onPress={() => void refresh()}
            />
          </>
        }
        primaryAction={<ProovraButton label="Upload / Capture Evidence" fullWidth={false} onPress={() => router.push("/capture")} />}
      />

      <ProovraCard style={styles.boundary}>
        <ProovraText variant="bodySm" weight="bold" color={theme.color.accent.a600} accessibilityRole="header">
          {LEGAL_BOUNDARY_TITLE}
        </ProovraText>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          {LEGAL_BOUNDARY}
        </ProovraText>
      </ProovraCard>

      <View style={styles.block}>
        <ProovraKpiGrid items={metrics} />
      </View>

      {trustChips.length > 0 ? (
        <View style={styles.chipRow}>
          {trustChips.map((c) => (
            <Pressable
              key={c.key}
              onPress={() => setFilter(c.key, "all")}
              accessibilityRole="button"
              accessibilityLabel={`Clear ${c.label}`}
              style={styles.trustChip}
            >
              <ProovraText variant="label" weight="semibold" color={theme.color.accent.a600}>
                {`${c.label}  ✕`}
              </ProovraText>
            </Pressable>
          ))}
        </View>
      ) : null}

      <ProovraCard style={styles.block}>
        <View accessibilityLabel="Evidence filters" style={styles.filters}>
          <ProovraInput
            value={filters.search}
            onChangeText={(text) => updateFilters({ ...filters, search: text })}
            placeholder="Search title, filename, or record ID"
            accessibilityLabel="Search title, filename, or record ID"
          />
          <EvidenceLibrarySavedViews
            views={savedViews}
            teamOptions={teamOptions}
            sourceNotSaved={filters.acquisition !== "all"}
            onApply={(v) => applyView(v)}
            onCreate={createView}
            onUpdate={updateView}
            onDelete={deleteView}
            onSetDefault={setDefaultView}
          />
          <ProovraFilterChips<LibraryScope>
            label="Workspace scope"
            value={filters.scope}
            options={SCOPE_OPTIONS as Array<{ value: LibraryScope; label: string }>}
            onChange={(v) => setFilter("scope", v)}
          />
          <ProovraFilterChips<LibrarySort> label="Sort" value={filters.sort} options={SORT_OPTIONS} onChange={(v) => setFilter("sort", v)} />
          <View style={styles.row}>
            <ProovraButton
              label={showFilters ? "Hide filters" : panelActive ? "More filters •" : "More filters"}
              variant="ghost"
              fullWidth={false}
              onPress={() => setShowFilters((v) => !v)}
            />
            {panelActive ? (
              <ProovraButton
                label="Clear filters"
                variant="ghost"
                fullWidth={false}
                onPress={() => updateFilters({ ...DEFAULT_LIBRARY_FILTERS, scope: filters.scope, sort: filters.sort, search: filters.search })}
              />
            ) : null}
          </View>
          {showFilters ? (
            <>
              <ProovraFilterChips label="Status" value={filters.status} options={STATUS_OPTIONS} onChange={(v) => setFilter("status", v)} />
              <ProovraFilterChips label="Evidence type" value={filters.type} options={TYPE_OPTIONS} onChange={(v) => setFilter("type", v)} />
              <ProovraFilterChips
                label="How the record entered PROOVRA"
                value={filters.acquisition}
                options={SOURCE_OPTIONS}
                onChange={(v) => setFilter("acquisition", v)}
              />
              <ProovraFilterChips label="Review" value={filters.review} options={REVIEW_OPTIONS} onChange={(v) => setFilter("review", v)} />
              <ProovraFilterChips label="Export" value={filters.exportReadiness} options={EXPORT_OPTIONS} onChange={(v) => setFilter("exportReadiness", v)} />
              <ProovraFilterChips label="Case" value={filters.caseAssignment} options={CASE_OPTIONS} onChange={(v) => setFilter("caseAssignment", v)} />
              <ProovraFilterChips label="Retention" value={filters.retention} options={RETENTION_OPTIONS} onChange={(v) => setFilter("retention", v)} />
            </>
          ) : null}
        </View>
      </ProovraCard>

      <ProovraCard style={styles.block}>
        <View style={styles.queueHead}>
          <ProovraText variant="h3" weight="semibold" accessibilityRole="header">
            Evidence queue
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            Dense operational triage for reviewer queues, export readiness, and case-linked evidence operations.
          </ProovraText>
          <View style={styles.row}>
            <ProovraBadge tone="neutral" label={filters.scope} />
            <ProovraText variant="label" color={theme.color.ink.muted} style={styles.flex1}>
              Results are loaded from the server using the selected filters.
            </ProovraText>
          </View>
        </View>

        <View style={styles.selectAll}>
          <Check
            checked={allLoadedSelected}
            label="Select all loaded pages"
            disabled={visibleItems.length === 0}
            onPress={toggleAllLoaded}
          />
          <ProovraText variant="bodySm">Select all loaded pages</ProovraText>
        </View>

        {selected.size > 0 ? (
          <EvidenceLibraryBulkToolbar
            scope={filters.scope}
            selectedCount={selected.size}
            selectedItems={visibleItems.filter((i) => selected.has(i.id))}
            cases={cases}
            onClear={() => setSelected(new Set())}
            onRun={runBulk}
            onSelectionResolved={(ids) => setSelected(new Set(ids))}
          />
        ) : null}

        {loading ? (
          <ProovraLoadingState label="Loading evidence records" />
        ) : error ? (
          <View>
            <ProovraText variant="body" weight="semibold" center>
              Evidence list unavailable
            </ProovraText>
            <ProovraErrorState message={error.message} requestId={error.requestId} onRetry={() => void refresh()} />
          </View>
        ) : visibleItems.length === 0 ? (
          <ProovraEmpty
            title="No evidence records in this scope"
            purpose="Adjust the scope or filters, or capture new evidence to populate the reviewer queue."
            action={
              <View style={styles.row}>
                <ProovraButton label="Upload / Capture Evidence" fullWidth={false} onPress={() => router.push("/capture")} />
                <ProovraButton label="Review Cases" variant="secondary" fullWidth={false} onPress={() => router.push("/cases")} />
              </View>
            }
          />
        ) : (
          <>
            <View style={styles.list}>
              {visibleItems.map((item) => {
                const title = rowTitle(item);
                const status = evidenceStatusDisplay(item.status);
                const caseName = item.caseId ? caseMap.get(item.caseId) ?? null : null;
                const active = item.id === inspectorId;
                return (
                  <View key={item.id} style={[styles.rowCard, active ? styles.rowActive : null]} testID={`evidence-row-${item.id}`}>
                    <Check checked={selected.has(item.id)} label={`Select evidence record ${title}`} onPress={() => toggleSelected(item.id)} />
                    <Pressable
                      style={styles.flex1}
                      onPress={() => openInspector(item.id)}
                      accessibilityRole="button"
                      accessibilityLabel={title}
                      accessibilityState={{ selected: active }}
                    >
                      <ProovraText variant="body" weight="semibold" numberOfLines={1}>
                        {title}
                      </ProovraText>
                      <ProovraText variant="label" mono color={theme.color.ink.muted}>
                        {shortId(item.id)}
                        {caseName ? `   Case: ${caseName}` : ""}
                      </ProovraText>
                      <ProovraText variant="label" color={theme.color.ink.secondary}>
                        {rowActivityLine(item)}
                      </ProovraText>
                      <ProovraText variant="label" color={theme.color.ink.muted}>
                        {formatUserDateTime(item.createdAt)}
                      </ProovraText>
                    </Pressable>
                    {canRestore ? (
                      <ProovraButton
                        label="Restore"
                        accessibilityLabel={`Restore ${title}`}
                        variant="secondary"
                        fullWidth={false}
                        loading={busyId === item.id}
                        onPress={() => restore(item)}
                      />
                    ) : (
                      <ProovraBadge tone={status.tone} label={recordStatusLabel(item.status)} />
                    )}
                  </View>
                );
              })}
            </View>

            <View style={styles.pagination}>
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                {`Page ${pageNumber}`}
              </ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                {`${visibleItems.length} page results`}
              </ProovraText>
              <View style={styles.row}>
                <ProovraButton label="Previous" variant="secondary" fullWidth={false} disabled={cursorHistory.length === 0} onPress={goPrevious} />
                <ProovraButton label="Next" variant="secondary" fullWidth={false} disabled={!hasNext} onPress={goNext} />
              </View>
            </View>
          </>
        )}
      </ProovraCard>

      {inspectorId ? inspector("modal") : null}
    </ProovraShell>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  block: { marginBottom: theme.space.s3 },
  boundary: { marginBottom: theme.space.s3, gap: theme.space.s1, borderLeftWidth: 4, borderLeftColor: theme.color.accent.a500 },
  filters: { gap: theme.space.s3 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginBottom: theme.space.s3 },
  trustChip: {
    paddingHorizontal: theme.space.s3,
    paddingVertical: 6,
    minHeight: 34,
    justifyContent: "center",
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.color.accent.a500,
    backgroundColor: theme.color.accent.a050,
  },
  queueHead: { gap: theme.space.s1, marginBottom: theme.space.s3 },
  selectAll: { flexDirection: "row", alignItems: "center", gap: theme.space.s2, marginBottom: theme.space.s2 },
  list: { gap: theme.space.s2 },
  rowCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.s3,
    padding: theme.space.s3,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border.default,
    backgroundColor: theme.color.surface.card,
  },
  rowActive: { borderColor: theme.color.accent.a500 },
  checkHit: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: theme.color.border.strong,
    alignItems: "center",
    justifyContent: "center",
  },
  boxOn: { backgroundColor: theme.color.accent.a500, borderColor: theme.color.accent.a500 },
  boxDisabled: { opacity: 0.4 },
  pagination: { marginTop: theme.space.s3, gap: theme.space.s2 },
});
