/**
 * Capture Environment helpers — dependency-free (only node:crypto).
 *
 * Parses a raw User-Agent into a bounded, privacy-safe summary and
 * builds the CaptureEnvironment record. The raw UA and raw IP NEVER
 * leave this boundary: only a UA hash and a masked IP are emitted.
 *
 * The UA parser is intentionally small and dependency-free (no
 * ua-parser-js) — it covers the common desktop/mobile browsers and
 * degrades to nulls / UNKNOWN for anything it doesn't recognise. It
 * never throws.
 */

import { createHash } from "node:crypto";

import {
  TECHNICAL_METADATA_SCHEMA_VERSION,
  type CaptureEnvironment,
  type CaptureMethodLabel,
  type DeviceClass,
  type UploadSource,
} from "./types.js";

const STR_MAX = 64;

function bounded(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length === 0 ? null : t.slice(0, STR_MAX);
}

export type ParsedUserAgent = {
  browserName: string | null;
  browserVersion: string | null;
  osName: string | null;
  osVersion: string | null;
  deviceClass: DeviceClass;
  /** Rendering engine: "Blink" | "WebKit" | "Gecko" | null. */
  engine: string | null;
  /** Platform/arch: "Windows x64" | "Windows ARM" | "macOS" | "iOS" |
   *  "Android" | "Linux" | null. */
  platform: string | null;
};

/**
 * Best-effort, never-throwing User-Agent parser. Returns nulls and
 * UNKNOWN for anything unrecognised.
 */
export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent {
  const empty: ParsedUserAgent = {
    browserName: null,
    browserVersion: null,
    osName: null,
    osVersion: null,
    deviceClass: "UNKNOWN",
    engine: null,
    platform: null,
  };
  if (!ua || typeof ua !== "string") return empty;
  const s = ua.slice(0, 512);

  // ---- Browser (order matters: Edge/Opera/Samsung before Chrome,
  //      Chrome before Safari) ----
  let browserName: string | null = null;
  let browserVersion: string | null = null;
  const browserMatchers: Array<[string, RegExp]> = [
    ["Edge", /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ["Opera", /OPR\/([\d.]+)/],
    ["Opera", /Opera\/([\d.]+)/],
    ["Samsung Internet", /SamsungBrowser\/([\d.]+)/],
    ["Firefox", /Firefox\/([\d.]+)/],
    ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/],
    ["Safari", /Version\/([\d.]+).*Safari\//],
  ];
  for (const [name, re] of browserMatchers) {
    const m = s.match(re);
    if (m) {
      browserName = name;
      browserVersion = bounded(m[1] ?? null);
      break;
    }
  }

  // ---- OS ----
  let osName: string | null = null;
  let osVersion: string | null = null;
  if (/Windows NT/.test(s)) {
    osName = "Windows";
    const v = s.match(/Windows NT ([\d.]+)/);
    // The UA token freezes at "Windows NT 10.0" for BOTH Windows 10 and 11 —
    // the exact version cannot be proven from the UA, so we leave it
    // unversioned ("Windows") rather than fabricate "10/11". Older tokens
    // (8.1/8/7) are still distinguishable and kept.
    const map: Record<string, string | null> = {
      "10.0": null,
      "6.3": "8.1",
      "6.2": "8",
      "6.1": "7",
    };
    const token = v?.[1] ?? "";
    osVersion = token in map ? map[token] : (v?.[1] ?? null);
  } else if (/iPhone|iPad|iPod/.test(s)) {
    osName = "iOS";
    const v = s.match(/OS (\d+[_\d]*)/);
    osVersion = v ? (v[1] ?? "").replace(/_/g, ".") : null;
  } else if (/Mac OS X/.test(s)) {
    osName = "macOS";
    const v = s.match(/Mac OS X (\d+[_\d.]*)/);
    osVersion = v ? (v[1] ?? "").replace(/_/g, ".") : null;
  } else if (/Android/.test(s)) {
    osName = "Android";
    const v = s.match(/Android ([\d.]+)/);
    osVersion = v ? (v[1] ?? null) : null;
  } else if (/Linux/.test(s)) {
    osName = "Linux";
  }

  // ---- Device class ----
  let deviceClass: DeviceClass = "DESKTOP";
  if (/iPad|Tablet/.test(s) || (/Android/.test(s) && !/Mobile/.test(s))) {
    deviceClass = "TABLET";
  } else if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/.test(s)) {
    deviceClass = "MOBILE";
  } else if (/bot|crawler|spider|curl|wget|python-requests|node-fetch/i.test(s)) {
    deviceClass = "SERVER";
  }

  // ---- Engine ---- (iOS forces WebKit for every browser; Gecko =
  //      Firefox-family; everything Chromium-derived = Blink.)
  let engine: string | null = null;
  if (osName === "iOS" || /AppleWebKit/.test(s)) {
    if (/Gecko\/|Firefox\//.test(s) && !/like Gecko/.test(s)) engine = "Gecko";
    else if (browserName === "Firefox") engine = "Gecko";
    else if (
      browserName === "Safari" ||
      osName === "iOS" ||
      (browserName === null && /AppleWebKit/.test(s) && !/Chrome|Chromium|CriOS/.test(s))
    ) {
      engine = "WebKit";
    } else engine = "Blink";
  } else if (browserName === "Firefox") {
    engine = "Gecko";
  } else if (
    browserName === "Chrome" ||
    browserName === "Edge" ||
    browserName === "Opera" ||
    browserName === "Samsung Internet"
  ) {
    engine = "Blink";
  }

  // ---- Platform / architecture ----
  let platform: string | null = null;
  if (osName === "Windows") {
    platform = /Win64|x64|WOW64/.test(s)
      ? "Windows x64"
      : /ARM/.test(s)
        ? "Windows ARM"
        : "Windows";
  } else if (osName === "macOS") {
    platform = "macOS";
  } else if (osName === "iOS") {
    platform = "iOS";
  } else if (osName === "Android") {
    platform = "Android";
  } else if (osName === "Linux") {
    platform = "Linux";
  }

  return {
    browserName: bounded(browserName),
    browserVersion: bounded(browserVersion),
    osName: bounded(osName),
    osVersion: bounded(osVersion),
    deviceClass,
    engine,
    platform,
  };
}

/** SHA-256 of the raw UA, prefixed. Never returns the raw UA. */
export function hashUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  return "sha256:" + createHash("sha256").update(ua).digest("hex");
}

