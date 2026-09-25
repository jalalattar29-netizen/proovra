/**
 * NOTIFICATION PREFERENCES — the native port of Settings › Notifications
 * (`apps/web/app/(app)/settings/_sections/NotificationsSection.tsx`):
 *   NotificationPreferencesPanel → NotificationScheduleCard → contact channel.
 *
 * Canonical sources: `GET/PUT /v1/me/notification-preferences` and
 * `GET/PUT /v1/me/notification-schedule`, both scoped to the ACTIVE workspace,
 * plus `GET /v1/users/me` for the account timezone the schedule inherits.
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
 * The organization notification-policy MANAGER the web renders beneath the
 * table is an ORG_OWNER/ORG_ADMIN surface (`canManageOrgPolicy`) and is not
 * ported here.
 */
import { useCallback, useEffect, useState } from "react";
import { Pressable, Switch, View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../../../src/api";
import { usePlatformContext } from "../../../src/product/platform-context";
import { MessagingContactSection } from "../../../src/ui/messaging-contact-section";
import { TimezonePickerSheet } from "../../../src/ui/timezone-picker-sheet";
import { accountTimezoneFrom } from "../../../src/product/settings-overview";
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
  EMAIL_LOCK_REASON,
  PREFERENCES_WRITE_PATH,
  SCHEDULE_WRITE_PATH,
  allowedFrequencies,
  buildPreferenceUpdate,
  buildPreferencesPath,
  buildScheduleUpdate,
  buildSchedulePath,
  channelLabel,
  formatMinuteOfDay,
  frequencyLabel,
  groupPreferenceRows,
  hasOrgPolicyLocks,
  inAppLockReason,
  isPolicyLocked,
  isScheduleUnavailable,
  parsePreferences,
  parseSchedule,
  preferenceTypeHelp,
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

/** Quiet-hour boundaries move in half-hour steps (the server stores minutes 0–1439). */
const STEP = 30;
const shift = (minute: number, by: number) => (((minute + by) % 1440) + 1440) % 1440;

export default function NotificationPreferencesScreen() {
  const router = useRouter();
  const { addToast } = useToast();
  const { context, loading: contextLoading } = usePlatformContext();
  const teamId = context?.activeTeamId ?? null;

  const [state, setState] = useState<State>({ phase: "loading" });
  const [schedule, setSchedule] = useState<ScheduleState>({ phase: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [accountTz, setAccountTz] = useState<string | null>(null);
  const [tzPickerOpen, setTzPickerOpen] = useState(false);

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
      // The account timezone the schedule inherits (Settings › Preferences).
      apiFetch("/v1/users/me")
        .then((d) => setAccountTz(accountTimezoneFrom(d)))
        .catch(() => setAccountTz(null)),
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
            : "Could not save preference.",
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
        addToast("Could not save the notification schedule.", "error");
      } finally {
        setBusy(null);
      }
    },
    [teamId, addToast],
  );

  const view = state.phase === "loaded" ? state.view : null;

  return (
    <ProovraScreen shell testID="settings-notifications">
      <ProovraPageHeader
        title="Notifications"
        eyebrow="Settings"
        subtitle="Which updates reach you in-app and by email, plus quiet hours and digest cadence."
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

      {/* No workspace once the context has resolved is an answer, not a wait (web NotificationsSection :25). */}
      {!teamId && contextLoading ? <ProovraLoadingState label="Resolving workspace" /> : null}
      {!teamId && !contextLoading ? (
        <ProovraText variant="bodySm" color={theme.color.ink.secondary} testID="notifications-no-workspace">
          Select a workspace to manage its notification preferences.
        </ProovraText>
      ) : null}

      {teamId && state.phase === "loading" ? (
        <ProovraLoadingState label="Loading preferences" />
      ) : null}

      {teamId && state.phase === "failed" ? (
        <ProovraErrorState message="Could not load notification preferences." onRetry={() => void load()} />
      ) : null}

      {view && view.rows.length === 0 ? (
        <ProovraEmpty presence="page" title="No notification categories are published." />
      ) : null}

      {view && view.rows.length > 0 ? (
        <>
          <ProovraPageSection
            title="Notification preferences"
            description="Operational notifications for this workspace. In-app delivery is enabled by default; email is opt-in. Toggling here is audited."
          >
            <ProovraCard testID="notification-legend">
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                <ProovraText variant="label" weight="semibold">In-app</ProovraText>
                {" — what appears in your bell and Operations Center."}
              </ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                <ProovraText variant="label" weight="semibold">Email</ProovraText>
                {" — choose immediate delivery or an hourly, daily, or weekly digest per category."}
              </ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                Critical evidence-integrity alerts always remain enabled in-app.
              </ProovraText>
              {/* Only when a REAL organization policy locks something here —
                  a personal workspace never sees organization terminology. */}
              {!view.isPersonalWorkspace && hasOrgPolicyLocks(view) ? (
                <ProovraText variant="label" color={theme.color.ink.secondary} testID="notification-org-policy-legend">
                  <ProovraText variant="label" weight="semibold">“Managed by your organization”</ProovraText>
                  {" means your organization’s policy controls that setting."}
                </ProovraText>
              ) : null}
            </ProovraCard>
          </ProovraPageSection>

          {groupPreferenceRows(view.rows).map((group) => (
            <ProovraPageSection key={group.title} title={group.title}>
              {group.rows.map((row) => (
                <ProovraCard key={row.type} testID={`notification-type-${row.type}`}>
                  <ProovraText variant="body" weight="semibold">{row.label}</ProovraText>
                  {preferenceTypeHelp(row.type) ? (
                    <ProovraText variant="label" color={theme.color.ink.muted}>{preferenceTypeHelp(row.type)}</ProovraText>
                  ) : null}
                  <View style={{ gap: theme.space.s3, marginTop: theme.space.s2 }}>
                    {row.cells.map((cell) => {
                      const shownEnabled = cell.locked ? true : cell.enabled;
                      return (
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
                              <ProovraText variant="bodySm">{channelLabel(cell.channel)}</ProovraText>
                              {cell.locked ? (
                                <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
                                  {cell.channel === "IN_APP" ? inAppLockReason(row.type) : EMAIL_LOCK_REASON}
                                </ProovraText>
                              ) : null}
                            </View>

                            {cell.locked ? (
                              <ProovraBadge label="Always on" tone="governance" />
                            ) : (
                              <Switch
                                value={cell.enabled}
                                disabled={busy === `${row.type}:${cell.channel}`}
                                accessibilityLabel={`${row.label} — ${cell.channel === "IN_APP" ? "in-app" : "email"}`}
                                onValueChange={(next) =>
                                  void toggle(row.type, cell.channel, next, cell.frequency)
                                }
                              />
                            )}
                          </View>

                          {/*
                            Cadence applies to email only — in-app is immediate
                            whenever it is on. A locked (required) email cannot
                            be set to Off; an organization minimum removes the
                            weaker cadences.
                          */}
                          {cell.channel === "EMAIL" && shownEnabled ? (
                            <View
                              style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s1 }}
                              accessibilityLabel={`${row.label} email frequency`}
                            >
                              {allowedFrequencies(view, row.type)
                                .filter((f) => !(cell.locked && f === "OFF"))
                                .map((f) => (
                                  <ProovraButton
                                    key={f}
                                    label={frequencyLabel(f)}
                                    variant={f === cell.frequency ? "primary" : "ghost"}
                                    fullWidth={false}
                                    disabled={busy === `${row.type}:EMAIL`}
                                    onPress={() => void setFrequency(row.type, f, cell.locked ? true : f !== "OFF")}
                                  />
                                ))}
                            </View>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                </ProovraCard>
              ))}
            </ProovraPageSection>
          ))}
        </>
      ) : null}

      {teamId ? (
        <ProovraPageSection
          title="Quiet hours & timezone"
          description={
            schedule.phase === "loaded"
              ? "Digest emails respect your quiet hours in your local timezone. Critical items may still deliver during quiet hours when the override is on."
              : undefined
          }
        >
          {schedule.phase === "loading" ? <ProovraLoadingState label="Loading quiet hours" /> : null}

          {schedule.phase === "unavailable" ? (
            // "Not provisioned here" is not "quiet hours are off": defaults are
            // never rendered as if they were saved.
            <ProovraCard testID="notification-schedule-unavailable">
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                Quiet hours and digest scheduling aren’t provisioned in this environment yet. Your other preferences still work.
              </ProovraText>
              <ProovraButton label="Save schedule" variant="secondary" fullWidth={false} disabled onPress={() => undefined} />
              <ProovraText variant="label" color={theme.color.ink.muted}>
                Scheduling is not provisioned in this environment.
              </ProovraText>
            </ProovraCard>
          ) : null}

          {schedule.phase === "failed" ? (
            <ProovraErrorState message="Could not load the notification schedule." onRetry={() => void load()} />
          ) : null}

          {schedule.phase === "loaded" ? (
            <ScheduleCard
              schedule={schedule.schedule}
              accountTz={accountTz}
              saving={busy === "schedule"}
              onSave={(next) => void saveSchedule(next)}
              onOpenPicker={() => setTzPickerOpen(true)}
            />
          ) : null}
        </ProovraPageSection>
      ) : null}

      {/* SMS/WhatsApp delivery destination — the same Notifications section as on the web. */}
      <MessagingContactSection teamId={teamId} />

      {schedule.phase === "loaded" ? (
        <TimezonePickerSheet
          visible={tzPickerOpen}
          title="Workspace timezone"
          current={schedule.schedule.timezone}
          onPick={(tz) => {
            setTzPickerOpen(false);
            void saveSchedule({ ...schedule.schedule, timezone: tz });
          }}
          onClose={() => setTzPickerOpen(false)}
        />
      ) : null}
    </ProovraScreen>
  );
}

function ScheduleCard({
  schedule,
  accountTz,
  saving,
  onSave,
  onOpenPicker,
}: {
  schedule: NotificationSchedule;
  accountTz: string | null;
  saving: boolean;
  onSave: (next: NotificationSchedule) => void;
  onOpenPicker: () => void;
}) {
  const inherit = schedule.timezone === null;
  const effective = schedule.timezone?.trim() || accountTz?.trim() || "UTC";
  return (
    <ProovraCard testID="notification-schedule">
      {/* EXPLICIT timezone inheritance — two states, never a silently
          diverging second value: inherit the account timezone, or override
          it for THIS workspace only. */}
      <ProovraText variant="bodySm" weight="semibold">Notification timezone</ProovraText>
      <ChoiceRow
        label={`Use account timezone — ${accountTz ?? "not set, so UTC fallback applies"}`}
        selected={inherit}
        disabled={saving}
        onPress={() => onSave({ ...schedule, timezone: null })}
      />
      <ChoiceRow
        label="Override for this workspace"
        selected={!inherit}
        disabled={saving}
        onPress={() => onSave({ ...schedule, timezone: schedule.timezone ?? accountTz ?? "UTC" })}
      />
      {!inherit ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2 }}>
          <ProovraText variant="label" color={theme.color.ink.secondary}>Workspace timezone</ProovraText>
          <ProovraButton label={schedule.timezone ?? "UTC"} variant="secondary" fullWidth={false} disabled={saving} accessibilityLabel="Workspace timezone" onPress={onOpenPicker} />
        </View>
      ) : null}
      <ProovraText variant="label" color={theme.color.ink.secondary} testID="notification-effective-tz">
        {"Digests and quiet hours use: "}
        <ProovraText variant="label" weight="semibold">{effective}</ProovraText>
      </ProovraText>

      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s3, marginTop: theme.space.s3 }}>
        <View style={{ flex: 1 }}>
          <ProovraText variant="bodySm" weight="semibold">Quiet hours</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted}>Pause digest delivery during the window below.</ProovraText>
        </View>
        <Switch
          value={schedule.quietHoursEnabled}
          disabled={saving}
          accessibilityLabel="Enable quiet hours"
          onValueChange={(next) => onSave({ ...schedule, quietHoursEnabled: next })}
        />
      </View>

      {schedule.quietHoursEnabled ? (
        <>
          <TimeStepper
            label="From"
            name="Quiet hours start"
            minute={schedule.quietStartMinute}
            disabled={saving}
            onChange={(m) => onSave({ ...schedule, quietStartMinute: m })}
          />
          <TimeStepper
            label="to"
            name="Quiet hours end"
            minute={schedule.quietEndMinute}
            disabled={saving}
            onChange={(m) => onSave({ ...schedule, quietEndMinute: m })}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s3 }}>
            <View style={{ flex: 1 }}>
              <ProovraText variant="bodySm" weight="semibold">Critical override</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.muted}>Critical operational items may bypass quiet hours.</ProovraText>
            </View>
            <Switch
              value={schedule.quietCriticalOverride}
              disabled={saving}
              accessibilityLabel="Allow critical notifications during quiet hours"
              onValueChange={(next) => onSave({ ...schedule, quietCriticalOverride: next })}
            />
          </View>
        </>
      ) : null}
    </ProovraCard>
  );
}

