import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import {
  SIGN_IN_PASSKEY_RETURN_URL,
  fetchSignInMethods,
  sendSignInCode,
  verifyMfa,
  type SignInMethod,
} from "../../src/auth/auth-api";
import { useCompleteLogin, type LoginMode } from "../../src/auth/use-auth-flow";
import { toSafeUserError } from "../../src/errors/safe-error";
import { theme } from "../../src/theme/theme";
import { ProovraScreen, ProovraCard, ProovraText, ProovraButton, ProovraInput, ProovraFormField } from "../../src/ui";
import { MfaEnrollmentAtSignIn } from "../../src/ui/mfa-enrollment-at-sign-in";
import { MfaRecoveryRequestPanel } from "../../src/ui/mfa-recovery-request";
import { AuthBrandHeader } from "../../src/ui/brand";
import { AuthNote } from "../../src/ui/auth-form";

type ChallengeMode = "passkey" | "totp" | "contact" | "recovery_code";

function modeFor(method: SignInMethod): ChallengeMode {
  if (method === "PASSKEY") return "passkey";
  if (method === "TOTP") return "totp";
  if (method === "SMS" || method === "WHATSAPP") return "contact";
  return "recovery_code";
}

const SWITCH_LABEL: Record<ChallengeMode, string> = {
  passkey: "Use a passkey or security key instead",
  totp: "Use the authenticator code instead",
  contact: "Send a code to your phone instead",
  recovery_code: "Use a recovery code instead",
};

/**
 * The web's reading of a failed verify (auth/mfa-challenge/page.tsx:146-196):
 * three 401 reasons END the challenge (sign in again); a wrong code is
 * retryable. The raw reason is matched, never rendered.
 */
function mfaFailure(err: unknown, mode: ChallengeMode): { expired: boolean; message: string } | null {
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
    message:
      mode === "recovery_code"
        ? "That recovery code was not accepted. Each code is single-use."
        : mode === "contact"
          ? "That code did not match. Check the latest message and try again, or send a new code."
          : mode === "passkey"
            ? "Your passkey wasn't confirmed. Try again, or choose another way to sign in."
            : "That code did not match. Check the timer on your authenticator and try again.",
  };
}

/**
 * MFA challenge — the web's /auth/mfa-challenge (auth/mfa-challenge/page.tsx).
 *
 * Reached when a login returns mfaRequired (the pending token rides in the
 * params). Three surfaces, as on the web:
 *   - `enroll=1` — the organization requires MFA and the account has no
 *     factor (403 mfaEnrollmentRequired). The factor is added here, with the
 *     refused sign-in's own token, and that finishes the sign-in;
 *   - an ended challenge — "Sign-in session expired" + Return to sign in;
 *   - the verify form: the second factors THIS person enrolled (read from
 *     POST /v1/auth/mfa/methods — AUTH-LOCKOUT-NONTOTP): a passkey, proved in
 *     the system browser (/auth/mfa-passkey) because the app has no WebAuthn;
 *     an authenticator code; a code sent to their verified phone; or a
 *     single-use recovery code. Then the lost-factor recovery request and
 *     "Still stuck? Contact support".
 */
