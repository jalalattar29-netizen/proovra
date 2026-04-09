"use client";

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
import { Button, useToast } from "../../components/ui";
import { useAuth, useLocale } from "../providers";
import { apiFetch, ApiError } from "../../lib/api";
import { authLogger } from "../../lib/auth-logger";
import { loadAppleIdentity, loadGoogleIdentity } from "../../lib/oauth";
import { MarketingHeader } from "../../components/header";
import { Footer } from "../../components/Footer";
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

    const guestToken =
      typeof window !== "undefined" ? localStorage.getItem("proovra-token") : null;

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

      const msg = err instanceof Error ? err.message : "Login failed";
      const requestId = err instanceof ApiError ? err.requestId : undefined;

      authLogger.log("AUTH_SESSION_FAILED", "error", { message: msg, requestId }, provider);
      authLogger.logTokenExchangeError(provider, msg);

      const providerLabel =
        provider === "guest" ? "" : provider.charAt(0).toUpperCase() + provider.slice(1);
      const displayMsg = providerLabel ? `${providerLabel} sign-in failed: ${msg}` : msg;

      setError(displayMsg);
      setStatus("Sign in failed.");
      addToast(requestId ? `${displayMsg} (requestId: ${requestId})` : displayMsg, "error", 6000);
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
      const msg = err instanceof Error ? err.message : "Apple sign-in failed";
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
            src="/images/site-velvet-bg.webp.png"
            alt=""
            className="h-full w-full object-cover object-center"
          />
        </div>

        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,18,22,0.84)_0%,rgba(8,18,22,0.74)_38%,rgba(8,18,22,0.76)_100%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_16%,rgba(158,216,207,0.08),transparent_24%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_24%,rgba(214,184,157,0.06),transparent_18%)]" />
        <div className="absolute inset-0 opacity-[0.035] [background:repeating-linear-gradient(0deg,rgba(255,255,255,0.024)_0px,rgba(255,255,255,0.024)_1px,transparent_1px,transparent_4px)]" />

        <div className="relative z-10 flex min-h-screen flex-col">
          <MarketingHeader />

          <main className="flex flex-1 items-center justify-center px-6 pb-14 pt-8 md:px-8 md:pb-20 md:pt-12">
            <div className="w-full max-w-[1180px]">
              <div className="grid gap-8 lg:grid-cols-[0.88fr_0.9fr] lg:items-center">
                <section className="hidden lg:block">
                  <div className="max-w-[500px]">
                    <div className="inline-flex items-center gap-2.5 rounded-full border border-white/10 bg-white/[0.055] px-4 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#dce3e0] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md">
                      <span className="text-[#9ed8cf]">
                        <ShieldIcon />
                      </span>
                      Secure access
                    </div>

                    <h1 className="mt-5 max-w-[520px] text-[1.85rem] font-medium leading-[1.02] tracking-[-0.04em] text-[#edf1ef] md:text-[2.35rem] xl:text-[2.8rem]">
                      Sign in to continue your{" "}
                      <span className="text-[#bfe8df]">evidence workflow</span>.
                    </h1>

                    <p className="mt-5 max-w-[500px] text-[0.98rem] leading-[1.82] tracking-[-0.006em] text-[#c7cfcc]">
                      Access your dashboard, verification records, reports, and protected evidence
                      flows using email, Google, Apple, or guest access.
                    </p>

                    <div className="mt-6 flex flex-wrap gap-2.5">
                      <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                        <span className="mr-2 text-[#9dd2ca]">✓</span>
                        Google and Apple sign-in
                      </div>

                      <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                        <span className="mr-2 text-[#9dd2ca]">✓</span>
                        Email access available
                      </div>

                      <div className="rounded-full border border-[rgba(214,184,157,0.24)] bg-[linear-gradient(180deg,rgba(183,157,132,0.08)_0%,rgba(255,255,255,0.03)_100%)] px-3.5 py-2 text-[0.78rem] text-[#e1d4c7] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                        <span className="mr-2 text-[#d6b89d]">✓</span>
                        Guest access supported
                      </div>
                    </div>
                  </div>
                </section>

                <section className="mx-auto w-full max-w-[540px]">
                  <div
                    className="auth-card auth-premium relative overflow-hidden rounded-[30px]"
                    style={{
                      boxShadow: "0 30px 80px rgba(0,0,0,0.18)",
                      border: "1px solid rgba(79,112,107,0.22)",
                    }}
                  >
                    <img
                      src="/images/panel-silver.webp.png"
                      alt=""
                      className="absolute inset-0 h-full w-full object-cover object-center"
                    />
                    <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.55)_100%)]" />
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_20%,rgba(214,184,157,0.18),transparent_40%)]" />
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_10%,rgba(255,255,255,0.35),transparent_30%)]" />

                    <div className="relative z-10 p-7 md:p-8">
                      <div className="mb-6">
                        <div className="inline-flex items-center gap-2.5 rounded-full border border-[#23373b]/8 bg-[rgba(35,55,59,0.05)] px-4 py-2.5 text-[0.74rem] font-semibold uppercase tracking-[0.18em] text-[#566366]">
                          <span className="text-[#3f5e62]">
                            <ShieldIcon />
                          </span>
                          Account access
                        </div>

                        <h2 className="mt-4 text-[1.9rem] font-semibold tracking-[-0.04em] text-[#16282d] md:text-[2.15rem]">
                          {t("signInTitle")}
                        </h2>

                        <p className="mt-3 text-[0.96rem] leading-[1.78] text-[#5c6a6e]">
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
                            disabled={busy}
                            onClick={() => void startApple()}
                            className="auth-social-btn"
                            style={{
                              background:
                                "linear-gradient(180deg, rgba(62,96,99,0.96) 0%, rgba(24,43,48,0.98) 100%)",
                              color: "#eef3f1",
                              border: "1px solid rgba(79,112,107,0.28)",
                              boxShadow: "0 14px 28px rgba(20,48,52,0.16)",
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
                            color: "#6c787c",
                          }}
                        >
                          {t("orDivider")}
                        </div>

                        <form onSubmit={onEmailLogin} style={{ display: "grid", gap: 10 }}>
                          <div className="auth-input-wrap">
                            <span className="auth-input-icon" aria-hidden="true" style={{ color: "#446166" }}>
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
                                background: "rgba(255,255,255,0.9)",
                                border: "1px solid rgba(79,112,107,0.16)",
                                boxShadow: ui.inputShadow,
                                color: "#102126",
                              }}
                            />
                          </div>

                          <div style={{ display: "grid", gap: 6 }}>
                            <div className="auth-input-wrap">
                              <span className="auth-input-icon" aria-hidden="true" style={{ color: "#446166" }}>
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
                                  background: "rgba(255,255,255,0.9)",
                                  border: "1px solid rgba(79,112,107,0.16)",
                                  boxShadow: ui.inputShadow,
                                  color: "#102126",
                                }}
                              />
                            </div>

                            <div style={{ display: "flex", justifyContent: "flex-end" }}>
                              <Link href="/forgot-password" className="auth-link" style={{ color: "#45656a" }}>
                                Forgot password?
                              </Link>
                            </div>
                          </div>

                          <label
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              gap: 10,
                              fontSize: 13,
                              lineHeight: 1.6,
                              color: "#5f6d71",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={acceptLegal}
                              onChange={(e) => setAcceptLegal(e.target.checked)}
                              disabled={busy}
                              style={{ marginTop: 3 }}
                            />
                            <span>
                              I agree to the{" "}
                              <Link href="/legal/terms" className="auth-link" style={{ color: "#b79d84" }}>
                                Terms of Service
                              </Link>
                              {", "}
                              <Link href="/legal/privacy" className="auth-link" style={{ color: "#b79d84" }}>
                                Privacy Policy
                              </Link>
                              {" and "}
                              <Link href="/legal/cookies" className="auth-link" style={{ color: "#b79d84" }}>
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
                                "linear-gradient(180deg, rgba(62,96,99,0.96) 0%, rgba(24,43,48,0.98) 100%)",
                              color: "#eef3f1",
                              border: "1px solid rgba(79,112,107,0.28)",
                              boxShadow: "0 14px 28px rgba(20,48,52,0.16)",
                            }}
                          >
                            Sign in with Email
                          </button>
                        </form>

                        <Button
                          variant="secondary"
                          onClick={() => handleAuth("/v1/auth/guest")}
                          disabled={busy}
                          style={{
                            background:
                              "linear-gradient(180deg, rgba(255,255,255,0.65) 0%, rgba(245,246,244,0.95) 100%)",
                            color: "#23373b",
                            border: "1px solid rgba(79,112,107,0.18)",
                            boxShadow: "0 12px 24px rgba(0,0,0,0.06)",
                          }}
                        >
                          {t("continueGuest")}
                        </Button>

                        {error && (
                          <div
                            className="error-text"
                            style={{
                              color: "#b42318",
                              background: "rgba(255,255,255,0.52)",
                              border: "1px solid rgba(180,35,24,0.12)",
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
                              color: "#496268",
                              background: "rgba(255,255,255,0.42)",
                              border: "1px solid rgba(79,112,107,0.10)",
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
                          color: "#617074",
                        }}
                      >
                        <span>{t("register")}? </span>
                        <Link href="/register" style={{ color: "#45656a", fontWeight: 600 }}>
                          {t("register")}
                        </Link>
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </main>

          <Footer />
        </div>
      </div>
    </div>
  );
}