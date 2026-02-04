"use client";

import { Button, Card } from "../../../components/ui";
import { useAuth, useLocale } from "../../providers";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "../../../lib/api";
import { getDeviceLocale } from "../../../lib/i18n";

export default function SettingsPage() {
  const { t, locale, setLocale } = useLocale();
  const { setToken } = useAuth();
  const [plan, setPlan] = useState("Free");
  const [googleToken, setGoogleToken] = useState("");
  const [appleToken, setAppleToken] = useState("");
  const [deviceLocale, setDeviceLocale] = useState<"en" | "ar" | "de">("en");

  useEffect(() => {
    setDeviceLocale(getDeviceLocale());
    apiFetch("/v1/billing/status")
      .then((data) => setPlan(data.entitlement?.plan ?? "Free"))
      .catch(() => setPlan("Free"));
  }, []);
  return (
    <div className="section">
      <div className="page-title">
        <div>
          <h1 style={{ margin: 0 }}>{t("settings")}</h1>
          <p className="page-subtitle">Manage your plan, language, and sign-in.</p>
        </div>
      </div>
      <div style={{ display: "grid", gap: 16 }}>
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>{t("language")}</div>
          <div style={{ display: "flex", gap: 8 }}>
            {locale !== "en" && (
              <button type="button" className="lang-button" onClick={() => setLocale("en")}>
                {t("switchToEnglish")}
              </button>
            )}
            {locale !== deviceLocale && (
              <button type="button" className="lang-button" onClick={() => setLocale(deviceLocale)}>
                {t("deviceLanguage")}
              </button>
            )}
          </div>
        </Card>
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Subscription</div>
          <p>{plan} plan</p>
          <div style={{ display: "flex", gap: 10 }}>
            <Link href="/pricing">
              <Button>View Pricing</Button>
            </Link>
            <Button
              variant="secondary"
              onClick={() => apiFetch("/v1/billing/restore", { method: "POST" })}
            >
              Restore Purchases
            </Button>
          </div>
        </Card>
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Sign in</div>
          <div style={{ display: "grid", gap: 8 }}>
            <input
              placeholder="Google idToken"
              value={googleToken}
              onChange={(e) => setGoogleToken(e.target.value)}
              style={{ padding: 10, borderRadius: 10, border: "1px solid #E2E8F0" }}
            />
            <Button
              onClick={async () => {
                const data = await apiFetch("/v1/auth/google", {
                  method: "POST",
                  body: JSON.stringify({ idToken: googleToken })
                });
                setToken(data.token);
              }}
            >
              Sign in with Google
            </Button>
            <input
              placeholder="Apple idToken"
              value={appleToken}
              onChange={(e) => setAppleToken(e.target.value)}
              style={{ padding: 10, borderRadius: 10, border: "1px solid #E2E8F0" }}
            />
            <Button
              variant="secondary"
              onClick={async () => {
                const data = await apiFetch("/v1/auth/apple", {
                  method: "POST",
                  body: JSON.stringify({ idToken: appleToken })
                });
                setToken(data.token);
              }}
            >
              Sign in with Apple
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
