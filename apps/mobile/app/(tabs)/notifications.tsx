import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { formatUserDateTime } from "../../src/lib/date";
import {
  resolveInboxUnread,
  resolveInboxRoute,
  sortInboxItems,
  filterInboxItems,
  inboxItemActionPath,
  INBOX_FILTERS,
  type InboxItem,
  type InboxItemAction,
} from "../../src/product/inbox";
import { theme } from "../../src/theme/theme";
import { useToast } from "../../src/toast-context";
import {
  ProovraShell,
  ProovraCard,
  ProovraSection,
  ProovraButton,
  ProovraListRow,
  ProovraEmptyState,
  ProovraFilterChips,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../src/ui";

type LoadState = "loading" | "ready" | "error";

/** In-app Notifications / Inbox (Phase 11A). Real backend contracts only; no
 *  push (deferred). Read/mark-read/mark-all-read + routing to authorized targets. */
export default function NotificationsScreen() {
  const router = useRouter();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [busy, setBusy] = useState(false);
  const { addToast } = useToast();
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const data = await apiFetch("/v1/me/inbox?pageSize=50");
      const list = (data.items ?? []) as InboxItem[];
      setItems(list);
      // Authoritative unread is metricSummary.unread / scopeSummary.unread; only
      // fall back to a page-local count when the server omits it (M3).
      const resolved = resolveInboxUnread(data);
      setUnread(resolved ?? list.filter((i) => i.isRead === false).length);
      setState("ready");
    } catch (err) {
      setError(toSafeUserError(err));
      setState("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const open = useCallback(
    (item: InboxItem) => {
      // Mark read (best-effort) then route to an in-app destination when the
      // href maps to a native route. Server authorizes the destination's data.
      void apiFetch(`/v1/me/inbox/items/${encodeURIComponent(item.itemKey)}/read`, { method: "POST" }).catch(() => {});
      setItems((prev) => prev.map((i) => (i.itemKey === item.itemKey ? { ...i, isRead: true } : i)));
      setUnread((u) => Math.max(0, u - (item.isRead ? 0 : 1)));
      const route = resolveInboxRoute(item.href);
      if (route) router.push(route as never);
    },
    [router],
  );

  /**
   * Per-item actions the canonical inbox persists through
   * `/v1/me/inbox/items/:itemKey/{read,unread,dismiss,snooze}`.
   *
   * Native offered only mark-read and mark-all-read, so an item could be
   * acknowledged but never deferred or restored. Optimistic, then reconciled by
   * a reload: an action that fails must not leave the row lying about its state.
   */
  const act = useCallback(
    async (item: InboxItem, action: InboxItemAction) => {
      setItems((prev) =>
        action === "dismiss"
          ? prev.filter((i) => i.itemKey !== item.itemKey)
          : prev.map((i) =>
              i.itemKey === item.itemKey ? { ...i, isRead: action !== "unread" } : i,
            ),
      );
      if (action === "read" && !item.isRead) setUnread((u) => Math.max(0, u - 1));
      if (action === "unread") setUnread((u) => u + 1);
      try {
        await apiFetch(inboxItemActionPath(item.itemKey, action), { method: "POST" });
      } catch (err) {
        addToast(toSafeUserError(err).message, "error");
        await load();
      }
    },
    [load, addToast],
  );

  const markAllRead = useCallback(async () => {
    setBusy(true);
    try {
      await apiFetch("/v1/me/inbox/mark-all-read", { method: "POST" });
      setItems((prev) => prev.map((i) => ({ ...i, isRead: true })));
      setUnread(0);
    } catch (err) {
      setError(toSafeUserError(err));
    } finally {
      setBusy(false);
    }
  }, []);

  // Filter locally over the fetched page, then sort: unread first, then by
  // severity, then newest. The canonical page renders "severity-ordered
  // actionable rows"; arrival order buries what matters under routine noise.
  const visible = sortInboxItems(filterInboxItems(items, filter));

  return (
    <ProovraShell>
      <ProovraSection
        title="Notifications"
        action={unread > 0 ? <ProovraButton label={`Mark all read (${unread})`} variant="ghost" fullWidth={false} loading={busy} onPress={() => void markAllRead()} /> : undefined}
      >
        {/*
          The preferences that decide what appears in this list, reached from
          the list itself. The web reaches them from a Settings pane; a phone
          user looking to mute a category looks here first.
        */}
        <ProovraListRow
          title="Notification preferences"
          subtitle="Choose which notifications reach you, and how"
          onPress={() => router.push("/(stack)/settings/notifications")}
        />
        <ProovraFilterChips
          label="Show"
          value={filter}
          onChange={setFilter}
          options={INBOX_FILTERS.map((f) => ({ value: f.value, label: f.label }))}
        />
        {state === "loading" ? (
          <ProovraLoadingState label="Notifications" />
        ) : state === "error" && error ? (
          <ProovraErrorState message={error.message} onRetry={load} />
        ) : items.length === 0 ? (
          <ProovraEmptyState
            title={filter === "all" ? "You're all caught up" : "Nothing matches this filter"}
            message={
              filter === "all"
                ? "Notifications about your evidence and cases appear here."
                : "Clear the filter to see everything in your inbox."
            }
            action={
              filter === "all" ? undefined : (
                <ProovraButton
                  label="Clear filter"
                  variant="secondary"
                  fullWidth={false}
                  onPress={() => setFilter("all")}
                />
              )
            }
          />
        ) : (
          <ProovraCard>
            {visible.map((item) => (
              <View key={item.itemKey} style={styles.row}>
                {item.isRead === false ? <View style={styles.dot} /> : <View style={styles.dotSpace} />}
                <View style={styles.rowBody}>
                  <ProovraListRow
                    title={item.title}
                    subtitle={[item.category, formatUserDateTime(item.occurredAt)]
                      .filter(Boolean)
                      .join(" · ")}
                    onPress={() => open(item)}
                  />
                </View>
                <ProovraButton
                  label={item.isRead ? "Unread" : "Read"}
                  variant="ghost"
                  fullWidth={false}
                  onPress={() => void act(item, item.isRead ? "unread" : "read")}
                />
                <ProovraButton
                  label="Dismiss"
                  variant="ghost"
                  fullWidth={false}
                  onPress={() => void act(item, "dismiss")}
                />
              </View>
            ))}
          </ProovraCard>
        )}
      </ProovraSection>
    </ProovraShell>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: theme.space.s2 },
  rowBody: { flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.accent.a500 },
  dotSpace: { width: 8 },
});
