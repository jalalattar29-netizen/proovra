import { useCallback, useEffect, useState } from "react";
import { Pressable, View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useLocale } from "../../src/locale-context";
import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { theme } from "../../src/theme/theme";
import {
  ProovraShell,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraInput,
  ProovraFormField,
  ProovraEmptyState,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../src/ui";
import { caseStatusDisplay, CASE_STATUSES } from "../../src/product/domain-display";

type CaseItem = { id: string; name: string; status?: string; evidenceCount?: number };
type LoadState = "loading" | "ready" | "error";
type StatusFilter = "ALL" | (typeof CASE_STATUSES)[number];

const STATUS_FILTERS: StatusFilter[] = ["ALL", ...CASE_STATUSES];

export default function CasesScreen() {
  const { t } = useLocale();
  const router = useRouter();
  const [items, setItems] = useState<CaseItem[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<SafeError | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const data = await apiFetch("/v1/cases");
      setItems((data.items ?? []) as CaseItem[]);
      setState("ready");
    } catch (err) {
      setError(toSafeUserError(err));
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async () => {
    setCreateError(null);
    const name = newName.trim();
    if (name.length < 1 || name.length > 120) {
      setCreateError({ kind: "input", title: "Check the details", message: "Enter a case name (1–120 characters)." });
      return;
    }
    setCreateBusy(true);
    try {
      const created = await apiFetch("/v1/cases", { method: "POST", body: JSON.stringify({ name }) });
      const id = created?.case?.id ?? created?.id;
      setCreating(false);
      setNewName("");
      if (id) router.push(`/case/${id}`);
      else await load();
    } catch (err) {
      setCreateError(toSafeUserError(err));
    } finally {
      setCreateBusy(false);
    }
  }, [newName, router, load]);

  const needle = query.trim().toLowerCase();
  const filtered = items.filter(
    (c) =>
      (statusFilter === "ALL" || c.status === statusFilter) &&
      (needle === "" || c.name.toLowerCase().includes(needle)),
  );

  return (
    <ProovraShell>
      <ProovraSection
        title={t("cases")}
        action={<ProovraButton label={creating ? "Cancel" : "+ New"} variant="ghost" fullWidth={false} onPress={() => setCreating((v) => !v)} />}
      >
        {creating ? (
          <ProovraCard style={styles.createCard}>
            <ProovraFormField label="Case name" error={createError ? createError.message : null}>
              <ProovraInput value={newName} onChangeText={setNewName} placeholder="e.g. Site inspection — Unit 4" autoCapitalize="sentences" onSubmitEditing={() => void create()} />
            </ProovraFormField>
            <ProovraButton label="Create case" loading={createBusy} onPress={() => void create()} />
          </ProovraCard>
        ) : null}

        {state === "ready" && items.length > 0 ? (
          <>
            <View style={styles.search}>
              <ProovraInput value={query} onChangeText={setQuery} placeholder="Search cases" />
            </View>
            <View style={styles.filterRow}>
              {STATUS_FILTERS.map((f) => {
                const active = f === statusFilter;
                const label = f === "ALL" ? "All" : caseStatusDisplay(f).label;
                return (
                  <Pressable
                    key={f}
                    onPress={() => setStatusFilter(f)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={[styles.filterChip, { backgroundColor: active ? theme.color.accent.a050 : theme.color.surface.card, borderColor: active ? theme.color.accent.a500 : theme.color.border.default }]}
                  >
                    <ProovraText variant="label" weight="semibold" color={active ? theme.color.accent.a600 : theme.color.ink.secondary}>
                      {label}
                    </ProovraText>
                  </Pressable>
                );
              })}
            </View>
          </>
        ) : null}

        {state === "loading" ? (
          <ProovraLoadingState label={t("cases")} />
        ) : state === "error" && error ? (
          <ProovraErrorState message={error.message} onRetry={load} />
        ) : items.length === 0 ? (
          <ProovraEmptyState title="No cases yet" message="Create a case to organize related evidence." action={<ProovraButton label="+ New case" fullWidth={false} onPress={() => setCreating(true)} />} />
        ) : filtered.length === 0 ? (
          <ProovraEmptyState title="No matches" message="No cases match your search." />
        ) : (
          <ProovraCard>
            {filtered.map((c) => (
              <ProovraListRow
                key={c.id}
                title={c.name}
                subtitle={typeof c.evidenceCount === "number" ? `${c.evidenceCount} item${c.evidenceCount === 1 ? "" : "s"}` : undefined}
                onPress={() => router.push(`/case/${c.id}`)}
                trailing={c.status ? <ProovraBadge tone={caseStatusDisplay(c.status).tone} label={caseStatusDisplay(c.status).label} /> : undefined}
              />
            ))}
          </ProovraCard>
        )}
      </ProovraSection>
    </ProovraShell>
  );
}

const styles = StyleSheet.create({
  createCard: { marginBottom: theme.space.s4 },
  search: { marginBottom: theme.space.s3 },
  filterRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginBottom: theme.space.s3 },
  filterChip: { paddingHorizontal: theme.space.s3, paddingVertical: theme.space.s2, borderRadius: theme.radius.pill, borderWidth: 1, minHeight: 36, justifyContent: "center" },
});
