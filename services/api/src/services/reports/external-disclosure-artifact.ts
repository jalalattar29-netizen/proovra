/**
 * The companion EXTERNAL_DISCLOSURE package recorded on a verification_packages
 * row (external_disclosure_artifact, migration 20281005000000). One reader for
 * the download routes, the public package record and the artifacts status.
 */
export function readExternalDisclosureArtifact(value: unknown): {
  packageId: string;
  storageKey: string;
  s3VersionId: string | null;
  packageSha256: string | null;
  sizeBytes: string | null;
  sealSha256: string | null;
  sealSigningKeySha256: string | null;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" && x.length > 0 ? x : null);
  const packageId = str(v.packageId);
  const storageKey = str(v.storageKey);
  if (!packageId || !storageKey) return null;
  return {
    packageId,
    storageKey,
    s3VersionId: str(v.s3VersionId),
    packageSha256: str(v.packageSha256),
    sizeBytes: str(v.sizeBytes),
    sealSha256: str(v.sealSha256),
    sealSigningKeySha256: str(v.sealSigningKeySha256),
  };
}

