/**
 * Locale-aware number formatting for the Operations surfaces (D10).
 *
 * Kept free of React and of the app providers so the row model and the
 * node-run tests can import it without a browser context.
 */
export function formatOpsNumber(value: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}
