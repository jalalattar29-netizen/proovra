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

function settingsCardStyle() {
  return {
    border: "1px solid rgba(158,216,207,0.16)",
    boxShadow:
      "0 18px 34px rgba(0, 0, 0, 0.10), inset 0 1px 0 rgba(255,255,255,0.06)",
  } as const;
}

function settingsButtonClass() {
  return "rounded-[16px] border border-[rgba(158,216,207,0.16)] bg-[linear-gradient(180deg,rgba(255,255,255,0.045)_0%,rgba(255,255,255,0.02)_100%)] px-5 py-3 text-[0.92rem] font-medium text-[#edf2f1] shadow-none transition-all duration-200 hover:-translate-y-[1px] hover:border-[rgba(158,216,207,0.26)] hover:bg-[linear-gradient(180deg,rgba(191,232,223,0.12)_0%,rgba(255,255,255,0.03)_100%)]";
}

function sectionHeader(icon: React.ReactNode, title: string) {
  return (
    <div
      className="mb-5 flex items-center gap-3 text-[1rem] font-semibold tracking-[-0.02em]"
      style={{ color: "rgba(246,252,255,0.96)" }}
    >
      <span className="text-[#bfe8df]">{icon}</span>
      <span>{title}</span>
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
    <div className="page landing-page">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0">
          <img
            src="/images/site-velvet-bg.webp.png"
            alt=""
            className="h-full w-full object-cover object-center"
          />
        </div>

        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,18,22,0.84)_0%,rgba(8,18,22,0.76)_34%,rgba(8,18,22,0.68)_62%,rgba(8,18,22,0.74)_100%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_16%,rgba(158,216,207,0.09),transparent_24%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_24%,rgba(214,184,157,0.06),transparent_18%)]" />
        <div className="absolute inset-0 opacity-[0.04] [background:repeating-linear-gradient(0deg,rgba(255,255,255,0.026)_0px,rgba(255,255,255,0.026)_1px,transparent_1px,transparent_4px)]" />

        <div className="relative z-10">
          <section className="mx-auto max-w-7xl px-6 pb-10 pt-10 md:px-8 md:pb-12 md:pt-14">
            <div className="max-w-[760px]">
              <div className="inline-flex rounded-full border border-white/10 bg-white/[0.055] px-4 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#dce3e0] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md">
                {t("settings")}
              </div>

              <h1 className="mt-5 max-w-[720px] text-[1.62rem] font-medium leading-[1.01] tracking-[-0.04em] text-[#edf1ef] md:text-[2.18rem] lg:text-[2.7rem]">
                Manage your{" "}
                <span className="text-[#bfe8df]">account preferences</span>.
              </h1>

              <p className="mt-5 max-w-[700px] text-[0.94rem] font-normal leading-[1.78] tracking-[-0.006em] text-[#c7cfcc] md:text-[0.98rem]">
                Update your <span className="text-[#e7ece9]">profile</span>, review{" "}
                <span className="text-[#bfe8df]">security and legal settings</span>, and manage
                your <span className="text-[#d6b89d]">subscription preferences</span> from one
                place.
              </p>

              <div className="mt-6 flex flex-wrap gap-2.5">
                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#9dd2ca]">✓</span>
                  Profile and identity controls
                </div>

                <div className="rounded-full border border-white/10 bg-white/[0.055] px-3.5 py-2 text-[0.78rem] font-normal text-[#d7dfdb] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#9dd2ca]">✓</span>
                  Language and security options
                </div>

                <div className="rounded-full border border-[rgba(214,184,157,0.24)] bg-[linear-gradient(180deg,rgba(183,157,132,0.08)_0%,rgba(255,255,255,0.03)_100%)] px-3.5 py-2 text-[0.78rem] font-normal text-[#e1d4c7] shadow-[0_8px_18px_rgba(0,0,0,0.08)] backdrop-blur-md">
                  <span className="mr-2 text-[#d6b89d]">✓</span>
                  Legal and billing visibility
                </div>
              </div>
            </div>
          </section>

          <section className="relative px-6 pb-14 md:px-8 md:pb-16">
            <div className="mx-auto max-w-7xl grid gap-5">
              <Card className="relative overflow-hidden rounded-[28px] border bg-transparent p-0 shadow-none" style={settingsCardStyle()}>
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(3,18,44,0.88)_0%,rgba(2,16,40,0.90)_100%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(158,216,207,0.06),transparent_28%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_84%_16%,rgba(214,184,157,0.05),transparent_22%)]" />

                <div className="relative z-10 p-5 md:p-6">
                  {sectionHeader(<Icons.Dashboard />, "Profile")}

                  <div style={{ marginBottom: 18, display: "flex", alignItems: "center", gap: 14 }}>
                    <div
                      className="flex h-14 w-14 items-center justify-center rounded-full"
                      style={{
                        background:
                          "linear-gradient(180deg, rgba(191,232,223,0.18) 0%, rgba(255,255,255,0.06) 100%)",
                        border: "1px solid rgba(158,216,207,0.16)",
                        color: "#edf2f1",
                        fontWeight: 800,
                        fontSize: 20,
                      }}
                    >
                      {initials}
                    </div>

                    <div>
                      <div style={{ fontSize: 12, color: "rgba(219,235,248,0.58)" }}>Account</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: "rgba(246,252,255,0.96)" }}>
                        {user?.displayName || user?.email || "Guest User"}
                      </div>
                      {user?.email && (
                        <div style={{ fontSize: 13, color: "rgba(219,235,248,0.72)" }}>
                          {user.email}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="grid gap-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <div style={{ marginBottom: 8, fontSize: 13, color: "rgba(219,235,248,0.72)" }}>
                          First name
                        </div>
                        <Input value={firstName} onChange={setFirstName} placeholder="First name" maxLength={80} />
                      </div>
                      <div>
                        <div style={{ marginBottom: 8, fontSize: 13, color: "rgba(219,235,248,0.72)" }}>
                          Last name
                        </div>
                        <Input value={lastName} onChange={setLastName} placeholder="Last name" maxLength={80} />
                      </div>
                    </div>

                    <div>
                      <div style={{ marginBottom: 8, fontSize: 13, color: "rgba(219,235,248,0.72)" }}>
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
                        <div style={{ marginBottom: 8, fontSize: 13, color: "rgba(219,235,248,0.72)" }}>
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
                        <div style={{ marginBottom: 8, fontSize: 13, color: "rgba(219,235,248,0.72)" }}>
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
                      <div style={{ marginBottom: 8, fontSize: 13, color: "rgba(219,235,248,0.72)" }}>
                        Bio
                      </div>
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

                  <div style={{ marginTop: 18, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <Button variant="secondary" onClick={handleSaveProfile} className={settingsButtonClass()}>
                      Save profile
                    </Button>
                    <Button variant="secondary" onClick={handleSignOut} className={settingsButtonClass()}>
                      Sign out
                    </Button>
                  </div>
                </div>
              </Card>

              <div className="grid gap-5 lg:grid-cols-2">
                <Card className="relative overflow-hidden rounded-[28px] border bg-transparent p-0 shadow-none" style={settingsCardStyle()}>
                  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(3,18,44,0.88)_0%,rgba(2,16,40,0.90)_100%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(158,216,207,0.06),transparent_28%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_84%_16%,rgba(214,184,157,0.05),transparent_22%)]" />

                  <div className="relative z-10 p-5 md:p-6">
                    {sectionHeader(<Icons.Security />, "Security")}

                    <div className="grid gap-4">
                      <div className="flex items-center justify-between gap-4 border-b border-white/6 pb-3">
                        <span style={{ color: "rgba(219,235,248,0.72)" }}>Login method</span>
                        <span style={{ color: "rgba(246,252,255,0.96)" }}>{user?.provider ?? "—"}</span>
                      </div>

                      <div className="flex items-center justify-between gap-4 border-b border-white/6 pb-3">
                        <span style={{ color: "rgba(219,235,248,0.72)" }}>Session</span>
                        <span style={{ color: "#bfe8df", fontWeight: 700 }}>Active</span>
                      </div>

                      <Link href="/legal/security" className="text-[0.95rem] text-[#dce7e4] transition-colors hover:text-[#bfe8df]">
                        Security policy
                      </Link>
                      <a href="mailto:security@proovra.com" className="text-[0.95rem] text-[#dce7e4] transition-colors hover:text-[#bfe8df]">
                        security@proovra.com
                      </a>
                    </div>
                  </div>
                </Card>

                <Card className="relative overflow-hidden rounded-[28px] border bg-transparent p-0 shadow-none" style={settingsCardStyle()}>
                  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(3,18,44,0.88)_0%,rgba(2,16,40,0.90)_100%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(158,216,207,0.06),transparent_28%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_84%_16%,rgba(214,184,157,0.05),transparent_22%)]" />

                  <div className="relative z-10 p-5 md:p-6">
                    {sectionHeader(<Icons.Settings />, t("language"))}

                    <div className="grid gap-4">
                      <div className="flex flex-col gap-3">
                        <span style={{ color: "rgba(219,235,248,0.72)" }}>UI language</span>
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

                      <p style={{ margin: 0, fontSize: 13, color: "rgba(219,235,248,0.58)" }}>
                        Language preference will be used for future UI updates.
                      </p>
                    </div>
                  </div>
                </Card>

                <Card className="relative overflow-hidden rounded-[28px] border bg-transparent p-0 shadow-none" style={settingsCardStyle()}>
                  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(3,18,44,0.88)_0%,rgba(2,16,40,0.90)_100%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(158,216,207,0.06),transparent_28%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_84%_16%,rgba(214,184,157,0.05),transparent_22%)]" />

                  <div className="relative z-10 p-5 md:p-6">
                    {sectionHeader(<Icons.Billing />, "Subscription")}

                    <div className="grid gap-4">
                      <div className="flex items-center justify-between gap-4 border-b border-white/6 pb-3">
                        <span style={{ color: "rgba(219,235,248,0.72)" }}>Current plan</span>
                        <span style={{ color: "#e6c9ae", fontWeight: 700 }}>{plan}</span>
                      </div>

                      <div>
                        <Link href="/billing">
                          <Button variant="secondary" className={settingsButtonClass()}>
                            Go to Billing
                          </Button>
                        </Link>
                      </div>
                    </div>
                  </div>
                </Card>

                <Card className="relative overflow-hidden rounded-[28px] border bg-transparent p-0 shadow-none" style={settingsCardStyle()}>
                  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(3,18,44,0.88)_0%,rgba(2,16,40,0.90)_100%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(158,216,207,0.06),transparent_28%)]" />
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_84%_16%,rgba(214,184,157,0.05),transparent_22%)]" />

                  <div className="relative z-10 p-5 md:p-6">
                    {sectionHeader(<Icons.Security />, "Legal")}

                    <div className="grid gap-4">
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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

                      <div style={{ display: "grid", gap: 10, marginTop: 6 }}>
                        <Button variant="secondary" onClick={() => openCookiePreferences()} className={settingsButtonClass()}>
                          Manage Cookie Preferences
                        </Button>

                        {latestCookieConsent ? (
                          <div style={{ fontSize: 12, color: "rgba(219,235,248,0.72)" }}>
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
                                  color: "rgba(219,235,248,0.72)",
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
                  </div>
                </Card>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}