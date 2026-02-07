import { Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { colors, radius, spacing, typography } from "@proovra/ui";
import { BottomNav, TopBar } from "../../components/ui";
import { useLocale } from "../../src/locale-context";
import { useState } from "react";
import { apiFetch } from "../../src/api";
import { useAuth } from "../../src/auth-context";

export default function SettingsScreen() {
  const { t, locale, setLocale, fontFamilyBold } = useLocale();
  const { setToken } = useAuth();
  const [googleToken, setGoogleToken] = useState("");
  const [appleToken, setAppleToken] = useState("");
  return (
    <View style={styles.container}>
      <TopBar title={t("settings")} />
      <View style={styles.content}>
        <Text style={[styles.label, { fontFamily: fontFamilyBold }]}>{t("language")}</Text>
        <View style={styles.row}>
          {(["en", "ar", "de"] as const).map((lng) => (
            <Pressable
              key={lng}
              onPress={() => setLocale(lng)}
              style={[styles.langButton, locale === lng && styles.langButtonActive]}
            >
              <Text
                style={[
                  styles.langText,
                  locale === lng && { color: colors.white }
                ]}
              >
                {lng.toUpperCase()}
              </Text>
            </Pressable>
          ))}
        </View>
        <Pressable style={[styles.langButton, { marginTop: spacing.lg }]} onPress={() => Linking.openURL("https://www.proovra.com/pricing")}>
          <Text style={styles.langText}>View Pricing</Text>
        </Pressable>
        <Text style={[styles.label, { fontFamily: fontFamilyBold, marginTop: spacing.lg }]}>
          Sign in
        </Text>
        <TextInput
          placeholder="Google idToken"
          value={googleToken}
          onChangeText={setGoogleToken}
          style={styles.input}
        />
        <Pressable
          style={[styles.langButton]}
          onPress={async () => {
            const data = await apiFetch("/v1/auth/google", {
              method: "POST",
              body: JSON.stringify({ idToken: googleToken })
            });
            setToken(data.token);
          }}
        >
          <Text style={styles.langText}>Sign in with Google</Text>
        </Pressable>
        <TextInput
          placeholder="Apple idToken"
          value={appleToken}
          onChangeText={setAppleToken}
          style={styles.input}
        />
        <Pressable
          style={[styles.langButton]}
          onPress={async () => {
            const data = await apiFetch("/v1/auth/apple", {
              method: "POST",
              body: JSON.stringify({ idToken: appleToken })
            });
            setToken(data.token);
          }}
        >
          <Text style={styles.langText}>Sign in with Apple</Text>
        </Pressable>
      </View>
      <BottomNav />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.lightBg
  },
  content: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl
  },
  label: {
    fontSize: typography.size.h3,
    color: colors.textDark,
    marginBottom: spacing.sm
  },
  row: {
    flexDirection: "row",
    gap: spacing.sm
  },
  langButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white
  },
  langButtonActive: {
    backgroundColor: colors.primaryNavy,
    borderColor: colors.primaryNavy
  },
  langText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textDark
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    marginTop: spacing.sm,
    backgroundColor: colors.white
  }
});
