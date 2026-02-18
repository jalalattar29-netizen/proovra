"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, useToast } from "../../components/ui";
import { useAuth, useLocale } from "../providers";
import { apiFetch, ApiError } from "../../lib/api";
import { formatBuildInfo } from "../../lib/build-info";
import { authLogger } from "../../lib/auth-logger";
import { loadAppleIdentity, loadGoogleIdentity } from "../../lib/oauth";

const DEBUG_AUTH = process.env.NEXT_PUBLIC_DEBUG_AUTH === "1";

type GoogleCredentialResponse = { credential?: string };

type GoogleAccountsId = {
  initialize: (options: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    cancel_on_tap_outside?: boolean;
  }) => void;
  prompt: () => void;
};

type GoogleGlobal = Window & {
  google?: {
    accounts?: {
      id?: GoogleAccountsId;
    };
  };
};

type AppleSignInResponse = { authorization?: { code?: string; id_token?: string } };

type AppleAuth = {
  init: (options: {
    clientId: string;
    scope: string;
    redirectURI: string;
    usePopup: boolean;
  }) => void;
  signIn: () => Promise<AppleSignInResponse>;
};

type AppleGlobal = Window & {
  AppleID?: {
    auth?: AppleAuth;
  };
};

export default function LoginPage() {
  const { t } = useLocale();
  const { setToken } = useAuth();
  const { addToast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextUrl = searchParams.get("next") || searchParams.get("returnUrl") || "/home";

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [googleReady, setGoogleReady] = useState(false);
  const [appleReady, setAppleReady] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const isMountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const googleInitOnceRef = useRef(false);

  const logDebug = (msg: string) => {
    if (DEBUG_AUTH) console.info(`[Auth] ${msg}`);
  };

  const handleAuth = async (path: string, idToken?: string, code?: string, extraBody?: Record<string, unknown>) => {
    if (!isMountedRef.current) return;
    if (inFlightRef.current) return;

    inFlightRef.current = true;
    setBusy(true);
    setError(null);

    const provider = path.includes("google") ? "google" : path.includes("apple") ? "apple" : path.includes("guest") ? "guest" : "email";
    setStatus(`Signing in via ${provider}...`);

    const guestToken = typeof window !== "undefined" ? localStorage.getItem("proovra-token") : null;

    authLogger.logTokenExchangeStart(provider, path);

    try {
      try {
        sessionStorage.setItem("proovra-return-url", nextUrl);
      } catch {
        // ignore
      }

      const payload =
        extraBody ?? (idToken ? { idToken } : code ? { code } : {});

      authLogger.log(
        "TOKEN_EXCHANGE",
        "request_payload",
        { endpoint: path, has_idToken: !!idToken, has_code: !!code },
        provider
      );

      const data = await apiFetch(path, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      authLogger.logTokenExchangeSuccess(provider, data);
      if (!isMountedRef.current) return;

      setToken(data.token);

      const me = await apiFetch("/v1/auth/me", { method: "GET" });
      authLogger.logSessionValidation("/v1/auth/me", me);

      if (!me?.user && !data.token) throw new Error("Session not confirmed");

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

      router.replace(nextUrl);
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

  useEffect(() => {
    if (typeof window === "undefined") return;
    isMountedRef.current = true;

    loadGoogleIdentity()
      .then(() => {
        const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
        if (!clientId) return setGoogleReady(false);

        const google = (window as GoogleGlobal).google;
        const id = google?.accounts?.id;
        if (!id?.initialize) return setGoogleReady(false);

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

        setGoogleReady(true);
      })
      .catch(() => setGoogleReady(false));

    loadAppleIdentity()
      .then(() => {
        const appleClientId = process.env.NEXT_PUBLIC_APPLE_CLIENT_ID ?? "";
        if (!appleClientId) return setAppleReady(false);

        const AppleID = (window as AppleGlobal).AppleID;
        const auth = AppleID?.auth;
        if (!auth?.init) return setAppleReady(false);

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

    return () => {
      authLogger.log("CLEANUP", "unmount", {});
      isMountedRef.current = false;
    };
  }, [nextUrl]);

  const startGoogle = () => {
    logDebug("Google click");
    authLogger.log("AUTH_START", "provider=google", {});
    try {
      sessionStorage.setItem("proovra-return-url", nextUrl);
    } catch {
      // ignore
    }
    if (busy || inFlightRef.current) return;

    const google = (window as GoogleGlobal).google;
    const id = google?.accounts?.id;

    if (!googleReady || !id?.prompt) {
      const msg = "Google sign-in is not ready yet.";
      setError(msg);
      addToast(msg, "error");
      return;
    }

    id.prompt();
  };

  const startApple = async () => {
    logDebug("Apple click");
    authLogger.log("AUTH_START", "provider=apple", {});
    try {
      sessionStorage.setItem("proovra-return-url", nextUrl);
    } catch {
      // ignore
    }
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
    if (!email || !password) {
      setError("Please enter email and password.");
      return;
    }
    void handleAuth("/v1/auth/email/login", undefined, undefined, { email, password });
  };

  return (
    <div className="blue-shell auth-screen">
      <div className="container">
        <header className="auth-top">
          <Link href="/" className="auth-brand">
            <img src="/brand/logo-white.svg" alt="PROO✓RA" />
            <span>{t("brand")}</span>
          </Link>

          <nav className="auth-top-links">
            <Link href="/register">{t("register")}</Link>
          </nav>
        </header>

        <main className="auth-main">
          <div className="auth-card">
            <h2 className="auth-title">{t("signInTitle")}</h2>

            <div className="auth-actions">
              <button type="button" className="social-btn" disabled={busy} onClick={startGoogle}>
                <span className="google-icon" aria-hidden="true" />
                Continue with Google
              </button>

              <button type="button" className="social-btn" disabled={busy} onClick={() => void startApple()}>
                <span className="apple-icon" aria-hidden="true"></span>
                {t("signInApple")}
              </button>

              <div className="auth-divider">{t("orDivider")}</div>

              {/* Email login */}
              <form onSubmit={onEmailLogin} className="auth-email-form" style={{ display: "grid", gap: 10 }}>
                <input
                  className="auth-input"
                  placeholder="Email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy}
                />
                <div style={{ display: "grid", gap: 6 }}>
                  <input
                    className="auth-input"
                    placeholder="Password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={busy}
                  />
                  <div style={{ textAlign: "right", fontSize: 12 }}>
                    <Link href="/forgot-password" style={{ color: "#334155" }}>
                      Forgot password?
                    </Link>
                  </div>
                </div>

                {/* NOTE: Button component ممكن ما يدعم type عندك، لذلك خليتها native button */}
                <button className="social-btn" type="submit" disabled={busy}>
                  Sign in with Email
                </button>
              </form>

              <Button variant="secondary" onClick={() => handleAuth("/v1/auth/guest")} disabled={busy}>
                {t("continueGuest")}
              </Button>

              {error && <div className="error-text">{error}</div>}
              {status && <div style={{ fontSize: 12, color: "#64748b" }}>{status}</div>}

              {DEBUG_AUTH && (
                <div
                  className="auth-debug-panel"
                  style={{
                    marginTop: 12,
                    padding: 12,
                    background: "#f1f5f9",
                    borderRadius: 8,
                    fontSize: 11,
                    color: "#475569",
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Auth Debug</div>
                  <div>Google: {googleReady ? "ready" : "missing"}</div>
                  <div>Apple: {appleReady ? "ready" : "missing"}</div>
                  <div>nextUrl: {nextUrl}</div>
                </div>
              )}
            </div>

            <div className="auth-switch">
              <span>{t("register")}? </span>
              <Link href="/register">{t("register")}</Link>
            </div>

            <div
              style={{
                marginTop: 20,
                paddingTop: 20,
                borderTop: "1px solid #e2e8f0",
                fontSize: 10,
                color: "#94a3b8",
                textAlign: "center",
              }}
            >
              {formatBuildInfo()}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
