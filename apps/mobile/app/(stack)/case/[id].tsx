import { useCallback, useEffect, useState } from "react";
import { Alert, Share, View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as FileSystem from "expo-file-system";
import { apiFetch, apiBaseUrl, getAuthToken } from "../../../src/api";
import { toSafeUserError, type SafeError } from "../../../src/errors/safe-error";
import { formatUserDateTime } from "../../../src/lib/date";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraListRow,
  ProovraEmptyState,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../../src/ui";

type EvidenceItem = { id: string; title?: string; type: string; status?: string; createdAt: string; itemCount?: number };
type LoadState = "loading" | "ready" | "error" | "notfound";

function evidenceTitle(item: EvidenceItem): string {
  const t = typeof item.title === "string" ? item.title.trim() : "";
  if (t) return t;
  switch ((item.type ?? "").toUpperCase()) {
    case "PHOTO": return "Photo Evidence";
    case "VIDEO": return "Video Evidence";
    case "AUDIO": return "Audio Evidence";
    case "DOCUMENT": return "Document Evidence";
    default: return "Digital Evidence Record";
  }
}

export default function CaseDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id ?? "";

  const [name, setName] = useState("Case");
  const [status, setStatus] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [exporting, setExporting] = useState(false);
  const [available, setAvailable] = useState<EvidenceItem[] | null>(null);
  const [busyEvId, setBusyEvId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setState("loading");
    setError(null);
    try {
      const [caseData, evidenceData] = await Promise.all([
        apiFetch(`/v1/cases/${id}`),
        apiFetch(`/v1/evidence?caseId=${id}`),
      ]);
      setName(caseData.case?.name ?? "Case");
      setStatus(caseData.case?.status ?? null);
      setEvidence(Array.isArray(evidenceData.items) ? (evidenceData.items as EvidenceItem[]) : []);
      setState("ready");
    } catch (err) {
      const safe = toSafeUserError(err);
      if (safe.kind === "notFound") setState("notfound");
      else { setError(safe); setState("error"); }
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // Export → download then present via the platform share sheet (Files/AirDrop/
  // etc.) instead of leaving it in an inaccessible cache dir.
  const exportZip = useCallback(async () => {
    const token = getAuthToken();
    if (!token) { Alert.alert("Not signed in", "Please sign in again."); return; }
    setExporting(true);
    try {
      const dir = FileSystem.documentDirectory ?? FileSystem.cacheDirectory;
      const dest = `${dir}case-${id}.zip`;
      const res = await FileSystem.downloadAsync(`${apiBaseUrl()}/v1/cases/${id}/export`, dest, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status >= 400) throw new Error(`Export failed (${res.status})`);
      await Share.share({ url: res.uri, title: `${name}.zip` });
    } catch (err) {
      Alert.alert("Export failed", toSafeUserError(err).message);
    } finally {
      setExporting(false);
    }
  }, [id, name]);

  const removeFromCase = useCallback(
    (item: EvidenceItem) => {
      Alert.alert("Remove from case", `Remove ${evidenceTitle(item)} from this case?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setBusyEvId(item.id);
              try {
                await apiFetch(`/v1/cases/${id}/evidence/${item.id}`, { method: "DELETE" });
                setEvidence((prev) => prev.filter((e) => e.id !== item.id));
              } catch (err) {
                Alert.alert("Could not remove", toSafeUserError(err).message);
              } finally {
                setBusyEvId(null);
              }
            })();
          },
        },
      ]);
    },
    [id],
  );

  const openAdd = useCallback(async () => {
    try {
      const data = await apiFetch(`/v1/cases/${id}/available-evidence`);
      setAvailable((data.items ?? []) as EvidenceItem[]);
    } catch (err) {
      Alert.alert("Could not load evidence", toSafeUserError(err).message);
    }
  }, [id]);

  const attach = useCallback(
    async (evId: string) => {
      setBusyEvId(evId);
      try {
        await apiFetch(`/v1/cases/${id}/evidence`, { method: "POST", body: JSON.stringify({ evidenceId: evId }) });
        setAvailable((prev) => (prev ? prev.filter((e) => e.id !== evId) : prev));
        await load();
      } catch (err) {
        Alert.alert("Could not add", toSafeUserError(err).message);
      } finally {
        setBusyEvId(null);
      }
    },
    [id, load],
  );

  if (state === "loading") return <ProovraScreen scroll={false}><ProovraLoadingState label="Loading case" /></ProovraScreen>;
  if (state === "notfound") return <ProovraScreen scroll={false}><ProovraEmptyState title="Case not found" action={<ProovraButton label="Back" fullWidth={false} onPress={() => router.back()} />} /></ProovraScreen>;
  if (state === "error" && error) return <ProovraScreen scroll={false}><ProovraErrorState message={error.message} onRetry={load} /></ProovraScreen>;

  return (
    <ProovraScreen>
      <View style={styles.headerRow}>
        <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
      </View>
      <ProovraCard style={styles.hero}>
        <ProovraText variant="h1" weight="bold">{name}</ProovraText>
        {status ? <ProovraText variant="bodySm" color={theme.color.ink.secondary} style={styles.heroSub}>{status}</ProovraText> : null}
        <View style={styles.heroActions}>
          <ProovraButton label="Export" variant="secondary" loading={exporting} onPress={() => void exportZip()} />
        </View>
      </ProovraCard>

      <ProovraSection
        title="Evidence"
        action={<ProovraButton label="+ Add" variant="ghost" fullWidth={false} onPress={() => void openAdd()} />}
      >
        {available ? (
          <ProovraCard style={styles.addCard}>
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Add evidence to this case</ProovraText>
            {available.length === 0 ? (
              <ProovraText variant="bodySm" color={theme.color.ink.muted} style={styles.note}>No eligible evidence to add.</ProovraText>
            ) : (
              available.map((e) => (
                <ProovraListRow
                  key={e.id}
                  title={evidenceTitle(e)}
                  subtitle={formatUserDateTime(e.createdAt)}
                  trailing={<ProovraButton label="Add" variant="secondary" fullWidth={false} loading={busyEvId === e.id} onPress={() => void attach(e.id)} />}
                />
              ))
            )}
            <ProovraButton label="Done" variant="ghost" onPress={() => setAvailable(null)} />
          </ProovraCard>
        ) : null}

        {evidence.length === 0 ? (
          <ProovraEmptyState title="No evidence in this case" message="Add existing evidence or capture new records." />
        ) : (
          <ProovraCard>
            {evidence.map((item) => (
              <ProovraListRow
                key={item.id}
                title={evidenceTitle(item)}
                subtitle={formatUserDateTime(item.createdAt)}
                onPress={() => router.push(`/(stack)/evidence/${item.id}` as never)}
                trailing={<ProovraButton label="Remove" variant="ghost" fullWidth={false} loading={busyEvId === item.id} onPress={() => removeFromCase(item)} />}
              />
            ))}
          </ProovraCard>
        )}
      </ProovraSection>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", marginTop: theme.space.s2 },
  hero: { marginBottom: theme.space.s4 },
  heroSub: { marginTop: theme.space.s2 },
  heroActions: { marginTop: theme.space.s4 },
  addCard: { marginBottom: theme.space.s4, gap: theme.space.s2 },
  note: { marginTop: theme.space.s2 },
});
