/**
 * SETTINGS — the native port of `/settings` (apps/web/app/(app)/settings/page.tsx).
 *
 * The web lands on an Overview pane — the person, the context they are working
 * in, four summary cards (Workspace · Plan · Security · Recent sign-ins) and
 * their preferences — beside a map of the other panes. Native renders the same
 * Overview here and lists the panes below it; each pane is its own screen.
 *
 * Every figure comes from the canonical envelope (`usePlatformContext`, Law of
 * One) or from the three security reads the web summary makes; the pane list is
 * gated by the same server projections the web's `resolveSettingsNavigation`
 * reads (see src/product/settings-overview.ts).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, Switch, View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useLocale } from "../../src/locale-context";
import { useAuth } from "../../src/auth-context";
import { logout as logoutApi, getLegalStatus } from "../../src/auth/auth-api";
import { loadTelemetryConsent, setTelemetryConsent } from "../../src/privacy/telemetry-consent";
import { apiFetch, setAuthToken } from "../../src/api";
import { toSafeUserError } from "../../src/errors/safe-error";
import { theme } from "../../src/theme/theme";
import { formatUserDateTime } from "../../src/lib/date";
import { usePlatformContext } from "../../src/product/platform-context";
import { summarizeSignInMethods } from "../../src/product/account-security";
import {
  EMPTY_SECURITY_SUMMARY,
  accountTimezoneFrom,
  detectDeviceTimezone,
  mfaConfiguredFrom,
  projectSettingsOverview,
  recentSignInsFrom,
  sessionCountFrom,
  timezoneLabel,
  type AccountSecuritySummary,
} from "../../src/product/settings-overview";
import { SettingsRolesSheet } from "../../src/ui/settings-roles";
import { TimezonePickerSheet } from "../../src/ui/timezone-picker-sheet";
import {
  ProovraShell,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraInput,
  ProovraFormField,
  ProovraListRow,
} from "../../src/ui";

// T-17 / RC-17 — all seven dictionaries are translated (they used to be
// en/ar/de only, and the rest were labelled "·beta"). Labels are each
// language's own name, as the web's picker shows them (PreferencesSection.tsx).
const LOCALES = ["en", "ar", "de", "fr", "es", "tr", "ru"] as const;
const LOCALE_NAMES: Record<(typeof LOCALES)[number], string> = {
  en: "English",
  ar: "العربية",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  tr: "Türkçe",
  ru: "Русский",
};

export default function SettingsScreen() {
  const { t, locale, mode, setLocale, setLocaleMode } = useLocale();
  const { user, setToken } = useAuth();
  const router = useRouter();
  const { envelope } = usePlatformContext();
  const overview = useMemo(() => projectSettingsOverview(envelope), [envelope]);

  const [telemetry, setTelemetry] = useState(false);
  const [legalOk, setLegalOk] = useState<boolean | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(user?.displayName ?? "");
  const [nameShown, setNameShown] = useState(user?.displayName ?? "");
  const [nameBusy, setNameBusy] = useState(false);
  const [security, setSecurity] = useState<AccountSecuritySummary>(EMPTY_SECURITY_SUMMARY);
  // The ACCOUNT timezone (users.routes.ts pickMe) — undefined while loading.
  const [accountTz, setAccountTz] = useState<string | null | undefined>(undefined);
  const [tzBusy, setTzBusy] = useState(false);
  const [tzPickerOpen, setTzPickerOpen] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);

  useEffect(() => {
    void loadTelemetryConsent().then(setTelemetry);
    void getLegalStatus().then((s) => setLegalOk(s.ok)).catch(() => setLegalOk(null));
    void apiFetch("/v1/users/me")
      .then((d) => setAccountTz(accountTimezoneFrom(d)))
      .catch(() => setAccountTz(null));
  }, []);

  // The web's account security summary (useAccountSecuritySummary): the SAME
  // canonical reads the Security pane makes, each failing soft on its own.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [links, mfa, sessions] = await Promise.all([
        apiFetch("/v1/identity/links").catch(() => null),
        apiFetch("/v1/identity/mfa/factors").catch(() => null),
        apiFetch("/v1/identity-security/my-sessions").catch(() => null),
      ]);
      if (!alive) return;
      setSecurity({
        loginMethods: links ? summarizeSignInMethods(links) : null,
        mfaConfigured: mfa ? mfaConfiguredFrom(mfa) : null,
        activeSessions: sessions ? sessionCountFrom(sessions) : null,
        recentSignIns: sessions ? recentSignInsFrom(sessions) : [],
      });
    })();
    return () => {
      alive = false;
    };
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

  /*
   * T-12 — the web saves the UI language to the ACCOUNT (PATCH /v1/users/me
   * { locale }, PreferencesSection.tsx), so it follows the person to every
   * device. Native kept the choice on this device only.
   */
  const chooseLocale = useCallback(
    async (lng: (typeof LOCALES)[number]) => {
      setLocaleMode("manual");
      setLocale(lng);
      try {
        await apiFetch("/v1/users/me", { method: "PATCH", body: JSON.stringify({ locale: lng }) });
      } catch (err) {
        Alert.alert("Could not save preferences. Please try again.", toSafeUserError(err).message);
      }
    },
    [setLocale, setLocaleMode],
  );

  /** PATCH /v1/users/me { timezone } — the server rejects a non-IANA name (users.routes.ts:122). */
  const saveTimezone = useCallback(async (tz: string) => {
    setTzBusy(true);
    try {
      const res = await apiFetch("/v1/users/me", { method: "PATCH", body: JSON.stringify({ timezone: tz }) });
      setAccountTz(accountTimezoneFrom(res) ?? tz);
      setTzPickerOpen(false);
      Alert.alert("Preferences saved", `Your account timezone is now ${tz}.`);
    } catch (err) {
      Alert.alert("Could not save preferences. Please try again.", toSafeUserError(err).message);
    } finally {
      setTzBusy(false);
    }
  }, []);

  const useCurrentTimezone = useCallback(async () => {
    const tz = detectDeviceTimezone();
    if (!tz) {
      Alert.alert("Could not detect your current timezone.");
      return;
    }
    await saveTimezone(tz);
  }, [saveTimezone]);

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

  const { billing } = overview;

  return (
    <ProovraShell>
      <ProovraSection title={t("settings")}>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary} style={styles.lede}>
          Manage your personal preferences, workspace settings, security, and integrations.
        </ProovraText>

        {/* ---------------------------------------------------- OVERVIEW */}
        <ProovraText variant="h3" weight="semibold">Overview</ProovraText>
        <ProovraText variant="label" color={theme.color.ink.muted} style={styles.gapBottom}>
          Your account, its preferences, and the workspace you are working in.
        </ProovraText>

        {/* IDENTITY — the person, and "as whom, and where". */}
        <ProovraCard style={styles.card} testID="settings-identity">
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Account</ProovraText>
          {editingName ? (
            <>
              <ProovraFormField label="Display name">
                <ProovraInput value={nameValue} onChangeText={setNameValue} placeholder="Your name" autoCapitalize="words" onSubmitEditing={() => void saveName()} />
              </ProovraFormField>
              <ProovraText variant="label" color={theme.color.ink.muted}>
                Display name — what appears on evidence reviews, reports, and invitations.
              </ProovraText>
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
          <View style={styles.chips} accessibilityLabel="Account context">
            {overview.roleLabel ? <ContextChip label="Role" value={overview.roleLabel} /> : null}
            <ContextChip label={billing.contextType === "personal" ? "Workspace" : "Organization"} value={overview.workspaceName} />
            <ContextChip label={billing.scopeLabel} value={billing.displayPlan} />
          </View>
        </ProovraCard>

        {/* SUMMARIES */}
        <SummaryCard title="Workspace" testID="settings-summary-workspace">
          <View style={styles.inline}>
            <ProovraText variant="body" weight="semibold">{overview.workspaceName}</ProovraText>
            {!overview.isPersonal ? <ProovraBadge label="Active" tone="verified" /> : null}
          </View>
          {overview.roleLabel ? <Fact label="Role" value={overview.roleLabel} /> : null}
          <Fact label="Type" value={overview.isPersonal ? "Personal space" : "Organization"} />
          {/* No action where there is nothing to open: a personal space has no
              membership administration, and a button that opens nothing is
              worse than no button. */}
          {overview.canManageMembers ? (
            <ProovraButton label="Manage members" variant="secondary" fullWidth={false} onPress={() => router.push("/(stack)/workspace-people")} />
          ) : null}
        </SummaryCard>

        <SummaryCard title="Plan" testID="settings-summary-plan">
          <ProovraText variant="body" weight="semibold">{billing.displayPlan}</ProovraText>
          <Fact label="Scope" value={billing.scopeLabel} />
          {billing.managedByOrgName ? <Fact label="Managed by" value={billing.managedByOrgName} /> : null}
          {billing.canOpenBilling ? (
            <ProovraButton label="View billing" variant="secondary" fullWidth={false} onPress={() => router.push("/(stack)/billing")} />
          ) : null}
        </SummaryCard>

        <SummaryCard title="Security" testID="settings-summary-security">
          <View style={styles.fact}>
            <ProovraText variant="label" color={theme.color.ink.muted}>Two-factor</ProovraText>
            {security.mfaConfigured === null ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>Checking…</ProovraText>
            ) : security.mfaConfigured ? (
              <ProovraBadge label="Configured" tone="verified" />
            ) : (
              <ProovraBadge label="Not configured" tone="pending" />
            )}
          </View>
          {security.loginMethods ? <Fact label="Sign-in" value={security.loginMethods} /> : null}
          {typeof security.activeSessions === "number" ? <Fact label="Active sessions" value={String(security.activeSessions)} /> : null}
          <ProovraButton label="Review security" variant="secondary" fullWidth={false} onPress={() => router.push("/(stack)/settings/security")} />
        </SummaryCard>

        <SummaryCard title="Recent sign-ins" testID="settings-summary-activity">
          {security.recentSignIns.length > 0 ? (
            security.recentSignIns.map((entry) => (
              <View key={entry.id} style={styles.fact}>
                <View style={[styles.inline, styles.flex1]}>
                  <ProovraText variant="bodySm">{entry.device}</ProovraText>
                  {entry.isCurrent ? <ProovraBadge label="This device" tone="verified" /> : null}
                </View>
                <ProovraText variant="label" color={theme.color.ink.muted}>{formatUserDateTime(entry.lastSeenAtIso)}</ProovraText>
              </View>
            ))
          ) : (
            <ProovraText variant="label" color={theme.color.ink.muted}>No recent sign-in activity available.</ProovraText>
          )}
        </SummaryCard>

        {/* PREFERENCES */}
        <ProovraCard style={styles.card} testID="settings-preferences">
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Preferences</ProovraText>
          <ProovraText variant="bodySm" weight="semibold">{t("language")}</ProovraText>
          <View style={styles.langRow}>
            <LangPill label="AUTO" active={mode === "auto"} onPress={() => setLocaleMode("auto")} />
            {LOCALES.map((lng) => (
              <LangPill
                key={lng}
                label={LOCALE_NAMES[lng]}
                active={locale === lng && mode === "manual"}
                onPress={() => void chooseLocale(lng)}
              />
            ))}
          </View>
          <ProovraText variant="label" color={theme.color.ink.muted} style={styles.gap}>
            Your choice is saved to your account, so it follows you to the web app and other devices.
          </ProovraText>

          <ProovraText variant="bodySm" weight="semibold" style={styles.gapTop}>Account timezone</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted}>
            Used for notification digests and quiet hours. Evidence and audit timestamps remain in UTC.
          </ProovraText>
          {accountTz === null ? (
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
              Not set — UTC is currently used as the fallback.
            </ProovraText>
          ) : accountTz ? (
            <ProovraText variant="bodySm" testID="settings-account-timezone">{timezoneLabel(accountTz)}</ProovraText>
          ) : null}
          <View style={styles.nameActions}>
            <ProovraButton label="Use my current timezone" variant="secondary" fullWidth={false} loading={tzBusy} onPress={() => void useCurrentTimezone()} />
            <ProovraButton label="Choose timezone" variant="ghost" fullWidth={false} disabled={tzBusy} onPress={() => setTzPickerOpen(true)} />
          </View>
        </ProovraCard>

        {/* ---------------------------------------------- THE OTHER PANES */}
        <ProovraCard style={styles.card}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Account</ProovraText>
          {/*
           * Security — native, not a web handoff. A user can change their
           * password, see where they are signed in, revoke a session and
           * manage two-factor from the device they are holding.
           */}
          <ProovraListRow
            title="Security"
            subtitle="Sign-in methods, two-factor authentication, active sessions and recent security activity."
            onPress={() => router.push("/(stack)/settings/security")}
          />
          <ProovraListRow
            title="Notifications"
            subtitle="Which updates reach you in-app and by email, plus quiet hours and digest cadence."
            onPress={() => router.push("/(stack)/settings/notifications")}
          />
          <ProovraListRow
            title="Privacy & data"
            subtitle="Manage consent, policy records, data export, and account lifecycle."
            onPress={() => router.push("/(stack)/settings/privacy")}
          />
        </ProovraCard>

        <ProovraCard style={styles.card}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Workspace</ProovraText>
          {/*
            The read behind this pane is one every membership role holds, so a
            VIEWER can learn what governs them. Hidden only where the web hides
            it: a personal plan whose AI allowance is zero.
          */}
          {overview.showAiSettings ? (
            <ProovraListRow
              title="AI & assistance"
              subtitle="Whether AI assistance is available in this workspace, what it may be used for, and the allowance your plan or agreement provides."
              onPress={() => router.push("/(stack)/settings/ai")}
            />
          ) : null}
          {overview.canManageMembers ? (
            <ProovraListRow
              title="Members"
              subtitle="Who belongs to this workspace, and how they are invited."
              onPress={() => router.push("/(stack)/workspace-people")}
            />
          ) : (
            <ProovraListRow
              title="People in this workspace"
              subtitle="Members, roles and invitations"
              onPress={() => router.push("/(stack)/workspace-people")}
            />
          )}
          {overview.canViewRoles ? (
            <ProovraListRow
              title="Roles & permissions"
              subtitle="Understand workspace roles and what each role can do."
              onPress={() => setRolesOpen(true)}
            />
          ) : null}
          {overview.showReviewerCriteria ? (
            <ProovraListRow
              title="Reviewer criteria"
              subtitle="Versioned criteria reviewers work against"
              onPress={() => router.push("/(stack)/settings/reviewer-criteria")}
            />
          ) : null}
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
          <ProovraListRow title="Billing & plan" subtitle="Your plan, seats and storage." onPress={() => router.push("/(stack)/billing")} />
          {/*
            The web reaches these two self-service consoles contextually and
            keeps them out of every nav surface. A phone has no contextual
            surface to reach them from, so they sit beside the plan they are
            about.
          */}
          <ProovraListRow
            title="Quotas & usage"
            subtitle="Account allowances, usage breakdown, and reset windows"
            onPress={() => router.push("/(stack)/operations/quotas")}
          />
          <ProovraListRow
            title="Batch analysis"
            subtitle="Batch processing jobs and queue status"
            onPress={() => router.push("/(stack)/operations/batch-analysis")}
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

        {/* Privacy & legal */}
        <ProovraCard style={styles.card}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Legal &amp; support</ProovraText>
          <View style={styles.switchRow}>
            <View style={styles.switchText}>
              <ProovraText variant="body" weight="semibold">Crash &amp; reliability reports</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.muted}>Share anonymized diagnostics to help fix problems.</ProovraText>
            </View>
            <Switch value={telemetry} onValueChange={onToggleTelemetry} accessibilityLabel="Crash and reliability reports" />
          </View>
          <ProovraListRow
            title="Legal acceptance"
            subtitle={legalOk === null ? "—" : legalOk ? "Up to date" : "Action needed"}
            onPress={() => router.push("/legal-acceptance")}
            trailing={<ProovraText variant="label" color={legalOk === false ? theme.color.status.risk.fg : theme.color.ink.muted}>{legalOk === false ? "Review" : ""}</ProovraText>}
          />
          {/*
            These read the canonical corpus over `GET /v1/legal/:slug` — the
            same text the web renders — and the whole corpus is reachable.
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

        <View style={styles.logout}>
          <ProovraButton label="Sign out" variant="secondary" onPress={() => void doLogout()} />
        </View>
      </ProovraSection>

      <SettingsRolesSheet visible={rolesOpen} myRole={overview.matrixRole} onClose={() => setRolesOpen(false)} />

      {/* The web's timezone selector — every IANA zone the runtime knows. */}
      <TimezonePickerSheet
        visible={tzPickerOpen}
        title="Account timezone"
        current={accountTz ?? null}
        onPick={(tz) => void saveTimezone(tz)}
        onClose={() => setTzPickerOpen(false)}
      />
    </ProovraShell>
  );
}

