/**
 * VERIFICATION PACKAGE SEAL — package format 5.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES
 * ---------------------------------------------------------------------------
 * Format 4 signed `package-manifest.json` only, and the manifest is built and
 * serialized BEFORE the report PDF, the intelligence files and the checksum
 * index are appended. No signed field referenced the report bytes, the
 * checksum index, or any entry hash except the evidence parts of a multipart
 * record. Replacing the embedded report and editing its line in the unsigned
 * `package-checksums.json` left a package whose signature still verified.
 *
 * ---------------------------------------------------------------------------
 * FORMAT 5
 * ---------------------------------------------------------------------------
 *   1. Every entry is written; `package-checksums.json` lists every entry
 *      (path, size, SHA-256 of the exact bytes in the ZIP) and is written after
 *      them.
 *   2. `package-seal.json` is the canonical JSON (see `canonicalize`: sorted
 *      keys, no whitespace, UTF-8) of a {@link PackageSeal}. It carries the
 *      SHA-256 of the exact `package-checksums.json` bytes, the certified
 *      report's version, path and SHA-256, and the chronology of the package.
 *   3. `package-seal.sig` carries an Ed25519 signature over the 32 raw bytes
 *      of SHA-256(`package-seal.json` bytes), by the package signer.
 *
 * A verifier checks, in order: the seal signature; the checksum index digest
 * against the seal; every entry against the index; that no entry exists
 * outside the index (other than the index, the seal and its signature); and
 * that the report entry named by the seal hashes to the seal's reportSha256.
 * Any single modified byte in any entry fails one of those checks.
 *
 * What the seal does NOT establish: that the signing key belongs to PROOVRA.
 * The key travels in the package; a reviewer must compare its fingerprint
 * (package-seal.sig signingKeyFingerprint) with the one PROOVRA recorded for
 * that package — Public Verify serves it, with the SHA-256 of the exact package
 * file (ET-PKG-02). A key found only inside the package vouches for nothing.
 *
 * Pure and platform-free: crypto is injected by the caller.
 */
import { canonicalize } from "./canonical-json.js";

export const PACKAGE_FORMAT_VERSION_SEALED = 5 as const;
export const PACKAGE_CHECKSUMS_FILE = "package-checksums.json";
export const PACKAGE_SEAL_FILE = "package-seal.json";
export const PACKAGE_SEAL_SIGNATURE_FILE = "package-seal.sig";

/** When, relative to its report, a package was assembled. */
export const PACKAGE_ASSEMBLY_KINDS = [
  /** Built by the same run that issued the report. */
  "WITH_REPORT_ISSUE",
  /** Built later for an already-issued report (recovery / first package). */
  "AFTER_REPORT_ISSUE",
] as const;
export type PackageAssemblyKind = (typeof PACKAGE_ASSEMBLY_KINDS)[number];

export type PackageSeal = {
  schema: "PROOVRA_PACKAGE_SEAL";
  sealVersion: 1;
  packageFormatVersion: 5;
  /**
   * The package's immutable identity (2026-10-07): minted before any child
   * document and carried by every one of them and by the package row. Absent
   * on packages sealed before then (their row id still identifies them).
   */
  packageId?: string;
  /** FULL_FORENSIC | EXTERNAL_DISCLOSURE; absent on earlier packages. */
  disclosureProfile?: "FULL_FORENSIC" | "EXTERNAL_DISCLOSURE";
  /** The package this one supersedes (the previous report version's package). */
  supersedesPackageId?: string | null;
  /** For EXTERNAL_DISCLOSURE: the FULL_FORENSIC package of the same version. */
  sourceFullPackageId?: string | null;
  evidenceId: string;
  /** The report version this package certifies. */
  reportVersion: number;
  /**
   * Path of the embedded report PDF inside the ZIP. Null only when the
   * profile withholds the report (EXTERNAL_DISCLOSURE): reportSha256 then
   * commits to the issued report without carrying it.
   */
  reportFile: string | null;
  /** SHA-256 (hex) of the embedded report PDF bytes. */
  reportSha256: string;
  /** When that report was issued (ISO-8601 UTC). */
  reportIssuedAtUtc: string;
  /** When this package was assembled (ISO-8601 UTC). */
  packageAssembledAtUtc: string;
  assembly: PackageAssemblyKind;
  /**
   * Last custody sequence included in the custody materials. Events after it
   * happened after the report was issued and are not in this package.
   */
  custodyThroughSequence: number | null;
  /**
   * When the TSA/OTS materials in this package were READ from the record.
   * For an AFTER_REPORT_ISSUE package this is later than the report: a proof
   * that improved after issuance appears here as a later fact, and the
   * embedded report still says what was true when it was issued.
   */
  proofMaterialsObservedAtUtc: string;
  /** SHA-256 of the original evidence (as signed at finalization). */
  fileSha256: string | null;
  /** SHA-256 of the canonical fingerprint signed at finalization. */
  fingerprintHash: string | null;
  checksumsFile: typeof PACKAGE_CHECKSUMS_FILE;
  /** SHA-256 (hex) of the exact `package-checksums.json` bytes. */
  checksumsSha256: string;
  /** Number of entries listed in the checksum index. */
  fileCount: number;
};

