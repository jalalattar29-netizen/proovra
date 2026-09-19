import { useCallback, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { verifyMfa } from "../../src/auth/auth-api";
import { useCompleteLogin, type LoginMode } from "../../src/auth/use-auth-flow";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { theme } from "../../src/theme/theme";
import { ProovraScreen, ProovraCard, ProovraText, ProovraButton, ProovraInput, ProovraFormField, ProovraSection } from "../../src/ui";
import { AuthBrandHeader } from "../../src/ui/brand";

/** MFA challenge — reached when a login returns mfaRequired (pending token). */
export default function MfaScreen() {
  const completeLogin = useCompleteLogin();
  const params = useLocalSearchParams<{ pendingToken?: string; mode?: string }>();
  const pendingToken = typeof params.pendingToken === "string" ? params.pendingToken : "";
  const mode: LoginMode = params.mode === "google" || params.mode === "apple" ? params.mode : "email";

  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SafeError | null>(null);

  const submit = useCallback(async () => {
    setError(null);
    if (!pendingToken) {
      setError({ kind: "auth", title: "Session ended", message: "This challenge expired. Please sign in again." });
      return;
    }
    if (!code.trim()) {
      setError({ kind: "input", title: "Check the details", message: useRecovery ? "Enter a recovery code." : "Enter your 6-digit code." });
      return;
    }
    setBusy(true);
    try {
      const session = await verifyMfa(pendingToken, useRecovery ? { recoveryCode: code.trim() } : { code: code.trim() });
      await completeLogin({ kind: "session", token: session.token, user: session.user }, mode);
    } catch (err) {
      setError(toSafeUserError(err));
    } finally {
      setBusy(false);
    }
  }, [pendingToken, code, useRecovery, mode, completeLogin]);

  return (
    <ProovraScreen width="form">
      <AuthBrandHeader />
      <ProovraSection title="Two-factor verification">
        <ProovraCard>
          <ProovraText variant="body" color={theme.color.ink.secondary} style={styles.intro}>
            {useRecovery ? "Enter one of your recovery codes." : "Enter the 6-digit code from your authenticator app."}
          </ProovraText>
          <ProovraFormField label={useRecovery ? "Recovery code" : "Authentication code"} error={error ? error.message : null}>
            <ProovraInput
              value={code}
              onChangeText={setCode}
              placeholder={useRecovery ? "xxxx-xxxx" : "123456"}
              keyboardType={useRecovery ? "default" : "number-pad"}
              onSubmitEditing={() => void submit()}
            />
          </ProovraFormField>
          <ProovraButton label="Verify" loading={busy} onPress={() => void submit()} />
          <View style={styles.actions}>
            <ProovraButton
              label={useRecovery ? "Use authenticator code" : "Use a recovery code"}
              variant="ghost"
              onPress={() => { setUseRecovery((v) => !v); setCode(""); setError(null); }}
            />
          </View>
        </ProovraCard>
      </ProovraSection>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({ intro: { marginBottom: theme.space.s4 }, actions: { marginTop: theme.space.s2 } });
