"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "../../providers";
import { apiFetch, isApiResponseError } from "../../../lib/api";
import { MarketingHeader } from "../../../components/marketing/MarketingHeader";
import { REQUIRED_LEGAL_VERSIONS } from "@proovra/shared/legal";
import { safeReturnPath } from "../../../lib/navigation/safe-return-path";

/**
 * EV5 — Email verification landing page.
 *
 * The user arrives here from the verification email (link contains a
 * `?token=` query param). On mount we POST the token to
 * `/v1/auth/email/verify`. Outcomes:
 *
 *   - 200 + { token, user } → backend has marked the address verified
 *     and minted a fresh session JWT. We persist the token, write the
 *     three required legal acceptances (the register form already
 *     showed them but couldn't record them without a session), and
 *     bounce to /home. Auto-sign-in per product spec.
 *   - 403 EMAIL_VERIFICATION_PASSWORD_REQUIRED → the link is good and stays
 *     good; a first verification needs the account's password beside it, so a
 *     person who never opened this account cannot switch on a password somebody
 *     else chose. They are pointed at "forgot password" instead.
 *   - 400 INVALID_OR_EXPIRED → show a calm "link no longer works"
 *     card with a Resend affordance + "Back to sign in" link.
 *   - 429 → "too many attempts, wait a minute" with Try again. The token was
 *     never looked at, so calling the link dead was false (F-06).
 *   - Network error / 5xx → "couldn't confirm the link right now" with Try
 *     again; the link is untouched and still works.
 *
 * F-26f — success lands on the `next` the emailed link carries (an
 * invitation, a plan chosen on /pricing), validated by the shared
 * open-redirect rule; /home otherwise.
 *
 * Visual language matches the rest of the auth surfaces — warm
 * background, glass card, rose accent. The page renders the
 * MarketingHeader for navigation continuity but no footer (same as
 * register/login).
 */

type VerifyState =
  | "loading"
  | "password"
  | "success"
  | "invalid"
  | "rate-limited"
  | "unreachable"
  | "missing-token"
  | "resend-input"
  | "resend-sent"
  | "resend-error";

// Match the versions used by register.tsx + login.tsx so the
// acceptance write here is bit-for-bit identical to those flows.
// The acceptance requirement is DERIVED from the canonical legal corpus in
// `@proovra/shared/legal`, not restated here. This page used to carry its own
// copy of the three dates; so did login and verify-email and the API. All four
// said 2026-04-06 while the documents said 2026-06-23 / 2026-06-26, so a user
// was recorded as accepting a revision of the Terms that was not the one on
// screen.

function getRequiredAcceptances() {
  return [
    { policyKey: "terms" as const, policyVersion: REQUIRED_LEGAL_VERSIONS.terms },
    { policyKey: "privacy" as const, policyVersion: REQUIRED_LEGAL_VERSIONS.privacy },
    { policyKey: "cookies" as const, policyVersion: REQUIRED_LEGAL_VERSIONS.cookies },
  ];
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailPageContent />
    </Suspense>
  );
}

function VerifyEmailPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setToken } = useAuth();
  const token = searchParams.get("token") ?? "";
  const nextPath = safeReturnPath(searchParams.get("next"));

  const [state, setState] = useState<VerifyState>(
    token ? "loading" : "missing-token",
  );
  const [resendEmail, setResendEmail] = useState("");
  const [resendBusy, setResendBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // Avoid double-firing the verify POST under React StrictMode dev
  // double-invocation — the backend would correctly reject the
  // second call as "already_used" but the user-visible result
  // would flicker to "invalid" before the success render lands.
  const hasFiredRef = useRef(false);

  const submit = useCallback(
    async (withPassword?: string) => {
      try {
        const data = (await apiFetch(
          "/v1/auth/email/verify",
          {
            method: "POST",
            body: JSON.stringify(withPassword ? { token, password: withPassword } : { token }),
          },
          { auth: false },
        )) as { token?: string } | null;

        if (!data?.token) {
          setState("invalid");
          return;
        }

        // EV5 — establish the session right here. The verify endpoint
        // already set the session cookie + AuthenticatedSession row;
        // persisting the JWT via setToken makes the bearer-token code
        // path (non-cookie clients) work too.
        setToken(data.token);

        // Best-effort: record legal acceptances now that we have a
        // session. Failure is non-fatal — the user still gets in.
        try {
          await apiFetch("/v1/users/legal-acceptance", {
            method: "POST",
            body: JSON.stringify({
              source: "register",
              acceptances: getRequiredAcceptances(),
            }),
          });
        } catch {
          // ignore
        }

        // Best-effort: claim any pre-session evidence the operator captured
        // while anonymous. The guest JWT lives in memory only (lib/api in-
        // memory slot, seeded by providers.tsx via setApiToken).
        try {
          const { readApiToken } = await import("../../../lib/api");
          const guestToken = readApiToken();
          if (guestToken) {
            await apiFetch("/v1/evidence/claim", {
              method: "POST",
              body: JSON.stringify({ guestToken }),
            });
          }
        } catch {
          // ignore
        }

        setState("success");
        window.setTimeout(() => router.push(nextPath), 1200);
      } catch (err) {
        const code = isApiResponseError(err) ? err.code : "NETWORK_ERROR";
        const status = isApiResponseError(err) ? (err.statusCode ?? 0) : 0;
        if (code === "EMAIL_VERIFICATION_PASSWORD_REQUIRED") {
          setState("password");
          return;
        }
        if (code === "EMAIL_VERIFICATION_PASSWORD_INCORRECT") {
          setState("password");
          setPasswordError("That is not the password chosen for this account.");
          return;
        }
        // Log to console for debug only — never to the UI.
        if (typeof window !== "undefined" && (window as { __DEV__?: boolean }).__DEV__) {
          // eslint-disable-next-line no-console
          console.debug("[verify-email] failed", code, err);
        }
        // Only the server's verdict on the TOKEN means the link is dead.
        // A throttle, an outage or a dropped connection says nothing about
        // it, and the link still works once the request gets through.
        if (status === 429) {
          setState("rate-limited");
          return;
        }
        if (status === 0 || status >= 500) {
          setState("unreachable");
          return;
        }
        setState("invalid");
      }
    },
    [token, router, setToken, nextPath],
  );

  const onRetry = async () => {
    setState("loading");
    await submit();
  };

  useEffect(() => {
    if (!token || hasFiredRef.current) return;
    hasFiredRef.current = true;
    void submit();
  }, [token, submit]);

  const onSubmitPassword = async () => {
    if (passwordBusy || !password) return;
    setPasswordBusy(true);
    setPasswordError(null);
    try {
      await submit(password);
    } finally {
      setPasswordBusy(false);
    }
  };

  const onResend = async () => {
    if (resendBusy) return;
    const trimmed = resendEmail.trim();
    if (!trimmed) return;
    setResendBusy(true);
    try {
      await apiFetch(
        "/v1/auth/email/resend-verification",
        {
          method: "POST",
          body: JSON.stringify({ email: trimmed, ...(nextPath !== "/home" ? { next: nextPath } : {}) }),
        },
        { auth: false },
      );
      setState("resend-sent");
    } catch {
      setState("resend-error");
    } finally {
      // 60 s window matches backend cooldown.
      window.setTimeout(() => setResendBusy(false), 60_000);
    }
  };

  return (
    <div className="page landing-page">
      <div className="relative min-h-screen overflow-hidden">
        <div className="absolute inset-0">
          <img
            src="/assets/hero/register-logo...png"
            alt=""
            className="h-full w-full object-cover object-center"
          />
        </div>
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,229,207,0.10)_0%,rgba(255,255,255,0.02)_45%,rgba(33,22,45,0.10)_100%)]" />

        <div className="relative z-10 flex min-h-screen flex-col">
          <MarketingHeader />

          <main className="flex flex-1 items-center px-6 pb-14 pt-24 md:px-8 md:pb-20 md:pt-28">
            <div className="mx-auto w-full max-w-[520px]">
              <div
                className="relative overflow-hidden rounded-[28px]"
                style={{
                  boxShadow: "0 28px 80px rgba(59,28,74,0.22)",
                  border: "1px solid rgba(255,255,255,0.45)",
                  background: "rgba(255,255,255,0.74)",
                  backdropFilter: "blur(22px) saturate(1.1)",
                  WebkitBackdropFilter: "blur(22px) saturate(1.1)",
                }}
              >
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_85%_15%,rgba(255,179,107,0.16),transparent_40%)]" />
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_8%,rgba(255,255,255,0.55),transparent_30%)]" />

                <div className="relative z-10 p-8 lg:p-9">
                  {state === "loading" ? (
                    <VerifyLoadingCard />
                  ) : state === "password" ? (
                    <VerifyPasswordCard
                      password={password}
                      onPasswordChange={setPassword}
                      onSubmit={onSubmitPassword}
                      busy={passwordBusy}
                      error={passwordError}
                    />
                  ) : state === "success" ? (
                    <VerifySuccessCard onContinue={() => router.push(nextPath)} />
                  ) : state === "rate-limited" || state === "unreachable" ? (
                    <VerifyRetryCard kind={state} onRetry={() => void onRetry()} />
                  ) : state === "missing-token" ? (
                    <VerifyMissingCard />
                  ) : state === "resend-sent" ? (
                    <VerifyResendSentCard />
                  ) : state === "resend-error" ? (
                    <VerifyResendErrorCard
                      email={resendEmail}
                      onResend={onResend}
                      resendBusy={resendBusy}
                      onEmailChange={setResendEmail}
                    />
                  ) : (
                    <VerifyInvalidCard
                      email={resendEmail}
                      onResend={onResend}
                      resendBusy={resendBusy}
                      onEmailChange={setResendEmail}
                    />
                  )}
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

