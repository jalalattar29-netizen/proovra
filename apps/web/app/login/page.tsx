"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, useToast } from "../../components/ui";
import { useAuth, useLocale } from "../providers";
import { apiFetch, ApiError } from "../../lib/api";
import { formatBuildInfo } from "../../lib/build-info";
import { authLogger } from "../../lib/auth-logger";
import { buildAppleAuthUrl, buildGoogleAuthUrl } from "../../lib/oauth";

const DEBUG_AUTH = process.env.NEXT_PUBLIC_DEBUG_AUTH === "1";

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
  const [googleHref, setGoogleHref] = useState<string>("");
  const [appleHref, setAppleHref] = useState<string>("");
  const [mounted, setMounted] = useState(false);
  const [debugEvents, setDebugEvents] = useState<string[]>([]);
  const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? "";
  const isMountedRef = useRef(true);

  const logDebug = (msg: string) => {
    if (DEBUG_AUTH) {
      const entry = `[${new Date().toISOString().slice(11, 23)}] ${msg}`;
      console.info(`[Auth] ${msg}`);
      setDebugEvents((prev) => [...prev.slice(-19), entry]);
    }
  };

  const handleAuth = async (path: string, idToken?: string, code?: string) => {
    if (!isMountedRef.current) return;
    setBusy(true);
    setError(null);
    const provider = path.includes("google") ? "google" : path.includes("apple") ? "apple" : "guest";
    setStatus(`Signing in via ${provider}...`);
    const guestToken = typeof window !== "undefined" ? localStorage.getItem("proovra-token") : null;
    
    authLogger.logTokenExchangeStart(provider, path);
    
    try {
      const payload = idToken ? { idToken } : code ? { code } : {};
      authLogger.log("TOKEN_EXCHANGE", "request_payload", {
        has_idToken: !!idToken,
        has_code: !!code,
        endpoint: path
      }, provider);

      const data = await apiFetch(path, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      authLogger.logTokenExchangeSuccess(provider, data);
      if (!isMountedRef.current) return;
      setToken(data.token);

      const me = await apiFetch("/v1/auth/me", { method: "GET" });
      authLogger.logSessionValidation("/v1/auth/me", me);
      
      if (!me?.user && !data.token) {
        throw new Error("Session not confirmed");
      }

      if (guestToken) {
        try {
          await apiFetch("/v1/evidence/claim", {
            method: "POST",
            body: JSON.stringify({ guestToken })
          });
        } catch {
          // ignore
        }
      }

      const userId = me?.user && typeof me.user === "object" && "id" in me.user ? (me.user as { id: string }).id : undefined;
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
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;

    const nextAppleState =
      window.crypto?.randomUUID?.() ?? `apple-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    let nextGoogleHref = "";
    let nextAppleHref = "";
    try {
      nextGoogleHref = buildGoogleAuthUrl({ state: "google" });
      authLogger.logUrlBuilt("google", nextGoogleHref, { state: "google" });
    } catch (e) {
      authLogger.logError("url_build_google", e instanceof Error ? e.message : "unknown");
    }
    if (!nextGoogleHref) {
      const params = new URLSearchParams({
        client_id: "548168595768-8uddhhcmdgl9108juth8fke4boncenut.apps.googleusercontent.com",
        redirect_uri: "https://www.proovra.com/auth/callback",
        response_type: "code",
        scope: "openid email profile",
        state: "google",
        access_type: "offline",
        prompt: "consent"
      });
      nextGoogleHref = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    try {
      nextAppleHref = buildAppleAuthUrl({ state: nextAppleState });
      authLogger.logUrlBuilt("apple", nextAppleHref, { state: nextAppleState });
    } catch (e) {
      authLogger.logError("url_build_apple", e instanceof Error ? e.message : "unknown");
    }
    if (!nextAppleHref) {
      const params = new URLSearchParams({
        response_type: "code id_token",
        response_mode: "form_post",
        client_id: "com.proovra.web",
        redirect_uri: "https://www.proovra.com/auth/callback",
        scope: "name email",
        state: nextAppleState
      });
      nextAppleHref = `https://appleid.apple.com/auth/authorize?${params.toString()}`;
    }

    setGoogleHref(nextGoogleHref);
    setAppleHref(nextAppleHref);
    setMounted(true);
    isMountedRef.current = true;

    try {
      sessionStorage.setItem("proovra-apple-state", nextAppleState);
    } catch {
      void 0;
    }

    if (DEBUG_AUTH) {
      console.info("[Auth] Redirect URIs ready:", {
        google: !!nextGoogleHref,
        apple: !!nextAppleHref,
        hostname: window.location.hostname,
        origin: window.location.origin
      });
    }

    return () => {
      authLogger.log("CLEANUP", "unmount", {});
      isMountedRef.current = false;
    };
  }, []);

  return (
    <div className="blue-shell auth-screen">
      <div className="container">
        <header className="auth-top">
          {/* ✅ clickable brand */}
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
              <a
                className="social-btn"
                href={mounted && googleHref ? googleHref : "#"}
                onClick={(event) => {
                  logDebug("Google click");
                  authLogger.log("AUTH_START", "provider=google", {});
                  try {
                    sessionStorage.setItem("proovra-return-url", nextUrl);
                  } catch { void 0; }
                  if (busy) {
                    event.preventDefault();
                    return;
                  }
                  if (!googleHref) {
                    event.preventDefault();
                    const msg = "Google sign-in failed: Redirect URL not ready.";
                    setError(msg);
                    addToast(msg, "error");
                    return;
                  }
                  // Let anchor navigate (redirect flow) — no preventDefault
                }}
              >
                <span className="google-icon" aria-hidden="true" />
                Continue with Google
              </a>

              <a
                className="social-btn"
                href={mounted && appleHref ? appleHref : "#"}
                onClick={(event) => {
                  logDebug("Apple click");
                  authLogger.log("AUTH_START", "provider=apple", {});
                  try {
                    sessionStorage.setItem("proovra-return-url", nextUrl);
                  } catch { void 0; }
                  if (busy) {
                    event.preventDefault();
                    return;
                  }
                  if (!appleHref) {
                    event.preventDefault();
                    const msg = "Apple sign-in failed: Redirect URL not ready.";
                    setError(msg);
                    addToast(msg, "error");
                    return;
                  }
                  // Let anchor navigate (redirect flow) — no preventDefault
                }}
              >
                <span className="apple-icon" aria-hidden="true">
                  
                </span>
                {t("signInApple")}
              </a>

              <div className="auth-divider">{t("orDivider")}</div>

              <Button variant="secondary" onClick={() => handleAuth("/v1/auth/guest")} disabled={busy}>
                {t("continueGuest")}
              </Button>

              {error && <div className="error-text">{error}</div>}
              {status && <div style={{ fontSize: 12, color: "#64748b" }}>{status}</div>}

              {DEBUG_AUTH && mounted && (
                <div className="auth-debug-panel" style={{ marginTop: 12, padding: 12, background: "#f1f5f9", borderRadius: 8, fontSize: 11, color: "#475569" }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Auth Debug</div>
                  <div>API: {apiBase || "missing"}</div>
                  <div>Google: {googleHref ? "ready" : "missing"}</div>
                  <div>Apple: {appleHref ? "ready" : "missing"}</div>
                  {debugEvents.length > 0 && (
                    <div style={{ marginTop: 8, maxHeight: 80, overflow: "auto" }}>
                      {debugEvents.map((e, i) => <div key={i}>{e}</div>)}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="auth-switch">
              <span>{t("register")}? </span>
              <Link href="/register">{t("register")}</Link>
            </div>

            <div style={{ marginTop: 20, paddingTop: 20, borderTop: "1px solid #e2e8f0", fontSize: 10, color: "#94a3b8", textAlign: "center" }}>
              {formatBuildInfo()}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
