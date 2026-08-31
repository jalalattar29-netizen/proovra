"use client";

/**
 * Preferences section (Settings IA refactor 2026-07-17).
 *
 * Former `/settings/preferences` page body, unchanged in behavior:
 *   - UI language (canonical PATCH /v1/users/me `locale`; partial
 *     translations are labeled, never presented as finished).
 *   - Account timezone — THE account-level timezone source of truth
 *     (`User.timezone`); digests/quiet hours inherit it unless a
 *     per-workspace notification-schedule override exists (precedence:
 *     override → account timezone → UTC). Evidence/custody/audit
 *     timestamps stay canonical UTC.
 * Save is change-gated with loading/success feedback.
 */

import { useEffect, useState } from "react";

import { supportedLocales, type Locale } from "@proovra/shared";
import { useToast } from "../../../../components/ui";
import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import { Button } from "../../../../components/ui/Button";
import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useAuth, useLocale } from "../../../providers";
import { usePlatformContext } from "../../../../lib/platform-context";
import {
  detectDeviceTimezone,
  timezoneOptions,
} from "../../../../lib/timezones";

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

const fieldLabel: React.CSSProperties = {
  margin: "0 0 6px",
  fontSize: 13,
  fontWeight: 700,
  color: "var(--ink-primary, #0f172a)",
};

const muted: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "var(--ink-secondary, #475569)",
};

export function PreferencesSection() {
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

  // §6.1 — Save is disabled until something actually changed; the busy
  // flag prevents duplicate submissions.
  const savedLocale = supportedLocales.includes(locale as Locale)
    ? (locale as Locale)
    : "en";
  const savedTimezone = user?.timezone ?? "";
  const dirty =
    selectedLocale !== savedLocale || timezone.trim() !== savedTimezone.trim();

  /**
   * "Use my current timezone" — read the device, then SAVE it.
   *
   * It used to call `setTimezone` and stop, so the box changed and nothing
   * else did: the account timezone was unchanged, the notification pane still
   * showed the old zone, and the value was lost entirely unless the person
   * also noticed the separate Save button. The button's name is a promise
   * about the account, so it writes to the account.
   *
   * Detection failure is REPORTED, never silently swapped for UTC — telling
   * somebody in Damascus that their device is in UTC is worse than telling
   * them the browser would not say.
   */
  const detectTimezone = async () => {
    const tz = detectDeviceTimezone();
    if (!tz) {
      setError("Could not detect your current timezone.");
      return;
    }
    setTimezone(tz);
    await save({ timezoneOverride: tz });
  };

  const save = async (opts?: { timezoneOverride?: string }) => {
    setError(null);
    setBusy(true);
    // The caller may hand us the value directly: React state set in the same
    // tick is not readable here, and "Use my current timezone" must save the
    // zone it just detected rather than the one that was there before.
    const nextTimezone = opts?.timezoneOverride ?? timezone;
    try {
      const res = (await apiFetch("/v1/users/me", {
        method: "PATCH",
        body: JSON.stringify({
          locale: selectedLocale,
          timezone: nextTimezone.trim() || null,
        }),
      })) as {
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
    <div style={{ display: "grid", gap: 18, maxWidth: 640 }} data-cc-preferences>
      <div data-cc-preferences-language>
        <h3 style={fieldLabel}>Language</h3>
        <p style={muted}>
          Languages marked &ldquo;partial translation&rdquo; fall back to
          English for untranslated text.
        </p>
        {/* The canonical listbox, not a native <select>. A native option list
            renders the OS popup: it cannot be styled, so Settings would show
            a browser-blue menu while the rest of the authenticated product
            shows the product's own. */}
        <div className="mt-2" data-cc-preferences-locale-select>
          <AppListbox
            value={selectedLocale}
            options={supportedLocales.map((lc) => ({
              value: lc,
              label: localeLabel(lc),
            }))}
            onChange={(next) => setSelectedLocale(next as Locale)}
            ariaLabel="UI language"
          />
        </div>
      </div>

      <div data-cc-preferences-timezone>
        {/*
          A SELECTOR, because "Syria" is a country and "Asia/Damascus" is a
          timezone.

          This was a free-text box asking for an IANA name. People typed the
          place they live, the field took it, and the server stored it — the
          account timezone had no validation at all, so an unusable value sat
          in the column that the digest scheduler inherits from. Both ends are
          fixed: the API now rejects a non-IANA name with the same validator
          the notification schedule has always used, and the control here can
          no longer produce one.
        */}
        <h3 style={fieldLabel} id="account-timezone-label">
          Account timezone
        </h3>
        <p style={muted}>
          Used for notification digests and quiet hours. Evidence and audit
          timestamps remain in UTC.
        </p>
        {timezone.trim() === "" ? (
          <p
            style={{ ...muted, marginTop: 6, fontWeight: 600 }}
            data-cc-preferences-tz-fallback
          >
            Not set — UTC is currently used as the fallback.
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div style={{ flex: 1, minWidth: 240, maxWidth: 380 }} data-cc-preferences-tz-select>
            <AppListbox
              value={timezone}
              options={timezoneOptions(timezone)}
              onChange={setTimezone}
              ariaLabelledby="account-timezone-label"
            />
          </div>
          <button
            type="button"
            className="app-secondary-action app-secondary-action--lg"
            onClick={() => void detectTimezone()}
            disabled={busy}
            data-cc-preferences-detect-tz
          >
            Use my current timezone
          </button>
        </div>
      </div>

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
          disabled={busy || !dirty}
          data-cc-preferences-save
        >
          Save preferences
        </Button>
      </div>
    </div>
  );
}
