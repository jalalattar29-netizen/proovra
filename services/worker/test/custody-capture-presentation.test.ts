/**
 * Custody capture-method presentation — intake structure/method split.
 *
 * `completeEvidence` overwrites capture_method to the STRUCTURE enum
 * MULTIPART_PACKAGE, and that raw value is copied into the
 * `captureMethodSnapshot` custody-event payload. It must never render as a
 * reviewer-facing "Capture:" label nor leak into the exported custody JSON.
 *
 * Pins:
 *   * resolveCustodyCapturePresentation splits raw → { method, structure }.
 *   * normalizeCustodyEventPayloadForPresentation replaces the raw enum with
 *     the role-safe method + adds an evidenceStructureSnapshot structure label
 *     (event hash untouched).
 *   * summarizePayloadForReport (REPORT_GENERATED) renders
 *     "Capture: Secure Intake Link • Structure: Multipart evidence package"
 *     for intake — never "Capture: MULTIPART_PACKAGE".
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  resolveCustodyCapturePresentation,
  normalizeCustodyEventPayloadForPresentation,
  mapEvidenceStructureLabel,
} from "../src/report-v2/normalizers.js";

const processorSrc = readFileSync(
  fileURLToPath(new URL("../src/processor.ts", import.meta.url)),
  "utf8",
);
const workerProjectorSrc = readFileSync(
  fileURLToPath(
    new URL("../src/capture-trust/provenance-projection.ts", import.meta.url),
  ),
  "utf8",
);

describe("resolveCustodyCapturePresentation", () => {
  it("intake: MULTIPART_PACKAGE → Secure Intake Link + Multipart evidence package", () => {
    const r = resolveCustodyCapturePresentation("MULTIPART_PACKAGE", true);
    expect(r.method).toBe("Secure Intake Link");
    expect(r.structure).toBe("Multipart evidence package");
  });

  it("capture: MULTIPART_PACKAGE → PROOVRA Web Upload + Multipart evidence package", () => {
    const r = resolveCustodyCapturePresentation("MULTIPART_PACKAGE", false);
    expect(r.method).toBe("PROOVRA Web Upload");
    expect(r.structure).toBe("Multipart evidence package");
  });

  it("BULK_IMPORT maps to a structure label", () => {
    expect(mapEvidenceStructureLabel("BULK_IMPORT")).toBe("Bulk import set");
    expect(mapEvidenceStructureLabel("SECURE_CAMERA")).toBeNull();
  });
});

describe("normalizeCustodyEventPayloadForPresentation", () => {
  it("replaces raw captureMethodSnapshot enum with method + adds structure", () => {
    const payload = {
      phase: "report_generated",
      reportVersion: 3,
      captureMethodSnapshot: "MULTIPART_PACKAGE",
      identityLevelSnapshot: "ORGANIZATION_ACCOUNT",
    };
    const out = normalizeCustodyEventPayloadForPresentation(payload, true) as Record<
      string,
      unknown
    >;
    expect(out.captureMethodSnapshot).toBe("Secure Intake Link");
    expect(out.evidenceStructureSnapshot).toBe("Multipart evidence package");
    // Raw enum must be gone entirely from the presentation payload.
    expect(JSON.stringify(out)).not.toContain("MULTIPART_PACKAGE");
    // Unrelated fields preserved.
    expect(out.reportVersion).toBe(3);
    expect(out.identityLevelSnapshot).toBe("ORGANIZATION_ACCOUNT");
  });

  it("also normalizes a payload.captureMethod key", () => {
    const out = normalizeCustodyEventPayloadForPresentation(
      { captureMethod: "MULTIPART_PACKAGE" },
      false,
    ) as Record<string, unknown>;
    expect(out.captureMethod).toBe("PROOVRA Web Upload");
    expect(JSON.stringify(out)).not.toContain("MULTIPART_PACKAGE");
  });

  it("leaves non-capture payloads untouched", () => {
    const payload = { phase: "verify_viewed", viewer: "reviewer" };
    const out = normalizeCustodyEventPayloadForPresentation(payload, true);
    expect(out).toBe(payload);
  });
});

describe("processor render wiring (REPORT_GENERATED custody summary)", () => {
  it("renders capture via the role-safe presentation, not the raw snapshot", () => {
    // The old bug rendered the raw enum directly.
    expect(processorSrc).not.toContain("Capture: ${captureMethodSnapshot}");
    // The fixed render resolves method + structure and emits both lines.
    expect(processorSrc).toContain("resolveCustodyCapturePresentation");
    expect(processorSrc).toContain("`Capture: ${capturePresentation.method}`");
    expect(processorSrc).toContain(
      "`Structure: ${capturePresentation.structure}`",
    );
  });

  it("threads isIntake into both custody display contexts", () => {
    expect(processorSrc).toContain(
      "isIntake: reportAcquisition?.isIntake === true",
    );
    expect(processorSrc).toContain(
      "isIntake: finalizedReportAcquisition?.isIntake === true",
    );
  });

  it("normalizes the exported custody array before the package build", () => {
    expect(processorSrc).toContain(
      "normalizeCustodyEventPayloadForPresentation(",
    );
  });

  it("threads isIntake into both trust-decision builds", () => {
    expect(processorSrc).toContain(
      "isIntake: reportAcquisition?.isIntake === true",
    );
    expect(processorSrc).toContain(
      "isIntake: finalizedReportAcquisition?.isIntake === true",
    );
  });
});

describe("provenance projector capture mode (non-intake)", () => {
  it("derives a real acquisition mode from uploadSource, never BULK_IMPORT by default", () => {
    expect(workerProjectorSrc).toContain("deriveNonIntakeCaptureMode");
    // Web upload → PROOVRA_WEB_UPLOAD (not BULK_IMPORT).
    expect(workerProjectorSrc).toMatch(
      /case "WEB_APP":\s*\n\s*return "PROOVRA_WEB_UPLOAD"/,
    );
    // Only genuinely-absent / import channels fall through to BULK_IMPORT.
    expect(workerProjectorSrc).toMatch(/default:\s*\n\s*return "BULK_IMPORT"/);
    // The default mode is no longer an unconditional BULK_IMPORT for non-intake.
    expect(workerProjectorSrc).not.toContain(
      'isIntakeEvidence ? "SECURE_INTAKE_LINK" : "BULK_IMPORT"',
    );
  });
});
