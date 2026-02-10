"use client";

import { Button, Card } from "../../../components/ui";
import { useAuth, useLocale } from "../../providers";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch } from "../../../lib/api";
import { Icons } from "../../../components/icons";

export default function SettingsPage() {
  const { t, locale } = useLocale();
  const { user, setToken } = useAuth();
  const router = useRouter();
  const [plan, setPlan] = useState("FREE");
  const [selectedLanguage, setSelectedLanguage] = useState<"en" | "ar">(locale);

  useEffect(() => {
    apiFetch("/v1/billing/status")
      .then((data) => setPlan(data.entitlement?.plan ?? "FREE"))
      .catch(() => setPlan("FREE"));
  }, []);

  const handleSignOut = async () => {
    try {
      await apiFetch("/v1/auth/logout", { method: "POST" });
    } catch {
      // ignore
    } finally {
      setToken(null);
      router.replace("/");
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
                  onChange={(e) => setSelectedLanguage(e.target.value as "en" | "ar")}
                  style={{
                    padding: "8px 12px",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--color-border)",
                    backgroundColor: "var(--color-white)",
                    color: "var(--color-text)",
                    fontSize: "14px",
                    fontFamily: "inherit",
                    cursor: "pointer"
                  }}
                >
                  <option value="en">English</option>
                  <option value="ar">العربية</option>
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
