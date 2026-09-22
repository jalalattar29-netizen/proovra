/**
 * NOTIFICATION PREFERENCES — the native port of
 * `apps/web/components/notifications/NotificationPreferencesPanel.tsx`.
 *
 * Canonical sources: `GET/PUT /v1/me/notification-preferences` and
 * `GET/PUT /v1/me/notification-schedule`, both scoped to the ACTIVE workspace.
 *
 * Two things this screen refuses to do:
 *   - render a locked category as a free toggle. The lock is the platform's
 *     in-app floor or the organization's policy, it is enforced server-side,
 *     and a switch that flips back after a 403 is worse than one that is
 *     visibly unavailable;
 *   - render a category with no stored row as "off". The endpoint publishes
 *     the defaults that the absence of a row implies, and those are what the
 *     user is actually receiving.
 *
 * Contact-channel verification is deliberately absent — see the note in
 * `src/product/notification-preferences.ts`.
 */
import { useCallback, useEffect, useState } from "react";
import { Switch, View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../../../src/api";
import { usePlatformContext } from "../../../src/product/platform-context";
import { useToast } from "../../../src/toast-context";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraPageHeader,
  ProovraPageSection,
  ProovraLoadingState,
  ProovraErrorState,
  ProovraEmpty,
} from "../../../src/ui";
import {
  PREFERENCES_WRITE_PATH,
  SCHEDULE_WRITE_PATH,
  allowedFrequencies,
  buildPreferenceUpdate,
  buildPreferencesPath,
  buildScheduleUpdate,
  buildSchedulePath,
  channelLabel,
  describeQuietWindow,
  frequencyLabel,
  isPolicyLocked,
  isScheduleUnavailable,
  parsePreferences,
  parseSchedule,
  type NotificationSchedule,
  type PreferencesView,
} from "../../../src/product/notification-preferences";

type State =
  | { phase: "loading" }
  | { phase: "loaded"; view: PreferencesView }
  | { phase: "failed" };

type ScheduleState =
  | { phase: "loading" }
  | { phase: "loaded"; schedule: NotificationSchedule }
  | { phase: "unavailable" }
  | { phase: "failed" };

