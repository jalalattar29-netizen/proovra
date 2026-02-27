// D:\digital-witness\apps\web\app\(app)\settings\page.tsx
"use client";

import { Button, Card, useToast, Input } from "../../../components/ui";
import { supportedLocales, type Locale } from "@proovra/shared";
import { useAuth, useLocale } from "../../providers";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";
import { Icons } from "../../../components/icons";

type BillingStatusResponse = {
  entitlement?: {
    plan?: string | null;
  } | null;
};

type UserMeResponse = {
  user?: {
    id: string;
    email?: string | null;
    displayName?: string | null;
    provider: string;

    firstName?: string | null;
    lastName?: string | null;
    avatarUrl?: string | null;
    locale?: string | null;
    timezone?: string | null;
    country?: string | null;
    bio?: string | null;

    createdAt?: string;
    updatedAt?: string;
  } | null;
};

type UserProfileUpdatePayload = {
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string | null;
  locale?: string | null;
  timezone?: string | null;
  country?: string | null;
  bio?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export default function SettingsPage() {
  const { t, locale } = useLocale();
  const { user, setToken, updateUser } = useAuth();
  const { addToast } = useToast();
  const router = useRouter();

  const [plan, setPlan] = useState("FREE");

  const [selectedLanguage, setSelectedLanguage] = useState<Locale>(
    supportedLocales.includes(locale as Locale) ? (locale as Locale) : "en"
  );

  // Profile form (editable)
  const [firstName, setFirstName] = useState<string>(user?.firstName ?? "");
  const [lastName, setLastName] = useState<string>(user?.lastName ?? "");
  const [displayName, setDisplayName] = useState<string>(user?.displayName ?? "");
  const [country, setCountry] = useState<string>(user?.country ?? "");
  const [timezone, setTimezone] = useState<string>(user?.timezone ?? "");
  const [bio, setBio] = useState<string>(user?.bio ?? "");

  // keep form in sync when user changes
  useEffect(() => {
    setFirstName(user?.firstName ?? "");
    setLastName(user?.lastName ?? "");
    setDisplayName(user?.displayName ?? "");
    setCountry(user?.country ?? "");
    setTimezone(user?.timezone ?? "");
    setBio(user?.bio ?? "");
  }, [user?.id]); // only when identity changes

  useEffect(() => {
    apiFetch("/v1/billing/status")
      .then((data: unknown) => {
        const obj = asRecord(data);
        const ent = obj ? asRecord(obj["entitlement"]) : null;
        const planValue = ent && typeof ent["plan"] === "string" ? (ent["plan"] as string) : "FREE";
        setPlan(planValue || "FREE");
      })
      .catch((err: unknown) => {
        captureException(err, { feature: "web_settings_billing" });
        setPlan("FREE");
        addToast("Could not load subscription status", "warning");
      });
  }, [addToast]);

  const initials = useMemo(() => {
    const a = (user?.displayName ?? user?.email ?? "?").trim();
    return a ? a[0]?.toUpperCase() : "?";
  }, [user?.displayName, user?.email]);

  const handleSignOut = async () => {
    try {
      addToast("Signing out...", "info");
      await apiFetch("/v1/auth/logout", { method: "POST" });
      addToast("Signed out successfully", "success");
    } catch (err: unknown) {
      captureException(err, { feature: "web_settings_logout" });
      addToast("Sign out failed", "error");
    } finally {
      setToken(null);
      setTimeout(() => {
        router.replace("/");
      }, 500);
    }
  };

  const handleSaveProfile = async () => {
    try {
      addToast("Saving profile...", "info");

      const payload: UserProfileUpdatePayload = {
        displayName: displayName.trim() || null,
        firstName: firstName.trim() || null,
        lastName: lastName.trim() || null,
        country: country.trim() || null,
        timezone: timezone.trim() || null,
        bio: bio.trim() || null,
        locale: selectedLanguage
      };

      // Prefer /v1/users/me if exists, fallback to /v1/auth/me (read-only)
      const res = await apiFetch("/v1/users/me", {
        method: "PATCH",
        body: JSON.stringify(payload)
      });

      const obj = asRecord(res);
      const userObj = obj ? asRecord(obj["user"]) : null;

      if (!userObj) {
        // Some APIs return { data: { user } }
        const dataObj = obj ? asRecord(obj["data"]) : null;
        const nestedUser = dataObj ? asRecord(dataObj["user"]) : null;
        const finalUser = nestedUser ?? userObj;

        if (!finalUser) {
          addToast("Profile saved", "success");
          return;
        }
      }

      // If API returns { user }
      const me = res as UserMeResponse;
      if (me?.user) updateUser(me.user);
      addToast("Profile updated", "success");
    } catch (err: unknown) {
      captureException(err, { feature: "web_settings_profile_save" });

      // If endpoint isn't deployed yet, show a clear message
      const msg =
        err instanceof Error ? err.message : "Could not save profile. Please try again.";
      addToast(msg.includes("404") ? "Profile endpoint not deployed yet (API 404)." : msg, "error");
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
              {/* Avatar + account */}
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
                  {initials}
                </div>
                <div>
                  <div style={{ fontSize: 14, color: "#999" }}>Account</div>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>
                    {user?.displayName || user?.email || "Guest User"}
                  </div>
                  {user?.email && (
                    <div style={{ fontSize: 13, color: "var(--color-muted)", marginTop: 2 }}>
                      {user.email}
                    </div>
                  )}
                </div>
              </div>

              {/* Editable profile fields */}
              <div style={{ display: "grid", gap: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <div className="settings-label" style={{ marginBottom: 6 }}>
                      First name
                    </div>
                    <Input value={firstName} onChange={setFirstName} placeholder="First name" />
                  </div>
                  <div>
                    <div className="settings-label" style={{ marginBottom: 6 }}>
                      Last name
                    </div>
                    <Input value={lastName} onChange={setLastName} placeholder="Last name" />
                  </div>
                </div>

                <div>
                  <div className="settings-label" style={{ marginBottom: 6 }}>
                    Display name
                  </div>
                  <Input
                    value={displayName}
                    onChange={setDisplayName}
                    placeholder="Public display name"
                  />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <div className="settings-label" style={{ marginBottom: 6 }}>
                      Country
                    </div>
                    <Input value={country} onChange={setCountry} placeholder="e.g. Germany" />
                  </div>
                  <div>
                    <div className="settings-label" style={{ marginBottom: 6 }}>
                      Timezone
                    </div>
                    <Input value={timezone} onChange={setTimezone} placeholder="e.g. Europe/Berlin" />
                  </div>
                </div>

                <div>
                  <div className="settings-label" style={{ marginBottom: 6 }}>
                    Bio
                  </div>
                  <textarea
                    className="input"
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    placeholder="A short bio (optional)"
                    rows={4}
                    style={{ resize: "vertical" }}
                  />
                </div>
              </div>

              <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Button variant="secondary" onClick={handleSaveProfile}>
                  Save profile
                </Button>
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
                  onChange={(e) => setSelectedLanguage(e.target.value as Locale)}
                  className="settings-select"
                >
                  {supportedLocales.map((lc) => (
                    <option key={lc} value={lc}>
                      {lc === "en"
                        ? "English"
                        : lc === "ar"
                          ? "العربية"
                          : lc === "de"
                            ? "Deutsch"
                            : lc === "fr"
                              ? "Français"
                              : lc === "es"
                                ? "Español"
                                : lc === "tr"
                                  ? "Türkçe"
                                  : lc === "ru"
                                    ? "Русский"
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