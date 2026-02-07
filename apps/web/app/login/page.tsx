"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, TopBar } from "../../components/ui";
import { useAuth, useLocale } from "../providers";
import { apiFetch } from "../../lib/api";
import { buildAppleAuthUrl, buildGoogleAuthUrl } from "../../lib/oauth";

export default function LoginPage() {
  const { t } = useLocale();
  const { setToken } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleHref, setGoogleHref] = useState<string>("");
  const [appleHref, setAppleHref] = useState<string>("");

  const handleAuth = async (path: string, idToken?: string) => {
    setBusy(true);
    setError(null);
    const guestToken = typeof window !== "undefined" ? localStorage.getItem("proovra-token") : null;
    try {
      const data = await apiFetch(path, {
        method: "POST",
        body: idToken ? JSON.stringify({ idToken }) : JSON.stringify({})
      });
      setToken(data.token);
      if (guestToken) {
        try {
          await apiFetch("/v1/evidence/claim", {
            method: "POST",
            body: JSON.stringify({ guestToken })
          });
        } catch {
          // ignore claim failures
        }
      }
      router.push("/home");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID) {
      setError("Google client ID is missing.");
      return;
    }
    if (!process.env.NEXT_PUBLIC_APPLE_CLIENT_ID) {
      setError("Apple client ID is missing.");
      return;
    }
    const appleState = crypto.randomUUID();
    sessionStorage.setItem("proovra-apple-state", appleState);
    setAppleHref(buildAppleAuthUrl({ state: appleState }));
    setGoogleHref(buildGoogleAuthUrl({ state: "google" }));
  }, []);

  return (
    <div className="page">
      <TopBar title={t("brand")} right={<Link href="/">{t("home")}</Link>} />
      <section className="section auth-page">
        <Card className="auth-card">
          <h2 style={{ marginTop: 0 }}>{t("signInTitle")}</h2>
          <div style={{ display: "grid", gap: 10 }}>
            <a
              className="btn secondary google-btn"
              href={googleHref || "#"}
              onClick={(event) => {
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
              className="btn secondary"
              href={appleHref || "#"}
              onClick={(event) => {
                if (!appleHref) {
                  event.preventDefault();
                  setError("Apple login is not ready yet.");
                }
              }}
            >
              {t("signInApple")}
            </a>
            <div className="auth-divider">{t("orDivider")}</div>
            <Button variant="secondary" onClick={() => handleAuth("/v1/auth/guest")} disabled={busy}>
              {t("continueGuest")}
            </Button>
            {error && <div className="error-text">{error}</div>}
          </div>
          <div className="auth-switch">
            <span>{t("register")}? </span>
            <Link href="/register">{t("register")}</Link>
          </div>
        </Card>
      </section>
    </div>
  );
}
