import { useCallback, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { requestPasswordReset } from "../../src/auth/auth-api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { theme } from "../../src/theme/theme";
import { ProovraScreen, ProovraCard, ProovraText, ProovraButton, ProovraInput, ProovraFormField, ProovraSection } from "../../src/ui";
import { AuthBrandHeader } from "../../src/ui/brand";

// The web's check, verbatim (apps/web/components/marketing/ForgotPasswordModal.tsx).
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Forgot password — request a reset link (always a neutral confirmation). */
export default function ForgotPasswordScreen() {
  const router = useRouter();
  // The web links here as `?email=` from Create account when the address is
  // already registered (register/page.tsx:1204-1216); carry it so it is not retyped.
  const params = useLocalSearchParams<{ email?: string }>();
  const [email, setEmail] = useState(typeof params.email === "string" ? params.email : "");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<SafeError | null>(null);

  const submit = useCallback(async () => {
    setError(null);
    // The web's own gate (ForgotPasswordModal.tsx): the server's zod schema
    // (`z.string().email()`) would only answer a malformed address with a 400
    // the user cannot act on, so refuse it here in the web's words.
    if (!EMAIL_SHAPE.test(email.trim())) {
      setError({ kind: "input", title: "Check the details", message: "Enter a valid email address." });
      return;
    }
    setBusy(true);
    try {
      await requestPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      // The per-IP limiter answers 429 { message: "too_many_requests" } with no
      // code, which the generic classifier can only call "Please try again."
      if ((err as { statusCode?: number } | null)?.statusCode === 429) {
        setError({ kind: "unknown", title: "Too many requests", message: "Too many requests. Please try again in a minute." });
      } else {
        // The web collapses every other failure to one sentence (ForgotPasswordModal.tsx:131)
        // — anything more specific would leak whether the address has an account.
        setError({ ...toSafeUserError(err), message: "We couldn’t send the reset email right now. Please try again." });
      }
    } finally {
      setBusy(false);
    }
  }, [email]);

  return (
    <ProovraScreen width="form" backdrop="auth">
      <AuthBrandHeader />
      {/* NEW:FORGOT-PW-FLOW — the web request step, in its words (ForgotPasswordModal.tsx). */}
      <ProovraSection title={sent ? "Check your email" : "Reset your password"}>
        <ProovraCard>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.muted}>Password reset</ProovraText>
          {sent ? (
            <>
              <ProovraText variant="body" color={theme.color.ink.secondary}>
                If an account exists for this address, a secure password reset link has been sent.
              </ProovraText>
              <View style={styles.actions}>
                <ProovraButton label="Back to sign in" variant="secondary" onPress={() => router.replace("/(stack)/auth")} />
                <ProovraButton label="Send again" variant="ghost" onPress={() => setSent(false)} />
              </View>
            </>
          ) : (
            <>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                Enter the email address associated with your PROOVRA account. If an account exists, we’ll send a secure password reset link.
              </ProovraText>
              <ProovraFormField label="Email address" error={error ? error.message : null}>
                <ProovraInput
                  value={email}
                  onChangeText={(v) => {
                    setEmail(v);
                    if (error) setError(null);
                  }}
                  placeholder="you@example.com"
                  keyboardType="email-address"
                  autoComplete="email"
                />
              </ProovraFormField>
              {busy && !error ? (
                <ProovraText variant="label" color={theme.color.ink.secondary} accessibilityRole="text">Sending secure reset link…</ProovraText>
              ) : null}
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
