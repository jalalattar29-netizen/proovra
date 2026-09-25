import { useCallback, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { verifyMfa } from "../../src/auth/auth-api";
import { useCompleteLogin, type LoginMode } from "../../src/auth/use-auth-flow";
import { toSafeUserError } from "../../src/errors/safe-error";
import { theme } from "../../src/theme/theme";
import { ProovraScreen, ProovraCard, ProovraText, ProovraButton, ProovraInput, ProovraFormField } from "../../src/ui";
import { MfaRecoveryRequestPanel } from "../../src/ui/mfa-recovery-request";
import { AuthBrandHeader } from "../../src/ui/brand";
import { AuthNote } from "../../src/ui/auth-form";

type ChallengeMode = "totp" | "recovery_code";

/**
 * The web's reading of a failed verify (auth/mfa-challenge/page.tsx:146-196):
 * three 401 reasons END the challenge (sign in again); a wrong code is
 * retryable. The raw reason is matched, never rendered.
 */
function mfaFailure(err: unknown, recovery: boolean): { expired: boolean; message: string } | null {
  const e = err as { statusCode?: number; body?: { message?: unknown }; message?: unknown } | null;
  const status = e?.statusCode;
  const reason = typeof e?.body?.message === "string" ? e.body.message : typeof e?.message === "string" ? e.message : "";
  if (status === 429) return { expired: false, message: "Too many attempts. Wait a minute before trying again." };
  if (status !== 401) return null;
  if (reason === "mfa_challenge_expired") return { expired: true, message: "Your two-factor challenge expired. Please sign in again to start a fresh challenge." };
  if (reason === "mfa_challenge_already_used") return { expired: true, message: "That two-factor challenge was already used. Please sign in again to start a fresh challenge." };
  if (reason === "mfa_pending_invalid") return { expired: true, message: "Your sign-in session ended. Please sign in again." };
  return {
    expired: false,
    message: recovery ? "That recovery code was not accepted. Each code is single-use." : "That code did not match. Check the timer on your authenticator and try again.",
  };
}

/**
 * MFA challenge — the web's /auth/mfa-challenge (auth/mfa-challenge/page.tsx).
 *
 * Reached when a login returns mfaRequired (the pending token rides in the
 * params). Three surfaces, as on the web:
 *   - `enroll=1` — the organization requires MFA and the account has no
 *     factor (auth.routes.ts:586-597, 403 mfaEnrollmentRequired). No code box;
 *     the way on is enrolment after a fresh sign-in (:222-262);
 *   - an ended challenge — "Sign-in session expired" + Return to sign in;
 *   - the verify form: authenticator code or single-use recovery code, the
 *     lost-factor recovery request, and "Still stuck? Contact support".
 */
export default function MfaScreen() {
  const router = useRouter();
  const completeLogin = useCompleteLogin();
  const params = useLocalSearchParams<{ pendingToken?: string; mode?: string; enroll?: string }>();
  const pendingToken = typeof params.pendingToken === "string" ? params.pendingToken : "";
  const enrollmentRequired = params.enroll === "1";
  const loginMode: LoginMode = params.mode === "google" || params.mode === "apple" ? params.mode : "email";
  // A challenge with no pending token cannot be completed (page.tsx:69-101).
  const [expired, setExpired] = useState<string | null>(
    pendingToken || enrollmentRequired ? null : "Your sign-in session has expired. Please sign in again.",
  );

  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [mode, setMode] = useState<ChallengeMode>("totp");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const recovery = mode === "recovery_code";

  const submit = useCallback(async () => {
    if (busy) return;
    setError(null);
    setStatus(null);
    if (!pendingToken) {
      setExpired("Your sign-in session ended. Please sign in again.");
      return;
    }
    let challenge: { code: string } | { recoveryCode: string };
    if (!recovery) {
      const digits = code.trim().replace(/\s+/g, "");
      if (!/^\d{6}$/.test(digits)) {
        setError("Enter the 6-digit code from your authenticator.");
        return;
      }
      challenge = { code: digits };
    } else {
      const trimmed = recoveryCode.trim();
      if (trimmed.length < 10) {
        setError("Enter a recovery code from your saved batch.");
        return;
      }
      challenge = { recoveryCode: trimmed };
    }
    setBusy(true);
    setStatus("Verifying second factor...");
    try {
      const session = await verifyMfa(pendingToken, challenge);
      await completeLogin({ kind: "session", token: session.token, user: session.user }, loginMode);
    } catch (err) {
      const read = mfaFailure(err, recovery);
      if (read?.expired) setExpired(read.message);
      else if (read) setError(read.message);
      else setError(toSafeUserError(err).message);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }, [busy, pendingToken, code, recoveryCode, recovery, loginMode, completeLogin]);

  const toggleMode = () => {
    setMode((m) => (m === "totp" ? "recovery_code" : "totp"));
    setError(null);
    setStatus(null);
    setCode("");
    setRecoveryCode("");
  };

  const toSignIn = () => router.replace("/(stack)/auth");
  const support = (lead: string) => (
    <View style={styles.supportRow}>
      <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{lead}</ProovraText>
      <ProovraButton label="Contact support" variant="ghost" fullWidth={false} onPress={() => router.push("/support")} />
    </View>
  );

  if (enrollmentRequired) {
    return (
      <ProovraScreen width="form">
        <AuthBrandHeader />
        <ProovraCard testID="mfa-enroll-required">
          <ProovraText variant="h2" weight="semibold" accessibilityRole="header">Set up two-factor authentication</ProovraText>
          <ProovraText variant="body" color={theme.color.ink.secondary}>
            Your organization requires two-factor authentication. To continue, you need to enroll an authenticator on your account.
          </ProovraText>
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
            Sign in again and your operator menu will guide you through enrollment. You will not be able to access workspace data until enrollment is complete.
          </ProovraText>
          <View style={styles.actions}>
            <ProovraButton label="Sign in to start enrollment" onPress={toSignIn} />
          </View>
          {support("Need help?")}
        </ProovraCard>
      </ProovraScreen>
    );
  }

  if (expired) {
    // A challenge that ended cannot be retried here: the only way on is a fresh sign-in.
    return (
      <ProovraScreen width="form">
        <AuthBrandHeader />
        <ProovraCard testID="mfa-expired">
          <ProovraText variant="h2" weight="semibold" accessibilityRole="header">Sign-in session expired</ProovraText>
          <ProovraText variant="body" color={theme.color.status.risk.fg}>{expired}</ProovraText>
          <View style={styles.actions}>
            <ProovraButton label="Return to sign in" onPress={toSignIn} />
          </View>
        </ProovraCard>
      </ProovraScreen>
    );
  }

  return (
    <ProovraScreen width="form">
      <AuthBrandHeader />
      <ProovraCard>
        <ProovraText variant="h2" weight="semibold" accessibilityRole="header">Two-factor verification</ProovraText>
        <ProovraText variant="body" color={theme.color.ink.secondary} style={styles.intro}>
          {recovery
            ? "Enter one of your single-use recovery codes. Each code works exactly once."
            : "Enter the 6-digit code from your authenticator app to finish signing in."}
        </ProovraText>
        {recovery ? (
          <ProovraFormField label="Recovery code">
            <ProovraInput
              value={recoveryCode}
              onChangeText={setRecoveryCode}
              placeholder="ABCDE-FGHJK"
              autoCapitalize="characters"
              accessibilityLabel="Single-use recovery code"
              editable={!busy}
              onSubmitEditing={() => void submit()}
            />
          </ProovraFormField>
        ) : (
          <ProovraFormField label="Authenticator code">
            <ProovraInput
              value={code}
              onChangeText={setCode}
              placeholder="123 456"
              keyboardType="number-pad"
              accessibilityLabel="Six-digit authenticator code"
              editable={!busy}
              onSubmitEditing={() => void submit()}
            />
          </ProovraFormField>
        )}
        {error ? <AuthNote tone="error" testID="mfa-error">{error}</AuthNote> : null}
        {status ? <AuthNote tone="status">{status}</AuthNote> : null}
        <View style={styles.actions}>
          <ProovraButton
            label={busy ? "Verifying..." : "Verify and continue"}
            accessibilityLabel="Verify and continue"
            loading={busy}
            onPress={() => void submit()}
          />
          <ProovraButton
            label={recovery ? "Use the authenticator code instead" : "Use a recovery code instead"}
            variant="ghost"
            onPress={toggleMode}
          />
        </View>
      </ProovraCard>

      {/*
        THE CREATE LEG. The verify leg and the admin approve/reject legs were
        wired long before anything in the product could FILE a request, and
        native had neither half — a user who lost their authenticator had a
        code box and nothing else. The panel resolves its own eligibility,
        because this route refuses an MFA-pending token and a control that
        401s on tap is worse than one that says why it cannot be used.
      */}
      <MfaRecoveryRequestPanel teamId={null} />
      {support("Still stuck?")}
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  intro: { marginTop: theme.space.s2, marginBottom: theme.space.s4 },
  actions: { marginTop: theme.space.s3, gap: theme.space.s2 },
  supportRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.space.s1, marginTop: theme.space.s4 },
});
