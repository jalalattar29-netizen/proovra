"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "../../components/ui";
import { useAuth, useLocale } from "../providers";
import { apiFetch } from "../../lib/api";
import {
  buildAppleAuthUrl,
  buildGoogleAuthUrl,
  loadAppleIdentity,
  loadGoogleIdentity
} from "../../lib/oauth";

export default function LoginPage() {
  const { t } = useLocale();
  const { setToken } = useAuth();
  const router = useRouter();
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

      router.push("/home");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setStatus("Sign in failed.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID) setError("Google client ID is missing.");
    if (!process.env.NEXT_PUBLIC_APPLE_CLIENT_ID) setError("Apple client ID is missing.");

    const nextAppleState =
      window.crypto?.randomUUID?.() ?? `apple-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
    const appleClientId = process.env.NEXT_PUBLIC_APPLE_CLIENT_ID ?? "";
    const googleRedirect =
      process.env.NEXT_PUBLIC_GOOGLE_REDIRECT_URI ?? `${window.location.origin}/auth/callback`;
    const appleRedirect =
      process.env.NEXT_PUBLIC_APPLE_REDIRECT_URI ?? `${window.location.origin}/auth/callback`;

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
        if (!google?.accounts?.id || !process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID) {
          setGoogleReady(false);
          return;
        }
        google.accounts.id.initialize({
          client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
          callback: (response: { credential?: string }) => {
            if (response.credential) void handleAuth("/v1/auth/google", response.credential);
            else setError("Google login failed.");
          }
        });
        setGoogleReady(true);
      })
      .catch(() => setGoogleReady(false));

    loadAppleIdentity()
      .then(() => {
        const AppleID = (window as typeof window & {
          AppleID?: {
            auth?: {
              init: (options: {
                clientId: string;
                scope: string;
                redirectURI: string;
                usePopup: boolean;
              }) => void;
            };
          };
        }).AppleID;
        if (!AppleID?.auth || !process.env.NEXT_PUBLIC_APPLE_CLIENT_ID) {
          setAppleReady(false);
          return;
        }
        const redirectUri =
          process.env.NEXT_PUBLIC_APPLE_REDIRECT_URI ?? `${window.location.origin}/auth/callback`;
        AppleID.auth.init({
          clientId: process.env.NEXT_PUBLIC_APPLE_CLIENT_ID,
          scope: "name email",
          redirectURI: redirectUri,
          usePopup: true
        });
        setAppleReady(true);
      })
      .catch(() => setAppleReady(false));

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
                  if (busy) {
                    event.preventDefault();
                    return;
                  }
                  if (googleReady) {
                    event.preventDefault();
                    const google = (window as typeof window & {
                      google?: { accounts?: { id?: { prompt: () => void } } };
                    }).google;
                    google?.accounts?.id?.prompt?.();
                    return;
                  }
                  if (!googleHref) {
                    event.preventDefault();
                    setError("Google login is not ready yet.");
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
                  if (busy) {
                    event.preventDefault();
                    return;
                  }
                  if (appleReady) {
                    event.preventDefault();
                    const AppleID = (window as typeof window & {
                      AppleID?: {
                        auth?: {
                          signIn: () => Promise<{
                            authorization?: { code?: string; id_token?: string };
                          }>;
                        };
                      };
                    }).AppleID;

                    AppleID?.auth
                      ?.signIn()
                      .then((response) => {
                        const idToken = response.authorization?.id_token;
                        const code = response.authorization?.code;
                        if (idToken || code) void handleAuth("/v1/auth/apple", idToken, code);
                        else setError("Apple login failed.");
                      })
                      .catch(() => setError("Apple login failed."));
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