export type PackageSealSignature = {
  schema: "PROOVRA_PACKAGE_SEAL_SIGNATURE";
  version: 1;
  signedFile: typeof PACKAGE_SEAL_FILE;
  digestAlgorithm: "SHA-256";
  signatureAlgorithm: "ED25519" | "ED25519_SHA_512";
  /** SHA-256 (hex) of the exact `package-seal.json` bytes. */
  sealSha256: string;
  signatureBase64: string;
  signingKeyId: string | null;
  signingKeyVersion: string | null;
  /** SHA-256 (hex) of the DER SubjectPublicKeyInfo of the signing key. */
  signingKeyFingerprint: string | null;
  publicKeyFile: string;
  signatureInput: string;
};

export function buildPackageSeal(input: Omit<PackageSeal, "schema" | "sealVersion" | "packageFormatVersion" | "checksumsFile">): PackageSeal {
  const hex = /^[a-f0-9]{64}$/;
  if (!hex.test(input.reportSha256)) throw new Error("package seal: reportSha256 must be 64 lowercase hex");
  if (!hex.test(input.checksumsSha256)) throw new Error("package seal: checksumsSha256 must be 64 lowercase hex");
  return {
    schema: "PROOVRA_PACKAGE_SEAL",
    sealVersion: 1,
    packageFormatVersion: PACKAGE_FORMAT_VERSION_SEALED,
    checksumsFile: PACKAGE_CHECKSUMS_FILE,
    ...input,
  };
}

/** The exact bytes of `package-seal.json`. */
export function serializePackageSeal(seal: PackageSeal): string {
  return canonicalize(seal);
}

export type PackageChecksumIndex = {
  schema: string;
  files: Array<{ path: string; sizeBytes: number; sha256: string }>;
};

export type SealVerificationCheck =
  | "SEAL_PRESENT"
  | "SIGNATURE_PRESENT"
  | "SIGNATURE_VALID"
  | "CHECKSUM_INDEX_BOUND"
  | "ENTRIES_MATCH_INDEX"
  | "NO_UNLISTED_ENTRIES"
  | "REPORT_BOUND"
  /** EXTERNAL_DISCLOSURE: the report is withheld; reportSha256 commits to it. */
  | "REPORT_COMMITTED_WITHHELD";

export type SealVerificationResult = {
  /** True only when EVERY check passed. */
  ok: boolean;
  passed: SealVerificationCheck[];
  failures: Array<{ check: SealVerificationCheck; detail: string }>;
  seal: PackageSeal | null;
};

/**
 * A large entry verified by its streamed digest instead of its bytes (the
 * verifier never needs an original file in memory). The seal, its signature,
 * the checksum index and the public key file must always be bytes.
 */
export type SealEntryDigest = { sha256: string; sizeBytes: number };

/**
 * Verify a format-5 package from its entries.
 *
 * `entries` maps ZIP paths to their exact bytes, or (for large entries) to
 * their streamed SHA-256 and size. Crypto is injected:
 * `sha256Hex(bytes)` and `verifyEd25519(message, signatureBase64, publicKeyPem)`.
 */
