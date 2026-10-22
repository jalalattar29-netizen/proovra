/**
 * THE COOKIE BANNER IS A PRECONDITION OF SIGNING IN, NOT ITS SUBJECT.
 *
 * On a first visit the consent manager (`#cc-main`, `position: fixed`) sits
 * over the bottom-right of the page until it is answered. At the chromium
 * project's 1280 × 720 viewport it covers the login form's "Sign in with
 * Email" button at EVERY vertical scroll position, so a helper that clicks it
 * without answering the banner burns its whole timeout on intercepted clicks.
 *
 * Those helpers used to pass only by accident: the marketing header overflowed
 * the login page's `overflow: hidden` wrapper by ~100px at 1280, and
 * Playwright's click retry scrolled that wrapper sideways far enough to slide
 * the button out from under the banner. Fixing the header overflow removed the
 * accident and every sign-in through the form timed out.
 *
 * The banner is answered here the way `e2e/point7/_harness.ts` answers it:
 * with the record the consent manager itself writes once a returning user has
 * declined non-essential cookies — the privacy-preserving answer. It is seeded
 * before any page script runs, so there is no race with the banner's
 * appearance. The banner is still built; specs that assert its first-visit
 * behaviour do not call this.
 */
import type { Page } from "@playwright/test";

const NECESSARY_ONLY_CONSENT = JSON.stringify({
  categories: ["necessary"],
  revision: 1,
  data: null,
  consentTimestamp: "2026-01-01T00:00:00.000Z",
  consentId: "critical-flow-consent",
  services: { necessary: [], preferences: [], analytics: [], marketing: [] },
  languageCode: "en",
  // v3 treats a record without these as invalid and shows the banner again.
  lastConsentTimestamp: "2026-01-01T00:00:00.000Z",
  expirationTime: 4102444800000,
});

/** Record a necessary-only consent decision before every navigation of `page`. */
export async function answerCookieBanner(page: Page): Promise<void> {
  await page.addInitScript((value: string) => {
    document.cookie = `cc_cookie=${encodeURIComponent(value)};path=/`;
  }, NECESSARY_ONLY_CONSENT);
}
