"use client";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { supportedLocales, type Locale } from "@proovra/shared";
import { Button, Card, useToast, Input } from "../../../components/ui";
import { Icons } from "../../../components/icons";
import { apiFetch } from "../../../lib/api";
import { formatUserDateTime } from "../../../lib/date";
// Phase IA-self-serve-simplification — gate the "Identity & Security"
// (workspace operator) section on /security-center eligibility. Self-
// serve users get Account Security via /settings/security; the
// workspace identity surface is ENTERPRISE_ONLY.
import { canAccessSurface } from "../../../lib/surface/access";
import { useSurfaceUserContext } from "../../../lib/surface/useSurfaceUserContext";
import { LEGAL_LINKS } from "../../../lib/legalLinks";
import { captureException } from "../../../lib/sentry";
import { openCookiePreferences } from "../../../lib/consent";
import { useAuth, useLocale } from "../../providers";
import { usePlatformContext } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
// Phase Final-D5-PT2 — `AccountSecurityCard` retired. Personal security
// (password change, active sessions, security events) now lives at the
// canonical `/security-center` route. The Security card below is a
// link-card pointing operators there.

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

function cardShellStyle() {
  return {
    border: "1px solid rgba(79,112,107,0.16)",
    boxShadow:
      "0 18px 38px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.48)",
  } as const;
}

function velvetButtonClass() {
  return "rounded-[999px] border px-5 py-3 text-[0.94rem] font-semibold transition-all duration-200 hover:-translate-y-[1px] hover:brightness-[1.03]";
}

function sectionHeader(icon: React.ReactNode, title: string) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <span className="flex h-10 w-10 items-center justify-center rounded-full border border-[rgba(183,157,132,0.18)] bg-[linear-gradient(180deg,rgba(183,157,132,0.08)_0%,rgba(255,255,255,0.03)_100%)] text-[#8a6e57] shadow-[0_10px_22px_rgba(0,0,0,0.08)]">
        {icon}
      </span>
      <div className="text-[1.08rem] font-semibold tracking-[-0.03em] text-[#21353a]">
        {title}
      </div>
    </div>
  );
}

function getLocaleLabel(lc: Locale): string {
  return lc === "en"
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
                : String(lc).toUpperCase();
}

// Phase 38.9 — wrap in canonical PageRouteGate. `account.settings`
// is an ACCOUNT-domain route (NONE active-space) so it loads for every
// authenticated user.
//
// Phase G5 pre-commit fix — the outer `<div data-testid="account-settings-page">`
// is a stable mount marker that commits as soon as React renders the
// route, regardless of envelope-resolution state. Playwright uses it
// to detect "the settings route is on screen" deterministically — the
// previous test waited only for either the inner AccountSecurityCard
// or the PageRouteGate denial panel, both of which depend on
// downstream envelope + capability resolution and can take >15s on a
// cold Next.js dev server. The marker adds zero runtime behavior; it
// is a single attribute on a wrapper div.
export default function SettingsPage() {
  return (
    <div data-testid="account-settings-page">
      <PageRouteGate routeId="account.settings">
        <SettingsPageInner />
      </PageRouteGate>
    </div>
  );
}

