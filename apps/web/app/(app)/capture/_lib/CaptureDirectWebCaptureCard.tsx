"use client";

/**
 * UC-1 — Direct Web Capture entry on the capture surface.
 *
 * A factual, non-blocking card that introduces the browser-extension capture
 * channel and links to installing it. It is informational: the actual capture
 * happens in the extension, so there is no dead in-app "capture" button here.
 * Wording follows the UC-1 claim matrix — PROOVRA records HOW a page was
 * captured, never that its content is true.
 */

const EXTENSION_INSTALL_URL =
  process.env.NEXT_PUBLIC_EXTENSION_INSTALL_URL ?? "/settings/legal/direct-web-capture";

export function CaptureDirectWebCaptureCard() {
  return (
    <section
      className="capture-direct-web"
      data-capture-direct-web-capture
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
      <div className="capture-direct-web__actions">
        <a
          className="app-secondary-action"
          data-capture-direct-web-install
          href={EXTENSION_INSTALL_URL}
        >
          Install the PROOVRA extension
        </a>
      </div>
    </section>
  );
}
