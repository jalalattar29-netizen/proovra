"use client";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

import {
  Suspense,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useToast } from "../../components/ui";
import { useAuth, useLocale } from "../providers";
import { apiFetch, ApiError } from "../../lib/api";
import { authLogger } from "../../lib/auth-logger";
import { loadAppleIdentity, loadGoogleIdentity } from "../../lib/oauth";
import { MarketingHeader } from "../../components/marketing/MarketingHeader";
import { ForgotPasswordModal } from "../../components/marketing/ForgotPasswordModal";
import {
  clearPendingOAuthLegalAcceptance,
  savePendingOAuthLegalAcceptance,
} from "../../lib/legalAcceptance";

const DEBUG_AUTH = process.env.NEXT_PUBLIC_DEBUG_AUTH === "1";

type GoogleCredentialResponse = { credential?: string };

type GoogleAccountsId = {
  initialize: (options: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    cancel_on_tap_outside?: boolean;
  }) => void;
  renderButton?: (
    parent: HTMLElement,
    options: {
      type?: "standard" | "icon";
      theme?: "outline" | "filled_blue" | "filled_black";
      size?: "large" | "medium" | "small";
      text?: "signin_with" | "signup_with" | "continue_with" | "signin";
      shape?: "rectangular" | "pill" | "circle" | "square";
      logo_alignment?: "left" | "center";
      width?: number;
      locale?: string;
    }
  ) => void;
};

type GoogleGlobal = Window & {
  google?: { accounts?: { id?: GoogleAccountsId } };
};

type AppleSignInResponse = { authorization?: { code?: string; id_token?: string } };

type AppleAuth = {
  init: (options: { clientId: string; scope: string; redirectURI: string; usePopup: boolean }) => void;
  signIn: () => Promise<AppleSignInResponse>;
};

type AppleGlobal = Window & {
  AppleID?: { auth?: AppleAuth };
};

function EmailIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm0 4.236-8 4.8-8-4.8V6l8 4.8L20 6v2.236Z"
      />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2Zm-7-2a2 2 0 0 1 4 0v2h-4V7Zm3 10.73V19h-2v-1.27a2 2 0 1 1 2 0Z"
      />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M16.365 1.43c0 1.14-.465 2.18-1.22 2.93-.77.77-1.94 1.37-3.03 1.27-.14-1.1.42-2.26 1.19-3.03.8-.8 2.05-1.36 3.06-1.17zM20.6 17.13c-.55 1.27-.81 1.84-1.51 2.93-.97 1.54-2.34 3.46-4.04 3.48-1.52.02-1.91-.99-3.97-.98-2.06.01-2.49.99-4 .97-1.7-.02-3-1.75-3.97-3.29-2.71-4.33-3-9.42-1.32-12.01 1.19-1.85 3.07-2.94 4.84-2.94 1.81 0 2.95 1 3.97 1 1 0 2.57-1.23 4.33-1.05.74.03 2.82.3 4.16 2.27-.11.07-2.49 1.46-2.46 4.35.03 3.45 3.03 4.6 3.07 4.61z"
      />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 2l7 3v6c0 5.25-3.438 10.125-7 11-3.562-.875-7-5.75-7-11V5l7-3Zm0 2.18L7 6.32V11c0 4.164 2.61 8.11 5 8.95 2.39-.84 5-4.786 5-8.95V6.32l-5-2.14Z"
      />
    </svg>
  );
}

const REQUIRED_LEGAL_VERSIONS = {
  terms: "2026-04-06",
  privacy: "2026-04-06",
  cookies: "2026-04-06",
} as const;

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageContent />
    </Suspense>
  );
}