function SettingsPageInner() {
  const { t, locale, setLocale } = useLocale();
  const { user, setToken, updateUser } = useAuth();
  // Phase IA-self-serve-simplification — gate the workspace-level
  // Identity & Security card on /security-center eligibility. Self-
  // serve users see only Account Security (/settings/security).
  const surfaceUserCtx = useSurfaceUserContext();
  const canSeeWorkspaceSecurity = canAccessSurface(
    surfaceUserCtx,
    "/security-center",
  );
  // R1 Part 4 — pair the /v1/users/me profile PATCH with a platform
  // envelope refresh so the canonical user fields stay in sync.
  // Pre-R1, profile edits drifted from the envelope until manual
  // reload.
  const platformCtx = usePlatformContext();
  const { addToast } = useToast();
  const router = useRouter();
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);

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
  if (!languageMenuOpen) return;

  const handleClick = () => setLanguageMenuOpen(false);

  window.addEventListener("click", handleClick);
  return () => window.removeEventListener("click", handleClick);
}, [languageMenuOpen]);

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

      // R1 Part 4 — sync canonical platform envelope so any surface
      // that reads user.firstName / user.locale / etc. from the
      // envelope reflects the edit immediately.
      try {
        await platformCtx.refresh();
      } catch {
        // Refresh failure is non-fatal — local AuthContext update
        // above already reflects the change. Drift will resolve on
        // next provider refresh.
      }

      addToast("Profile updated", "success");
    } catch (err: unknown) {
      captureException(err, { feature: "web_settings_profile_save" });
      const msg =
        toSafeUserError(err, { message: "Could not save profile. Please try again." }).message;
      addToast(
        msg.includes("404") ? "Profile endpoint not deployed yet (API 404)." : msg,
        "error"
      );
    }
  };

  return (
    <div className="section app-section settings-page-shell">
      <style jsx global>{`
        .settings-page-shell .settings-silver-card {
          position: relative;
          overflow: hidden;
        }

        .settings-page-shell .settings-silver-card--language {
  overflow: visible !important;
  z-index: 20;
}

.settings-page-shell .settings-silver-card--language .settings-silver-card__content {
  overflow: visible;
}

.settings-page-shell .settings-language-dropdown-wrap {
  position: relative;
  z-index: 30;
}

.settings-main-grid {
  display: grid;
  gap: 20px;
}

@media (min-width: 1024px) {
  .settings-main-grid {
    grid-template-columns: 1fr;
  }
}

        .settings-page-shell .settings-silver-card__bg {
          position: absolute;
          inset: 0;
          background-image: url("/images/panel-silver.webp.png");
          background-size: cover;
          background-position: center;
        }

        .settings-page-shell .settings-silver-card__overlay {
          position: absolute;
          inset: 0;
          background:
            radial-gradient(circle at 16% 12%, rgba(255,255,255,0.34), transparent 28%),
            linear-gradient(
              180deg,
              rgba(255,255,255,0.24) 0%,
              rgba(248,249,246,0.34) 42%,
              rgba(239,241,238,0.42) 100%
            );
        }

        .settings-page-shell .settings-silver-card__content {
          position: relative;
          z-index: 1;
        }

        .settings-page-shell input,
        .settings-page-shell textarea,
        .settings-page-shell select,
        .settings-page-shell .input {
          background: linear-gradient(
            180deg,
            rgba(250,251,249,0.94) 0%,
            rgba(241,244,241,0.98) 100%
          ) !important;
          border: 1px solid rgba(79,112,107,0.14) !important;
          color: #23373b !important;
          border-radius: 18px !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.68),
            0 10px 22px rgba(0,0,0,0.05) !important;
        }

        .settings-page-shell input::placeholder,
        .settings-page-shell textarea::placeholder {
          color: rgba(93,109,113,0.62) !important;
        }

        .settings-page-shell input:focus,
        .settings-page-shell textarea:focus,
        .settings-page-shell select:focus,
        .settings-page-shell .input:focus {
          border-color: rgba(79,112,107,0.22) !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.78),
            0 0 0 3px rgba(79,112,107,0.08),
            0 12px 24px rgba(0,0,0,0.06) !important;
          outline: none !important;
        }

        .settings-page-shell textarea {
          min-height: 120px;
        }

        .settings-page-shell input,
.settings-page-shell textarea {
  width: 100%;
}

        .settings-page-shell .settings-primary-btn {
          border-color: rgba(79,112,107,0.22) !important;
          background: linear-gradient(
            180deg,
            rgba(58,92,95,0.96) 0%,
            rgba(20,38,42,0.98) 100%
          ) !important;
          color: #eef3f1 !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.08),
            0 16px 34px rgba(18,40,44,0.22) !important;
        }

        .settings-page-shell .settings-secondary-btn {
          border-color: rgba(79,112,107,0.12) !important;
          background: linear-gradient(
            180deg,
            rgba(250,251,249,0.82) 0%,
            rgba(241,244,241,0.96) 100%
          ) !important;
          color: #24373b !important;
          box-shadow:
            0 10px 20px rgba(0,0,0,0.05),
            inset 0 1px 0 rgba(255,255,255,0.70) !important;
        }

        .settings-cards-grid {
  display: grid;
  gap: 20px;
}

@media (min-width: 1100px) {
  .settings-cards-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

        .settings-page-shell .settings-select {
          width: 100%;
          min-height: 54px;
          padding: 0 48px 0 16px !important;
          appearance: none;
          -webkit-appearance: none;
          -moz-appearance: none;
          background-image:
            linear-gradient(180deg, rgba(250,251,249,0.94) 0%, rgba(241,244,241,0.98) 100%),
            url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='%238a6e57' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E") !important;
          background-repeat: no-repeat, no-repeat !important;
          background-position: left top, right 16px center !important;
          background-size: auto, 16px !important;
          cursor: pointer;
        }

        .settings-page-shell .settings-select option {
          background: #f7f8f5;
          color: #23373b;
        }

        .settings-page-shell .settings-legal-links {
          display: grid;
          gap: 10px;
        }

        .settings-page-shell .settings-legal-link,
        .settings-page-shell .settings-security-link {
          width: fit-content;
          color: #496166 !important;
          font-weight: 500;
          text-decoration: none;
          transition:
            color 0.2s ease,
            opacity 0.2s ease,
            transform 0.2s ease;
        }

        .settings-page-shell .settings-legal-link:hover,
        .settings-page-shell .settings-security-link:hover {
          color: #21353a !important;
          opacity: 1;
          transform: translateY(-1px);
        }
      `}</style>

      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ maxWidth: 760 }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.72rem",
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.10)",
                  background: "rgba(255,255,255,0.04)",
                  padding: "8px 16px",
                  fontSize: "0.68rem",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.28em",
                  color: "#afbbb7",
                  boxShadow: "0 10px 24px rgba(0,0,0,0.08)",
                  backdropFilter: "blur(10px)",
                  WebkitBackdropFilter: "blur(10px)",
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: "#b79d84",
                    opacity: 0.95,
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                {t("settings")}
              </div>

              <h1
                className="mt-5 max-w-[720px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
                style={{ margin: "20px 0 0" }}
              >
                Manage your <span className="text-[#c3ebe2]">account preferences</span>.
              </h1>

              <p className="mt-5 max-w-[700px] text-[0.95rem] font-normal leading-[1.8] tracking-[-0.006em] text-[#aab5b2] md:text-[0.99rem]">
                Update your <span className="text-[#cfd8d5]">profile</span>, review{" "}
                <span className="text-[#bbc7c3]">security and legal settings</span>, and
                manage your <span className="text-[#d9ccbf]">subscription preferences</span>{" "}
                from one place.
              </p>

              <div className="mt-6 flex flex-wrap gap-2.5">
                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#c7d1ce] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#91aca5]">✓</span>
                  Profile and identity controls
                </div>

                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#c7d1ce] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#91aca5]">✓</span>
                  Language and security options
                </div>

                <div className="rounded-full border border-[rgba(214,184,157,0.18)] bg-[linear-gradient(180deg,rgba(183,157,132,0.07)_0%,rgba(255,255,255,0.028)_100%)] px-3.5 py-2 text-[0.78rem] font-normal text-[#d9ccbf] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#c2a07f]">✓</span>
                  Legal and billing visibility
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        className="app-body app-body-full pt-8 md:pt-10"
        style={{
          position: "relative",
          background:
            "linear-gradient(180deg, rgba(239,241,238,0.96) 0%, rgba(234,237,234,0.98) 100%)",
        }}
      >
        <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
          <img
            src="/images/landing-network-bg.png"
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-top opacity-[0.12] saturate-[0.55] brightness-[1.02] contrast-[0.94]"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.03)_22%,rgba(255,255,255,0.03)_78%,rgba(255,255,255,0.08)_100%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0.03)_12%,rgba(255,255,255,0.00)_24%,rgba(255,255,255,0.00)_76%,rgba(255,255,255,0.03)_88%,rgba(255,255,255,0.10)_100%)]" />
        </div>

        <section className="relative z-10 px-6 pb-14 md:px-8 md:pb-16">
