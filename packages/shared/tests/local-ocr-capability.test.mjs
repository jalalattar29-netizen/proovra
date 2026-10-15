/**
 * AUD-019 — the local OCR capability is the WORKER's report, never a constant.
 * The API projects the newest heartbeat report through these pure rules: a
 * stale or missing report is NOT_REPORTED (never "enabled", never "not
 * enabled"), an engine without any requested model cannot run.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseLocalOcrCapabilityReport,
  projectLocalOcrCapability,
} from "../dist/local-ocr-capability.js";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const MAX_AGE = 15 * 60 * 1000;
const report = (over = {}) => ({
  localOcr: {
    engine: "tesseract",
    available: true,
    version: "5.5.1",
    installedLanguages: ["ara", "deu", "eng"],
    requested: "deu+eng+ara",
    effective: "deu+eng+ara",
    missing: [],
    observedAtUtc: "2026-10-15T11:59:00.000Z",
    ...over,
  },
});

test("a fresh report of the engine with all models is AVAILABLE with the languages that run", () => {
  const v = projectLocalOcrCapability(parseLocalOcrCapabilityReport(report()), NOW, MAX_AGE);
  assert.deepEqual(v, {
    state: "AVAILABLE",
    version: "5.5.1",
    effectiveLanguages: "deu+eng+ara",
    missingLanguages: [],
    reportedAtUtc: "2026-10-15T11:59:00.000Z",
  });
});

test("no report, a malformed report, or a stale one is NOT_REPORTED", () => {
  assert.deepEqual(projectLocalOcrCapability(parseLocalOcrCapabilityReport({ buildRevision: "x" }), NOW, MAX_AGE), {
    state: "NOT_REPORTED",
  });
  assert.equal(parseLocalOcrCapabilityReport({ localOcr: { engine: "other", available: true } }), null);
  assert.equal(parseLocalOcrCapabilityReport(report({ observedAtUtc: "not a date" })), null);
  const stale = parseLocalOcrCapabilityReport(report({ observedAtUtc: "2026-10-15T11:00:00.000Z" }));
  assert.deepEqual(projectLocalOcrCapability(stale, NOW, MAX_AGE), { state: "NOT_REPORTED" });
});

test("engine missing and no installed requested model are distinct states", () => {
  assert.equal(
    projectLocalOcrCapability(parseLocalOcrCapabilityReport(report({ available: false, version: null, effective: null })), NOW, MAX_AGE).state,
    "ENGINE_UNAVAILABLE",
  );
  const v = projectLocalOcrCapability(
    parseLocalOcrCapabilityReport(report({ installedLanguages: [], effective: null, missing: ["deu", "eng", "ara"] })),
    NOW,
    MAX_AGE,
  );
  assert.equal(v.state, "LANGUAGE_UNAVAILABLE");
  assert.deepEqual(v.missingLanguages, ["deu", "eng", "ara"]);
});

test("language tokens from the metadata are bounded to model-name shape", () => {
  const r = parseLocalOcrCapabilityReport(report({ missing: ["deu", "<script>", 7] }));
  assert.deepEqual(r.missing, ["deu"]);
});
