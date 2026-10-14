/**
 * EVERY REMEDIATION STRING READS IN THE READER'S LANGUAGE (2026-10-14).
 *
 * The server registry is the one authority for what a condition offers and for
 * its English; `REMEDIATION_TEXT_TRANSLATIONS` (shared) carries the reviewed
 * German and Arabic of that exact English. This gate keeps the two in step:
 * every string the registry can project is translated, nothing stale is kept,
 * and no translation (or English) carries internal language.
 */
import { describe, expect, it } from "vitest";

import { REMEDIATION_TEXT_TRANSLATIONS, localizeRemediationText } from "@proovra/shared";

import { allRemediationTexts } from "../src/services/operations/remediation-registry.js";

const INTERNAL: Array<[string, RegExp]> = [
  ["snake_case identifier", /\b[a-z]+(?:_[a-z0-9]+)+\b/],
  ["enum constant", /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/],
  ["code span", /`/],
  ["camelCase field", /\b[a-z]+[A-Z][a-zA-Z]*\b/],
  ["CLI or file name", /\b[a-z]+(?:-[a-z]+){2,}\b|\.ts\b/],
];
const internalIn = (s: string) => INTERNAL.filter(([, re]) => re.test(s)).map(([n]) => n);

describe("remediation copy — en/de/ar", () => {
  const texts = allRemediationTexts();

  it("the registry projects a non-trivial set", () => {
    expect(texts.length).toBeGreaterThan(40);
  });

  it("every projectable string has a reviewed German and Arabic translation", () => {
    expect(texts.filter((t) => !REMEDIATION_TEXT_TRANSLATIONS[t])).toEqual([]);
  });

  it("no translation is kept for a string the registry no longer projects", () => {
    const live = new Set(texts);
    expect(Object.keys(REMEDIATION_TEXT_TRANSLATIONS).filter((k) => !live.has(k))).toEqual([]);
  });

  it("no English, German or Arabic remediation string carries internal language", () => {
    for (const t of texts) {
      expect(internalIn(t), `en: ${t}`).toEqual([]);
      for (const loc of ["de", "ar"] as const) {
        const tr = localizeRemediationText(loc, t)!;
        expect(tr, `${loc}: ${t}`).not.toBe(t);
        expect(internalIn(tr), `${loc}: ${tr}`).toEqual([]);
      }
    }
  });

  it("Arabic translations are Arabic script; German are not English", () => {
    for (const t of texts) {
      expect(localizeRemediationText("ar", t)!, t).toMatch(/[؀-ۿ]/);
    }
  });

  it("English and unknown locales render the server's English", () => {
    const t = texts[0]!;
    expect(localizeRemediationText("en", t)).toBe(t);
    expect(localizeRemediationText("fr", t)).toBe(t);
    expect(localizeRemediationText(null, null)).toBeNull();
  });
});
