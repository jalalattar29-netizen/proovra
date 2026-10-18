/**
 * THE PACKAGE SEAL FACT FOR A VERIFICATION SURFACE (2026-10-18).
 *
 * The matrix's package rows and the package-integrity card state ONE seal
 * check, decided here from the published package row, the signing-key registry
 * and — for a seal issued before seals were bound to a key id — the stored
 * package itself, read back READ-ONLY:
 *
 *   NONE            no package has been issued
 *   LEGACY          a format <= 4 package: not sealed
 *   PUBLISHED       sealed with a registered PACKAGE_SEAL key whose fingerprint
 *                   is the one the row recorded (the worker verified the seal
 *                   against that key before it published the package)
 *   LEGACY_VERIFIED sealed before key ids were recorded; the seal's signature
 *                   verifies NOW against a registered PACKAGE_SEAL key whose
 *                   fingerprint equals the row's recorded fingerprint, and the
 *                   seal is the one the row recorded
 *   LEGACY_UNBOUND  sealed, but it could not be checked against a key PROOVRA
 *                   publishes (no such key, a revoked key, the stored package
 *                   unreadable): "Sealed — seal not checked against a published
 *                   PROOVRA key."
 *   FAILED          checked and contradicted: the registered key is not the key
 *                   the row recorded, the stored seal is not the recorded seal,
 *                   or its signature does not verify
 *
 * NOTHING IS WRITTEN. An issued package, its row and its storage object are
 * immutable; this reads them. A result is memoized per package id (the inputs
 * never change); a storage failure is not memoized, so a transient outage is
 * re-checked on the next request and is never stated as FAILED.
 */
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { inflateRawSync } from "node:zlib";

import {
  verifySealedPackageEntries,
  type PackageSealFact,
  type SealEntryDigest,
} from "@proovra/shared";
import { findRegisteredSigningKey, publicFingerprintOfPem } from "@proovra/shared-runtime";

import { prisma } from "../../db.js";
import { getObjectRange, headObject } from "../../storage.js";

export type SealCheckPackageRow = {
  id: string;
  packageFormatVersion: number | null;
  sealSha256: string | null;
  sealSigningKeySha256: string | null;
  sealSigningKeyId: string | null;
  sealSigningKeyVersion: number | null;
  storageBucket: string | null;
  storageKey: string | null;
  s3VersionId?: string | null;
};

/** The extended fact: completeness is stated only when every entry was checked. */
export type PackageSealCheck = { fact: PackageSealFact; completenessVerified: boolean | null };

const PACKAGE_FORMAT_VERSION_SEALED = 5;
/** Bounded reads: a package larger than this is not re-read for completeness. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
/** The entries the signature check needs as bytes (never an original file). */
const SEAL_MATERIAL = new Set(["package-seal.json", "package-seal.sig", "package-checksums.json"]);

const memo = new Map<string, Promise<PackageSealCheck>>();

export async function resolvePackageSealCheck(pkg: SealCheckPackageRow | null): Promise<PackageSealCheck> {
  if (!pkg) return { fact: { kind: "NONE" }, completenessVerified: null };
  if ((pkg.packageFormatVersion ?? 0) < PACKAGE_FORMAT_VERSION_SEALED || !pkg.sealSha256 || !pkg.sealSigningKeySha256) {
    return { fact: { kind: "LEGACY" }, completenessVerified: null };
  }
  // Keyed by the row's whole seal identity: an issued row never changes, so
  // this is the id in practice — and a different row state is never served a
  // stale answer.
  const key = [pkg.id, pkg.sealSha256, pkg.sealSigningKeySha256, pkg.sealSigningKeyId ?? "", pkg.sealSigningKeyVersion ?? ""].join("|");
  const cached = memo.get(key);
  if (cached) return cached;
  const pending = decide(pkg);
  memo.set(key, pending);
  const result = await pending.catch(() => null);
  if (!result || result.transient) {
    memo.delete(key);
    return result ? { fact: result.fact, completenessVerified: result.completenessVerified } : { fact: { kind: "LEGACY_UNBOUND" }, completenessVerified: null };
  }
  return { fact: result.fact, completenessVerified: result.completenessVerified };
}

/** Test seam: forget memoized checks. */
export function clearPackageSealCheckMemo(): void {
  memo.clear();
}

type Decision = PackageSealCheck & { transient?: boolean };

async function decide(pkg: SealCheckPackageRow): Promise<Decision> {
  const recordedFp = pkg.sealSigningKeySha256!.toLowerCase();
  if (pkg.sealSigningKeyId && pkg.sealSigningKeyVersion != null) {
    const key = await findRegisteredSigningKey(prisma as never, {
      keyId: pkg.sealSigningKeyId,
      version: pkg.sealSigningKeyVersion,
      purpose: "PACKAGE_SEAL",
    });
    if (!key) return { fact: { kind: "LEGACY_UNBOUND" }, completenessVerified: null };
    if (key.fingerprintSha256.toLowerCase() !== recordedFp) return { fact: { kind: "FAILED" }, completenessVerified: null };
    if (key.revokedAt) return { fact: { kind: "LEGACY_UNBOUND" }, completenessVerified: null };
    return {
      fact: { kind: "PUBLISHED", sealKeyId: pkg.sealSigningKeyId, sealKeyVersion: pkg.sealSigningKeyVersion },
      completenessVerified: true,
    };
  }
  return verifyLegacySeal(pkg, recordedFp);
}

