// apps/web/lib/currency.ts
export type SupportedCurrency = "USD" | "EUR";

const DEFAULT_USD_TO_EUR = 0.92;

// تقدر تضبطه من Vercel env: NEXT_PUBLIC_USD_TO_EUR="0.93"
function usdToEurRate(): number {
  const raw = (process.env.NEXT_PUBLIC_USD_TO_EUR ?? "").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_USD_TO_EUR;
}

function looksEuropeanLocale(locale: string): boolean {
  // EU/EEA + Switzerland + UK (اختياري)
  const EU_LIKE = new Set([
    "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE",
    "IS","LI","NO","CH","UK","GB"
  ]);

  // locale مثل: "de-DE" أو "fr" أو "en-GB"
  const m = locale.match(/-([A-Za-z]{2})$/);
  const cc = (m?.[1] ?? "").toUpperCase();
  return cc ? EU_LIKE.has(cc) : false;
}

export function isEuropeClient(): boolean {
  if (typeof window === "undefined") return false;

  // 1) timezone
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  if (tz.startsWith("Europe/")) return true;

  // 2) locale region
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some((l) => looksEuropeanLocale(l));
}

export function detectCurrency(): SupportedCurrency {
  return isEuropeClient() ? "EUR" : "USD";
}

export function convertUsd(amountUsd: number, currency: SupportedCurrency): number {
  if (currency === "EUR") return amountUsd * usdToEurRate();
  return amountUsd;
}

export function formatMoney(amount: number, currency: SupportedCurrency): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    // شهرياً عادة بدون كسور، لكن خليها 0-2 حسب القيمة
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
  }).format(amount);
}