function LoginPageContent() {
  const { t } = useLocale();
  const { setToken } = useAuth();
  const { addToast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextUrl = searchParams.get("next") || searchParams.get("returnUrl") || "/home";

  const [acceptLegal, setAcceptLegal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [appleReady, setAppleReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // EV5 — when the backend returns EMAIL_NOT_VERIFIED we surface a
  // distinct "verify your email" panel with a Resend affordance instead
  // of a flat error string. The flag clears on any retry.
  const [needsVerification, setNeedsVerification] = useState(false);
  const [verifyResendBusy, setVerifyResendBusy] = useState(false);
  const [verifyResendStatus, setVerifyResendStatus] = useState<string | null>(null);

  // FP3 — forgot-password modal lives inside the login page. The
  // standalone /forgot-password route now redirects to /login?forgot=1
  // so deep links open the modal directly.
  const [forgotOpen, setForgotOpen] = useState(false);
  const forgotTriggerRef = useRef<HTMLButtonElement | null>(null);

  const isMountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const googleInitOnceRef = useRef(false);
  const googleBtnWrapRef = useRef<HTMLDivElement | null>(null);
  const googleBtnHostRef = useRef<HTMLDivElement | null>(null);
  const acceptLegalRef = useRef(false);
  const nextUrlRef = useRef(nextUrl);

  const ui = useMemo(() => {
    const cardShadow = "0 26px 70px rgba(2, 9, 22, 0.16)";
    const border = "1px solid rgba(79, 112, 107, 0.18)";
    const socialMaxW = 360;
    const inputShadow = "0 12px 28px rgba(6, 16, 22, 0.08)";
    return { cardShadow, border, socialMaxW, inputShadow };
  }, []);

  useEffect(() => {
    acceptLegalRef.current = acceptLegal;
  }, [acceptLegal]);

  useEffect(() => {
    nextUrlRef.current = nextUrl;
  }, [nextUrl]);

  // FP3 — auto-open the forgot-password modal when the URL carries
  // `?forgot=1` (the /forgot-password redirect target). On open we
  // strip the param via router.replace so a refresh doesn't keep
  // reopening the modal after the user has already dismissed it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (searchParams.get("forgot") === "1") {
      setForgotOpen(true);
      const url = new URL(window.location.href);
      url.searchParams.delete("forgot");
      router.replace(url.pathname + (url.search ? url.search : ""));
    }
  }, [searchParams, router]);

  const logDebug = (msg: string) => {
    if (DEBUG_AUTH) console.info(`[Auth] ${msg}`);
  };

  const getRequiredAcceptances = () => [
    {
      policyKey: "terms" as const,
      policyVersion: REQUIRED_LEGAL_VERSIONS.terms,
    },
    {
      policyKey: "privacy" as const,
      policyVersion: REQUIRED_LEGAL_VERSIONS.privacy,
    },
    {
      policyKey: "cookies" as const,
      policyVersion: REQUIRED_LEGAL_VERSIONS.cookies,
    },
  ];

  const persistPendingOAuthLegalAcceptance = () => {
    savePendingOAuthLegalAcceptance({
      source: "login",
      returnUrl: nextUrlRef.current.startsWith("/") ? nextUrlRef.current : "/home",
      acceptances: getRequiredAcceptances(),
      createdAt: new Date().toISOString(),
    });
  };

  const setReturnUrl = (url: string) => {
    try {
      sessionStorage.setItem("proovra-return-url", url);
    } catch {
      // ignore
    }
  };

  const recordRequiredLegalAcceptances = async () => {
    await apiFetch("/v1/users/legal-acceptance", {
      method: "POST",
      body: JSON.stringify({
        source: "login",
        acceptances: getRequiredAcceptances(),
      }),
    });
  };

  const handleAuth = async (
    path: string,
    idToken?: string,
    code?: string,
    extraBody?: Record<string, unknown>
  ) => {
    if (!isMountedRef.current) return;
    if (inFlightRef.current) return;

    const accepted = acceptLegalRef.current;
    const currentNextUrl = nextUrlRef.current.startsWith("/") ? nextUrlRef.current : "/home";

    if (!accepted) {
      const msg =
        "You must accept the Terms of Service, Privacy Policy, and Cookie Policy before continuing.";
      setError(msg);
      addToast(msg, "error");
      return;
    }

    const provider = path.includes("google")
      ? "google"
      : path.includes("apple")
        ? "apple"
        : path.includes("guest")
          ? "guest"
          : "email";

    if (provider === "google" || provider === "apple") {
      persistPendingOAuthLegalAcceptance();
    } else {
      clearPendingOAuthLegalAcceptance();
    }

    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    setStatus(`Signing in via ${provider}...`);

    // Guest JWT (if any) lives in memory only — the auth context holds it
    // for the lifetime of this tab and never persists it to storage.
    const { readApiToken } = await import("../../lib/api");
    const guestToken = readApiToken();

    authLogger.logTokenExchangeStart(provider, path);

    try {
      setReturnUrl(currentNextUrl);

      const payload = extraBody ?? (idToken ? { idToken } : code ? { code } : {});
      authLogger.log(
        "TOKEN_EXCHANGE",
        "request_payload",
        { endpoint: path, has_idToken: !!idToken, has_code: !!code },
        provider
      );

      const data = await apiFetch(
        path,
        { method: "POST", body: JSON.stringify(payload) },
        { auth: false }
      );
      authLogger.logTokenExchangeSuccess(provider, data);

      if (!isMountedRef.current) return;

      // R8.1.2 — login-time MFA challenge. When the backend reports
      // `mfaRequired: true` it has ALREADY set the short-lived
      // `proovra_mfa_pending` HTTP-only cookie. The session cookie is
      // NOT yet set. We bounce the operator to the canonical
      // /auth/mfa-challenge page; the pending cookie travels along
      // because apiFetch + the page request both send credentials.
      // The pending token is ALSO available in `data.mfaPendingToken`
      // for non-cookie clients (mobile) — for web we deliberately
      // ignore that field so the secret never enters page memory
      // outside the cookie. No localStorage persistence is performed.
      if (data?.mfaRequired === true) {
        authLogger.log(
          "AUTH_MFA_REQUIRED",
          "challenge_issued",
          { provider, path },
          provider,
        );
        const next = encodeURIComponent(currentNextUrl);
        router.replace(`/auth/mfa-challenge?next=${next}`);
        return;
      }

      if (!data?.token) {
        throw new Error("Authentication failed: missing token");
      }

      setToken(data.token);

      try {
        await recordRequiredLegalAcceptances();
        clearPendingOAuthLegalAcceptance();
      } catch {
        addToast(
          "Sign-in completed, but legal acceptance logging could not be saved.",
          "warning"
        );
      }

      const me = await apiFetch("/v1/auth/me", { method: "GET" });
      authLogger.logSessionValidation("/v1/auth/me", me);

      if (!me?.user && !data.token) {
        throw new Error("Session not confirmed");
      }

      if (guestToken) {
        try {
          await apiFetch("/v1/evidence/claim", {
            method: "POST",
            body: JSON.stringify({ guestToken }),
          });
        } catch {
          // ignore
        }
      }

      router.replace(currentNextUrl);
    } catch (err) {
      if (!isMountedRef.current) return;

      const msg = toSafeUserError(err, { message: "Login failed" }).message;
      const requestId = err instanceof ApiError ? err.requestId : undefined;
      const errCode = err instanceof ApiError ? err.code : undefined;

      authLogger.log("AUTH_SESSION_FAILED", "error", { message: msg, requestId }, provider);
      authLogger.logTokenExchangeError(provider, msg);

      // EV5 — backend signals an unverified email with a structured
      // 403 + EMAIL_NOT_VERIFIED code. Flip to the dedicated verify
      // panel instead of a flat error string so the operator can
      // resend the link without leaving the page.
      if (provider === "email" && errCode === "EMAIL_NOT_VERIFIED") {
        setNeedsVerification(true);
        setVerifyResendStatus(null);
        setError(null);
        setStatus(null);
        return;
      }

      const providerLabel =
        provider === "guest" ? "" : provider.charAt(0).toUpperCase() + provider.slice(1);
      const displayMsg = providerLabel ? `${providerLabel} sign-in failed: ${msg}` : msg;

      setError(displayMsg);
      setStatus("Sign in failed.");
      // Request id goes to a copyable support reference — never inline.
      addToast(displayMsg, "error", 6000, requestId ? { supportReference: requestId } : undefined);
    } finally {
      if (isMountedRef.current) setBusy(false);
      inFlightRef.current = false;
    }
  };

  const renderGoogleButton = () => {
    const host = googleBtnHostRef.current;
    const wrap = googleBtnWrapRef.current;
    if (!host || !wrap) return;

    const google = (window as GoogleGlobal).google;
    const id = google?.accounts?.id;
    if (!id?.renderButton) return;

    const width = Math.min(ui.socialMaxW, host.getBoundingClientRect().width || ui.socialMaxW);

    wrap.innerHTML = "";
    id.renderButton(wrap, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "continue_with",
      shape: "pill",
      logo_alignment: "left",
      width: Math.round(width),
      locale: "en",
    });
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    isMountedRef.current = true;

    loadGoogleIdentity()
      .then(() => {
        const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
        if (!clientId) return;

        const google = (window as GoogleGlobal).google;
        const id = google?.accounts?.id;
        if (!id?.initialize) return;

        if (!googleInitOnceRef.current) {
          googleInitOnceRef.current = true;
          id.initialize({
            client_id: clientId,
            cancel_on_tap_outside: true,
            callback: (response: GoogleCredentialResponse) => {
              const idToken = response.credential;
              if (!idToken) {
                setError("Google login failed.");
                return;
              }
              void handleAuth("/v1/auth/google", idToken);
            },
          });
        }

        renderGoogleButton();

        const ro = new ResizeObserver(() => renderGoogleButton());
        if (googleBtnHostRef.current) ro.observe(googleBtnHostRef.current);
        return () => ro.disconnect();
      })
      .catch(() => {
        // ignore
      });

    loadAppleIdentity()
      .then(() => {
        const appleClientId = process.env.NEXT_PUBLIC_APPLE_CLIENT_ID ?? "";
        if (!appleClientId) {
          setAppleReady(false);
          return;
        }

        const AppleID = (window as AppleGlobal).AppleID;
        const auth = AppleID?.auth;
        if (!auth?.init) {
          setAppleReady(false);
          return;
        }

        const redirectUri =
          process.env.NEXT_PUBLIC_APPLE_REDIRECT_URI ??
          `${window.location.origin}/auth/callback`;

        auth.init({
          clientId: appleClientId,
          scope: "name email",
          redirectURI: redirectUri,
          usePopup: true,
        });
        setAppleReady(true);
      })
      .catch(() => setAppleReady(false));

    return () => {
      authLogger.log("CLEANUP", "unmount", {});
      isMountedRef.current = false;
    };
  }, [ui.socialMaxW]);

  const startApple = async () => {
    logDebug("Apple click");
    authLogger.log("AUTH_START", "provider=apple", {});
    setReturnUrl(nextUrlRef.current);

    if (!acceptLegalRef.current) {
      const msg =
        "You must accept the Terms of Service, Privacy Policy, and Cookie Policy before continuing.";
      setError(msg);
      addToast(msg, "error");
      return;
    }

    persistPendingOAuthLegalAcceptance();

    if (busy || inFlightRef.current) return;

    const AppleID = (window as AppleGlobal).AppleID;
    const auth = AppleID?.auth;

    if (!appleReady || !auth?.signIn) {
      const msg = "Apple sign-in is not ready yet.";
      setError(msg);
      addToast(msg, "error");
      return;
    }

    try {
      const response = await auth.signIn();
      const idToken = response.authorization?.id_token;
      const code = response.authorization?.code;

      if (!idToken && !code) {
        const msg = "Apple sign-in failed: No token received.";
        setError(msg);
        addToast(msg, "error");
        return;
      }

      await handleAuth("/v1/auth/apple", idToken, code);
    } catch (err) {
      const msg = toSafeUserError(err, { message: "Apple sign-in failed" }).message;
      setError(msg);
      addToast(msg, "error");
    }
  };

  const onEmailLogin = (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email || !password) {
      setError("Please enter email and password.");
      return;
    }

    void handleAuth("/v1/auth/email/login", undefined, undefined, { email, password });
  };

  const SocialHostStyle: CSSProperties = {
    width: "100%",
    maxWidth: ui.socialMaxW,
    margin: "0 auto",
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

        {/* Warm readability overlay — only as much as needed to keep
            the auth card legible against the bright sunrise artwork.
            No heavy black scrim, no dark teal wash. */}
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,229,207,0.10)_0%,rgba(255,255,255,0.02)_45%,rgba(33,22,45,0.10)_100%)]" />

        <div className="relative z-10 flex min-h-screen flex-col">
          <MarketingHeader />

          <main className="flex flex-1 items-center px-6 pb-14 pt-24 md:px-8 md:pb-20 md:pt-28">
            <div className="mx-auto w-full max-w-7xl">
              <div className="grid gap-10 lg:grid-cols-[0.92fr_0.88fr] lg:items-start">
                {/* Left column is offset down on desktop only so its
                    "Welcome Back" eyebrow lines up with the right
                    card's "Sign in" headline. Same math as Register:
                    card padding (36px) + eyebrow chip (~38px) + mt-4
                    (16px) ≈ 90px from card-top to headline. Mobile
                    keeps zero offset. */}
                <section className="hidden lg:block lg:pt-[88px]">
  <div className="max-w-[900px]">
    <div className="inline-flex items-center gap-2.5 rounded-full border border-[rgba(230,72,128,0.22)] bg-white/70 px-4 py-2 text-[0.74rem] font-semibold uppercase tracking-[0.2em] text-[#21162D] shadow-[0_10px_24px_rgba(33,22,45,0.10)] backdrop-blur-md">
      <span style={{ color: "#E64880" }}>
        <ShieldIcon />
      </span>
      Welcome Back
    </div>

    <h1 className="mt-5 max-w-[760px] text-[2rem] font-medium leading-[0.98] tracking-[-0.045em] text-[#1B1230] md:text-[2.7rem] xl:text-[3.25rem]">
      Return to your{" "}
      <span
        style={{
          background: "linear-gradient(90deg,#C92C63 0%,#D63E76 38%,#E14A68 68%,#8B3DE6 100%)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          backgroundClip: "text",
          color: "transparent",
        }}
      >
        PROOVRA
      </span>{" "}
      workspace.
    </h1>

    <p className="mt-5 max-w-[760px] text-[1rem] leading-[1.82] tracking-[-0.006em] text-[#4B3B4F]">
      Sign in to continue reviewing evidence records, verification reports, cases,
      workspaces, and protected review workflows.
    </p>

    <div className="mt-6 flex flex-wrap gap-2.5">
      {[
        "Evidence Operations Workspace",
        "Secure Review Access",
        "Reports, Cases & Verification Materials",
      ].map((label) => (
        <div
          key={label}
          className="rounded-full border px-3.5 py-2 text-[0.78rem] font-medium text-[#21162D] backdrop-blur-md"
          style={{
            background: "rgba(255,255,255,0.16)",
            borderColor: "rgba(255,255,255,0.32)",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
          }}
        >
          <span className="mr-2" style={{ color: "#E64880" }}>✓</span>
          {label}
        </div>
      ))}
    </div>
  </div>