export default function MfaScreen() {
  const router = useRouter();
  const completeLogin = useCompleteLogin();
  const params = useLocalSearchParams<{ pendingToken?: string; mode?: string; enroll?: string }>();
  const pendingToken = typeof params.pendingToken === "string" ? params.pendingToken : "";
  const enrollmentRequired = params.enroll === "1";
  const loginMode: LoginMode =
    params.mode === "google" || params.mode === "apple" || params.mode === "sso" ? params.mode : "email";
  // A challenge with no pending token cannot be completed (page.tsx:69-101).
  const [expired, setExpired] = useState<string | null>(
    pendingToken || enrollmentRequired ? null : "Your sign-in session has expired. Please sign in again.",
  );

  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [mode, setMode] = useState<ChallengeMode>("totp");
  const [available, setAvailable] = useState<ChallengeMode[] | null>(null);
  const [destinationMask, setDestinationMask] = useState<string | null>(null);
  const [passkeyUrl, setPasskeyUrl] = useState<string | null>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [contactCode, setContactCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const recovery = mode === "recovery_code";

  /** Reads (and arms a fresh passkey handoff for) what this sign-in accepts. */
  const loadMethods = useCallback(async (): Promise<ChallengeMode[] | null> => {
    if (!pendingToken) return null;
    try {
      const read = await fetchSignInMethods(pendingToken);
      if (!read) return null;
      setDestinationMask(read.destinationMask);
      setPasskeyUrl(read.passkeyHandoffUrl);
      return Array.from(new Set(read.methods.map(modeFor)));
    } catch {
      return null;
    }
  }, [pendingToken]);

  useEffect(() => {
    if (enrollmentRequired || !pendingToken) return;
    let cancelled = false;
    void loadMethods().then((modes) => {
      if (cancelled || !modes) return;
      setAvailable(modes);
      setMode(modes[0]!);
    });
    return () => {
      cancelled = true;
    };
  }, [enrollmentRequired, pendingToken, loadMethods]);

  /** The one completion path every factor shares. */
  const finishWith = useCallback(
    async (challenge: Parameters<typeof verifyMfa>[1], method: ChallengeMode) => {
      setBusy(true);
      setStatus("Verifying second factor...");
      try {
        const session = await verifyMfa(pendingToken, challenge);
        await completeLogin({ kind: "session", token: session.token, user: session.user }, loginMode);
      } catch (err) {
        const read = mfaFailure(err, method);
        if (read?.expired) setExpired(read.message);
        else if (read) setError(read.message);
        else setError(toSafeUserError(err).message);
        setStatus(null);
        // A passkey handoff is single-use: arm a fresh one for the retry.
        if (method === "passkey") void loadMethods();
      } finally {
        setBusy(false);
      }
    },
    [pendingToken, completeLogin, loginMode, loadMethods],
  );

  const signInWithPasskey = useCallback(async () => {
    if (busy) return;
    setError(null);
    setStatus(null);
    const url = passkeyUrl;
    if (!url) {
      setError("Passkey sign-in isn't available right now. Choose another way to sign in.");
      return;
    }
    setPasskeyUrl(null);
    // The browser proves the passkey; whatever it reports, the server decides.
    await WebBrowser.openAuthSessionAsync(url, SIGN_IN_PASSKEY_RETURN_URL);
    await finishWith({ passkeyHandoff: true }, "passkey");
  }, [busy, passkeyUrl, finishWith]);

  const sendCode = useCallback(async () => {
    if (busy) return;
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      const sent = await sendSignInCode(pendingToken);
      setCodeSent(true);
      const mask = sent.destinationMask ?? destinationMask;
      setStatus(mask ? `We sent a code to ${mask}.` : "We sent a code to your phone.");
    } catch (err) {
      const e = err as { statusCode?: number } | null;
      if (e?.statusCode === 429) setError("Too many codes requested. Wait a few minutes before trying again.");
      else if (e?.statusCode === 401) setExpired("Your sign-in session ended. Please sign in again.");
      else setError("We couldn't send a code right now. Choose another way to sign in, or try again shortly.");
    } finally {
      setBusy(false);
    }
  }, [busy, pendingToken, destinationMask]);

  const submit = useCallback(async () => {
    if (busy) return;
    setError(null);
    setStatus(null);
    if (!pendingToken) {
      setExpired("Your sign-in session ended. Please sign in again.");
      return;
    }
    if (mode === "passkey") {
      await signInWithPasskey();
      return;
    }
    if (mode === "contact") {
      if (!codeSent) {
        await sendCode();
        return;
      }
      const digits = contactCode.replace(/\s+/g, "");
      if (!/^\d{4,10}$/.test(digits)) {
        setError("Enter the code from the message we sent.");
        return;
      }
      await finishWith({ contactCode: digits }, "contact");
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
    await finishWith(challenge, mode);
  }, [busy, pendingToken, code, recoveryCode, recovery, mode, codeSent, contactCode, signInWithPasskey, sendCode, finishWith]);

  const toggleMode = () => {
    setMode((m) => (m === "totp" ? "recovery_code" : "totp"));
    setError(null);
    setStatus(null);
    setCode("");
    setRecoveryCode("");
  };

  const switchTo = (target: ChallengeMode) => {
    setMode(target);
    setError(null);
    setStatus(null);
    setCode("");
    setRecoveryCode("");
    setContactCode("");
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
        <MfaEnrollmentAtSignIn
          onRestart={toSignIn}
          support={support("Need help?")}
          onSignedIn={(session, hold) =>
            completeLogin({ kind: "session", token: session.token, user: session.user }, hold.mode, {
              legalAcceptedSource: hold.legalAcceptedSource,
            })
          }
        />
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
            : mode === "passkey"
              ? "Use your passkey or security key to finish signing in. A secure browser window will open."
              : mode === "contact"
                ? `We'll send a one-time code to your verified phone${destinationMask ? ` (${destinationMask})` : ""}.`
                : "Enter the 6-digit code from your authenticator app to finish signing in."}
        </ProovraText>
        {mode === "passkey" ? null : mode === "contact" ? (
          codeSent ? (
            <ProovraFormField label="Code from your phone">
              <ProovraInput
                value={contactCode}
                onChangeText={setContactCode}
                placeholder="123456"
                keyboardType="number-pad"
                accessibilityLabel="Code sent to your phone"
                editable={!busy}
                onSubmitEditing={() => void submit()}
              />
            </ProovraFormField>
          ) : null
        ) : recovery ? (
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
          {mode === "passkey" ? (
            <ProovraButton label={busy ? "Verifying..." : "Continue with passkey"} loading={busy} onPress={() => void submit()} />
          ) : mode === "contact" && !codeSent ? (
            <ProovraButton label="Send code" loading={busy} onPress={() => void submit()} />
          ) : (
            <ProovraButton
              label={busy ? "Verifying..." : "Verify and continue"}
              accessibilityLabel="Verify and continue"
              loading={busy}
              onPress={() => void submit()}
            />
          )}
          {mode === "contact" && codeSent ? (
            <ProovraButton label="Send a new code" variant="ghost" onPress={() => void sendCode()} />
          ) : null}
          {available ? (
            available
              .filter((m) => m !== mode)
              .map((m) => <ProovraButton key={m} label={SWITCH_LABEL[m]} variant="ghost" onPress={() => switchTo(m)} />)
          ) : (
            <ProovraButton
              label={recovery ? "Use the authenticator code instead" : "Use a recovery code instead"}
              variant="ghost"
              onPress={toggleMode}
            />
          )}
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