/**
 * Mask an IP for reportable output. IPv4 → keep first two octets
 * ("203.0.x.x"). IPv6 → keep first two hextets ("2001:db8:…"). Never
 * returns the full address. Returns null for empty/unparseable input.
 */
export function maskIp(ip: string | null | undefined): string | null {
  if (!ip || typeof ip !== "string") return null;
  const t = ip.trim();
  if (t.length === 0) return null;
  // Strip any IPv6-mapped IPv4 prefix.
  const v4mapped = t.replace(/^::ffff:/i, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4mapped)) {
    const parts = v4mapped.split(".");
    return `${parts[0]}.${parts[1]}.x.x`;
  }
  if (t.includes(":")) {
    const groups = t.split(":").filter((g) => g.length > 0);
    if (groups.length >= 2) return `${groups[0]}:${groups[1]}:…`;
    return "…";
  }
  return null;
}

export type BuildCaptureEnvironmentInput = {
  rawUserAgent?: string | null;
  rawIp?: string | null;
  timezone?: string | null;
  locale?: string | null;
  captureMethod?: CaptureMethodLabel | string | null;
  uploadSource?: UploadSource | string | null;
  attestationAttempted?: boolean | null;
  attestationResult?: string | null;
  // Privacy-safe network summary. Country/region come from the caller's
  // (existing) geo service — never derived from the raw IP here. Full IP /
  // ASN / ISP / VPN are NOT accepted.
  country?: string | null;
  region?: string | null;
  networkType?: string | null;
  ipSourceHeader?: string | null;
};

const CAPTURE_METHODS: ReadonlyArray<CaptureMethodLabel> = [
  "SECURE_CAPTURE",
  "UPLOAD",
  "INTAKE_LINK",
  "API",
  "MOBILE",
  "UNKNOWN",
];
const UPLOAD_SOURCES: ReadonlyArray<UploadSource> = [
  "WEB_APP",
  "MOBILE_APP",
  "INTAKE_LINK",
  "API",
  "UNKNOWN",
];

function coerceCaptureMethod(v: string | null | undefined): CaptureMethodLabel {
  if (!v) return "UNKNOWN";
  const up = v.toUpperCase();
  // Tolerate the existing Evidence.captureMethod enum vocabulary.
  if (up.includes("SECURE") || up.includes("CAPTURE")) return "SECURE_CAPTURE";
  if (up.includes("INTAKE")) return "INTAKE_LINK";
  if (up.includes("MOBILE")) return "MOBILE";
  if (up === "API") return "API";
  if (up.includes("UPLOAD")) return "UPLOAD";
  return (CAPTURE_METHODS.find((m) => m === up) ?? "UNKNOWN") as CaptureMethodLabel;
}

function coerceUploadSource(v: string | null | undefined): UploadSource {
  if (!v) return "UNKNOWN";
  const up = v.toUpperCase();
  return (UPLOAD_SOURCES.find((m) => m === up) ?? "UNKNOWN") as UploadSource;
}

/**
 * Build the privacy-safe CaptureEnvironment record. Pure, never throws.
 * Raw UA / raw IP are consumed here and never re-emitted.
 */
export function buildCaptureEnvironment(
  input: BuildCaptureEnvironmentInput,
): CaptureEnvironment {
  const ua = parseUserAgent(input.rawUserAgent ?? null);
  // IANA timezone sanity check — keep only plausible "Area/City" or "UTC".
  const tz = bounded(input.timezone ?? null);
  const timezone =
    tz && (/^[A-Za-z]+\/[A-Za-z0-9_\-+/]+$/.test(tz) || tz === "UTC") ? tz : tz;
  const locale = bounded(input.locale ?? null);
  return {
    schemaVersion: TECHNICAL_METADATA_SCHEMA_VERSION,
    captureMethod: coerceCaptureMethod(
      (input.captureMethod as string | null) ?? null,
    ),
    uploadSource: coerceUploadSource(
      (input.uploadSource as string | null) ?? null,
    ),
    browserName: ua.browserName,
    browserVersion: ua.browserVersion,
    osName: ua.osName,
    osVersion: ua.osVersion,
    deviceClass: ua.deviceClass,
    engine: ua.engine,
    platform: ua.platform,
    timezone,
    locale,
    userAgentHash: hashUserAgent(input.rawUserAgent ?? null),
    ipAddressMasked: maskIp(input.rawIp ?? null),
    country: bounded(input.country ?? null),
    region: bounded(input.region ?? null),
    networkType: bounded(input.networkType ?? null) ?? "UNKNOWN",
    ipSourceHeader: bounded(input.ipSourceHeader ?? null),
    attestationAttempted: input.attestationAttempted === true,
    attestationResult: bounded(input.attestationResult ?? null),
  };
}
