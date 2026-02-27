// D:\digital-witness\apps\web\app\(app)\settings\page.tsx
"use client";

import { Button, Card, useToast } from "../../../components/ui";
import { supportedLocales, type Locale } from "@proovra/shared";
import { useAuth, useLocale } from "../../providers";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";
import { Icons } from "../../../components/icons";

type ProfileDraft = {
  firstName: string;
  lastName: string;
  displayName: string;
  country: string;
  timezone: string;
  bio: string;
};

function initialsFromUser(user: any): string {
  const f = (user?.firstName ?? "").trim();
  const l = (user?.lastName ?? "").trim();
  const d = (user?.displayName ?? "").trim();
  const e = (user?.email ?? "").trim();

  const pick = (s: string) => (s ? s[0].toUpperCase() : "");
  const a = pick(f) || pick(d) || pick(e) || "?";
  const b = pick(l);
  return (a + b).trim() || "?";
}

export default function SettingsPage() {
  const { t, locale } = useLocale();
  const { user, setToken, updateUser } = useAuth();
  const { addToast } = useToast();
  const router = useRouter();

  const [plan, setPlan] = useState("FREE");
  const [savingProfile, setSavingProfile] = useState(false);

  const [selectedLanguage, setSelectedLanguage] = useState<Locale>(
    supportedLocales.includes(locale as Locale) ? (locale as Locale) : "en"
  );

  // Build initial draft from user
  const initialDraft = useMemo<ProfileDraft>(() => {
    const u: any = user ?? {};
    return {
      firstName: (u.firstName ?? "").toString(),
      lastName: (u.lastName ?? "").toString(),
      displayName: (u.displayName ?? "").toString(),
      country: (u.country ?? "").toString(),
      timezone: (u.timezone ?? "").toString(),
      bio: (u.bio ?? "").toString(),
    };
  }, [user]);

  const [draft, setDraft] = useState<ProfileDraft>(initialDraft);

  // Keep draft synced when user changes (login/logout/refresh)
  useEffect(() => {
    setDraft(initialDraft);
  }, [initialDraft]);

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

  const profileCompletion = useMemo(() => {
    const total = 5; // first/last/display/country/timezone (bio optional)
    let filled = 0;
    if (draft.firstName.trim()) filled++;
    if (draft.lastName.trim()) filled++;
    if (draft.displayName.trim()) filled++;
    if (draft.country.trim()) filled++;
    if (draft.timezone.trim()) filled++;
    const pct = Math.round((filled / total) * 100);
    return { filled, total, pct };
  }, [draft]);

  const saveProfile = async () => {
    if (!user?.id) {
      addToast("You must be signed in to edit your profile", "warning");
      return;
    }

    try {
      setSavingProfile(true);
      addToast("Saving profile...", "info");

      const payload = {
        firstName: draft.firstName,
        lastName: draft.lastName,
        displayName: draft.displayName,
        country: draft.country,
        timezone: draft.timezone,
        bio: draft.bio,
      };

      const res = await apiFetch("/v1/users/me", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });

      if (res?.user) {
        updateUser(res.user);
      }

      addToast("Profile updated", "success");
    } catch (err) {
      captureException(err, { feature: "web_settings_profile_update" });
      addToast("Could not update profile", "error");
    } finally {
      setSavingProfile(false);
    }
  };

  const copyUserId = async () => {
    const id = (user as any)?.id;
    if (!id) return;
    try {
      await navigator.clipboard.writeText(String(id));
      addToast("User ID copied", "success");
    } catch {
      addToast("Could not copy", "warning");
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
              {/* Summary header */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
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
                      fontSize: 22,
                      fontWeight: 800,
                      letterSpacing: 0.5,
                      flex: "0 0 auto",
                    }}
                    aria-label="Avatar"
                  >
                    {initialsFromUser(user)}
                  </div>

                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: "var(--color-muted)" }}>Account</div>
                    <div
                      style={{
                        fontSize: 16,
                        fontWeight: 800,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {draft.displayName.trim() ||
                        `${draft.firstName} ${draft.lastName}`.trim() ||
                        user?.email ||
                        "Guest User"}
                    </div>

                    <div style={{ marginTop: 6, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <span style={{ fontSize: 13, color: "var(--color-muted)" }}>{user?.email ?? "—"}</span>

                      {(user as any)?.id && (
                        <button
                          type="button"
                          className="settings-link"
                          style={{ padding: 0, background: "transparent", border: 0, cursor: "pointer" }}
                          onClick={copyUserId}
                          title="Copy your user ID"
                        >
                          Copy User ID
                        </button>
                      )}

                      {user?.provider && (
                        <span style={{ fontSize: 12, color: "var(--color-muted)" }}>
                          • {String(user.provider).toLowerCase()}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Completion */}
                <div style={{ textAlign: "right", flex: "0 0 auto" }}>
                  <div style={{ fontSize: 12, color: "var(--color-muted)" }}>Profile completeness</div>
                  <div style={{ fontSize: 14, fontWeight: 800 }}>{profileCompletion.pct}%</div>
                </div>
              </div>

              {/* Divider-like spacing */}
              <div style={{ height: 12 }} />

              {/* Form */}
              <div style={{ display: "grid", gap: 12 }}>
                <div className="settings-row">
                  <span className="settings-label">First name</span>
                  <input
                    className="settings-select"
                    value={draft.firstName}
                    onChange={(e) => setDraft((p) => ({ ...p, firstName: e.target.value }))}
                    placeholder="e.g., Jalal"
                    autoComplete="given-name"
                  />
                </div>

                <div className="settings-row">
                  <span className="settings-label">Last name</span>
                  <input
                    className="settings-select"
                    value={draft.lastName}
                    onChange={(e) => setDraft((p) => ({ ...p, lastName: e.target.value }))}
                    placeholder="e.g., Attar"
                    autoComplete="family-name"
                  />
                </div>

                <div className="settings-row">
                  <span className="settings-label">Display name</span>
                  <input
                    className="settings-select"
                    value={draft.displayName}
                    onChange={(e) => setDraft((p) => ({ ...p, displayName: e.target.value }))}
                    placeholder="Shown in the app"
                    autoComplete="nickname"
                  />
                </div>

                <div className="settings-row">
                  <span className="settings-label">Country (ISO-2)</span>
                  <input
                    className="settings-select"
                    value={draft.country}
                    onChange={(e) => setDraft((p) => ({ ...p, country: e.target.value.toUpperCase() }))}
                    placeholder="DE"
                    maxLength={2}
                    inputMode="text"
                  />
                </div>

                <div className="settings-row">
                  <span className="settings-label">Timezone</span>
                  <input
                    className="settings-select"
                    value={draft.timezone}
                    onChange={(e) => setDraft((p) => ({ ...p, timezone: e.target.value }))}
                    placeholder="Europe/Berlin"
                  />
                </div>

                <div className="settings-row" style={{ alignItems: "start" }}>
                  <span className="settings-label">Bio</span>
                  <textarea
                    className="settings-select"
                    value={draft.bio}
                    onChange={(e) => setDraft((p) => ({ ...p, bio: e.target.value }))}
                    placeholder="Short bio (optional)"
                    rows={3}
                    style={{ resize: "vertical" }}
                  />
                </div>
              </div>

              {/* Actions */}
              <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Button variant="secondary" onClick={saveProfile} disabled={savingProfile || !user?.id}>
                  {savingProfile ? "Saving..." : profileCompletion.pct < 80 ? "Complete profile" : "Save profile"}
                </Button>

                <Button variant="secondary" onClick={handleSignOut}>
                  Sign out
                </Button>
              </div>

              {!user?.id && (
                <p style={{ marginTop: 10, fontSize: 13, color: "var(--color-muted)" }}>
                  You are currently browsing as a guest. Sign in to complete your profile.
                </p>
              )}
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