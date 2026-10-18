/**
 * ET-PKG-06 — public Verify presents a recorded storage lock as recorded, an
 * expired one as expired, and counts only an OBSERVED lock as a passed signal;
 * the BASIC original verdict names what it checked.
 *
 * Converged 2026-10-18: the rich page no longer builds its own storage
 * presentation from the raw storage fields (buildStoragePresentation).
 * Storage protection is stated once, by the matrix's storage_protection row —
 * the server's statement already distinguishes recorded, expired and observed
 * locks.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../app/verify/[token]/page.tsx", import.meta.url), "utf8");
const basic = readFileSync(new URL("../app/verify/[token]/BasicVerificationView.tsx", import.meta.url), "utf8");

test("ET-PKG-06: storage protection is the matrix row — no client storage badge", () => {
  assert.doesNotMatch(page, /function buildStoragePresentation\(/);
  assert.doesNotMatch(page, /"Immutable Storage Locked"|"Storage Protection Reported"/);
  assert.match(page, /"storage_protection"/);
});

test("ET-PKG-06: only an observed lock is a passed storage signal", () => {
  // 2026-10-08 — the page no longer tallies passed signals into a confidence
  // number at all; storage reads its matrix row. A recorded lock is still
  // never conflated with an observed one.
  assert.doesNotMatch(page, /const passedSignals = \[/);
  assert.doesNotMatch(page, /confidenceScore/);
  assert.doesNotMatch(page, /input\.storageVerified === true \|\| input\.immutableStorage === true/);
});

test("ET-PKG-06: the BASIC original verdict says the stored original is not re-read", () => {
  assert.ok(basic.includes("the stored original is not re-read on this page"));
});
