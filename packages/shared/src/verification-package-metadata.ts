export type VerificationPackageMetadata = {
  manifestPresent: boolean;
  signedManifestPresent: boolean;
  checksumIndexPresent: boolean;
  auditExportIncluded?: boolean;
  custodyExportIncluded?: boolean;
  accessExportIncluded?: boolean;
  packageVersion: "v1";
  generatedAtUtc: string;
  inspectedAtUtc?: string;
  source: "GENERATION" | "ZIP_INSPECTION";
};
