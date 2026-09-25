import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { apiFetch } from "../../src/api";
import { toSafeUserError } from "../../src/errors/safe-error";
import { formatUserDate, formatUserDateTime } from "../../src/lib/date";
import {
  resolveInboxUnread,
  resolveInboxRoute,
  inboxItemActionPath,
  type InboxItemAction,
} from "../../src/product/inbox";
import {
  ARCHIVED_ALWAYS_READ,
  CATEGORY_LABELS,
  DEFAULT_INBOX_SORT,
  INBOX_FILTER_LABELS,
  INBOX_SORT_OPTIONS,
  NOTIFICATION_METRICS,
  PRIMARY_VIEW_LABELS,
  TONE_LABELS,
  TONE_STATUS,
  activeInboxFilterCount,
  buildInboxQueryPath,
  deriveInboxFilterContext,
  inboxItemMeta,
  inboxMetricCount,
  inboxPopulationTotal,
  inboxResultNoun,
  inboxShowingText,
  inboxWorkspaceOptions,
  isInboxTone,
  parseInboxEnvelope,
  visibleInboxFilterGroups,
  type InboxCategoryFilter,
  type InboxEnvelope,
  type InboxSort,
  type InboxViewItem,
  type PrimaryView,
} from "../../src/product/inbox-view";
import { usePlatformContext } from "../../src/product/platform-context";
import { theme } from "../../src/theme/theme";
import { useToast } from "../../src/toast-context";
import {
  ProovraShell,
  ProovraCard,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraText,
  ProovraSheet,
  ProovraEmpty,
  ProovraFilterChips,
  ProovraKpiGrid,
  ProovraPageHeader,
  ProovraCursorPager,
  ProovraLoadingState,
} from "../../src/ui";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: InboxEnvelope }
  | { kind: "error"; status: number; message: string };

/**
 * NOTIFICATIONS — the native port of the canonical inbox page
 * (`apps/web/app/(app)/inbox/page.tsx`). Every axis — the primary view the
 * metric cards select, the category filter, the archive status, the workspace
 * and the sort — is sent to `GET /v1/me/inbox` and applied by the server to
 * the full population; the list pages by the server's cursor.
 */
