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

import { fillOpsCopy, formatOpsCount, opsCopyFor, opsDuration, opsRelativeTime, type OpsCopy } from "../product/ops-copy";
import {
  SEVERITY_VOCABULARY,
  STATUS_VOCABULARY,
  affectedFor,
  categoryLabel,
  conditionTitle,
  formatMetricValue,
  groupQuantity,
  slaLabel,
  slaTone,
  type Incident,
  type IncidentGroup,
  type RowActionKey,
} from "../product/ops-console";
import { useOptionalLocale } from "../locale-context";
import { statusTone, theme } from "../theme/theme";
import { CopyButton } from "./copy-button";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraSupportReference, ProovraText } from "./index";
import { ProovraSheet } from "./patterns";

type Tone = Parameters<typeof statusTone>[0];

/**
 * The row direction for the active locale. Arabic mirrors, as ProovraSection
 * and ProovraListRow do (they read the same locale's isRTL).
 */
export function useOpsRowDirection(): "row" | "row-reverse" {
  return useOptionalLocale() === "ar" ? "row-reverse" : "row";
}

/** The Operations dictionary for the active locale. */
export function useOpsCopy(): { t: OpsCopy; locale: string } {
  const locale = useOptionalLocale();
  return { t: opsCopyFor(locale), locale };
}

/** The minimum touch target (Apple HIG / WCAG 2.5.5): 44pt. */
export const OPS_MIN_HIT = 44;