<div className="settings-main-grid mx-auto max-w-7xl gap-5">
              <Card
              className="settings-silver-card rounded-[30px] border bg-transparent p-0 shadow-none"
              style={cardShellStyle()}
            >
              <div className="settings-silver-card__bg" />
              <div className="settings-silver-card__overlay" />

              <div className="settings-silver-card__content p-6 md:p-7">
                {sectionHeader(<Icons.Dashboard />, "Profile")}

                <div className="mb-5 flex items-center gap-4">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full border border-[rgba(183,157,132,0.18)] bg-[linear-gradient(180deg,rgba(214,184,157,0.12)_0%,rgba(255,255,255,0.56)_100%)] text-[1.35rem] font-bold text-[#23373b] shadow-[0_10px_22px_rgba(0,0,0,0.08)]">
                    {initials}
                  </div>

                  <div>
                    <div className="text-[12px] text-[#6a777b]">Account</div>
                    <div className="text-[1.05rem] font-semibold tracking-[-0.02em] text-[#21353a]">
                      {user?.displayName || user?.email || "Guest User"}
                    </div>
                    {user?.email ? (
                      <div className="text-[13px] text-[#5d6d71]">{user.email}</div>
                    ) : null}
                  </div>
                </div>

                <div className="grid gap-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <div className="mb-2 text-[13px] text-[#5d6d71]">First name</div>
                      <Input
                        value={firstName}
                        onChange={setFirstName}
                        placeholder="First name"
                        maxLength={80}
                      />
                    </div>

                    <div>
                      <div className="mb-2 text-[13px] text-[#5d6d71]">Last name</div>
                      <Input
                        value={lastName}
                        onChange={setLastName}
                        placeholder="Last name"
                        maxLength={80}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 text-[13px] text-[#5d6d71]">Display name</div>
                    <Input
                      value={displayName}
                      onChange={setDisplayName}
                      placeholder="Public display name"
                      maxLength={120}
                    />
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <div className="mb-2 text-[13px] text-[#5d6d71]">Country</div>
                      <Input
                        value={country}
                        onChange={setCountry}
                        placeholder="e.g. Germany, Syria"
                        maxLength={120}
                      />
                    </div>

                    <div>
                      <div className="mb-2 text-[13px] text-[#5d6d71]">Timezone</div>
                      <Input
                        value={timezone}
                        onChange={setTimezone}
                        placeholder="e.g. Europe/Berlin"
                        maxLength={64}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 text-[13px] text-[#5d6d71]">Bio</div>
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

                <div className="mt-5 flex flex-wrap gap-3">
                  <Button
                    variant="secondary"
                    onClick={handleSaveProfile}
                    className={`${velvetButtonClass()} settings-primary-btn`}
                  >
                    Save profile
                  </Button>

                  <Button
                    variant="secondary"
                    onClick={handleSignOut}
                    className={`${velvetButtonClass()} settings-secondary-btn`}
                  >
                    Sign out
                  </Button>
                </div>
              </div>
            </Card>

<div className="settings-cards-grid gap-5">
                <Card
                className="settings-silver-card rounded-[30px] border bg-transparent p-0 shadow-none"
                style={cardShellStyle()}
              >
                <div className="settings-silver-card__bg" />
                <div className="settings-silver-card__overlay" />

                <div className="settings-silver-card__content p-6 md:p-7">
                  {sectionHeader(<Icons.Security />, "Security")}

                  <div className="grid gap-4">
                    <div className="flex items-center justify-between gap-4 border-b border-[rgba(79,112,107,0.08)] pb-3">
                      <span className="text-[#5d6d71]">Login method</span>
                      <span className="text-[#21353a]">{user?.provider ?? "—"}</span>
                    </div>

                    <div className="flex items-center justify-between gap-4 border-b border-[rgba(79,112,107,0.08)] pb-3">
                      <span className="text-[#5d6d71]">Session</span>
                      <span className="font-semibold text-[#2d5b59]">Active</span>
                    </div>

                    <Link
                      href="/legal/security"
                      className="settings-security-link text-[0.95rem]"
                    >
                      Security policy
                    </Link>

                    <a
                      href="mailto:security@proovra.com"
                      className="settings-security-link text-[0.95rem]"
                    >
                      security@proovra.com
                    </a>
                  </div>
                </div>
              </Card>

<Card
  className="settings-silver-card settings-silver-card--language rounded-[30px] border bg-transparent p-0 shadow-none"
  style={cardShellStyle()}
>
                  <div className="settings-silver-card__bg" />
                <div className="settings-silver-card__overlay" />

                <div className="settings-silver-card__content p-6 md:p-7">
                  {sectionHeader(<Icons.Settings />, t("language"))}

                  <div className="grid gap-4">
                    <div className="flex flex-col gap-3">
                      <span className="text-[#5d6d71]">UI language</span>
<div className="settings-language-dropdown-wrap" style={{ position: "relative" }}>
    <button
    type="button"
onClick={(e) => {
  e.stopPropagation();
  setLanguageMenuOpen((prev) => !prev);
}}
    className="settings-select"
    style={{
      textAlign: "left",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      position: "relative",
    }}
    aria-expanded={languageMenuOpen}
    aria-haspopup="listbox"
  >
<span
  style={{
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    display: "block",
  }}
>
  {getLocaleLabel(selectedLanguage)}
</span>
  </button>

  {languageMenuOpen && (
<div
  role="listbox"
  onClick={(e) => e.stopPropagation()}
  style={{
            position: "absolute",
        top: "calc(100% + 8px)",
        left: 0,
        right: 0,
        zIndex: 80,
        borderRadius: 20,
        border: "1px solid rgba(79,112,107,0.12)",
        background:
          "linear-gradient(180deg, rgba(252,253,251,0.98) 0%, rgba(243,245,242,0.99) 100%)",
        boxShadow:
          "0 18px 38px rgba(0,0,0,0.10), inset 0 1px 0 rgba(255,255,255,0.7)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        padding: 8,
      }}
    >
      {supportedLocales.map((lc) => {
        const active = selectedLanguage === lc;

        return (
          <button
            key={lc}
            type="button"
onClick={(e) => {
  e.stopPropagation();
  setSelectedLanguage(lc as Locale);
  setLanguageMenuOpen(false);
}}
            style={{
              width: "100%",
              minHeight: 46,
              border: "none",
              background: active
                ? "linear-gradient(180deg, rgba(58,92,95,0.10) 0%, rgba(20,38,42,0.08) 100%)"
                : "transparent",
              color: "#23373b",
              borderRadius: 14,
              textAlign: "left",
              padding: "0 14px",
              fontSize: 14,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <span>{getLocaleLabel(lc as Locale)}</span>

            {active ? (
              <span
                style={{
                  color: "#3a5d61",
                  fontWeight: 700,
                  fontSize: 13,
                  flexShrink: 0,
                }}
              >
                ✓
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  )}
</div>
                    </div>

                    <p className="m-0 text-[13px] text-[#6a777b]">
                      Language preference will be used for future UI updates.
                    </p>
                  </div>
                </div>
              </Card>

              <Card
                className="settings-silver-card rounded-[30px] border bg-transparent p-0 shadow-none"
                style={cardShellStyle()}
              >
                <div className="settings-silver-card__bg" />
                <div className="settings-silver-card__overlay" />

                <div className="settings-silver-card__content p-6 md:p-7">
                  {sectionHeader(<Icons.Billing />, "Subscription")}

                  <div className="grid gap-4">
                    <div className="flex items-center justify-between gap-4 border-b border-[rgba(79,112,107,0.08)] pb-3">
                      <span className="text-[#5d6d71]">Current plan</span>
                      <span className="font-semibold text-[#8a6e57]">{plan}</span>
                    </div>

                    <div>
                      <Link href="/billing">
                        <Button
                          variant="secondary"
                          className={`${velvetButtonClass()} settings-primary-btn`}
                        >
                          Go to Billing
                        </Button>
                      </Link>
                    </div>
                  </div>
                </div>
              </Card>

              {/* Phase IA-collapse — Account security lives at
                  /settings/security (route id `account.security`):
                  password change, active sessions, sign-out everywhere,
                  recent security events. Workspace identity operations
                  (MFA policy, trusted devices, session revocations,
                  MFA recovery approvals) live at /security-center
                  (route id `workspace.security_center`, label
                  "Identity & Security"). Two cards below — one for
                  personal, one for workspace operators. The
                  `data-cc-security-link-card` attribute is preserved
                  on the workspace card so the Phase Final-D5-PT2
                  contract (the /settings page still points operators
                  at the workspace security console) stays satisfied. */}
              <Card
                className="settings-silver-card rounded-[30px] border bg-transparent p-0 shadow-none"
                style={cardShellStyle()}
                data-cc-account-security-link-card
              >
                <div className="settings-silver-card__bg" />
                <div className="settings-silver-card__overlay" />

                <div className="settings-silver-card__content p-6 md:p-7">
                  {sectionHeader(<Icons.Security />, "Account security")}

                  <div className="grid gap-4">
                    <p className="m-0 text-[13px] text-[#5d6d71]">
                      Change your password, review active sessions, sign
                      out of other devices, and view recent security
                      events.
                    </p>

                    <Link href="/settings/security">
                      <Button
                        variant="secondary"
                        className={`${velvetButtonClass()} settings-primary-btn`}
                      >
                        Open Account security
                      </Button>
                    </Link>
                  </div>
                </div>
              </Card>

              <Card
                className="settings-silver-card rounded-[30px] border bg-transparent p-0 shadow-none"
                style={cardShellStyle()}
                data-cc-security-link-card
              >
                <div className="settings-silver-card__bg" />
                <div className="settings-silver-card__overlay" />

                <div className="settings-silver-card__content p-6 md:p-7">
                  {sectionHeader(<Icons.Security />, "Identity & Security")}

                  {canSeeWorkspaceSecurity ? (
                    <div className="grid gap-4">
                      <p className="m-0 text-[13px] text-[#5d6d71]">
                        Workspace identity operations: MFA policy, trusted
                        devices, session revocations, and MFA recovery
                        approvals. Operator/admin access required.
                      </p>

                      <Link href="/security-center" data-cc-security-link-card>
                        <Button
                          variant="secondary"
                          className={`${velvetButtonClass()} settings-primary-btn`}
                        >
                          Open Security Center
                        </Button>
                      </Link>
                    </div>
                  ) : (
                    /* Phase IA-self-serve-simplification — self-serve
                       users see Account Security instead. The workspace
                       Security Center surface is ENTERPRISE_ONLY. */
                    <div className="grid gap-4">
                      <p className="m-0 text-[13px] text-[#5d6d71]">
                        Personal account controls: password, sessions,
                        and identity events tied to your account.
                      </p>
                      <Link href="/settings/security">
                        <Button
                          variant="secondary"
                          className={`${velvetButtonClass()} settings-primary-btn`}
                        >
                          Open Account Security
                        </Button>
                      </Link>
                    </div>
                  )}
                </div>
              </Card>

              <Card
                className="settings-silver-card rounded-[30px] border bg-transparent p-0 shadow-none"
                style={cardShellStyle()}
              >
                <div className="settings-silver-card__bg" />
                <div className="settings-silver-card__overlay" />

                <div className="settings-silver-card__content p-6 md:p-7">
                  {sectionHeader(<Icons.Security />, "Legal")}

                  <div className="grid gap-4">
                    <div className="settings-legal-links">
                      {LEGAL_LINKS.map((link) => (
                        <Link
                          key={link.href}
                          href={link.href}
                          className="settings-legal-link text-[0.95rem]"
                        >
                          {link.label}
                        </Link>
                      ))}
                    </div>

                    <div className="mt-1 grid gap-3">
                      <Button
                        variant="primary"
                        onClick={() => openCookiePreferences()}
                        className={`${velvetButtonClass()} settings-primary-btn`}
                      >
                        Manage Cookie Preferences
                      </Button>

                      {latestCookieConsent ? (
                        <div className="text-[12px] text-[#6a777b]">
                          Cookie consent v{latestCookieConsent.consentVersion} — saved on{" "}
                          {formatUserDateTime(latestCookieConsent.createdAt)}
                        </div>
                      ) : null}

                      {legalAcceptances.length > 0 ? (
                        <div className="mt-1 grid gap-2">
                          {legalAcceptances.slice(0, 4).map((item) => (
                            <div key={item.id} className="text-[12px] text-[#6a777b]">
                              {item.policyKey} v{item.policyVersion} —{" "}
                              {formatUserDateTime(item.acceptedAt)}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}