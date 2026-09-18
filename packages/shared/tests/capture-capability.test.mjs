import test from "node:test";
import assert from "node:assert/strict";

// F7 — the canonical cross-platform capture-capability authority.
//
// These tests are the platform-capability matrix guard (C in the audit's
// permanent guards). The load-bearing negative invariants:
//   - mobile web NEVER receives an installable browser-extension state
//   - iOS native NEVER receives Chromium-extension availability
//   - an unpublished extension NEVER yields an install control
//   - a relative/internal URL is NEVER accepted as a publication target
//   - Android screen capture is not inferred from a web user agent
import {
  resolveCaptureCapabilities,
  resolveWebCaptureCapabilities,
  resolveExtensionDistribution,
  classifyWebPlatform,
  classifyWebBrowserSupport,
  CAPTURE_PLATFORMS,
  CAPTURE_AVAILABILITY_STATES,
} from "../dist/index.js";

const PUBLISHED_URL = "https://chromewebstore.google.com/detail/proovra/abcdefghijklmnopabcdefghijklmnop";

test("resolveExtensionDistribution accepts only genuine external store URLs", () => {
  assert.equal(resolveExtensionDistribution(PUBLISHED_URL).state, "PUBLISHED");
  assert.equal(resolveExtensionDistribution(PUBLISHED_URL).url, PUBLISHED_URL);
  assert.equal(
    resolveExtensionDistribution("https://microsoftedge.microsoft.com/addons/detail/x").state,
    "PUBLISHED",
  );
  assert.equal(
    resolveExtensionDistribution("https://chrome.google.com/webstore/detail/x").state,
    "PUBLISHED",
  );

  // The F1 defect class: an internal/relative fallback must NEVER be published.
  for (const bad of [
    undefined,
    null,
    "",
    "   ",
    "/settings/legal/direct-web-capture",
    "settings/legal/direct-web-capture",
    "http://chromewebstore.google.com/detail/x", // not https
    "https://evil.example.com/detail/x", // unknown host
    "https://chrome.google.com/not-webstore", // wrong path on legacy host
    "javascript:alert(1)",
  ]) {
    const d = resolveExtensionDistribution(bad);
    assert.equal(d.state, "UNPUBLISHED", `expected UNPUBLISHED for ${JSON.stringify(bad)}`);
    assert.equal(d.url, null);
  }
});

test("mobile web NEVER receives an installable extension state (even if published)", () => {
  const cap = resolveCaptureCapabilities({
    platform: "WEB_MOBILE",
    browserSupport: "CHROMIUM_SUPPORTED",
    extension: { state: "PUBLISHED", url: PUBLISHED_URL },
  });
  assert.equal(cap.directWebCapture.state, "UNSUPPORTED_PLATFORM");
  assert.equal(cap.directWebCapture.canInstall, false);
  assert.equal(cap.directWebCapture.installUrl, null);
  assert.equal(cap.canInstallBrowserExtension, false);
  // Mobile web has no native screen capture regardless of anything.
  assert.equal(cap.canDirectScreenCapture, false);
  assert.equal(cap.canContinuousScreenCapture, false);
});

test("iOS native NEVER receives Chromium-extension availability", () => {
  const cap = resolveCaptureCapabilities({
    platform: "IOS_NATIVE",
    extension: { state: "PUBLISHED", url: PUBLISHED_URL },
  });
  assert.equal(cap.directWebCapture.state, "UNSUPPORTED_PLATFORM");
  assert.equal(cap.canInstallBrowserExtension, false);
  // UC-5 not implemented: no Android screen capture leaks onto iOS.
  assert.equal(cap.canDirectScreenCapture, false);
  assert.equal(cap.canContinuousScreenCapture, false);
});

test("desktop Chromium + unpublished extension = COMING_SOON, no install", () => {
  const cap = resolveCaptureCapabilities({
    platform: "WEB_DESKTOP",
    browserSupport: "CHROMIUM_SUPPORTED",
    extension: { state: "UNPUBLISHED", url: null },
  });
  assert.equal(cap.directWebCapture.state, "COMING_SOON");
  assert.equal(cap.directWebCapture.canInstall, false);
  assert.equal(cap.directWebCapture.installUrl, null);
});

test("desktop Chromium + published extension = AVAILABLE with real install URL", () => {
  const cap = resolveCaptureCapabilities({
    platform: "WEB_DESKTOP",
    browserSupport: "CHROMIUM_SUPPORTED",
    extension: { state: "PUBLISHED", url: PUBLISHED_URL },
  });
  assert.equal(cap.directWebCapture.state, "AVAILABLE");
  assert.equal(cap.directWebCapture.canInstall, true);
  assert.equal(cap.directWebCapture.installUrl, PUBLISHED_URL);
});

test("desktop unsupported browser = UNSUPPORTED_BROWSER, never install (even if published)", () => {
  const cap = resolveCaptureCapabilities({
    platform: "WEB_DESKTOP",
    browserSupport: "UNSUPPORTED",
    extension: { state: "PUBLISHED", url: PUBLISHED_URL },
  });
  assert.equal(cap.directWebCapture.state, "UNSUPPORTED_BROWSER");
  assert.equal(cap.canInstallBrowserExtension, false);
});

test("desktop unknown browser is never offered an install control", () => {
  const cap = resolveCaptureCapabilities({
    platform: "WEB_DESKTOP",
    browserSupport: "UNKNOWN",
    extension: { state: "PUBLISHED", url: PUBLISHED_URL },
  });
  assert.equal(cap.directWebCapture.state, "COMING_SOON");
  assert.equal(cap.canInstallBrowserExtension, false);
});