/** The web's `fill="solid"` severity capsule — the one filled chip a row carries. */
export function OpsSeverityCapsule({ label, tone, a11y }: { label: string; tone: Tone; a11y?: string }) {
  const t = statusTone(tone);
  const { t: words } = useOpsCopy();
  return (
    <View
      accessibilityLabel={a11y ?? fillOpsCopy(words.a11ySeverity, { label })}
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
  const { t: words } = useOpsCopy();
  // The status is a WORD, not a colour: the label carries it for anyone who
  // cannot tell the tones apart, and a reader announces "Status …".
  return (
    <ProovraText variant="label" weight="semibold" color={statusTone(tone).fg} accessibilityLabel={fillOpsCopy(words.a11yStatus, { label })}>
      {label}
    </ProovraText>
  );
}

/** The row's metric phrase (C/IncidentSurface.tsx `Condition` + rowModel metric label). */
export function incidentMetricLabel(i: Incident, t: OpsCopy = opsCopyFor("en"), locale: string | null = null): string | null {
  const m = i.metric;
  if (!m) return null;
  const age = i.metricContract === "AGE_THRESHOLD" && m.unit === "minutes";
  return age
    ? fillOpsCopy(t.metricAge, { age: opsDuration(m.currentValue * 60, t), window: opsDuration(m.thresholdValue * 60, t) })
    : `${fillOpsCopy(t.metricAffected, { n: formatMetricValue(m.currentValue, locale), unit: m.unit })} · ${fillOpsCopy(t.metricThreshold, { n: formatOpsCount(m.thresholdValue, locale) })}`;
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  const dir = useOpsRowDirection();
  return (
    <View style={{ flexDirection: dir, gap: theme.space.s2, alignItems: "flex-start" }}>
      <ProovraText variant="label" color={theme.color.ink.muted} style={{ width: 96 }}>
        {term}
      </ProovraText>
      <View style={{ flex: 1, flexDirection: dir, flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 }}>{children}</View>
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
  selectLabel,
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
  /** The checkbox's accessible name (localised by the caller). */
  selectLabel?: string;
}) {
  const [menu, setMenu] = useState(false);
  const dir = useOpsRowDirection();
  const { t, locale } = useOpsCopy();
  const title = conditionTitle(i, t);
  const sev = { label: t.severity[i.severity].label, tone: SEVERITY_VOCABULARY[i.severity].tone };
  const st = { label: t.status[i.status].label, tone: STATUS_VOCABULARY[i.status].tone };
  const affected = affectedFor(i, t);
  const meta = [
    categoryLabel(i.category, t),
    incidentMetricLabel(i, t, locale),
    i.metric?.stale ? fillOpsCopy(t.lastConfirmed, { at: opsRelativeTime(i.metric.observedAtUtc, t, locale) }) : null,
    affected.label,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <ProovraCard testID={`ops-incident-${i.id}`}>
      <View style={{ gap: theme.space.s2 }}>
        <View style={{ flexDirection: dir, alignItems: "center", gap: theme.space.s2 }}>
          {selectable ? (
            // The TARGET is 44×44pt; the drawn box stays 22pt inside it.
            <Pressable
              onPress={onToggle}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: marked }}
              accessibilityLabel={selectLabel ?? fillOpsCopy(t.selectFor, { title })}
              style={{ minWidth: OPS_MIN_HIT, minHeight: OPS_MIN_HIT, alignItems: "center", justifyContent: "center" }}
              testID={`ops-select-${i.id}`}
            >
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  borderWidth: 2,
                  borderColor: marked ? theme.color.accent.a500 : theme.color.border.strong,
                  backgroundColor: marked ? theme.color.accent.a500 : "transparent",
                }}
              />
            </Pressable>
          ) : null}
          <OpsSeverityCapsule label={sev.label} tone={sev.tone} />
          <View style={{ flex: 1 }} />
          <OpsStatusText label={st.label} tone={st.tone} />
        </View>
        <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={title} style={{ gap: 2 }}>
          <ProovraText variant="body" weight="semibold">
            {title}
          </ProovraText>
          {meta ? (
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {meta}
            </ProovraText>
          ) : null}
        </Pressable>
        <View style={{ gap: 4 }}>
          {owner !== null ? (
            <Fact term={t.factOwner}>
              <ProovraText variant="label">{owner}</ProovraText>
            </Fact>
          ) : null}
          <Fact term={t.factFirstSeen}>
            <ProovraText variant="label">{opsRelativeTime(i.firstSeenAtUtc, t, locale)}</ProovraText>
            {attention && i.sla ? <ProovraBadge label={slaLabel(i.sla.posture, t)} tone={slaTone(i.sla.posture)} /> : null}
          </Fact>
          <Fact term={t.factLatest}>
            <ProovraText variant="label">
              {`${opsRelativeTime(i.lastSeenAtUtc, t, locale)}${
                i.occurrenceCount > 1 ? ` · ${fillOpsCopy(t.observedChecks, { n: formatOpsCount(i.occurrenceCount, locale) })}` : ""
              }`}
            </ProovraText>
          </Fact>
        </View>
        {actions.length > 0 ? (
          <View style={{ alignItems: dir === "row" ? "flex-end" : "flex-start" }}>
            <ProovraButton
              label={pending ? t.rowWorking : t.rowActions}
              accessibilityLabel={fillOpsCopy(t.rowActionsFor, { title })}
              variant="ghost"
              fullWidth={false}
              disabled={pending}
              onPress={() => setMenu(true)}
            />
          </View>
        ) : null}
      </View>
      <ProovraSheet closeLabel={t.close} visible={menu} title={title} onClose={() => setMenu(false)}>
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

/** The group card's accessible name: title, severity, status and counts — not the title alone. */
export function groupCardLabel(g: IncidentGroup, t: OpsCopy = opsCopyFor("en"), locale: string | null = null): string {
  const stKey = (g.statusPosture in STATUS_VOCABULARY ? g.statusPosture : "OPEN") as keyof typeof STATUS_VOCABULARY;
  const conditions = g.conditionCount === 1 ? t.groupConditionOne : fillOpsCopy(t.groupConditionsCount, { n: formatMetricValue(g.conditionCount, locale) });
  return [
    conditionTitle(g, t),
    fillOpsCopy(t.a11ySeverity, { label: t.severity[g.severity].label }),
    fillOpsCopy(t.a11yStatus, { label: t.status[stKey].label }),
    conditions,
    groupQuantity(g, t, locale),
  ]
    .filter((x, n, all) => all.indexOf(x) === n)
    .join(", ");
}

