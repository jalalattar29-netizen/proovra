/**
 * AUD-22 (2026-10-20) — A CAPTURE WINDOW THAT CANNOT BE TRUE IS REFUSED.
 *
 * Characterization (before): the web and screen manifest validators accepted
 * any two parseable times — a start after the end, an end in the future, a
 * start days before the session. A capture may precede its session (the
 * extension captures, then opens the session to deliver), within a bound.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  captureWindowProblem,
  CAPTURE_PRE_SESSION_ALLOWANCE_MS,
  validateWebCaptureManifest,
} from "../dist/index.js";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const iso = (ms) => new Date(NOW.getTime() + ms).toISOString();

test("a plausible window passes, including a capture shortly before its session", () => {
  assert.equal(captureWindowProblem(iso(-60_000), iso(-30_000), { now: NOW, sessionStartedAtUtc: iso(-20_000) }), null);
  assert.equal(captureWindowProblem(iso(-5 * 60_000), iso(-4 * 60_000), { now: NOW, sessionStartedAtUtc: iso(-60_000) }), null);
});

test("start after end, a future end, or a start long before the session is refused", () => {
  assert.match(captureWindowProblem(iso(-1000), iso(-2000), { now: NOW }), /after/);
  assert.match(captureWindowProblem(iso(-1000), iso(60 * 60_000), { now: NOW }), /future/);
  assert.match(
    captureWindowProblem(iso(-CAPTURE_PRE_SESSION_ALLOWANCE_MS - 120_000), iso(-60_000), { now: NOW, sessionStartedAtUtc: iso(-60_000) }),
    /before the capture session/,
  );
});

test("the web manifest validator applies the window check", () => {
  const manifest = (start, end) => ({
    schemaVersion: "PROOVRA_WEB_CAPTURE_MANIFEST_V1",
    captureMode: "VIEWPORT",
    captureSessionId: "11111111-1111-4111-8111-111111111111",
    captureStartedAtUtc: start,
    captureEndedAtUtc: end,
  });
  const reversed = validateWebCaptureManifest(manifest(iso(-1000), iso(-5000)), { now: NOW });
  assert.equal(reversed.ok, false);
  assert.match(reversed.error, /after captureEndedAtUtc/);
});

test("the extension statement does not place the capture inside the session (AUD-22)", async () => {
  const { resolveEvidenceAcquisition } = await import("../dist/index.js");
  const a = resolveEvidenceAcquisition({ acquisitionMode: "DIRECT_WEB_CAPTURE_EXTENSION", acquisitionModeSource: "RECORDED_AT_CREATION" });
  assert.doesNotMatch(a.statement, /captured this web page, in a server-issued capture session/);
  assert.match(a.statement, /captured this web page and delivered it in a server-issued capture session/);
});