export function verifySealedPackageEntries(input: {
  entries: ReadonlyMap<string, Uint8Array | SealEntryDigest>;
  sha256Hex: (bytes: Uint8Array) => string;
  verifyEd25519: (message: Uint8Array, signatureBase64: string, publicKeyPem: string) => boolean;
  decodeUtf8: (bytes: Uint8Array) => string;
  hexToBytes: (hex: string) => Uint8Array;
}): SealVerificationResult {
  const passed: SealVerificationCheck[] = [];
  const failures: SealVerificationResult["failures"] = [];
  const fail = (check: SealVerificationCheck, detail: string) => failures.push({ check, detail });
  const isBytes = (e: Uint8Array | SealEntryDigest | undefined): e is Uint8Array => e instanceof Uint8Array;
  const bytesOf = (path: string): Uint8Array | undefined => {
    const e = input.entries.get(path);
    return isBytes(e) ? e : undefined;
  };
  const digestOf = (e: Uint8Array | SealEntryDigest) => (isBytes(e) ? input.sha256Hex(e) : e.sha256.toLowerCase());
  const sizeOf = (e: Uint8Array | SealEntryDigest) => (isBytes(e) ? e.length : e.sizeBytes);

  const sealBytes = bytesOf(PACKAGE_SEAL_FILE);
  if (!sealBytes) {
    fail("SEAL_PRESENT", "package-seal.json is absent (not a format-5 package)");
    return { ok: false, passed, failures, seal: null };
  }
  passed.push("SEAL_PRESENT");

  let seal: PackageSeal | null = null;
  try {
    seal = JSON.parse(input.decodeUtf8(sealBytes)) as PackageSeal;
  } catch {
    fail("SEAL_PRESENT", "package-seal.json is not valid JSON");
    return { ok: false, passed, failures, seal: null };
  }

  const sigBytes = bytesOf(PACKAGE_SEAL_SIGNATURE_FILE);
  let signature: PackageSealSignature | null = null;
  if (!sigBytes) {
    fail("SIGNATURE_PRESENT", "package-seal.sig is absent");
  } else {
    try {
      signature = JSON.parse(input.decodeUtf8(sigBytes)) as PackageSealSignature;
      passed.push("SIGNATURE_PRESENT");
    } catch {
      fail("SIGNATURE_PRESENT", "package-seal.sig is not valid JSON");
    }
  }

  if (signature) {
    const sealSha = input.sha256Hex(sealBytes);
    const keyBytes = bytesOf(signature.publicKeyFile);
    if (sealSha !== signature.sealSha256) {
      fail("SIGNATURE_VALID", "seal digest does not match the digest the signature names");
    } else if (!keyBytes) {
      fail("SIGNATURE_VALID", `public key file ${signature.publicKeyFile} is absent`);
    } else {
      let valid = false;
      try {
        valid = input.verifyEd25519(
          input.hexToBytes(sealSha),
          signature.signatureBase64,
          input.decodeUtf8(keyBytes),
        );
      } catch {
        valid = false;
      }
      if (valid) passed.push("SIGNATURE_VALID");
      else fail("SIGNATURE_VALID", "Ed25519 signature over the seal digest does not verify");
    }
  }

  const indexBytes = bytesOf(PACKAGE_CHECKSUMS_FILE);
  let index: PackageChecksumIndex | null = null;
  if (!indexBytes) {
    fail("CHECKSUM_INDEX_BOUND", "package-checksums.json is absent");
  } else if (input.sha256Hex(indexBytes) !== seal.checksumsSha256) {
    fail("CHECKSUM_INDEX_BOUND", "package-checksums.json differs from the sealed digest");
  } else {
    passed.push("CHECKSUM_INDEX_BOUND");
    try {
      index = JSON.parse(input.decodeUtf8(indexBytes)) as PackageChecksumIndex;
    } catch {
      fail("CHECKSUM_INDEX_BOUND", "package-checksums.json is not valid JSON");
    }
  }

  if (index) {
    const listed = new Set<string>();
    const mismatched: string[] = [];
    for (const file of index.files ?? []) {
      listed.add(file.path);
      const entry = input.entries.get(file.path);
      if (!entry) {
        mismatched.push(`${file.path}: missing`);
        continue;
      }
      if (sizeOf(entry) !== file.sizeBytes || digestOf(entry) !== file.sha256) {
        mismatched.push(`${file.path}: bytes differ`);
      }
    }
    if (mismatched.length === 0) passed.push("ENTRIES_MATCH_INDEX");
    else fail("ENTRIES_MATCH_INDEX", mismatched.slice(0, 20).join("; "));

    const outside = [...input.entries.keys()].filter(
      (path) =>
        !listed.has(path) &&
        path !== PACKAGE_CHECKSUMS_FILE &&
        path !== PACKAGE_SEAL_FILE &&
        path !== PACKAGE_SEAL_SIGNATURE_FILE &&
        !path.endsWith("/"),
    );
    if (outside.length === 0) passed.push("NO_UNLISTED_ENTRIES");
    else fail("NO_UNLISTED_ENTRIES", `entries not covered by the index: ${outside.slice(0, 20).join(", ")}`);

    if (seal.reportFile === null) {
      // Only a profile that withholds the report may omit it, and it must
      // still commit to the issued report's digest.
      if (seal.disclosureProfile === "EXTERNAL_DISCLOSURE" && /^[a-f0-9]{64}$/.test(seal.reportSha256)) {
        passed.push("REPORT_COMMITTED_WITHHELD");
      } else {
        fail("REPORT_BOUND", "the seal names no report and is not an external-disclosure package");
      }
      return { ok: failures.length === 0, passed, failures, seal };
    }
    const reportEntry = index.files?.find((f) => f.path === seal!.reportFile);
    const reportBytes = input.entries.get(seal.reportFile);
    if (!reportEntry || !reportBytes) {
      fail("REPORT_BOUND", `the sealed report ${seal.reportFile} is not in the package`);
    } else if (reportEntry.sha256 !== seal.reportSha256 || digestOf(reportBytes) !== seal.reportSha256) {
      fail("REPORT_BOUND", "the embedded report does not hash to the sealed reportSha256");
    } else {
      passed.push("REPORT_BOUND");
    }
  }

  return { ok: failures.length === 0, passed, failures, seal };
}
