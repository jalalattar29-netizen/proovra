import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useLocale } from "../../src/locale-context";
import { apiFetch, apiFetchText } from "../../src/api";
import { useToast } from "../../src/toast-context";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { describeRelativeTime } from "../../src/lib/relative-time";
import { theme, statusTone } from "../../src/theme/theme";
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
  ProovraSupportReference,
  ProovraSheet,
  ProovraConfirmSheet,
} from "../../src/ui";
import { caseStatusDisplay } from "../../src/product/domain-display";
import { usePlatformContext } from "../../src/product/platform-context";
import {
  CREATE_CASE_COPY,
  MATTER_QUEUE_COPY as COPY,
  archiveCaseConfirm,
  caseTotalLabel,
  createdCaseId,
  deleteCaseConfirm,
  reasonCodeLabel,
  riskBadgeLabel,
  validateNewCaseName,
  RISK_OPTIONS,
  STATUS_SEGMENTS,
  buildMatterQueuePath,
  canSeeAdvancedCaseOps,
  caseReadiness,
  evidenceCountLabel,
  normalizeCaseSearch,
  parseMatterQueue,
  queueCountTitle,
  riskTone,
  rowCounters,
  type CaseStatusFilter,
  type MatterQueue,
  type MatterQueueRow,
  type RiskLevelFilter,
} from "../../src/product/matter-queue";

/*
 * THE WORKSPACE'S CASES QUEUE — the native port of the web CasesIndex
 * (apps/web/components/cases-experience/CasesIndex.tsx).
 *
 *   GET  /v1/cases/matter-queue?teamId=&search=&status=&riskLevel=  (search/status/risk are the SERVER's filters)
 *   POST /v1/cases { name, teamId }                                   (CreateCaseModal)
 *   POST /v1/cases/:id/status { toStatus: "ARCHIVED" } · DELETE /v1/cases/:id   (the row action menu)
 *
 * Not ported: the bulk action bar (CasesIndex.tsx:941) and the risk select /
 * risk, counter and reason-code signals render only for enterprise workspaces
 * (`useEnterpriseSurfaceAccess`); the signals are shown here under the same
 * server-projected gate, the bulk bar is not ported.
 */
type QueueState =
  | { phase: "loading" }
  | { phase: "ready"; queue: MatterQueue; reloading: boolean }
  | { phase: "auth"; code: "auth_required" | "permission_denied" }
  | { phase: "unavailable"; message: string };

type RowConfirm = { kind: "archive" | "delete"; row: MatterQueueRow };

