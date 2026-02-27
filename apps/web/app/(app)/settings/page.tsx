"use client";

import { Button, Card, useToast } from "../../../components/ui";
import { supportedLocales, type Locale } from "@proovra/shared";
import { useAuth, useLocale } from "../../providers";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";
import { Icons } from "../../../components/icons";

export default function SettingsPage() {
  const { t, locale } = useLocale();
  const { user, setToken } = useAuth();
  const { addToast } = useToast();
  const router = useRouter();
  const [plan, setPlan] = useState("FREE");
const [selectedLanguage, setSelectedLanguage] = useState<Locale>(
  supportedLocales.includes(locale as Locale) ? (locale as Locale) : "en"
);
  useEffect(() => {
    apiFetch("/v1/billing/status")
      .then((data) => setPlan(data.entitlement?.plan ?? "FREE"))
      .catch((err) => {
        captureException(err, { feature: "web_settings_billing" });
        setPlan("FREE");
        addToast("Could not load subscription status", "warning");
      });
  }, [addToast]);

  const handleSignOut = async () => {
    try {
      addToast("Signing out...", "info");
      await apiFetch("/v1/auth/logout", { method: "POST" });
      addToast("Signed out successfully", "success");
    } catch (err) {
      captureException(err, { feature: "web_settings_logout" });
      addToast("Sign out failed", "error");
    } finally {
      setToken(null);
      setTimeout(() => {
        router.replace("/");
      }, 500);
    }
  };

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title" style={{ marginBottom: 0 }}>
            <div>
              <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
                {t("settings")}
              </h1>
              <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
                Manage your account and preferences.
              </p>
            </div>
          </div>
        </div>
      </div>
      <div className="app-body app-body-full">
        <div className="container" style={{ display: "grid", gap: 16 }}>
          {/* A) Profile */}
          <Card>
            <div className="settings-section-header">
              <Icons.Dashboard />
              <span>Profile</span>
            </div>
            <div className="settings-section-body">
              {/* Profile Avatar */}
              <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
                <div
                  style={{
                    width: 64,
                    height: 64,
                    borderRadius: 32,
                    background: "linear-gradient(135deg, #0B1F2A 0%, #0B7BE5 100%)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    fontSize: 28,
                    fontWeight: 600
                  }}
                >
                  {user?.displayName?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || "?"}
                </div>
                <div>
                  <div style={{ fontSize: 14, color: "#999" }}>Account</div>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>
                    {user?.displayName || user?.email || "Guest User"}
                  </div>
                </div>
              </div>
              {user?.displayName && (
                <div className="settings-row">
                  <span className="settings-label">Name</span>
                  <span>{user.displayName}</span>
                </div>
              )}
              {user?.email && (
                <div className="settings-row">
                  <span className="settings-label">Email</span>
                  <span>{user.email}</span>
                </div>
              )}
              {user?.provider && (
                <div className="settings-row">
                  <span className="settings-label">Auth provider</span>
                  <span>{user.provider}</span>
                </div>
              )}
              {!user?.email && !user?.displayName && (
                <div className="settings-row" style={{ color: "var(--color-muted)" }}>
                  Guest or minimal profile
                </div>
              )}
              <div style={{ marginTop: 16 }}>
                <Button variant="secondary" onClick={handleSignOut}>
                  Sign out
                </Button>
              </div>
            </div>
          </Card>

          {/* B) Security */}
          <Card>
            <div className="settings-section-header">
              <Icons.Security />
              <span>Security</span>
            </div>
            <div className="settings-section-body">
              <div className="settings-row">
                <span className="settings-label">Login method</span>
                <span>{user?.provider ?? "—"}</span>
              </div>
              <div className="settings-row">
                <span className="settings-label">Session</span>
                <span>Active</span>
              </div>
              <Link href="/legal/security" className="settings-link">
                Security policy
              </Link>
              <a href="mailto:security@proovra.com" className="settings-link">
                security@proovra.com
              </a>
            </div>
          </Card>

          {/* C) Language */}
          <Card>
            <div className="settings-section-header">
              <Icons.Settings />
              <span>{t("language")}</span>
            </div>
            <div className="settings-section-body">
              <div className="settings-row">
                <span className="settings-label">UI language</span>
<select
  value={selectedLanguage}
onChange={(e) => setSelectedLanguage(e.target.value as Locale)}  className="settings-select"
>
  {supportedLocales.map((lc) => (
    <option key={lc} value={lc}>
      {lc === "en" ? "English"
        : lc === "ar" ? "العربية"
        : lc === "de" ? "Deutsch"
        : lc === "fr" ? "Français"
        : lc === "es" ? "Español"
        : lc === "tr" ? "Türkçe"
        : lc === "ru" ? "Русский"
        : String(lc).toUpperCase()}
    </option>
  ))}
</select>
</div>
              <p style={{ margin: 0, fontSize: 13, color: "var(--color-muted)" }}>
                Language preference will be used for future UI updates.
              </p>
            </div>
          </Card>

          {/* D) Subscription */}
          <Card>
            <div className="settings-section-header">
              <Icons.Billing />
              <span>Subscription</span>
            </div>
            <div className="settings-section-body">
              <div className="settings-row">
                <span className="settings-label">Current plan</span>
                <span>{plan}</span>
              </div>
              <div style={{ marginTop: 12 }}>
                <Link href="/billing">
                  <Button variant="secondary">Go to Billing</Button>
                </Link>
              </div>
            </div>
          </Card>

          {/* E) Legal */}
          <Card>
            <div className="settings-section-header">
              <Icons.Security />
              <span>Legal</span>
            </div>
            <div className="settings-section-body">
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Link href="/privacy" className="settings-link">
                  Privacy Policy
                </Link>
                <Link href="/terms" className="settings-link">
                  Terms of Service
                </Link>
                <Link href="/legal/security" className="settings-link">
                  Security
                </Link>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
