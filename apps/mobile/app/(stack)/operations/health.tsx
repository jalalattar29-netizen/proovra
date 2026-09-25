/**
 * WORKSPACE HEALTH (T-11 / RC-12) — the native port of
 * `apps/web/app/(app)/operations/health/page.tsx`. Decisions and copy live in
 * `src/product/ops-health.ts`.
 *
 * The two panels fail independently, exactly as on the web: a failed posture
 * read never makes the list look empty, and a failed list never makes the
 * workspace look healthy.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../../../src/api";
import { toSafeUserError } from "../../../src/errors/safe-error";
import { formatUserTime } from "../../../src/lib/date";
import { usePlatformContext } from "../../../src/product/platform-context";
import { SEVERITY_VOCABULARY, canViewWorkspaceHealth } from "../../../src/product/ops-console";
import {
  HEALTH_COPY,
  HEALTH_POLL_MS,
  SEVERITY_ORDER,
  STATE_TONE,
  STATE_WORD,
  buildWorkspaceAlertsPath,
  buildWorkspaceHealthPath,
  healthSeverityTone,
  parseAlerts,
  parseHealth,
  stateReason,
  type HealthAlert,
  type HealthPosture,
} from "../../../src/product/ops-health";
import { theme } from "../../../src/theme/theme";
import {
  ProovraBadge,
  ProovraButton,
  ProovraCard,
  ProovraDetailRows,
  ProovraEmpty,
  ProovraListRow,
  ProovraPageHeader,
  ProovraScreen,
  ProovraSection,
  ProovraText,
} from "../../../src/ui";

type Panel<T> =
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "unavailable"; message: string; atUtc: string };

export default function WorkspaceHealthScreen() {
  const router = useRouter();
  const { context, loading, envelope } = usePlatformContext();
  // PageRouteGate "workspace.operations_health": WORKSPACE_HEALTH_VIEW or nothing is read.
  const permitted = canViewWorkspaceHealth(envelope);
  const workspaceId = permitted ? (context?.activeTeamId ?? null) : null;
  const name = context?.displayName ?? "this workspace";

  const [posture, setPosture] = useState<Panel<HealthPosture>>({ kind: "loading" });
  const [alerts, setAlerts] = useState<Panel<{ items: HealthAlert[]; evaluatedAtUtc: string; capped: boolean }>>({ kind: "loading" });
  const [token, setToken] = useState(0);

  const tick = useCallback(async (id: string) => {
    // Each read settles on its own; one failing never blanks the other.
    await Promise.all([
      apiFetch(buildWorkspaceHealthPath(id))
        .then((d) => setPosture({ kind: "ready", value: parseHealth(d) }))
        .catch((err) =>
          setPosture({ kind: "unavailable", message: toSafeUserError(err).message || HEALTH_COPY.postureFallback, atUtc: new Date().toISOString() }),
        ),
      apiFetch(buildWorkspaceAlertsPath(id))
        .then((d) => setAlerts({ kind: "ready", value: parseAlerts(d) }))
        .catch((err) =>
          setAlerts({ kind: "unavailable", message: toSafeUserError(err).message || HEALTH_COPY.listFallback, atUtc: new Date().toISOString() }),
        ),
    ]);
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    void tick(workspaceId);
    const timer = setInterval(() => void tick(workspaceId), HEALTH_POLL_MS);
    return () => clearInterval(timer);
  }, [workspaceId, tick, token]);

  if (!loading && !permitted) {
    return (
      <ProovraScreen shell testID="workspace-health">
        <ProovraPageHeader title={HEALTH_COPY.title} eyebrow="Operations" />
        <ProovraEmpty title={HEALTH_COPY.deniedTitle} purpose={HEALTH_COPY.deniedBody} />
      </ProovraScreen>
    );
  }

  if (!loading && !workspaceId) {
    return (
      <ProovraScreen shell testID="workspace-health">
        <ProovraPageHeader title={HEALTH_COPY.title} eyebrow="Operations" />
        <ProovraEmpty title={HEALTH_COPY.title} purpose={HEALTH_COPY.noWorkspace} />
      </ProovraScreen>
    );
  }

  return (
    <ProovraScreen shell testID="workspace-health">
      <ProovraPageHeader
        eyebrow="Operations"
        title={HEALTH_COPY.title}
        subtitle={HEALTH_COPY.subtitle(name)}
        contextStrip={<ProovraBadge label={HEALTH_COPY.scope} tone="info" />}
        primaryAction={<ProovraButton label="Refresh" variant="secondary" fullWidth={false} onPress={() => setToken((n) => n + 1)} />}
      />

      <ProovraSection title={HEALTH_COPY.postureTitle}>
        <ProovraCard>
          {posture.kind === "loading" ? <ProovraText variant="bodySm">{HEALTH_COPY.evaluating}</ProovraText> : null}
          {posture.kind === "unavailable" ? (
            <View style={{ gap: theme.space.s2 }} accessibilityRole="alert">
              <ProovraBadge label={STATE_WORD.UNKNOWN} tone={STATE_TONE.UNKNOWN} />
              <ProovraText variant="bodySm">{HEALTH_COPY.postureUnavailable(posture.message, formatUserTime(posture.atUtc))}</ProovraText>
            </View>
          ) : null}
          {posture.kind === "ready" ? (
            <View style={{ gap: theme.space.s3 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2, flexWrap: "wrap" }}>
                <ProovraBadge label={STATE_WORD[posture.value.state]} tone={STATE_TONE[posture.value.state]} />
                <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                  {stateReason(posture.value.state)}
                </ProovraText>
              </View>
              <ProovraDetailRows
                rows={[
                  { label: "Open conditions", value: String(posture.value.openTotal) },
                  { label: "Open or acknowledged", value: String(posture.value.unresolved) },
                  {
                    label: "Last condition activity",
                    value: posture.value.lastActivityUtc ? formatUserTime(posture.value.lastActivityUtc) : HEALTH_COPY.noActivity,
                  },
                  { label: "Evaluated", value: formatUserTime(posture.value.evaluatedAtUtc) },
                ]}
              />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
                {SEVERITY_ORDER.filter((s) => (posture.value.bySeverity[s] ?? 0) > 0).map((s) => (
                  <ProovraBadge key={s} label={`${SEVERITY_VOCABULARY[s].label} · ${posture.value.bySeverity[s]} open`} tone={healthSeverityTone(s)} />
                ))}
              </View>
            </View>
          ) : null}
        </ProovraCard>
      </ProovraSection>

      <ProovraSection title={HEALTH_COPY.listTitle}>
        <ProovraButton label={HEALTH_COPY.openQueue} variant="ghost" fullWidth={false} onPress={() => router.push("/operations")} />
        {alerts.kind === "loading" ? <ProovraText variant="bodySm">{HEALTH_COPY.listLoading}</ProovraText> : null}
        {alerts.kind === "unavailable" ? (
          <View style={{ gap: theme.space.s2 }} accessibilityRole="alert">
            <ProovraBadge label={STATE_WORD.UNKNOWN} tone={STATE_TONE.UNKNOWN} />
            <ProovraText variant="bodySm">{HEALTH_COPY.listUnavailable(alerts.message, formatUserTime(alerts.atUtc))}</ProovraText>
          </View>
        ) : null}
        {alerts.kind === "ready" && alerts.value.items.length === 0 ? (
          <ProovraText variant="bodySm">{HEALTH_COPY.listEmpty(formatUserTime(alerts.value.evaluatedAtUtc))}</ProovraText>
        ) : null}
        {alerts.kind === "ready" && alerts.value.items.length > 0 ? (
          <ProovraCard>
            {alerts.value.items.map((a) => (
              <ProovraListRow
                key={a.id}
                title={a.title}
                subtitle={[
                  a.safeSummary,
                  a.categoryLabel,
                  `First seen ${formatUserTime(a.firstSeenAtUtc)} · Last seen ${formatUserTime(a.lastSeenAtUtc)} · ${a.occurrenceCount} ${a.occurrenceCount === 1 ? "occurrence" : "occurrences"}`,
                ]
                  .filter(Boolean)
                  .join("\n")}
                trailing={<ProovraBadge label={SEVERITY_VOCABULARY[a.severity].label} tone={healthSeverityTone(a.severity)} />}
              />
            ))}
          </ProovraCard>
        ) : null}
        {alerts.kind === "ready" && alerts.value.capped ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {HEALTH_COPY.capped}
          </ProovraText>
        ) : null}
      </ProovraSection>

      <ProovraText variant="label" color={theme.color.ink.muted}>
        {HEALTH_COPY.footnote}
      </ProovraText>
    </ProovraScreen>
  );
}
