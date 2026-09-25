import { useCallback, useEffect, useState } from "react";
import { shareFile } from "../../../src/lib/share-file";
import { CopyButton } from "../../../src/ui/copy-button";
import { Alert, Pressable, View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as FileSystem from "expo-file-system";
import { apiFetch, apiFetchText, apiBaseUrl, getAuthToken } from "../../../src/api";
import { toSafeUserError } from "../../../src/errors/safe-error";
import { useToast } from "../../../src/toast-context";
import { caseStatusDisplay } from "../../../src/product/domain-display";
import { statusTone } from "../../../src/theme/theme";
import {
  CASE_NOTES_BOUNDARY,
  CASE_NOTE_MAX,
  DELETE_CASE_CONSEQUENCE,
  buildCaseCommentResolvePath,
  buildCaseCommentPath,
  buildCaseCommentsPath,
  buildCasePath,
  buildCaseRenameBody,
  buildMemberNameMap,
  buildResolveCommentBody,
  caseDenialReason,
  parseCaseAssignments,
  parseCaseNotes,
  parseCaseViewer,
  resolveMemberName,
  summariseCaseDeliverables,
  deriveCaseNeedsAttention,
  formatCaseDate,
  parseCaseDeliverableRows,
  type CaseDeliverableRow,
  type CaseAssignment,
  type CaseDeliverables,
  type CaseNote,
  type CaseViewer,
} from "../../../src/product/case-workspace";
import {
  CASE_STATUS_OPTIONS,
  NOTE_DELETE_CONSEQUENCE,
  attachOutcomeMessage,
  buildCaseNoteBody,
  caseEvidenceMeta,
  caseStatusLabel,
  deleteCaseDangerText,
  evidenceCountText,
  matchesCaseEvidence,
  overviewKpis,
  parseCaseEvidenceRows,
  parseCaseTab,
  priorityLabel,
  renameSaveDisabled,
  statusChangeConsequence,
  type CaseEvidenceRow,
  type CaseTab,
} from "../../../src/product/case-detail";
import { theme } from "../../../src/theme/theme";
import { TeamResponsibilityPanel } from "../../../src/ui/team-responsibility";
import { PresenceIndicator } from "../../../src/ui/presence-indicator";
import { CaseCopilot } from "../../../src/ui/case-copilot";
import { CaseAttachEvidenceSheet, CaseSectionTabs } from "../../../src/ui/case-detail-sections";
import { parseCaseCopilotEvidence, type CaseCopilotEvidence } from "../../../src/product/ai-copilot";
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
  ProovraConfirmSheet,
  ProovraKpiGrid,
  ProovraDetailRows,
  ProovraFilterSearch,
} from "../../../src/ui";

/*
 * CASE DETAIL — the native port of the web SimpleCaseDetail
 * (apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx).
 *
 * Header (title, primary Add evidence, status + metadata, copyable Case ID),
 * then the web's five sections: Overview, Evidence, Reports & Packages, Notes,
 * Settings. The enterprise MatterWorkspace branch (app/(app)/cases/[id]/page.tsx:83,
 * gated on useEnterpriseSurfaceAccess) is not ported.
 *
 * Reads: GET /v1/cases/:id (header row + access list for member names) and
 * GET /v1/cases/:id/matter-workspace (evidence, notes, the viewer's own
 * capabilities). The linked evidence is the envelope's — the same rows the
 * web reads — not a second list from /v1/evidence.
 */

type PageState = "loading" | "ready" | "restricted" | "notfound" | "error";
type WorkspaceState = "loading" | "ready" | "error";

type Confirm =
  | { kind: "remove"; row: CaseEvidenceRow }
  | { kind: "deleteNote"; note: CaseNote }
  | { kind: "status"; to: string }
  | { kind: "deleteCase" };

