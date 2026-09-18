/**
 * UC — Canonical CAPTURE CAPABILITY authority (F7).
 *
 * THE ONE ANSWER to "which capture channels can this PLATFORM/DEVICE product-wise
 * offer, and in what truthful availability state?".
 *
 * This authority answers a PRODUCT/PLATFORM question only. It deliberately does
 * NOT decide:
 *   - AUTHORIZATION  ("may THIS user/workspace create Evidence?") — that is the
 *     server's `authorizeOrFail(evidence.create)` + personal-space authority.
 *   - COMMERCIAL ELIGIBILITY ("does the plan/quota allow another Evidence?") —
 *     that is the canonical evidence-creation / billing authority. Capture is
 *     plan-blind; it never invents a capture-specific plan.
 *   - DISTRIBUTION FACT ("is the extension actually published?") beyond the
 *     resolved `ExtensionDistribution` the caller passes in.
 *
 * A platform can SUPPORT a capability while the user is UNAUTHORIZED or
 * QUOTA_BLOCKED. Those are separate dimensions and must be composed by the
 * caller, never conflated here.
 *
 * Pure and isomorphic: no DOM, no `navigator`, no `process.env`, no I/O. The web
 * layer reads `navigator`/Client-Hints and `NEXT_PUBLIC_*` env, converts them to
 * the plain inputs below, and calls in. The native app passes its platform and
 * native-module probe results. This keeps ONE capability decision shared by web
 * and mobile instead of scattered inline `Platform.OS` checks.
 */

/** The runtime surface a capture UI is rendering on. */
export const CAPTURE_PLATFORMS = [
  /** Desktop web browser (the only surface where the browser extension can run). */
  "WEB_DESKTOP",
  /** Mobile web browser (a phone/tablet browser — NOT the native app). */
  "WEB_MOBILE",
  /** The PROOVRA native Android app (Expo/React Native). */
  "ANDROID_NATIVE",
  /** The PROOVRA native iOS app (UC-5, not yet implemented). */
  "IOS_NATIVE",
  /** Platform could not be determined (e.g. server render before hydration). */
  "UNKNOWN",
] as const;
export type CapturePlatform = (typeof CAPTURE_PLATFORMS)[number];

/** Whether a desktop web browser is a Chromium family that can run the MV3 extension. */
export const WEB_BROWSER_SUPPORT = [
  "CHROMIUM_SUPPORTED",
  "UNSUPPORTED",
  "UNKNOWN",
] as const;
export type WebBrowserSupport = (typeof WEB_BROWSER_SUPPORT)[number];

/** Publication/distribution fact for the browser extension, resolved by the caller. */
export const EXTENSION_DISTRIBUTION_STATES = [
  /** A validated external store/distribution URL exists — installable. */
  "PUBLISHED",
  /** Built but not published — no installable target exists. */
  "UNPUBLISHED",
] as const;
export type ExtensionDistributionState = (typeof EXTENSION_DISTRIBUTION_STATES)[number];

export interface ExtensionDistribution {
  readonly state: ExtensionDistributionState;
  /** The validated external install URL. Present ONLY when state === "PUBLISHED". */
  readonly url: string | null;
}

/**
 * Truthful availability of a capture channel on the resolved platform. Used to
 * pick UI copy without ever showing an actionable control that cannot act.
 */
export const CAPTURE_AVAILABILITY_STATES = [
  /** Usable right now on this platform. */
  "AVAILABLE",
  /** Supported on this platform in principle, but not yet distributable
   *  (e.g. the extension is built but unpublished). No install control. */
  "COMING_SOON",
  /** This platform can never offer the channel (e.g. Direct Web Capture on a
   *  phone browser or the native app). Show where it IS available instead. */
  "UNSUPPORTED_PLATFORM",
  /** Desktop web, but the browser family cannot run the extension. */
  "UNSUPPORTED_BROWSER",
  /** Availability could not be determined (e.g. pre-hydration). */
  "UNAVAILABLE",
] as const;
export type CaptureAvailabilityState = (typeof CAPTURE_AVAILABILITY_STATES)[number];

/** The Direct Web Capture (browser-extension channel) projection. */
export interface DirectWebCaptureCapability {
  readonly state: CaptureAvailabilityState;
  /** True ONLY when a real external install URL exists on a supported desktop browser. */
  readonly canInstall: boolean;
  /** The validated external store URL when `canInstall`, else null. Never an internal route. */
  readonly installUrl: string | null;
}

