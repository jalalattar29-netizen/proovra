/**
 * PRO-NA2Z-02 (WS-BILL, 2026-11-18) — ProovraSheet calls `onDismiss` on every
 * platform, exactly once.
 *
 * Billing opens the next sheet and every checkout / approval page ONLY from a
 * sheet's `onDismiss`. React Native's Modal documents that callback for iOS; the
 * test stub's Modal (like Android) never calls it. Off iOS the sheet now calls it
 * after the close animation; on iOS the native callback stays the only caller.
 */
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let P;

before(async () => {
  P = await loadModule("src/ui/patterns.tsx", ["test/support/providers.tsx"]);
});

afterEach(() => {
  delete globalThis.__RN_OS__;
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function closeSheet() {
  let calls = 0;
  const sheet = (visible) =>
    h(P.TestProviders, null, h(P.ProovraSheet, { visible, title: "Pricing", onClose: () => {}, onDismiss: () => (calls += 1) }, null));
  const view = await renderComponent(sheet(true));
  await view.update(sheet(false));
  await act(async () => {
    await wait(P.SHEET_DISMISS_FALLBACK_MS + 50);
  });
  // A re-render while hidden must not call it again.
  await view.update(sheet(false));
  await act(async () => {
    await wait(P.SHEET_DISMISS_FALLBACK_MS + 50);
  });
  view.unmount();
  return calls;
}

test("Android: closing the sheet hands off through onDismiss exactly once", async () => {
  globalThis.__RN_OS__ = "android";
  assert.equal(await closeSheet(), 1);
});

test("iOS: unchanged — only the native Modal callback calls onDismiss", async () => {
  globalThis.__RN_OS__ = "ios";
  assert.equal(await closeSheet(), 0);
});
