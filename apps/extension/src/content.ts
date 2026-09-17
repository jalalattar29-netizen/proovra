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
      sendResponse({ ok: true, html, counts, crossOriginFrames: countCrossOriginFrames() });
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