function ChoiceRow({ label, selected, disabled, onPress }: { label: string; selected: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={selected ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected, checked: selected, disabled }}
      style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2, paddingVertical: theme.space.s1, minHeight: 36 }}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          borderWidth: 2,
          borderColor: selected ? theme.color.accent.a500 : theme.color.border.strong,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.accent.a500 }} /> : null}
      </View>
      <ProovraText variant="bodySm" color={theme.color.ink.secondary} style={{ flex: 1 }}>{label}</ProovraText>
    </Pressable>
  );
}

/** A time field on a phone without a date-time picker: the web's HH:MM, stepped by half hours. */
function TimeStepper({ label, name, minute, disabled, onChange }: { label: string; name: string; minute: number; disabled: boolean; onChange: (m: number) => void }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2 }}>
      <ProovraText variant="label" color={theme.color.ink.secondary} style={{ minWidth: 40 }}>{label}</ProovraText>
      <ProovraButton label="−" variant="secondary" fullWidth={false} disabled={disabled} accessibilityLabel={`${name} earlier`} onPress={() => onChange(shift(minute, -STEP))} />
      <ProovraText variant="body" weight="semibold" accessibilityLabel={`${name} ${formatMinuteOfDay(minute)}`}>{formatMinuteOfDay(minute)}</ProovraText>
      <ProovraButton label="+" variant="secondary" fullWidth={false} disabled={disabled} accessibilityLabel={`${name} later`} onPress={() => onChange(shift(minute, STEP))} />
    </View>
  );
}
