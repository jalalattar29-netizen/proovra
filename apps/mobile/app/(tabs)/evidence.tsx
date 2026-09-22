import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Image, Linking, Modal, Pressable, ScrollView, Share, View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import * as FileSystem from "expo-file-system";
import { apiFetch } from "../../src/api";
import {
  buildEvidenceBulkRequest,
  EVIDENCE_BULK_MAX_IDS,
  type EvidenceBulkActionName,
} from "@proovra/shared";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { formatUserDateTime } from "../../src/lib/date";
import { theme, statusTone } from "../../src/theme/theme";
import { useResponsive } from "../../src/theme/responsive";
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
  ProovraSheet,
  ProovraFormField,
} from "../../src/ui";
import { evidenceLifecycleDisplay, evidenceStatusDisplay, evidenceTypeLabel, EVIDENCE_TYPES, humanizeEnum } from "../../src/product/domain-display";
import {
  buildLibraryQuery,
  projectLibraryMetrics,
  hasActiveFilters,
  nextSort,
  sortLabel,
  parseSavedViews,
  buildSavedViewBody,
  buildSavedViewPath,
  buildSavedViewDefaultPath,
  buildSavedViewRenameBody,
  validateSavedViewName,
  withDefaultSavedView,
  defaultSavedViewToApply,
  SAVED_VIEW_NAME_MAX,
  parseEvidenceBulkResponse,
  resolveBulkSelection,
  projectInspectorEvidence,
  resolveInspectorPreview,
  projectInspectorArtifactState,
  safeCsvFilename,
  bulkActionsForScope,
  type InspectorEvidence,
  type InspectorArtifactState,
  STATUS_FILTERS,
  SOURCE_FILTERS,
  REPORT_FILTERS,
  type LibrarySort,
  type LibraryMetric,
  type SavedViewItem,
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
type CaseOption = {
  id: string;
  name: string;
  status?: string;
};

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
function Chip({
  label,
  active,
  onPress,
  onLongPress,
  accessibilityHint,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  /** A saved view chip carries its manage actions here. */
  onLongPress?: () => void;
  accessibilityHint?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: active }}
      style={[styles.smallChip, { backgroundColor: active ? theme.color.accent.a050 : theme.color.surface.card, borderColor: active ? theme.color.accent.a500 : theme.color.border.default }]}
    >
      <ProovraText variant="label" weight="semibold" color={active ? theme.color.accent.a600 : theme.color.ink.secondary}>
        {label}
      </ProovraText>
    </Pressable>
  );
}


type InspectorLoadState = "idle" | "loading" | "ready" | "error";