export interface CaptureCapabilityInput {
  readonly platform: CapturePlatform;
  /** Only consulted for WEB_DESKTOP. Defaults to UNKNOWN. */
  readonly browserSupport?: WebBrowserSupport;
  /** Resolved extension distribution (web supplies; native/unknown may omit → treated UNPUBLISHED). */
  readonly extension?: ExtensionDistribution;
  /** ANDROID_NATIVE device probe: does the native module report frame-capture support? */
  readonly nativeScreenCaptureSupported?: boolean;
  /** ANDROID_NATIVE device probe: does the native module report continuous-capture support? */
  readonly nativeContinuousCaptureSupported?: boolean;
}

export interface CaptureCapabilities {
  readonly platform: CapturePlatform;
  /** Standard signed-in web upload (files/photo/video/audio). */
  readonly canWebUpload: boolean;
  /** In-surface camera/media capture (web getUserMedia or native camera). */
  readonly canCameraCapture: boolean;
  /** UC-1 browser-extension channel projection (state + truthful install). */
  readonly directWebCapture: DirectWebCaptureCapability;
  /** Convenience mirror of `directWebCapture.canInstall`. */
  readonly canInstallBrowserExtension: boolean;
  /** UC-2 Android Direct Screen Capture (frames). */
  readonly canDirectScreenCapture: boolean;
  /** UC-3 Android Continuous Screen Capture (segments). */
  readonly canContinuousScreenCapture: boolean;
  /** UC-4 Derived Review is a downstream server capability, available wherever the app runs. */
  readonly canDerivedReview: boolean;
}

const UNPUBLISHED: ExtensionDistribution = { state: "UNPUBLISHED", url: null };

/**
 * Hosts we accept as a genuine, external extension store/distribution target.
 * An internal/relative path is NEVER accepted — that is the F1 defect class.
 */
const ALLOWED_EXTENSION_STORE_HOSTS: Readonly<Record<string, "any" | "webstore-path">> = {
  "chromewebstore.google.com": "any",
  "chrome.google.com": "webstore-path", // legacy Web Store lives under /webstore
  "microsoftedge.microsoft.com": "any",
};

/**
 * Resolve a raw install-URL configuration value into a distribution fact.
 *
 * Returns PUBLISHED only for an absolute `https:` URL on a known extension-store
 * host (Chrome Web Store or Edge Add-ons). Anything else — undefined, empty, a
 * relative/internal path like "/settings/legal/direct-web-capture", an http URL,
 * or an unknown host — resolves to UNPUBLISHED with no URL. There is deliberately
 * NO internal fallback: an unpublished extension must never present an install CTA.
 */
export function resolveExtensionDistribution(
  installUrl: string | null | undefined,
): ExtensionDistribution {
  if (typeof installUrl !== "string") return UNPUBLISHED;
  const raw = installUrl.trim();
  if (raw.length === 0) return UNPUBLISHED;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return UNPUBLISHED; // relative/internal paths and malformed values fail here
  }
  if (parsed.protocol !== "https:") return UNPUBLISHED;

  const hostRule = ALLOWED_EXTENSION_STORE_HOSTS[parsed.hostname];
  if (!hostRule) return UNPUBLISHED;
  if (hostRule === "webstore-path" && !parsed.pathname.startsWith("/webstore")) {
    return UNPUBLISHED;
  }
  return { state: "PUBLISHED", url: parsed.toString() };
}

function resolveDirectWebCapture(
  platform: CapturePlatform,
  browserSupport: WebBrowserSupport,
  extension: ExtensionDistribution,
): DirectWebCaptureCapability {
  // The extension channel exists only on desktop web. Everything else is told,
  // truthfully, that it is not the place to use it.
  if (platform === "UNKNOWN") {
    return { state: "UNAVAILABLE", canInstall: false, installUrl: null };
  }
  if (platform === "WEB_MOBILE" || platform === "ANDROID_NATIVE" || platform === "IOS_NATIVE") {
    return { state: "UNSUPPORTED_PLATFORM", canInstall: false, installUrl: null };
  }
  // WEB_DESKTOP from here on.
  if (browserSupport === "UNSUPPORTED") {
    return { state: "UNSUPPORTED_BROWSER", canInstall: false, installUrl: null };
  }
  if (browserSupport === "UNKNOWN") {
    // We could not confirm a supported browser (typically pre-hydration). Never
    // offer an install control; present it as coming soon until confirmed.
    return { state: "COMING_SOON", canInstall: false, installUrl: null };
  }
  // WEB_DESKTOP + CHROMIUM_SUPPORTED.
  if (extension.state === "PUBLISHED" && extension.url) {
    return { state: "AVAILABLE", canInstall: true, installUrl: extension.url };
  }
  return { state: "COMING_SOON", canInstall: false, installUrl: null };
}

/**
 * THE canonical capture-capability resolver. Composes platform, browser family,
 * extension distribution and native probes into one truthful capability record.
 */
