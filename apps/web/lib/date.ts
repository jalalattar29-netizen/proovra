function parseDate(value?: string | Date | null): Date | null {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const USER_DATE_TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
};

const UTC_AUDIT_DATE_TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
};

export function formatUserDateTime(value?: string | Date | null): string {
  const date = parseDate(value);
  if (!date) return "Not available";

  try {
    return new Intl.DateTimeFormat(
      undefined,
      USER_DATE_TIME_FORMAT_OPTIONS
    ).format(date);
  } catch {
    return date.toLocaleString();
  }
}

export function formatUtcAuditDateTime(value?: string | Date | null): string {
  const date = parseDate(value);
  if (!date) return "Not available";

  try {
    return new Intl.DateTimeFormat(
      "en-GB",
      UTC_AUDIT_DATE_TIME_FORMAT_OPTIONS
    ).format(date);
  } catch {
    return date.toISOString();
  }
}