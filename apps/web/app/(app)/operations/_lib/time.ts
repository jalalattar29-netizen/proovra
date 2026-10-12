/**
 * Relative time and elapsed spans for the Operations surfaces, in the
 * reader's language (D10).
 *
 * The thresholds are the same ones `lib/relative-time` uses (minutes under an
 * hour, hours under a day, days under thirty, then a date), so English output
 * is unchanged ("2h ago", "15h 2m"); the WORDS now come from
 * `Intl.RelativeTimeFormat` / `Intl.NumberFormat` for the active locale and
 * from the shared Operations dictionary. Absolute timestamps still go through
 * the project's canonical formatter (`formatUserDate`), never `toLocale*`.
 */
import { operationsDict, type OperationsCopy } from "@proovra/shared/i18n";

import { formatUserDate } from "../../../../lib/date";

function relativeFormatter(locale: string): Intl.RelativeTimeFormat | null {
  try {
    return new Intl.RelativeTimeFormat(locale, { style: "narrow", numeric: "always" });
  } catch {
    return null;
  }
}

function unit(locale: string, u: "minute" | "hour" | "day", value: number): string {
  try {
    return new Intl.NumberFormat(locale, { style: "unit", unit: u, unitDisplay: "narrow" }).format(value);
  } catch {
    return `${value}${u[0]}`;
  }
}

/** "2h ago" / "vor 2 Std." / "قبل ساعتين" — or a date beyond thirty days. */
export function opsRelativeTime(
  iso: string | null | undefined,
  locale = "en",
  copy: OperationsCopy = operationsDict.en,
  now: number = Date.now(),
): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const past = t <= now;
  const minutes = Math.floor(Math.abs(now - t) / 60_000);
  if (minutes < 1) return past ? copy.time.justNow : copy.time.inUnderAMinute;
  const rtf = relativeFormatter(locale);
  const say = (value: number, u: "minute" | "hour" | "day") =>
    rtf ? rtf.format(past ? -value : value, u) : `${value}${u[0]}`;
  if (minutes < 60) return say(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return say(hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 30) return say(days, "day");
  return formatUserDate(iso);
}

/** An elapsed span: "15h 2m" / "15 Std. 2 Min." — never a raw minute count. */
export function opsDuration(
  seconds: number | null | undefined,
  locale = "en",
  copy: OperationsCopy = operationsDict.en,
): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.floor(seconds);
  if (total < 60) return copy.time.underAMinute;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return unit(locale, "minute", minutes);
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) {
    return restMinutes === 0
      ? unit(locale, "hour", hours)
      : `${unit(locale, "hour", hours)} ${unit(locale, "minute", restMinutes)}`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0
    ? unit(locale, "day", days)
    : `${unit(locale, "day", days)} ${unit(locale, "hour", restHours)}`;
}
