import { useCallback, useState } from "react";
import { useLocale } from "../../src/locale-context";
import { View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { emailLogin, resendVerification } from "../../src/auth/auth-api";
import { useOAuth, type OAuthMode } from "../../src/auth/use-oauth";
import { useCompleteLogin } from "../../src/auth/use-auth-flow";
import { toSafeUserError } from "../../src/errors/safe-error";
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
import {
  AuthCardHead,
  AuthLegalConsent,
  AuthNote,
  AuthPasswordInput,
  RESEND_COPY,
  useVerificationResend,
} from "../../src/ui/auth-form";

/** login/page.tsx:302-304 — nothing, email or Google/Apple, proceeds without consent. */
const LOGIN_LEGAL_REQUIRED =
  "You must accept the Terms of Service, Privacy Policy, and Cookie Policy before continuing.";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROVIDER_LABEL: Record<OAuthMode, string> = { google: "Google", apple: "Apple" };

/**
 * Auth Gateway / Sign In — the web sign-in card (login/page.tsx:755-1180).
 *
 * The web order: the card head ("Account access" / "Sign in"), Google, Apple,
 * "Or", then the email form with a show/hide password, Forgot password, the
 * Terms/Privacy/Cookie consent box and "Sign in with Email". Consent gates
 * every path, and once a session exists the acceptances are recorded
 * (useCompleteLogin → POST /v1/users/legal-acceptance, source "login").
 *
 * An unverified address gets the web's calm "Verify your email address" panel
 * with Resend (60-second hold) and "Use a different email" — not a red error.
 * Field errors land on the field; a credential failure is never placed on one
 * (the server answers unknown-address and wrong-password alike).
 *
 * Whether a device can COMPLETE the Google/Apple exchange depends on the
 * deployed API accepting the native client ids (T-01 — externally blocked).
 */
export default function AuthScreen() {
  const router = useRouter();
  const { t } = useLocale();
  const completeLogin = useCompleteLogin();
  // The web links here as `?email=` from Create account when the address is
  // already registered (register/page.tsx:1204-1216); carry it so it is not retyped.
  const params = useLocalSearchParams<{ email?: string }>();
  const [email, setEmail] = useState(typeof params.email === "string" ? params.email : "");
  const [password, setPassword] = useState("");
  const [acceptLegal, setAcceptLegal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [needsVerification, setNeedsVerification] = useState(false);
  const [lastProvider, setLastProvider] = useState<OAuthMode | null>(null);

  const verify = useVerificationResend(() => resendVerification(email.trim()));

  const oauth = useOAuth({
    onResult: (result, mode) => {
      void completeLogin(result, mode, { legalAcceptedSource: "login" });
    },
  });

  const requireLegal = (): boolean => {
    if (acceptLegal) return true;
    setError(LOGIN_LEGAL_REQUIRED);
    return false;
  };

  const startOAuth = (mode: OAuthMode) => {
    setError(null);
    if (!requireLegal()) return;
    setLastProvider(mode);
    oauth.clearError();
    if (mode === "google") oauth.promptGoogle();
    else oauth.signInApple();
  };

  const submit = useCallback(async () => {
    setError(null);
    setFieldErrors({});
    setNeedsVerification(false);
    // Answered here, per field — format only; whether the address has an
    // account is never answered before authentication (login/page.tsx:626-645).
    const pre: { email?: string; password?: string } = {};
    if (!email.trim()) pre.email = "Enter your email address.";
    else if (!EMAIL_RE.test(email.trim())) pre.email = "Enter a valid email address.";
    if (!password) pre.password = "Enter your password.";
    if (pre.email || pre.password) {
      setFieldErrors(pre);
      return;
    }
    if (!acceptLegal) {
      setError(LOGIN_LEGAL_REQUIRED);
      return;
    }
    setBusy(true);
    setStatus("Signing in via email...");
    try {
      const result = await emailLogin(email.trim(), password);
      await completeLogin(result, "email", { legalAcceptedSource: "login" });
      setStatus(null);
    } catch (err) {
      const safe = toSafeUserError(err);
      if (safe.code === "EMAIL_NOT_VERIFIED") {
        verify.reset();
        setNeedsVerification(true);
        setStatus(null);
      } else {
        setError(safe.message);
        setStatus("Sign in failed.");
      }
    } finally {
      setBusy(false);
    }
  }, [email, password, acceptLegal, completeLogin, verify]);

  const oauthError = oauth.error
    ? `${lastProvider ? `${PROVIDER_LABEL[lastProvider]} sign-in failed: ` : ""}${oauth.error.message}`
    : null;
  const shownError = error ?? oauthError;

  return (
    <ProovraScreen width="form" backdrop="auth">
      {/* The web sign-in heading and subtitle (login/page.tsx:712-730). */}
      <AuthBrandHeader tagline="Sign in to continue reviewing evidence records, verification reports, cases, workspaces, and protected review workflows." />
      {/* The hero eyebrow (login/page.tsx:704-709). */}
      <ProovraText variant="label" weight="semibold" center color={theme.color.accent.a600} style={styles.heroEyebrow}>WELCOME BACK</ProovraText>
      <ProovraText variant="h2" weight="semibold" center style={styles.welcome}>Return to your PROOVRA workspace.</ProovraText>

      <ProovraCard>
        <AuthCardHead
          eyebrow="Account access"
          title="Sign in"
          subtitle="Continue with your preferred sign-in method and return safely to your PROOVRA workspace."
        />

        {/* The web order: Google, Apple, "Or", then email. */}
        <View style={styles.oauth}>
          <ProovraButton
            label={t("signInGoogle")}
            variant="secondary"
            loading={oauth.busy === "google"}
            disabled={busy}
            onPress={() => startOAuth("google")}
          />
          {oauth.appleAvailable ? (
            <ProovraButton
              label={t("signInApple")}
              variant="secondary"
              loading={oauth.busy === "apple"}
              disabled={busy}
              onPress={() => startOAuth("apple")}
            />
          ) : null}
        </View>

        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {t("orDivider")}
          </ProovraText>
          <View style={styles.dividerLine} />
        </View>

        <ProovraFormField label="Email" error={fieldErrors.email ?? null}>
          <ProovraInput
            value={email}
            onChangeText={setEmail}
            placeholder="Email"
            keyboardType="email-address"
            autoComplete="email"
            editable={!busy}
            testID="auth-email"
          />
        </ProovraFormField>
        <ProovraFormField label="Password" error={fieldErrors.password ?? null}>
          <AuthPasswordInput
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            editable={!busy}
            onSubmitEditing={() => void submit()}
            testID="auth-password"
          />
        </ProovraFormField>
        <View style={styles.forgot}>
          <ProovraButton label="Forgot password?" variant="ghost" fullWidth={false} onPress={() => router.push("/forgot-password")} />
        </View>

        <AuthLegalConsent
          checked={acceptLegal}
          disabled={busy}
          onToggle={() => {
            setAcceptLegal((v) => !v);
            if (error === LOGIN_LEGAL_REQUIRED) setError(null);
          }}
          onOpenDocument={(slug) => router.push(`/legal/${slug}`)}
        />

        <ProovraButton label="Sign in with Email" loading={busy} onPress={() => void submit()} testID="auth-signin" />

        {/* EV5 — the calm verification panel (login/page.tsx:1012-1110), not an error. */}
        {needsVerification ? (
          <View style={styles.verify} accessibilityLiveRegion="polite" testID="auth-verify-panel">
            <ProovraText variant="body" weight="semibold">Verify your email address</ProovraText>
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              Please verify your email address before signing in. The link in your inbox will activate your account.
            </ProovraText>
            <View style={styles.verifyActions}>
              <ProovraButton
                label={verify.busy ? RESEND_COPY.pending : "Resend verification email"}
                fullWidth={false}
                disabled={verify.busy || !email.trim()}
                onPress={() => void verify.resend()}
              />
              <ProovraButton
                label="Use a different email"
                variant="ghost"
                fullWidth={false}
                onPress={() => {
                  setNeedsVerification(false);
                  verify.reset();
                }}
              />
            </View>
            {verify.status ? (
              <ProovraText variant="label" color={theme.color.ink.secondary}>{verify.status}</ProovraText>
            ) : null}
          </View>
        ) : null}

        {/*
          The web's OAuth return page (auth/callback/ui/page.tsx:340-404):
          "Signing you in…" while the provider token is exchanged, and a
          "Sign-in failed" heading when it is refused. Native has no redirect
          page — the ceremony returns to this screen — so the same two states
          are said here.
        */}
        {oauth.busy ? (
          <View style={styles.oauthProgress} accessibilityLiveRegion="polite" testID="auth-oauth-progress">
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.muted}>Authentication</ProovraText>
            <ProovraText variant="body" weight="semibold">Signing you in…</ProovraText>
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>Please wait while we securely complete your sign-in.</ProovraText>
          </View>
        ) : null}
        {oauthError && !error ? (
          <ProovraText variant="body" weight="semibold" color={theme.color.status.risk.fg} style={styles.failedHead}>
            Sign-in failed
          </ProovraText>
        ) : null}
        {shownError ? <AuthNote tone="error" testID="auth-error">{shownError}</AuthNote> : null}
        {status ? <AuthNote tone="status">{status}</AuthNote> : null}

        <View style={styles.switchRow}>
          {/* NEW:L10N-LOGIN — the web's "Register? Register" line (login/page.tsx:1164-1175). */}
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{`${t("register")}?`}</ProovraText>
          <ProovraButton label={t("register")} variant="ghost" fullWidth={false} onPress={() => router.push("/register")} />
        </View>
      </ProovraCard>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  heroEyebrow: { letterSpacing: 2, marginBottom: theme.space.s1 },
  welcome: { marginBottom: theme.space.s4 },
  divider: { flexDirection: "row", alignItems: "center", gap: theme.space.s3, marginVertical: theme.space.s4 },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: theme.color.border.default },
  oauth: { gap: theme.space.s3 },
  forgot: { alignItems: "flex-end", marginTop: -theme.space.s2 },
  verify: {
    marginTop: theme.space.s3,
    gap: theme.space.s2,
    padding: theme.space.s4,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.color.accent.a200,
    backgroundColor: "rgba(255, 255, 255, 0.62)",
  },
  verifyActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s3 },
  failedHead: { marginTop: theme.space.s3 },
  oauthProgress: { marginTop: theme.space.s3, gap: theme.space.s1, alignItems: "center" },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: theme.space.s1, marginTop: theme.space.s4 },
});
