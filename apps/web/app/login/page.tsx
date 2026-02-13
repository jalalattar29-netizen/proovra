"use client";

import { useEffect, useRef, useState } from "react";
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

  const isMountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const googleInitOnceRef = useRef(false);

  const logDebug = (msg: string) => {
    if (DEBUG_AUTH) console.info(`[Auth] ${msg}`);
  };

  const handleAuth = async (path: string, idToken?: string, code?: string) => {
    if (!isMountedRef.current) return;
    if (inFlightRef.current) return;

    inFlightRef.current = true;
    setBusy(true);
    setError(null);

    const provider = path.includes("google") ? "google" : path.includes("apple") ? "apple" : "guest";
    setStatus(`Signing in via ${provider}...`);

    const guestToken = typeof window !== "undefined" ? localStorage.getItem("proovra-token") : null;

    authLogger.logTokenExchangeStart(provider, path);

    try {
      try {
        sessionStorage.setItem("proovra-return-url", nextUrl);
      } catch {
        // ignore
      }

      const payload = idToken ? { idToken } : code ? { code } : {};

      authLogger.log(
        "TOKEN_EXCHANGE",
        "request_payload",
        {
          has_idToken: !!idToken,
          has_code: !!code,
          endpoint: path,
        },
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

      const userId =
        me?.user && typeof me.user === "object" && "id" in me.user ? (me.user as { id: string }).id : undefined;

      authLogger.log("AUTH_SESSION_SUCCESS", `userId=${userId ?? "unknown"}`, { provider, redirectTo: nextUrl }, provider);
      authLogger.log("LOGIN", "success", { provider, redirectTo: nextUrl }, provider);

      if (!isMountedRef.current) return;
      router.replace(nextUrl);
    } catch (err) {
      if (!isMountedRef.current) return;

      const msg = err instanceof Error ? err.message : "Login failed";
      const requestId = err instanceof ApiError ? err.requestId : undefined;

      authLogger.log("AUTH_SESSION_FAILED", "error", { code: "token_exchange_failed", message: msg, requestId }, provider);
      authLogger.logTokenExchangeError(provider, msg);

      const providerLabel = provider === "guest" ? "" : provider.charAt(0).toUpperCase() + provider.slice(1);
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

    // GOOGLE init (GIS)
    loadGoogleIdentity()
      .then(() => {
        const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
        if (!clientId) {
          setGoogleReady(false);
          return;
        }

        const google = (window as GoogleGlobal).google;
        const id = google?.accounts?.id;

        if (!id?.initialize) {
          setGoogleReady(false);
          return;
        }

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

    // APPLE init (popup)
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

    return () => {
      authLogger.log("CLEANUP", "unmount", {});
      isMountedRef.current = false;
    };
    // intentionally run once
  }, []);

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
                <span className="apple-icon" aria-hidden="true">
                  
                </span>
                {t("signInApple")}
              </button>

              <div className="auth-divider">{t("orDivider")}</div>

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
