import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, Switch, View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useLocale } from "../../src/locale-context";
import { useAuth } from "../../src/auth-context";
import { logout as logoutApi, getLegalStatus } from "../../src/auth/auth-api";
import { loadTelemetryConsent, setTelemetryConsent } from "../../src/privacy/telemetry-consent";
import { apiFetch, setAuthToken } from "../../src/api";
import { toSafeUserError } from "../../src/errors/safe-error";
import { theme } from "../../src/theme/theme";
import {
  ProovraShell,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraInput,
  ProovraFormField,
  ProovraListRow,
} from "../../src/ui";

/** The device's IANA timezone, or null when the runtime can't resolve one. */
function deviceTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.includes("/") ? tz : null;
  } catch {
    return null;
  }
}

// en/ar/de are fully translated; the rest fall back to English (audit §I.4 —
// never advertise a placeholder as a complete translation).
const FULL_LOCALES = new Set(["en", "ar", "de"]);
const LOCALES = ["en", "ar", "de", "fr", "es", "tr", "ru"] as const;

export default function SettingsScreen() {
  const { t, locale, mode, setLocale, setLocaleMode } = useLocale();
  const { user, setToken } = useAuth();
  const router = useRouter();
  const [telemetry, setTelemetry] = useState(false);
  const [legalOk, setLegalOk] = useState<boolean | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(user?.displayName ?? "");
  const [nameShown, setNameShown] = useState(user?.displayName ?? "");
  const [nameBusy, setNameBusy] = useState(false);
  const [tzBusy, setTzBusy] = useState(false);
  const tz = deviceTimezone();

  useEffect(() => {
    void loadTelemetryConsent().then(setTelemetry);
    void getLegalStatus().then((s) => setLegalOk(s.ok)).catch(() => setLegalOk(null));
  }, []);

  // Profile edits go through the canonical PATCH /v1/users/me (server-validated).
  const saveName = useCallback(async () => {
    const displayName = nameValue.trim();
    if (!displayName || displayName.length > 120) {
      Alert.alert("Check the details", "Enter a name (1–120 characters).");
      return;
    }
    setNameBusy(true);
    try {
      await apiFetch("/v1/users/me", { method: "PATCH", body: JSON.stringify({ displayName }) });
      setNameShown(displayName);
      setEditingName(false);
    } catch (err) {
      Alert.alert("Could not update name", toSafeUserError(err).message);
    } finally {
      setNameBusy(false);
    }
  }, [nameValue]);

  const setDeviceTimezone = useCallback(async () => {
    if (!tz) return;
    setTzBusy(true);
    try {
      await apiFetch("/v1/users/me", { method: "PATCH", body: JSON.stringify({ timezone: tz }) });
      Alert.alert("Timezone updated", `Your account timezone is now ${tz}.`);
    } catch (err) {
      Alert.alert("Could not update timezone", toSafeUserError(err).message);
    } finally {
      setTzBusy(false);
    }
  }, [tz]);

  const onToggleTelemetry = useCallback((next: boolean) => {
    setTelemetry(next);
    void setTelemetryConsent(next);
  }, []);

  const doLogout = useCallback(async () => {
    await logoutApi();
    setToken(null);
    setAuthToken(null);
    router.replace("/(stack)/auth");
  }, [router, setToken]);

  return (
    <ProovraShell>
      <ProovraSection title={t("settings")}>
        {/* Account */}
        <ProovraCard style={styles.card}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Account</ProovraText>
          {editingName ? (
            <>
              <ProovraFormField label="Display name">
                <ProovraInput value={nameValue} onChangeText={setNameValue} placeholder="Your name" autoCapitalize="words" onSubmitEditing={() => void saveName()} />
              </ProovraFormField>
              <View style={styles.nameActions}>
                <ProovraButton label="Save" loading={nameBusy} fullWidth={false} onPress={() => void saveName()} />
                <ProovraButton label="Cancel" variant="ghost" fullWidth={false} disabled={nameBusy} onPress={() => { setEditingName(false); setNameValue(nameShown); }} />
              </View>
            </>
          ) : (
            <ProovraListRow
              title={nameShown || "Signed in"}
              subtitle={user?.email ?? undefined}
              trailing={<ProovraText variant="label" color={theme.color.accent.a600} weight="semibold">Edit</ProovraText>}
              onPress={() => { setNameValue(nameShown); setEditingName(true); }}
            />
          )}
          {tz ? (
            <ProovraListRow
              title="Timezone"
              subtitle={`Set your account timezone to this device (${tz})`}
              trailing={<ProovraButton label="Use device" variant="secondary" fullWidth={false} loading={tzBusy} onPress={() => void setDeviceTimezone()} />}
            />
          ) : null}
        </ProovraCard>

        {/* Language */}
        <ProovraCard style={styles.card}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>{t("language")}</ProovraText>
          <View style={styles.langRow}>
            <LangPill label="AUTO" active={mode === "auto"} onPress={() => setLocaleMode("auto")} />
            {LOCALES.map((lng) => (
              <LangPill
                key={lng}
                label={FULL_LOCALES.has(lng) ? lng.toUpperCase() : `${lng.toUpperCase()}·beta`}
                active={locale === lng && mode === "manual"}
                onPress={() => { setLocaleMode("manual"); setLocale(lng); }}
              />
            ))}
          </View>
          <ProovraText variant="label" color={theme.color.ink.muted} style={styles.gap}>
            English, Arabic and German are fully translated; other languages are in progress.
          </ProovraText>
        </ProovraCard>

        {/* Privacy & legal */}
        <ProovraCard style={styles.card}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Privacy &amp; legal</ProovraText>
          <View style={styles.switchRow}>
            <View style={styles.switchText}>
              <ProovraText variant="body" weight="semibold">Crash &amp; reliability reports</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.muted}>Share anonymized diagnostics to help fix problems.</ProovraText>
            </View>
            <Switch value={telemetry} onValueChange={onToggleTelemetry} accessibilityLabel="Crash and reliability reports" />
          </View>
          <ProovraListRow
            title="Privacy"
            subtitle="Export your data, or close your account"
            onPress={() => router.push("/(stack)/settings/privacy")}
          />
          <ProovraListRow
            title="Reviewer criteria"
            subtitle="Versioned criteria reviewers work against"
            onPress={() => router.push("/(stack)/settings/reviewer-criteria")}
          />
          <ProovraListRow
            title="Spaces"
            subtitle="Switch between your Personal Space and shared workspaces"
            onPress={() => router.push("/(stack)/spaces")}
          />
          <ProovraListRow
            title="Organizations"
            subtitle="The organizations you belong to"
            onPress={() => router.push("/(stack)/organizations")}
          />
          <ProovraListRow
            title="People in this workspace"
            subtitle="Members, roles and invitations"
            onPress={() => router.push("/(stack)/workspace-people")}
          />
          {/*
            The app used AI-assisted surfaces and could not say whether AI was
            on in this workspace, which capabilities, or who decided. The read
            behind this row is one every membership role holds, so a VIEWER
            can learn what governs them.
          */}
          <ProovraListRow
            title="AI & assistance"
            subtitle="What AI does in this workspace, and who decides it"
            onPress={() => router.push("/(stack)/settings/ai")}
          />
          <ProovraListRow
            title="Notification preferences"
            subtitle="Which notifications reach you, in the app and by email"
            onPress={() => router.push("/(stack)/settings/notifications")}
          />
          <ProovraListRow
            title="Legal acceptance"
            subtitle={legalOk === null ? "—" : legalOk ? "Up to date" : "Action needed"}
            onPress={() => router.push("/legal-acceptance")}
            trailing={<ProovraText variant="label" color={legalOk === false ? theme.color.status.risk.fg : theme.color.ink.muted}>{legalOk === false ? "Review" : ""}</ProovraText>}
          />
          {/*
            These two opened www.proovra.com in the system browser, which meant
            the app could not show the terms a user is asked to accept if the
            handoff failed or the device was offline, and could not state which
            version it had shown. They now read the canonical corpus over
            `GET /v1/legal/:slug` — the same text the web renders — and the
            whole corpus is reachable, not just these two documents.
          */}
          <ProovraListRow title="Terms of Service" onPress={() => router.push("/legal/terms")} />
          <ProovraListRow title="Privacy Policy" onPress={() => router.push("/legal/privacy")} />
          <ProovraListRow
            title="All legal documents"
            subtitle="Policies, agreements and disclosures"
            onPress={() => router.push("/legal")}
          />
          <ProovraListRow
            title="Support"
            subtitle="Product, billing, security and legal routes"
            onPress={() => router.push("/(stack)/support")}
          />
          <ProovraListRow title="Verify a record" subtitle="Check the authenticity of a PROOVRA verification link" onPress={() => router.push("/verify")} />
          <ProovraListRow
            title="Trust Center"
            subtitle="How PROOVRA verifies evidence, and what it does not claim"
            onPress={() => router.push("/(stack)/trust-center")}
          />
        </ProovraCard>

        {/*
         * Security — native, not a web handoff.
         *
         * This used to open proovra.com/security-center in a browser, which
         * meant a user could not change their password, see where they were
         * signed in, revoke a session or manage two-factor from the device
         * they were holding — on the one device most likely to be lost.
         */}
        <ProovraCard style={styles.card}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Security</ProovraText>
          <ProovraListRow
            title="Password, two-factor and sessions"
            subtitle="Change your password, manage two-factor, review where you are signed in"
            onPress={() => router.push("/(stack)/settings/security")}
          />
        </ProovraCard>

        {/* Collaboration */}
        <ProovraCard style={styles.card}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Collaboration</ProovraText>
          <ProovraListRow
            title="Collaboration groups"
            subtitle="Groups you belong to in this workspace"
            onPress={() => router.push("/teams")}
          />
          <ProovraListRow
            title="Evidence requests"
            subtitle="Requests to submit evidence"
            onPress={() => router.push("/evidence-requests")}
          />
          <ProovraListRow
            title="Intake links"
            subtitle="View and revoke secure intake links"
            onPress={() => router.push("/intake-links")}
          />
        </ProovraCard>

        {/* Billing */}
        <ProovraCard style={styles.card}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Plan</ProovraText>
          <ProovraListRow title="Billing &amp; plan" subtitle="View your plan and usage" onPress={() => router.push("/(stack)/billing")} />
          {/*
            The web reaches these two self-service consoles contextually and
            keeps them out of every nav surface (routeRegistry: sidebarEligible,
            commandPaletteVisible and allToolsVisible are all false). A phone
            has no contextual surface to reach them from, so they sit beside the
            plan they are about — which is where a user looking for "how much
            have I used" actually goes.
          */}
          <ProovraListRow
            title="Quotas &amp; usage"
            subtitle="Account allowances, usage breakdown, and reset windows"
            onPress={() => router.push("/(stack)/operations/quotas")}
          />
          <ProovraListRow
            title="Batch analysis"
            subtitle="Batch processing jobs and queue status"
            onPress={() => router.push("/(stack)/operations/batch-analysis")}
          />
        </ProovraCard>

        <View style={styles.logout}>
          <ProovraButton label="Sign out" variant="secondary" onPress={() => void doLogout()} />
        </View>
      </ProovraSection>
    </ProovraShell>
  );
}

function LangPill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.pill, { borderColor: active ? theme.color.accent.a500 : theme.color.border.default, backgroundColor: active ? theme.color.accent.a050 : "transparent" }]}
    >
      <ProovraText variant="label" weight="semibold" color={active ? theme.color.accent.a600 : theme.color.ink.secondary}>{label}</ProovraText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: theme.space.s4, gap: theme.space.s2 },
  gap: { marginTop: theme.space.s1 },
  nameActions: { flexDirection: "row", gap: theme.space.s2 },
  langRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginTop: theme.space.s2 },
  pill: { paddingHorizontal: theme.space.s3, paddingVertical: theme.space.s2, borderRadius: theme.radius.pill, borderWidth: 1, minHeight: 36, justifyContent: "center" },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.s3, marginTop: theme.space.s2 },
  switchText: { flex: 1, gap: 2 },
  logout: { marginTop: theme.space.s2 },
});
