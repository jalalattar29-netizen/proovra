import { useCallback, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { requestPasswordReset } from "../../src/auth/auth-api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { theme } from "../../src/theme/theme";
import { ProovraScreen, ProovraCard, ProovraText, ProovraButton, ProovraInput, ProovraFormField, ProovraSection } from "../../src/ui";

/** Forgot password — request a reset link (always a neutral confirmation). */
export default function ForgotPasswordScreen() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<SafeError | null>(null);

  const submit = useCallback(async () => {
    setError(null);
    if (!email.trim()) {
      setError({ kind: "input", title: "Check the details", message: "Enter your email." });
      return;
    }
    setBusy(true);
    try {
      await requestPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      setError(toSafeUserError(err));
    } finally {
      setBusy(false);
    }
  }, [email]);

  return (
    <ProovraScreen width="form">
      <ProovraSection title="Reset your password">
        <ProovraCard>
          {sent ? (
            <>
              <ProovraText variant="body" color={theme.color.ink.secondary}>
                If an account exists for {email.trim()}, we sent a reset link. Open it on this device to set a new password.
              </ProovraText>
              <View style={styles.actions}>
                <ProovraButton label="Back to sign in" variant="secondary" onPress={() => router.replace("/(stack)/auth")} />
              </View>
            </>
          ) : (
            <>
              <ProovraFormField label="Email" error={error ? error.message : null}>
                <ProovraInput value={email} onChangeText={setEmail} placeholder="you@example.com" keyboardType="email-address" autoComplete="email" />
              </ProovraFormField>
              <ProovraButton label="Send reset link" loading={busy} onPress={() => void submit()} />
              <View style={styles.actions}>
                <ProovraButton label="Back to sign in" variant="ghost" onPress={() => router.back()} />
              </View>
            </>
          )}
        </ProovraCard>
      </ProovraSection>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({ actions: { marginTop: theme.space.s3 } });