test("Android native screen capture requires the platform AND the native probe", () => {
  const supported = resolveCaptureCapabilities({
    platform: "ANDROID_NATIVE",
    nativeScreenCaptureSupported: true,
    nativeContinuousCaptureSupported: true,
  });
  assert.equal(supported.canDirectScreenCapture, true);
  assert.equal(supported.canContinuousScreenCapture, true);
  // No extension CTA in the native app.
  assert.equal(supported.directWebCapture.state, "UNSUPPORTED_PLATFORM");
  assert.equal(supported.canInstallBrowserExtension, false);

  const unsupportedDevice = resolveCaptureCapabilities({
    platform: "ANDROID_NATIVE",
    nativeScreenCaptureSupported: false,
    nativeContinuousCaptureSupported: false,
  });
  assert.equal(unsupportedDevice.canDirectScreenCapture, false);
  assert.equal(unsupportedDevice.canContinuousScreenCapture, false);
});

test("unknown platform yields no actionable capture capability", () => {
  const cap = resolveCaptureCapabilities({ platform: "UNKNOWN" });
  assert.equal(cap.directWebCapture.state, "UNAVAILABLE");
  assert.equal(cap.canInstallBrowserExtension, false);
  assert.equal(cap.canWebUpload, false);
  assert.equal(cap.canDirectScreenCapture, false);
  assert.equal(cap.canDerivedReview, false);
});

test("classifyWebPlatform: Client-Hints and UA fallback", () => {
  assert.equal(classifyWebPlatform({ uaDataMobile: true }), "WEB_MOBILE");
  assert.equal(classifyWebPlatform({ uaDataMobile: false }), "WEB_DESKTOP");
  assert.equal(
    classifyWebPlatform({ userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile" }),
    "WEB_MOBILE",
  );
  assert.equal(
    classifyWebPlatform({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) CriOS/120" }),
    "WEB_MOBILE",
  );
  assert.equal(
    classifyWebPlatform({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120" }),
    "WEB_DESKTOP",
  );
  assert.equal(classifyWebPlatform({ userAgent: "" }), "UNKNOWN");
});

test("classifyWebBrowserSupport: Chromium desktop vs not", () => {
  assert.equal(
    classifyWebBrowserSupport({ uaDataBrands: ["Chromium", "Google Chrome", "Not?A_Brand"] }),
    "CHROMIUM_SUPPORTED",
  );
  assert.equal(classifyWebBrowserSupport({ uaDataBrands: ["Firefox"] }), "UNSUPPORTED");
  assert.equal(
    classifyWebBrowserSupport({ userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537" }),
    "CHROMIUM_SUPPORTED",
  );
  assert.equal(
    classifyWebBrowserSupport({ userAgent: "Mozilla/5.0 (Windows NT 10.0) Edg/120.0" }),
    "CHROMIUM_SUPPORTED",
  );
  assert.equal(
    classifyWebBrowserSupport({ userAgent: "Mozilla/5.0 (Macintosh) Version/17.0 Safari/605" }),
    "UNSUPPORTED",
  );
  assert.equal(
    classifyWebBrowserSupport({ userAgent: "Mozilla/5.0 (Windows NT 10.0; rv:120) Gecko Firefox/120" }),
    "UNSUPPORTED",
  );
  // iOS "Chrome" is WebKit, not extension-capable.
  assert.equal(
    classifyWebBrowserSupport({ userAgent: "Mozilla/5.0 (iPhone) CriOS/120 Mobile Safari" }),
    "UNSUPPORTED",
  );
});

test("resolveWebCaptureCapabilities end-to-end: mobile Chrome UA never installs", () => {
  const cap = resolveWebCaptureCapabilities(
    { userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari" },
    PUBLISHED_URL,
  );
  assert.equal(cap.platform, "WEB_MOBILE");
  assert.equal(cap.canInstallBrowserExtension, false);
  assert.equal(cap.directWebCapture.state, "UNSUPPORTED_PLATFORM");
});

test("resolveWebCaptureCapabilities end-to-end: desktop Chrome + published installs", () => {
  const cap = resolveWebCaptureCapabilities(
    { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537" },
    PUBLISHED_URL,
  );
  assert.equal(cap.platform, "WEB_DESKTOP");
  assert.equal(cap.canInstallBrowserExtension, true);
  assert.equal(cap.directWebCapture.installUrl, PUBLISHED_URL);
});

test("resolveWebCaptureCapabilities end-to-end: desktop Chrome + internal fallback NEVER installs (F1)", () => {
  const cap = resolveWebCaptureCapabilities(
    { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537" },
    "/settings/legal/direct-web-capture",
  );
  assert.equal(cap.canInstallBrowserExtension, false);
  assert.equal(cap.directWebCapture.installUrl, null);
  assert.equal(cap.directWebCapture.state, "COMING_SOON");
});

test("vocabularies are stable", () => {
  assert.deepEqual([...CAPTURE_PLATFORMS], [
    "WEB_DESKTOP",
    "WEB_MOBILE",
    "ANDROID_NATIVE",
    "IOS_NATIVE",
    "UNKNOWN",
  ]);
  assert.ok(CAPTURE_AVAILABILITY_STATES.includes("COMING_SOON"));
});