/**
 * A seal written before the row recorded its key id: find the registered
 * PACKAGE_SEAL key with the recorded fingerprint, read the stored package back
 * and run the canonical seal verifier — the one a recipient's tooling runs.
 */
async function verifyLegacySeal(pkg: SealCheckPackageRow, recordedFp: string): Promise<Decision> {
  const key = await prisma.signingKey.findFirst({
    where: { purpose: "PACKAGE_SEAL", fingerprintSha256: recordedFp, revokedAt: null },
    select: { keyId: true, version: true, publicKeyPem: true },
  });
  if (!key || publicFingerprintOfPem(key.publicKeyPem) !== recordedFp) {
    return { fact: { kind: "LEGACY_UNBOUND" }, completenessVerified: null };
  }
  if (!pkg.storageBucket || !pkg.storageKey) return { fact: { kind: "LEGACY_UNBOUND" }, completenessVerified: null };

  let entries: Map<string, Uint8Array | SealEntryDigest>;
  let complete: boolean;
  try {
    ({ entries, complete } = await readPackageEntries(pkg.storageBucket, pkg.storageKey, pkg.s3VersionId ?? null));
  } catch {
    // Storage unreadable now: not checked, and checked again next time.
    return { fact: { kind: "LEGACY_UNBOUND" }, completenessVerified: null, transient: true };
  }

  const sealBytes = entries.get("package-seal.json");
  if (!(sealBytes instanceof Uint8Array) || sha256Hex(sealBytes) !== pkg.sealSha256!.toLowerCase()) {
    return { fact: { kind: "FAILED" }, completenessVerified: null };
  }
  // The package carries its own public key; it must BE the published key.
  let sig: { publicKeyFile?: string; signingKeyFingerprint?: string } = {};
  try {
    const raw = entries.get("package-seal.sig");
    sig = raw instanceof Uint8Array ? JSON.parse(Buffer.from(raw).toString("utf8")) : {};
  } catch {
    sig = {};
  }
  const shippedKey = sig.publicKeyFile ? entries.get(sig.publicKeyFile) : undefined;
  if (!(shippedKey instanceof Uint8Array) || publicFingerprintOfPem(Buffer.from(shippedKey)) !== recordedFp) {
    return { fact: { kind: "LEGACY_UNBOUND" }, completenessVerified: null };
  }

  const result = verifySealedPackageEntries({
    entries,
    sha256Hex,
    verifyEd25519: (message, signatureBase64, publicKeyPem) =>
      verifySignature(null, Buffer.from(message), createPublicKey(publicKeyPem), Buffer.from(signatureBase64, "base64")),
    decodeUtf8: (b) => Buffer.from(b).toString("utf8"),
    hexToBytes: (h) => Buffer.from(h, "hex"),
  });
  const signatureFailed = result.failures.some((f) => f.check === "SEAL_PRESENT" || f.check === "SIGNATURE_PRESENT" || f.check === "SIGNATURE_VALID");
  if (signatureFailed) return { fact: { kind: "FAILED" }, completenessVerified: null };
  return {
    fact: { kind: "LEGACY_VERIFIED", sealKeyId: key.keyId, sealKeyVersion: key.version, completenessVerified: complete && result.ok },
    completenessVerified: complete && result.ok,
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type CentralEntry = { name: string; method: number; compressedSize: number; size: number; localHeaderOffset: number };

/**
 * Every entry of a stored ZIP, by ranged reads: the seal material as bytes,
 * every other entry as its digest and size. `complete` is false when an entry
 * was too large (or the package too large) to be re-read: the seal is still
 * checked, completeness is not stated.
 */
async function readPackageEntries(
  bucket: string,
  key: string,
  versionId: string | null,
): Promise<{ entries: Map<string, Uint8Array | SealEntryDigest>; complete: boolean }> {
  const meta = await headObject({ bucket, key, versionId });
  const size = Number((meta as { sizeBytes?: number | bigint | null }).sizeBytes ?? 0);
  if (!size) throw new Error("empty package object");
  const range = (start: number, end: number) =>
    getObjectRange({ bucket, key, range: `bytes=${start}-${end}`, versionId });

  const tailLength = Math.min(size, 128 * 1024);
  const tail = await range(size - tailLength, size - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end of central directory");
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("zip64 package");
  const cd = await range(cdOffset, cdOffset + cdSize - 1);
  const central: CentralEntry[] = [];
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    central.push({
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      localHeaderOffset: cd.readUInt32LE(p + 42),
      name: cd.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const entries = new Map<string, Uint8Array | SealEntryDigest>();
  let complete = size <= MAX_PACKAGE_BYTES;
  for (const e of central) {
    if (e.name.endsWith("/")) continue;
    const material = SEAL_MATERIAL.has(e.name) || e.name.endsWith(".pem");
    if (!material && (!complete || e.compressedSize > MAX_ENTRY_BYTES || e.size > MAX_ENTRY_BYTES)) {
      complete = false;
      continue;
    }
    const header = await range(e.localHeaderOffset, e.localHeaderOffset + 29);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error("bad local header");
    const dataStart = e.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const raw = e.compressedSize === 0 ? Buffer.alloc(0) : await range(dataStart, dataStart + e.compressedSize - 1);
    const bytes = e.method === 0 ? raw : e.method === 8 ? inflateRawSync(raw) : null;
    if (!bytes) {
      complete = false;
      continue;
    }
    entries.set(e.name, material ? new Uint8Array(bytes) : { sha256: sha256Hex(bytes), sizeBytes: bytes.length });
  }
  return { entries, complete };
}
