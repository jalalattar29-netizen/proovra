import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, Switch, View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useLocale } from "../../src/locale-context";
import { useAuth } from "../../src/auth-context";
import { logout as logoutApi, getLegalStatus } from "../../src/auth/auth-api";
import { loadTelemetryConsent, setTelemetryConsent } from "../../src/privacy/telemetry-consent";
import { setAuthToken } from "../../src/api";
import { theme } from "../../src/theme/theme";
import {
  ProovraShell,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraListRow,
} from "../../src/ui";

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

  useEffect(() => {
    void loadTelemetryConsent().then(setTelemetry);
    void getLegalStatus().then((s) => setLegalOk(s.ok)).catch(() => setLegalOk(null));
  }, []);

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
          <ProovraText variant="body" weight="semibold" style={styles.gap}>{user?.displayName || "Signed in"}</ProovraText>
          {user?.email ? <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{user.email}</ProovraText> : null}
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
            title="Legal acceptance"
            subtitle={legalOk === null ? "—" : legalOk ? "Up to date" : "Action needed"}
            onPress={() => router.push("/legal-acceptance")}
            trailing={<ProovraText variant="label" color={legalOk === false ? theme.color.status.risk.fg : theme.color.ink.muted}>{legalOk === false ? "Review" : ""}</ProovraText>}
          />
          <ProovraListRow title="Terms of Service" onPress={() => void Linking.openURL("https://www.proovra.com/terms")} />
          <ProovraListRow title="Privacy Policy" onPress={() => void Linking.openURL("https://www.proovra.com/privacy")} />
          <ProovraListRow title="Trust Center" onPress={() => void Linking.openURL("https://www.proovra.com/trust")} />
          <ProovraListRow title="Verify a record" subtitle="Check the authenticity of a PROOVRA verification link" onPress={() => router.push("/verify")} />
        </ProovraCard>

        {/* Security (web-managed) */}
        <ProovraCard style={styles.card}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Security</ProovraText>
          <ProovraListRow
            title="Manage security"
            subtitle="Two-factor, sessions and password on the web app"
            onPress={() => void Linking.openURL("https://www.proovra.com/security-center")}
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
        </ProovraCard>

        {/* Billing */}
        <ProovraCard style={styles.card}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Plan</ProovraText>
          <ProovraListRow title="Billing &amp; plan" subtitle="View your plan and usage" onPress={() => router.push("/(stack)/billing")} />
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
  langRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginTop: theme.space.s2 },
  pill: { paddingHorizontal: theme.space.s3, paddingVertical: theme.space.s2, borderRadius: theme.radius.pill, borderWidth: 1, minHeight: 36, justifyContent: "center" },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.s3, marginTop: theme.space.s2 },
  switchText: { flex: 1, gap: 2 },
  logout: { marginTop: theme.space.s2 },
});
