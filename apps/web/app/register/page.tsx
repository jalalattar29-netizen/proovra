"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "../../components/ui";
import { useAuth, useLocale } from "../providers";
import { apiFetch } from "../../lib/api";
import {
  buildAppleAuthUrl,
  buildGoogleAuthUrl,
  loadAppleIdentity,
  loadGoogleIdentity,
} from "../../lib/oauth";

/** ===== Types (no any) ===== */
type AppleSignInResponse = {
  authorization?: { code?: string; id_token?: string };
};

type AppleIDGlobal = typeof window & {
  AppleID?: {
    auth?: {
      init: (options: {
        clientId: string;
        scope: string;
        redirectURI: string;
        usePopup: boolean;
      }) => void;
      signIn: () => Promise<AppleSignInResponse>;
    };
  };
};

export default function RegisterPage() {
  const { t } = useLocale();
  const { setToken } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const returnUrl = useMemo(() => {
    return searchParams.get("returnUrl") || "/home";
  }, [searchParams]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [googleReady, setGoogleReady] = useState(false);
  const [appleReady, setAppleReady] = useState(false);
  const [googleHref, setGoogleHref] = useState<string>("");
  const [appleHref, setAppleHref] = useState<string>("");

  const [mounted, setMounted] = useState(false);

  const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? "";

  const handleAuth = async (path: string, idToken?: string, code?: string) => {
    setBusy(true);
    setError(null);
    setStatus(`Signing in via ${path}...`);

    const guestToken =
      typeof window !== "undefined" ? localStorage.getItem("proovra-token") : null;

    try {
      const payload = idToken ? { idToken } : code ? { code } : {};
      const data: { token: string } = await apiFetch(path, {
        method: "POST",
        body: JSON.stringify(payload),
      });

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
      setError(err instanceof Error ? err.message : "Registration failed");
      setStatus("Sign in failed.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;

    setMounted(true);

    const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
    const appleClientId = process.env.NEXT_PUBLIC_APPLE_CLIENT_ID ?? "";

    if (!googleClientId) setError("Google client ID is missing.");
    if (!appleClientId) setError("Apple client ID is missing.");

    const nextAppleState =
      window.crypto?.randomUUID?.() ??
      `apple-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const googleRedirect =
      process.env.NEXT_PUBLIC_GOOGLE_REDIRECT_URI ?? `${window.location.origin}/auth/callback`;
    const appleRedirect =
      process.env.NEXT_PUBLIC_APPLE_REDIRECT_URI ?? `${window.location.origin}/auth/callback`;

    // Build hrefs (fallback always exists)
    let nextGoogleHref = "";
    let nextAppleHref = "";

    try {
      nextGoogleHref = buildGoogleAuthUrl({ state: "google", origin: window.location.origin });
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
        prompt: "consent",
      });
      nextGoogleHref = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    try {
      nextAppleHref = buildAppleAuthUrl({ state: nextAppleState, origin: window.location.origin });
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
        state: nextAppleState,
      });
      nextAppleHref = `https://appleid.apple.com/auth/authorize?${params.toString()}`;
    }

    setGoogleHref(nextGoogleHref);
    setAppleHref(nextAppleHref);

    try {
      sessionStorage.setItem("proovra-apple-state", nextAppleState);
    } catch {
      // ignore
    }

    /**
     * ✅ Google: only load SDK to mark "ready",
     * BUT we DO NOT use google.accounts.id.prompt() here (it fails silently sometimes).
     * We always redirect using googleHref when clicking.
     */
    loadGoogleIdentity()
      .then(() => {
        if (!googleClientId) {
          setGoogleReady(false);
          return;
        }
        setGoogleReady(true);
      })
      .catch(() => setGoogleReady(false));

    /**
     * ✅ Apple: popup flow via SDK
     */
    loadAppleIdentity()
      .then(() => {
        const AppleID = (window as AppleIDGlobal).AppleID;
        if (!AppleID?.auth || !appleClientId) {
          setAppleReady(false);
          return;
        }

        const redirectUri =
          process.env.NEXT_PUBLIC_APPLE_REDIRECT_URI ?? `${window.location.origin}/auth/callback`;

        AppleID.auth.init({
          clientId: appleClientId,
          scope: "name email",
          redirectURI: redirectUri,
          usePopup: true,
        });

        setAppleReady(true);
      })
      .catch(() => setAppleReady(false));

    setStatus(null);
  }, []);

  return (
    <div className="blue-shell auth-screen">
      <div className="container">
        <header className="auth-top">
          <Link href="/" className="auth-brand">
            <img src="/brand/logo-white.svg" alt="PROO✓RA" />
            <span>{t("brand")}</span>
          </Link>

          <nav className="auth-top-links">
            <Link href="/login">{t("login")}</Link>
          </nav>
        </header>

        <main className="auth-main">
          <div className="auth-card">
            <h2 className="auth-title">{t("createAccountTitle")}</h2>

            <div className="auth-actions">
              {/* ✅ GOOGLE (redirect - guaranteed) */}
              <a
                className="social-btn"
                href={mounted ? googleHref || "#" : "#"}
                onClick={(event) => {
                  try {
                    sessionStorage.setItem("proovra-return-url", returnUrl);
                  } catch {
                    // ignore
                  }

                  if (busy) {
                    event.preventDefault();
                    return;
                  }

                  // if href missing (should not happen), block and show error
                  if (!googleHref) {
                    event.preventDefault();
                    setError("Google login link is not ready yet.");
                    return;
                  }

                  // IMPORTANT: do not preventDefault -> allow redirect
                  // also: keep googleReady only as debug/status
                  if (!googleReady) {
                    // still allow redirect, but optionally show info
                    // no blocking
                  }
                }}
              >
                <span className="google-icon" aria-hidden="true" />
                Continue with Google
              </a>

              {/* ✅ APPLE (popup) */}
              <a
                className="social-btn"
                href={mounted ? appleHref || "#" : "#"}
                onClick={(event) => {
                  try {
                    sessionStorage.setItem("proovra-return-url", returnUrl);
                  } catch {
                    // ignore
                  }

                  if (busy) {
                    event.preventDefault();
                    return;
                  }

                  if (appleReady) {
                    event.preventDefault();
                    const AppleID = (window as AppleIDGlobal).AppleID;

                    AppleID?.auth
                      ?.signIn()
                      .then((response) => {
                        const idToken = response.authorization?.id_token;
                        const code = response.authorization?.code;
                        if (idToken || code) void handleAuth("/v1/auth/apple", idToken, code);
                        else
                          setError(
                            "Apple sign-up failed: No authentication token received. Please try again."
                          );
                      })
                      .catch((err: unknown) => {
                        const message = err instanceof Error ? err.message : "Apple sign-up failed.";
                        setError(message);
                      });

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

              {/* ✅ GUEST */}
              <Button variant="secondary" onClick={() => void handleAuth("/v1/auth/guest")} disabled={busy}>
                {t("continueGuest")}
              </Button>

              {error && <div className="error-text">{error}</div>}
              {status && <div style={{ fontSize: 12, color: "#64748b" }}>{status}</div>}

              {/* Debug (dev only) */}
              {mounted && process.env.NODE_ENV !== "production" && (
                <div style={{ fontSize: 11, color: "#94a3b8" }}>
                  API: {apiBase || "missing"}
                  {" · "}Google SDK: {googleReady ? "ready" : "missing"}
                  {" · "}Apple SDK: {appleReady ? "ready" : "missing"}
                  {" · "}Google HREF: {googleHref ? "set" : "missing"}
                  {" · "}Apple HREF: {appleHref ? "set" : "missing"}
                </div>
              )}
            </div>

            <div className="auth-switch">
              <span>{t("login")}? </span>
              <Link href="/login">{t("login")}</Link>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
