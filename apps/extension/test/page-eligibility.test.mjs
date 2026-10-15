/**
 * AUD-026 — restricted pages are named before a capture starts; hosts compare
 * exactly, never by substring.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isRestrictedScriptingError, pageRestriction } from "./dist/page-eligibility.js";
import { statusLine } from "./dist/status-copy.js";

test("browser-internal, store and non-web pages are restricted", () => {
  assert.equal(pageRestriction("chrome://newtab/"), "BROWSER_INTERNAL_PAGE");
  assert.equal(pageRestriction("edge://settings/"), "BROWSER_INTERNAL_PAGE");
  assert.equal(pageRestriction("about:blank"), "BROWSER_INTERNAL_PAGE");
  assert.equal(pageRestriction("chrome-extension://abc/popup.html"), "BROWSER_INTERNAL_PAGE");
  assert.equal(pageRestriction("view-source:https://example.com/"), "BROWSER_INTERNAL_PAGE");
  assert.equal(pageRestriction("https://chromewebstore.google.com/detail/abc"), "EXTENSION_STORE_PAGE");
  assert.equal(pageRestriction("https://chrome.google.com/webstore/detail/abc"), "EXTENSION_STORE_PAGE");
  assert.equal(pageRestriction("https://microsoftedge.microsoft.com/addons/detail/abc"), "EXTENSION_STORE_PAGE");
  assert.equal(pageRestriction("file:///C:/page.html"), "NOT_A_WEB_PAGE");
  assert.equal(pageRestriction("data:text/html,hi"), "NOT_A_WEB_PAGE");
});

test("ordinary pages — including look-alike hosts — are capturable", () => {
  assert.equal(pageRestriction("https://example.com/article"), null);
  assert.equal(pageRestriction("https://chromewebstore.google.com.evil.example/detail"), null);
  assert.equal(pageRestriction("https://evilchromewebstore.google.com/detail"), null);
  assert.equal(pageRestriction("https://chrome.google.com/search"), null);
  assert.equal(pageRestriction("https://microsoftedge.microsoft.com/other"), null);
  assert.equal(pageRestriction(null), null);
});

test("the browser's own scripting refusals are recognised", () => {
  assert.equal(isRestrictedScriptingError(new Error("Cannot access a chrome:// URL")), true);
  // Edge's own wording, observed in Edge 14x (the acceptance found it).
  assert.equal(isRestrictedScriptingError(new Error("Cannot access chrome:// and edge:// URLs")), true);
  assert.equal(isRestrictedScriptingError(new Error("Cannot access a chrome-extension:// URL of different extension")), true);
  assert.equal(isRestrictedScriptingError(new Error("The extensions gallery cannot be scripted.")), true);
  assert.equal(isRestrictedScriptingError(new Error("Frame with ID 0 was removed.")), false);
});

test("each new failure reason has its own stable sentence", () => {
  const base = { state: "FAILED", outcome: "NOTHING_SAVED", cancelRequested: false };
  const store = statusLine({ ...base, reason: "RESTRICTED_PAGE", denial: "EXTENSION_STORE_PAGE" });
  assert.match(store.text, /extension store pages/);
  const internal = statusLine({ ...base, reason: "RESTRICTED_PAGE", denial: "BROWSER_INTERNAL_PAGE" });
  assert.match(internal.text, /browser page/);
  assert.match(statusLine({ ...base, reason: "TAB_CHANGED", denial: null }).text, /different tab/);
  assert.match(statusLine({ ...base, reason: "PAGE_NAVIGATED", denial: null }).text, /different address/);
  for (const reason of ["RESTRICTED_PAGE", "TAB_CHANGED", "PAGE_NAVIGATED"]) {
    assert.match(statusLine({ ...base, reason, denial: null }).text, /Nothing was saved|Open the web page/);
  }
  assert.match(statusLine({ state: "RUNNING", step: "retrying", detail: "uploading (attempt 2 of 4)", cancelRequested: false }).text, /retrying/);
});
