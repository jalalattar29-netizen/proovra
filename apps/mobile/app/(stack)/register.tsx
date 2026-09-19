import { useCallback, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { registerAccount, resendVerification } from "../../src/auth/auth-api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { theme } from "../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraInput,
  ProovraFormField,
  ProovraSection,
} from "../../src/ui";

/** Create Account — verification-first (register returns no session). */
export default function RegisterScreen() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SafeError | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setError(null);
    if (!email.trim() || password.length < 12) {
      setError({ kind: "input", title: "Check the details", message: "Enter a valid email and a password of at least 12 characters." });
      return;
    }
    setBusy(true);
    try {
      const res = await registerAccount({ email: email.trim(), password, displayName: displayName.trim() || undefined });
      setSentTo(res.email);
    } catch (err) {
      setError(toSafeUserError(err));
    } finally {
      setBusy(false);
    }
  }, [email, password, displayName]);

  if (sentTo) {
    return (
      <ProovraScreen width="form">
        <ProovraSection title="Check your email">
          <ProovraCard>
            <ProovraText variant="body" color={theme.color.ink.secondary}>
              We sent a verification link to {sentTo}. Open it on this device to finish creating your account and accept the terms.
            </ProovraText>
            <View style={styles.actions}>
              <ProovraButton label="Resend email" variant="secondary" onPress={() => void resendVerification(sentTo)} />
              <ProovraButton label="Back to sign in" variant="ghost" onPress={() => router.replace("/(stack)/auth")} />
            </View>
          </ProovraCard>
        </ProovraSection>
      </ProovraScreen>
    );
  }

  return (
    <ProovraScreen width="form">
      <ProovraSection title="Create account">
        <ProovraCard>
          <ProovraFormField label="Name">
            <ProovraInput value={displayName} onChangeText={setDisplayName} placeholder="Your name" autoCapitalize="words" />
          </ProovraFormField>
          <ProovraFormField label="Email">
            <ProovraInput value={email} onChangeText={setEmail} placeholder="you@example.com" keyboardType="email-address" autoComplete="email" />
          </ProovraFormField>
          <ProovraFormField label="Password" error={error ? error.message : null}>
            <ProovraInput value={password} onChangeText={setPassword} placeholder="At least 12 characters" secureTextEntry autoComplete="password" />
          </ProovraFormField>
          <ProovraButton label="Create account" loading={busy} onPress={() => void submit()} />
          <View style={styles.actions}>
            <ProovraButton label="Already have an account? Sign in" variant="ghost" onPress={() => router.replace("/(stack)/auth")} />
          </View>
          <ProovraText variant="label" color={theme.color.ink.muted} style={styles.legal}>
            Creating an account means you agree to the Terms and Privacy Policy.
          </ProovraText>
        </ProovraCard>
      </ProovraSection>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  actions: { marginTop: theme.space.s3, gap: theme.space.s2 },
  legal: { marginTop: theme.space.s3 },
});
