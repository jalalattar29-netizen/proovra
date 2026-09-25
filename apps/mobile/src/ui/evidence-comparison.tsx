/**
 * EVIDENCE COMPARISON (T-14) — the touch port of the web ComparisonPanel and
 * StructuredSnapshot. Collapsed until opened; the read happens on open, as on
 * the web. Each card leads with a one-line summary and keeps the full
 * structure behind "Technical details". The raw JSON has the web's Copy JSON.
 */
import React, { useEffect, useState } from "react";
import { CopyButton } from "./copy-button";
import { Pressable, View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import {
  body as snapshotBody,
  buildComparisonPath,
  CHANGE_LABEL,
  compareLegend,
  COMPARISON_COPY,
  projectComparison,
  summariseGroup,
  type ComparisonGroup,
  type SnapNode,
} from "../product/evidence-comparison";
import { theme } from "../theme/theme";
import { ProovraCard, ProovraText } from "./index";

function Toggle({ label, open, onPress }: { label: string; open: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={label}
      onPress={onPress}
      style={{ minHeight: 44, justifyContent: "center" }}
    >
      <ProovraText variant="bodySm" weight="semibold" color={theme.color.ink.secondary}>{`${label} ${open ? "▴" : "▾"}`}</ProovraText>
    </Pressable>
  );
}

function Mark({ change }: { change: SnapNode["change"] }) {
  if (!change || change === "unchanged") return null;
  return <ProovraText variant="label" weight="semibold" color={theme.color.status.pending.fg}>{CHANGE_LABEL[change]}</ProovraText>;
}

function Nodes({ nodes, depth }: { nodes: SnapNode[]; depth: number }) {
  return (
    <View style={{ gap: theme.space.s1, paddingLeft: depth > 0 ? theme.space.s2 : 0 }}>
      {nodes.map((n) =>
        n.kind === "fact" ? (
          <View key={n.key} style={{ flexDirection: "row", gap: theme.space.s2, flexWrap: "wrap" }}>
            <ProovraText variant="label" color={theme.color.ink.muted}>{n.label}</ProovraText>
            <ProovraText variant="label" selectable>{n.value}</ProovraText>
            <Mark change={n.change} />
          </View>
        ) : (
          <View key={n.key} style={{ gap: theme.space.s1 }}>
            <View style={{ flexDirection: "row", gap: theme.space.s2, flexWrap: "wrap" }}>
              <ProovraText variant="label" weight="semibold">{n.label}</ProovraText>
              {n.count !== null ? (
                <ProovraText variant="label" color={theme.color.ink.muted}>{`${n.count} ${n.count === 1 ? "entry" : "entries"}`}</ProovraText>
              ) : null}
              <Mark change={n.change} />
            </View>
            {n.count === 0 ? <ProovraText variant="label" color={theme.color.ink.muted}>Not recorded</ProovraText> : null}
            {n.body ? <Nodes nodes={n.body} depth={depth + 1} /> : null}
            {n.items ? n.items.map((item, i) => <Nodes key={i} nodes={item} depth={depth + 1} />) : null}
            {n.scalarItems ? n.scalarItems.map((s, i) => <ProovraText key={i} variant="label" selectable>{s}</ProovraText>) : null}
          </View>
        ),
      )}
    </View>
  );
}

function GroupCard({ group }: { group: ComparisonGroup }) {
  const [details, setDetails] = useState(false);
  const [raw, setRaw] = useState(false);
  if (!group.data) {
    return (
      <ProovraCard>
        <ProovraText variant="bodySm" weight="semibold">{group.title}</ProovraText>
        <ProovraText variant="label" color={theme.color.ink.muted}>{COMPARISON_COPY.notAvailable}</ProovraText>
      </ProovraCard>
    );
  }
  return (
    <ProovraCard testID={`comparison-${group.title}`}>
      <View style={{ gap: theme.space.s1 }}>
        <ProovraText variant="bodySm" weight="semibold">{group.title}</ProovraText>
        <ProovraText variant="label" color={theme.color.ink.secondary}>{summariseGroup(group.data)}</ProovraText>
        <Toggle label={`${COMPARISON_COPY.technical}: ${group.title}`} open={details} onPress={() => setDetails((v) => !v)} />
        {details ? (
          <View style={{ gap: theme.space.s2 }}>
            {group.compare ? <ProovraText variant="label" color={theme.color.ink.muted}>{compareLegend(group.compare.label)}</ProovraText> : null}
            <Nodes nodes={snapshotBody(group.data, group.compare?.fields, false)} depth={0} />
            <Toggle label={COMPARISON_COPY.raw} open={raw} onPress={() => setRaw((v) => !v)} />
            {raw ? (
              <>
                {/* StructuredSnapshot.tsx:300-312 */}
                <CopyButton value={JSON.stringify(group.data, null, 2)} label="Copy JSON" accessibilityLabel={`Copy JSON: ${group.title}`} />
                <ProovraText variant="label" selectable style={{ fontFamily: "monospace" }}>{JSON.stringify(group.data, null, 2)}</ProovraText>
              </>
            ) : null}
          </View>
        ) : null}
      </View>
    </ProovraCard>
  );
}

export function EvidenceComparisonPanel({ evidenceId }: { evidenceId: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ status: "idle" | "loading" } | { status: "ready"; groups: ComparisonGroup[] } | { status: "failed"; message: string }>({ status: "idle" });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ status: "loading" });
    apiFetch(buildComparisonPath(evidenceId))
      .then((d) => {
        if (!cancelled) setState({ status: "ready", groups: projectComparison(d) });
      })
      .catch((err) => {
        if (!cancelled) setState({ status: "failed", message: toSafeUserError(err, { message: COMPARISON_COPY.unavailable }).message });
      });
    return () => {
      cancelled = true;
    };
  }, [evidenceId, open]);

  return (
    <View testID="evidence-comparison" style={{ gap: theme.space.s2 }}>
      <Toggle label={COMPARISON_COPY.title} open={open} onPress={() => setOpen((v) => !v)} />
      {open ? (
        <View style={{ gap: theme.space.s2 }}>
          <ProovraText variant="label" color={theme.color.ink.muted}>{COMPARISON_COPY.boundary}</ProovraText>
          {state.status === "loading" ? <ProovraText variant="label" color={theme.color.ink.muted}>{COMPARISON_COPY.loading}</ProovraText> : null}
          {state.status === "failed" ? <ProovraText variant="label" color={theme.color.ink.muted}>{state.message}</ProovraText> : null}
          {state.status === "ready" ? state.groups.map((g) => <GroupCard key={g.title} group={g} />) : null}
        </View>
      ) : null}
    </View>
  );
}
