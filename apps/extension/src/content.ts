/**
 * Content script — runs IN the page, only after the user's explicit action
 * (injected on demand via chrome.scripting from the background). It never
 * exfiltrates anything on its own: it answers bounded requests from the
 * background (page info, scroll, sanitized DOM) and returns the results.
 */
import { sanitizeDom } from "./lib/sanitizer.js";

type Req =
  | { kind: "GET_PAGE_INFO" }
  | { kind: "SCROLL_TO"; y: number }
  | { kind: "GET_SANITIZED_DOM" }
  | { kind: "RESTORE_SCROLL"; y: number };

chrome.runtime.onMessage.addListener((message: Req, _sender, sendResponse) => {
  try {
    if (message.kind === "GET_PAGE_INFO") {
      sendResponse({
        ok: true,
        url: location.href,
        title: document.title || null,
        scrollHeight: Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight ?? 0,
        ),
        viewportW: window.innerWidth,
        viewportH: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        scrollY: window.scrollY,
      });
      return; // synchronous response
    }
    if (message.kind === "SCROLL_TO") {
      const before = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
      window.scrollTo({ top: message.y, left: 0, behavior: "instant" as ScrollBehavior });
      const after = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
      sendResponse({ ok: true, actualY: window.scrollY, heightChanged: before !== after, height: after });
      return;
    }
    if (message.kind === "RESTORE_SCROLL") {
      window.scrollTo({ top: message.y, left: 0, behavior: "instant" as ScrollBehavior });
      sendResponse({ ok: true });
      return;
    }
    if (message.kind === "GET_SANITIZED_DOM") {
      const clone = document.documentElement.cloneNode(true) as HTMLElement;
      const counts = sanitizeDom(clone);
      const html = `<!DOCTYPE html>\n<!-- PROOVRA sanitized DOM snapshot; inert, secrets cleared -->\n${clone.outerHTML}`;
      // Shadow DOM: cloneNode does NOT traverse shadow roots, so component
      // content is not in this snapshot. We count OPEN shadow roots so the
      // manifest can disclose the limitation truthfully (closed roots are
      // undetectable, so this is a lower bound, never a guarantee of complete
      // capture).
      sendResponse({
        ok: true,
        html,
        counts,
        crossOriginFrames: countCrossOriginFrames(),
        shadowRoots: countOpenShadowRoots(),
      });
      return;
    }
  } catch (err) {
    sendResponse({ ok: false, error: String(err instanceof Error ? err.message : err) });
  }
  return; // no async keep-alive needed
});

function countCrossOriginFrames(): number {
  let n = 0;
  for (const frame of Array.from(document.querySelectorAll("iframe"))) {
    try {
      // Accessing contentDocument throws for cross-origin frames.
      void (frame as HTMLIFrameElement).contentDocument;
    } catch {
      n += 1;
    }
  }
  return n;
}

/**
 * Count elements carrying an OPEN shadow root. `cloneNode(true)` omits shadow
 * trees, so any open root means the DOM snapshot is incomplete. Closed roots are
 * not observable from script, so this is a lower bound used only to DISCLOSE the
 * limitation — never to assert a complete capture.
 */
function countOpenShadowRoots(): number {
  let n = 0;
  for (const el of Array.from(document.querySelectorAll("*"))) {
    if ((el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot) n += 1;
  }
  return n;
}
