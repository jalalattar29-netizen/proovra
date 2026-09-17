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
const provenanceLoaderSrc = readFileSync(
  fileURLToPath(
    new URL("../src/capture-trust/load-provenance-chain.ts", import.meta.url),
  ),
  "utf8",
);

// UC-0 — the method label comes from the record's acquisition authority.
const INTAKE = { acquisitionMode: "SECURE_INTAKE_LINK", isIntake: true };
const WEB = { acquisitionMode: "PROOVRA_WEB_UPLOAD", isIntake: false };
const LEGACY = { acquisitionMode: null, isIntake: false };
const MOBILE = { acquisitionMode: "PROOVRA_MOBILE_APP", isIntake: false };

describe("resolveCustodyCapturePresentation", () => {
  it("intake: MULTIPART_PACKAGE → Secure Intake Link + Multipart evidence package", () => {
    const r = resolveCustodyCapturePresentation("MULTIPART_PACKAGE", INTAKE);
    expect(r.method).toBe("Secure Intake Link");
    expect(r.structure).toBe("Multipart evidence package");
  });

  it("web upload: MULTIPART_PACKAGE → PROOVRA Web Upload + Multipart evidence package", () => {
    const r = resolveCustodyCapturePresentation("MULTIPART_PACKAGE", WEB);
    expect(r.method).toBe("PROOVRA Web Upload");
    expect(r.structure).toBe("Multipart evidence package");
  });

  it("the structure enum never decides the method (UC-0)", () => {
    // A legacy record whose acquisition was never recorded does NOT become a
    // web upload just because its structure snapshot says MULTIPART_PACKAGE.
    expect(resolveCustodyCapturePresentation("MULTIPART_PACKAGE", LEGACY).method).toBe(
      "Not recorded",
    );
    expect(resolveCustodyCapturePresentation("SECURE_CAMERA", LEGACY).method).toBe(
      "Not recorded",
    );
    expect(resolveCustodyCapturePresentation("UPLOADED_FILE", MOBILE).method).toBe(
      "PROOVRA Mobile App",
    );
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
    const out = normalizeCustodyEventPayloadForPresentation(payload, INTAKE) as Record<
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
      WEB,
    ) as Record<string, unknown>;
    expect(out.captureMethod).toBe("PROOVRA Web Upload");
    expect(JSON.stringify(out)).not.toContain("MULTIPART_PACKAGE");
  });

  it("leaves non-capture payloads untouched", () => {
    const payload = { phase: "verify_viewed", viewer: "reviewer" };
    const out = normalizeCustodyEventPayloadForPresentation(payload, INTAKE);
    expect(out).toBe(payload);
  });

  it("relabels a legacy intake_authorization only for a recorded web upload", () => {
    const payload = { uploadKind: "intake_authorization" };
    expect(
      (normalizeCustodyEventPayloadForPresentation(payload, WEB) as Record<string, unknown>)
        .uploadKind,
    ).toBe("web_upload_authorization");
    expect(
      (normalizeCustodyEventPayloadForPresentation(payload, LEGACY) as Record<string, unknown>)
        .uploadKind,
    ).toBe("upload_authorization");
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

describe("provenance chain (UC-0)", () => {
  it("the package loader uses THE shared projection, not a worker copy", () => {
    // The worker-local projector (which inferred the mode from uploadSource)
    // was deleted; the loader delegates to @proovra/shared-runtime.
    expect(provenanceLoaderSrc).toContain('from "@proovra/shared-runtime"');
    expect(provenanceLoaderSrc).toContain("loadProvenanceChain(prisma, evidenceId)");
    expect(provenanceLoaderSrc).not.toMatch(/^import .*provenance-projection/m);
  });

  it("processor threads the acquisition snapshot into custody display and the report row", () => {
    expect(processorSrc).toContain("acquisitionModeSnapshot:");
    expect(processorSrc).toContain(
      "acquisitionMode: effectiveReportEvidencePayload.acquisitionMode ?? null",
    );
  });
});
