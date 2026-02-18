"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, useToast } from "../../components/ui";
import { useAuth, useLocale } from "../providers";
import { apiFetch, ApiError } from "../../lib/api";
import { authLogger } from "../../lib/auth-logger";
import { loadAppleIdentity, loadGoogleIdentity } from "../../lib/oauth";

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
  google?: { accounts?: { id?: GoogleAccountsId } };
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
  AppleID?: { auth?: AppleAuth };
};

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

  const [googleReady, setGoogleReady] = useState(false);
  const [appleReady, setAppleReady] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");

  const inFlightRef = useRef(false);
  const googleInitOnceRef = useRef(false);

  const handleAuth = async (path: string, idToken?: string, code?: string, extraBody?: Record<string, unknown>) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    setBusy(true);
    setError(null);

    const provider = path.includes("google") ? "google" : path.includes("apple") ? "apple" : path.includes("guest") ? "guest" : "email";
    setStatus(`Signing in via ${provider}...`);

    const guestToken = typeof window !== "undefined" ? localStorage.getItem("proovra-token") : null;

    try {
      try {
        sessionStorage.setItem("proovra-return-url", returnUrl);
      } catch {
        // ignore
      }

      const payload = extraBody ?? (idToken ? { idToken } : code ? { code } : {});
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

  useEffect(() => {
    if (typeof window === "undefined") return;

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
                setError("Google sign-up failed.");
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
  }, [returnUrl]);

  const startGoogle = () => {
    try {
      sessionStorage.setItem("proovra-return-url", returnUrl);
    } catch {
      // ignore
    }
    if (busy || inFlightRef.current) return;

    const google = (window as GoogleGlobal).google;
    const id = google?.accounts?.id;

    if (!googleReady || !id?.prompt) {
      const msg = "Google sign-up is not ready yet.";
      setError(msg);
      addToast(msg, "error");
      return;
    }

    id.prompt();
  };

  const startApple = async () => {
    try {
      sessionStorage.setItem("proovra-return-url", returnUrl);
    } catch {
      // ignore
    }
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
    if (!email || !password || !password2) {
      setError("Please fill email and password.");
      return;
    }
    if (password !== password2) {
      setError("Passwords do not match.");
      return;
    }

    // افترضنا endpoint هذا (إذا عندك اسم مختلف بالـ API غيّره بسطر واحد)
    void handleAuth("/v1/auth/email/register", undefined, undefined, { email, password });
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
            <Link href="/login">{t("login")}</Link>
          </nav>
        </header>

        <main className="auth-main">
          <div className="auth-card">
            <h2 className="auth-title">{t("createAccountTitle")}</h2>

            <div className="auth-actions">
              <button type="button" className="social-btn" disabled={busy} onClick={startGoogle}>
                <span className="google-icon" aria-hidden="true" />
                Continue with Google
              </button>

              <button type="button" className="social-btn" disabled={busy} onClick={() => void startApple()}>
                <span className="apple-icon" aria-hidden="true"></span>
                Continue with Apple
              </button>

              <div className="auth-divider">{t("orDivider")}</div>

              {/* Email register */}
              <form onSubmit={onEmailRegister} style={{ display: "grid", gap: 10 }}>
                <input
                  className="auth-input"
                  placeholder="Email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy}
                />
                <input
                  className="auth-input"
                  placeholder="Password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                />
                <input
                  className="auth-input"
                  placeholder="Confirm password"
                  type="password"
                  autoComplete="new-password"
                  value={password2}
                  onChange={(e) => setPassword2(e.target.value)}
                  disabled={busy}
                />

                <button className="social-btn" type="submit" disabled={busy}>
                  Create account with Email
                </button>
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
