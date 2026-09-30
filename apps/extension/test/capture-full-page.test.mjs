/**
 * UC-EXT-003 / UC-EXT-004 — the REAL full-page capture loop against a stubbed
 * `chrome` that enforces Chrome's documented quota: a third captureVisibleTab
 * call inside any one second rejects with the MAX_CAPTURE_VISIBLE_TAB_CALLS_
 * PER_SECOND error, exactly as the browser does.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function installChrome({ pageHeight = 3200, viewport = 800, failAfter = Infinity, domReply } = {}) {
  const calls = [];
  let y = 0;
  globalThis.chrome = {
    tabs: {
      async sendMessage(_tabId, msg) {
        switch (msg.kind) {
          case "GET_PAGE_INFO":
            return { ok: true, url: "https://example.com/long", title: "Long", scrollHeight: pageHeight, viewportW: 1280, viewportH: viewport, devicePixelRatio: 1, scrollY: 0 };
          case "SCROLL_TO":
            y = msg.y;
            return { ok: true, actualY: y, heightChanged: false };
          case "RESTORE_SCROLL":
            return { ok: true };
          case "GET_SANITIZED_DOM":
            return domReply ?? { ok: true, html: "<html></html>", counts: null, crossOriginFrames: 0, shadowRoots: 0, protectedMedia: 0, mutationsObserved: 0 };
          default:
            throw new Error(`unexpected ${msg.kind}`);
        }
      },
      async captureVisibleTab() {
        const now = Date.now();
        const inLastSecond = calls.filter((t) => now - t < 1000).length;
        calls.push(now);
        if (inLastSecond >= 2) {
          throw new Error("This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.");
        }
        if (calls.length > failAfter) throw new Error("Cannot access contents of the page.");
        return PNG;
      },
    },
  };
  return calls;
}

test("a page four viewports tall is captured completely without tripping the 2/s quota", async () => {
  installChrome({ pageHeight: 3200, viewport: 800 });
  const { captureFullPage } = await import("./dist/capture.js");
  const r = await captureFullPage(1, 1);
  const tiles = r.artifacts.filter((a) => a.role === "page_tile");
  assert.equal(tiles.length, 4);
  assert.deepEqual(tiles.map((t) => t.tileIndex), [0, 1, 2, 3]);
  assert.equal(r.limitations.includes("CAPTURE_INTERRUPTED"), false);
});

test("a tile the browser keeps refusing ends the capture PARTIAL with the tiles taken, not a discard", async () => {
  installChrome({ pageHeight: 3200, viewport: 800, failAfter: 2 });
  const { captureFullPage } = await import("./dist/capture.js");
  const r = await captureFullPage(1, 1);
  const tiles = r.artifacts.filter((a) => a.role === "page_tile");
  assert.equal(tiles.length, 2);
  assert.ok(r.limitations.includes("CAPTURE_INTERRUPTED"));
  assert.ok(r.notes.some((n) => /stopped after 2 of 4/.test(n)));
});

test("a missing DOM snapshot and the page facts are recorded (UC-EXT-004)", async () => {
  installChrome({
    pageHeight: 800,
    viewport: 800,
    domReply: { ok: false, crossOriginFrames: 1, shadowRoots: 2, protectedMedia: 1, mutationsObserved: 5 },
  });
  const { captureViewport } = await import("./dist/capture.js");
  const r = await captureViewport(1, 1);
  assert.equal(r.domSnapshotMissing, true);
  assert.equal(r.artifacts.some((a) => a.role === "dom_snapshot"), false);
  for (const code of [
    "CROSS_ORIGIN_IFRAME_NOT_CAPTURED",
    "SHADOW_DOM_NOT_FULLY_REPRESENTED",
    "PROTECTED_MEDIA_NOT_CAPTURED",
    "DYNAMIC_CONTENT_MAY_BE_INCOMPLETE",
  ]) {
    assert.ok(r.limitations.includes(code), code);
  }
});
