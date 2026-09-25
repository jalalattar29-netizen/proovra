/**
 * CASE DETAIL — the section tabs and the "Link evidence to case" picker of the
 * web SimpleCaseDetail (SimpleCaseDetail.tsx:340 tabs, :1353 AttachEvidenceModal),
 * built from the shared native primitives.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View, StyleSheet } from "react-native";
import { apiFetch } from "../api";
import { theme } from "../theme/theme";
import { ProovraText, ProovraButton, ProovraBadge, ProovraSheet, ProovraFilterSearch } from "./index";
import {
  ATTACH_COPY,
  CASE_TABS,
  attachConfirmLabel,
  attachCountMessage,
  attachIntegrityTone,
  attachSubmitError,
  matchesCaseEvidence,
  parseAttachCandidates,
  verificationText,
  type CaseEvidenceRow,
  type CaseTab,
} from "../product/case-detail";

/** The five case sections as selectable pills — the web `.app-tabs` row. */
export function CaseSectionTabs({ active, onChange }: { active: CaseTab; onChange: (tab: CaseTab) => void }) {
  return (
    <View style={styles.tabs} accessibilityLabel="Case sections" testID="case-section-tabs">
      {CASE_TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <Pressable
            key={tab.id}
            onPress={() => onChange(tab.id)}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected }}
            style={[
              styles.tab,
              {
                borderColor: selected ? theme.color.accent.a500 : theme.color.border.default,
                backgroundColor: selected ? theme.color.accent.a050 : "transparent",
              },
            ]}
          >
            <ProovraText variant="label" weight="semibold" color={selected ? theme.color.accent.a600 : theme.color.ink.secondary}>
              {tab.label}
            </ProovraText>
          </Pressable>
        );
      })}
    </View>
  );
}

type LoadState = "loading" | "ready" | "restricted" | "error";

/**
 * Searchable, MULTI-select picker. One POST per record (the route has no batch
 * attach), settled together so one refusal does not abort the rest; rows that
 * failed stay selected so the retry targets exactly the unfinished work.
 */
