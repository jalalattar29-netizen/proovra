/**
 * A USER-AGENT STRING IS NOT A DEVICE.
 *
 * =============================================================================
 * WHAT WENT WRONG
 * =============================================================================
 * `/admin/identity/sessions` renders one row per live session, and its Device
 * column printed `uaPreview` — which is the raw user-agent truncated to 120
 * characters:
 *
 *     Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML,
 *     like Gecko) Claude/1.…
 *
 * In a 207px column that wraps to five or six lines, and every other cell in
 * the row stretches to match. Measured: 205px per row, 75 rows, a 15,409px
 * table — and four further sections of the page pushed past 16,000px, where
 * nobody will ever scroll to find them.
 *
 * The same page's own description says:
 *
 *     "Device and network previews are shown; raw addresses, user-agent
 *      strings and session tokens are never stored or rendered."
 *
 * The second half of that sentence was false. This makes it true.
 *
 * =============================================================================
 * WHY HERE AND NOT IN THE API
 * =============================================================================
 * `uaPreview` is written at session creation and stored. Changing what gets
 * stored needs a migration and a backfill, and would not improve a single
 * session that already exists. Deriving the descriptor at render time fixes
 * every row immediately, including historical ones, and leaves the stored
 * value untouched for anyone who needs it.
 *
 * The full stored preview stays reachable — the caller puts it in `title` —
 * because an operator chasing an anomalous session sometimes needs the exact
 * string, and hiding it entirely would trade one honesty problem for another.
 *
 * =============================================================================
 * WHAT IT DELIBERATELY DOES NOT DO
 * =============================================================================
 * No UA-parsing library, no version numbers, no device fingerprinting. The
 * question an operator asks of this column is "is that plausibly me, or
 * plausibly not" — browser family and platform answer it. A version string
 * adds width and answers nothing.
 *
 * Unrecognised input returns `null` rather than a guess. The caller renders
 * "Unrecognised client", which is honest; inventing "Other browser" is not.
 */

/** Ordered: the first match wins, so more specific tokens come first. */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  // Edge and Opera both carry "Chrome" in their UA, so they must precede it.
  [/\bEdg(?:e|A|iOS)?\//i, "Edge"],
  [/\bOPR\/|\bOpera\//i, "Opera"],
  [/\bSamsungBrowser\//i, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//i, "Firefox"],
  [/\bChrome\/|\bCriOS\//i, "Chrome"],
  // Safari last: every WebKit browser claims it.
  [/\bSafari\//i, "Safari"],
  [/\bcurl\//i, "curl"],
  [/\bPostmanRuntime\//i, "Postman"],
  [/\bnode(?:-fetch)?\//i, "Node"],
  [/\bpython-requests\//i, "Python"],
  [/\bPlaywright\b|\bHeadlessChrome\//i, "Headless browser"],
];

const PLATFORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\biPhone\b/i, "iPhone"],
  [/\biPad\b/i, "iPad"],
  [/\bAndroid\b/i, "Android"],
  [/\bWindows NT\b/i, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/i, "macOS"],
  [/\bCrOS\b/i, "ChromeOS"],
  [/\bLinux\b/i, "Linux"],
];

const first = (
  table: ReadonlyArray<readonly [RegExp, string]>,
  ua: string,
): string | null => table.find(([re]) => re.test(ua))?.[1] ?? null;

/**
 * A short, human descriptor for a stored user-agent preview.
 *
 * Returns `null` when nothing is recognisable, so the caller decides the
 * wording for "we do not know".
 *
 * @example describeClient("Mozilla/5.0 (Windows NT 10.0…) Chrome/120…")
 *          // → "Chrome on Windows"
 */
export function describeClient(ua: string | null | undefined): string | null {
  if (typeof ua !== "string") return null;
  const trimmed = ua.trim();
  if (trimmed.length === 0) return null;

  const browser = first(BROWSERS, trimmed);
  const platform = first(PLATFORMS, trimmed);

  if (browser && platform) return `${browser} on ${platform}`;
  if (browser) return browser;
  if (platform) return platform;
  return null;
}