</section>

                <section className="mx-auto w-full max-w-[520px]">
                  <div
                    className="auth-card auth-premium relative overflow-hidden rounded-[28px]"
                    style={{
                      boxShadow: "0 28px 80px rgba(59,28,74,0.22)",
                      border: "1px solid rgba(255,255,255,0.45)",
                      background: "rgba(255,255,255,0.74)",
                      backdropFilter: "blur(22px) saturate(1.1)",
                      WebkitBackdropFilter: "blur(22px) saturate(1.1)",
                    }}
                  >
                    {/* Warm corner highlights on the glass surface */}
                    <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_85%_15%,rgba(255,179,107,0.16),transparent_40%)]" />
                    <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_8%,rgba(255,255,255,0.55),transparent_30%)]" />

                    <div className="relative z-10 p-8 lg:p-9">
                      <div className="mb-6">
                        <div
                          className="inline-flex items-center gap-2.5 rounded-full px-4 py-2.5 text-[0.74rem] font-semibold uppercase tracking-[0.18em]"
                          style={{
                            color: "#21162D",
                            background: "rgba(230,72,128,0.08)",
                            border: "1px solid rgba(230,72,128,0.20)",
                          }}
                        >
                          <span style={{ color: "#E64880" }}>
                            <ShieldIcon />
                          </span>
                          Account access
                        </div>

                        <h2 className="mt-4 text-[1.9rem] font-semibold tracking-[-0.04em] text-[#1B1230] md:text-[2.15rem]">
                          Sign in
                        </h2>

                        <p className="mt-3 text-[0.96rem] leading-[1.78] text-[#4B3B4F]">
                          Continue with your preferred sign-in method and return safely to your
                          PROOVRA workspace.
                        </p>
                      </div>

                      <div className="auth-actions" style={{ display: "grid", gap: 12 }}>
                        <div ref={googleBtnHostRef} style={SocialHostStyle} aria-label="Continue with Google">
                          <div
                            ref={googleBtnWrapRef}
                            style={{
                              width: "100%",
                              display: "flex",
                              justifyContent: "center",
                              opacity: busy ? 0.7 : 1,
                              pointerEvents: busy ? "none" : "auto",
                            }}
                          />
                        </div>

                        <div style={SocialHostStyle}>
                          <button
                            type="button"
                            aria-label="Continue with Apple"
                            disabled={busy}
                            onClick={() => void startApple()}
                            className="auth-social-btn"
                            style={{
                              background:
                                "linear-gradient(180deg, #2A1C36 0%, #15101F 100%)",
                              color: "#ffffff",
                              border: "1px solid rgba(33,22,45,0.45)",
                              boxShadow: "0 14px 28px rgba(33,22,45,0.22)",
                            }}
                          >
                            <span className="auth-social-icon" aria-hidden="true">
                              <AppleIcon />
                            </span>
                            {t("signInApple")}
                          </button>
                        </div>

                        <div
                          className="auth-divider"
                          style={{
                            color: "#7A687D",
                          }}
                        >
                          {t("orDivider")}
                        </div>

                        <form onSubmit={onEmailLogin} style={{ display: "grid", gap: 10 }}>
                          <div className="auth-input-wrap">
                            <span className="auth-input-icon" aria-hidden="true" style={{ color: "#7A687D" }}>
                              <EmailIcon />
                            </span>
                            <input
                              className="auth-input"
                              placeholder="Email"
                              type="email"
                              autoComplete="email"
                              value={email}
                              onChange={(e) => setEmail(e.target.value)}
                              disabled={busy}
                              style={{
                                background: "rgba(255,255,255,0.84)",
                                border: "1px solid rgba(255,255,255,0.44)",
                                boxShadow: ui.inputShadow,
                                color: "#1B1230",
                              }}
                            />
                          </div>

                          <div style={{ display: "grid", gap: 6 }}>
                            <div className="auth-input-wrap">
                              <span className="auth-input-icon" aria-hidden="true" style={{ color: "#7A687D" }}>
                                <LockIcon />
                              </span>
                              <input
                                className="auth-input"
                                placeholder="Password"
                                type="password"
                                autoComplete="current-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                disabled={busy}
                                style={{
                                  background: "rgba(255,255,255,0.84)",
                                  border: "1px solid rgba(255,255,255,0.44)",
                                  boxShadow: ui.inputShadow,
                                  color: "#1B1230",
                                }}
                              />
                            </div>

                            <div style={{ display: "flex", justifyContent: "flex-end" }}>
                              <button
                                ref={forgotTriggerRef}
                                type="button"
                                onClick={() => setForgotOpen(true)}
                                className="auth-link"
                                style={{
                                  color: "#D63E76",
                                  fontWeight: 600,
                                  background: "transparent",
                                  border: 0,
                                  padding: 0,
                                  cursor: "pointer",
                                  font: "inherit",
                                }}
                              >
                                Forgot password?
                              </button>
                            </div>
                          </div>

