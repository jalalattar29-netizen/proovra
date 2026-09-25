/**
 * TRUST CENTER LIVE PANELS (T-15) — see src/product/trust-live.ts.
 * Touch adaptations: the web tables become stacked rows; vendor documentation
 * opens in the system browser; change history expands inline per vendor.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Linking, View } from "react-native";
import type { StatusIncidentProjection, StatusPageProjection, SubprocessorProjection } from "@proovra/shared";

import { apiFetch } from "../api";
import { formatUserDate, formatUserDateTime } from "../lib/date";
import { theme } from "../theme/theme";
import { isEntitlementDenial } from "../product/trust-center";
import {
  TRUST_LIVE_COPY as COPY,
  TRUST_STATUS_PATH,
  TRUST_SUBPROCESSORS_PATH,
  buildSubprocessorVersionsPath,
  identifierLabel,
  parseSubprocessorRegistry,
  parseSubprocessorVersions,
  parseTrustStatus,
  subprocessorDegradedMessage,
  type LiveRead,
  type SubprocessorVersion,
} from "../product/trust-live";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraText } from "./index";

type Load<T> = { phase: "loading" } | LiveRead<T> | { phase: "failed" } | { phase: "locked" };

function healthTone(h: string): "verified" | "pending" | "risk" | "neutral" {
  const u = h.toUpperCase();
  if (u === "OPERATIONAL" || u === "HEALTHY") return "verified";
  if (u === "DEGRADED" || u === "PARTIAL_OUTAGE" || u === "MAINTENANCE") return "pending";
  if (u === "MAJOR_OUTAGE" || u === "OUTAGE" || u === "DOWN") return "risk";
  return "neutral";
}

function Incidents({ items }: { items: ReadonlyArray<StatusIncidentProjection> }) {
  if (items.length === 0) return <ProovraText variant="label" color={theme.color.ink.muted}>None.</ProovraText>;
  return (
    <>
      {items.map((i) => (
        <View key={i.id} style={{ gap: 2, paddingVertical: theme.space.s1 }}>
          <ProovraText variant="bodySm" weight="semibold">{i.title}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted}>{`${i.severity} · ${i.state}`}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {`Components: ${i.componentKeys.join(", ")} · Started ${formatUserDateTime(i.startedAtUtc)}${i.resolvedAtUtc ? ` · Resolved ${formatUserDateTime(i.resolvedAtUtc)}` : ""}`}
          </ProovraText>
          {i.updates.map((u) => (
            <ProovraText key={u.id} variant="label" color={theme.color.ink.secondary}>
              {`• ${u.state} · ${formatUserDateTime(u.createdAtUtc)} — ${u.body}`}
            </ProovraText>
          ))}
          {i.postmortemUrl ? (
            <ProovraButton label="Postmortem" variant="ghost" fullWidth={false} onPress={() => void Linking.openURL(i.postmortemUrl as string)} />
          ) : null}
        </View>
      ))}
    </>
  );
}

export function TrustStatusPanel() {
  const [state, setState] = useState<Load<StatusPageProjection>>({ phase: "loading" });
  const refresh = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      setState(parseTrustStatus(await apiFetch(TRUST_STATUS_PATH)));
    } catch (err) {
      setState(isEntitlementDenial(err) ? { phase: "locked" } : { phase: "failed" });
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshBtn = (label: string) => (
    <ProovraButton label={label} variant="secondary" fullWidth={false} disabled={state.phase === "loading"} onPress={() => void refresh()} />
  );

  return (
    <ProovraCard>
      <View style={{ gap: theme.space.s3 }} testID="trust-status-live">
        {state.phase === "loading" ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>Loading status…</ProovraText>
        ) : state.phase === "locked" ? (
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>Not included in your plan.</ProovraText>
        ) : state.phase === "failed" ? (
          <>
            <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{COPY.statusFailed}</ProovraText>
            {refreshBtn("Retry")}
          </>
        ) : state.phase === "degraded" ? (
          <>
            <ProovraText variant="bodySm" weight="semibold" color={theme.color.status.pending.fg}>{COPY.statusDegraded}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.secondary}>{state.reason}</ProovraText>
            {refreshBtn("Retry")}
          </>
        ) : state.phase === "empty" ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>{COPY.statusEmpty}</ProovraText>
        ) : (
          (() => {
            const st = state.value;
            return (
              <>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {`Operational health across PROOVRA components. Upstream: ${st.upstreamProvider}.`}
                </ProovraText>
                <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2 }}>
                  <ProovraText variant="bodySm" weight="semibold">Overall health:</ProovraText>
                  <ProovraBadge tone={healthTone(st.overallHealth)} label={st.overallHealth} />
                </View>
                <ProovraText variant="bodySm" weight="semibold">Components</ProovraText>
                {st.components.map((c) => (
                  <View key={c.key} style={{ gap: 2 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2 }}>
                      <ProovraText variant="bodySm">{c.label}</ProovraText>
                      <ProovraBadge tone={healthTone(c.health)} label={c.health} />
                    </View>
                    <ProovraText variant="label" color={theme.color.ink.muted}>
                      {`${c.description} · Source ${c.upstreamSource} · Updated ${formatUserDateTime(c.lastUpdatedUtc)}`}
                    </ProovraText>
                  </View>
                ))}
                <ProovraText variant="bodySm" weight="semibold">{`Active incidents · ${st.activeIncidents.length}`}</ProovraText>
                <Incidents items={st.activeIncidents} />
                <ProovraText variant="bodySm" weight="semibold">{`Resolved incidents · ${st.recentIncidents.length}`}</ProovraText>
                <Incidents items={st.recentIncidents} />
                <ProovraText variant="bodySm" weight="semibold">{`Maintenance windows · ${st.maintenanceWindows.length}`}</ProovraText>
                {st.maintenanceWindows.length === 0 ? (
                  <ProovraText variant="label" color={theme.color.ink.muted}>None scheduled.</ProovraText>
                ) : (
                  st.maintenanceWindows.map((w) => (
                    <ProovraText key={w.id} variant="label" color={theme.color.ink.secondary}>
                      {`${w.title} · ${w.componentKeys.join(", ")} · ${formatUserDateTime(w.startsAtUtc)} – ${formatUserDateTime(w.endsAtUtc)} · ${w.state}`}
                    </ProovraText>
                  ))
                )}
                {st.limitations.length > 0 ? (
                  <>
                    <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Limitations</ProovraText>
                    {st.limitations.map((l) => (
                      <ProovraText key={l} variant="label" color={theme.color.ink.muted}>{`• ${l}`}</ProovraText>
                    ))}
                  </>
                ) : null}
                {refreshBtn("Refresh")}
              </>
            );
          })()
        )}
      </View>
    </ProovraCard>
  );
}

function SubprocessorHistory({ id, name }: { id: string; name: string }) {
  const [rows, setRows] = useState<SubprocessorVersion[] | null | "failed">(null);
  const load = useCallback(async () => {
    setRows(null);
    try {
      setRows(parseSubprocessorVersions(await apiFetch(buildSubprocessorVersionsPath(id))));
    } catch {
      setRows("failed");
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  if (rows === null) return <ProovraText variant="label" color={theme.color.ink.muted}>Loading change history…</ProovraText>;
  if (rows === "failed") {
    return (
      <>
        <ProovraText variant="label" color={theme.color.status.risk.fg}>{COPY.historyFailed}</ProovraText>
        <ProovraButton label="Retry change history" variant="ghost" fullWidth={false} onPress={() => void load()} />
      </>
    );
  }
  if (rows.length === 0) return <ProovraText variant="label" color={theme.color.ink.muted}>{`No change history is recorded for ${name}.`}</ProovraText>;
  return (
    <>
      {rows.map((v) => (
        <View key={v.id} style={{ gap: 2 }}>
          <ProovraText variant="label" weight="semibold">
            {`Version ${v.version}${v.state ? ` · ${identifierLabel(v.state)}` : ""}${v.effectiveAt ? ` · Effective ${formatUserDate(v.effectiveAt)}` : ""}`}
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>{v.summary}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {`${v.region ? `Region: ${v.region}` : "Region not recorded"} · Data categories: ${v.dataCategories.length ? v.dataCategories.map(identifierLabel).join(", ") : "not recorded"}`}
          </ProovraText>
        </View>
      ))}
    </>
  );
}

export function SubprocessorRegistry() {
  const [state, setState] = useState<Load<SubprocessorProjection[]>>({ phase: "loading" });
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      setState(parseSubprocessorRegistry(await apiFetch(TRUST_SUBPROCESSORS_PATH)));
    } catch (err) {
      setState(isEntitlementDenial(err) ? { phase: "locked" } : { phase: "failed" });
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <ProovraCard>
      <View style={{ gap: theme.space.s3 }} testID="subprocessor-registry">
        {state.phase === "loading" ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>Loading subprocessors…</ProovraText>
        ) : state.phase === "locked" ? (
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>Not included in your plan.</ProovraText>
        ) : state.phase === "failed" ? (
          <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{COPY.subprocessorsFailed}</ProovraText>
        ) : state.phase === "degraded" ? (
          <ProovraText variant="bodySm" color={theme.color.status.pending.fg}>{subprocessorDegradedMessage(state.reason)}</ProovraText>
        ) : state.phase === "empty" ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>{COPY.subprocessorsEmpty}</ProovraText>
        ) : (
          state.value.map((r) => (
            <View key={r.id} style={{ gap: 2, paddingVertical: theme.space.s1 }} testID={`subprocessor-${r.slug}`}>
              <ProovraText variant="bodySm" weight="semibold">{r.name}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>{`${r.vendor} · ${r.purpose}`}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {`Region ${r.region} · ${identifierLabel(r.state)} · v${r.version} · Effective ${formatUserDate(r.effectiveAtUtc)}`}
              </ProovraText>
              {r.dataCategories.length ? (
                <ProovraText variant="label" color={theme.color.ink.muted}>{`Data categories: ${r.dataCategories.map(identifierLabel).join(", ")}`}</ProovraText>
              ) : null}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
                {r.documentationUrl ? (
                  <ProovraButton label="Vendor documentation" variant="ghost" fullWidth={false} onPress={() => void Linking.openURL(r.documentationUrl as string)} />
                ) : null}
                <ProovraButton
                  label={historyFor === r.id ? "Hide history" : "History"}
                  accessibilityLabel={`Change history for ${r.name}`}
                  variant="ghost"
                  fullWidth={false}
                  onPress={() => setHistoryFor(historyFor === r.id ? null : r.id)}
                />
              </View>
              {historyFor === r.id ? <SubprocessorHistory id={r.id} name={r.name} /> : null}
            </View>
          ))
        )}
        <ProovraButton label="Refresh" variant="secondary" fullWidth={false} disabled={state.phase === "loading"} onPress={() => void refresh()} />
      </View>
    </ProovraCard>
  );
}
