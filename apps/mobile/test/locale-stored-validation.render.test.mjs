/**
 * F-P1-13 — a stored MANUAL locale is honoured only when this build supports
 * it (the web validates `proovra-locale` the same way, apps/web/lib/i18n.ts).
 *
 * Real LocaleProvider over the AsyncStorage stub (device language en-US).
 * RED on the pre-remediation tree: a stored "xx" became the active locale.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;

before(async () => {
  M = await loadModule("src/locale-context.tsx", ["test/support/expo-stub.mjs", "src/i18n.ts"]);
});
beforeEach(async () => {
  await M.AsyncStorage.__reset?.();
});

async function activeLocale() {
  let seen = null;
  function Probe() {
    seen = M.useLocale();
    return null;
  }
  const r = await renderComponent(h(M.LocaleProvider, null, h(Probe)));
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  r.unmount();
  return { locale: seen?.locale, mode: seen?.mode };
}

test("F-P1-13: a supported manual choice is honoured", async () => {
  await M.AsyncStorage.setItem("proovra-locale-mode", "manual");
  await M.AsyncStorage.setItem("proovra-locale", "de");
  assert.deepEqual(await activeLocale(), { locale: "de", mode: "manual" });
});

test("F-P1-13: an unsupported stored locale falls back to the device language", async () => {
  await M.AsyncStorage.setItem("proovra-locale-mode", "manual");
  await M.AsyncStorage.setItem("proovra-locale", "xx");
  assert.deepEqual(await activeLocale(), { locale: "en", mode: "auto" });
});

test("F-P1-13: storedManualLocale (pure)", () => {
  assert.equal(M.storedManualLocale("manual", "ar"), "ar");
  assert.equal(M.storedManualLocale("manual", "pt"), null);
  assert.equal(M.storedManualLocale("auto", "ar"), null);
  assert.equal(M.storedManualLocale(null, null), null);
});
