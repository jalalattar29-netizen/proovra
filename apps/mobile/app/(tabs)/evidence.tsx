import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { formatUserDateTime } from "../../src/lib/date";
import { theme } from "../../src/theme/theme";
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
import { evidenceStatusDisplay, evidenceTypeLabel } from "../../src/product/domain-display";

type Scope = "active" | "archived" | "trash" | "locked";
type EvidenceItem = {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  // Server-provided display fields (mapEvidenceListItem) — preferred over raw enums.
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

/** Row title: prefer the server's display fields; fall back to a typed label. */
function rowTitle(item: EvidenceItem): string {
  return (
    item.displayTitle?.trim() ||
    item.title?.trim() ||
    item.displayFileName?.trim() ||
    item.originalFileName?.trim() ||
    evidenceTypeLabel(item.type)
  );
}

/** Canonical Native Evidence Library — one surface, four lifecycle scopes. */
export default function EvidenceLibraryScreen() {
  const router = useRouter();
  const [scope, setScope] = useState<Scope>("active");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchPage = useCallback(
    async (opts: { scope: Scope; search: string; cursor?: string | null; append: boolean }) => {
      if (!opts.append) setState("loading");
      setError(null);
      try {
        const params = new URLSearchParams({ scope: opts.scope, limit: "50" });
        if (opts.search.trim()) params.set("search", opts.search.trim());
        if (opts.cursor) params.set("cursor", opts.cursor);
        const data = await apiFetch(`/v1/evidence?${params.toString()}`);
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

  useEffect(() => {
    // Scope change loads immediately; search is debounced in onChangeText.
    // `query` is intentionally omitted so a scope switch uses the current query
    // without racing the debounce; fetchPage is stable (useCallback []).
    void fetchPage({ scope, search: query, append: false });
  }, [scope, fetchPage]);

  const onSearch = useCallback(
    (text: string) => {
      setQuery(text);
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => {
        void fetchPage({ scope, search: text, append: false });
      }, 300);
    },
    [scope, fetchPage],
  );

  const restore = useCallback(
    (item: EvidenceItem) => {
      const isTrash = scope === "trash";
      Alert.alert(
        isTrash ? "Restore from Trash" : "Restore from Archive",
        `Restore this ${item.type.toLowerCase()} record?`,
        [
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
                  setItems((prev) => prev.filter((i) => i.id !== item.id)); // optimistic
                } catch (err) {
                  Alert.alert("Could not restore", toSafeUserError(err).message);
                } finally {
                  setBusyId(null);
                }
              })();
            },
          },
        ],
      );
    },
    [scope],
  );

  const canRestore = scope === "archived" || scope === "trash";

  return (
    <ProovraShell>
      <ProovraSection title="Evidence">
        <View style={styles.scopeRow}>
          {SCOPES.map((s) => {
            const active = s.key === scope;
            return (
              <Pressable
                key={s.key}
                onPress={() => setScope(s.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={[styles.scopeChip, { backgroundColor: active ? theme.color.accent.a050 : theme.color.surface.card, borderColor: active ? theme.color.accent.a500 : theme.color.border.default }]}
              >
                <ProovraText variant="label" weight="semibold" color={active ? theme.color.accent.a600 : theme.color.ink.secondary}>
                  {s.label}
                </ProovraText>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.search}>
          <ProovraInput value={query} onChangeText={onSearch} placeholder="Search evidence" />
        </View>

        {state === "loading" ? (
          <ProovraLoadingState label="Loading evidence" />
        ) : state === "error" && error ? (
          <ProovraErrorState message={error.message} onRetry={() => void fetchPage({ scope, search: query, append: false })} />
        ) : items.length === 0 ? (
          <ProovraEmptyState
            title={scope === "active" ? "No evidence yet" : `Nothing in ${scope}`}
            message={scope === "active" ? "Captured records appear here." : undefined}
            action={scope === "active" ? <ProovraButton label="+ Capture" fullWidth={false} onPress={() => router.push("/capture")} /> : undefined}
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
                        <ProovraButton
                          label="Restore"
                          variant="secondary"
                          fullWidth={false}
                          loading={busyId === item.id}
                          onPress={() => restore(item)}
                        />
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
                <ProovraButton label="Load more" variant="secondary" onPress={() => void fetchPage({ scope, search: query, cursor, append: true })} />
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
  scopeChip: { paddingHorizontal: theme.space.s3, paddingVertical: theme.space.s2, borderRadius: theme.radius.pill, borderWidth: 1, minHeight: 36, justifyContent: "center" },
  search: { marginBottom: theme.space.s3 },
  more: { marginTop: theme.space.s4 },
});