function EvidenceInspector({
  item,
  evidence,
  artifacts,
  state,
  error,
  presentation,
  actionBusy,
  onClose,
  onRetry,
  onOpenRecord,
  onOpenReport,
  onOpenPackage,
  onShareVerification,
}: {
  item: EvidenceItem | null;
  evidence: InspectorEvidence | null;
  artifacts: InspectorArtifactState | null;
  state: InspectorLoadState;
  error: SafeError | null;
  presentation: "modal" | "rail";
  actionBusy: string | null;
  onClose: () => void;
  onRetry: () => void;
  onOpenRecord: () => void;
  onOpenReport: () => void;
  onOpenPackage: () => void;
  onShareVerification: () => void;
}) {
  const preview = evidence ? resolveInspectorPreview(evidence) : null;
  const title =
    evidence?.displayTitle?.trim() ||
    evidence?.displayFileName?.trim() ||
    evidence?.originalFileName?.trim() ||
    (item ? rowTitle(item) : "Evidence");

  const body = (
    <View style={styles.inspector}>
      <View style={styles.inspectorHeader}>
        <View style={styles.inspectorHeading}>
          <ProovraText variant="h2" weight="bold" numberOfLines={2}>
            {title}
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted}>
            Evidence Inspector
          </ProovraText>
        </View>
        <ProovraButton
          label="Close"
          variant="ghost"
          fullWidth={false}
          onPress={onClose}
        />
      </View>

      {state === "loading" ? (
        <ProovraLoadingState label="Loading selected record" />
      ) : state === "error" && error ? (
        <ProovraErrorState message={error.message} onRetry={onRetry} />
      ) : !evidence ? (
        <ProovraEmptyState
          title="Preview unavailable"
          message="The selected evidence record could not be projected."
        />
      ) : (
        <>
          <View style={styles.inspectorBadgeRow}>
            <ProovraBadge
              tone={evidenceStatusDisplay(evidence.status).tone}
              label={
                evidence.statusLabel?.trim() ||
                evidenceStatusDisplay(evidence.status).label
              }
            />
            {evidence.verificationStatus ? (
              <ProovraBadge
                tone="neutral"
                label={
                  evidence.verificationStatusLabel?.trim() ||
                  humanizeEnum(evidence.verificationStatus)
                }
              />
            ) : null}
            {/*
              Lifecycle, shown only when it says something the scope does not.
              The tabs already separate ARCHIVED and TRASHED; LOCKED is the one
              that coexists with ACTIVE, and a locked record was rendering
              identically to an unlocked one. "This cannot be changed" is not a
              detail to leave the user to discover by trying.
            */}
            {evidence.lifecycleState && evidence.lifecycleState !== "ACTIVE" ? (
              <ProovraBadge
                tone={evidenceLifecycleDisplay(evidence.lifecycleState).tone}
                label={evidenceLifecycleDisplay(evidence.lifecycleState).label}
              />
            ) : null}
          </View>

          <ProovraCard style={styles.inspectorMeta}>
            <InspectorMetaRow
              label="Type"
              value={evidenceTypeLabel(evidence.type)}
            />
            <InspectorMetaRow
              label="Created"
              value={
                evidence.createdAt
                  ? formatUserDateTime(evidence.createdAt)
                  : "—"
              }
            />
            <InspectorMetaRow
              label="Record"
              value={evidence.id}
            />
          </ProovraCard>

          <View style={styles.inspectorBlock}>
            <ProovraText variant="body" weight="semibold">
              Evidence Preview
            </ProovraText>

            {preview?.kind === "image" ? (
              <Image
                source={{ uri: preview.url }}
                resizeMode="contain"
                style={styles.inspectorImage}
                accessibilityLabel={
                  preview.item.label ||
                  preview.item.originalFileName ||
                  "Evidence preview"
                }
              />
            ) : preview?.kind === "external" ? (
              <ProovraCard style={styles.previewNotice}>
                <ProovraText variant="bodySm" weight="semibold">
                  Preview available
                </ProovraText>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  This media type opens with the device viewer.
                </ProovraText>
                <ProovraButton
                  label="Open Preview"
                  variant="secondary"
                  fullWidth={false}
                  onPress={() => void Linking.openURL(preview.url)}
                />
              </ProovraCard>
            ) : preview?.kind === "restricted" ? (
              <ProovraCard style={styles.previewNotice}>
                <ProovraText variant="bodySm" weight="semibold">
                  Preview restricted
                </ProovraText>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  Content access is not granted for this projection.
                </ProovraText>
              </ProovraCard>
            ) : preview?.kind === "unsupported" ? (
              <ProovraCard style={styles.previewNotice}>
                <ProovraText variant="bodySm" weight="semibold">
                  Preview not supported
                </ProovraText>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  The evidence record is available, but this item cannot be
                  rendered inline.
                </ProovraText>
              </ProovraCard>
            ) : (
              <ProovraCard style={styles.previewNotice}>
                <ProovraText variant="bodySm" weight="semibold">
                  No preview available
                </ProovraText>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  No previewable content item is available for this record.
                </ProovraText>
              </ProovraCard>
            )}
          </View>

          <View style={styles.inspectorBlock}>
            <ProovraText variant="body" weight="semibold">
              Technical Materials
            </ProovraText>

            <ProovraListRow
              title="Report"
              subtitle={
                artifacts?.report
                  ? humanizeEnum(artifacts.report)
                  : "Status unavailable"
              }
              trailing={
                artifacts?.report === "READY" ? (
                  <ProovraButton
                    label="Open"
                    variant="secondary"
                    fullWidth={false}
                    loading={actionBusy === "report"}
                    onPress={onOpenReport}
                  />
                ) : (
                  <ProovraBadge
                    tone="neutral"
                    label={
                      artifacts?.report
                        ? humanizeEnum(artifacts.report)
                        : "Unavailable"
                    }
                  />
                )
              }
            />

            <ProovraListRow
              title="Verification Package"
              subtitle={
                artifacts?.verificationPackage
                  ? humanizeEnum(artifacts.verificationPackage)
                  : "Requested only when you open it"
              }
              trailing={
                <ProovraButton
                  label="Open"
                  variant="secondary"
                  fullWidth={false}
                  loading={actionBusy === "package"}
                  onPress={onOpenPackage}
                />
              }
            />

            <ProovraListRow
              title="Public Verification"
              subtitle="Use the server-published verification URL"
              trailing={
                <ProovraButton
                  label="Share"
                  variant="secondary"
                  fullWidth={false}
                  loading={actionBusy === "verify"}
                  onPress={onShareVerification}
                />
              }
            />
          </View>

          <View style={styles.inspectorFooter}>
            <ProovraButton
              label="Open Evidence"
              onPress={onOpenRecord}
            />
          </View>
        </>
      )}
    </View>
  );

  if (presentation === "rail") {
    return (
      <View style={styles.inspectorRail}>
        <ScrollView
          contentContainerStyle={styles.inspectorScroll}
          showsVerticalScrollIndicator={false}
        >
          {body}
        </ScrollView>
      </View>
    );
  }

  return (
    <Modal
      visible
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.inspectorModalBackdrop}>
        <View style={styles.inspectorModal}>
          <ScrollView
            contentContainerStyle={styles.inspectorScroll}
            showsVerticalScrollIndicator={false}
          >
            {body}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function InspectorMetaRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <View style={styles.inspectorMetaRow}>
      <ProovraText variant="label" color={theme.color.ink.muted}>
        {label}
      </ProovraText>
      <ProovraText
        variant="bodySm"
        weight="semibold"
        numberOfLines={2}
        style={styles.inspectorMetaValue}
      >
        {value}
      </ProovraText>
    </View>
  );
}

