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

function cardShellStyle() {
  return {
    border: "1px solid rgba(183,157,132,0.18)",
    boxShadow:
      "0 22px 42px rgba(0, 0, 0, 0.16), inset 0 1px 0 rgba(255,255,255,0.03)",
  } as const;
}

function velvetButtonClass(primary = false) {
  if (primary) {
    return "rounded-[999px] border px-5 py-3 text-[0.94rem] font-semibold transition-all duration-200 hover:-translate-y-[1px] hover:brightness-[1.03]";
  }

  return "rounded-[999px] border px-5 py-3 text-[0.94rem] font-semibold transition-all duration-200 hover:-translate-y-[1px] hover:brightness-[1.03]";
}

function sectionHeader(icon: React.ReactNode, title: string) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <span className="flex h-10 w-10 items-center justify-center rounded-full border border-[rgba(183,157,132,0.18)] bg-[linear-gradient(180deg,rgba(183,157,132,0.08)_0%,rgba(255,255,255,0.03)_100%)] text-[#d6b89d] shadow-[0_10px_22px_rgba(0,0,0,0.10)]">
        {icon}
      </span>
      <div className="text-[1.08rem] font-semibold tracking-[-0.03em] text-[#d8e0dd]">
        {title}
      </div>
    </div>
  );
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
    <div className="section app-section settings-page-shell">
      <style jsx global>{`
        .settings-page-shell .settings-velvet-card {
          position: relative;
          overflow: hidden;
        }

        .settings-page-shell .settings-velvet-card__bg {
          position: absolute;
          inset: 0;
          background-image: url("/images/site-velvet-bg.webp.png");
          background-size: cover;
          background-position: center;
          transform: scale(1.12);
        }

        .settings-page-shell .settings-velvet-card__overlay {
          position: absolute;
          inset: 0;
          background:
            radial-gradient(circle at 18% 14%, rgba(158, 216, 207, 0.05), transparent 28%),
            radial-gradient(circle at 86% 18%, rgba(214, 184, 157, 0.04), transparent 24%),
            linear-gradient(180deg, rgba(8, 20, 24, 0.82) 0%, rgba(7, 18, 22, 0.88) 100%);
        }

        .settings-page-shell .settings-velvet-card__content {
          position: relative;
          z-index: 1;
        }

        .settings-page-shell input,
        .settings-page-shell textarea,
        .settings-page-shell select {
          background: linear-gradient(
            180deg,
            rgba(20, 39, 42, 0.92) 0%,
            rgba(13, 27, 30, 0.96) 100%
          ) !important;
          border: 1px solid rgba(183, 157, 132, 0.18) !important;
          color: #d8e0dd !important;
          border-radius: 18px !important;
          box-shadow: 0 10px 22px rgba(0, 0, 0, 0.12) !important;
        }

        .settings-page-shell input::placeholder,
        .settings-page-shell textarea::placeholder {
          color: rgba(194, 204, 201, 0.52) !important;
        }

        .settings-page-shell input:focus,
        .settings-page-shell textarea:focus,
        .settings-page-shell select:focus {
          border-color: rgba(183, 157, 132, 0.28) !important;
          box-shadow:
            0 0 0 3px rgba(183, 157, 132, 0.08),
            0 10px 22px rgba(0, 0, 0, 0.12) !important;
        }

        .settings-page-shell .settings-primary-btn {
          border-color: rgba(158, 216, 207, 0.14) !important;
          background: linear-gradient(
            180deg,
            rgba(62, 98, 96, 0.26) 0%,
            rgba(14, 30, 34, 0.38) 100%
          ) !important;
          color: #aebbb6 !important;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.04),
            0 14px 28px rgba(0, 0, 0, 0.08) !important;
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
        }

        .settings-page-shell .settings-secondary-btn {
          border-color: rgba(79, 112, 107, 0.18) !important;
          background-image:
            linear-gradient(180deg, rgba(8, 20, 24, 0.78) 0%, rgba(7, 18, 22, 0.88) 100%),
            url("/images/site-velvet-bg.webp.png") !important;
          background-size: cover !important;
          background-position: center !important;
          color: #aebbb6 !important;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.03),
            0 14px 28px rgba(0, 0, 0, 0.10) !important;
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
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
                  gap: 8,
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
                    width: 4,
                    height: 4,
                    borderRadius: 999,
                    background: "#b79d84",
                    opacity: 0.8,
                    display: "inline-block",
                  }}
                />
                {t("settings")}
              </div>

              <h1
                className="mt-5 max-w-[720px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]"
                style={{ margin: "20px 0 0" }}
              >
                Manage your{" "}
                <span className="text-[#c3ebe2]">account preferences</span>.
              </h1>

              <p
                className="mt-5 max-w-[700px] text-[0.95rem] font-normal leading-[1.8] tracking-[-0.006em] text-[#aab5b2] md:text-[0.99rem]"
              >
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

      <div className="app-body app-body-full">
        <section className="relative px-6 pb-14 md:px-8 md:pb-16">
          <div className="mx-auto grid max-w-7xl gap-5">
            <Card
              className="settings-velvet-card rounded-[30px] border bg-transparent p-0 shadow-none"
              style={cardShellStyle()}
            >
              <div className="settings-velvet-card__bg" />
              <div className="settings-velvet-card__overlay" />

              <div className="settings-velvet-card__content p-6 md:p-7">
                {sectionHeader(<Icons.Dashboard />, "Profile")}

                <div className="mb-5 flex items-center gap-4">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full border border-[rgba(183,157,132,0.18)] bg-[linear-gradient(180deg,rgba(183,157,132,0.12)_0%,rgba(255,255,255,0.03)_100%)] text-[1.35rem] font-bold text-[#d8e0dd] shadow-[0_10px_22px_rgba(0,0,0,0.12)]">
                    {initials}
                  </div>

                  <div>
                    <div className="text-[12px] text-[rgba(194,204,201,0.58)]">Account</div>
                    <div className="text-[1.05rem] font-semibold tracking-[-0.02em] text-[#d8e0dd]">
                      {user?.displayName || user?.email || "Guest User"}
                    </div>
                    {user?.email ? (
                      <div className="text-[13px] text-[rgba(194,204,201,0.72)]">
                        {user.email}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="grid gap-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <div className="mb-2 text-[13px] text-[rgba(194,204,201,0.72)]">
                        First name
                      </div>
                      <Input
                        value={firstName}
                        onChange={setFirstName}
                        placeholder="First name"
                        maxLength={80}
                      />
                    </div>

                    <div>
                      <div className="mb-2 text-[13px] text-[rgba(194,204,201,0.72)]">
                        Last name
                      </div>
                      <Input
                        value={lastName}
                        onChange={setLastName}
                        placeholder="Last name"
                        maxLength={80}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 text-[13px] text-[rgba(194,204,201,0.72)]">
                      Display name
                    </div>
                    <Input
                      value={displayName}
                      onChange={setDisplayName}
                      placeholder="Public display name"
                      maxLength={120}
                    />
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <div className="mb-2 text-[13px] text-[rgba(194,204,201,0.72)]">
                        Country
                      </div>
                      <Input
                        value={country}
                        onChange={setCountry}
                        placeholder="e.g. Germany, Syria"
                        maxLength={120}
                      />
                    </div>

                    <div>
                      <div className="mb-2 text-[13px] text-[rgba(194,204,201,0.72)]">
                        Timezone
                      </div>
                      <Input
                        value={timezone}
                        onChange={setTimezone}
                        placeholder="e.g. Europe/Berlin"
                        maxLength={64}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 text-[13px] text-[rgba(194,204,201,0.72)]">Bio</div>
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
                    className={`${velvetButtonClass(true)} settings-primary-btn`}
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

            <div className="grid gap-5 lg:grid-cols-2">
              <Card
                className="settings-velvet-card rounded-[30px] border bg-transparent p-0 shadow-none"
                style={cardShellStyle()}
              >
                <div className="settings-velvet-card__bg" />
                <div className="settings-velvet-card__overlay" />

                <div className="settings-velvet-card__content p-6 md:p-7">
                  {sectionHeader(<Icons.Security />, "Security")}

                  <div className="grid gap-4">
                    <div className="flex items-center justify-between gap-4 border-b border-white/6 pb-3">
                      <span className="text-[rgba(194,204,201,0.72)]">Login method</span>
                      <span className="text-[#d8e0dd]">{user?.provider ?? "—"}</span>
                    </div>

                    <div className="flex items-center justify-between gap-4 border-b border-white/6 pb-3">
                      <span className="text-[rgba(194,204,201,0.72)]">Session</span>
                      <span className="font-semibold text-[#bfe8df]">Active</span>
                    </div>

                    <Link
                      href="/legal/security"
                      className="text-[0.95rem] text-[#dce7e4] transition-colors hover:text-[#bfe8df]"
                    >
                      Security policy
                    </Link>

                    <a
                      href="mailto:security@proovra.com"
                      className="text-[0.95rem] text-[#dce7e4] transition-colors hover:text-[#bfe8df]"
                    >
                      security@proovra.com
                    </a>
                  </div>
                </div>
              </Card>

              <Card
                className="settings-velvet-card rounded-[30px] border bg-transparent p-0 shadow-none"
                style={cardShellStyle()}
              >
                <div className="settings-velvet-card__bg" />
                <div className="settings-velvet-card__overlay" />

                <div className="settings-velvet-card__content p-6 md:p-7">
                  {sectionHeader(<Icons.Settings />, t("language"))}

                  <div className="grid gap-4">
                    <div className="flex flex-col gap-3">
                      <span className="text-[rgba(194,204,201,0.72)]">UI language</span>
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

                    <p className="m-0 text-[13px] text-[rgba(194,204,201,0.58)]">
                      Language preference will be used for future UI updates.
                    </p>
                  </div>
                </div>
              </Card>

              <Card
                className="settings-velvet-card rounded-[30px] border bg-transparent p-0 shadow-none"
                style={cardShellStyle()}
              >
                <div className="settings-velvet-card__bg" />
                <div className="settings-velvet-card__overlay" />

                <div className="settings-velvet-card__content p-6 md:p-7">
                  {sectionHeader(<Icons.Billing />, "Subscription")}

                  <div className="grid gap-4">
                    <div className="flex items-center justify-between gap-4 border-b border-white/6 pb-3">
                      <span className="text-[rgba(194,204,201,0.72)]">Current plan</span>
                      <span className="font-semibold text-[#d6b89d]">{plan}</span>
                    </div>

                    <div>
                      <Link href="/billing">
                        <Button
                          variant="secondary"
                          className={`${velvetButtonClass()} settings-secondary-btn`}
                        >
                          Go to Billing
                        </Button>
                      </Link>
                    </div>
                  </div>
                </div>
              </Card>

              <Card
                className="settings-velvet-card rounded-[30px] border bg-transparent p-0 shadow-none"
                style={cardShellStyle()}
              >
                <div className="settings-velvet-card__bg" />
                <div className="settings-velvet-card__overlay" />

                <div className="settings-velvet-card__content p-6 md:p-7">
                  {sectionHeader(<Icons.Security />, "Legal")}

                  <div className="grid gap-4">
                    <div className="flex flex-col gap-2">
                      {LEGAL_LINKS.map((link) => (
                        <Link
                          key={link.href}
                          href={link.href}
                          className="text-[0.95rem] text-[#dce7e4] transition-colors hover:text-[#bfe8df]"
                        >
                          {link.label}
                        </Link>
                      ))}
                    </div>

                    <div className="mt-1 grid gap-3">
                      <Button
                        variant="secondary"
                        onClick={() => openCookiePreferences()}
                        className={`${velvetButtonClass()} settings-secondary-btn`}
                      >
                        Manage Cookie Preferences
                      </Button>

                      {latestCookieConsent ? (
                        <div className="text-[12px] text-[rgba(194,204,201,0.72)]">
                          Cookie consent v{latestCookieConsent.consentVersion} — saved on{" "}
                          {new Date(latestCookieConsent.createdAt).toLocaleString()}
                        </div>
                      ) : null}

                      {legalAcceptances.length > 0 ? (
                        <div className="mt-1 grid gap-2">
                          {legalAcceptances.slice(0, 4).map((item) => (
                            <div
                              key={item.id}
                              className="text-[12px] text-[rgba(194,204,201,0.72)]"
                            >
                              {item.policyKey} v{item.policyVersion} —{" "}
                              {new Date(item.acceptedAt).toLocaleString()}
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