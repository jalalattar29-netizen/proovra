"use client";

/**
 * Preferences (2026-07-16 Settings IA remediation).
 *
 * Canonical home for account-level presentation preferences:
 *
 *   - UI language — persisted via the canonical PATCH /v1/users/me
 *     (`locale`). Locales with incomplete translations are LABELED as
 *     partial rather than presented as finished (only en/ar/de carry
 *     complete translations today; the rest fall back to English).
 *
 *   - Account timezone — THE single account-level timezone source of
 *     truth (`User.timezone`). Notification digests and quiet hours
 *     inherit it unless a per-workspace notification-schedule override
 *     exists (precedence: schedule override → account timezone → UTC;
 *     enforced in services/api digest-scheduler). Evidence, custody, and
 *     audit source timestamps remain canonical UTC — this preference
 *     affects recipient-local presentation only.
 */

import { useEffect, useState } from "react";

import { supportedLocales, type Locale } from "@proovra/shared";
import { useToast, Input } from "../../../../components/ui";
import { PageShell, PageHeader } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useAuth, useLocale } from "../../../providers";
import { usePlatformContext } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";

// Translation completeness (packages/shared/src/i18n.ts): en/ar/de carry
// real translations; the others are English-fallback stubs and are labeled
// as partial — we do not pretend stub translations are complete.
const COMPLETE_LOCALES: ReadonlySet<string> = new Set(["en", "ar", "de"]);

const LOCALE_NAMES: Record<string, string> = {
  en: "English",
  ar: "العربية",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  tr: "Türkçe",
  ru: "Русский",
};

function localeLabel(lc: string): string {
  const base = LOCALE_NAMES[lc] ?? lc.toUpperCase();
  return COMPLETE_LOCALES.has(lc) ? base : `${base} (partial translation)`;
}

export default function PreferencesPage() {
  return (
    <div data-testid="account-preferences-page">
      <PageRouteGate routeId="account.preferences">
        <PreferencesInner />
      </PageRouteGate>
    </div>
  );
}

function PreferencesInner() {
  const { locale, setLocale } = useLocale();
  const { user, updateUser } = useAuth();
  const platformCtx = usePlatformContext();
  const { addToast } = useToast();

  const [selectedLocale, setSelectedLocale] = useState<Locale>(
    supportedLocales.includes(locale as Locale) ? (locale as Locale) : "en",
  );
  const [timezone, setTimezone] = useState(user?.timezone ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTimezone(user?.timezone ?? "");
  }, [user?.timezone]);
  useEffect(() => {
    if (supportedLocales.includes(locale as Locale)) {
      setSelectedLocale(locale as Locale);
    }
  }, [locale]);

  const detectTimezone = () => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) setTimezone(tz);
    } catch {
      /* detection unavailable — manual entry stays */
    }
  };

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = (await apiFetch("/v1/users/me", {
        method: "PATCH",
        body: JSON.stringify({
          locale: selectedLocale,
          timezone: timezone.trim() || null,
        }),
      })) as {
        // The API returns the full user record; cast mirrors the
        // long-standing extraction on the old settings form.
        user?: { id: string; provider: string; locale?: string | null };
      };
      if (res.user && typeof res.user.id === "string") {
        updateUser(res.user);
        if (res.user.locale) setLocale(res.user.locale as Locale);
      } else {
        setLocale(selectedLocale);
      }
      try {
        await platformCtx.refresh();
      } catch {
        /* non-fatal — local update already applied */
      }
      addToast("Preferences saved", "success");
    } catch (err) {
      setError(
        toSafeUserError(err, {
          message: "Could not save preferences. Please try again.",
        }).message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Account"
          title="Preferences"
          subtitle="UI language and your account timezone. The account timezone is the default for notification digests and quiet hours; a workspace notification schedule can explicitly override it."
        />
      }
    >
      <div style={{ display: "grid", gap: 14, maxWidth: 640 }}>
        <Card variant="admin" padding="comfortable" data-cc-preferences-language>
          <h2
            style={{
              margin: "0 0 8px",
              fontSize: 14,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              color: "var(--ink-primary, #0f172a)",
            }}
          >
            Language
          </h2>
          <p className="m-0 text-[13px]" style={{ color: "var(--ink-secondary, #475569)" }}>
            Languages marked &ldquo;partial translation&rdquo; fall back to
            English for untranslated text.
          </p>
          <select
            aria-label="UI language"
            className="mt-3"
            value={selectedLocale}
            onChange={(e) => setSelectedLocale(e.target.value as Locale)}
            data-cc-preferences-locale-select
            style={{
              width: "100%",
              minHeight: 42,
              padding: "0 12px",
              borderRadius: 10,
              border: "1px solid var(--border-default, rgba(15,23,42,0.12))",
              background: "var(--surface-card, #ffffff)",
              color: "var(--ink-primary, #0f172a)",
              fontSize: 13,
            }}
          >
            {supportedLocales.map((lc) => (
              <option key={lc} value={lc}>
                {localeLabel(lc)}
              </option>
            ))}
          </select>
        </Card>

        <Card variant="admin" padding="comfortable" data-cc-preferences-timezone>
          <h2
            style={{
              margin: "0 0 8px",
              fontSize: 14,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              color: "var(--ink-primary, #0f172a)",
            }}
          >
            Account timezone
          </h2>
          <p className="m-0 text-[13px]" style={{ color: "var(--ink-secondary, #475569)" }}>
            IANA timezone (e.g. Europe/Berlin). Used as the default for
            notification digests and quiet hours. Evidence and audit record
            timestamps stay in canonical UTC.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div style={{ flex: 1, minWidth: 220 }}>
              <Input
                className="cases-form-input"
                value={timezone}
                onChange={setTimezone}
                placeholder="e.g. Europe/Berlin"
                maxLength={64}
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={detectTimezone}
              data-cc-preferences-detect-tz
            >
              Use my current timezone
            </Button>
          </div>
        </Card>

        {error ? (
          <div
            role="alert"
            className="rounded-lg border px-3 py-2 text-[12px]"
            style={{
              borderColor: "rgba(179,38,30,0.35)",
              background: "rgba(179,38,30,0.06)",
              color: "#8f1d16",
            }}
          >
            {error}
          </div>
        ) : null}

        <div>
          <Button
            variant="secondary"
            onClick={() => void save()}
            loading={busy}
            disabled={busy}
            data-cc-preferences-save
          >
            Save preferences
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