<label
  className="auth-legal-check"
  style={{
    display: "flex",
    alignItems: "flex-start",
    gap: 12,
    padding: "12px 14px",
    borderRadius: 16,
    background: "rgba(255,255,255,0.42)",
    border: "1px solid rgba(230,72,128,0.20)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.30)",
    fontSize: 14,
    lineHeight: 1.75,
    color: "#4B3B4F",
  }}
>
  <input
    type="checkbox"
    checked={acceptLegal}
    onChange={(e) => setAcceptLegal(e.target.checked)}
    disabled={busy}
    className="auth-legal-checkbox"
    style={{ accentColor: "#E64880" }}
  />
  <span style={{ display: "block", paddingTop: 1 }}>
    I agree to the{" "}
    <Link href="/legal/terms" className="auth-link" style={{ color: "#D63E76", fontWeight: 600 }}>
      Terms of Service
    </Link>
    {", "}
    <Link href="/legal/privacy" className="auth-link" style={{ color: "#D63E76", fontWeight: 600 }}>
      Privacy Policy
    </Link>
    {" and "}
    <Link href="/legal/cookies" className="auth-link" style={{ color: "#D63E76", fontWeight: 600 }}>
      Cookie Policy
    </Link>
    .
  </span>
</label>
                          <button
                            className="auth-social-btn"
                            type="submit"
                            disabled={busy}
                            style={{
                              background:
                                "linear-gradient(90deg, #E64880 0%, #FF6B6B 52%, #FF8A6A 100%)",
                              color: "#ffffff",
                              border: "1px solid rgba(230,72,128,0.45)",
                              boxShadow: "0 14px 28px rgba(230,72,128,0.22)",
                              fontWeight: 600,
                            }}
                          >
                            Sign in with Email
                          </button>
                        </form>

                        {/* EV5 — distinct affordance for unverified accounts.
                            Reads as a calm verification status block, not an
                            error. Resend button hits the same backend
                            endpoint used by /register and /auth/verify-email. */}
                        {needsVerification && (
                          <div
                            role="status"
                            aria-live="polite"
                            style={{
                              background: "rgba(255,255,255,0.62)",
                              border: "1px solid rgba(230,72,128,0.22)",
                              borderRadius: 16,
                              padding: "14px 16px",
                              color: "#1B1230",
                              display: "grid",
                              gap: 10,
                            }}
                          >
                            <div style={{ fontWeight: 600 }}>
                              Verify your email address
                            </div>
                            <div style={{ color: "#4B3B4F", fontSize: 14, lineHeight: 1.6 }}>
                              Please verify your email address before signing in.
                              The link in your inbox will activate your account.
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                              <button
                                type="button"
                                disabled={verifyResendBusy || !email}
                                onClick={async () => {
                                  if (verifyResendBusy || !email) return;
                                  setVerifyResendBusy(true);
                                  setVerifyResendStatus("Sending verification email…");
                                  try {
                                    await apiFetch(
                                      "/v1/auth/email/resend-verification",
                                      {
                                        method: "POST",
                                        body: JSON.stringify({ email }),
                                      },
                                      { auth: false },
                                    );
                                    setVerifyResendStatus("Verification email sent.");
                                  } catch {
                                    setVerifyResendStatus(
                                      "Please wait before requesting another verification email.",
                                    );
                                  } finally {
                                    window.setTimeout(
                                      () => setVerifyResendBusy(false),
                                      60_000,
                                    );
                                  }
                                }}
                                className="auth-social-btn"
                                style={{
                                  background:
                                    verifyResendBusy || !email
                                      ? "rgba(230,72,128,0.18)"
                                      : "linear-gradient(90deg, #E64880 0%, #FF6B6B 52%, #FF8A6A 100%)",
                                  color:
                                    verifyResendBusy || !email ? "#7A687D" : "#ffffff",
                                  border: "1px solid rgba(230,72,128,0.45)",
                                  boxShadow:
                                    verifyResendBusy || !email
                                      ? "none"
                                      : "0 14px 28px rgba(230,72,128,0.22)",
                                  fontWeight: 600,
                                  cursor:
                                    verifyResendBusy || !email ? "not-allowed" : "pointer",
                                }}
                              >
                                {verifyResendBusy ? "Resend pending…" : "Resend verification email"}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setNeedsVerification(false);
                                  setVerifyResendStatus(null);
                                }}
                                style={{
                                  color: "#D63E76",
                                  fontWeight: 600,
                                  fontSize: 14,
                                  background: "transparent",
                                  border: 0,
                                  padding: 0,
                                  cursor: "pointer",
                                }}
                              >
                                Use a different email
                              </button>
                            </div>
                            {verifyResendStatus ? (
                              <div style={{ color: "#4B3B4F", fontSize: 13 }}>
                                {verifyResendStatus}
                              </div>
                            ) : null}
                          </div>
                        )}

                        {error && (
                          <div
                            className="error-text"
                            role="alert"
                            style={{
                              color: "#D14343",
                              background: "rgba(255,255,255,0.62)",
                              border: "1px solid rgba(209,67,67,0.20)",
                              borderRadius: 14,
                              padding: "10px 12px",
                            }}
                          >
                            {error}
                          </div>
                        )}

                        {status && (
                          <div
                            className="auth-status"
                            style={{
                              color: "#4B3B4F",
                              background: "rgba(255,255,255,0.52)",
                              border: "1px solid rgba(230,72,128,0.12)",
                              borderRadius: 14,
                              padding: "10px 12px",
                            }}
                          >
                            {status}
                          </div>
                        )}

                        {DEBUG_AUTH && (
                          <div
                            className="auth-debug-panel"
                            style={{
                              background: "rgba(255,255,255,0.42)",
                              border: "1px solid rgba(79,112,107,0.10)",
                              borderRadius: 16,
                              padding: 12,
                              color: "#4f5f63",
                            }}
                          >
                            <div style={{ fontWeight: 700, marginBottom: 6 }}>Auth Debug</div>
                            <div>Apple: {appleReady ? "ready" : "missing"}</div>
                            <div>nextUrl: {nextUrl}</div>
                            <div>acceptLegal: {acceptLegal ? "true" : "false"}</div>
                          </div>
                        )}
                      </div>

                      <div
                        className="auth-switch"
                        style={{
                          marginTop: 18,
                          color: "#4B3B4F",
                        }}
                      >
                        <span>{t("register")}? </span>
                        <Link href="/register" style={{ color: "#D63E76", fontWeight: 600 }}>
                          {t("register")}
                        </Link>
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </main>
        </div>

        {/* FP3 — forgot-password modal mounted at the page root so it
            sits above the auth card backdrop and inherits the warm
            palette regardless of which section the trigger lives in. */}
        <ForgotPasswordModal
          open={forgotOpen}
          onClose={() => setForgotOpen(false)}
        />
      </div>
    </div>
  );
}