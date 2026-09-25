/**
 * OPERATIONS SURFACES — the queue's row, group row, notices and identifiers.
 *
 * Ports of the web's narrow-width renderings, which are the ones a phone
 * should match:
 *   - OpsIncidentCard  ← C/IncidentSurface.tsx `opsw-card` (head: select,
 *                        severity capsule, status text; the condition; facts:
 *                        Owner / First seen / Latest activity; a row menu).
 *   - OpsGroupCard     ← C/GroupSurface.tsx (severity + title, status text,
 *                        one quantity, threshold, staleness, owned, last seen,
 *                        failure classes).
 *   - OpsNotice        ← C/States.tsx DegradedNotice / InlineMutationError /
 *                        the reconciliation notices (an app-alert with an
 *                        optional support reference and actions).
 *   - OpsIdentifier    ← C/IncidentInspector.tsx `Identifier` (value + Copy).
 *
 * The row used to be a ProovraListRow whose subtitle is ONE line, so the
 * second line — first seen, latest activity, owner — never rendered.
 */
import React, { useState } from "react";
import { Pressable, View } from "react-native";

import { describeDuration, describeRelativeTime } from "../lib/relative-time";
import {
  SEVERITY_VOCABULARY,
  STATUS_VOCABULARY,
  affectedFor,
  categoryLabel,
  formatMetricValue,
  groupQuantity,
  slaLabel,
  slaTone,
  type Incident,
  type IncidentGroup,
  type RowActionKey,
} from "../product/ops-console";
import { statusTone, theme } from "../theme/theme";
import { CopyButton } from "./copy-button";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraSupportReference, ProovraText } from "./index";
import { ProovraSheet } from "./patterns";

type Tone = Parameters<typeof statusTone>[0];

/** The web's `fill="solid"` severity capsule — the one filled chip a row carries. */
export function OpsSeverityCapsule({ label, tone }: { label: string; tone: Tone }) {
  const t = statusTone(tone);
  return (
    <View
      accessibilityLabel={`Severity ${label}`}
      style={{ backgroundColor: t.solid, borderRadius: theme.radius.pill, paddingHorizontal: theme.space.s2, paddingVertical: 2 }}
    >
      <ProovraText variant="label" weight="semibold" color={theme.color.surface.card}>
        {label}
      </ProovraText>
    </View>
  );
}

/** AppStatusText: status as coloured text, not a second capsule. */
export function OpsStatusText({ label, tone }: { label: string; tone: Tone }) {
  return (
    <ProovraText variant="label" weight="semibold" color={statusTone(tone).fg}>
      {label}
    </ProovraText>
  );
}

/** The row's metric phrase (C/IncidentSurface.tsx `Condition` + rowModel metric label). */
export function incidentMetricLabel(i: Incident): string | null {
  const m = i.metric;
  if (!m) return null;
  const age = i.metricContract === "AGE_THRESHOLD" && m.unit === "minutes";
  return age
    ? `last sample ${describeDuration(m.currentValue * 60)} ago · window ${describeDuration(m.thresholdValue * 60)}`
    : `${formatMetricValue(m.currentValue)} affected ${m.unit} · threshold ${m.thresholdValue.toLocaleString("en-US")}`;
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", gap: theme.space.s2, alignItems: "flex-start" }}>
      <ProovraText variant="label" color={theme.color.ink.muted} style={{ width: 96 }}>
        {term}
      </ProovraText>
      <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 }}>{children}</View>
    </View>
  );
}

export function OpsIncidentCard({
  incident: i,
  owner,
  attention,
  selectable,
  marked,
  actions,
  pending,
  onToggle,
  onOpen,
  onAction,
}: {
  incident: Incident;
  /** Null when ownership is not an axis in this workspace. */
  owner: string | null;
  attention: boolean;
  selectable: boolean;
  marked: boolean;
  actions: ReadonlyArray<{ key: RowActionKey; label: string; danger?: boolean }>;
  pending: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onAction: (key: RowActionKey) => void;
}) {
  const [menu, setMenu] = useState(false);
  const sev = SEVERITY_VOCABULARY[i.severity];
  const st = STATUS_VOCABULARY[i.status];
  const affected = affectedFor(i);
  const meta = [
    categoryLabel(i.category),
    incidentMetricLabel(i),
    i.metric?.stale ? `last confirmed ${describeRelativeTime(i.metric.observedAtUtc)}` : null,
    affected.label,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <ProovraCard testID={`ops-incident-${i.id}`}>
      <View style={{ gap: theme.space.s2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2 }}>
          {selectable ? (
            <Pressable
              onPress={onToggle}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: marked }}
              accessibilityLabel={`Select ${i.title} for a bulk action`}
              hitSlop={8}
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                borderWidth: 2,
                borderColor: marked ? theme.color.accent.a500 : theme.color.border.strong,
                backgroundColor: marked ? theme.color.accent.a500 : "transparent",
              }}
            />
          ) : null}
          <OpsSeverityCapsule label={sev.label} tone={sev.tone} />
          <View style={{ flex: 1 }} />
          <OpsStatusText label={st.label} tone={st.tone} />
        </View>
        <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={i.title} style={{ gap: 2 }}>
          <ProovraText variant="body" weight="semibold">
            {i.title}
          </ProovraText>
          {meta ? (
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {meta}
            </ProovraText>
          ) : null}
        </Pressable>
        <View style={{ gap: 4 }}>
          {owner !== null ? (
            <Fact term="Owner">
              <ProovraText variant="label">{owner}</ProovraText>
            </Fact>
          ) : null}
          <Fact term="First seen">
            <ProovraText variant="label">{describeRelativeTime(i.firstSeenAtUtc)}</ProovraText>
            {attention && i.sla ? <ProovraBadge label={slaLabel(i.sla.posture)} tone={slaTone(i.sla.posture)} /> : null}
          </Fact>
          <Fact term="Latest activity">
            <ProovraText variant="label">
              {`${describeRelativeTime(i.lastSeenAtUtc)}${
                i.occurrenceCount > 1 ? ` · Observed in ${i.occurrenceCount.toLocaleString("en-US")} checks` : ""
              }`}
            </ProovraText>
          </Fact>
        </View>
        {actions.length > 0 ? (
          <View style={{ alignItems: "flex-end" }}>
            <ProovraButton
              label={pending ? "Working…" : "Actions"}
              accessibilityLabel={`Actions for ${i.title}`}
              variant="ghost"
              fullWidth={false}
              disabled={pending}
              onPress={() => setMenu(true)}
            />
          </View>
        ) : null}
      </View>
      <ProovraSheet visible={menu} title={i.title} onClose={() => setMenu(false)}>
        <View style={{ gap: theme.space.s2 }} testID={`ops-row-menu-${i.id}`}>
          {actions.map((a) => (
            <ProovraButton
              key={a.key}
              label={a.label}
              variant={a.danger ? "danger" : "secondary"}
              onPress={() => {
                setMenu(false);
                onAction(a.key);
              }}
            />
          ))}
        </View>
      </ProovraSheet>
    </ProovraCard>
  );
}

