import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
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
import type { ProovraStatusTone } from "@proovra/ui";

type CaseItem = { id: string; name: string; status?: string; evidenceCount?: number };
type LoadState = "loading" | "ready" | "error";

function caseTone(status?: string): ProovraStatusTone {
  switch (status) {
    case "OPEN":
    case "INVESTIGATING":
      return "info";
    case "ON_HOLD":
      return "pending";
    case "RESOLVED":
    case "CLOSED":
      return "verified";
    case "ARCHIVED":
      return "neutral";
    default:
      return "neutral";
  }
}

export default function CasesScreen() {
  const { t } = useLocale();
  const router = useRouter();
  const [items, setItems] = useState<CaseItem[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [query, setQuery] = useState("");
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

  const filtered = query.trim()
    ? items.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()))
    : items;

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
          <View style={styles.search}>
            <ProovraInput value={query} onChangeText={setQuery} placeholder="Search cases" />
          </View>
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
                trailing={c.status ? <ProovraBadge tone={caseTone(c.status)} label={c.status} /> : undefined}
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
});
