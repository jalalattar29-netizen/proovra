"use client";

/**
 * UC-1 — Direct Web Capture entry on the capture surface.
 *
 * A factual, non-blocking card that introduces the browser-extension capture
 * channel and states its TRUTHFUL availability for the visitor's platform. The
 * actual capture happens in the extension, so there is no in-app "capture"
 * button here — and, critically, there is no dead or misleading install link.
 *
 * The availability state comes from the ONE canonical capture-capability
 * authority (`@proovra/shared` F7) via `useCaptureCapabilities`:
 *   - AVAILABLE            → a real external store install link (published only)
 *   - COMING_SOON          → supported desktop browser, extension not yet published
 *   - UNSUPPORTED_BROWSER  → desktop, non-Chromium browser
 *   - UNSUPPORTED_PLATFORM → mobile web (available on desktop Chrome/Edge)
 *   - UNAVAILABLE          → pre-hydration / unknown; neutral description only
 *
 * There is NEVER an "Install" control unless a genuine external store URL exists
 * on a supported desktop browser. The install target is only ever that external
 * URL — never an internal legal/route fallback. Wording follows the UC-1 claim
 * matrix: PROOVRA records HOW a page was captured, never that its content is true.
 */

import { useCaptureCapabilities } from "./useCaptureCapabilities";

/** The authenticated "how it works" disclosure page (NOT the install target). */
const DIRECT_WEB_CAPTURE_LEARN_MORE_HREF = "/settings/legal/direct-web-capture";

function availabilityLine(state: string): string {
  switch (state) {
    case "AVAILABLE":
      return "The PROOVRA browser extension is available for supported desktop Chrome and Edge browsers.";
    case "COMING_SOON":
      return "The PROOVRA browser extension is coming soon. It is not yet available to install.";
    case "UNSUPPORTED_BROWSER":
      return "Direct Web Capture requires a Chromium-based desktop browser such as Chrome or Edge.";
    case "UNSUPPORTED_PLATFORM":
      return "Direct Web Capture runs in a browser extension on supported desktop Chrome or Edge browsers. Open PROOVRA on a desktop browser to use it.";
    default:
      return "Direct Web Capture runs through the PROOVRA browser extension on supported desktop browsers.";
  }
}

export function CaptureDirectWebCaptureCard() {
  const { directWebCapture } = useCaptureCapabilities();
  const { state, canInstall, installUrl } = directWebCapture;

  return (
    <section
      className="capture-direct-web"
      data-capture-direct-web-capture
      data-direct-web-capture-state={state}
      aria-labelledby="direct-web-capture-heading"
    >
      <h2 id="direct-web-capture-heading" className="capture-direct-web__title">
        Direct Web Capture
      </h2>
      <p className="capture-direct-web__body">
        Don&apos;t just upload a screenshot. With the PROOVRA browser extension you can
        preserve a web page through a server-issued capture session: PROOVRA takes part in
        the capture, independently checks the bytes it receives, and records how and when
        the page was captured.
      </p>
      <p className="capture-direct-web__note">
        PROOVRA records how the page entered the evidence lifecycle. It does not establish
        that the page&apos;s content is true, who authored it, or that a website is genuine.
      </p>
      <p className="capture-direct-web__availability" data-capture-direct-web-availability>
        {availabilityLine(state)}
      </p>
      <div className="capture-direct-web__actions">
        {canInstall && installUrl ? (
          <a
            className="app-secondary-action"
            data-capture-direct-web-install
            href={installUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Install the PROOVRA extension
          </a>
        ) : null}
        <a
          className="capture-direct-web__learn-more"
          data-capture-direct-web-learn-more
          href={DIRECT_WEB_CAPTURE_LEARN_MORE_HREF}
        >
          Learn how Direct Web Capture works
        </a>
      </div>
    </section>
  );
}