export default function CasesScreen() {
  const { t } = useLocale();
  const router = useRouter();
  const { addToast } = useToast();
  const platform = usePlatformContext();
  const teamId = platform.context?.activeTeamId ?? null;
  const workspaceName = platform.context?.displayName ?? null;
  const advanced = canSeeAdvancedCaseOps(platform.envelope);

  const [state, setState] = useState<QueueState>({ phase: "loading" });
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [status, setStatus] = useState<CaseStatusFilter>("");
  const [riskLevel, setRiskLevel] = useState<RiskLevelFilter>("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<SafeError | null>(null);
  const [actionsFor, setActionsFor] = useState<MatterQueueRow | null>(null);
  const [rowConfirm, setRowConfirm] = useState<RowConfirm | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const generation = useRef(0);

  // Search is debounced (300ms) so typing does not refetch per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setAppliedSearch(normalizeCaseSearch(search)), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    if (!teamId) return;
    const mine = ++generation.current;
    // A reload keeps the list on screen; only the first load shows the spinner.
    setState((prev) => (prev.phase === "ready" ? { ...prev, reloading: true } : { phase: "loading" }));
    try {
      const queue = parseMatterQueue(await apiFetch(buildMatterQueuePath(teamId, { search: appliedSearch, status, riskLevel })));
      if (mine !== generation.current) return;
      setState({ phase: "ready", queue, reloading: false });
    } catch (err) {
      if (mine !== generation.current) return;
      const code = (err as { statusCode?: number } | null)?.statusCode;
      if (code === 401) setState({ phase: "auth", code: "auth_required" });
      else if (code === 403) setState({ phase: "auth", code: "permission_denied" });
      else setState({ phase: "unavailable", message: toSafeUserError(err, { message: COPY.unavailableFallback }).message });
    }
  }, [teamId, appliedSearch, status, riskLevel]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = useCallback(() => {
    setCreateError(null);
    setNewName("");
    setCreating(true);
  }, []);

  const closeCreate = useCallback(() => {
    if (createBusy) return;
    setCreating(false);
    setNewName("");
    setCreateError(null);
  }, [createBusy]);

  const create = useCallback(async () => {
    if (createBusy) return;
    setCreateError(null);
    const invalid = validateNewCaseName(newName);
    if (invalid) {
      setCreateError({ kind: "input", title: "Check the details", message: invalid });
      return;
    }
    setCreateBusy(true);
    try {
      // The case belongs to the workspace it is created in (CreateCaseModal sends teamId).
      const name = newName.trim();
      const created = await apiFetch("/v1/cases", { method: "POST", body: JSON.stringify(teamId ? { name, teamId } : { name }) });
      const id = createdCaseId(created);
      setCreating(false);
      setNewName("");
      if (id) router.push(`/case/${id}`);
      else await load();
    } catch (err) {
      setCreateError(toSafeUserError(err, { message: "Could not create case" }));
    } finally {
      setCreateBusy(false);
    }
  }, [newName, router, load, teamId, createBusy]);

  /** CasesIndex RowActions: Open / Rename / Change status go to the case; Archive and Delete act here. */
  const openCase = (row: MatterQueueRow, tab?: "settings") => {
    setActionsFor(null);
    router.push(tab ? `/case/${row.id}?tab=${tab}` : `/case/${row.id}`);
  };

  const runRowConfirm = useCallback(async () => {
    const c = rowConfirm;
    setRowConfirm(null);
    if (!c) return;
    setRowBusy(c.row.id);
    try {
      if (c.kind === "archive") {
        await apiFetch(`/v1/cases/${encodeURIComponent(c.row.id)}/status`, { method: "POST", body: JSON.stringify({ toStatus: "ARCHIVED" }) });
        addToast("Case archived.", "success");
      } else {
        // 204 No Content (cases.routes.ts:1272) — read as text, not JSON.
        await apiFetchText(`/v1/cases/${encodeURIComponent(c.row.id)}`, { method: "DELETE" });
        addToast("Case deleted.", "success");
      }
      await load();
    } catch (err) {
      addToast(toSafeUserError(err, { message: c.kind === "archive" ? "Could not archive case." : "Could not delete case." }).message, "error");
    } finally {
      setRowBusy(null);
    }
  }, [rowConfirm, load, addToast]);

  const anyFilterActive = appliedSearch.length > 0 || status !== "" || riskLevel !== "";
  const clearFilters = () => {
    setSearch("");
    setAppliedSearch("");
    setStatus("");
    setRiskLevel("");
  };

  const chip = (key: string, label: string, active: boolean, onPress: () => void) => (
    <Pressable
      key={key}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={[styles.filterChip, { backgroundColor: active ? theme.color.accent.a050 : theme.color.surface.card, borderColor: active ? theme.color.accent.a500 : theme.color.border.default }]}
    >
      <ProovraText variant="label" weight="semibold" color={active ? theme.color.accent.a600 : theme.color.ink.secondary}>
        {label}
      </ProovraText>
    </Pressable>
  );

  let body: React.ReactNode;
  if (!teamId) {
    body = <ProovraEmptyState title={t("cases")} message={COPY.noWorkspace} />;
  } else if (state.phase === "loading") {
    body = <ProovraLoadingState label={t("cases")} />;
  } else if (state.phase === "auth") {
    body = (
      <>
        {/* The web auth/outage headers carry this eyebrow (CasesIndex.tsx:1804, :1837). */}
        <ProovraText variant="label" weight="semibold" color={theme.color.ink.muted}>Investigation Matters</ProovraText>
        <ProovraEmptyState
        title={state.code === "auth_required" ? COPY.signInTitle : COPY.deniedTitle}
        message={state.code === "auth_required" ? COPY.signInBody : COPY.deniedBody}
        />
      </>
    );
  } else if (state.phase === "unavailable") {
    body = (
      <>
        <ProovraText variant="label" weight="semibold" color={theme.color.ink.muted}>Investigation Matters</ProovraText>
        <ProovraErrorState message={`${COPY.unavailableTitle}. ${state.message}`} onRetry={() => void load()} />
      </>
    );
  } else {
    const { queue } = state;
    body = (
      <>
        <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary} style={styles.count}>
          {queueCountTitle(queue.items.length, queue.total)}
        </ProovraText>
        {queue.items.length === 0 ? (
          queue.total === 0 && !anyFilterActive ? (
            <ProovraEmptyState
              title={COPY.noneTitle}
              message={COPY.noneBody}
              action={<ProovraButton label="Create case" fullWidth={false} onPress={openCreate} />}
            />
          ) : (
            <ProovraEmptyState
              title={COPY.noMatchTitle}
              message={COPY.noMatchBody}
              action={<ProovraButton label={COPY.clearFilters} variant="secondary" fullWidth={false} onPress={clearFilters} />}
            />
          )
        ) : (
          <ProovraCard>
            {queue.items.map((c) => {
              const counters = advanced ? rowCounters(c) : [];
              const meta = [
                c.shortRef,
                c.ownerLabel,
                evidenceCountLabel(c.linkedEvidenceCount),
                ...counters,
                c.latestActivityAtUtc ? describeRelativeTime(c.latestActivityAtUtc) : null,
              ].filter(Boolean);
              const readiness = caseReadiness(c);
              const statusDisplay = c.status ? caseStatusDisplay(c.status) : null;
              return (
                <ProovraListRow
                  key={c.id}
                  title={c.name}
                  subtitle={meta.join(" · ")}
                  onPress={() => router.push(`/case/${c.id}`)}
                  trailing={
                    <View style={styles.trailingRow}>
                      <View style={styles.trailing}>
                        {/* A state on this table is TEXT in its lifecycle tone (CasesIndex.tsx:1216), not a capsule. */}
                        {statusDisplay ? (
                          <ProovraText variant="label" weight="semibold" color={statusTone(statusDisplay.tone).fg}>{statusDisplay.label}</ProovraText>
                        ) : null}
                        <ProovraText variant="label" color={statusTone(readiness.tone).fg}>{readiness.label}</ProovraText>
                        {advanced && c.priority && c.priority !== "P2" ? <ProovraBadge tone="neutral" label={c.priority} /> : null}
                        {advanced && c.riskLevel ? <ProovraBadge tone={riskTone(c.riskLevel)} label={riskBadgeLabel(c.riskLevel, c.riskScore)} /> : null}
                        {advanced && c.activeLegalHoldCount > 0 ? <ProovraBadge tone="risk" label="Legal preservation" /> : null}
                        {advanced ? c.riskReasonCodes.map((code) => <ProovraBadge key={code} tone="neutral" label={reasonCodeLabel(code)} />) : null}
                      </View>
                      <Pressable
                        onPress={() => setActionsFor(c)}
                        disabled={rowBusy === c.id}
                        accessibilityRole="button"
                        accessibilityLabel={`Case actions for ${c.name}`}
                        hitSlop={8}
                        style={styles.more}
                      >
                        <ProovraText variant="body" weight="bold" color={theme.color.ink.secondary}>⋯</ProovraText>
                      </Pressable>
                    </View>
                  }
                />
              );
            })}
          </ProovraCard>
        )}
      </>
    );
  }

  const confirmCopy = rowConfirm ? (rowConfirm.kind === "archive" ? archiveCaseConfirm(rowConfirm.row.name) : deleteCaseConfirm(rowConfirm.row.name)) : null;

  return (
    <ProovraShell>
      <ProovraSection
        title={t("cases")}
        action={<ProovraButton label="Create case" fullWidth={false} onPress={openCreate} />}
      >
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{COPY.subtitle}</ProovraText>
        {state.phase === "ready" ? (
          // The header context strip (CasesIndex.tsx:395): total, when the server built it, and a reload in flight.
          <View style={styles.context} testID="cases-context">
            <ProovraBadge tone="info" label={caseTotalLabel(state.queue.total)} />
            {state.queue.generatedAt ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>{`Refreshed ${describeRelativeTime(state.queue.generatedAt)}`}</ProovraText>
            ) : null}
            {state.reloading ? <ProovraText variant="label" color={theme.color.ink.muted}>Updating…</ProovraText> : null}
          </View>
        ) : null}

        {teamId && (state.phase === "ready" || anyFilterActive) ? (
          <>
            <View style={styles.search}>
              <ProovraInput
                value={search}
                onChangeText={setSearch}
                placeholder={COPY.searchPlaceholder}
                accessibilityLabel={COPY.searchLabel}
                autoCapitalize="none"
              />
              {/* The web FilterBar clear (FilterBar.tsx:256). */}
              {search.length > 0 ? <ProovraButton label="Clear search" variant="ghost" fullWidth={false} onPress={() => setSearch("")} /> : null}
            </View>
            <View style={styles.filterRow}>
              {STATUS_SEGMENTS.map((seg) => chip(seg.value || "ALL", seg.label, status === seg.value, () => setStatus(seg.value)))}
            </View>
            {advanced ? (
              <View style={styles.filterRow}>
                {RISK_OPTIONS.map((r) => chip(`risk-${r.value || "ANY"}`, r.value ? `Risk ${r.label}` : r.label, riskLevel === r.value, () => setRiskLevel(r.value)))}
              </View>
            ) : null}
          </>
        ) : null}

        {body}
      </ProovraSection>

      {creating ? (
        <ProovraSheet visible title={CREATE_CASE_COPY.title} onClose={closeCreate}>
          <View style={styles.sheetBody} testID="create-case-sheet">
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{CREATE_CASE_COPY.description}</ProovraText>
            {workspaceName ? (
              <ProovraText variant="label" color={theme.color.ink.secondary}>{`${CREATE_CASE_COPY.contextPrefix} ${workspaceName}`}</ProovraText>
            ) : null}
            <ProovraFormField label="Case name" error={createError ? createError.message : null}>
              <ProovraInput
                value={newName}
                onChangeText={(v) => setNewName(v.slice(0, 120))}
                placeholder={CREATE_CASE_COPY.placeholder}
                autoCapitalize="sentences"
                editable={!createBusy}
                onSubmitEditing={() => void create()}
              />
            </ProovraFormField>
            <ProovraText variant="label" color={theme.color.ink.muted}>{CREATE_CASE_COPY.helper}</ProovraText>
            <ProovraSupportReference reference={createError?.requestId} />
            <View style={styles.sheetActions}>
              <ProovraButton label="Cancel" variant="secondary" fullWidth={false} disabled={createBusy} onPress={closeCreate} />
              <ProovraButton
                label={createBusy ? "Creating…" : "Create case"}
                fullWidth={false}
                disabled={createBusy || newName.trim().length === 0}
                onPress={() => void create()}
              />
            </View>
          </View>
        </ProovraSheet>
      ) : null}

      {actionsFor ? (
        <ProovraSheet visible title={actionsFor.name} onClose={() => setActionsFor(null)}>
          <View style={styles.sheetBody} testID="case-row-actions">
            <ProovraButton label="Open" variant="secondary" onPress={() => openCase(actionsFor)} />
            {/* Rename and status live on the case's Settings section. */}
            <ProovraButton label="Rename" variant="secondary" onPress={() => openCase(actionsFor, "settings")} />
            <ProovraButton label="Change status" variant="secondary" onPress={() => openCase(actionsFor, "settings")} />
            <ProovraButton
              label="Archive"
              variant="secondary"
              disabled={actionsFor.status === "ARCHIVED"}
              onPress={() => {
                setRowConfirm({ kind: "archive", row: actionsFor });
                setActionsFor(null);
              }}
            />
            <ProovraButton
              label="Delete"
              variant="danger"
              onPress={() => {
                setRowConfirm({ kind: "delete", row: actionsFor });
                setActionsFor(null);
              }}
            />
          </View>
        </ProovraSheet>
      ) : null}

      {rowConfirm && confirmCopy ? (
        <ProovraConfirmSheet
          visible
          title={confirmCopy.title}
          consequence={confirmCopy.consequence}
          confirmLabel={confirmCopy.confirmLabel}
          tone={rowConfirm.kind === "archive" ? "warning" : "danger"}
          onConfirm={() => void runRowConfirm()}
          onCancel={() => setRowConfirm(null)}
        />
      ) : null}
    </ProovraShell>
  );
}

const styles = StyleSheet.create({
  context: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2, marginVertical: theme.space.s3 },
  search: { marginBottom: theme.space.s3 },
  count: { marginBottom: theme.space.s2 },
  trailingRow: { flexDirection: "row", alignItems: "center", gap: theme.space.s2 },
  trailing: { alignItems: "flex-end", gap: theme.space.s1 },
  more: { minWidth: 32, minHeight: 32, alignItems: "center", justifyContent: "center" },
  filterRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginBottom: theme.space.s3 },
  filterChip: { paddingHorizontal: theme.space.s3, paddingVertical: theme.space.s2, borderRadius: theme.radius.pill, borderWidth: 1, minHeight: 36, justifyContent: "center" },
  sheetBody: { gap: theme.space.s3 },
  sheetActions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.space.s2 },
});
