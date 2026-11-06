/**
 * MOBILE-014 — the browser chrome colour is one value, and it is a token.
 *
 * Every page's <meta name="theme-color"> was #FFFFFF while the installed PWA's
 * manifest said #0B1F5E, a colour the design system does not name; the same
 * product was tinted two ways depending on how it was opened.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the manifest and the page head declare the same theme colour, and the design system names it", () => {
  const manifest = JSON.parse(read("../public/manifest.webmanifest")) as { theme_color: string };
  const head = /<meta name="theme-color" content="(#[0-9A-Fa-f]{6})"/.exec(read("../app/layout.tsx"))?.[1];
  assert.equal(manifest.theme_color.toUpperCase(), head?.toUpperCase());
  assert.match(read("../../../docs/architecture/design-system.md"), new RegExp(`theme-color.*${manifest.theme_color}`, "i"));
});
