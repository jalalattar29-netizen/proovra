/**
 * ET-PKG-06 — public Verify presents a recorded storage lock as recorded, an
 * expired one as expired, and counts only an OBSERVED lock as a passed signal;
 * the BASIC original verdict names what it checked.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../app/verify/[token]/page.tsx", import.meta.url), "utf8");
const basic = readFileSync(new URL("../app/verify/[token]/BasicVerificationView.tsx", import.meta.url), "utf8");
const presentation = page.slice(page.indexOf("function buildStoragePresentation("), page.indexOf("function describeSnapshotSource("));

test("ET-PKG-06: expired retention and a recorded lock are presented as such, before the success badge", () => {
  const expired = presentation.indexOf('"Retention Expired"');
  const recorded = presentation.indexOf('"Immutable Storage Recorded"');
  const locked = presentation.indexOf('"Immutable Storage Locked"');
  assert.ok(expired > 0 && recorded > expired && locked > recorded);
  assert.match(presentation, /const recorded = storage\?\.source === "RECORDED";/);
});

test("ET-PKG-06: only an observed lock is a passed storage signal", () => {
  assert.match(page, /\/\/ signal; a recorded snapshot is not\.\s*input\.storageVerified === true,\s*\]\.filter\(Boolean\)\.length;/);
  assert.doesNotMatch(page, /input\.storageVerified === true \|\| input\.immutableStorage === true/);
});

test("ET-PKG-06: the BASIC original verdict says the stored original is not re-read", () => {
  assert.ok(basic.includes("the stored original is not re-read on this page"));
});