/** Canonical Native Evidence Library — one surface, four lifecycle scopes. */
export default function EvidenceLibraryScreen() {
  const router = useRouter();
  const responsive = useResponsive();
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
  const [savedViews, setSavedViews] = useState<SavedViewItem[]>([]);
  const [savingView, setSavingView] = useState(false);
  const [newViewName, setNewViewName] = useState("");
  const [showSaveView, setShowSaveView] = useState(false);
  /** The view whose manage sheet is open: rename, default, delete. */
  const [managingView, setManagingView] = useState<SavedViewItem | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [viewBusy, setViewBusy] = useState(false);
  /** The default view is applied at most once, and never over a live filter. */
  const defaultViewApplied = useRef(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [caseChooserOpen, setCaseChooserOpen] = useState(false);
  const [caseOptions, setCaseOptions] = useState<CaseOption[]>([]);
  const [caseOptionsState, setCaseOptionsState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [caseOptionsError, setCaseOptionsError] = useState<SafeError | null>(null);

  // Inspector selection is deliberately independent from checkbox/bulk selection.
  const [inspectorId, setInspectorId] = useState<string | null>(null);
  const [inspectorEvidence, setInspectorEvidence] = useState<InspectorEvidence | null>(null);
  const [inspectorArtifacts, setInspectorArtifacts] = useState<InspectorArtifactState | null>(null);
  const [inspectorState, setInspectorState] = useState<InspectorLoadState>("idle");
  const [inspectorError, setInspectorError] = useState<SafeError | null>(null);
  const [inspectorActionBusy, setInspectorActionBusy] = useState<string | null>(null);

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

  // Server-persisted saved views (GET /v1/evidence/saved-views) — not fake local.
  const loadViews = useCallback(async () => {
    try {
      setSavedViews(parseSavedViews(await apiFetch("/v1/evidence/saved-views")));
    } catch {
      setSavedViews([]);
    }
  }, []);
  useEffect(() => { void loadViews(); }, [loadViews]);

  /**
   * The default saved view, applied once on first load.
   *
   * It was read and ignored: an operator could set a default on the web and
   * the phone opened on the unfiltered library every time. Never applied over
   * a filter or a search the user has already set - a default that overrode a
   * live choice would be the surface arguing with them - and never twice, so
   * clearing it stays cleared.
   */
  useEffect(() => {
    if (defaultViewApplied.current || savedViews.length === 0) return;
    const untouched =
      !hasActiveFilters({
        type: typeFilter,
        status: statusFilter,
        source: sourceFilter,
        reportReady: reportFilter,
      }) && query.trim() === "";
    const view = defaultSavedViewToApply(savedViews, untouched);
    defaultViewApplied.current = true;
    if (view) applyView(view);
    // Intentionally keyed on the views alone: this runs on the FIRST list
    // that arrives, reading the filters as they are at that moment. The ref
    // guard is what makes running once correct rather than accidental.
  }, [savedViews]);

  const openViewManager = useCallback((v: SavedViewItem) => {
    setManagingView(v);
    setRenameDraft(v.name);
  }, []);

  /**
   * Rename. The route also accepts scope / filters / sortKey, and neither
   * client sends them from the list: overwriting a view's filters is a
   * different act from renaming it, and one control doing both is how an
   * operator loses the view they meant to keep.
   */
  const renameView = useCallback(async () => {
    const target = managingView;
    if (!target) return;
    const invalid = validateSavedViewName(renameDraft);
    if (invalid) {
      Alert.alert("Could not rename view", invalid);
      return;
    }
    setViewBusy(true);
    try {
      await apiFetch(buildSavedViewPath(target.id), {
        method: "PATCH",
        body: JSON.stringify(buildSavedViewRenameBody(renameDraft)),
      });
      setManagingView(null);
      await loadViews();
    } catch (err) {
      Alert.alert("Could not rename view", toSafeUserError(err).message);
    } finally {
      setViewBusy(false);
    }
  }, [managingView, renameDraft, loadViews]);

  /**
   * The server clears the previous default in the same workspace, so the local
   * fold-in clears it too - otherwise the list shows two defaults until the
   * next read.
   */
  const makeViewDefault = useCallback(async () => {
    const target = managingView;
    if (!target) return;
    setViewBusy(true);
    try {
      await apiFetch(buildSavedViewDefaultPath(target.id), { method: "POST" });
      setSavedViews((prev) => withDefaultSavedView(prev, target.id));
      setManagingView(null);
      await loadViews();
    } catch (err) {
      Alert.alert("Could not set default view", toSafeUserError(err).message);
    } finally {
      setViewBusy(false);
    }
  }, [managingView, loadViews]);

  /** Deleting asks first: a saved view is a filter the operator composed. */
  const deleteView = useCallback(() => {
    const target = managingView;
    if (!target) return;
    Alert.alert(
      "Delete saved view",
      `Delete "${target.name}"? The evidence it filtered is not affected.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setViewBusy(true);
              try {
                await apiFetch(buildSavedViewPath(target.id), { method: "DELETE" });
                setManagingView(null);
                await loadViews();
              } catch (err) {
                Alert.alert("Could not delete view", toSafeUserError(err).message);
              } finally {
                setViewBusy(false);
              }
            })();
          },
        },
      ],
    );
  }, [managingView, loadViews]);

  const applyView = useCallback((v: SavedViewItem) => {
    setScope(v.scope as Scope);
    setTypeFilter(v.type);
    setStatusFilter(v.status);
    setSort(v.sort);
    setSourceFilter("ALL"); setReportFilter("ALL");
    setQuery(v.search);
  }, []);

  const saveView = useCallback(async () => {
    const name = newViewName.trim();
    if (!name) return;
    setSavingView(true);
    try {
      await apiFetch("/v1/evidence/saved-views", {
        method: "POST",
        body: JSON.stringify(buildSavedViewBody({ name, scope, type: typeFilter, status: statusFilter, search: query, sort })),
      });
      setNewViewName(""); setShowSaveView(false);
      await loadViews();
    } catch (err) {
      Alert.alert("Could not save view", toSafeUserError(err).message);
    } finally {
      setSavingView(false);
    }
  }, [newViewName, scope, typeFilter, statusFilter, query, sort, loadViews]);

  const toggleSelected = useCallback((idv: string) => {
    setSelected((prev) => {
      const next = new Set(prev);

      if (next.has(idv)) {
        next.delete(idv);
        return next;
      }

      if (next.size >= EVIDENCE_BULK_MAX_IDS) {
        Alert.alert(
          "Selection limit",
          `You can select up to ${EVIDENCE_BULK_MAX_IDS} evidence records at once.`,
        );
        return prev;
      }

      next.add(idv);
      return next;
    });
  }, []);

  const loadCaseOptions = useCallback(async () => {
    setCaseOptionsState("loading");
    setCaseOptionsError(null);

    try {
      const data = await apiFetch("/v1/cases");
      const raw = Array.isArray(data?.items) ? data.items : [];

      const cases: CaseOption[] = raw
        .filter(
          (item: unknown): item is Record<string, unknown> =>
            !!item &&
            typeof item === "object" &&
            typeof (item as Record<string, unknown>).id === "string" &&
            typeof (item as Record<string, unknown>).name === "string",
        )
        .map(
          (item: Record<string, unknown>): CaseOption => ({
            id: item.id as string,
            name: (item.name as string).trim(),
            status: typeof item.status === "string" ? item.status : undefined,
          }),
        )
        .filter((item: CaseOption) => item.id.length > 0 && item.name.length > 0);

      setCaseOptions(cases);
      setCaseOptionsState("ready");
    } catch (err) {
      setCaseOptions([]);
      setCaseOptionsError(toSafeUserError(err));
      setCaseOptionsState("error");
    }
  }, []);

  const executeBulk = useCallback(
    (
      spec: { action: EvidenceBulkActionName; label: string; destructive?: boolean },
      ids: string[],
      caseId?: string,
    ) => {
      Alert.alert(
        spec.label,
        `${spec.label} ${ids.length} record${ids.length === 1 ? "" : "s"}?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: spec.label,
            style: spec.destructive ? "destructive" : "default",
            onPress: () => {
              void (async () => {
                setBulkBusy(true);

                try {
                  const response = await apiFetch("/v1/evidence/bulk", {
                    method: "POST",
                    body: JSON.stringify(
                      buildEvidenceBulkRequest({
                        action: spec.action,
                        evidenceIds: ids,
                        caseId,
                      }),
                    ),
                  });

                  const parsed = parseEvidenceBulkResponse(response);

                  if (spec.action === "EXPORT_METADATA_CSV") {
                    if (!parsed.csv) {
                      Alert.alert(
                        "Export unavailable",
                        "The server did not return a CSV export for this selection.",
                      );
                      return;
                    }

                    if (!FileSystem.cacheDirectory) {
                      Alert.alert(
                        "Export unavailable",
                        "A writable temporary directory is not available on this device.",
                      );
                      return;
                    }

                    const filename = safeCsvFilename(parsed.fileName);
                    const uri = `${FileSystem.cacheDirectory}${filename}`;

                    await FileSystem.writeAsStringAsync(uri, parsed.csv, {
                      encoding: FileSystem.EncodingType.UTF8,
                    });

                    await Share.share({
                      url: uri,
                      title: filename,
                      message: filename,
                    });

                    return;
                  }

                  const remainingIds = resolveBulkSelection(ids, parsed);

                  // Accepted/queued is explicitly non-terminal. Keep the
                  // operator's selection intact and do not claim completion.
                  if (parsed.accepted === true || parsed.queued === true) {
                    setSelected(new Set(remainingIds));
                    setSelectionMode(true);
                    setCaseChooserOpen(false);

                    Alert.alert(
                      "Bulk action queued",
                      typeof parsed.pendingCount === "number" && parsed.pendingCount > 0
                        ? `${parsed.pendingCount} record${parsed.pendingCount === 1 ? "" : "s"} pending.`
                        : "The action was accepted and is still being processed.",
                    );
                    return;
                  }

                  setSelected(new Set(remainingIds));
                  setSelectionMode(remainingIds.length > 0);
                  setCaseChooserOpen(false);

                  if (typeof parsed.failedCount === "number" && parsed.failedCount > 0) {
                    Alert.alert(
                      "Bulk action partially completed",
                      `${parsed.successCount ?? 0} completed, ${parsed.failedCount} failed. Failed records remain selected.`,
                    );
                  }

                  await reload();
                } catch (err) {
                  Alert.alert("Bulk action failed", toSafeUserError(err).message);
                } finally {
                  setBulkBusy(false);
                }
              })();
            },
          },
        ],
      );
    },
    [reload],
  );

  const runBulk = useCallback(
    (spec: { action: EvidenceBulkActionName; label: string; destructive?: boolean }) => {
      const ids = [...selected];
      if (ids.length === 0) return;

      if (spec.action === "ADD_TO_CASE") {
        setCaseChooserOpen(true);

        if (caseOptionsState === "idle" || caseOptionsState === "error") {
          void loadCaseOptions();
        }

        return;
      }

      executeBulk(spec, ids);
    },
    [selected, caseOptionsState, loadCaseOptions, executeBulk],
  );

  const addSelectionToCase = useCallback(
    (caseOption: CaseOption) => {
      const ids = [...selected];
      if (ids.length === 0) return;

      executeBulk(
        {
          action: "ADD_TO_CASE",
          label: `Add to ${caseOption.name}`,
        },
        ids,
        caseOption.id,
      );
    },
    [selected, executeBulk],
  );


  const loadInspector = useCallback(async (evidenceId: string) => {
    setInspectorState("loading");
    setInspectorError(null);
    setInspectorEvidence(null);
    setInspectorArtifacts(null);

    try {
      // Core record first. This is the authority for preview/content policy.
      const coreData = await apiFetch(`/v1/evidence/${evidenceId}`);
      const projected = projectInspectorEvidence(coreData);

      if (!projected) {
        throw new Error("The selected evidence record could not be projected.");
      }

      setInspectorEvidence(projected);

      // Side-effect-free artifact status. Do NOT mint report/package URLs here.
      try {
        const statusData = await apiFetch(
          `/v1/evidence/${evidenceId}/artifacts/status`,
        );
        setInspectorArtifacts(projectInspectorArtifactState(statusData));
      } catch {
        setInspectorArtifacts(null);
      }

      setInspectorState("ready");
    } catch (err) {
      setInspectorError(toSafeUserError(err));
      setInspectorState("error");
    }
  }, []);

  const openInspector = useCallback(
    (evidenceId: string) => {
      setInspectorId(evidenceId);
      void loadInspector(evidenceId);
    },
    [loadInspector],
  );

  const closeInspector = useCallback(() => {
    // Never mutate bulk selection here.
    setInspectorId(null);
    setInspectorEvidence(null);
    setInspectorArtifacts(null);
    setInspectorError(null);
    setInspectorState("idle");
    setInspectorActionBusy(null);
  }, []);

  const openInspectorReport = useCallback(async () => {
    if (!inspectorId || inspectorArtifacts?.report !== "READY") return;

    setInspectorActionBusy("report");
    try {
      // STATUS-BEFORE-URL: this is reached only after READY.
      const response = await apiFetch(
        `/v1/evidence/${inspectorId}/report/latest`,
      );
      const url =
        typeof response?.url === "string" && response.url
          ? response.url
          : null;

      if (!url) {
        Alert.alert(
          "Report unavailable",
          "The report is marked ready, but no download URL was returned.",
        );
        return;
      }

      await Linking.openURL(url);
    } catch (err) {
      Alert.alert("Could not open report", toSafeUserError(err).message);
    } finally {
      setInspectorActionBusy(null);
    }
  }, [inspectorId, inspectorArtifacts]);

  const openInspectorPackage = useCallback(async () => {
    if (!inspectorId) return;

    setInspectorActionBusy("package");
    try {
      // Intentionally action-time only: never mint a package URL on Inspector mount.
      const response = await apiFetch(
        `/v1/evidence/${inspectorId}/verification-package`,
      );
      const url =
        typeof response?.url === "string" && response.url
          ? response.url
          : null;

      if (!url) {
        const message =
          typeof response?.message === "string" && response.message
            ? response.message
            : "The verification package is not available for this record.";
        Alert.alert("Package unavailable", message);
        return;
      }

      await Linking.openURL(url);
    } catch (err) {
      Alert.alert(
        "Could not open verification package",
        toSafeUserError(err).message,
      );
    } finally {
      setInspectorActionBusy(null);
    }
  }, [inspectorId]);

  const shareInspectorVerification = useCallback(async () => {
    if (!inspectorId) return;

    setInspectorActionBusy("verify");
    try {
      const response = await apiFetch(`/public/verify/${inspectorId}`);
      const url =
        typeof response?.publicUrl === "string" && response.publicUrl
          ? response.publicUrl
          : null;

      if (!url) {
        Alert.alert(
          "Not published",
          "Public verification is not published for this record.",
        );
        return;
      }

      await Share.share({
        url,
        message: `Verify this PROOVRA record: ${url}`,
      });
    } catch (err) {
      const safe = toSafeUserError(err);
      Alert.alert(
        safe.kind === "notFound" ? "Not published" : "Could not share",
        safe.kind === "notFound"
          ? "Public verification is not published for this record."
          : safe.message,
      );
    } finally {
      setInspectorActionBusy(null);
    }
  }, [inspectorId]);

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

        <View style={styles.filterRow}>
          {savedViews.map((v) => (
            <Chip
              key={v.id}
              // The default is marked, because "which view am I in" is the
              // first question a saved view raises.
              label={v.isDefault ? `${v.name} ·` : v.name}
              active={false}
              onPress={() => applyView(v)}
              onLongPress={() => openViewManager(v)}
              accessibilityHint="Double tap to apply. Long press to rename, set as default, or delete."
            />
          ))}
          <Chip label={showSaveView ? "Cancel save" : "＋ Save view"} active={showSaveView} onPress={() => setShowSaveView((s) => !s)} />
          <Chip label={selectionMode ? "Done" : "Select"} active={selectionMode} onPress={() => { setSelectionMode((m) => !m); setSelected(new Set()); }} />
        </View>

        {showSaveView ? (
          <ProovraCard style={styles.filterPanel}>
            <ProovraInput value={newViewName} onChangeText={setNewViewName} placeholder="Name this view" autoCapitalize="sentences" onSubmitEditing={() => void saveView()} />
            {sourceFilter !== "ALL" || reportFilter !== "ALL" ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>
                Saved views preserve scope, search, type, status and sort. Source and report filters are not part of the current saved-view contract.
              </ProovraText>
            ) : null}
            <ProovraButton label="Save current view" loading={savingView} disabled={!newViewName.trim()} onPress={() => void saveView()} />
          </ProovraCard>
        ) : null}

        {/*
          MANAGING ONE SAVED VIEW — rename, make default, delete.
          All three routes existed from the beginning and none was called,
          so a view saved under the wrong name was permanent on a phone.
        */}
        <ProovraSheet
          visible={managingView !== null}
          title={managingView ? managingView.name : "Saved view"}
          onClose={() => setManagingView(null)}
        >
          <ProovraFormField label="Name">
            <ProovraInput
              value={renameDraft}
              onChangeText={setRenameDraft}
              placeholder={`Up to ${SAVED_VIEW_NAME_MAX} characters`}
              autoCapitalize="sentences"
              accessibilityLabel="Saved view name"
            />
          </ProovraFormField>
          <ProovraButton
            label="Rename view"
            loading={viewBusy}
            disabled={
              validateSavedViewName(renameDraft) !== null ||
              renameDraft.trim() === (managingView?.name ?? "")
            }
            onPress={() => void renameView()}
          />
          {managingView?.isDefault ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>
              This is the view the library opens on.
            </ProovraText>
          ) : (
            <ProovraButton
              label="Open the library on this view"
              variant="secondary"
              loading={viewBusy}
              onPress={() => void makeViewDefault()}
            />
          )}
          <ProovraButton
            label="Delete view"
            variant="ghost"
            loading={viewBusy}
            onPress={deleteView}
          />
        </ProovraSheet>

        {selectionMode && selected.size > 0 && caseChooserOpen ? (
          <ProovraCard style={styles.caseChooser}>
            <View style={styles.caseChooserHeader}>
              <View style={styles.caseChooserTitle}>
                <ProovraText variant="body" weight="semibold">
                  Add selected evidence to a case
                </ProovraText>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  Choose the target case for {selected.size} selected record{selected.size === 1 ? "" : "s"}.
                </ProovraText>
              </View>

              <ProovraButton
                label="Cancel"
                variant="ghost"
                fullWidth={false}
                onPress={() => setCaseChooserOpen(false)}
              />
            </View>

            {caseOptionsState === "loading" ? (
              <ProovraLoadingState label="Loading cases" />
            ) : caseOptionsState === "error" && caseOptionsError ? (
              <ProovraErrorState
                message={caseOptionsError.message}
                onRetry={() => void loadCaseOptions()}
              />
            ) : caseOptions.length === 0 ? (
              <ProovraEmptyState
                title="No cases available"
                message="Create a case before adding evidence to one."
              />
            ) : (
              <View style={styles.caseList}>
                {caseOptions.map((caseOption) => (
                  <ProovraListRow
                    key={caseOption.id}
                    title={caseOption.name}
                    subtitle={caseOption.status ? humanizeEnum(caseOption.status) : undefined}
                    onPress={() => addSelectionToCase(caseOption)}
                    trailing={<ProovraBadge tone="neutral" label="Add" />}
                  />
                ))}
              </View>
            )}
          </ProovraCard>
        ) : null}

        {selectionMode && selected.size > 0 ? (
          <ProovraCard style={styles.bulkBar}>
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>{selected.size} selected</ProovraText>
            <View style={styles.filterRow}>
              {bulkActionsForScope(scope).map((a) => (
                <ProovraButton key={a.action} label={a.label} variant={a.destructive ? "danger" : "secondary"} fullWidth={false} loading={bulkBusy} onPress={() => runBulk(a)} />
              ))}
            </View>
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
                const isSel = selected.has(item.id);
                return (
                  <ProovraListRow
                    key={item.id}
                    title={`${selectionMode ? (isSel ? "☑  " : "☐  ") : ""}${rowTitle(item)}`}
                    subtitle={item.displaySubtitle?.trim() || `${evidenceTypeLabel(item.type)} · ${formatUserDateTime(item.createdAt)}`}
                    onPress={() => (selectionMode ? toggleSelected(item.id) : openInspector(item.id))}
                    trailing={
                      selectionMode ? (
                        <ProovraBadge tone={isSel ? "verified" : "neutral"} label={isSel ? "Selected" : "Tap"} />
                      ) : canRestore ? (
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

        {inspectorId && responsive.isTablet ? (
          <EvidenceInspector
            item={items.find((item) => item.id === inspectorId) ?? null}
            evidence={inspectorEvidence}
            artifacts={inspectorArtifacts}
            state={inspectorState}
            error={inspectorError}
            presentation="rail"
            actionBusy={inspectorActionBusy}
            onClose={closeInspector}
            onRetry={() => void loadInspector(inspectorId)}
            onOpenRecord={() => router.push(`/evidence/${inspectorId}`)}
            onOpenReport={() => void openInspectorReport()}
            onOpenPackage={() => void openInspectorPackage()}
            onShareVerification={() => void shareInspectorVerification()}
          />
        ) : null}

        {inspectorId && !responsive.isTablet ? (
          <EvidenceInspector
            item={items.find((item) => item.id === inspectorId) ?? null}
            evidence={inspectorEvidence}
            artifacts={inspectorArtifacts}
            state={inspectorState}
            error={inspectorError}
            presentation="modal"
            actionBusy={inspectorActionBusy}
            onClose={closeInspector}
            onRetry={() => void loadInspector(inspectorId)}
            onOpenRecord={() => router.push(`/evidence/${inspectorId}`)}
            onOpenReport={() => void openInspectorReport()}
            onOpenPackage={() => void openInspectorPackage()}
            onShareVerification={() => void shareInspectorVerification()}
          />
        ) : null}
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
  bulkBar: { marginBottom: theme.space.s3, gap: theme.space.s2 },
  caseChooser: { marginBottom: theme.space.s3, gap: theme.space.s3 },
  caseChooserHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: theme.space.s3 },
  caseChooserTitle: { flex: 1, gap: 2 },
  caseList: { gap: theme.space.s1 },
  smallChip: { paddingHorizontal: theme.space.s3, paddingVertical: 6, borderRadius: theme.radius.pill, borderWidth: 1, minHeight: 34, justifyContent: "center" },
  more: { marginTop: theme.space.s4 },

  inspectorRail: {
    marginTop: theme.space.s4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border.default,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.color.surface.card,
    maxHeight: 720,
    overflow: "hidden",
  },
  inspectorModalBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.34)",
  },
  inspectorModal: {
    maxHeight: "90%",
    backgroundColor: theme.color.surface.app,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    overflow: "hidden",
  },
  inspectorScroll: {
    padding: theme.space.s4,
  },
  inspector: {
    gap: theme.space.s4,
  },
  inspectorHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.space.s3,
  },
  inspectorHeading: {
    flex: 1,
    gap: 2,
  },
  inspectorBadgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.space.s2,
  },
  inspectorMeta: {
    gap: theme.space.s2,
  },
  inspectorMetaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: theme.space.s3,
  },
  inspectorMetaValue: {
    flex: 1,
    textAlign: "right",
  },
  inspectorBlock: {
    gap: theme.space.s2,
  },
  inspectorImage: {
    width: "100%",
    height: 260,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surface.muted,
  },
  previewNotice: {
    gap: theme.space.s2,
  },
  inspectorFooter: {
    paddingTop: theme.space.s2,
  },
});
