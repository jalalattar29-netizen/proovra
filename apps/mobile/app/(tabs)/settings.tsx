import { StyleSheet, Text, View, Pressable, TextInput } from "react-native";
import { colors, radius, spacing, typography } from "@proovra/ui";
import { BottomNav, TopBar } from "../../components/ui";
import { useLocale } from "../../src/locale-context";
import { useMemo, useState } from "react";
import { apiFetch } from "../../src/api";
import { useAuth } from "../../src/auth-context";
import { useRouter } from "expo-router";
import * as FileSystem from "expo-file-system";
import { uploadWithPut } from "../../src/upload-utils";
import { Linking } from "react-native";

export default function SettingsScreen() {
  const { t, locale, setLocale, fontFamilyBold } = useLocale();
  const { setToken, token, authReady } = useAuth();
  const router = useRouter();
  const [googleToken, setGoogleToken] = useState("");
  const [appleToken, setAppleToken] = useState("");
  const [smokeLogs, setSmokeLogs] = useState<string[]>([]);
  const [smokeRunning, setSmokeRunning] = useState(false);
  const [smokeResult, setSmokeResult] = useState<"idle" | "pass" | "fail">("idle");
  const showSmoke = useMemo(
    () => __DEV__ && process.env.EXPO_PUBLIC_DEBUG_SMOKE === "1",
    []
  );

  const appendLog = (message: string) => {
    const stamp = new Date().toLocaleTimeString();
    setSmokeLogs((prev) => [...prev, `${stamp} ${message}`]);
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const pollReport = async (evidenceId: string) => {
    const delays = [2000, 3000, 5000, 8000, 12000, 15000, 15000, 15000];
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      try {
        const data = await apiFetch(`/v1/evidence/${evidenceId}/report/latest`, {
          method: "GET"
        });
        return data;
      } catch {
        appendLog("Report not ready yet...");
        await sleep(delays[attempt]);
      }
    }
    throw new Error("Report still generating");
  };

  const runSmokeTest = async () => {
    if (smokeRunning) return;
    setSmokeRunning(true);
    setSmokeLogs([]);
    setSmokeResult("idle");
    try {
      appendLog(`Auth ready: ${authReady ? "yes" : "no"}`);
      appendLog(`Token present: ${token ? "yes" : "no"}`);
      const me = await apiFetch("/v1/auth/me", { method: "GET" });
      appendLog(`Auth user: ${me.user?.id ?? "missing"}`);

      appendLog("Creating evidence...");
      const created = await apiFetch("/v1/evidence", {
        method: "POST",
        body: JSON.stringify({
          type: "PHOTO",
          mimeType: "text/plain",
          originalFilename: "smoke.txt",
          deviceTimeIso: new Date().toISOString()
        })
      });

      const testPath = `${FileSystem.cacheDirectory ?? ""}smoke-${Date.now()}.txt`;
      await FileSystem.writeAsStringAsync(testPath, "smoke-test");
      appendLog("Uploading via signed PUT...");
      const uploadResult = await uploadWithPut({
        putUrl: created.upload.putUrl,
        uri: testPath,
        mimeType: "text/plain"
      });
      appendLog(`PUT status ${uploadResult.status}`);

      appendLog("Completing evidence...");
      await apiFetch(`/v1/evidence/${created.id}/complete`, {
        method: "POST",
        body: JSON.stringify({
          sizeBytes: 10,
          durationMs: 0,
          originalFilename: "smoke.txt"
        })
      });

      appendLog("Polling report...");
      const report = await pollReport(created.id);
      const url = report?.url ?? report?.publicUrl ?? null;
      appendLog(url ? "Report ready" : "Report ready (no URL)");
      if (url) {
        appendLog("Opening report...");
        void Linking.openURL(url);
      }
      setSmokeResult("pass");
    } catch (err) {
      appendLog(err instanceof Error ? err.message : "Smoke test failed");
      setSmokeResult("fail");
    } finally {
      setSmokeRunning(false);
    }
  };
  return (
    <View style={styles.container}>
      <TopBar title={t("settings")} />
      <View style={styles.content}>
        <Text style={[styles.label, { fontFamily: fontFamilyBold }]}>{t("language")}</Text>
        <View style={styles.row}>
          {(["en", "ar", "de", "fr", "es", "tr", "ru"] as const).map((lng) => (
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
        <Pressable style={[styles.langButton, { marginTop: spacing.sm }]} onPress={() => router.push("/(stack)/billing")}>
          <Text style={styles.langText}>Manage Billing</Text>
        </Pressable>
        {showSmoke ? (
          <View style={styles.smokeCard}>
            <Text style={[styles.label, { fontFamily: fontFamilyBold }]}>
              Runtime Smoke Test
            </Text>
            <Text style={styles.smokeHint}>
              Dev-only. Runs auth → create → PUT → complete → report.
            </Text>
            <Pressable
              style={[
                styles.langButton,
                smokeRunning && { backgroundColor: colors.border }
              ]}
              onPress={runSmokeTest}
              disabled={smokeRunning}
            >
              <Text style={styles.langText}>
                {smokeRunning ? "Running..." : "Run Smoke Test"}
              </Text>
            </Pressable>
            {smokeResult !== "idle" ? (
              <Text
                style={[
                  styles.smokeResult,
                  smokeResult === "pass" ? styles.smokePass : styles.smokeFail
                ]}
              >
                {smokeResult === "pass" ? "PASS" : "FAIL"}
              </Text>
            ) : null}
            {smokeLogs.length > 0 ? (
              <View style={styles.smokeLog}>
                {smokeLogs.map((line, index) => (
                  <Text key={`${line}-${index}`} style={styles.smokeLogText}>
                    {line}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
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
  },
  smokeCard: {
    marginTop: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
    backgroundColor: colors.white
  },
  smokeHint: {
    color: colors.textDark,
    fontSize: 12,
    marginBottom: spacing.sm
  },
  smokeResult: {
    marginTop: spacing.sm,
    fontWeight: "700"
  },
  smokePass: {
    color: colors.green
  },
  smokeFail: {
    color: colors.red
  },
  smokeLog: {
    marginTop: spacing.sm,
    gap: 4
  },
  smokeLogText: {
    fontSize: 11,
    color: "#64748b"
  }
});
