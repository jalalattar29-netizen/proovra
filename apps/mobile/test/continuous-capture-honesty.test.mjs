/**
 * T-18 / RC-18 — continuous capture must not claim to seal.
 *
 * The review control was labelled "Finish & Sign" and its copy said it "seals
 * these segments into one evidence record", while the module stages and
 * Capture's Finish & Sign is the one sealing action (F-08). A failed staging
 * said only "Could not finalize the evidence." and offered "Try Again" — which
 * in fact starts a brand-new recording. The draft item's size was a hard-coded 0.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule } from "./support/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(HERE, rel), "utf8");
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
let C;

before(async () => {
  C = await loadModule("src/continuous-capture.ts", []);
});

test("only Capture has a control named Finish & Sign; the continuous screen names where it leads", () => {
  const screen = code("../app/(stack)/continuous-capture.tsx");
  assert.ok(!/label="Finish (&amp;|&) Sign"/.test(screen), "the staging control still wears the sealing action's name");
  assert.ok(!/seals these segments into one evidence record/.test(screen), "the screen still claims to seal");
  assert.ok(!/Finalizing — sealing/.test(screen), "the progress label still claims sealing");
  assert.match(C.CONTINUOUS_REVIEW_COPY.action, /^Continue to Finish & Sign$/);
  assert.match(C.CONTINUOUS_REVIEW_COPY.explainer, /opens Capture, where Finish & Sign seals them/);
  assert.match(read("../app/(stack)/capture.tsx"), /label="Finish (&amp;|&) Sign"|Finish & Sign/);
});

test("each staging step fails with its own sentence, and never offers to retry a released session", () => {
  const msgs = Object.values(C.CONTINUOUS_STAGE_FAILURE);
  assert.equal(new Set(msgs).size, 3, "two steps share one failure sentence");
  for (const m of msgs) assert.ok(!/Could not finalize the evidence/.test(m));
  const screen = code("../app/(stack)/continuous-capture.tsx");
  assert.match(screen, /CONTINUOUS_STAGE_FAILURE\[step\]/);
  assert.match(screen, /recoverable: false/, "a finalize failure is still marked retryable");
  assert.match(screen, /label="Start a new recording"/);
  assert.ok(!/"Could not finalize the evidence\."/.test(screen));
});

test("the staged draft carries the real size — the sum of declared segments, not 0", () => {
  assert.equal(C.continuousSessionBytes([{ sizeBytes: 1000 }, { sizeBytes: 2500 }, { sizeBytes: -1 }, { sizeBytes: NaN }]), 3500);
  assert.equal(C.continuousSessionBytes([]), 0);
  const screen = code("../app/(stack)/continuous-capture.tsx");
  assert.ok(!/sizeBytes:\s*0\b/.test(screen), "the draft item size is still hard-coded to 0");
  assert.match(screen, /sizeBytes: continuousSessionBytes\(declaredRef\.current\)/);
});
