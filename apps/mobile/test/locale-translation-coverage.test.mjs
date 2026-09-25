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
const MAX_IDENTICAL_TO_ENGLISH = 6;

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
    const same = keys.filter((k) => dict[loc][k] === dict.en[k]);
    assert.ok(
      same.length <= MAX_IDENTICAL_TO_ENGLISH,
      `${loc} returns English for ${same.length}/${keys.length} keys (${same.join(", ")})`,
    );
  }
});

test("every value is non-empty", () => {
  for (const loc of supportedLocales) {
    for (const [k, v] of Object.entries(dict[loc])) assert.ok(typeof v === "string" && v.trim().length > 0, `${loc}.${k}`);
  }
});
