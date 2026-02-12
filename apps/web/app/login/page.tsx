"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "../../components/ui";
import { useAuth, useLocale } from "../providers";
import { apiFetch } from "../../lib/api";
import {
  buildAppleAuthUrl,
  buildGoogleAuthUrl,
  loadGoogleIdentity
} from "../../lib/oauth";

export default function LoginPage() {
  const { t } = useLocale();
  const { setToken } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextUrl = searchParams.get("next") || searchParams.get("returnUrl") || "/home";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [googleReady, setGoogleReady] = useState(false);
  const [appleReady, setAppleReady] = useState(false);
  const [googleHref, setGoogleHref] = useState<string>("");
  const [appleHref, setAppleHref] = useState<string>("");
  const [mounted, setMounted] = useState(false);
  const [debugGoogleHref, setDebugGoogleHref] = useState<string>("");
  const [debugAppleHref, setDebugAppleHref] = useState<string>("");
  const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? "";

  const handleAuth = async (path: string, idToken?: string, code?: string) => {
    setBusy(true);
    setError(null);
    setStatus(`Signing in via ${path}...`);
    const guestToken = typeof window !== "undefined" ? localStorage.getItem("proovra-token") : null;
    try {
      const payload = idToken ? { idToken } : code ? { code } : {};
      const data = await apiFetch(path, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      setToken(data.token);

      const me = await apiFetch("/v1/auth/me", { method: "GET" });
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

      router.replace(nextUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Login failed";
      const provider = path.includes("google") ? "Google" : path.includes("apple") ? "Apple" : "";
      setError(provider ? `${provider} sign-in failed: ${msg}` : msg);
      setStatus("Sign in failed.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;

    const nextAppleState =
      window.crypto?.randomUUID?.() ?? `apple-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const googleClientId = "548168595768-8uddhhcmdgl9108juth8fke4boncenut.apps.googleusercontent.com";
    const appleClientId = "com.proovra.web";
    const googleRedirect = "https://www.proovra.com/auth/callback";
    const appleRedirect = "https://www.proovra.com/auth/callback";

    let nextGoogleHref = "";
    let nextAppleHref = "";
    try {
      nextGoogleHref = buildGoogleAuthUrl({ state: "google" });
    } catch {
      nextGoogleHref = "";
    }
    if (!nextGoogleHref) {
      const params = new URLSearchParams({
        client_id: googleClientId,
        redirect_uri: googleRedirect,
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
    } catch {
      nextAppleHref = "";
    }
    if (!nextAppleHref) {
      const params = new URLSearchParams({
        response_type: "code id_token",
        response_mode: "form_post",
        client_id: appleClientId,
        redirect_uri: appleRedirect,
        scope: "name email",
        state: nextAppleState
      });
      nextAppleHref = `https://appleid.apple.com/auth/authorize?${params.toString()}`;
    }

    setAppleHref(nextAppleHref);
    setGoogleHref(nextGoogleHref);
    setDebugGoogleHref(nextGoogleHref);
    setDebugAppleHref(nextAppleHref);
    
    // Set ready states based on hrefs
    if (nextAppleHref) setAppleReady(true);
    if (nextGoogleHref) setGoogleReady(false); // Will be set to true after SDK loads

    try {
      sessionStorage.setItem("proovra-apple-state", nextAppleState);
    } catch (err) {
      void err;
    }

    loadGoogleIdentity()
      .then(() => {
        const google = (window as typeof window & {
          google?: {
            accounts?: {
              id?: {
                initialize: (options: {
                  client_id: string;
                  callback: (response: { credential?: string }) => void;
                }) => void;
              };
            };
          };
        }).google;
        if (!google?.accounts?.id) {
          setGoogleReady(false);
          return;
        }
        google.accounts.id.initialize({
          client_id: googleClientId,
          callback: (response: { credential?: string }) => {
            if (response.credential) void handleAuth("/v1/auth/google", response.credential);
            else setError("Google sign-in failed: No credential returned.");
          }
        });
        setGoogleReady(true);
      })
      .catch(() => setGoogleReady(false));

    setStatus(null);
    setMounted(true);
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
                href={mounted ? googleHref || "#" : "#"}
                onClick={(event) => {
                  try {
                    sessionStorage.setItem("proovra-return-url", nextUrl);
                  } catch {
                    void 0;
                  }
                  if (busy) {
                    event.preventDefault();
                    return;
                  }
                  if (googleReady) {
                    event.preventDefault();
                    const google = (window as typeof window & {
                      google?: {
                        accounts?: {
                          id?: {
                            prompt: (callback?: (notification: {
                              isNotDisplayed?: () => boolean;
                              isSkippedMoment?: () => boolean;
                              isDismissedMoment?: () => boolean;
                            }) => void) => void;
                          };
                        };
                      };
                    }).google;
                    google?.accounts?.id?.prompt?.((notification) => {
                      if (
                        notification?.isNotDisplayed?.() ||
                        notification?.isSkippedMoment?.() ||
                        notification?.isDismissedMoment?.()
                      ) {
                        if (googleHref) window.location.href = googleHref;
                        else setError("Google sign-in failed: Redirect URL not ready.");
                      }
                    });
                    return;
                  }
                  if (!googleHref) {
                    event.preventDefault();
                    setError("Google sign-in failed: Not ready yet.");
                  }
                }}
              >
                <span className="google-icon" aria-hidden="true" />
                Continue with Google
              </a>

              <a
                className="social-btn"
                href={mounted ? appleHref || "#" : "#"}
                onClick={(event) => {
                  try {
                    sessionStorage.setItem("proovra-return-url", nextUrl);
                  } catch {
                    void 0;
                  }
                  if (busy) {
                    event.preventDefault();
                    return;
                  }
                  if (appleReady) {
                    event.preventDefault();
                    // With usePopup: false, just navigate to the href
                    return;
                  }
                  if (!appleHref) {
                    event.preventDefault();
                    setError("Apple login is not ready yet.");
                  }
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

              {mounted && process.env.NODE_ENV !== "production" && (
                <div style={{ fontSize: 11, color: "#94a3b8" }}>
                  API: {apiBase || "missing"}
                  {" · "}Google URL: {googleReady ? "ready" : "missing"}
                  {" · "}Apple URL: {appleReady ? "ready" : "missing"}
                  {" · "}Google HREF: {googleHref ? "set" : "missing"}
                  {" · "}Apple HREF: {appleHref ? "set" : "missing"}
                  <div style={{ marginTop: 6, wordBreak: "break-all" }}>
                    Google URL: {debugGoogleHref || "(empty)"}
                  </div>
                  <div style={{ wordBreak: "break-all" }}>
                    Apple URL: {debugAppleHref || "(empty)"}
                  </div>
                </div>
              )}
            </div>

            <div className="auth-switch">
              <span>{t("register")}? </span>
              <Link href="/register">{t("register")}</Link>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
