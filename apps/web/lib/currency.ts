// apps/web/lib/currency.ts
export type SupportedCurrency = "USD" | "EUR";

const DEFAULT_USD_TO_EUR = 0.92;

function usdToEurRate(): number {
  const raw = (process.env.NEXT_PUBLIC_USD_TO_EUR ?? "").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_USD_TO_EUR;
}

function isEuroCountryFromLocale(locale: string): boolean {
  const EURO_COUNTRIES = new Set([
    "AT",
    "BE",
    "CY",
    "DE",
    "EE",
    "ES",
    "FI",
    "FR",
    "GR",
    "HR",
    "IE",
    "IT",
    "LT",
    "LU",
    "LV",
    "MT",
    "NL",
    "PT",
    "SI",
    "SK",
  ]);

  const m = locale.match(/-([A-Za-z]{2})$/);
  const cc = (m?.[1] ?? "").toUpperCase();
  return cc ? EURO_COUNTRIES.has(cc) : false;
}

export function isEuropeClient(): boolean {
  if (typeof window === "undefined") return false;

  const langs = navigator.languages?.length
    ? navigator.languages
    : [navigator.language];

  return langs.some((l) => isEuroCountryFromLocale(l));
}

export function detectCurrency(): SupportedCurrency {
  return isEuropeClient() ? "EUR" : "USD";
}

export function convertUsd(
  amountUsd: number,
  currency: SupportedCurrency
): number {
  if (!Number.isFinite(amountUsd)) return 0;
  if (currency === "EUR") return amountUsd * usdToEurRate();
  return amountUsd;
}

export function normalizeCurrency(
  value: string | null | undefined
): SupportedCurrency {
  return String(value ?? "").trim().toUpperCase() === "EUR" ? "EUR" : "USD";
}

export function formatMoney(
  amount: number,
  currency: SupportedCurrency
): string {
  const safeAmount = Number.isFinite(amount) ? amount : 0;

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: safeAmount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: safeAmount % 1 === 0 ? 0 : 2,
  }).format(safeAmount);
}

export function formatMinorUnits(
  amountCents: number | null | undefined,
  currency: SupportedCurrency
): string {
  const cents = Number.isFinite(amountCents ?? NaN) ? Number(amountCents) : 0;
  return formatMoney(cents / 100, currency);
}