export function resolveCaptureCapabilities(input: CaptureCapabilityInput): CaptureCapabilities {
  const platform = input.platform;
  const browserSupport = input.browserSupport ?? "UNKNOWN";
  const extension = input.extension ?? UNPUBLISHED;

  const directWebCapture = resolveDirectWebCapture(platform, browserSupport, extension);

  const isWeb = platform === "WEB_DESKTOP" || platform === "WEB_MOBILE";
  const isNativeApp = platform === "ANDROID_NATIVE" || platform === "IOS_NATIVE";

  const canDirectScreenCapture =
    platform === "ANDROID_NATIVE" && input.nativeScreenCaptureSupported === true;
  const canContinuousScreenCapture =
    platform === "ANDROID_NATIVE" && input.nativeContinuousCaptureSupported === true;

  return {
    platform,
    canWebUpload: isWeb,
    canCameraCapture: isWeb || isNativeApp,
    directWebCapture,
    canInstallBrowserExtension: directWebCapture.canInstall,
    canDirectScreenCapture,
    canContinuousScreenCapture,
    canDerivedReview: platform !== "UNKNOWN",
  };
}

// ---------------------------------------------------------------------------
// Web-only pure classifiers. The web layer passes plain signals it reads from
// `navigator` / User-Agent Client Hints; this keeps DOM access out of shared.
// The native app never uses these — it declares ANDROID_NATIVE/IOS_NATIVE.
// ---------------------------------------------------------------------------

export interface WebPlatformSignals {
  /** navigator.userAgent (may be empty on SSR). */
  readonly userAgent?: string | null;
  /** navigator.userAgentData?.mobile (true/false) when Client Hints are present. */
  readonly uaDataMobile?: boolean | null;
  /** navigator.userAgentData?.brands' brand strings, when present. */
  readonly uaDataBrands?: ReadonlyArray<string> | null;
}

const MOBILE_UA_PATTERN = /Android|iPhone|iPad|iPod|Mobile|Windows Phone|IEMobile/i;

/** Classify a WEB context as desktop vs mobile. Never returns a native platform. */
export function classifyWebPlatform(signals: WebPlatformSignals): "WEB_DESKTOP" | "WEB_MOBILE" | "UNKNOWN" {
  if (typeof signals.uaDataMobile === "boolean") {
    return signals.uaDataMobile ? "WEB_MOBILE" : "WEB_DESKTOP";
  }
  const ua = signals.userAgent;
  if (typeof ua !== "string" || ua.trim().length === 0) return "UNKNOWN";
  // iPadOS Safari reports a desktop UA; treat explicit iPad token or touch macs
  // conservatively as mobile only when the mobile pattern matches.
  return MOBILE_UA_PATTERN.test(ua) ? "WEB_MOBILE" : "WEB_DESKTOP";
}

const CHROMIUM_BRANDS = ["Chromium", "Google Chrome", "Microsoft Edge"];

/**
 * Classify whether a desktop browser is a Chromium family capable of running the
 * MV3 extension. Only meaningful for WEB_DESKTOP. Prefers Client-Hints brands;
 * falls back to a conservative User-Agent read. iOS "Chrome" (CriOS) and other
 * non-desktop-Chromium engines are not treated as supported.
 */
export function classifyWebBrowserSupport(signals: WebPlatformSignals): WebBrowserSupport {
  const brands = signals.uaDataBrands;
  if (brands && brands.length > 0) {
    return brands.some((b) => CHROMIUM_BRANDS.some((c) => b.includes(c)))
      ? "CHROMIUM_SUPPORTED"
      : "UNSUPPORTED";
  }
  const ua = signals.userAgent;
  if (typeof ua !== "string" || ua.trim().length === 0) return "UNKNOWN";
  // On iOS every browser is WebKit (CriOS/FxiOS/EdgiOS) — not extension-capable.
  if (/CriOS|FxiOS|EdgiOS|iPhone|iPad|iPod/i.test(ua)) return "UNSUPPORTED";
  // Desktop Chromium engines: Chrome, Edge (Edg), Chromium, Opera (OPR), Brave.
  if (/(Edg|Chromium|Chrome|OPR)\/\d/i.test(ua)) return "CHROMIUM_SUPPORTED";
  return "UNSUPPORTED";
}

/**
 * Convenience: resolve the full capability record directly from raw web signals
 * plus a raw install-URL config value. Used by the web capture surface.
 */
export function resolveWebCaptureCapabilities(
  signals: WebPlatformSignals,
  extensionInstallUrl: string | null | undefined,
): CaptureCapabilities {
  const platform = classifyWebPlatform(signals);
  const browserSupport =
    platform === "WEB_DESKTOP" ? classifyWebBrowserSupport(signals) : "UNKNOWN";
  return resolveCaptureCapabilities({
    platform,
    browserSupport,
    extension: resolveExtensionDistribution(extensionInstallUrl),
  });
}
