/**
 * WORKSPACE HEALTH (T-11 / RC-12) — the native port of
 * `apps/web/app/(app)/operations/health/page.tsx`. Decisions and copy live in
 * `src/product/ops-health.ts`.
 *
 * The two panels fail independently, exactly as on the web: a failed posture
 * read never makes the list look empty, and a failed list never makes the
 * workspace look healthy.
 *
 * ONE WORKSPACE, ONE SCREEN STATE (D5). The screen is keyed on the active
 * workspace, so a switch remounts it from nothing; every read also carries a
 * sequence number, and an answer for an earlier workspace or an earlier poll
 * is dropped rather than painted over the current one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../../../src/api";
import { toSafeUserError } from "../../../src/errors/safe-error";
import { useOptionalLocale } from "../../../src/locale-context";
import { usePlatformContext } from "../../../src/product/platform-context";
import { canViewWorkspaceHealth, categoryLabel, conditionSummary, conditionTitle } from "../../../src/product/ops-console";
import { fillOpsCopy, formatOpsCount, formatOpsDateTime, opsCopyFor } from "../../../src/product/ops-copy";
import {
  ALERTS_CAP,
  HEALTH_POLL_MS,
  SEVERITY_ORDER,
  STATE_TONE,
  buildWorkspaceAlertsPath,
  buildWorkspaceHealthPath,
  healthCopyFor,
  healthSeverityTone,
  healthStateReason,
  parseAlerts,
  parseHealth,
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
import { useOpsRowDirection } from "../../../src/ui/ops-surfaces";

type Panel<T> =
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "unavailable"; message: string; atUtc: string };

export default function WorkspaceHealthScreen() {
  const { context } = usePlatformContext();
  // D5 — a workspace switch remounts the screen: no panel of the previous
  // workspace survives into the next one.
  return <WorkspaceHealthBody key={context?.activeTeamId ?? "no-workspace"} />;
}

function WorkspaceHealthBody() {
  const router = useRouter();
  const locale = useOptionalLocale();
  const hc = healthCopyFor(locale);
  const t = opsCopyFor(locale);
  const when = (iso: string | null | undefined) => formatOpsDateTime(iso, locale);
  const rowDir = useOpsRowDirection();
  const { context, loading, envelope } = usePlatformContext();
  // PageRouteGate "workspace.operations_health": WORKSPACE_HEALTH_VIEW or nothing is read.
  const permitted = canViewWorkspaceHealth(envelope);
  const workspaceId = permitted ? (context?.activeTeamId ?? null) : null;
  const name = context?.displayName ?? t.thisWorkspace;

  const [posture, setPosture] = useState<Panel<HealthPosture>>({ kind: "loading" });
  const [alerts, setAlerts] = useState<Panel<{ items: HealthAlert[]; evaluatedAtUtc: string; capped: boolean; total: number | null }>>({
    kind: "loading",
  });
  const [token, setToken] = useState(0);
  // The workspace + sequence the latest read was asked for.
  const current = useRef<{ workspaceId: string | null; seq: number }>({ workspaceId, seq: 0 });

  const tick = useCallback(async (id: string) => {
    const seq = (current.current.seq += 1);
    current.current.workspaceId = id;
    const fresh = () => current.current.workspaceId === id && current.current.seq === seq;
    // Each read settles on its own; one failing never blanks the other.
    await Promise.all([
      apiFetch(buildWorkspaceHealthPath(id))
        .then((d) => fresh() && setPosture({ kind: "ready", value: parseHealth(d) }))
        .catch(
          (err) =>
            fresh() &&
            setPosture({ kind: "unavailable", message: toSafeUserError(err).message || t.healthPostureFallback, atUtc: new Date().toISOString() }),
        ),
      apiFetch(buildWorkspaceAlertsPath(id))
        .then((d) => fresh() && setAlerts({ kind: "ready", value: parseAlerts(d) }))
        .catch(
          (err) =>
            fresh() &&
            setAlerts({ kind: "unavailable", message: toSafeUserError(err).message || t.healthListFallback, atUtc: new Date().toISOString() }),
        ),
    ]);
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    // A new workspace (or Refresh) starts from "loading", never from the
    // previous answer.
    setPosture({ kind: "loading" });
    setAlerts({ kind: "loading" });
    void tick(workspaceId);
    const timer = setInterval(() => void tick(workspaceId), HEALTH_POLL_MS);
    return () => {
      clearInterval(timer);
      // Invalidate whatever is in flight for this workspace.
      current.current.seq += 1;
    };
  }, [workspaceId, tick, token]);

  if (!loading && !permitted) {
    return (
      <ProovraScreen shell testID="workspace-health">
        <ProovraPageHeader title={t.healthTitle} eyebrow={t.healthEyebrow} />
        <ProovraEmpty title={t.healthDeniedTitle} purpose={t.healthDeniedBody} />
      </ProovraScreen>
    );
  }

  if (!loading && !workspaceId) {
    return (
      <ProovraScreen shell testID="workspace-health">
        <ProovraPageHeader title={t.healthTitle} eyebrow={t.healthEyebrow} />
        <ProovraEmpty title={t.healthTitle} purpose={t.healthNoWorkspace} />
      </ProovraScreen>
    );
  }

  const count = (n: number | null) => (n === null ? "—" : formatOpsCount(n, locale));

  return (
    <ProovraScreen shell testID="workspace-health">
      <ProovraPageHeader
        eyebrow={t.healthEyebrow}
        title={t.healthTitle}
        subtitle={fillOpsCopy(t.healthSubtitle, { name })}
        contextStrip={<ProovraBadge label={t.healthScope} tone="info" />}
        primaryAction={<ProovraButton label={t.healthRefresh} variant="secondary" fullWidth={false} onPress={() => setToken((n) => n + 1)} />}
      />

      <ProovraSection title={t.healthPostureTitle} heading>
        <ProovraCard>
          {posture.kind === "loading" ? <ProovraText variant="bodySm">{t.healthEvaluating}</ProovraText> : null}
          {posture.kind === "unavailable" ? (
            <View style={{ gap: theme.space.s2 }} accessibilityRole="alert">
              <ProovraBadge label={hc.word.UNKNOWN} tone={STATE_TONE.UNKNOWN} />
              <ProovraText variant="bodySm">{fillOpsCopy(t.healthPostureUnavailable, { message: posture.message, at: when(posture.atUtc) })}</ProovraText>
            </View>
          ) : null}
          {posture.kind === "ready" ? (
            <View style={{ gap: theme.space.s3 }} testID={`workspace-health-state-${posture.value.state}`}>
              <View style={{ flexDirection: rowDir, alignItems: "center", gap: theme.space.s2, flexWrap: "wrap" }}>
                <ProovraBadge label={hc.word[posture.value.state]} tone={STATE_TONE[posture.value.state]} />
                <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                  {healthStateReason(hc, posture.value.state, posture.value.unknownReason)}
                </ProovraText>
              </View>
              <ProovraDetailRows
                rows={[
                  // The counts say WHICH set they are: unresolved (open,
                  // acknowledged or suppressed), and of those, not yet acknowledged.
                  { label: hc.unresolvedLabel, value: count(posture.value.unresolved) },
                  ...(posture.value.untriaged !== null ? [{ label: hc.untriagedLabel, value: count(posture.value.untriaged) }] : []),
                  {
                    label: hc.lastActivity,
                    value: posture.value.lastActivityUtc ? when(posture.value.lastActivityUtc) : t.healthNoActivity,
                  },
                  { label: hc.evaluated, value: when(posture.value.evaluatedAtUtc) },
                ]}
              />
              <View style={{ flexDirection: rowDir, flexWrap: "wrap", gap: theme.space.s2 }}>
                {SEVERITY_ORDER.filter((s) => (posture.value.bySeverity[s] ?? 0) > 0).map((s) => (
                  <ProovraBadge
                    key={s}
                    label={fillOpsCopy(hc.bySeverityOpen, { severity: t.severity[s].label, n: count(posture.value.bySeverity[s] ?? 0) })}
                    tone={healthSeverityTone(s)}
                  />
                ))}
              </View>
            </View>
          ) : null}
        </ProovraCard>
      </ProovraSection>

      <ProovraSection title={t.healthListTitle} heading>
        <ProovraButton label={t.healthOpenQueue} variant="ghost" fullWidth={false} onPress={() => router.push("/operations")} />
        {alerts.kind === "loading" ? <ProovraText variant="bodySm">{t.healthListLoading}</ProovraText> : null}
        {alerts.kind === "unavailable" ? (
          <View style={{ gap: theme.space.s2 }} accessibilityRole="alert">
            <ProovraBadge label={hc.word.UNKNOWN} tone={STATE_TONE.UNKNOWN} />
            <ProovraText variant="bodySm">{fillOpsCopy(t.healthListUnavailable, { message: alerts.message, at: when(alerts.atUtc) })}</ProovraText>
          </View>
        ) : null}
        {alerts.kind === "ready" && alerts.value.items.length === 0 ? (
          <ProovraText variant="bodySm">{fillOpsCopy(t.healthListEmpty, { at: when(alerts.value.evaluatedAtUtc) })}</ProovraText>
        ) : null}
        {alerts.kind === "ready" && alerts.value.items.length > 0 ? (
          <ProovraCard>
            {alerts.value.items.map((a) => (
              <ProovraListRow
                key={a.id}
                title={conditionTitle(a, t)}
                subtitle={[
                  conditionSummary(a, t) || null,
                  categoryLabel(a.category, t),
                  fillOpsCopy(t.healthAlertTimes, { first: when(a.firstSeenAtUtc), last: when(a.lastSeenAtUtc), n: count(a.occurrenceCount) }),
                ]
                  .filter(Boolean)
                  .join("\n")}
                trailing={<ProovraBadge label={t.severity[a.severity].label} tone={healthSeverityTone(a.severity)} />}
              />
            ))}
          </ProovraCard>
        ) : null}
        {alerts.kind === "ready" && alerts.value.capped ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {`${fillOpsCopy(t.healthCapped, { n: count(ALERTS_CAP) })}${alerts.value.total !== null ? ` ${fillOpsCopy(t.healthCappedTotal, { n: count(alerts.value.total) })}` : ""}`}
          </ProovraText>
        ) : null}
      </ProovraSection>

      <ProovraText variant="label" color={theme.color.ink.muted}>
        {t.healthFootnote}
      </ProovraText>
    </ProovraScreen>
  );
}
