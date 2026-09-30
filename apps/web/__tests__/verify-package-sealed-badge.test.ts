/**
 * ET-PKG-05 — the public Verify package badge rests on the seal.
 *
 * "Package Integrity Complete / Independent Review Enabled" was computed from
 * artifact-presence flags alone, so an unsealed legacy package got the success
 * badge; and a package that EXISTED but was partial was described as absent.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../app/verify/[token]/page.tsx", import.meta.url), "utf8");
const card = page.slice(page.indexOf("function VerificationPackageIntegrityCard("));

test("ET-PKG-05: complete requires a sealed package; an unsealed one is named as such", () => {
  assert.match(card, /const unsealed = integrity\.available && integrity\.sealed !== true;/);
  assert.match(card, /const complete =\s*integrity\.available &&\s*integrity\.sealed === true &&/);
  assert.ok(card.includes('"Legacy Package — Not Sealed"'));
  assert.ok(card.includes('unsealed ? "Not Sealed"'));
});

test("ET-PKG-05: a package that exists but is not complete is not described as absent", () => {
  assert.ok(card.includes("A package exists for this record, but it is not confirmed here as a complete sealed set"));
});

test("ET-PKG-05: the server's sealed state reaches the card", () => {
  assert.match(page, /sealed: server\?\.sealed === true,/);
});
