"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "../../components/ui";
import { useAuth, useLocale } from "../providers";
import { apiFetch } from "../../lib/api";
import { buildAppleAuthUrl, buildGoogleAuthUrl, loadAppleIdentity, loadGoogleIdentity } from "../../lib/oauth";

export default function RegisterPage() {
  const { t } = useLocale();
  const { setToken } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnUrl = searchParams.get("returnUrl") || "/home";

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [googleReady, setGoogleReady] = useState(false);
  const [appleReady, setAppleReady] = useState(false);
  const [googleHref, setGoogleHref] = useState<string>("");
  const [appleHref, setAppleHref] = useState<string>("");

  const [mounted, setMounted] = useState(false);

  // ✅ NEW: email/password register form
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const handleAuth = async (path: string, idToken?: string, code?: string) => {
    setBusy(true);
    setError(null);
    setStatus(`Signing in via ${path}...`);
    const guestToken = typeof window !== "undefined" ? localStorage.getItem("proovra-token") : null;

    try {
      const payload = idToken ? { idToken } : code ? { code } : {};
      const data = await apiFetch(path, { method: "POST", body: JSON.stringify(payload) });

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

  // ✅ NEW: email/password register
  const handleEmailRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !password) {
      setError("Please enter your email and password.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    setError(null);
    setStatus("Creating your account...");

    const guestToken = typeof window !== "undefined" ? localStorage.getItem("proovra-token") : null;

    try {
      const data = await apiFetch("/v1/auth/email/register", {
        method: "POST",
        body: JSON.stringify({
          email: cleanEmail,
          password,
          displayName: displayName.trim() || undefined,
        }),
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
      const msg = err instanceof Error ? err.message : "Registration failed";
      setError(msg === "email_already_exists" ? "This email is already registered." : msg);
      setStatus("Registration failed.");
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
    const googleRedirect = process.env.NEXT_PUBLIC_GOOGLE_REDIRECT_URI ?? `${window.location.origin}/auth/callback`;
    const appleRedirect = process.env.NEXT_PUBLIC_APPLE_REDIRECT_URI ?? `${window.location.origin}/auth/callback`;

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

    loadGoogleIdentity()
      .then(() => {
        const google = (window as typeof window & {
          google?: { accounts?: { id?: { initialize: (options: any) => void } } };
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
          },
        });

        setGoogleReady(true);
      })
      .catch(() => setGoogleReady(false));

    loadAppleIdentity()
      .then(() => {
        const AppleID = (window as any).AppleID as
          | { auth?: { init: (options: any) => void } }
          | undefined;

        if (!AppleID?.auth || !process.env.NEXT_PUBLIC_APPLE_CLIENT_ID) {
          setAppleReady(false);
          return;
        }

        const redirectUri = process.env.NEXT_PUBLIC_APPLE_REDIRECT_URI ?? `${window.location.origin}/auth/callback`;

        AppleID.auth.init({
          clientId: process.env.NEXT_PUBLIC_APPLE_CLIENT_ID,
          scope: "name email",
          redirectURI: redirectUri,
          usePopup: true,
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
                  if (googleReady) {
                    event.preventDefault();
                    const google = (window as any).google as { accounts?: { id?: { prompt: () => void } } } | undefined;
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
                    const AppleID = (window as any).AppleID as
                      | { auth?: { signIn: () => Promise<{ authorization?: { code?: string; id_token?: string } }> } }
                      | undefined;

                    AppleID?.auth
                      ?.signIn()
                      .then((response) => {
                        const idToken = response.authorization?.id_token;
                        const code = response.authorization?.code;
                        if (idToken || code) void handleAuth("/v1/auth/apple", idToken, code);
                        else setError("Apple sign-up failed: No authentication token received. Please try again.");
                      })
                      .catch(() => {
                        setError("Apple sign-up failed. Please try again.");
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

              {/* ✅ NEW: Email/password register */}
              <form id="email-register-form" onSubmit={handleEmailRegister} style={{ width: "100%", display: "grid", gap: 10 }}>
                <input
                  type="text"
                  placeholder="Name (optional)"
                  autoComplete="name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  disabled={busy}
                  className="auth-input"
                  style={{
                    width: "100%",
                    height: 44,
                    borderRadius: 10,
                    border: "1px solid #e2e8f0",
                    padding: "0 12px",
                    background: "white",
                  }}
                />
                <input
                  type="email"
                  placeholder="Email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy}
                  className="auth-input"
                  style={{
                    width: "100%",
                    height: 44,
                    borderRadius: 10,
                    border: "1px solid #e2e8f0",
                    padding: "0 12px",
                    background: "white",
                  }}
                />
                <input
                  type="password"
                  placeholder="Password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  className="auth-input"
                  style={{
                    width: "100%",
                    height: 44,
                    borderRadius: 10,
                    border: "1px solid #e2e8f0",
                    padding: "0 12px",
                    background: "white",
                  }}
                />
                <input
                  type="password"
                  placeholder="Confirm password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={busy}
                  className="auth-input"
                  style={{
                    width: "100%",
                    height: 44,
                    borderRadius: 10,
                    border: "1px solid #e2e8f0",
                    padding: "0 12px",
                    background: "white",
                  }}
                />

                <Button variant="primary" disabled={busy} onClick={() => (document.getElementById("email-register-form") as HTMLFormElement | null)?.requestSubmit()}>
                  Create account with Email
                </Button>
              </form>

              <Button variant="secondary" onClick={() => handleAuth("/v1/auth/guest")} disabled={busy}>
                {t("continueGuest")}
              </Button>

              {error && <div className="error-text">{error}</div>}
              {status && <div style={{ fontSize: 12, color: "#64748b" }}>{status}</div>}
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
