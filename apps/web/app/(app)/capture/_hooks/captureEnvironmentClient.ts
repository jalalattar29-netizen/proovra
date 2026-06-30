/**
 * Client capture-environment hints — silent, privacy-safe browser context
 * sent alongside evidence creation. Guarded so an environment without
 * Intl / navigator (SSR, exotic runtimes) never breaks capture. The
 * server reduces these to the stored capture environment (raw IP / UA are
 * derived + masked/hashed server-side; the client only contributes the
 * timezone + language tag).
 */
export function getClientCaptureEnvironment(): {
  captureTimezone: string | undefined;
  captureLocale: string | undefined;
} {
  let captureTimezone: string | undefined;
  try {
    captureTimezone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    captureTimezone = undefined;
  }
  const captureLocale =
    typeof navigator !== "undefined" && navigator.language
      ? navigator.language
      : undefined;
  return { captureTimezone, captureLocale };
}
