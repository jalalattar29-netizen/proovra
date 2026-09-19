import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { formatUserDateTime } from "../../src/lib/date";
import { theme } from "../../src/theme/theme";
import {
  ProovraShell,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraListRow,
  ProovraEmptyState,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../src/ui";

type InboxItem = { itemKey: string; title: string; href?: string; occurredAt: string; category?: string; isRead?: boolean };
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

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const data = await apiFetch("/v1/me/inbox?pageSize=50");
      const list = (data.items ?? []) as InboxItem[];
      setItems(list);
      const summaryUnread = data?.counts?.unread ?? data?.summary?.unread;
      setUnread(typeof summaryUnread === "number" ? summaryUnread : list.filter((i) => i.isRead === false).length);
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
      const href = item.href ?? "";
      if (href.startsWith("/evidence/")) router.push(href as never);
      else if (href.startsWith("/cases/")) router.push(href.replace("/cases/", "/case/") as never);
      else if (href.startsWith("/case/")) router.push(href as never);
    },
    [router],
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

  return (
    <ProovraShell>
      <ProovraSection
        title="Notifications"
        action={unread > 0 ? <ProovraButton label={`Mark all read (${unread})`} variant="ghost" fullWidth={false} loading={busy} onPress={() => void markAllRead()} /> : undefined}
      >
        {state === "loading" ? (
          <ProovraLoadingState label="Notifications" />
        ) : state === "error" && error ? (
          <ProovraErrorState message={error.message} onRetry={load} />
        ) : items.length === 0 ? (
          <ProovraEmptyState title="You're all caught up" message="Notifications about your evidence and cases appear here." />
        ) : (
          <ProovraCard>
            {items.map((item) => (
              <View key={item.itemKey} style={styles.row}>
                {item.isRead === false ? <View style={styles.dot} /> : <View style={styles.dotSpace} />}
                <View style={styles.rowBody}>
                  <ProovraListRow
                    title={item.title}
                    subtitle={formatUserDateTime(item.occurredAt)}
                    onPress={() => open(item)}
                  />
                </View>
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
