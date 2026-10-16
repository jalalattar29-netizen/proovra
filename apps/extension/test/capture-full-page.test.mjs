/**
 * UC-EXT-003 / UC-EXT-004 — the REAL full-page capture loop against a stubbed
 * `chrome` that enforces Chrome's documented quota: a third captureVisibleTab
 * call inside any one second rejects with the MAX_CAPTURE_VISIBLE_TAB_CALLS_
 * PER_SECOND error, exactly as the browser does.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function installChrome({
  pageHeight = 3200,
  viewport = 800,
  failAfter = Infinity,
  domReply,
  // AUD-026 — the tab as chrome.tabs.get reports it, per capture call so far.
  tabAt = () => ({ active: true, windowId: 1, url: "https://example.com/long" }),
} = {}) {
  const calls = [];
  let y = 0;
  globalThis.chrome = {
    tabs: {
      async get(tabId) {
        return { id: tabId, ...tabAt(calls.length) };
      },
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

// ---------------------------------------------------------------------------
// AUD-026 — captureVisibleTab photographs the ACTIVE tab, so the chosen tab is
// re-checked before and after every shot and before the DOM snapshot.
// ---------------------------------------------------------------------------
test("AUD-026: switching tab mid full-page capture stops it — no tile of the other tab is taken", async () => {
  const calls = installChrome({
    pageHeight: 3200,
    viewport: 800,
    tabAt: (shots) => ({ active: shots < 2, windowId: 1, url: "https://example.com/long" }),
  });
  const { captureFullPage, CaptureInterruptedError } = await import("./dist/capture.js");
  await assert.rejects(captureFullPage(1, 1), (err) => err instanceof CaptureInterruptedError && err.code === "TAB_CHANGED");
  assert.equal(calls.length, 2, "no screenshot is taken once the tab is no longer active");
});

test("AUD-026: a navigation mid capture is PAGE_NAVIGATED; a hidden URL (grant revoked) is a navigation too", async () => {
  installChrome({ tabAt: (shots) => ({ active: true, windowId: 1, url: shots < 1 ? "https://example.com/long" : "https://other.example/" }) });
  const { captureFullPage, CaptureInterruptedError } = await import("./dist/capture.js");
  await assert.rejects(captureFullPage(1, 1), (err) => err instanceof CaptureInterruptedError && err.code === "PAGE_NAVIGATED");

  installChrome({ tabAt: (shots) => ({ active: true, windowId: 1, url: shots < 1 ? "https://example.com/long" : undefined }) });
  await assert.rejects(captureFullPage(1, 1), (err) => err instanceof CaptureInterruptedError && err.code === "PAGE_NAVIGATED");
});

test("AUD-026: a fragment change is the same document and does not stop the capture", async () => {
  installChrome({ tabAt: (shots) => ({ active: true, windowId: 1, url: `https://example.com/long#section-${shots}` }) });
  const { captureFullPage } = await import("./dist/capture.js");
  const r = await captureFullPage(1, 1);
  assert.equal(r.artifacts.filter((a) => a.role === "page_tile").length, 4);
});

test("AUD-026: the viewport shot is re-checked after it is taken (a switch between check and shot)", async () => {
  installChrome({ tabAt: (shots) => ({ active: shots === 0, windowId: 1, url: "https://example.com/long" }) });
  const { captureViewport, CaptureInterruptedError } = await import("./dist/capture.js");
  await assert.rejects(captureViewport(1, 1), (err) => err instanceof CaptureInterruptedError && err.code === "TAB_CHANGED");
});

test("AUD-026: a tab moved to another window is TAB_CHANGED", async () => {
  installChrome({ tabAt: () => ({ active: true, windowId: 2, url: "https://example.com/long" }) });
  const { captureViewport, CaptureInterruptedError } = await import("./dist/capture.js");
  await assert.rejects(captureViewport(1, 1), (err) => err instanceof CaptureInterruptedError && err.code === "TAB_CHANGED");
});

test("AUD-026: iframe and shadow-DOM boundaries are recorded as limitations, not silently dropped", async () => {
  installChrome({
    domReply: { ok: true, html: "<html></html>", counts: null, crossOriginFrames: 2, shadowRoots: 1, protectedMedia: 0, mutationsObserved: 0 },
  });
  const { captureViewport } = await import("./dist/capture.js");
  const r = await captureViewport(1, 1);
  assert.ok(r.limitations.includes("CROSS_ORIGIN_IFRAME_NOT_CAPTURED"));
  assert.ok(r.limitations.includes("SHADOW_DOM_NOT_FULLY_REPRESENTED"));
});

test("AUD-026: a navigation that breaks the content-script message mid-capture is PAGE_NAVIGATED, not a generic error", async () => {
  // Edge, observed: the page navigates while SCROLL_TO is in flight, the
  // message fails with "Receiving end does not exist", and only then would the
  // next tab re-check have run.
  let navigated = false;
  installChrome({ tabAt: () => ({ active: true, windowId: 1, url: navigated ? "https://other.example/" : "https://example.com/long" }) });
  const send = globalThis.chrome.tabs.sendMessage;
  globalThis.chrome.tabs.sendMessage = async (tabId, msg) => {
    if (msg.kind === "SCROLL_TO" && msg.y > 0) {
      navigated = true;
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }
    return send(tabId, msg);
  };
  const { captureFullPage, CaptureInterruptedError } = await import("./dist/capture.js");
  await assert.rejects(captureFullPage(1, 1), (err) => err instanceof CaptureInterruptedError && err.code === "PAGE_NAVIGATED");
});

test("AUD-026: a navigation still in flight (old url, new pendingUrl) is PAGE_NAVIGATED, not a generic error", async () => {
  // Chromium, observed: the message fails as the navigation starts, before it
  // commits — `tab.url` still names the old page and only `tab.pendingUrl`
  // names the new one. Reading `url` first let the re-check pass and the
  // generic failure stand.
  let navigating = false;
  installChrome({
    tabAt: () => ({
      active: true,
      windowId: 1,
      url: "https://example.com/long",
      ...(navigating ? { pendingUrl: "https://other.example/" } : {}),
    }),
  });
  const send = globalThis.chrome.tabs.sendMessage;
  globalThis.chrome.tabs.sendMessage = async (tabId, msg) => {
    if (msg.kind === "SCROLL_TO" && msg.y > 0) {
      navigating = true;
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }
    return send(tabId, msg);
  };
  const { captureFullPage, CaptureInterruptedError } = await import("./dist/capture.js");
  await assert.rejects(captureFullPage(1, 1), (err) => err instanceof CaptureInterruptedError && err.code === "PAGE_NAVIGATED");
});

test("AUD-026: a same-address reload in flight is not a navigation away", async () => {
  installChrome({ tabAt: () => ({ active: true, windowId: 1, url: "https://example.com/long", pendingUrl: "https://example.com/long" }) });
  const { captureFullPage } = await import("./dist/capture.js");
  const r = await captureFullPage(1, 1);
  assert.ok(r.artifacts.length > 0);
});

test("AUD-026: a screenshot refused because the tab switched is TAB_CHANGED, not a PARTIAL record", async () => {
  let switched = false;
  installChrome({ tabAt: () => ({ active: !switched, windowId: 1, url: "https://example.com/long" }) });
  const capture = globalThis.chrome.tabs.captureVisibleTab;
  let shots = 0;
  globalThis.chrome.tabs.captureVisibleTab = async (...a) => {
    shots += 1;
    if (shots === 2) {
      switched = true;
      throw new Error("Cannot access contents of the page.");
    }
    return capture(...a);
  };
  const { captureFullPage, CaptureInterruptedError } = await import("./dist/capture.js");
  await assert.rejects(captureFullPage(1, 1), (err) => err instanceof CaptureInterruptedError && err.code === "TAB_CHANGED");
});

test("AUD-026: a failed message on an unchanged page keeps its own error", async () => {
  installChrome();
  const send = globalThis.chrome.tabs.sendMessage;
  globalThis.chrome.tabs.sendMessage = async (tabId, msg) => {
    if (msg.kind === "SCROLL_TO" && msg.y > 0) throw new Error("content script crashed");
    return send(tabId, msg);
  };
  const { captureFullPage } = await import("./dist/capture.js");
  await assert.rejects(captureFullPage(1, 1), /content script crashed/);
});
