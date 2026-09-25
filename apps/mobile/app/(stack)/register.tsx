import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { apiFetch } from "../../src/api";
import { registerAccount, resendVerification } from "../../src/auth/auth-api";
import {
  EMAIL_AVAILABILITY_COPY,
  EMAIL_AVAILABILITY_DEBOUNCE_MS,
  EMAIL_AVAILABILITY_TONE,
  EMAIL_REGEX,
  classifyAvailability,
  emailAvailabilityPath,
  preCheckState,
  type EmailAvailability,
} from "../../src/auth/email-availability";
import { useCompleteLogin } from "../../src/auth/use-auth-flow";
import { useOAuth } from "../../src/auth/use-oauth";
import { toSafeUserError } from "../../src/errors/safe-error";
import { useLocale } from "../../src/locale-context";
import { theme } from "../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraInput,
  ProovraFormField,
} from "../../src/ui";
import { ProovraPasswordRules, passwordMeetsRules } from "../../src/ui/password-rules";
import { AuthBrandHeader } from "../../src/ui/brand";
import {
  AuthCardHead,
  AuthLegalConsent,
  AuthNote,
  AuthPasswordInput,
  RESEND_COPY,
  useVerificationResend,
} from "../../src/ui/auth-form";

const TONE_COLOR = {
  danger: theme.color.status.risk.fg,
  muted: theme.color.ink.muted,
  success: theme.color.status.verified.fg,
  warning: theme.color.status.pending.fg,
} as const;

/**
 * Create Account — verification-first (register returns no session).
 *
 * The web card (app/register/page.tsx:936-1660): the head ("Account setup" /
 * "Create your account"), Google and Apple ABOVE the email form, "Or", then
 * the email address with live availability, a password with show/hide and the
 * shared rules panel, a confirmation with its own show/hide, the consent box,
 * and "Create account with Email". The form answers on submit with the web's
 * words; it does not sit disabled while the person wonders why.
 *
 * On success the card becomes the web's "Verify your email address" panel:
 * the address, the spam/24-hour note, Resend (held 60 s), Change email, and
 * Back to sign in.
 *
 * Google/Apple sign-up uses the SAME hooks as sign-in (`useOAuth` +
 * `useCompleteLogin`), so it passes the same MFA and legal gates, and records
 * the acceptances the person just gave with source "register" as the web does
 * (register/page.tsx:525-534). Whether a device can COMPLETE the exchange
 * depends on the deployed API accepting the native client ids (T-01 —
 * externally blocked).
 */
/** The web's words when an account is attempted without consent (email or Google/Apple). */
const LEGAL_REQUIRED_MESSAGE =
  "You must accept the Terms of Service, Privacy Policy, and Cookie Policy to create an account.";
const RULES_MESSAGE = "Your password does not meet the requirements listed below the password field.";