export function OpsGroupCard({ group: g, onOpen }: { group: IncidentGroup; onOpen: () => void }) {
  const dir = useOpsRowDirection();
  const { t, locale } = useOpsCopy();
  const stKey = (g.statusPosture in STATUS_VOCABULARY ? g.statusPosture : "OPEN") as keyof typeof STATUS_VOCABULARY;
  const sev = { label: t.severity[g.severity].label, tone: SEVERITY_VOCABULARY[g.severity].tone };
  const st = { label: t.status[stKey].label, tone: STATUS_VOCABULARY[stKey].tone };
  const meta = [
    categoryLabel(g.category, t),
    groupQuantity(g, t, locale),
    g.metric && g.metric.contract === "AGGREGATE_THRESHOLD" ? fillOpsCopy(t.metricThreshold, { n: formatOpsCount(g.metric.thresholdValue, locale) }) : null,
    g.metric?.stale ? fillOpsCopy(t.lastConfirmed, { at: opsRelativeTime(g.metric.observedAtUtc, t, locale) }) : null,
    g.assignedCount > 0 ? fillOpsCopy(t.groupOwned, { n: formatOpsCount(g.assignedCount, locale) }) : null,
    g.lastSeenAtUtc ? fillOpsCopy(t.groupLastSeen, { at: opsRelativeTime(g.lastSeenAtUtc, t, locale) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <ProovraCard onPress={onOpen} accessibilityLabel={groupCardLabel(g, t, locale)} testID={`ops-group-${g.groupKey}`}>
      <View style={{ gap: theme.space.s2 }}>
        <View style={{ flexDirection: dir, alignItems: "center", gap: theme.space.s2 }}>
          <OpsSeverityCapsule label={sev.label} tone={sev.tone} />
          <View style={{ flex: 1 }} />
          <OpsStatusText label={st.label} tone={st.tone} />
        </View>
        <ProovraText variant="body" weight="semibold">
          {conditionTitle(g, t)}
        </ProovraText>
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {meta}
        </ProovraText>
        {g.failureGroups.length > 1 ? (
          <View style={{ flexDirection: dir, flexWrap: "wrap", gap: theme.space.s2 }}>
            {g.failureGroups.map((f) => (
              <ProovraBadge key={f.label} label={`${formatMetricValue(f.count, locale)} ${f.label.toLowerCase()}`} tone="neutral" />
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
  tone: "warn" | "danger" | "info" | "success";
  title?: string;
  text: string;
  reference?: string | null;
  actions?: ReadonlyArray<{ label: string; onPress: () => void; variant?: "secondary" | "ghost" }>;
  testID?: string;
}) {
  const dir = useOpsRowDirection();
  const t = statusTone(tone === "danger" ? "risk" : tone === "warn" ? "pending" : tone === "success" ? "verified" : "info");
  return (
    <View
      testID={testID}
      accessibilityRole={tone === "info" || tone === "success" ? "text" : "alert"}
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
        <View style={{ flexDirection: dir, flexWrap: "wrap", gap: theme.space.s2 }}>
          {actions.map((a) => (
            <ProovraButton key={a.label} label={a.label} variant={a.variant ?? "secondary"} fullWidth={false} onPress={a.onPress} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** A technical identifier with its own Copy control (C/IncidentInspector.tsx `Identifier`). */
export function OpsIdentifier({ label, value, copyLabel }: { label: string; value: string; copyLabel?: string }) {
  const { t } = useOpsCopy();
  const dir = useOpsRowDirection();
  return (
    <View style={{ flexDirection: dir, alignItems: "center", gap: theme.space.s2, flexWrap: "wrap" }}>
      <ProovraText variant="label" color={theme.color.ink.muted} style={{ width: 72 }}>
        {label}
      </ProovraText>
      <ProovraText variant="label" mono selectable style={{ flex: 1 }}>
        {value}
      </ProovraText>
      <CopyButton
        value={value}
        label={t.copyShort}
        copiedLabel={t.copied}
        failedLabel={t.copyFailed}
        accessibilityLabel={copyLabel ?? `Copy ${label.toLowerCase()}`}
      />
    </View>
  );
}