// ====================== Card variants ======================

const Eyebrow = ({ label }: { label: string }) => (
  <div
    className="inline-flex items-center gap-2.5 rounded-full px-4 py-2.5 text-[0.74rem] font-semibold uppercase tracking-[0.18em]"
    style={{
      color: "#21162D",
      background: "rgba(230,72,128,0.08)",
      border: "1px solid rgba(230,72,128,0.20)",
    }}
  >
    {label}
  </div>
);

const Heading = ({ children }: { children: React.ReactNode }) => (
  <h1 className="mt-4 text-[1.9rem] font-semibold tracking-[-0.04em] text-[#1B1230] md:text-[2.15rem]">
    {children}
  </h1>
);

const Body = ({ children }: { children: React.ReactNode }) => (
  <p className="mt-3 text-[0.96rem] leading-[1.78] text-[#4B3B4F]">{children}</p>
);

const PrimaryButton = ({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className="auth-social-btn"
    style={{
      background: disabled
        ? "rgba(230,72,128,0.18)"
        : "var(--btn-primary-bg)",
      color: disabled ? "#7A687D" : "#ffffff",
      border: "1px solid rgba(230,72,128,0.45)",
      boxShadow: disabled ? "none" : "0 14px 28px rgba(230,72,128,0.22)",
      fontWeight: 600,
      cursor: disabled ? "not-allowed" : "pointer",
    }}
  >
    {children}
  </button>
);

const BackToSignIn = () => (
  <Link
    href="/login"
    className="auth-link"
    style={{ color: "var(--accent-600, #6d28d9)", fontWeight: 600, fontSize: 14 }}
  >
    Back to sign in
  </Link>
);

function VerifyLoadingCard() {
  return (
    <div role="status" aria-live="polite">
      <Eyebrow label="Verifying" />
      <Heading>Verifying your email</Heading>
      <Body>One moment while we confirm the verification link.</Body>
    </div>
  );
}

function VerifyPasswordCard({
  password,
  onPasswordChange,
  onSubmit,
  busy,
  error,
}: {
  password: string;
  onPasswordChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <div>
      <Eyebrow label="One more step" />
      <Heading>Confirm your password</Heading>
      <Body>
        Enter the password you chose when you created this account to finish
        verifying your email.
      </Body>
      <div className="mt-6">
        <label
          htmlFor="verify-password"
          className="block text-[12px] font-semibold uppercase tracking-[0.18em]"
          style={{ color: "#7A687D" }}
        >
          Password
        </label>
        <input
          id="verify-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
          }}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "verify-password-error" : undefined}
          data-testid="verify-password-input"
          className="mt-2 w-full rounded-2xl px-4 py-3 text-[15px]"
          style={{
            color: "#1B1230",
            background: "rgba(255,255,255,0.84)",
            border: "1px solid rgba(255,255,255,0.44)",
            boxShadow: "0 12px 28px rgba(6,16,22,0.08)",
          }}
        />
        {error ? (
          <p
            id="verify-password-error"
            role="alert"
            className="mt-2 text-[14px]"
            style={{ color: "#A32D2D" }}
            data-testid="verify-password-error"
          >
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <PrimaryButton onClick={onSubmit} disabled={busy || !password}>
            {busy ? "Verifying…" : "Verify my email"}
          </PrimaryButton>
        </div>
      </div>
      <Body>
        Did you not create this account, or forgot the password?{" "}
        <Link
          href="/forgot-password"
          className="auth-link"
          style={{ color: "var(--accent-600, #6d28d9)", fontWeight: 600 }}
          data-testid="verify-forgot-password"
        >
          Set a new password
        </Link>{" "}
        from a link sent to this address. It replaces any password already on
        the account.
      </Body>
    </div>
  );
}

