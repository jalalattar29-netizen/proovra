/**
 * Web Capture custody wording — "initial browser upload location".
 *
 * The UPLOAD_AUTHORIZED custody event written by createEvidence() used a single
 * hard-coded `meaning` of "initial intake location". That is misleading for a
 * normal Web Capture / Browser Upload (it is NOT an Intake Link submission).
 * createEvidence() is SHARED by Web Capture, the mobile direct-capture session
 * and Intake. UC-0 replaced the boolean `browserUpload` flag with the
 * server-authoritative `acquisitionMode`, so the wording is keyed by the mode
 * each caller declares: web → "browser upload", intake → "intake", mobile app →
 * "mobile app upload".
 *
 * This is a WRITER-only change (future events); historical custody events and
 * the hash-chain logic are untouched.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { enclosingSource } from "../../../scripts/source-contract/index.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), "utf8");

describe("Web Capture custody wording — initial browser upload location", () => {
  const service = read("services/api/src/services/evidence.service.ts");

  it("createEvidence keys the UPLOAD_AUTHORIZED meaning on the acquisition mode", () => {
    expect(service).not.toMatch(/browserUpload/);
    expect(service).toMatch(/acquisitionMode: EvidenceAcquisitionMode;/);
    expect(service).toContain(
      "A presigned upload URL was issued for the initial ${UPLOAD_LOCATION_BY_ACQUISITION[params.acquisitionMode]} location.",
    );
    expect(service).toMatch(/PROOVRA_WEB_UPLOAD: "browser upload"/);
    expect(service).toMatch(/SECURE_INTAKE_LINK: "intake"/);
    expect(service).toMatch(/PROOVRA_MOBILE_APP: "mobile app upload"/);
  });

  it("POST /v1/evidence (Web Capture) declares PROOVRA_WEB_UPLOAD", () => {
    const route = read("services/api/src/routes/evidence.routes.ts");
    const block = enclosingSource(route, "const result = await createEvidence({", "statement", {
      unique: true,
      fileName: "evidence.routes.ts",
    });
    expect(block).toMatch(/acquisitionMode:\s*"PROOVRA_WEB_UPLOAD"/);
  });

  it("Intake and the mobile session declare their own modes", () => {
    const intake = read(
      "services/api/src/services/external-intake-orchestration.service.ts",
    );
    expect(
      enclosingSource(intake, "createEvidence({", "call", {
        unique: true,
        fileName: "external-intake-orchestration.service.ts",
      }),
    ).toMatch(/acquisitionMode:\s*"SECURE_INTAKE_LINK"/);

    const mobile = read(
      "services/api/src/services/capture-trust/direct-capture-ingest.service.ts",
    );
    expect(
      enclosingSource(mobile, "createEvidence({", "call", {
        unique: true,
        fileName: "direct-capture-ingest.service.ts",
      }),
    ).toMatch(/acquisitionMode:/);
  });
});
