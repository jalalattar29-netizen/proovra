import type { C2paEvidenceSummary } from "./c2pa.js";

export type VerificationPackageMetadata = {
  manifestPresent: boolean;
  signedManifestPresent: boolean;
  checksumIndexPresent: boolean;
  offlineVerifierIncluded: boolean;
  auditExportIncluded?: boolean;
  custodyExportIncluded?: boolean;
  accessExportIncluded?: boolean;
  packageVersion: "v1";
  generatedAtUtc: string;
  inspectedAtUtc?: string;
  source: "GENERATION" | "ZIP_INSPECTION";
  /**
   * Phase M2 — bounded C2PA provenance summary. Additive and
   * optional; absent on legacy records / pre-M2 generations. This
   * field is a PROJECTION of the bundled `provenance/c2pa-summary.json`
   * file inside the Verification Package and is mirrored here so API
   * surfaces can render the same data without re-fetching the ZIP.
   */
  c2pa?: C2paEvidenceSummary | null;
};
