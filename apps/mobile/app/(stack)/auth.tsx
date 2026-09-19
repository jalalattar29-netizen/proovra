import { useCallback, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { emailLogin, resendVerification } from "../../src/auth/auth-api";
import { useOAuth } from "../../src/auth/use-oauth";
import { useCompleteLogin } from "../../src/auth/use-auth-flow";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { theme } from "../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraInput,
  ProovraFormField,
} from "../../src/ui";
import { AuthBrandHeader } from "../../src/ui/brand";

/**
 * Auth Gateway / Sign In. Email+password, Google, Apple, plus links to Create
 * Account and Forgot Password. OAuth ceremony + result routing (session vs
 * MFA) go through the shared hooks; errors are sanitized (no raw provider
 * strings, no API-base debug leak).
 */
export default function AuthScreen() {
  const router = useRouter();
  const completeLogin = useCompleteLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SafeError | null>(null);
  const [unverified, setUnverified] = useState(false);

  const oauth = useOAuth({
    onResult: (result, mode) => {
      void completeLogin(result, mode);
    },
  });

  const submit = useCallback(async () => {
    setError(null);
    setUnverified(false);
    if (!email.trim() || !password) {
      setError({ kind: "input", title: "Check the details", message: "Enter your email and password." });
      return;
    }
    setBusy(true);
    try {
      const result = await emailLogin(email.trim(), password);
      await completeLogin(result, "email");
    } catch (err) {
      const safe = toSafeUserError(err);
      if (safe.code === "EMAIL_NOT_VERIFIED") {
        setUnverified(true);
        setError({ ...safe, message: "Verify your email to continue." });
      } else {
        setError(safe);
      }
    } finally {
      setBusy(false);
    }
  }, [email, password, completeLogin]);

  const oauthError = oauth.error;
  const shownError = error ?? oauthError;

  return (
    <ProovraScreen width="form">
      <AuthBrandHeader tagline="Sign in to capture and prove digital evidence." />

      <ProovraCard>
        <ProovraFormField label="Email">
          <ProovraInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoComplete="email"
            testID="auth-email"
          />
        </ProovraFormField>
        <ProovraFormField label="Password" error={shownError ? shownError.message : null}>
          <ProovraInput
            value={password}
            onChangeText={setPassword}
            placeholder="Your password"
            secureTextEntry
            autoComplete="password"
            onSubmitEditing={() => void submit()}
            testID="auth-password"
          />
        </ProovraFormField>

        {unverified ? (
          <ProovraButton
            label="Resend verification email"
            variant="ghost"
            fullWidth={false}
            onPress={() => void resendVerification(email.trim())}
          />
        ) : null}

        <ProovraButton label="Sign in" loading={busy} onPress={() => void submit()} testID="auth-signin" />
        <View style={styles.linkRow}>
          <ProovraButton label="Create account" variant="ghost" fullWidth={false} onPress={() => router.push("/register")} />
          <ProovraButton label="Forgot password?" variant="ghost" fullWidth={false} onPress={() => router.push("/forgot-password")} />
        </View>
      </ProovraCard>

      <View style={styles.divider}>
        <View style={styles.dividerLine} />
        <ProovraText variant="label" color={theme.color.ink.muted}>
          or continue with
        </ProovraText>
        <View style={styles.dividerLine} />
      </View>

      <View style={styles.oauth}>
        <ProovraButton
          label="Continue with Google"
          variant="secondary"
          loading={oauth.busy === "google"}
          onPress={oauth.promptGoogle}
        />
        {oauth.appleAvailable ? (
          <ProovraButton
            label="Continue with Apple"
            variant="secondary"
            loading={oauth.busy === "apple"}
            onPress={oauth.signInApple}
          />
        ) : null}
      </View>

      <View style={styles.legal}>
        <ProovraText variant="label" color={theme.color.ink.muted} center>
          By continuing you agree to the Terms and acknowledge the Privacy Policy.
        </ProovraText>
      </View>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  linkRow: { flexDirection: "row", justifyContent: "space-between", marginTop: theme.space.s2 },
  divider: { flexDirection: "row", alignItems: "center", gap: theme.space.s3, marginVertical: theme.space.s5 },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: theme.color.border.default },
  oauth: { gap: theme.space.s3 },
  legal: { marginTop: theme.space.s6 },
});
