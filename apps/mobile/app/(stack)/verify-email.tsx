import { useCallback, useEffect, useRef, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { resendVerification, verifyEmail } from "../../src/auth/auth-api";
import { useCompleteLogin } from "../../src/auth/use-auth-flow";
import { theme } from "../../src/theme/theme";
import { ProovraScreen, ProovraCard, ProovraButton, ProovraSection, ProovraLoadingState, ProovraText, ProovraFormField, ProovraInput } from "../../src/ui";

/**
 * Email verification — reached via the emailed deep link (carries ?token=).
 *
 * The web's states (auth/verify-email/page.tsx): any failure is the
 * invalid-or-expired card with an email field to send a fresh link; a resend
 * lands on "Email sent / Check your inbox" or "Retry needed". The resend is
 * held for a minute after each attempt, as on the web.
 */
type State = "verifying" | "success" | "missing-token" | "invalid" | "resend-sent" | "resend-error";
type Session = Awaited<ReturnType<typeof verifyEmail>>;

const RESEND_HOLD_MS = 60_000;
/** The web shows "Email verified" for this long before continuing (verify-email/page.tsx:141). */
const SUCCESS_HOLD_MS = 1_200;

export default function VerifyEmailScreen() {
  const router = useRouter();
  const completeLogin = useCompleteLogin();
  const params = useLocalSearchParams<{ token?: string }>();
  const token = typeof params.token === "string" ? params.token : "";
  const [state, setState] = useState<State>("verifying");
  const [email, setEmail] = useState("");
  const [resendBusy, setResendBusy] = useState(false);
  const fired = useRef(false);
  const session = useRef<Session | null>(null);
  const continued = useRef(false);
  // Timers die with the screen: a hold that outlived it set state on an
  // unmounted screen (and kept a test process alive for a minute).
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // Once only: the timer and the button both lead here.
  const continueToApp = useCallback(() => {
    const s = session.current;
    if (!s || continued.current) return;
    continued.current = true;
    void completeLogin({ kind: "session", token: s.token, user: s.user }, "email");
  }, [completeLogin]);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void (async () => {
      if (!token) {
        // No token is a different failure from a dead one: the web says the link was not recognised.
        setState("missing-token");
        return;
      }
      try {
        session.current = await verifyEmail(token);
        setState("success");
        timers.current.push(setTimeout(continueToApp, SUCCESS_HOLD_MS));
      } catch {
        setState("invalid");
      }
    })();
  }, [token, continueToApp]);

  const resend = async () => {
    const trimmed = email.trim();
    if (resendBusy || !trimmed) return;
    setResendBusy(true);
    try {
      await resendVerification(trimmed);
      setState("resend-sent");
    } catch {
      setState("resend-error");
    } finally {
      timers.current.push(setTimeout(() => setResendBusy(false), RESEND_HOLD_MS));
    }
  };

  const backToSignIn = <ProovraButton label="Back to sign in" variant="ghost" onPress={() => router.replace("/(stack)/auth")} />;
  const form = (
    <>
      <ProovraFormField label="Email address">
        <ProovraInput value={email} onChangeText={setEmail} placeholder="you@example.com" keyboardType="email-address" autoCapitalize="none" accessibilityLabel="Email address" />
      </ProovraFormField>
      <ProovraButton label={resendBusy ? "Resend pending…" : "Resend verification email"} disabled={resendBusy || !email.trim()} onPress={() => void resend()} />
      {backToSignIn}
    </>
  );

  return (
    <ProovraScreen scroll={false} width="form" backdrop="auth">
      <ProovraSection title="Verifying your email">
        <ProovraCard>
          {state === "verifying" ? (
            <View style={styles.stack}>
              <ProovraLoadingState label="Confirming your account" />
              <ProovraText variant="bodySm" color={theme.color.ink.secondary} center>
                One moment while we confirm the verification link.
              </ProovraText>
            </View>
          ) : state === "success" ? (
            <View style={styles.stack} testID="verify-success">
              <ProovraText variant="label" weight="semibold" color={theme.color.status.verified.fg}>Verified</ProovraText>
              <ProovraText variant="h3" weight="semibold">Email verified</ProovraText>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                Your account has been successfully verified. You’ll land in your PROOVRA workspace in a moment.
              </ProovraText>
              <ProovraButton label="Continue to PROOVRA" onPress={continueToApp} />
            </View>
          ) : state === "missing-token" ? (
            <View style={styles.stack} testID="verify-missing-token">
              <ProovraText variant="label" weight="semibold" color={theme.color.status.risk.fg}>Missing token</ProovraText>
              <ProovraText variant="h3" weight="semibold">Verification link not recognised</ProovraText>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                Open the verification link directly from your email. If you no longer have it, you can request a new one from the sign-in page.
              </ProovraText>
              {backToSignIn}
            </View>
          ) : state === "invalid" ? (
            <View style={styles.stack} testID="verify-invalid">
              <ProovraText variant="label" weight="semibold" color={theme.color.status.risk.fg}>Link expired</ProovraText>
              <ProovraText variant="h3" weight="semibold">Verification link invalid or expired</ProovraText>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                This link has already been used or has expired. Enter your email and we’ll send a fresh verification email.
              </ProovraText>
              {form}
            </View>
          ) : state === "resend-sent" ? (
            <View style={styles.stack} testID="verify-resend-sent">
              <ProovraText variant="label" weight="semibold" color={theme.color.status.verified.fg}>Email sent</ProovraText>
              <ProovraText variant="h3" weight="semibold">Check your inbox</ProovraText>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                If an account exists for that address and still needs verification, we’ve sent a fresh link. Verification links expire after 24 hours.
              </ProovraText>
              {backToSignIn}
            </View>
          ) : (
            <View style={styles.stack} testID="verify-resend-error">
              <ProovraText variant="label" weight="semibold" color={theme.color.status.risk.fg}>Retry needed</ProovraText>
              <ProovraText variant="h3" weight="semibold">We couldn’t send the email</ProovraText>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                Please wait a moment and try again. If the issue persists, contact support.
              </ProovraText>
              {form}
            </View>
          )}
          <ProovraText variant="label" color={theme.color.ink.muted} center style={styles.hint}>
            Open the verification link on the device where you are signing in.
          </ProovraText>
        </ProovraCard>
      </ProovraSection>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({ stack: { gap: theme.space.s2 }, hint: { marginTop: theme.space.s4 } });