export function CaseAttachEvidenceSheet({
  caseId,
  linkedIds,
  onClose,
  onAttached,
}: {
  caseId: string;
  linkedIds: ReadonlySet<string>;
  onClose: () => void;
  /** The page decides: it keeps the sheet open when every row failed. */
  onAttached: (result: { succeeded: number; failed: number }) => Promise<void>;
}) {
  const [candidates, setCandidates] = useState<CaseEvidenceRow[]>([]);
  const [load, setLoad] = useState<LoadState>("loading");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inFlight = useRef(false);
  // The linked set is captured once: a parent re-render must not refetch.
  const linkedRef = useRef(linkedIds);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await apiFetch(`/v1/cases/${encodeURIComponent(caseId)}/available-evidence`);
        if (!alive) return;
        setCandidates(parseAttachCandidates(res, linkedRef.current));
        setLoad("ready");
      } catch (err) {
        if (!alive) return;
        // A refusal and an outage are different answers: "no evidence to link"
        // would be a confident statement about a population never seen.
        const code = (err as { statusCode?: number } | null)?.statusCode;
        setLoad(code === 401 || code === 403 ? "restricted" : "error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [caseId]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const submit = useCallback(async () => {
    if (inFlight.current || selected.size === 0) return;
    inFlight.current = true;
    setBusy(true);
    setSubmitError(null);
    const ids = Array.from(selected);
    const results = await Promise.allSettled(
      ids.map((evidenceId) =>
        apiFetch(`/v1/cases/${encodeURIComponent(caseId)}/evidence`, {
          method: "POST",
          body: JSON.stringify({ evidenceId }),
        }),
      ),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - succeeded;
    if (succeeded > 0) {
      setSelected((prev) => {
        const next = new Set(prev);
        results.forEach((r, i) => {
          if (r.status === "fulfilled") next.delete(ids[i]);
        });
        return next;
      });
      setQuery("");
    }
    setSubmitError(attachSubmitError(failed));
    inFlight.current = false;
    setBusy(false);
    await onAttached({ succeeded, failed });
  }, [caseId, selected, onAttached]);

  const visible = candidates.filter((c) => matchesCaseEvidence(c, query));
  const count = selected.size;

  let list: React.ReactNode;
  if (load === "loading") list = <ProovraText variant="bodySm" color={theme.color.ink.muted}>{ATTACH_COPY.loading}</ProovraText>;
  else if (load === "restricted") list = <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{ATTACH_COPY.restricted}</ProovraText>;
  else if (load === "error") list = <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{ATTACH_COPY.error}</ProovraText>;
  else if (candidates.length === 0) list = <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{ATTACH_COPY.empty}</ProovraText>;
  else if (visible.length === 0) list = <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{ATTACH_COPY.noMatch}</ProovraText>;
  else
    list = visible.map((c) => {
      const on = selected.has(c.id);
      return (
        <Pressable
          key={c.id}
          onPress={() => !busy && toggle(c.id)}
          disabled={busy}
          accessibilityRole="checkbox"
          accessibilityLabel={c.title}
          accessibilityState={{ checked: on, disabled: busy }}
          testID={`case-attach-row-${c.id}`}
          style={[
            styles.candidate,
            { borderColor: on ? theme.color.accent.a500 : theme.color.border.default, backgroundColor: on ? theme.color.accent.a050 : theme.color.surface.card },
          ]}
        >
          <View style={[styles.check, { borderColor: on ? theme.color.accent.a600 : theme.color.border.strong, backgroundColor: on ? theme.color.accent.a600 : "transparent" }]}>
            {on ? <ProovraText variant="label" weight="bold" color={theme.color.ink.onAccent}>✓</ProovraText> : null}
          </View>
          <View style={styles.candidateBody}>
            <ProovraText variant="bodySm" weight="semibold" numberOfLines={2}>{c.title}</ProovraText>
            <View style={styles.meta}>
              <ProovraBadge tone="neutral" label={(c.type || "RECORD").replace(/_/g, " ")} />
              <ProovraText variant="label" mono color={theme.color.ink.muted}>{c.id.slice(0, 8)}</ProovraText>
              {c.verificationStatus ? <ProovraBadge tone={attachIntegrityTone(c.verificationStatus)} label={verificationText(c.verificationStatus)} /> : null}
            </View>
            {/* Informational only: a record without a report is still linkable. */}
            <ProovraText variant="label" color={theme.color.ink.secondary}>{`${c.reportLabel} · ${c.packageLabel}`}</ProovraText>
          </View>
        </Pressable>
      );
    });

  return (
    <ProovraSheet visible title={ATTACH_COPY.title} onClose={busy ? () => {} : onClose}>
      <View style={styles.sheetBody} testID="case-attach-sheet">
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{ATTACH_COPY.lede}</ProovraText>
        <ProovraFilterSearch value={query} onChange={setQuery} placeholder={ATTACH_COPY.searchPlaceholder} />
        {submitError ? (
          <View accessibilityRole="alert"><ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{submitError}</ProovraText></View>
        ) : null}
        <View style={styles.list}>{list}</View>
        <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
          {attachCountMessage(count)}
        </ProovraText>
        <View style={styles.actions}>
          <ProovraButton label="Cancel" variant="secondary" fullWidth={false} disabled={busy} onPress={onClose} />
          <ProovraButton label={attachConfirmLabel(count, busy)} fullWidth={false} disabled={count === 0 || busy} onPress={() => void submit()} />
        </View>
      </View>
    </ProovraSheet>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginBottom: theme.space.s4 },
  tab: { paddingHorizontal: theme.space.s3, paddingVertical: theme.space.s2, borderRadius: theme.radius.pill, borderWidth: 1, minHeight: 36, justifyContent: "center" },
  sheetBody: { gap: theme.space.s3 },
  list: { gap: theme.space.s2 },
  candidate: { flexDirection: "row", gap: theme.space.s3, padding: theme.space.s3, borderWidth: 1, borderRadius: theme.radius.md, alignItems: "flex-start" },
  check: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: "center", justifyContent: "center", marginTop: 2 },
  candidateBody: { flex: 1, gap: theme.space.s1 },
  meta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.space.s2 },
});