export default function NotificationPreferencesScreen() {
  const router = useRouter();
  const { addToast } = useToast();
  const { context } = usePlatformContext();
  const teamId = context?.activeTeamId ?? null;

  const [state, setState] = useState<State>({ phase: "loading" });
  const [schedule, setSchedule] = useState<ScheduleState>({ phase: "loading" });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    setState({ phase: "loading" });
    setSchedule({ phase: "loading" });

    await Promise.all([
      apiFetch(buildPreferencesPath(teamId))
        .then((d) => setState({ phase: "loaded", view: parsePreferences(d) }))
        .catch(() => setState({ phase: "failed" })),
      apiFetch(buildSchedulePath(teamId))
        .then((d) => {
          const s = parseSchedule(d);
          setSchedule(s ? { phase: "loaded", schedule: s } : { phase: "unavailable" });
        })
        .catch((err) =>
          setSchedule(isScheduleUnavailable(err) ? { phase: "unavailable" } : { phase: "failed" }),
        ),
    ]);
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (type: string, channel: string, next: boolean, frequency: string) => {
      if (!teamId) return;
      const key = `${type}:${channel}`;
      setBusy(key);
      try {
        await apiFetch(PREFERENCES_WRITE_PATH, {
          method: "PUT",
          body: JSON.stringify(
            buildPreferenceUpdate({
              teamId,
              preferenceType: type,
              channel,
              enabled: next,
              frequency,
            }),
          ),
        });
        await load();
      } catch (err) {
        // A policy 403 is the organization or the platform floor answering,
        // not a failure to say sorry for.
        addToast(
          isPolicyLocked(err)
            ? "This category is managed for your workspace and cannot be changed."
            : "That preference could not be saved.",
          isPolicyLocked(err) ? "info" : "error",
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, load, addToast],
  );

  const setFrequency = useCallback(
    async (type: string, frequency: string, enabled: boolean) => {
      await toggle(type, "EMAIL", enabled, frequency);
    },
    [toggle],
  );

  const saveSchedule = useCallback(
    async (next: NotificationSchedule) => {
      if (!teamId) return;
      setBusy("schedule");
      setSchedule({ phase: "loaded", schedule: next });
      try {
        await apiFetch(SCHEDULE_WRITE_PATH, {
          method: "PUT",
          body: JSON.stringify(buildScheduleUpdate(teamId, next)),
        });
      } catch (err) {
        setSchedule(isScheduleUnavailable(err) ? { phase: "unavailable" } : { phase: "failed" });
        addToast("Quiet hours could not be saved.", "error");
      } finally {
        setBusy(null);
      }
    },
    [teamId, addToast],
  );

  return (
    <ProovraScreen testID="settings-notifications">
      <ProovraPageHeader
        title="Notifications"
        eyebrow="Settings"
        subtitle="Which notifications reach you, in the app and by email."
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

      {!teamId ? <ProovraLoadingState label="Resolving workspace" /> : null}

      {teamId && state.phase === "loading" ? (
        <ProovraLoadingState label="Loading preferences" />
      ) : null}

      {teamId && state.phase === "failed" ? (
        <ProovraErrorState message="Preferences could not be loaded." onRetry={() => void load()} />
      ) : null}

      {state.phase === "loaded" && state.view.rows.length === 0 ? (
        <ProovraEmpty presence="page" title="No notification categories are published." />
      ) : null}

      {state.phase === "loaded" && state.view.rows.length > 0
        ? state.view.rows.map((row) => (
            <ProovraPageSection key={row.type} title={row.label}>
              <ProovraCard>
                <View style={{ gap: theme.space.s3 }}>
                  {row.cells.map((cell) => (
                    <View key={cell.channel} style={{ gap: theme.space.s2 }}>
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: theme.space.s2,
                        }}
                      >
                        <View style={{ flex: 1 }}>
                          <ProovraText variant="body">{channelLabel(cell.channel)}</ProovraText>
                          {cell.locked ? (
                            <ProovraText variant="label" color={theme.color.ink.muted}>
                              {state.view.isPersonalWorkspace
                                ? "Always on — critical alerts cannot be turned off."
                                : "Managed by your organization."}
                            </ProovraText>
                          ) : null}
                        </View>

                        {cell.locked ? (
                          <ProovraBadge label="Always on" tone="governance" />
                        ) : (
                          <Switch
                            value={cell.enabled}
                            disabled={busy === `${row.type}:${cell.channel}`}
                            accessibilityLabel={`${row.label}, ${channelLabel(cell.channel)}`}
                            onValueChange={(next) =>
                              void toggle(row.type, cell.channel, next, cell.frequency)
                            }
                          />
                        )}
                      </View>

                      {/*
                        Cadence applies to email only — in-app is immediate
                        whenever it is on, which is why the endpoint ignores a
                        frequency sent for IN_APP.
                      */}
                      {cell.channel === "EMAIL" && cell.enabled && !cell.locked ? (
                        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s1 }}>
                          {allowedFrequencies(state.view, row.type).map((f) => (
                            <ProovraButton
                              key={f}
                              label={frequencyLabel(f)}
                              variant={f === cell.frequency ? "primary" : "ghost"}
                              fullWidth={false}
                              disabled={busy === `${row.type}:EMAIL`}
                              onPress={() => void setFrequency(row.type, f, f !== "OFF")}
                            />
                          ))}
                        </View>
                      ) : null}
                    </View>
                  ))}
                </View>
              </ProovraCard>
            </ProovraPageSection>
          ))
        : null}

      <ProovraPageSection title="Quiet hours">
        {schedule.phase === "loading" ? <ProovraLoadingState label="Loading quiet hours" /> : null}

        {schedule.phase === "unavailable" ? (
          // "Not available on this deployment" is not "quiet hours are off".
          <ProovraEmpty
            presence="inline"
            title="Quiet hours are not available here."
            purpose="This workspace's deployment does not yet carry the schedule."
          />
        ) : null}

        {schedule.phase === "failed" ? (
          <ProovraErrorState message="Quiet hours could not be loaded." onRetry={() => void load()} />
        ) : null}

        {schedule.phase === "loaded" ? (
          <ProovraCard>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: theme.space.s2,
              }}
            >
              <View style={{ flex: 1 }}>
                <ProovraText variant="body" weight="semibold">
                  Pause email during quiet hours
                </ProovraText>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {describeQuietWindow(schedule.schedule)}
                </ProovraText>
              </View>
              <Switch
                value={schedule.schedule.quietHoursEnabled}
                disabled={busy === "schedule"}
                accessibilityLabel="Pause email during quiet hours"
                onValueChange={(next) =>
                  void saveSchedule({ ...schedule.schedule, quietHoursEnabled: next })
                }
              />
            </View>

            {schedule.schedule.quietHoursEnabled ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {schedule.schedule.quietCriticalOverride
                  ? "Critical alerts still come through."
                  : "Critical alerts are held until quiet hours end."}
              </ProovraText>
            ) : null}

            <ProovraText variant="label" color={theme.color.ink.muted}>
              {schedule.schedule.timezone
                ? `Times are in ${schedule.schedule.timezone}.`
                : "Times follow your account timezone."}
            </ProovraText>
          </ProovraCard>
        ) : null}
      </ProovraPageSection>
    </ProovraScreen>
  );
}
