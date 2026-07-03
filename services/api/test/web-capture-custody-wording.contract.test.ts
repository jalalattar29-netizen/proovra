/**
 * Web Capture custody wording — "initial browser upload location".
 *
 * The UPLOAD_AUTHORIZED custody event written by createEvidence() used a single
 * hard-coded `meaning` of "initial intake location". That is misleading for a
 * normal Web Capture / Browser Upload (it is NOT an Intake Link submission).
 * createEvidence() is SHARED by Web Capture, Mobile citizen-capture, and Intake,
 * so the wording is branched on a `browserUpload` flag that ONLY the Web Capture
 * route sets. Intake + Mobile keep the existing "initial intake location".
 *
 * This is a WRITER-only change (future events); historical custody events and
 * the hash-chain logic are untouched.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), "utf8");

describe("Web Capture custody wording — initial browser upload location", () => {
  const service = read("services/api/src/services/evidence.service.ts");

  it("createEvidence branches the UPLOAD_AUTHORIZED meaning on browserUpload", () => {
    // The param exists.
    expect(service).toMatch(/browserUpload\?:\s*boolean/);
    // Web wording is used when browserUpload is set.
    expect(service).toMatch(/params\.browserUpload/);
    expect(service).toContain(
      "A presigned upload URL was issued for the initial browser upload location.",
    );
    // Intake/Mobile wording is preserved (the default branch).
    expect(service).toContain(
      "A presigned upload URL was issued for the initial intake location.",
    );
  });

  it("POST /v1/evidence (Web Capture) sets browserUpload: true", () => {
    const route = read("services/api/src/routes/evidence.routes.ts");
    const idx = route.indexOf("const result = await createEvidence({");
    expect(idx).toBeGreaterThan(0);
    const block = route.slice(idx, idx + 1600);
    expect(block).toMatch(/browserUpload:\s*true/);
  });

  it("Intake and Mobile createEvidence callers do NOT set browserUpload", () => {
    const intake = read(
      "services/api/src/services/external-intake-orchestration.service.ts",
    );
    const intakeIdx = intake.indexOf("createEvidence({");
    expect(intakeIdx).toBeGreaterThan(0);
    expect(intake.slice(intakeIdx, intakeIdx + 900)).not.toMatch(/browserUpload/);

    const mobile = read(
      "services/api/src/services/capture-trust/citizen-capture.service.ts",
    );
    const mobileIdx = mobile.indexOf("createEvidence({");
    expect(mobileIdx).toBeGreaterThan(0);
    expect(mobile.slice(mobileIdx, mobileIdx + 900)).not.toMatch(/browserUpload/);
  });
});
