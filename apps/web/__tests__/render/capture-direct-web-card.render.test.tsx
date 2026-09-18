import { describe, it, expect, afterEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { CaptureDirectWebCaptureCard } from "../../app/(app)/capture/_lib/CaptureDirectWebCaptureCard";

/**
 * F3/F1/F2 render-level proof: the Direct Web Capture card shows the TRUTHFUL
 * state for the platform, and the install control appears ONLY on a supported
 * desktop browser with a genuine published external store URL. Mobile web,
 * unsupported browsers, and the unpublished state never get an install link.
 */

const PUBLISHED = "https://chromewebstore.google.com/detail/proovra/abcdefghijklmnopabcdefghijklmnop";

function setBrowser(userAgent: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true });
  // Force the UA fallback path (no Client Hints) so the UA string drives it.
  Object.defineProperty(window.navigator, "userAgentData", { value: undefined, configurable: true });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function stateAttr(): string | null {
  return document.querySelector("[data-capture-direct-web-capture]")?.getAttribute(
    "data-direct-web-capture-state",
  ) ?? null;
}
function installLink(): HTMLAnchorElement | null {
  return document.querySelector("a[data-capture-direct-web-install]");
}
function learnMore(): HTMLAnchorElement | null {
  return document.querySelector("a[data-capture-direct-web-learn-more]");
}

describe("CaptureDirectWebCaptureCard", () => {
  it("desktop Chromium + published extension → real external install link", async () => {
    vi.stubEnv("NEXT_PUBLIC_EXTENSION_INSTALL_URL", PUBLISHED);
    setBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537 Chrome/120.0 Safari/537");
    render(<CaptureDirectWebCaptureCard />);
    await waitFor(() => expect(stateAttr()).toBe("AVAILABLE"));
    const link = installLink();
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe(PUBLISHED);
    expect(link!.getAttribute("rel")).toContain("noopener");
    expect(learnMore()).not.toBeNull();
  });

  it("mobile web → NO install link, learn-more still present (F3)", async () => {
    vi.stubEnv("NEXT_PUBLIC_EXTENSION_INSTALL_URL", PUBLISHED);
    setBrowser("Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537 Chrome/120 Mobile Safari/537");
    render(<CaptureDirectWebCaptureCard />);
    await waitFor(() => expect(stateAttr()).toBe("UNSUPPORTED_PLATFORM"));
    expect(installLink()).toBeNull();
    expect(learnMore()).not.toBeNull();
    expect(learnMore()!.getAttribute("href")).toBe("/settings/legal/direct-web-capture");
  });

  it("desktop Chromium + unpublished (unset env) → COMING_SOON, NO install link (F1/F2)", async () => {
    vi.stubEnv("NEXT_PUBLIC_EXTENSION_INSTALL_URL", "");
    setBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537 Chrome/120.0 Safari/537");
    render(<CaptureDirectWebCaptureCard />);
    await waitFor(() => expect(stateAttr()).toBe("COMING_SOON"));
    expect(installLink()).toBeNull();
  });

  it("desktop non-Chromium (Firefox) → UNSUPPORTED_BROWSER, NO install link even if published", async () => {
    vi.stubEnv("NEXT_PUBLIC_EXTENSION_INSTALL_URL", PUBLISHED);
    setBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0");
    render(<CaptureDirectWebCaptureCard />);
    await waitFor(() => expect(stateAttr()).toBe("UNSUPPORTED_BROWSER"));
    expect(installLink()).toBeNull();
  });

  it("an internal fallback URL is NEVER treated as installable (F1)", async () => {
    vi.stubEnv("NEXT_PUBLIC_EXTENSION_INSTALL_URL", "/settings/legal/direct-web-capture");
    setBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537 Chrome/120.0 Safari/537");
    render(<CaptureDirectWebCaptureCard />);
    await waitFor(() => expect(stateAttr()).toBe("COMING_SOON"));
    expect(installLink()).toBeNull();
  });
});