function SummaryCard({ title, testID, children }: { title: string; testID: string; children: React.ReactNode }) {
  return (
    <ProovraCard style={styles.card} testID={testID}>
      <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>{title}</ProovraText>
      {children}
    </ProovraCard>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <ProovraText variant="label" color={theme.color.ink.muted}>{label}</ProovraText>
      <ProovraText variant="bodySm" weight="semibold">{value}</ProovraText>
    </View>
  );
}

function ContextChip({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.chip}>
      <ProovraText variant="label" color={theme.color.ink.muted}>{label}</ProovraText>
      <ProovraText variant="label" weight="semibold">{value}</ProovraText>
    </View>
  );
}

function LangPill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={[styles.pill, { borderColor: active ? theme.color.accent.a500 : theme.color.border.default, backgroundColor: active ? theme.color.accent.a050 : "transparent" }]}
    >
      <ProovraText variant="label" weight="semibold" color={active ? theme.color.accent.a600 : theme.color.ink.secondary}>{label}</ProovraText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: theme.space.s4, gap: theme.space.s2 },
  lede: { marginBottom: theme.space.s3 },
  gap: { marginTop: theme.space.s1 },
  gapTop: { marginTop: theme.space.s3 },
  gapBottom: { marginBottom: theme.space.s3 },
  flex1: { flex: 1 },
  inline: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 },
  fact: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.s2 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  chip: {
    paddingHorizontal: theme.space.s3,
    paddingVertical: theme.space.s1,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border.default,
    gap: 2,
  },
  nameActions: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  langRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginTop: theme.space.s2 },
  pill: { paddingHorizontal: theme.space.s3, paddingVertical: theme.space.s2, borderRadius: theme.radius.pill, borderWidth: 1, minHeight: 36, justifyContent: "center" },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.s3, marginTop: theme.space.s2 },
  switchText: { flex: 1, gap: 2 },
  logout: { marginTop: theme.space.s2 },
});