export default function NotificationsScreen() {
  const router = useRouter();
  const { addToast } = useToast();
  const platform = usePlatformContext();

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  /** The chrome draws from the last envelope while the next one loads (web lastEnvelope). */
  const [lastEnvelope, setLastEnvelope] = useState<InboxEnvelope | null>(null);
  const [items, setItems] = useState<InboxViewItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const [primaryView, setPrimaryView] = useState<PrimaryView>("all");
  const [category, setCategory] = useState<InboxCategoryFilter>("all");
  const [archived, setArchived] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("all");
  const [sort, setSort] = useState<InboxSort>(DEFAULT_INBOX_SORT);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);

  const generation = useRef(0);
  const query = useMemo(
    () => ({ primaryView, category, archived, workspaceId, sort }),
    [primaryView, category, archived, workspaceId, sort],
  );

  const load = useCallback(async () => {
    const mine = (generation.current += 1);
    setState({ kind: "loading" });
    try {
      const data = parseInboxEnvelope(await apiFetch(buildInboxQueryPath(query)));
      // A newer load (a filter changed meanwhile) owns the screen.
      if (mine !== generation.current) return;
      setState({ kind: "ready", data });
      setLastEnvelope(data);
      setItems(data.items);
      setNextCursor(data.nextCursor);
    } catch (err) {
      if (mine !== generation.current) return;
      const status = typeof (err as { statusCode?: unknown })?.statusCode === "number" ? (err as { statusCode: number }).statusCode : 0;
      setState({ kind: "error", status, message: toSafeUserError(err, { message: "Could not load inbox." }).message });
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    try {
      const data = parseInboxEnvelope(await apiFetch(buildInboxQueryPath({ ...query, cursor: nextCursor })));
      if (mine !== generation.current) return;
      setItems((prev) => [...prev, ...data.items]);
      setNextCursor(data.nextCursor);
      setState({ kind: "ready", data });
      setLastEnvelope(data);
    } catch (err) {
      // The button stays as the retry surface; what is on screen is kept.
      addToast(toSafeUserError(err, { message: "Could not load more." }).message, "error");
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, query, addToast]);

  /** Per-item read / unread / archive / unarchive, optimistic then reconciled. */
  const act = useCallback(
    async (item: InboxViewItem, action: InboxItemAction) => {
      if (pendingKey) return;
      setPendingKey(item.itemKey);
      const before = items;
      setItems((prev) =>
        action === "archive"
          ? prev.filter((i) => i.itemKey !== item.itemKey)
          : prev.map((i) =>
              i.itemKey !== item.itemKey
                ? i
                : action === "unarchive"
                  ? { ...i, dismissedAt: null }
                  : { ...i, isRead: action === "read" },
            ),
      );
      try {
        await apiFetch(inboxItemActionPath(item.itemKey, action), { method: "POST" });
      } catch (err) {
        setItems(before);
        addToast(toSafeUserError(err).message, "error");
      } finally {
        setPendingKey(null);
      }
    },
    [items, pendingKey, addToast],
  );

  const open = useCallback(
    (item: InboxViewItem, route: string) => {
      // Opening marks read, fire-and-forget (web Open link onClick).
      if (!item.isRead && item.canMarkRead) void act(item, "read");
      router.push(route as never);
    },
    [act, router],
  );

  /**
   * The web moved "Mark all as read" to its header bell, the surface where
   * clearing everything is what a person wants. Native has no bell panel, so
   * the capability stays reachable here — the same scoped POST.
   */
  const markAllRead = useCallback(async () => {
    setMarkingAll(true);
    try {
      await apiFetch("/v1/me/inbox/mark-all-read", { method: "POST" });
      await load();
    } catch (err) {
      addToast(toSafeUserError(err).message, "error");
    } finally {
      setMarkingAll(false);
    }
  }, [load, addToast]);

  const selectView = useCallback((v: PrimaryView) => setPrimaryView(v), []);
  /** Archived composes with the view — except Unread, which it cannot contain. */
  const toggleArchived = useCallback(() => {
    setArchived((was) => {
      if (!was) setPrimaryView((v) => (v === "unread" ? "all" : v));
      return !was;
    });
  }, []);
  const clearAllFilters = useCallback(() => {
    setCategory("all");
    setArchived(false);
    setWorkspaceId("all");
  }, []);

  const shell: InboxEnvelope | null = state.kind === "ready" ? state.data : lastEnvelope;
  const filterCtx = useMemo(() => deriveInboxFilterContext(platform.envelope), [platform.envelope]);
  const groups = visibleInboxFilterGroups(filterCtx, shell);
  const workspaceOptions = useMemo(() => inboxWorkspaceOptions(platform.envelope), [platform.envelope]);
  const activeCount = activeInboxFilterCount({ category, archived, workspaceId });
  const unread = shell ? resolveInboxUnread({ metricSummary: shell.metricSummary, scopeSummary: shell.scopeSummary }) ?? 0 : 0;

  const activeChips: Array<{ id: string; label: string; clear: () => void }> = [];
  if (archived) activeChips.push({ id: "archived", label: "Archived", clear: () => setArchived(false) });
  if (category !== "all") activeChips.push({ id: category, label: INBOX_FILTER_LABELS[category], clear: () => setCategory("all") });
  if (workspaceId !== "all") {
    activeChips.push({
      id: `workspace:${workspaceId}`,
      label: workspaceOptions.find((o) => o.value === workspaceId)?.label ?? "Workspace",
      clear: () => setWorkspaceId("all"),
    });
  }

  return (
    <ProovraShell>
      <ProovraPageHeader
        title="Notifications"
        subtitle="Updates, assignments, mentions and integrity alerts relevant to you."
        primaryAction={
          <ProovraButton
            label={state.kind === "loading" ? "Refreshing…" : "Refresh"}
            accessibilityLabel="Refresh"
            variant="primary"
            fullWidth={false}
            disabled={state.kind === "loading"}
            onPress={() => void load()}
          />
        }
        secondaryActions={
          !archived && unread > 0 ? (
            <ProovraButton
              label={`Mark all read (${unread})`}
              variant="ghost"
              fullWidth={false}
              loading={markingAll}
              onPress={() => void markAllRead()}
            />
          ) : undefined
        }
      />

      {/* The preferences that decide what appears here, reached from the list itself. */}
      <ProovraListRow
        title="Notification preferences"
        subtitle="Choose which notifications reach you, and how"
        onPress={() => router.push("/(stack)/settings/notifications")}
      />

      {shell ? (
        <View accessibilityLabel="Notification summary" style={styles.block}>
          <ProovraKpiGrid
            items={NOTIFICATION_METRICS.map((m) => {
              const impossible = m.key === "unread" && archived;
              return {
                key: m.key,
                label: m.label,
                value: String(inboxMetricCount(m.key, shell)),
                caption: impossible ? ARCHIVED_ALWAYS_READ : m.explanation,
                tone: m.tone,
                selected: primaryView === m.key,
                // The one impossible card is inert, and says why.
                onPress: impossible ? undefined : () => selectView(m.key),
              };
            })}
          />
          {!shell.mayAssertAllClear ? (
            <ProovraText variant="label" color={theme.color.status.pending.fg}>
              {`Some sources could not be read, so this may not be everything.${
                shell.incompleteSources.length > 0 ? ` Affected: ${shell.incompleteSources.join(", ")}.` : ""
              }`}
            </ProovraText>
          ) : null}
        </View>
      ) : null}

      {shell && archived && shell.historyAvailable === false ? (
        <ProovraCard>
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
            Archived notifications are not available in this environment yet.
          </ProovraText>
        </ProovraCard>
      ) : null}

      {shell ? (
        <View accessibilityLabel="Notification filters and sorting" style={styles.block}>
          <ProovraFilterChips<PrimaryView>
            label="Show"
            value={primaryView}
            onChange={(v) => {
              if (v === "unread" && archived) return;
              selectView(v);
            }}
            options={(["all", "unread"] as const).map((v) => ({ value: v, label: PRIMARY_VIEW_LABELS[v] }))}
          />
          <View style={styles.toolbarRow}>
            <ProovraButton
              label={activeCount > 0 ? `Filters (${activeCount})` : "Filters"}
              accessibilityLabel="Filters"
              variant="secondary"
              fullWidth={false}
              onPress={() => setFiltersOpen(true)}
            />
          </View>
          <ProovraFilterChips<InboxSort>
            label="Sort"
            value={sort}
            onChange={setSort}
            options={INBOX_SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </View>
      ) : null}

      {shell && activeChips.length > 0 ? (
        <View accessibilityLabel="Active filters" style={styles.chipRow}>
          {activeChips.map((chip) => (
            <ProovraButton
              key={chip.id}
              label={`${chip.label} ✕`}
              accessibilityLabel={`Remove ${chip.label} filter`}
              variant="secondary"
              fullWidth={false}
              onPress={chip.clear}
            />
          ))}
          <ProovraButton label="Clear all" variant="ghost" fullWidth={false} onPress={clearAllFilters} />
        </View>
      ) : null}

      {state.kind === "ready" ? (
        <View style={styles.block}>
          <ProovraText variant="bodySm" weight="semibold">
            {inboxShowingText(items.length, state.data, inboxResultNoun({ archived, primaryView, category }, items.length))}
          </ProovraText>
          {state.data.cappedSources.length > 0 ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {`Some sources were capped: ${state.data.cappedSources.join(", ")}. Open the relevant console for the full list.`}
            </ProovraText>
          ) : null}
        </View>
      ) : null}

      {state.kind === "loading" ? (
        <ProovraLoadingState label="Loading inbox…" />
      ) : state.kind === "error" ? (
        <ProovraCard>
          <View accessibilityRole="alert" style={styles.block}>
            <ProovraText variant="bodySm" weight="semibold" color={theme.color.status.risk.fg}>
              Couldn’t load inbox.
            </ProovraText>
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {`${state.status ? `HTTP ${state.status}: ` : ""}${state.message}`}
            </ProovraText>
            <ProovraButton label="Retry" variant="secondary" fullWidth={false} onPress={() => void load()} />
          </View>
        </ProovraCard>
      ) : items.length === 0 && archived && activeCount === 1 && primaryView === "all" ? (
        // Tested BEFORE the population: the archived reply carries no
        // scopeSummary and its summary.total is the archive's own size, so an
        // empty archive would otherwise read "You're all caught up" — the web
        // falls into exactly that (inbox/page.tsx:1761 vs :1780).
        <ProovraEmpty
          framed
          title="No archived notifications."
          purpose="Archiving a notification files it here and takes it out of your active list."
        />
      ) : inboxPopulationTotal(state.data) === 0 ? (
        <ProovraEmpty
          framed
          title="You're all caught up"
          purpose="You don't have any notifications right now. New updates will appear here when something relevant happens."
        />
      ) : items.length === 0 ? (
        <ProovraEmpty
          framed
          title="No notifications match these filters."
          purpose="Try changing or clearing the active filters."
          action={<ProovraButton label="Clear filters" variant="secondary" fullWidth={false} onPress={clearAllFilters} />}
        />
      ) : (
        <View style={styles.list}>
          {items.map((item) => {
            const route = resolveInboxRoute(item.href);
            const busy = pendingKey === item.itemKey;
            const tone = isInboxTone(item.tone) ? item.tone : null;
            return (
              <ProovraCard key={item.itemKey} testID={`inbox-item-${item.itemKey}`}>
                <View style={styles.itemHead}>
                  {item.isRead === false ? <View style={styles.dot} accessibilityLabel="Unread" /> : null}
                  {tone ? <ProovraBadge label={TONE_LABELS[tone]} tone={TONE_STATUS[tone]} /> : null}
                  {item.category ? <ProovraBadge label={CATEGORY_LABELS[item.category] ?? item.category} tone="neutral" /> : null}
                </View>
                <ProovraText variant="bodySm" weight={item.isRead ? "medium" : "bold"}>
                  {item.title}
                </ProovraText>
                {item.body ? (
                  <ProovraText variant="label" color={theme.color.ink.secondary}>
                    {item.body}
                  </ProovraText>
                ) : null}
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {[formatUserDateTime(item.occurredAt), ...inboxItemMeta(item, formatUserDate)].join(" · ")}
                </ProovraText>
                <View style={styles.actions}>
                  {route ? (
                    <ProovraButton
                      label="Open"
                      accessibilityLabel={`Open: ${item.title}`}
                      variant="primary"
                      fullWidth={false}
                      onPress={() => open(item, route)}
                    />
                  ) : null}
                  {item.canMarkRead ? (
                    <ProovraButton
                      label={item.isRead ? "Mark as unread" : "Mark as read"}
                      accessibilityLabel={`${item.isRead ? "Mark as unread" : "Mark as read"}: ${item.title}`}
                      variant="secondary"
                      fullWidth={false}
                      disabled={busy}
                      onPress={() => void act(item, item.isRead ? "unread" : "read")}
                    />
                  ) : null}
                  {/* History offers the way back out; anything the server lets you archive offers the way in. */}
                  {item.dismissedAt ? (
                    <ProovraButton
                      label="Unarchive"
                      accessibilityLabel={`Unarchive: ${item.title}`}
                      variant="secondary"
                      fullWidth={false}
                      disabled={busy}
                      onPress={() => void act(item, "unarchive")}
                    />
                  ) : item.canDismiss !== false ? (
                    <ProovraButton
                      label="Archive"
                      accessibilityLabel={`Archive: ${item.title}`}
                      variant="secondary"
                      fullWidth={false}
                      disabled={busy}
                      onPress={() => void act(item, "archive")}
                    />
                  ) : null}
                </View>
              </ProovraCard>
            );
          })}
          <ProovraCursorPager hasMore={!!nextCursor} loading={loadingMore} onLoadMore={() => void loadMore()} />
        </View>
      )}

      <ProovraSheet visible={filtersOpen} title="Filters" onClose={() => setFiltersOpen(false)}>
        <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
          Status
        </ProovraText>
        <ProovraButton
          label={archived ? "Archived ✓" : "Archived"}
          accessibilityLabel="Status: Archived"
          variant={archived ? "primary" : "secondary"}
          fullWidth={false}
          onPress={toggleArchived}
        />
        {groups.map((g) => (
          <ProovraFilterChips<InboxCategoryFilter>
            key={g.id}
            label={g.label}
            value={category}
            // Single-choice; choosing the active one clears it (web selectAdvancedFilter).
            onChange={(k) => setCategory((cur) => (cur === k ? "all" : k))}
            options={g.keys.map((k) => ({ value: k, label: INBOX_FILTER_LABELS[k] }))}
          />
        ))}
        {workspaceOptions.length > 2 ? (
          <ProovraFilterChips
            label="Workspace"
            value={workspaceId}
            onChange={setWorkspaceId}
            options={workspaceOptions}
          />
        ) : null}
        <View style={styles.chipRow}>
          <ProovraButton
            label="Clear filters"
            variant="secondary"
            fullWidth={false}
            disabled={activeCount === 0}
            onPress={clearAllFilters}
          />
          <ProovraButton label="Done" variant="primary" fullWidth={false} onPress={() => setFiltersOpen(false)} />
        </View>
      </ProovraSheet>
    </ProovraShell>
  );
}

const styles = StyleSheet.create({
  block: { gap: theme.space.s2, marginBottom: theme.space.s3 },
  toolbarRow: { flexDirection: "row", gap: theme.space.s2 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginBottom: theme.space.s3 },
  list: { gap: theme.space.s2 },
  itemHead: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.space.s2, marginBottom: theme.space.s1 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginTop: theme.space.s2 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.accent.a500 },
});
