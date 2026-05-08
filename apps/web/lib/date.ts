function parseDate(value?: string | null): Date | null {
  if (!value) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const USER_DATE_TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZoneName: "short",
};

const UTC_AUDIT_DATE_TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  timeZone: "UTC",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
};

export function formatUserDateTime(value?: string | null): string {
  const date = parseDate(value);
  if (!date) return "Not available";

  return new Intl.DateTimeFormat(undefined, USER_DATE_TIME_FORMAT_OPTIONS).format(date);
}

export function formatUtcAuditDateTime(value?: string | null): string {
  const date = parseDate(value);
  if (!date) return "Not available";

  return new Intl.DateTimeFormat("en-GB", UTC_AUDIT_DATE_TIME_FORMAT_OPTIONS).format(date);
}