export default function CaseDetailScreen() {
  const router = useRouter();
  const { addToast } = useToast();
  const params = useLocalSearchParams<{ id?: string; tab?: string }>();
  const id = params.id ?? "";

  const [state, setState] = useState<PageState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [tab, setTab] = useState<CaseTab>(() => parseCaseTab(params.tab));
  const [reloading, setReloading] = useState(false);

  const [name, setName] = useState("Case");
  const [status, setStatus] = useState<string | null>(null);
  const [caseTeamId, setCaseTeamId] = useState<string | null>(null);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [caseFacts, setCaseFacts] = useState<{ reference: string | null; priority: string | null; createdAt: string | null; updatedAt: string | null }>({
    reference: null,
    priority: null,
    createdAt: null,
    updatedAt: null,
  });

  const [wsState, setWsState] = useState<WorkspaceState>("loading");
  const [evidence, setEvidence] = useState<CaseEvidenceRow[]>([]);
  const [notes, setNotes] = useState<CaseNote[]>([]);
  const [assignments, setAssignments] = useState<CaseAssignment[]>([]);
  // The SERVER's answer to what this caller may do here. Absent means NOT
  // allowed: a client that defaulted to "yes" would offer a destructive action
  // to someone the server would refuse.
  const [viewer, setViewer] = useState<CaseViewer>(parseCaseViewer(null));
  const [deliverables, setDeliverables] = useState<CaseDeliverables | null>(null);
  const [deliverableRows, setDeliverableRows] = useState<CaseDeliverableRow[]>([]);
  const [needsAttention, setNeedsAttention] = useState<Array<{ key: string; label: string }> | null>(null);
  const [copilotEvidence, setCopilotEvidence] = useState<CaseCopilotEvidence[] | null>(null);

  const [attachOpen, setAttachOpen] = useState(false);
  const [evidenceSearch, setEvidenceSearch] = useState("");
  const [busyEvId, setBusyEvId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [exporting, setExporting] = useState(false);

  const loadHeader = useCallback(
    async (initial: boolean) => {
      if (!id) return;
      if (initial) setState("loading");
      try {
        const caseData = await apiFetch(buildCasePath(String(id)));
        const c = caseData?.case ?? {};
        setName(typeof c.name === "string" ? c.name : "Case");
        setNameDraft(typeof c.name === "string" ? c.name : "");
        setStatus(typeof c.status === "string" ? c.status : null);
        setCaseFacts({
          reference: typeof c.referenceNumber === "string" ? c.referenceNumber : null,
          priority: typeof c.priority === "string" ? c.priority : null,
          createdAt: typeof c.createdAt === "string" ? c.createdAt : null,
          updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : null,
        });
        setCaseTeamId(typeof c.teamId === "string" ? c.teamId : null);
        setMemberNames(buildMemberNameMap(c.access));
        setState("ready");
      } catch (err) {
        const code = (err as { statusCode?: number } | null)?.statusCode;
        const safe = toSafeUserError(err);
        if (code === 401 || code === 403) setState("restricted");
        else if (safe.kind === "notFound") setState("notfound");
        else {
          setErrorMessage("Unable to load the case right now. Try again.");
          setState("error");
        }
      }
    },
    [id],
  );

  const loadWorkspace = useCallback(async () => {
    if (!id) return;
    try {
      const ws = await apiFetch(`/v1/cases/${encodeURIComponent(String(id))}/matter-workspace`);
      setEvidence(parseCaseEvidenceRows(ws));
      setNotes(parseCaseNotes(ws));
      setAssignments(parseCaseAssignments(ws));
      setViewer(parseCaseViewer(ws));
      setDeliverables(summariseCaseDeliverables(ws));
      setNeedsAttention(deriveCaseNeedsAttention(ws));
      setDeliverableRows(parseCaseDeliverableRows(ws));
      setCopilotEvidence(parseCaseCopilotEvidence(ws));
      setWsState("ready");
    } catch {
      // An envelope that could not be read closes the controls rather than
      // opening them, and says so rather than showing an empty case.
      setViewer(parseCaseViewer(null));
      setCopilotEvidence(null);
      setWsState("error");
    }
  }, [id]);

  /** A reload keeps the page on screen and says "Updating…", as the web header does. */
  const reload = useCallback(async () => {
    setReloading(true);
    try {
      await Promise.all([loadHeader(false), loadWorkspace()]);
    } finally {
      setReloading(false);
    }
  }, [loadHeader, loadWorkspace]);

  useEffect(() => { void loadHeader(true); }, [loadHeader]);
  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);

  const addNote = useCallback(async () => {
    const body = noteText.trim();
    if (!body) return;
    setNoteBusy(true);
    try {
      await apiFetch(buildCaseCommentsPath(String(id)), { method: "POST", body: JSON.stringify(buildCaseNoteBody(body)) });
      setNoteText("");
      await loadWorkspace();
      addToast("Note added.", "success");
    } catch (err) {
      addToast(toSafeUserError(err, { message: "Could not add note." }).message, "error");
    } finally {
      setNoteBusy(false);
    }
  }, [noteText, id, loadWorkspace, addToast]);

  const resolveNote = useCallback(
    async (note: CaseNote) => {
      setNoteBusy(true);
      try {
        await apiFetch(buildCaseCommentResolvePath(String(id), note.id), { method: "POST", body: JSON.stringify(buildResolveCommentBody()) });
        await loadWorkspace();
        addToast("Note marked as resolved.", "success");
      } catch (err) {
        addToast(toSafeUserError(err, { message: "Could not resolve note." }).message, "error");
      } finally {
        setNoteBusy(false);
      }
    },
    [id, loadWorkspace, addToast],
  );

  const deleteNote = useCallback(
    async (note: CaseNote) => {
      setNoteBusy(true);
      try {
        await apiFetch(buildCaseCommentPath(String(id), note.id), { method: "DELETE" });
        await loadWorkspace();
        addToast("Note deleted.", "success");
      } catch (err) {
        addToast(toSafeUserError(err, { message: "Could not delete note." }).message, "error");
      } finally {
        setNoteBusy(false);
      }
    },
    [id, loadWorkspace, addToast],
  );

  const renameCase = useCallback(async () => {
    if (renameSaveDisabled(nameDraft, name)) return;
    setSettingsBusy(true);
    try {
      await apiFetch(buildCasePath(String(id)), { method: "PATCH", body: JSON.stringify(buildCaseRenameBody(nameDraft)) });
      await reload();
      addToast("Case name updated.", "success");
    } catch (err) {
      addToast(toSafeUserError(err, { message: "Could not rename case." }).message, "error");
    } finally {
      setSettingsBusy(false);
    }
  }, [id, nameDraft, name, reload, addToast]);

  // POST /v1/cases/:id/status { toStatus } → { case }. The server is the
  // authority (allowed transitions + permissions); the page re-reads.
  const changeStatus = useCallback(
    async (toStatus: string) => {
      setSettingsBusy(true);
      try {
        await apiFetch(`/v1/cases/${encodeURIComponent(String(id))}/status`, { method: "POST", body: JSON.stringify({ toStatus }) });
        await reload();
        addToast("Case status updated.", "success");
      } catch (err) {
        addToast(toSafeUserError(err, { message: "Could not change status." }).message, "error");
      } finally {
        setSettingsBusy(false);
      }
    },
    [id, reload, addToast],
  );

  const deleteCase = useCallback(async () => {
    setSettingsBusy(true);
    try {
      // 204 No Content (cases.routes.ts:1272): read as text. apiFetch parsed the
      // empty body as JSON and reported a deletion that had succeeded as a failure.
      await apiFetchText(buildCasePath(String(id)), { method: "DELETE" });
      addToast("Case deleted. Evidence records were preserved.", "success");
      router.back();
    } catch (err) {
      addToast(toSafeUserError(err, { message: "Could not delete case." }).message, "error");
    } finally {
      setSettingsBusy(false);
    }
  }, [id, router, addToast]);

  // DELETE /v1/cases/:id/evidence/:evidenceId unlinks; it never deletes the record.
  const removeFromCase = useCallback(
    async (row: CaseEvidenceRow) => {
      setBusyEvId(row.id);
      try {
        await apiFetch(`/v1/cases/${encodeURIComponent(String(id))}/evidence/${encodeURIComponent(row.id)}`, { method: "DELETE" });
        addToast("Evidence removed from this case.", "success");
        await reload();
      } catch (err) {
        addToast(toSafeUserError(err, { message: "Could not remove evidence." }).message, "error");
      } finally {
        setBusyEvId(null);
      }
    },
    [id, reload, addToast],
  );

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
      await shareFile(res.uri, { mimeType: "application/zip", dialogTitle: `${name}.zip`, uti: "public.zip-archive" });
    } catch (err) {
      Alert.alert("Export failed", toSafeUserError(err).message);
    } finally {
      setExporting(false);
    }
  }, [id, name]);

  const runConfirm = useCallback(() => {
    const c = confirm;
    setConfirm(null);
    if (!c) return;
    if (c.kind === "remove") void removeFromCase(c.row);
    else if (c.kind === "deleteNote") void deleteNote(c.note);
    else if (c.kind === "status") void changeStatus(c.to);
    else void deleteCase();
  }, [confirm, removeFromCase, deleteNote, changeStatus, deleteCase]);

  if (state === "loading") return <ProovraScreen shell scroll={false}><ProovraLoadingState label="Loading case" /></ProovraScreen>;
  if (state === "restricted") {
    return (
      <ProovraScreen shell scroll={false}>
        <ProovraEmptyState title="You don't have access to this case." message="Ask a workspace owner or administrator if you need access." />
      </ProovraScreen>
    );
  }
  if (state === "notfound") {
    return (
      <ProovraScreen shell scroll={false}>
        <ProovraEmptyState
          title="Case not found"
          message="The case may have been deleted or moved."
          action={<ProovraButton label="Back to cases" variant="secondary" fullWidth={false} onPress={() => router.back()} />}
        />
      </ProovraScreen>
    );
  }
  if (state === "error") {
    return (
      <ProovraScreen shell scroll={false}>
        <ProovraErrorState message={`Case unavailable. ${errorMessage ?? ""}`.trim()} onRetry={() => void loadHeader(true)} />
      </ProovraScreen>
    );
  }

  const evidenceCount = evidence.length;
  const linkReason = caseDenialReason(viewer, "linkEvidence");
  const statusFg = status ? statusTone(caseStatusDisplay(status).tone).fg : theme.color.ink.secondary;
  const canUnlink = viewer.canUnlinkEvidence || viewer.canUnlinkLegacyEvidence;
  const unlinkReason = caseDenialReason(viewer, "unlinkEvidence") ?? caseDenialReason(viewer, "unlinkLegacyEvidence");

  const workspaceUnavailable = (
    <ProovraErrorState message="Could not load this case's evidence and notes." onRetry={() => void loadWorkspace()} />
  );

  /* ---------------------------------------------------------------- tabs */

  const overview = () => {
    const reportsReady = deliverables?.reportsReady ?? 0;
    const packagesReady = deliverables?.packagesReady ?? 0;
    return (
      <>
        <ProovraKpiGrid items={overviewKpis(evidenceCount, reportsReady, packagesReady)} />
        <ProovraCard style={styles.block} testID="case-summary">
          <ProovraDetailRows
            rows={[
              { label: "Status", value: caseStatusLabel(status) },
              { label: "Priority", value: priorityLabel(caseFacts.priority) },
              { label: "Reference", value: caseFacts.reference ?? "—" },
              { label: "Created", value: formatCaseDate(caseFacts.createdAt) },
              { label: "Last updated", value: formatCaseDate(caseFacts.updatedAt) },
            ]}
          />
        </ProovraCard>

        <ProovraSection title="Quick actions">
          <ProovraCard style={styles.rail}>
            <ProovraButton label="Add evidence" disabled={!viewer.canLinkEvidence} onPress={() => setAttachOpen(true)} />
            {/* Report and package generation live on the evidence record; with
                no evidence there is no valid input, so both are disabled with
                the web's reason. */}
            <ProovraButton label="Generate report" variant="secondary" disabled={evidenceCount === 0} onPress={() => setTab("reports")} />
            <ProovraButton label="Create verification package" variant="secondary" disabled={evidenceCount === 0} onPress={() => setTab("reports")} />
            {evidenceCount === 0 ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>
                Add evidence before generating a report. A finalized evidence record is required for a verification package.
              </ProovraText>
            ) : null}
          </ProovraCard>
        </ProovraSection>

        {/* The web Overview's attention panel (SimpleCaseDetail.tsx:964), same rules. */}
        {needsAttention ? (
          <ProovraSection title="What needs attention">
            <ProovraCard testID="case-needs-attention" style={[styles.block, styles.attention]}>
              {needsAttention.length === 0 || needsAttention[0].key === "no-evidence" ? (
                <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                  {needsAttention.length === 0 ? "No open issues. Reports and packages are up to date." : needsAttention[0].label}
                </ProovraText>
              ) : (
                needsAttention.map((a) => (
                  <ProovraText key={a.key} variant="bodySm" color={theme.color.status.pending.fg}>{`• ${a.label}`}</ProovraText>
                ))
              )}
              {evidenceCount === 0 ? (
                <ProovraButton label="Add evidence" variant="secondary" fullWidth={false} disabled={!viewer.canLinkEvidence} onPress={() => setAttachOpen(true)} />
              ) : null}
            </ProovraCard>
          </ProovraSection>
        ) : null}

        {/* T-12 — the collaboration group coordinating this case (SimpleCaseDetail.tsx:382). */}
        <TeamResponsibilityPanel targetType="CASE" targetId={String(id)} />

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
      </>
    );
  };

  const evidenceTab = () => {
    const visible = evidence.filter((row) => matchesCaseEvidence(row, evidenceSearch));
    return (
      <>
        {evidenceCount === 0 ? (
          <ProovraEmptyState title="No evidence linked yet." message="Use Add evidence above to link files, photos, videos, or documents to this case." />
        ) : (
          <>
            <ProovraFilterSearch value={evidenceSearch} onChange={setEvidenceSearch} placeholder="Search linked evidence by name, type, or record ID" />
            <View style={styles.rows}>
              {visible.map((row) => (
                <ProovraCard key={row.id} testID={`case-evidence-${row.id}`} style={styles.evidenceRow}>
                  <ProovraText variant="body" weight="semibold" numberOfLines={2}>{row.title}</ProovraText>
                  <ProovraText variant="label" color={theme.color.ink.secondary}>{caseEvidenceMeta(row)}</ProovraText>
                  <View style={styles.rowActions}>
                    <ProovraButton label="Open" variant="secondary" fullWidth={false} onPress={() => router.push(`/(stack)/evidence/${row.id}` as never)} />
                    <ProovraButton
                      label="Remove from case"
                      variant="ghost"
                      fullWidth={false}
                      loading={busyEvId === row.id}
                      disabled={!canUnlink}
                      accessibilityLabel={`Remove ${row.title} from case`}
                      onPress={() => setConfirm({ kind: "remove", row })}
                    />
                  </View>
                </ProovraCard>
              ))}
            </View>
            {!canUnlink && unlinkReason ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>{unlinkReason}</ProovraText>
            ) : null}
            {visible.length === 0 ? (
              <ProovraCard style={styles.block}>
                <ProovraText variant="bodySm" color={theme.color.ink.muted}>No linked evidence matches your search.</ProovraText>
              </ProovraCard>
            ) : null}
          </>
        )}
        {/* T-15 — Evidence Operations Copilot, beside the evidence as on the web
            (SimpleCaseDetail.tsx:408). Without the envelope no record carries a revision. */}
        {copilotEvidence ? (
          <CaseCopilot caseId={String(id)} linkedEvidence={copilotEvidence} onRefreshEvidence={() => void loadWorkspace()} />
        ) : null}
      </>
    );
  };

  const reportsTab = () => {
    const d = deliverables ?? { total: 0, reportsReady: 0, packagesReady: 0, pending: 0, failed: 0 };
    return (
      <>
        <ProovraCard style={styles.block}>
          {/*
            Counted from the envelope's own evidence rows — no second source.
            REVIEW_REQUIRED is counted with FAILED, as the web counts it.
          */}
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
            {evidenceCount === 0
              ? "Add evidence first to generate reports and verification packages."
              : `${d.reportsReady} of ${evidenceCount} evidence records have a report. ${d.packagesReady} have a verification package.`}
          </ProovraText>
          {deliverableRows.some((r) => r.needsAttention) ? (
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>Open the evidence record to generate missing deliverables.</ProovraText>
          ) : null}
        </ProovraCard>
        {evidenceCount > 0 ? (
          <>
            <ProovraKpiGrid
              items={[
                { key: "reports", label: "Reports ready", value: String(d.reportsReady), tone: "verified" },
                { key: "packages", label: "Packages ready", value: String(d.packagesReady), tone: "verified" },
                { key: "pending", label: "Pending", value: String(d.pending), tone: "pending" },
                { key: "failed", label: "Failed", value: String(d.failed), tone: "risk" },
              ]}
            />
            <ProovraSection title="Reports & verification packages">
              <ProovraCard testID="case-deliverable-rows">
                {deliverableRows.map((r) => (
                  <ProovraListRow
                    key={r.id}
                    title={r.title}
                    subtitle={`${r.report} · ${r.pack}`}
                    accessibilityHint="Opens the evidence record, where its report and package are generated."
                    testID={`case-deliverable-${r.id}`}
                    onPress={() => router.push(`/(stack)/evidence/${r.id}` as never)}
                    trailing={
                      <ProovraButton label="Open evidence" variant="secondary" fullWidth={false} accessibilityLabel={`Open evidence ${r.title}`} onPress={() => router.push(`/(stack)/evidence/${r.id}` as never)} />
                    }
                  />
                ))}
              </ProovraCard>
            </ProovraSection>
          </>
        ) : null}
      </>
    );
  };

  const notesTab = () => (
    <>
      <ProovraCard style={styles.block}>
        <ProovraText variant="h3" weight="semibold">Private case notes</ProovraText>
        {/* Not decoration: a private note beside integrity state reads as part of the record unless something says it is not. */}
        <ProovraText variant="label" color={theme.color.ink.secondary}>{CASE_NOTES_BOUNDARY}</ProovraText>
        {viewer.canComment ? (
          <View style={styles.composer}>
            <ProovraInput
              value={noteText}
              onChangeText={(t) => setNoteText(t.slice(0, CASE_NOTE_MAX))}
              placeholder="Write a private note for this case"
              accessibilityLabel="Write a private note for this case"
              autoCapitalize="sentences"
              multiline
            />
            <View style={styles.composerActions}>
              <ProovraButton label={noteBusy ? "Adding…" : "Add note"} fullWidth={false} disabled={!noteText.trim() || noteBusy} onPress={() => void addNote()} />
            </View>
          </View>
        ) : (
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>You don&apos;t have permission to add notes on this case.</ProovraText>
        )}
      </ProovraCard>

      <ProovraCard style={styles.block}>
        {notes.length === 0 ? (
          <View style={styles.notesEmpty}>
            <ProovraText variant="bodySm" weight="semibold" center>No notes yet.</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.muted} center>Notes you add appear here, newest activity first.</ProovraText>
          </View>
        ) : (
          notes.map((note) => (
            <View key={note.id} style={[styles.noteRow, note.resolved ? styles.noteResolved : null]} testID={`case-note-${note.id}`}>
              <ProovraText variant="bodySm">{note.body}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {[
                  resolveMemberName(memberNames, note.authorUserId),
                  formatCaseDate(note.createdAt),
                  note.resolved ? `resolved ${formatCaseDate(note.resolvedAt)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </ProovraText>
              <View style={styles.noteActions}>
                {/* The route only resolves; there is no reopen. */}
                {!note.resolved && viewer.canResolveComment ? (
                  <ProovraButton label="Mark resolved" variant="ghost" fullWidth={false} disabled={noteBusy} onPress={() => void resolveNote(note)} />
                ) : null}
                {/* Author-only: DELETE answers 403 comment_forbidden to anyone else. */}
                {viewer.userId && note.authorUserId === viewer.userId ? (
                  <ProovraButton label="Delete" variant="ghost" fullWidth={false} disabled={noteBusy} accessibilityLabel="Delete note" onPress={() => setConfirm({ kind: "deleteNote", note })} />
                ) : null}
              </View>
            </View>
          ))
        )}
      </ProovraCard>
    </>
  );

  const settingsTab = () => {
    const statusReason = caseDenialReason(viewer, "changeStatus");
    return (
      <>
        <ProovraCard style={styles.block} testID="case-settings-rename">
          <ProovraText variant="h3" weight="semibold">Case details</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>Rename this case. The name appears everywhere the case is referenced.</ProovraText>
          <ProovraFormField label="Case name">
            <ProovraInput value={nameDraft} onChangeText={(t) => setNameDraft(t.slice(0, 120))} autoCapitalize="sentences" editable={viewer.canMutate} />
          </ProovraFormField>
          <ProovraButton
            label="Save"
            fullWidth={false}
            loading={settingsBusy}
            disabled={!viewer.canMutate || renameSaveDisabled(nameDraft, name)}
            onPress={() => void renameCase()}
          />
        </ProovraCard>

        <ProovraCard style={styles.block} testID="case-settings-status">
          <ProovraText variant="h3" weight="semibold">Status &amp; lifecycle</ProovraText>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Case status</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            Use status to organize this case. Evidence integrity, reports, packages, custody, and retention are unchanged.
          </ProovraText>
          <View style={styles.statusRow}>
            {CASE_STATUS_OPTIONS.map((opt) => {
              const current = opt.value === status;
              const disabled = !viewer.canChangeStatus || settingsBusy;
              return (
                <Pressable
                  key={opt.value}
                  disabled={disabled}
                  onPress={() => {
                    if (!current) setConfirm({ kind: "status", to: opt.value });
                  }}
                  accessibilityRole="radio"
                  accessibilityLabel={`Set status ${opt.label}`}
                  accessibilityState={{ checked: current, disabled }}
                  style={[
                    styles.statusChip,
                    {
                      borderColor: current ? theme.color.accent.a500 : theme.color.border.strong,
                      backgroundColor: current ? theme.color.accent.a050 : "transparent",
                      opacity: disabled && !current ? 0.5 : 1,
                    },
                  ]}
                >
                  <ProovraText variant="label" weight="semibold" color={current ? theme.color.accent.a600 : theme.color.ink.primary}>{opt.label}</ProovraText>
                </Pressable>
              );
            })}
          </View>
          {!viewer.canChangeStatus && statusReason ? (
            // The server's own words, not a paraphrase of a refusal it made.
            <ProovraText variant="label" color={theme.color.ink.muted}>{statusReason}</ProovraText>
          ) : null}
        </ProovraCard>

        <ProovraCard style={[styles.block, styles.danger]} testID="case-settings-delete">
          <ProovraText variant="h3" weight="semibold" color={theme.color.status.risk.fg}>Delete case</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>{deleteCaseDangerText(evidenceCount)}</ProovraText>
          <ProovraButton
            label="Delete case"
            variant="secondary"
            fullWidth={false}
            disabled={!viewer.canManage || settingsBusy}
            onPress={() => setConfirm({ kind: "deleteCase" })}
          />
          {!viewer.canManage ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>Only the case owner or an admin can delete this case.</ProovraText>
          ) : null}
        </ProovraCard>
      </>
    );
  };

  const confirmProps = (() => {
    if (!confirm) return null;
    switch (confirm.kind) {
      case "remove":
        return {
          title: `Remove "${confirm.row.title}" from this case?`,
          consequence: "This removes the evidence from this case only. The evidence record itself will remain preserved.",
          confirmLabel: "Remove from case",
          tone: "danger" as const,
        };
      case "deleteNote":
        return { title: "Delete this note?", consequence: NOTE_DELETE_CONSEQUENCE, confirmLabel: "Delete note", tone: "danger" as const };
      case "status":
        return { title: "Change case status", consequence: statusChangeConsequence(status ?? "", confirm.to), confirmLabel: "Change status", tone: "neutral" as const };
      case "deleteCase":
        return { title: "Delete this case?", consequence: DELETE_CASE_CONSEQUENCE, confirmLabel: "Delete case", tone: "danger" as const };
    }
  })();

  let body: React.ReactNode;
  if (wsState === "loading") body = <ProovraLoadingState label="Loading case" />;
  else if (wsState === "error") body = workspaceUnavailable;
  else if (tab === "overview") body = overview();
  else if (tab === "evidence") body = evidenceTab();
  else if (tab === "reports") body = reportsTab();
  else if (tab === "notes") body = notesTab();
  else body = settingsTab();

  return (
    <ProovraScreen shell>
      <View style={styles.headerRow}>
        <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
      </View>
      <ProovraCard style={styles.hero}>
        <ProovraText variant="h1" weight="bold">{name}</ProovraText>
        {/* Compact metadata line (SimpleCaseDetail.tsx:666): status as text in its lifecycle tone, then the facts. */}
        <View style={styles.meta} testID="case-meta">
          {status ? (
            <ProovraText variant="label" weight="semibold" color={statusFg}>{caseStatusDisplay(status).label}</ProovraText>
          ) : null}
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {[
              caseFacts.reference ? `Ref ${caseFacts.reference}` : null,
              wsState === "ready" ? evidenceCountText(evidenceCount) : null,
              `Created ${formatCaseDate(caseFacts.createdAt)}`,
              `Last updated ${formatCaseDate(caseFacts.updatedAt)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </ProovraText>
          {reloading ? <ProovraText variant="label" color={theme.color.ink.muted}>Updating…</ProovraText> : null}
        </View>
        {/* SimpleCaseDetail.tsx:719-740 — the labelled, copyable Case ID (LTR, selectable). */}
        <View style={styles.idRow} testID="case-id">
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.muted}>CASE ID :</ProovraText>
          <ProovraText variant="label" mono selectable>{String(id)}</ProovraText>
          <CopyButton value={String(id)} label="Copy" accessibilityLabel="Copy case ID" />
        </View>
        {/* T-15 — "Also here" (MatterWorkspace.tsx:863). */}
        <PresenceIndicator teamId={caseTeamId} resourceKind="matter" resourceId={String(id)} />
        <View style={styles.heroActions}>
          {/* The single canonical Add-evidence entry point, reachable from every section. */}
          <ProovraButton label="Add evidence" fullWidth={false} disabled={!viewer.canLinkEvidence} onPress={() => setAttachOpen(true)} />
          <ProovraButton label="Export" variant="secondary" fullWidth={false} loading={exporting} onPress={() => void exportZip()} />
        </View>
        {!viewer.canLinkEvidence && linkReason ? (
          // The server's own words, not a paraphrase of a refusal it made.
          <ProovraText variant="label" color={theme.color.ink.muted}>{linkReason}</ProovraText>
        ) : null}
      </ProovraCard>

      <CaseSectionTabs active={tab} onChange={setTab} />
      {body}

      {attachOpen ? (
        <CaseAttachEvidenceSheet
          caseId={String(id)}
          linkedIds={new Set(evidence.map((e) => e.id))}
          onClose={() => setAttachOpen(false)}
          onAttached={async ({ succeeded, failed }) => {
            const outcome = attachOutcomeMessage(succeeded, failed);
            // Every row failed: keep the sheet so the selection can be retried.
            if (succeeded === 0 && failed > 0) {
              addToast(outcome.text, "error");
              return;
            }
            setAttachOpen(false);
            await reload();
            addToast(outcome.text, outcome.tone);
          }}
        />
      ) : null}

      {confirmProps ? (
        <ProovraConfirmSheet
          visible
          title={confirmProps.title}
          consequence={confirmProps.consequence}
          confirmLabel={confirmProps.confirmLabel}
          tone={confirmProps.tone}
          onConfirm={runConfirm}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", marginTop: theme.space.s2 },
  hero: { marginBottom: theme.space.s4, gap: theme.space.s2 },
  meta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 },
  idRow: { flexDirection: "row", alignItems: "center", gap: theme.space.s2, flexWrap: "wrap" },
  heroActions: { marginTop: theme.space.s2, flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  block: { marginBottom: theme.space.s4, gap: theme.space.s2 },
  rail: { gap: theme.space.s2 },
  attention: { borderLeftWidth: 4, borderLeftColor: theme.color.status.pending.solid },
  rows: { gap: theme.space.s2, marginVertical: theme.space.s3 },
  evidenceRow: { gap: theme.space.s1 },
  rowActions: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginTop: theme.space.s1 },
  composer: { gap: theme.space.s2, marginTop: theme.space.s2 },
  composerActions: { flexDirection: "row", justifyContent: "flex-end" },
  notesEmpty: { alignItems: "center", gap: 4, paddingVertical: theme.space.s3 },
  noteRow: { paddingVertical: theme.space.s2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border.subtle, gap: 2 },
  noteResolved: { opacity: 0.6 },
  noteActions: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginTop: theme.space.s2 },
  statusChip: { paddingHorizontal: theme.space.s3, paddingVertical: theme.space.s2, borderRadius: theme.radius.pill, borderWidth: 1, minHeight: 40, justifyContent: "center" },
  danger: { borderWidth: 1, borderColor: theme.color.status.risk.border, backgroundColor: theme.color.status.risk.bg },
});
