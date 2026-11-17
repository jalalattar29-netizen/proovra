/**
 * T-17 / RC-17 — every advertised locale is actually translated.
 *
 * THE DEFECT
 * ----------
 * `supportedLocales` advertised fr, es, tr and ru, and each of their dictionary
 * blocks was a copy of the English one under a "Placeholder - all keys
 * fallback to EN" comment. Choosing French left the whole product in English
 * while the language picker said French — on both platforms, since the web and
 * native read the same `packages/shared/src/i18n.ts`.
 *
 * The four blocks are now translated. This guard makes the placeholder state
 * impossible to reintroduce: a supported locale whose values are mostly the
 * English strings fails, whatever its comment says.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dict, supportedLocales } from "@proovra/shared";

// Words that are the same in several languages (brand, "Video", loanwords such
// as "Teams" or "Dashboard"). German, a real translation, shares 4 of 42.
// B2A-F-12 (2026-11-17) — the dictionary grew from 89 to 838 keys with the web
// shell, Home, Search, support and lead-form copy, so the bound is now a SHARE
// of the keys: German and French, real translations, share ~2.4% (Workflow,
// Audio, Photo, Document, Trust Center…); a placeholder copy shares ~100%.
// Values with no letters (separators, arrows, "{greeting}, {name}") are the
// same in every language and are not counted.
const MAX_IDENTICAL_TO_ENGLISH = 6;
const MAX_IDENTICAL_SHARE = 0.04;

test("every supported locale has every English key", () => {
  const keys = Object.keys(dict.en);
  for (const loc of supportedLocales) {
    assert.deepEqual(Object.keys(dict[loc]), keys, `${loc} is missing or reorders keys`);
  }
});

test("no supported locale is English under another name", () => {
  const keys = Object.keys(dict.en);
  for (const loc of supportedLocales) {
    if (loc === "en") continue;
    const same = keys.filter(
      (k) => dict[loc][k] === dict.en[k] && /\p{L}/u.test(dict.en[k].replace(/\{\w+\}/g, "")),
    );
    assert.ok(
      same.length <= Math.max(MAX_IDENTICAL_TO_ENGLISH, Math.floor(keys.length * MAX_IDENTICAL_SHARE)),
      `${loc} returns English for ${same.length}/${keys.length} keys (${same.join(", ")})`,
    );
  }
});

test("every value is non-empty", () => {
  for (const loc of supportedLocales) {
    for (const [k, v] of Object.entries(dict[loc])) assert.ok(typeof v === "string" && v.trim().length > 0, `${loc}.${k}`);
  }
});
