/**
 * AUD-37 (2026-10-20) — the capture clients' half of three device-side facts,
 * pinned at source (the device behaviour itself is UNVERIFIED until run on a
 * physical Android phone):
 *   1. a mock location fix is SENT as such, never as an ordinary fix;
 *   2. a single-frame capture a process death interrupted is OFFERED for
 *      review from the durable native ledger, and the ledger is cleared only
 *      when the capture is staged or discarded;
 *   3. the Android service writes that ledger before JS learns of a frame.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(HERE, "..", p), "utf8");

test("the capture paths send the provider's mock flag with the fix (the ONE shared location read)", () => {
  const src = read("src/capture/device-location.ts");
  assert.match(src, /pos\.mocked === true \? \{ providerReportedMock: true \}/);
  // Every native capture path reads location through it; none reads expo-location itself.
  for (const screen of ["app/(stack)/capture.tsx", "app/(stack)/continuous-capture.tsx", "app/(stack)/screen-capture.tsx"]) {
    assert.ok(!/from "expo-location"/.test(read(screen)), screen);
    assert.match(read(screen), /from "\.\.\/\.\.\/src\/capture\/device-location"/, screen);
  }
});

test("the frame screen offers a recovered capture and clears the ledger only when staged or discarded", () => {
  const src = read("app/(stack)/screen-capture.tsx");
  assert.match(src, /const recovered = getRecoveredScreenCapture\(\);/);
  assert.match(src, /dispatch\(\{ type: "STOPPED", frameCount: recovered\.frames\.length, stopReason: recovered\.stopReason \}\)/);
  // Cleared after a successful staging, a terminal refusal, and an explicit reset.
  assert.equal((src.match(/clearScreenCaptureLedger\(\)/g) ?? []).length, 3);
});

test("the Android service records each frame durably before JS is told, and the module refuses to overwrite recovered frames", () => {
  const svc = read("modules/proovra-screen-capture/android/src/main/java/com/proovra/screencapture/ScreenCaptureService.kt");
  const ledgerAt = svc.indexOf("FrameLedgerKeeper.update { frameLedgerWithFrame(it, frames.last(), limitations.toList()) }");
  const notifyAt = svc.indexOf("onFrame?.invoke(index, frames.size, FRAME_CAPTURED)", ledgerAt);
  assert.ok(ledgerAt > 0 && notifyAt > ledgerAt);
  assert.match(svc, /fun lastOutcome\(\): ScreenCaptureOutcome\? = last \?: recoveredOutcome\(\)/);
  const mod = read("modules/proovra-screen-capture/android/src/main/java/com/proovra/screencapture/ProovraScreenCaptureModule.kt");
  assert.match(mod, /RECOVERY_PENDING/);
  assert.match(mod, /Function\("getRecoveredScreenCapture"\)/);
});

test("continuous staging states every lost segment BEFORE the manifest is fixed", () => {
  const src = read("src/continuous-capture.ts");
  const lossAt = src.indexOf("await stateLostSegments(session, reconciliation.missingSequences);");
  const manifestAt = src.indexOf("manifestJson = JSON.stringify(buildContinuousManifest(");
  assert.ok(lossAt > 0 && manifestAt > lossAt);
  // A never-declared segment is the same truth (PART_NOT_DECLARED); anything else stops the staging.
  assert.match(src, /code === "PART_NOT_DECLARED"\) continue;\n\s+throw err;/);
});
