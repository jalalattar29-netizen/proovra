"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { supportedLocales, type Locale } from "@proovra/shared";
import { Button, Card, useToast, Input } from "../../../components/ui";
import { Icons } from "../../../components/icons";
import { apiFetch } from "../../../lib/api";
import { LEGAL_LINKS } from "../../../lib/legalLinks";
import { captureException } from "../../../lib/sentry";
import { openCookiePreferences } from "../../../lib/consent";
import { useAuth, useLocale } from "../../providers";

type BillingStatusResponse = {
  entitlement?: { plan?: string | null } | null;
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

type LegalAcceptanceItem = {
  id: string;
  policyKey: string;
  policyVersion: string;
  acceptedAt: string;
  source?: string | null;
};

type CookieConsentLatest = {
  record?: {
    id: string;
    consentVersion: string;
    necessary: boolean;
    analytics: boolean;
    marketing: boolean;
    preferences: boolean;
    createdAt: string;
  } | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function extractUserFromResponse(res: unknown): UserMeResponse["user"] | null {
  const obj = asRecord(res);
  if (!obj) return null;

  const directUser = asRecord(obj["user"]);
  if (directUser && typeof directUser["id"] === "string") {
    return directUser as unknown as NonNullable<UserMeResponse["user"]>;
  }

  const dataObj = asRecord(obj["data"]);
  const nestedUser = dataObj ? asRecord(dataObj["user"]) : null;
  if (nestedUser && typeof nestedUser["id"] === "string") {
    return nestedUser as unknown as NonNullable<UserMeResponse["user"]>;
  }

  return null;
}

export default function SettingsPage() {
  const { t, locale, setLocale } = useLocale();
  const { user, setToken, updateUser } = useAuth();
  const { addToast } = useToast();
  const router = useRouter();

  const [plan, setPlan] = useState("FREE");

  const [selectedLanguage, setSelectedLanguage] = useState<Locale>(
    supportedLocales.includes(locale as Locale) ? (locale as Locale) : "en"
  );

  const [firstName, setFirstName] = useState<string>(user?.firstName ?? "");
  const [lastName, setLastName] = useState<string>(user?.lastName ?? "");
  const [displayName, setDisplayName] = useState<string>(user?.displayName ?? "");
  const [country, setCountry] = useState<string>(user?.country ?? "");
  const [timezone, setTimezone] = useState<string>(user?.timezone ?? "");
  const [bio, setBio] = useState<string>(user?.bio ?? "");

  const [legalAcceptances, setLegalAcceptances] = useState<LegalAcceptanceItem[]>([]);
  const [latestCookieConsent, setLatestCookieConsent] =
    useState<CookieConsentLatest["record"]>(null);

  useEffect(() => {
    const normalized = supportedLocales.includes(locale as Locale)
      ? (locale as Locale)
      : "en";

    setSelectedLanguage(normalized);
  }, [locale]);

  useEffect(() => {
    setFirstName(user?.firstName ?? "");
    setLastName(user?.lastName ?? "");
    setDisplayName(user?.displayName ?? "");
    setCountry(user?.country ?? "");
    setTimezone(user?.timezone ?? "");
    setBio(user?.bio ?? "");
  }, [
    user?.firstName,
    user?.lastName,
    user?.displayName,
    user?.country,
    user?.timezone,
    user?.bio,
    user?.id,
  ]);

  useEffect(() => {
    apiFetch("/v1/billing/status")
      .then((data: BillingStatusResponse) => {
        setPlan(data.entitlement?.plan ?? "FREE");
      })
      .catch((err: unknown) => {
        captureException(err, { feature: "web_settings_billing" });
        setPlan("FREE");
        addToast("Could not load subscription status", "warning");
      });
  }, [addToast]);

  useEffect(() => {
    if (!user?.id) return;

    apiFetch("/v1/users/legal-acceptance")
      .then((data: { items?: LegalAcceptanceItem[] }) => {
        setLegalAcceptances(Array.isArray(data.items) ? data.items : []);
      })
      .catch(() => {
        setLegalAcceptances([]);
      });

    apiFetch("/v1/users/cookie-consent/latest")
      .then((data: CookieConsentLatest) => {
        setLatestCookieConsent(data.record ?? null);
      })
      .catch(() => {
        setLatestCookieConsent(null);
      });
  }, [user?.id]);

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
      router.replace("/");
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
        locale: selectedLanguage,
      };

      const res = await apiFetch("/v1/users/me", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });

      const updated = extractUserFromResponse(res);
      if (updated) {
        updateUser(updated);
        if (updated.locale) {
          setLocale(updated.locale as Locale);
        }
      }

      addToast("Profile updated", "success");
    } catch (err: unknown) {
      captureException(err, { feature: "web_settings_profile_save" });
      const msg =
        err instanceof Error ? err.message : "Could not save profile. Please try again.";
      addToast(
        msg.includes("404") ? "Profile endpoint not deployed yet (API 404)." : msg,
        "error"
      );
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
        <Card className="app-card">
          <div className="settings-section-header">
            <Icons.Dashboard />
            <span>Profile</span>
          </div>

          <div className="settings-section-body">
            <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
              <div className="profile-avatar">{initials}</div>

              <div className="profile-info">
                <div className="profile-info-label">Account</div>
                <div className="profile-info-title">
                  {user?.displayName || user?.email || "Guest User"}
                </div>
                {user?.email && <div className="profile-info-email">{user.email}</div>}
              </div>
            </div>

            <div className="profile-form-fields">
              <div className="profile-grid-2">
                <div className="profile-form-group">
                  <div className="profile-field-label">First name</div>
                  <Input value={firstName} onChange={setFirstName} placeholder="First name" maxLength={80} />
                </div>
                <div className="profile-form-group">
                  <div className="profile-field-label">Last name</div>
                  <Input value={lastName} onChange={setLastName} placeholder="Last name" maxLength={80} />
                </div>
              </div>

              <div className="profile-form-group">
                <div className="profile-field-label">Display name</div>
                <Input value={displayName} onChange={setDisplayName} placeholder="Public display name" maxLength={120} />
              </div>

              <div className="profile-grid-2">
                <div className="profile-form-group">
                  <div className="profile-field-label">Country</div>
                  <Input value={country} onChange={setCountry} placeholder="e.g. Germany, Syria" maxLength={120} />
                </div>
                <div className="profile-form-group">
                  <div className="profile-field-label">Timezone</div>
                  <Input value={timezone} onChange={setTimezone} placeholder="e.g. Europe/Berlin" maxLength={64} />
                </div>
              </div>

              <div className="profile-form-group">
                <div className="profile-field-label">Bio</div>
                <textarea
                  className="input"
                  value={bio}
                  onChange={(e) => setBio(e.target.value.slice(0, 280))}
                  placeholder="A short bio (optional)"
                  rows={4}
                  maxLength={280}
                  style={{ resize: "vertical" }}
                />
              </div>
            </div>

            <div className="profile-actions">
              <Button variant="secondary" onClick={handleSaveProfile}>
                Save profile
              </Button>
              <Button variant="secondary" onClick={handleSignOut}>
                Sign out
              </Button>
            </div>
          </div>
        </Card>

        <Card className="app-card">
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
              <span style={{ color: "#bfe8df" }}>Active</span>
            </div>

            <Link href="/legal/security" className="settings-link">
              Security policy
            </Link>
            <a href="mailto:security@proovra.com" className="settings-link">
              security@proovra.com
            </a>
          </div>
        </Card>

        <Card className="app-card">
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
            <p style={{ margin: 0, fontSize: 13, color: "var(--app-muted)" }}>
              Language preference will be used for future UI updates.
            </p>
          </div>
        </Card>

        <Card className="app-card">
          <div className="settings-section-header">
            <Icons.Billing />
            <span>Subscription</span>
          </div>
          <div className="settings-section-body">
            <div className="settings-row">
              <span className="settings-label">Current plan</span>
              <span style={{ color: "#e6c9ae" }}>{plan}</span>
            </div>
            <div style={{ marginTop: 12 }}>
              <Link href="/billing">
                <Button variant="secondary">Go to Billing</Button>
              </Link>
            </div>
          </div>
        </Card>

        <Card className="app-card">
          <div className="settings-section-header">
            <Icons.Security />
            <span>Legal</span>
          </div>

          <div className="settings-section-body">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {LEGAL_LINKS.map((link) => (
                <Link key={link.href} href={link.href} className="settings-link">
                  {link.label}
                </Link>
              ))}
            </div>

            <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
              <Button
                variant="secondary"
                onClick={() => {
                  openCookiePreferences();
                }}
              >
                Manage Cookie Preferences
              </Button>

              {latestCookieConsent ? (
                <div style={{ fontSize: 12, color: "var(--app-text)" }}>
                  Cookie consent v{latestCookieConsent.consentVersion} — saved on{" "}
                  {new Date(latestCookieConsent.createdAt).toLocaleString()}
                </div>
              ) : null}

              {legalAcceptances.length > 0 ? (
                <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
                  {legalAcceptances.slice(0, 4).map((item) => (
                    <div
                      key={item.id}
                      style={{
                        fontSize: 12,
                        color: "var(--app-text)",
                        opacity: 0.85,
                      }}
                    >
                      {item.policyKey} v{item.policyVersion} —{" "}
                      {new Date(item.acceptedAt).toLocaleString()}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </Card>
      </div>
    </div>
  </div>
);
}