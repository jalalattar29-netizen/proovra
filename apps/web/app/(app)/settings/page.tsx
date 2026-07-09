"use client";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { supportedLocales, type Locale } from "@proovra/shared";
import { useToast, Input } from "../../../components/ui";
import { PageShell, PageHeader } from "../../../components/ui/PageShell";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
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

function sectionHeader(icon: React.ReactNode, title: string) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 40,
          height: 40,
          borderRadius: 12,
          background: "var(--surface-card, #ffffff)",
          border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
          color: "var(--ink-secondary, #475569)",
        }}
      >
        {icon}
      </span>
      <div
        style={{
          fontSize: 16,
          fontWeight: 650,
          letterSpacing: "-0.01em",
          color: "var(--ink-primary, #0f172a)",
        }}
      >
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
    <PageShell
      className="settings-page-shell"
      header={
        <PageHeader
          eyebrow={t("settings")}
          title="Manage your account preferences"
          subtitle="Update your profile, review security and legal settings, and manage your subscription preferences from one place."
          contextStrip={
            <>
              <Badge tone="info">Profile and identity controls</Badge>
              <Badge tone="neutral">Language and security options</Badge>
              <Badge tone="governance">Legal and billing visibility</Badge>
            </>
          }
        />
      }
    >
      <style jsx global>{`
        .settings-page-shell .settings-language-dropdown-wrap {
          position: relative;
          z-index: 30;
        }

        .settings-main-grid {
          display: grid;
          gap: 20px;
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

        .settings-page-shell input,
        .settings-page-shell textarea,
        .settings-page-shell .input {
          width: 100%;
          border-radius: 12px !important;
        }

        .settings-page-shell textarea {
          min-height: 120px;
        }

        .settings-page-shell .settings-select {
          width: 100%;
          min-height: 44px;
          padding: 0 44px 0 14px !important;
          appearance: none;
          -webkit-appearance: none;
          -moz-appearance: none;
          background: var(--surface-card, #ffffff);
          border: 1px solid var(--border-default, rgba(15, 23, 42, 0.09));
          border-radius: 12px;
          color: var(--ink-primary, #0f172a);
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 14px center;
          cursor: pointer;
        }

        .settings-page-shell .settings-legal-links {
          display: grid;
          gap: 10px;
        }

        .settings-page-shell .settings-legal-link,
        .settings-page-shell .settings-security-link {
          width: fit-content;
          color: var(--ink-secondary, #475569);
          font-weight: 500;
          text-decoration: none;
          transition: color 0.2s ease, transform 0.2s ease;
        }

        .settings-page-shell .settings-legal-link:hover,
        .settings-page-shell .settings-security-link:hover {
          color: var(--ink-primary, #0f172a);
          transform: translateY(-1px);
        }
      `}</style>

      <div className="settings-main-grid">
        <Card variant="admin" padding="comfortable">
          <div>
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
                  <Button variant="primary" onClick={handleSaveProfile}>
                    Save profile
                  </Button>

                  <Button variant="secondary" onClick={handleSignOut}>
                    Sign out
                  </Button>
                </div>
          </div>
        </Card>

        <div className="settings-cards-grid">
          <Card variant="admin" padding="comfortable">
            <div>
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

          <Card variant="admin" padding="comfortable" style={{ overflow: "visible" }}>
            <div>
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

          <Card variant="admin" padding="comfortable">
            <div>
                  {sectionHeader(<Icons.Billing />, "Subscription")}

                  <div className="grid gap-4">
                    <div className="flex items-center justify-between gap-4 border-b border-[rgba(79,112,107,0.08)] pb-3">
                      <span className="text-[#5d6d71]">Current plan</span>
                      <span className="font-semibold text-[#8a6e57]">{plan}</span>
                    </div>

                    <div>
                      <Link href="/billing">
                        <Button variant="secondary">Go to Billing</Button>
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
            variant="admin"
            padding="comfortable"
            data-cc-account-security-link-card
          >
            <div>
                  {sectionHeader(<Icons.Security />, "Account security")}

                  <div className="grid gap-4">
                    <p className="m-0 text-[13px] text-[#5d6d71]">
                      Change your password, review active sessions, sign
                      out of other devices, and view recent security
                      events.
                    </p>

                    <Link href="/settings/security">
                      <Button variant="secondary">Open Account security</Button>
                    </Link>
                  </div>
            </div>
          </Card>

              {/* Phase 1 (frontend consolidation) — de-duplicate the
                  account-security entry point. The workspace "Identity &
                  Security" card renders ONLY for enterprise workspaces (it
                  links to the Security Center). Self-serve users are already
                  covered by the "Account security" card above, so the prior
                  self-serve fallback here — which re-linked /settings/security
                  — was a duplicate entry point and is removed. The
                  `data-cc-security-link-card` marker and the `/security-center`
                  link are preserved (Phase Final-D5-PT2 contract). */}
          {canSeeWorkspaceSecurity ? (
            <Card
              variant="admin"
              padding="comfortable"
              data-cc-security-link-card
            >
              <div>
                    {sectionHeader(<Icons.Security />, "Identity & Security")}

                    <div className="grid gap-4">
                      <p className="m-0 text-[13px] text-[#5d6d71]">
                        Workspace identity operations: MFA policy, trusted
                        devices, session revocations, and MFA recovery
                        approvals. Operator/admin access required.
                      </p>

                      <Link href="/security-center" data-cc-security-link-card>
                        <Button variant="secondary">Open Security Center</Button>
                      </Link>
                    </div>
              </div>
            </Card>
          ) : null}

          <Card variant="admin" padding="comfortable">
            <div>
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
                        variant="secondary"
                        onClick={() => openCookiePreferences()}
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
    </PageShell>
  );
}