"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, TopBar } from "../../components/ui";
import { useAuth, useLocale } from "../providers";
import { apiFetch } from "../../lib/api";

export default function RegisterPage() {
  const { t } = useLocale();
  const { setToken } = useAuth();
  const router = useRouter();
  const [googleToken, setGoogleToken] = useState("");
  const [appleToken, setAppleToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAuth = async (path: string, idToken?: string) => {
    setBusy(true);
    setError(null);
    try {
      const data = await apiFetch(path, {
        method: "POST",
        body: idToken ? JSON.stringify({ idToken }) : JSON.stringify({})
      });
      setToken(data.token);
      router.push("/home");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <TopBar title={t("brand")} right={<Link href="/">{t("home")}</Link>} />
      <section className="section auth-page">
        <Card className="auth-card">
          <h2 style={{ marginTop: 0 }}>{t("createAccountTitle")}</h2>
          <div style={{ display: "grid", gap: 10 }}>
            <input
              placeholder="Google idToken"
              value={googleToken}
              onChange={(e) => setGoogleToken(e.target.value)}
              style={{ padding: 10, borderRadius: 10, border: "1px solid #E2E8F0" }}
            />
            <Button onClick={() => handleAuth("/v1/auth/google", googleToken)} disabled={busy}>
              {t("signInGoogle")}
            </Button>
            <input
              placeholder="Apple idToken"
              value={appleToken}
              onChange={(e) => setAppleToken(e.target.value)}
              style={{ padding: 10, borderRadius: 10, border: "1px solid #E2E8F0" }}
            />
            <Button
              variant="secondary"
              onClick={() => handleAuth("/v1/auth/apple", appleToken)}
              disabled={busy}
            >
              {t("signInApple")}
            </Button>
            <div className="auth-divider">{t("orDivider")}</div>
            <Button variant="secondary" onClick={() => handleAuth("/v1/auth/guest")} disabled={busy}>
              {t("continueGuest")}
            </Button>
            {error && <div className="error-text">{error}</div>}
          </div>
          <div className="auth-switch">
            <span>{t("login")}? </span>
            <Link href="/login">{t("login")}</Link>
          </div>
        </Card>
      </section>
    </div>
  );
}
