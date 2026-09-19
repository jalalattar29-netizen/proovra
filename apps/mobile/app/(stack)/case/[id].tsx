import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, Share, View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as FileSystem from "expo-file-system";
import { apiFetch, apiBaseUrl, getAuthToken } from "../../../src/api";
import { toSafeUserError, type SafeError } from "../../../src/errors/safe-error";
import { formatUserDateTime } from "../../../src/lib/date";
import { caseStatusDisplay, CASE_STATUSES } from "../../../src/product/domain-display";
import {
  parseCaseNotes,
  parseCaseAssignments,
  buildMemberNameMap,
  resolveMemberName,
  type CaseNote,
  type CaseAssignment,
} from "../../../src/product/case-workspace";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraInput,
  ProovraFormField,
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
  const [changingStatus, setChangingStatus] = useState(false);
  const [statusBusy, setStatusBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<CaseNote[]>([]);
  const [assignments, setAssignments] = useState<CaseAssignment[]>([]);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [noteText, setNoteText] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);

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
      setMemberNames(buildMemberNameMap(caseData.case?.access));
      setEvidence(Array.isArray(evidenceData.items) ? (evidenceData.items as EvidenceItem[]) : []);
      setState("ready");
    } catch (err) {
      const safe = toSafeUserError(err);
      if (safe.kind === "notFound") setState("notfound");
      else { setError(safe); setState("error"); }
    }
  }, [id]);

  // Notes + assignments come from the canonical matter-workspace envelope. It is
  // a separate, degrade-safe load: a failure just hides those sections and never
  // blocks the case/evidence view.
  const loadWorkspace = useCallback(async () => {
    if (!id) return;
    try {
      const ws = await apiFetch(`/v1/cases/${id}/matter-workspace`);
      setNotes(parseCaseNotes(ws));
      setAssignments(parseCaseAssignments(ws));
    } catch {
      setNotes([]);
      setAssignments([]);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);

  const addNote = useCallback(async () => {
    const body = noteText.trim();
    if (!body) return;
    setNoteBusy(true);
    try {
      await apiFetch(`/v1/cases/${id}/comments`, { method: "POST", body: JSON.stringify({ body }) });
      setNoteText("");
      await loadWorkspace();
    } catch (err) {
      Alert.alert("Could not add note", toSafeUserError(err).message);
    } finally {
      setNoteBusy(false);
    }
  }, [noteText, id, loadWorkspace]);

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

  // POST /v1/cases/:id/status { toStatus } → { case }. The server is the
  // authority (enforces allowed transitions + permissions); we reflect its result.
  const changeStatus = useCallback(
    async (toStatus: string) => {
      setStatusBusy(toStatus);
      try {
        const res = await apiFetch(`/v1/cases/${id}/status`, {
          method: "POST",
          body: JSON.stringify({ toStatus }),
        });
        setStatus(res?.case?.status ?? toStatus);
        setChangingStatus(false);
      } catch (err) {
        Alert.alert("Could not change status", toSafeUserError(err).message);
      } finally {
        setStatusBusy(null);
      }
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
        {status ? (
          <View style={styles.heroSub}>
            <ProovraBadge tone={caseStatusDisplay(status).tone} label={caseStatusDisplay(status).label} />
          </View>
        ) : null}
        {changingStatus ? (
          <View style={styles.statusRow}>
            {CASE_STATUSES.filter((s) => s !== status).map((s) => {
              const d = caseStatusDisplay(s);
              const busy = statusBusy === s;
              return (
                <Pressable
                  key={s}
                  disabled={!!statusBusy}
                  onPress={() => void changeStatus(s)}
                  accessibilityRole="button"
                  accessibilityLabel={`Set status ${d.label}`}
                  style={[styles.statusChip, { borderColor: theme.color.border.strong, opacity: busy ? 0.5 : 1 }]}
                >
                  <ProovraText variant="label" weight="semibold" color={theme.color.ink.primary}>{d.label}</ProovraText>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        <View style={styles.heroActions}>
          <ProovraButton
            label={changingStatus ? "Cancel" : "Change status"}
            variant="secondary"
            fullWidth={false}
            onPress={() => setChangingStatus((v) => !v)}
          />
          <ProovraButton label="Export" variant="secondary" fullWidth={false} loading={exporting} onPress={() => void exportZip()} />
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

      <ProovraSection title="Notes">
        <ProovraCard style={styles.notesComposer}>
          <ProovraFormField label="Add a note">
            <ProovraInput value={noteText} onChangeText={setNoteText} placeholder="Add a note to this case…" autoCapitalize="sentences" onSubmitEditing={() => void addNote()} />
          </ProovraFormField>
          <ProovraButton label="Add note" loading={noteBusy} disabled={!noteText.trim()} onPress={() => void addNote()} />
        </ProovraCard>
        {notes.length === 0 ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>No notes yet.</ProovraText>
        ) : (
          <ProovraCard>
            {notes.map((note) => (
              <View key={note.id} style={styles.noteRow}>
                <ProovraText variant="bodySm">{note.body}</ProovraText>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {[resolveMemberName(memberNames, note.authorUserId), note.createdAt ? formatUserDateTime(note.createdAt) : null, note.resolved ? "Resolved" : null].filter(Boolean).join(" · ")}
                </ProovraText>
              </View>
            ))}
          </ProovraCard>
        )}
      </ProovraSection>

      {assignments.length > 0 ? (
        <ProovraSection title="Assignments">
          <ProovraCard>
            {assignments.map((a) => (
              <ProovraListRow
                key={a.id}
                title={resolveMemberName(memberNames, a.assignedToUserId)}
                subtitle={[a.role, a.note].filter(Boolean).join(" · ") || undefined}
                trailing={<ProovraBadge tone="governance" label={a.role || "Member"} />}
              />
            ))}
          </ProovraCard>
        </ProovraSection>
      ) : null}
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", marginTop: theme.space.s2 },
  hero: { marginBottom: theme.space.s4 },
  heroSub: { marginTop: theme.space.s3, flexDirection: "row" },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginTop: theme.space.s3 },
  statusChip: { paddingHorizontal: theme.space.s3, paddingVertical: theme.space.s2, borderRadius: theme.radius.pill, borderWidth: 1, minHeight: 40, justifyContent: "center" },
  heroActions: { marginTop: theme.space.s4, flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  addCard: { marginBottom: theme.space.s4, gap: theme.space.s2 },
  note: { marginTop: theme.space.s2 },
  noteRow: { paddingVertical: theme.space.s2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border.subtle, gap: 2 },
  notesComposer: { marginBottom: theme.space.s3, gap: theme.space.s2 },
});
