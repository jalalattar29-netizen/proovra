import { useCallback, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { confirmPasswordReset } from "../../src/auth/auth-api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { theme } from "../../src/theme/theme";
import { ProovraScreen, ProovraCard, ProovraText, ProovraButton, ProovraInput, ProovraFormField, ProovraSection } from "../../src/ui";

/** Reset password — reached via the emailed deep link (carries ?token=). */
export default function ResetPasswordScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const token = typeof params.token === "string" ? params.token : "";
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<SafeError | null>(null);

  const submit = useCallback(async () => {
    setError(null);
    if (!token) {
      setError({ kind: "input", title: "Link invalid", message: "This reset link is missing or expired. Request a new one." });
      return;
    }
    if (password.length < 12) {
      setError({ kind: "input", title: "Check the details", message: "Password must be at least 12 characters." });
      return;
    }
    setBusy(true);
    try {
      await confirmPasswordReset(token, password);
      setDone(true);
    } catch (err) {
      setError(toSafeUserError(err));
    } finally {
      setBusy(false);
    }
  }, [token, password]);

  return (
    <ProovraScreen>
      <ProovraSection title="Set a new password">
        <ProovraCard>
          {done ? (
            <>
              <ProovraText variant="body" color={theme.color.ink.secondary}>
                Your password was updated. Sign in with your new password.
              </ProovraText>
              <View style={styles.actions}>
                <ProovraButton label="Go to sign in" onPress={() => router.replace("/(stack)/auth")} />
              </View>
            </>
          ) : (
            <>
              <ProovraFormField label="New password" error={error ? error.message : null}>
                <ProovraInput value={password} onChangeText={setPassword} placeholder="At least 12 characters" secureTextEntry />
              </ProovraFormField>
              <ProovraButton label="Update password" loading={busy} onPress={() => void submit()} />
            </>
          )}
        </ProovraCard>
      </ProovraSection>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({ actions: { marginTop: theme.space.s3 } });
