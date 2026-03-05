// services/api/src/utils/logger.ts
const isProd = process.env.NODE_ENV === "production";

// Logs: ممنوعة في production
export function log(...args: unknown[]) {
  if (!isProd) console.log(...args);
}
export function warn(...args: unknown[]) {
  if (!isProd) console.warn(...args);
}

// Errors: مسموحة دائماً (بس لا تطبع tokens)
export function error(...args: unknown[]) {
  console.error(...args);
}