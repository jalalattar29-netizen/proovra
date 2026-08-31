"use client";

/**
 * The IANA timezone list, from the runtime.
 *
 * `Intl.supportedValuesOf("timeZone")` IS the browser's own copy of the IANA
 * database, so there is no list to ship, no dependency to add and nothing to
 * keep in step with the server — which validates the same names with
 * `isValidIanaTimezone` from `@proovra/shared`.
 *
 * This was already written inside `NotificationPreferencesPanel`. It is here
 * because Settings → Preferences now needs it too, and two copies of "what
 * counts as a timezone" is exactly how one surface starts accepting a value
 * the other refuses.
 */
export function supportedTimezones(): string[] {
  try {
    const intlWithValues = Intl as unknown as {
      supportedValuesOf?: (key: string) => string[];
    };
    const values = intlWithValues.supportedValuesOf?.("timeZone");
    if (Array.isArray(values) && values.length > 0) return values;
  } catch {
    /* older runtimes */
  }
  return ["UTC"];
}

/**
 * The device's current timezone, or null when the runtime will not say.
 *
 * Null is a real answer and callers must show it as one: silently falling
 * back to UTC would tell someone in Damascus that their device is in UTC.
 */
export function detectDeviceTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz.trim().length > 0 ? tz.trim() : null;
  } catch {
    return null;
  }
}

/**
 * "Damascus — Asia/Damascus".
 *
 * The city is what a person recognises; the identifier is what gets stored.
 * Showing only `Asia/Damascus` makes the list read as machine configuration,
 * and showing only `Damascus` would hide the value the account actually
 * holds — so the option carries both and the VALUE is always the canonical
 * IANA name.
 */
export function timezoneLabel(tz: string): string {
  const city = tz.split("/").pop()?.replace(/_/g, " ").trim();
  return city && city !== tz ? `${city} — ${tz}` : tz;
}

/**
 * Options for a timezone selector, with `current` guaranteed present.
 *
 * An account may already hold a zone this runtime does not enumerate (an
 * older browser, or a name the platform has since renamed). Dropping it
 * would make the control show something the account is not set to, and the
 * first save would silently rewrite it.
 */
export function timezoneOptions(
  current: string | null | undefined,
): Array<{ value: string; label: string }> {
  const zones = supportedTimezones();
  const held = current?.trim();
  const options = zones.map((tz) => ({ value: tz, label: timezoneLabel(tz) }));
  if (held && !zones.includes(held)) {
    options.unshift({ value: held, label: timezoneLabel(held) });
  }
  return options;
}