export default function RegisterScreen() {
  const router = useRouter();
  const { t } = useLocale();
  const completeLogin = useCompleteLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  // The web's consent checkbox: nothing — email or Google/Apple — proceeds without it.
  const [acceptLegal, setAcceptLegal] = useState(false);
  const passwordsMismatch = password2.length > 0 && password !== password2;
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [availability, setAvailability] = useState<EmailAvailability>("idle");

  const resend = useVerificationResend(() => resendVerification(sentTo ?? email.trim()));

  const requireLegal = (): boolean => {
    if (acceptLegal) return true;
    setError(LEGAL_REQUIRED_MESSAGE);
    return false;
  };

  const oauth = useOAuth({
    onResult: (result, mode) => {
      void completeLogin(result, mode, { legalAcceptedSource: "register" });
    },
  });

  // Live availability, debounced like the web; a stale answer for an address
  // the person has since changed is discarded.
  useEffect(() => {
    const pre = preCheckState(email);
    setAvailability(pre);
    if (pre !== "checking") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      apiFetch(emailAvailabilityPath(email.trim()), { method: "GET" })
        .then((d) => {
          if (!cancelled) setAvailability(classifyAvailability(d));
        })
        .catch(() => {
          if (!cancelled) setAvailability("error");
        });
    }, EMAIL_AVAILABILITY_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [email]);

  /** register/page.tsx:776-815, in the web's order and words. */
  const submit = useCallback(async () => {
    setError(null);
    setAttempted(true);
    if (!email || !password || !password2) {
      setError("Please fill in your email and choose a password.");
      return;
    }
    if (!EMAIL_REGEX.test(email.trim())) {
      setError("Please enter a valid email address.");
      return;
    }
    if (availability === "exists") {
      setError("An account already exists for this email. Sign in or reset your password instead.");
      return;
    }
    if (!passwordMeetsRules(password)) {
      setError(RULES_MESSAGE);
      return;
    }
    if (password !== password2) {
      setError("Passwords do not match.");
      return;
    }
    if (!acceptLegal) {
      setError(LEGAL_REQUIRED_MESSAGE);
      return;
    }
    setBusy(true);
    try {
      const res = await registerAccount({ email: email.trim(), password, displayName: displayName.trim() || undefined });
      resend.reset();
      setSentTo(res.email);
    } catch (err) {
      const safe = toSafeUserError(err);
      if (safe.code === "EMAIL_ALREADY_EXISTS") {
        // The poll can miss a race; the server's 409 flips the inline affordance on.
        setAvailability("exists");
        setError("An account already exists for this email. Sign in or reset your password instead.");
      } else if (safe.code === "weak_new_password") {
        setError(RULES_MESSAGE);
      } else {
        setError(safe.message);
      }
    } finally {
      setBusy(false);
    }
  }, [acceptLegal, availability, email, password, password2, displayName, resend]);

  /** register/page.tsx:771-783 — back to an empty address. */
  const changeEmail = () => {
    resend.reset();
    setSentTo(null);
    setEmail("");
    setAvailability("idle");
    setError(null);
  };

  if (sentTo) {
    return (
      <ProovraScreen width="form" backdrop="auth">
        <AuthBrandHeader tagline="Register to manage evidence records, verification pages, reports, and protected review workflows from one place." />
        <ProovraCard testID="register-verify">
          <AuthCardHead eyebrow="Verify your email" title="Verify your email address" />
          <View accessibilityLiveRegion="polite" style={styles.verifyBody}>
            <ProovraText variant="body" color={theme.color.ink.secondary}>
              {"We’ve sent a verification email to "}
              <ProovraText variant="body" weight="semibold">{sentTo}</ProovraText>
              {". Please open the email and click the verification link to activate your PROOVRA account."}
            </ProovraText>
            <ProovraText variant="bodySm" color={theme.color.ink.muted}>
              {"If you don’t see the email within a minute, check your spam folder. Verification links expire after 24 hours."}
            </ProovraText>
          </View>
          <View style={styles.actions}>
            <ProovraButton
              label={resend.busy ? RESEND_COPY.pending : "Resend email"}
              disabled={resend.busy}
              onPress={() => void resend.resend()}
            />
            <ProovraButton label="Change email" variant="secondary" onPress={changeEmail} />
            <ProovraButton label="Back to sign in" variant="ghost" onPress={() => router.replace("/(stack)/auth")} />
          </View>
          {resend.status ? <AuthNote tone="status">{resend.status}</AuthNote> : null}
        </ProovraCard>
      </ProovraScreen>
    );
  }

  const status = availability === "idle" ? null : availability;

  return (
    <ProovraScreen width="form" backdrop="auth">
      {/* The web's hero column (register/page.tsx:868-900). */}
      <AuthBrandHeader tagline="Register to manage evidence records, verification pages, reports, and protected review workflows from one place." />
      <ProovraText variant="label" weight="semibold" center color={theme.color.accent.a600} style={styles.heroEyebrow}>CREATE ACCOUNT</ProovraText>
      <ProovraText variant="h2" weight="semibold" center style={styles.welcome}>Create your secure PROOVRA account.</ProovraText>

      <ProovraCard>
        <AuthCardHead
          eyebrow="Account setup"
          title="Create your account"
          subtitle="Create your account using Google, Apple, or email and continue directly into your PROOVRA workspace."
        />

        {/* The web order: Google, Apple, then "Or", then the email form. */}
        <View style={styles.oauth}>
          <ProovraButton
            label="Continue with Google"
            variant="google"
            loading={oauth.busy === "google"}
            disabled={busy}
            onPress={() => {
              if (requireLegal()) void oauth.promptGoogle();
            }}
            testID="register-google"
          />
          {oauth.appleAvailable ? (
            <ProovraButton
              label="Continue with Apple"
              variant="apple"
              loading={oauth.busy === "apple"}
              disabled={busy}
              onPress={() => {
                if (requireLegal()) void oauth.signInApple();
              }}
              testID="register-apple"
            />
          ) : null}
          {oauth.error ? (
            <ProovraText variant="label" color={TONE_COLOR.danger}>
              {oauth.error.message}
            </ProovraText>
          ) : null}
        </View>

        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {t("orDivider")}
          </ProovraText>
          <View style={styles.dividerLine} />
        </View>

        <ProovraFormField label="Name">
          <ProovraInput value={displayName} onChangeText={setDisplayName} placeholder="Your name" autoCapitalize="words" editable={!busy} />
        </ProovraFormField>
        <ProovraFormField label="Email address">
          <ProovraInput
            value={email}
            onChangeText={setEmail}
            placeholder="Email"
            keyboardType="email-address"
            autoComplete="email"
            accessibilityLabel="Email address"
            editable={!busy}
            testID="register-email"
          />
        </ProovraFormField>
        {status ? (
          <View style={styles.availability} accessibilityLiveRegion="polite" testID="register-email-status">
            <ProovraText variant="label" color={TONE_COLOR[EMAIL_AVAILABILITY_TONE[status]]}>
              {EMAIL_AVAILABILITY_COPY[status]}
            </ProovraText>
            {status === "exists" ? (
              <View style={styles.existsLinks}>
                <ProovraButton
                  label="Sign in"
                  variant="ghost"
                  fullWidth={false}
                  onPress={() => router.replace({ pathname: "/(stack)/auth", params: { email: email.trim() } })}
                />
                <ProovraButton
                  label="Forgot password?"
                  variant="ghost"
                  fullWidth={false}
                  onPress={() => router.push({ pathname: "/forgot-password", params: { email: email.trim() } })}
                />
              </View>
            ) : null}
          </View>
        ) : null}
        <ProovraFormField label="Password">
          <AuthPasswordInput value={password} onChangeText={setPassword} placeholder="Password" accessibilityLabel="Password" editable={!busy} testID="register-password" />
        </ProovraFormField>
        {/*
          The rules panel, from the same module the web uses. After a refused
          submit an unmet rule is marked as failed, as the web marks it once
          the field has been touched.
        */}
        <ProovraPasswordRules password={password} visible={password.length > 0 || attempted} touched={attempted} />
        <ProovraFormField label="Confirm password" error={passwordsMismatch ? "Passwords do not match." : null}>
          <AuthPasswordInput
            value={password2}
            onChangeText={setPassword2}
            placeholder="Confirm password"
            accessibilityLabel="Confirm password"
            toggleNoun="confirm password"
            editable={!busy}
            testID="register-password-confirm"
          />
        </ProovraFormField>
        {/* The web consent checkbox, each document a link to the reader. */}
        <AuthLegalConsent
          checked={acceptLegal}
          disabled={busy}
          onToggle={() => {
            setAcceptLegal((v) => !v);
            if (error === LEGAL_REQUIRED_MESSAGE) setError(null);
          }}
          onOpenDocument={(slug) => router.push(`/legal/${slug}`)}
        />
        <ProovraButton
          label={busy ? "Creating account…" : "Create account with Email"}
          accessibilityLabel="Create account with Email"
          loading={busy}
          onPress={() => void submit()}
          testID="register-submit"
        />
        {error ? <AuthNote tone="error" testID="register-error">{error}</AuthNote> : null}
        {busy ? <AuthNote tone="status">Creating account...</AuthNote> : null}

        <View style={styles.switchRow}>
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{`${t("login")}?`}</ProovraText>
          <ProovraButton label={t("login")} variant="ghost" fullWidth={false} onPress={() => router.replace("/(stack)/auth")} />
        </View>
      </ProovraCard>

      {/* T-12 — "Security and privacy commitments" (register/page.tsx:1664-1700):
          factual signals, verbatim, as a named list. */}
      <View
        role="list"
        accessibilityLabel="Security and privacy commitments"
        style={styles.commitments}
        testID="register-commitments"
      >
        {SECURITY_COMMITMENTS.map((label) => (
          <View key={label} role="listitem" style={styles.commitment}>
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {label}
            </ProovraText>
          </View>
        ))}
      </View>
    </ProovraScreen>
  );
}

/** register/page.tsx:1681-1686, verbatim — factual only, no marketing claims. */
const SECURITY_COMMITMENTS = [
  "TLS Protected",
  "Privacy-First Design",
  "GDPR-Aware Data Handling",
  "No Credit Card Required",
] as const;

const styles = StyleSheet.create({
  heroEyebrow: { letterSpacing: 2, marginBottom: theme.space.s1 },
  welcome: { marginBottom: theme.space.s4 },
  commitments: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: theme.space.s2, marginTop: theme.space.s4 },
  commitment: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border.default,
    backgroundColor: theme.color.surface.card,
  },
  oauth: { gap: theme.space.s3 },
  divider: { flexDirection: "row", alignItems: "center", gap: theme.space.s3, marginVertical: theme.space.s4 },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: theme.color.border.default },
  availability: { marginTop: -theme.space.s2, marginBottom: theme.space.s3, gap: theme.space.s1 },
  existsLinks: { flexDirection: "row", gap: theme.space.s2 },
  verifyBody: { gap: theme.space.s3 },
  actions: { marginTop: theme.space.s4, gap: theme.space.s2 },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: theme.space.s1, marginTop: theme.space.s4 },
});
