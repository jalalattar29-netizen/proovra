/**
 * Session presentation helpers (2026-07-17 Settings remediation).
 *
 * Pure, runtime-testable mapping from stored session previews to
 * user-facing copy:
 *
 *   - `describeUserAgent` — a raw UA preview never renders as primary
 *     content; it becomes "Chrome on Windows" / "Safari on iPhone" etc.
 *   - `presentLocation` — approximate location renders ONLY when a
 *     reliable ISO country code exists AND the observed address is not a
 *     private/container network (172.18.x.x is infrastructure, not the
 *     user's location). Unavailable → null; the UI says "Location
 *     unavailable" — never "??".
 *   - `isPrivateNetworkIp` — RFC1918/loopback/link-local detection on the
 *     masked preview.
 *
 * Raw UA + masked IP stay available behind the per-session
 * "Technical details" disclosure — presentation changes only.
 */

export function isPrivateNetworkIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const v = ip.trim();
  if (v.startsWith("10.") || v.startsWith("192.168.") || v.startsWith("127.")) {
    return true;
  }
  if (v.startsWith("169.254.")) return true; // link-local
  const m = v.match(/^172\.(\d{1,3})\./);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  // IPv6 loopback / unique-local.
  if (v === "::1" || v.toLowerCase().startsWith("fc") || v.toLowerCase().startsWith("fd")) {
    return true;
  }
  return false;
}

const BROWSERS: ReadonlyArray<{ re: RegExp; label: string }> = [
  // Order matters — Edge/Opera UAs also contain "Chrome"; Chrome contains
  // "Safari".
  { re: /Edg(?:e|A|iOS)?\//i, label: "Edge" },
  { re: /OPR\/|Opera/i, label: "Opera" },
  { re: /SamsungBrowser\//i, label: "Samsung Internet" },
  { re: /Firefox\/|FxiOS\//i, label: "Firefox" },
  { re: /CriOS\//i, label: "Chrome" },
  { re: /Chrome\//i, label: "Chrome" },
  { re: /Safari\//i, label: "Safari" },
];

const PLATFORMS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /iPhone/i, label: "iPhone" },
  { re: /iPad/i, label: "iPad" },
  { re: /Android/i, label: "Android" },
  { re: /Windows/i, label: "Windows" },
  { re: /Macintosh|Mac OS X/i, label: "macOS" },
  { re: /CrOS/i, label: "ChromeOS" },
  { re: /Linux/i, label: "Linux" },
];

/**
 * "Chrome on Windows" / "Safari on iPhone" / "Firefox on macOS".
 * Unknown or missing UA → "Unknown device". Never returns the raw UA.
 */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua || ua.trim().length === 0) return "Unknown device";
  const browser = BROWSERS.find((b) => b.re.test(ua))?.label ?? null;
  const platform = PLATFORMS.find((p) => p.re.test(ua))?.label ?? null;
  if (browser && platform) return `${browser} on ${platform}`;
  if (browser) return browser;
  if (platform) return `Browser on ${platform}`;
  return "Unknown device";
}

/**
 * Human country name from a 2-letter ISO code, or null when no RELIABLE
 * location exists (missing/placeholder code, or the observed address is
 * a private/container network so any derived geo is meaningless).
 */
export function presentLocation(
  countryCode: string | null | undefined,
  ipPreview: string | null | undefined,
): string | null {
  const code = (countryCode ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  if (isPrivateNetworkIp(ipPreview)) return null;
  try {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    const name = names.of(code);
    // Intl returns the input code for unknown regions — not a real name.
    if (!name || name === code) return null;
    return name;
  } catch {
    return null;
  }
}