export function OpsGroupCard({ group: g, onOpen }: { group: IncidentGroup; onOpen: () => void }) {
  const sev = SEVERITY_VOCABULARY[g.severity];
  const st = STATUS_VOCABULARY[g.statusPosture as keyof typeof STATUS_VOCABULARY] ?? STATUS_VOCABULARY.OPEN;
  const meta = [
    categoryLabel(g.category),
    groupQuantity(g),
    g.metric && g.metric.contract === "AGGREGATE_THRESHOLD" ? `threshold ${g.metric.thresholdValue.toLocaleString("en-US")}` : null,
    g.metric?.stale ? `last confirmed ${describeRelativeTime(g.metric.observedAtUtc)}` : null,
    g.assignedCount > 0 ? `${g.assignedCount} owned` : null,
    g.lastSeenAtUtc ? `last seen ${describeRelativeTime(g.lastSeenAtUtc)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <ProovraCard onPress={onOpen} accessibilityLabel={g.title} testID={`ops-group-${g.groupKey}`}>
      <View style={{ gap: theme.space.s2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2 }}>
          <OpsSeverityCapsule label={sev.label} tone={sev.tone} />
          <View style={{ flex: 1 }} />
          <OpsStatusText label={st.label} tone={st.tone} />
        </View>
        <ProovraText variant="body" weight="semibold">
          {g.title}
        </ProovraText>
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {meta}
        </ProovraText>
        {g.failureGroups.length > 1 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
            {g.failureGroups.map((f) => (
              <ProovraBadge key={f.label} label={`${formatMetricValue(f.count)} ${f.label.toLowerCase()}`} tone="neutral" />
            ))}
          </View>
        ) : null}
      </View>
    </ProovraCard>
  );
}

/**
 * An app-alert. `warn` for a notice that changes what the numbers mean,
 * `danger` for a failed mutation or a failed run, `info` for in-flight status.
 */
export function OpsNotice({
  tone,
  title,
  text,
  reference,
  actions,
  testID,
}: {
  tone: "warn" | "danger" | "info";
  title?: string;
  text: string;
  reference?: string | null;
  actions?: ReadonlyArray<{ label: string; onPress: () => void; variant?: "secondary" | "ghost" }>;
  testID?: string;
}) {
  const t = statusTone(tone === "danger" ? "risk" : tone === "warn" ? "pending" : "info");
  return (
    <View
      testID={testID}
      accessibilityRole={tone === "info" ? "text" : "alert"}
      style={{
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.bg,
        borderRadius: theme.radius.md,
        padding: theme.space.s3,
        gap: theme.space.s2,
      }}
    >
      {title ? (
        <ProovraText variant="bodySm" weight="semibold" color={t.fg}>
          {title}
        </ProovraText>
      ) : null}
      <ProovraText variant="bodySm" color={t.fg}>
        {text}
      </ProovraText>
      {reference ? <ProovraSupportReference reference={reference} /> : null}
      {actions && actions.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
          {actions.map((a) => (
            <ProovraButton key={a.label} label={a.label} variant={a.variant ?? "secondary"} fullWidth={false} onPress={a.onPress} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** A technical identifier with its own Copy control (C/IncidentInspector.tsx `Identifier`). */
export function OpsIdentifier({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2, flexWrap: "wrap" }}>
      <ProovraText variant="label" color={theme.color.ink.muted} style={{ width: 72 }}>
        {label}
      </ProovraText>
      <ProovraText variant="label" mono selectable style={{ flex: 1 }}>
        {value}
      </ProovraText>
      <CopyButton value={value} accessibilityLabel={`Copy ${label.toLowerCase()}`} />
    </View>
  );
}
