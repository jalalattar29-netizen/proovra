/**
 * INGEST-007 (decided 2026-11-07) — PROOVRA ships no malware scanner, and no
 * surface may say files are scanned when none is connected.
 *
 * MALWARE_SCANNING_ENABLED with only the built-in no-op scanner records SKIPPED
 * rows and scans nothing, so the Security Center summary reports scanning as
 * enabled only when a real scanner is wired (setActiveScanner) AND the flag is on.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  isMalwareScannerConnected,
  isMalwareScanningEnabled,
  setActiveScanner,
} from "../src/services/security/file-security-scan.service.js";

const saved = process.env.MALWARE_SCANNING_ENABLED;
afterEach(() => {
  if (saved === undefined) delete process.env.MALWARE_SCANNING_ENABLED;
  else process.env.MALWARE_SCANNING_ENABLED = saved;
});

/** What GET /v1/security/summary reports (security.routes.ts). */
const reported = () => isMalwareScanningEnabled() && isMalwareScannerConnected();

describe("INGEST-007 — scanning is reported only when something scans", () => {
  it("the flag alone, with no scanner connected, is not scanning", () => {
    process.env.MALWARE_SCANNING_ENABLED = "true";
    expect(isMalwareScannerConnected()).toBe(false);
    expect(reported()).toBe(false);
  });

  it("a connected scanner with the flag on is scanning; with the flag off it is not", () => {
    const restore = setActiveScanner(async () => ({ status: "CLEAN", scanner: "test-scanner" }));
    try {
      process.env.MALWARE_SCANNING_ENABLED = "true";
      expect(reported()).toBe(true);
      process.env.MALWARE_SCANNING_ENABLED = "false";
      expect(reported()).toBe(false);
    } finally {
      restore();
    }
    expect(isMalwareScannerConnected()).toBe(false);
  });
});
