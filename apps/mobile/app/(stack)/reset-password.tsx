import { useCallback, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { confirmPasswordReset } from "../../src/auth/auth-api";
import { theme } from "../../src/theme/theme";
import { ProovraScreen, ProovraCard, ProovraButton, ProovraFormField } from "../../src/ui";
import { ProovraPasswordRules, passwordMeetsRules } from "../../src/ui/password-rules";
import { AuthBrandHeader } from "../../src/ui/brand";
import { AuthCardHead, AuthNote, AuthPasswordInput } from "../../src/ui/auth-form";

/**
 * The server answers a failed confirm with `{ message: reason }`; an invalid or
 * expired token gets the dedicated expired-link state, as on the web.
 */
function failureReason(err: unknown): string | null {
  const e = err as { code?: unknown; body?: { message?: unknown } } | null;
  const body = e?.body?.message;
  if (typeof body === "string") return body;
  return typeof e?.code === "string" ? e.code : null;
}

/**
 * Reset password — reached via the emailed deep link (carries ?token=).
 *
 * The web page (app/reset-password/page.tsx): three cards. A link with NO
 * token is the "Reset link expired" card straight away (:272-274) — never a
 * form that cannot submit. The form is "Password Access" / "Create a new
 * password" with a show/hide on each field, the shared rules panel, and
 * "Reset password" ("Resetting password…" while it works); it answers on
 * submit. Success is the "Password updated" card.
 */
export default function ResetPasswordScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const token = typeof params.token === "string" ? params.token.trim() : "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [linkInvalid, setLinkInvalid] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Said as soon as the second entry diverges, as the web does.
  const mismatch = confirm.length > 0 && password !== confirm;

  const submit = useCallback(async () => {
    if (busy) return;
    setTouched(true);
    if (!token) {
      setLinkInvalid(true);
      return;
    }
    if (!passwordMeetsRules(password)) {
      setError("Your password does not meet the requirements listed below the password field.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await confirmPasswordReset(token, password);
      setDone(true);
    } catch (err) {
      const reason = failureReason(err);
      if (reason === "INVALID_OR_EXPIRED" || reason === "invalid_or_expired" || reason === "invalid_token") {
        setLinkInvalid(true);
      } else if (reason === "RATE_LIMITED" || reason === "too_many_requests") {
        setError("Too many requests. Please try again in a minute.");
      } else {
        setError("We couldn’t reset your password right now. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }, [busy, token, password, confirm]);

  const toSignIn = () => router.replace("/(stack)/auth");

  if (!token || linkInvalid) {
    return (
      <ProovraScreen width="form" backdrop="auth">
        <AuthBrandHeader />
        <ProovraCard testID="reset-link-expired">
          <View accessibilityRole="alert">
            <AuthCardHead
              eyebrow="Link expired"
              title="Reset link expired"
              subtitle="This password reset link is invalid or has expired. Request a new reset link to continue."
            />
          </View>
          <View style={styles.actions}>
            <ProovraButton label="Request new link" onPress={() => router.replace("/(stack)/forgot-password")} />
            <ProovraButton label="Back to sign in" variant="ghost" onPress={toSignIn} />
          </View>
        </ProovraCard>
      </ProovraScreen>
    );
  }

  if (done) {
    return (
      <ProovraScreen width="form" backdrop="auth">
        <AuthBrandHeader />
        <ProovraCard testID="reset-done">
          <View accessibilityLiveRegion="polite">
            <AuthCardHead eyebrow="Password updated" title="Password updated" subtitle="You can now sign in with your new password." />
          </View>
          <View style={styles.actions}>
            <ProovraButton label="Back to sign in" onPress={toSignIn} />
          </View>
        </ProovraCard>
      </ProovraScreen>
    );
  }

  return (
    <ProovraScreen width="form" backdrop="auth">
      <AuthBrandHeader />
      <ProovraCard>
        <AuthCardHead
          eyebrow="Password Access"
          title="Create a new password"
          subtitle="Choose a strong password to secure your PROOVRA account."
        />
        <ProovraFormField label="New password">
          <AuthPasswordInput
            value={password}
            onChangeText={setPassword}
            placeholder="New password"
            accessibilityLabel="New password"
            editable={!busy}
            testID="reset-new"
          />
        </ProovraFormField>
        <ProovraPasswordRules password={password} visible={password.length > 0 || touched} touched={touched} />
        <ProovraFormField label="Confirm new password" error={mismatch ? "Passwords don’t match." : null}>
          <AuthPasswordInput
            value={confirm}
            onChangeText={setConfirm}
            placeholder="Confirm new password"
            accessibilityLabel="Confirm new password"
            toggleNoun="confirm password"
            editable={!busy}
            testID="reset-confirm"
          />
        </ProovraFormField>
        <View style={styles.actions}>
          <ProovraButton
            label={busy ? "Resetting password…" : "Reset password"}
            accessibilityLabel="Reset password"
            loading={busy}
            onPress={() => void submit()}
          />
          <ProovraButton label="Back to sign in" variant="ghost" onPress={toSignIn} />
        </View>
        {error ? <AuthNote tone="error">{error}</AuthNote> : null}
      </ProovraCard>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({ actions: { marginTop: theme.space.s3, gap: theme.space.s2 } });
