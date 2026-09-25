/**
 * SEARCH RESULT INSPECTOR (T-15 / T-14) — the touch port of the web search
 * console's right-hand Inspector (apps/web/app/(app)/search/page.tsx). A phone
 * has no third column, so selecting a result opens this sheet: type, title,
 * lifecycle, the one open action, signals, pointers, lifecycle facts, summary
 * and the record's related evidence (GET /v1/search/relationships/:id).
 * Investigation pivots are omitted: native has no /investigation screens.
 */
import React, { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../api";
import { formatUserDateTime } from "../lib/date";
import { theme } from "../theme/theme";
import {
  buildSearchRelationshipsPath,
  documentTypeDisplay,
  parseSearchRelationships,
  isSearchLifecycleValue,
  rowLifecycleState,
  rowSupportingSubtitle,
  searchBadgeLabel,
  searchBadgeTone,
  searchLifecycleLabel,
  searchLifecycleTone,
  searchOpenAction,
  type SearchRelationship,
  type SearchRow,
} from "../product/search";
import { ProovraBadge, ProovraButton, ProovraText } from "./index";
import { ProovraSheet } from "./patterns";

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: theme.space.s1, marginTop: theme.space.s3 }}>
      <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>{label}</ProovraText>
      {children}
    </View>
  );
}
function Fact({ label, value, onPress, state }: { label: string; value: string; onPress?: () => void; state?: string | null }) {
  // A lifecycle FACT is toned text by the one mapping; an absent value is a neutral dash.
  const color = onPress
    ? theme.color.accent.a600
    : state !== undefined && isSearchLifecycleValue(state)
      ? theme.color.status[searchLifecycleTone(state)].fg
      : theme.color.ink.primary;
  const text = (
    <ProovraText variant="bodySm" color={color} selectable>
      {value}
    </ProovraText>
  );
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
      <ProovraText variant="label" color={theme.color.ink.muted} style={{ minWidth: 96 }}>{label}</ProovraText>
      {onPress ? (
        <Pressable onPress={onPress} accessibilityRole="link" accessibilityLabel={`${label}: ${value}`}>
          {text}
        </Pressable>
      ) : (
        text
      )}
    </View>
  );
}

export function SearchInspector({ row, teamId, onClose }: { row: SearchRow | null; teamId: string | null; onClose: () => void }) {
  const router = useRouter();
  const [relationships, setRelationships] = useState<SearchRelationship[] | null>(null);
  const evidenceId = row?.evidenceId ?? null;

  useEffect(() => {
    setRelationships(null);
    if (!teamId || !evidenceId) return;
    let cancelled = false;
    apiFetch(buildSearchRelationshipsPath(evidenceId, teamId))
      .then((d) => {
        if (!cancelled) setRelationships(parseSearchRelationships(d, evidenceId));
      })
      .catch(() => {
        // The web shows "No related evidence." on a failed read, too.
        if (!cancelled) setRelationships([]);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, evidenceId]);

  if (!row) return null;
  const type = documentTypeDisplay(row.documentType);
  const action = searchOpenAction(row);
  const lifecycle = rowLifecycleState(row);
  const subtitle = rowSupportingSubtitle(row);
  const go = (route: Parameters<typeof router.push>[0]) => {
    onClose();
    router.push(route);
  };
  const title = row.title?.trim() || type.label;

  return (
    <ProovraSheet visible title={title} onClose={onClose}>
      <View style={{ gap: theme.space.s2 }} testID="search-inspector">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, alignItems: "center" }}>
          <ProovraBadge tone={type.tone} label={type.label} />
          {lifecycle ? (
            <ProovraText variant="label" weight="semibold" color={theme.color.status[searchLifecycleTone(lifecycle)].fg}>
              {searchLifecycleLabel(lifecycle)}
            </ProovraText>
          ) : null}
        </View>
        {subtitle ? (
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{subtitle}</ProovraText>
        ) : null}
        {action ? <ProovraButton label={action.label} variant="secondary" fullWidth={false} onPress={() => go(action.route as never)} /> : null}

        {(row.badges ?? []).length > 0 ? (
          <Section label="Signals">
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s1 }}>
              {(row.badges ?? []).map((b) => (
                <ProovraBadge key={b} tone={searchBadgeTone(b)} label={searchBadgeLabel(b)} />
              ))}
            </View>
          </Section>
        ) : null}

        <Section label="Pointers">
          <Fact label="Document" value={row.documentId} />
          {row.evidenceId ? <Fact label="Evidence" value={row.evidenceId} onPress={() => go(`/evidence/${row.evidenceId}`)} /> : null}
          {row.workflowInstanceId ? <Fact label="Workflow" value={row.workflowInstanceId} /> : null}
          {row.workflowStepInstanceId ? <Fact label="Workflow step" value={row.workflowStepInstanceId} /> : null}
          {row.caseId ? <Fact label="Case" value={row.caseId} onPress={() => go(`/case/${row.caseId}`)} /> : null}
        </Section>

        {typeof row.semanticScore === "number" && row.semanticScore > 0 ? (
          <Section label="Related evidence">
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {`Semantically similar to: ${title.slice(0, 80)}${title.length > 80 ? "…" : ""}`}
            </ProovraText>
          </Section>
        ) : null}

        <Section label="Lifecycle">
          <Fact label="Review" value={searchLifecycleLabel(row.reviewState)} state={row.reviewState ?? null} />
          <Fact label="Workflow" value={searchLifecycleLabel(row.workflowState)} state={row.workflowState ?? null} />
          <Fact label="Export" value={searchLifecycleLabel(row.exportState)} state={row.exportState ?? null} />
          <Fact label="Retention" value={searchLifecycleLabel(row.retentionState)} state={row.retentionState ?? null} />
          <Fact label="Legal hold" value={searchLifecycleLabel(row.legalHoldState)} state={row.legalHoldState ?? null} />
          <Fact label="Updated" value={row.updatedAtUtc ? formatUserDateTime(row.updatedAtUtc) : "—"} />
        </Section>

        {row.summary ? (
          <Section label="Summary">
            <ProovraText variant="bodySm">{row.summary}</ProovraText>
          </Section>
        ) : null}

        {row.evidenceId ? (
          <Section label="Related evidence">
            {relationships === null ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>Loading…</ProovraText>
            ) : relationships.length === 0 ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>No related evidence.</ProovraText>
            ) : (
              relationships.map((r) => (
                <View key={r.relationshipId} style={{ gap: 2 }}>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, alignItems: "center" }}>
                    <ProovraBadge tone="neutral" label={r.relationshipType} />
                    <Pressable onPress={() => go(`/evidence/${r.otherEvidenceId}`)} accessibilityRole="link" accessibilityLabel={`Related evidence ${r.otherEvidenceId}`}>
                      <ProovraText variant="bodySm" color={theme.color.accent.a600}>{r.otherEvidenceId}</ProovraText>
                    </Pressable>
                  </View>
                  {r.note ? <ProovraText variant="label" color={theme.color.ink.secondary}>{r.note}</ProovraText> : null}
                </View>
              ))
            )}
          </Section>
        ) : null}
      </View>
    </ProovraSheet>
  );
}