function VerifySuccessCard({ onContinue }: { onContinue: () => void }) {
  return (
    <div role="status" aria-live="polite">
      <Eyebrow label="Verified" />
      <Heading>Email verified</Heading>
      <Body>
        Your account has been successfully verified. You&rsquo;ll land in your
        PROOVRA workspace in a moment.
      </Body>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <PrimaryButton onClick={onContinue}>Continue to PROOVRA</PrimaryButton>
      </div>
    </div>
  );
}

function VerifyRetryCard({
  kind,
  onRetry,
}: {
  kind: "rate-limited" | "unreachable";
  onRetry: () => void;
}) {
  return (
    <div role="alert" data-testid={`verify-retry-${kind}`}>
      <Eyebrow label={kind === "rate-limited" ? "Too many attempts" : "Not confirmed yet"} />
      <Heading>
        {kind === "rate-limited"
          ? "Too many attempts — wait a moment"
          : "We couldn\u2019t check your link just now"}
      </Heading>
      <Body>
        {kind === "rate-limited"
          ? "There have been too many verification attempts from this connection. Wait a minute and try again \u2014 your link still works."
          : "PROOVRA could not be reached to confirm this link. Check your connection and try again \u2014 your link has not been used and still works."}
      </Body>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <PrimaryButton onClick={onRetry}>Try again</PrimaryButton>
        <BackToSignIn />
      </div>
    </div>
  );
}

function VerifyMissingCard() {
  return (
    <div role="status" aria-live="polite">
      <Eyebrow label="Missing token" />
      <Heading>Verification link not recognised</Heading>
      <Body>
        Open the verification link directly from your email. If you no longer
        have it, you can request a new one from the sign-in page.
      </Body>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <BackToSignIn />
      </div>
    </div>
  );
}

function ResendForm({
  email,
  onEmailChange,
  onResend,
  resendBusy,
}: {
  email: string;
  onEmailChange: (v: string) => void;
  onResend: () => void;
  resendBusy: boolean;
}) {
  return (
    <div className="mt-6">
      <label
        htmlFor="verify-resend-email"
        className="block text-[12px] font-semibold uppercase tracking-[0.18em]"
        style={{ color: "#7A687D" }}
      >
        Email address
      </label>
      <input
        id="verify-resend-email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => onEmailChange(e.target.value)}
        placeholder="you@example.com"
        disabled={resendBusy}
        className="mt-2 w-full rounded-2xl px-4 py-3 text-[15px]"
        style={{
          color: "#1B1230",
          background: "rgba(255,255,255,0.84)",
          border: "1px solid rgba(255,255,255,0.44)",
          boxShadow: "0 12px 28px rgba(6,16,22,0.08)",
        }}
      />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <PrimaryButton onClick={onResend} disabled={resendBusy || !email.trim()}>
          {resendBusy ? "Resend pending…" : "Resend verification email"}
        </PrimaryButton>
        <BackToSignIn />
      </div>
    </div>
  );
}

function VerifyInvalidCard({
  email,
  onEmailChange,
  onResend,
  resendBusy,
}: {
  email: string;
  onEmailChange: (v: string) => void;
  onResend: () => void;
  resendBusy: boolean;
}) {
  return (
    <div role="status" aria-live="polite">
      <Eyebrow label="Link expired" />
      <Heading>Verification link invalid or expired</Heading>
      <Body>
        This link has already been used or has expired. Enter your email and
        we&rsquo;ll send a fresh verification email.
      </Body>
      <ResendForm
        email={email}
        onEmailChange={onEmailChange}
        onResend={onResend}
        resendBusy={resendBusy}
      />
    </div>
  );
}

function VerifyResendSentCard() {
  return (
    <div role="status" aria-live="polite">
      <Eyebrow label="Email sent" />
      <Heading>Check your inbox</Heading>
      <Body>
        If an account exists for that address and still needs verification,
        we&rsquo;ve sent a fresh link. Verification links expire after
        24&nbsp;hours.
      </Body>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <BackToSignIn />
      </div>
    </div>
  );
}

function VerifyResendErrorCard({
  email,
  onEmailChange,
  onResend,
  resendBusy,
}: {
  email: string;
  onEmailChange: (v: string) => void;
  onResend: () => void;
  resendBusy: boolean;
}) {
  return (
    <div role="alert">
      <Eyebrow label="Retry needed" />
      <Heading>We couldn&rsquo;t send the email</Heading>
      <Body>
        Please wait a moment and try again. If the issue persists, contact
        support.
      </Body>
      <ResendForm
        email={email}
        onEmailChange={onEmailChange}
        onResend={onResend}
        resendBusy={resendBusy}
      />
    </div>
  );
}
