"use client";

import { FormEvent, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, useToast } from "../../components/ui";
import { useAuth, useLocale } from "../providers";
import { apiFetch, ApiError } from "../../lib/api";
import { authLogger } from "../../lib/auth-logger";
import { loadAppleIdentity, loadGoogleIdentity } from "../../lib/oauth";
import { MarketingHeader } from "../../components/header";

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

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="m9 16.2-3.5-3.5L4.1 14.1 9 19l11-11-1.4-1.4L9 16.2Z" />
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

export default function RegisterPage() {
  const { t } = useLocale();
  const { setToken } = useAuth();
  const { addToast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnUrl = searchParams.get("returnUrl") || "/home";

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [appleReady, setAppleReady] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");

  const inFlightRef = useRef(false);
  const googleInitOnceRef = useRef(false);
  const googleBtnWrapRef = useRef<HTMLDivElement | null>(null);
  const googleBtnHostRef = useRef<HTMLDivElement | null>(null);

  const ui = useMemo(() => {
    // (نفس إحساس login)
    const cardShadow = "0 24px 70px rgba(2, 9, 22, 0.55)";
    const border = "1px solid rgba(101, 235, 255, 0.22)";
    const socialMaxW = 360;
    return { cardShadow, border, socialMaxW };
  }, []);

  const setReturnUrl = (url: string) => {
    try {
      sessionStorage.setItem("proovra-return-url", url);
    } catch {
      // ignore
    }
  };

  const handleAuth = async (path: string, idToken?: string, code?: string, extraBody?: Record<string, unknown>) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    setBusy(true);
    setError(null);

    const provider = path.includes("google")
      ? "google"
      : path.includes("apple")
      ? "apple"
      : path.includes("guest")
      ? "guest"
      : "email";

    setStatus(`Signing in via ${provider}...`);

    const guestToken = typeof window !== "undefined" ? localStorage.getItem("proovra-token") : null;

    try {
      setReturnUrl(returnUrl);

      const payload = extraBody ?? (idToken ? { idToken } : code ? { code } : {});
      const data = await apiFetch(path, { method: "POST", body: JSON.stringify(payload) }, { auth: false });

      setToken(data.token);

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

      router.push(returnUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Registration failed";
      const requestId = err instanceof ApiError ? err.requestId : undefined;

      authLogger.log("AUTH_SESSION_FAILED", "error", { message: msg, requestId }, provider);
      setError(requestId ? `${msg} (requestId: ${requestId})` : msg);
      setStatus("Sign in failed.");
      addToast(requestId ? `${msg} (requestId: ${requestId})` : msg, "error", 6000);
    } finally {
      setBusy(false);
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
                setError("Google sign-up failed.");
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

        const redirectUri = process.env.NEXT_PUBLIC_APPLE_REDIRECT_URI ?? `${window.location.origin}/auth/callback`;

        auth.init({
          clientId: appleClientId,
          scope: "name email",
          redirectURI: redirectUri,
          usePopup: true,
        });

        setAppleReady(true);
      })
      .catch(() => setAppleReady(false));
  }, [returnUrl]);

  const startApple = async () => {
    setReturnUrl(returnUrl);
    if (busy || inFlightRef.current) return;

    const AppleID = (window as AppleGlobal).AppleID;
    const auth = AppleID?.auth;

    if (!appleReady || !auth?.signIn) {
      const msg = "Apple sign-up is not ready yet.";
      setError(msg);
      addToast(msg, "error");
      return;
    }

    try {
      const response = await auth.signIn();
      const idToken = response.authorization?.id_token;
      const code = response.authorization?.code;

      if (!idToken && !code) {
        const msg = "Apple sign-up failed: No token received.";
        setError(msg);
        addToast(msg, "error");
        return;
      }

      await handleAuth("/v1/auth/apple", idToken, code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Apple sign-up failed";
      setError(msg);
      addToast(msg, "error");
    }
  };

  const onEmailRegister = (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email || !password || !password2) {
      setError("Please fill email and password.");
      return;
    }
    if (password !== password2) {
      setError("Passwords do not match.");
      return;
    }

    void handleAuth("/v1/auth/email/register", undefined, undefined, { email, password });
  };

  const SocialHostStyle: CSSProperties = {
    width: "100%",
    maxWidth: ui.socialMaxW,
    margin: "0 auto",
  };

  return (
    <div className="page landing-page">
      <div className="blue-shell auth-screen auth-dark">
        {/* ✅ نفس هيدر الموقع */}
        <MarketingHeader />

        <div className="container">
          <main className="auth-main">
            <div
              className="auth-card"
              style={{
                boxShadow: ui.cardShadow,
                border: ui.border,
                backdropFilter: "blur(12px)",
              }}
            >
              <h2 className="auth-title">{t("createAccountTitle")}</h2>

              <div className="auth-actions" style={{ display: "grid", gap: 12 }}>
                {/* Google */}
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

                {/* Apple */}
                <div style={SocialHostStyle}>
                  <button type="button" disabled={busy} onClick={() => void startApple()} className="auth-social-btn">
                    <span className="auth-social-icon" aria-hidden="true">
                      <AppleIcon />
                    </span>
                    Continue with Apple
                  </button>
                </div>

                <div className="auth-divider">{t("orDivider")}</div>

                {/* Email register */}
                <form onSubmit={onEmailRegister} style={{ display: "grid", gap: 10 }}>
                  <div className="auth-input-wrap">
                    <span className="auth-input-icon" aria-hidden="true">
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
                    />
                  </div>

                  <div className="auth-input-wrap">
                    <span className="auth-input-icon" aria-hidden="true">
                      <LockIcon />
                    </span>
                    <input
                      className="auth-input"
                      placeholder="Password"
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={busy}
                    />
                  </div>

                  <div className="auth-input-wrap">
                    <span className="auth-input-icon" aria-hidden="true">
                      <CheckIcon />
                    </span>
                    <input
                      className="auth-input"
                      placeholder="Confirm password"
                      type="password"
                      autoComplete="new-password"
                      value={password2}
                      onChange={(e) => setPassword2(e.target.value)}
                      disabled={busy}
                    />
                  </div>

                  <button className="auth-social-btn" type="submit" disabled={busy}>
                    Create account with Email
                  </button>
                </form>

                <Button variant="secondary" onClick={() => handleAuth("/v1/auth/guest")} disabled={busy}>
                  {t("continueGuest")}
                </Button>

                {error && <div className="error-text">{error}</div>}
                {status && <div className="auth-status">{status}</div>}
              </div>

              <div className="auth-switch">
                <span>{t("login")}? </span>
                <Link href="/login">{t("login")}</Link>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}