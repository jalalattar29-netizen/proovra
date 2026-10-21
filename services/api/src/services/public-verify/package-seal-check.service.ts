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
 *   KEY_REVOKED     sealed with PROOVRA's registered PACKAGE_SEAL key (the
 *                   recorded fingerprint), and that key is revoked — stated
 *                   with the package page's one revoked-key sentence, which
 *                   says "after issuance" only when the dates show it
 *   LEGACY_UNBOUND  sealed, but it could not be checked against a key PROOVRA
 *                   publishes (no such key, the stored package unreadable):
 *                   "Sealed — seal not checked against a published PROOVRA key."
 *   FAILED          checked and contradicted: the registered key is not the key
 *                   the row recorded, the stored seal is not the recorded seal,
 *                   or its signature does not verify
 *
 * NOTHING IS WRITTEN. An issued package, its row and its storage object are
 * immutable; this reads them.
 *
 * WHAT IS REMEMBERED (2026-10-20, AUD-05). The key registry is NOT immutable: a
 * key can be revoked at any time. The whole answer used to be memoized per
 * package, so a revocation stayed "PUBLISHED" until the process restarted.
 * Now the registry is read on every check (one indexed row), and only the
 * expensive, immutable part — re-reading the stored package and verifying its
 * seal bytes — is memoized. A storage failure is not memoized, so a transient
 * outage is re-checked on the next request and is never stated as FAILED.
 */
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { inflateRawSync } from "node:zlib";

import {
  resolveSealKeyBinding,
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
  /** When the package was issued: decides "revoked after issuance". */
  generatedAtUtc?: Date | null;
};

/** The extended fact: completeness is stated only when every entry was checked. */
export type PackageSealCheck = { fact: PackageSealFact; completenessVerified: boolean | null };

const PACKAGE_FORMAT_VERSION_SEALED = 5;
/** Bounded reads: a package larger than this is not re-read for completeness. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
/** The entries the signature check needs as bytes (never an original file). */
const SEAL_MATERIAL = new Set(["package-seal.json", "package-seal.sig", "package-checksums.json"]);

/** The immutable byte check of a legacy seal, per package seal identity and key. */
const byteCheckMemo = new Map<string, Promise<ByteCheck>>();

export async function resolvePackageSealCheck(pkg: SealCheckPackageRow | null): Promise<PackageSealCheck> {
  if (!pkg) return { fact: { kind: "NONE" }, completenessVerified: null };
  if ((pkg.packageFormatVersion ?? 0) < PACKAGE_FORMAT_VERSION_SEALED || !pkg.sealSha256 || !pkg.sealSigningKeySha256) {
    return { fact: { kind: "LEGACY" }, completenessVerified: null };
  }
  try {
    return await decide(pkg);
  } catch {
    // F-30 — the registry unreachable: not checked NOW, checked again next
    // time. Never a "legacy seal" (that is a statement about the package).
    return { fact: { kind: "NOT_CHECKED_NOW" }, completenessVerified: null };
  }
}

/** Test seam: forget memoized byte checks. */
export function clearPackageSealCheckMemo(): void {
  byteCheckMemo.clear();
}

/** KEY_REVOKED, with "after issuance" only when the dates show it. */
function revokedFact(pkg: SealCheckPackageRow, revokedAt: Date): PackageSealCheck {
  const issuedAt = pkg.generatedAtUtc ?? null;
  return {
    fact: {
      kind: "KEY_REVOKED",
      revokedAtUtc: revokedAt.toISOString(),
      revokedAfterIssuance: issuedAt ? revokedAt.getTime() > issuedAt.getTime() : null,
    },
    completenessVerified: null,
  };
}

async function decide(pkg: SealCheckPackageRow): Promise<PackageSealCheck> {
  const recordedFp = pkg.sealSigningKeySha256!.toLowerCase();
  if (pkg.sealSigningKeyId && pkg.sealSigningKeyVersion != null) {
    // Read live on every check (AUD-05): revocation is never remembered.
    const key = await findRegisteredSigningKey(prisma as never, {
      keyId: pkg.sealSigningKeyId,
      version: pkg.sealSigningKeyVersion,
      purpose: "PACKAGE_SEAL",
    });
    // F-30 — THE binding decision the public package record also reads.
    const binding = resolveSealKeyBinding({
      sealed: true,
      recordedFingerprintSha256: recordedFp,
      registered: key ? { fingerprintSha256: key.fingerprintSha256, revokedAt: key.revokedAt ?? null } : null,
    });
    if (binding === "KEY_NOT_PUBLISHED") return { fact: { kind: "KEY_NOT_PUBLISHED" }, completenessVerified: null };
    if (binding === "KEY_MISMATCH") return { fact: { kind: "FAILED" }, completenessVerified: null };
    if (binding === "KEY_REVOKED") return revokedFact(pkg, key!.revokedAt!);
    // F-30 — VERIFIED from the stored package, not from the row: the bytes are
    // read back and the seal checked against the registered key (remembered
    // per seal identity, as for a legacy seal).
    const bytes = await checkSealBytesOnce(pkg, recordedFp);
    switch (bytes.kind) {
      case "VERIFIED":
        return {
          fact: { kind: "PUBLISHED", sealKeyId: pkg.sealSigningKeyId, sealKeyVersion: pkg.sealSigningKeyVersion, completenessVerified: bytes.complete },
          completenessVerified: bytes.complete,
        };
      case "FAILED":
      case "UNBOUND":
        return { fact: { kind: "FAILED" }, completenessVerified: null };
      default:
        return { fact: { kind: "NOT_CHECKED_NOW" }, completenessVerified: null };
    }
  }
  return verifyLegacySeal(pkg, recordedFp);
}

type ByteCheck =
  | { kind: "VERIFIED"; complete: boolean }
  | { kind: "FAILED" }
  | { kind: "UNBOUND" }
  | { kind: "TRANSIENT" };

/**
 * A seal written before the row recorded its key id: find the registered
 * PACKAGE_SEAL key with the recorded fingerprint (live, revoked or not), then
 * — remembered per seal identity — read the stored package back and run the
 * canonical seal verifier, the one a recipient's tooling runs, bound to that
 * fingerprint.
 */
async function verifyLegacySeal(pkg: SealCheckPackageRow, recordedFp: string): Promise<PackageSealCheck> {
  const key = await prisma.signingKey.findFirst({
    where: { purpose: "PACKAGE_SEAL", fingerprintSha256: recordedFp },
    orderBy: { createdAt: "asc" },
    select: { keyId: true, version: true, publicKeyPem: true, revokedAt: true },
  });
  if (!key || publicFingerprintOfPem(key.publicKeyPem) !== recordedFp) {
    return { fact: { kind: "LEGACY_UNBOUND" }, completenessVerified: null };
  }
  if (key.revokedAt) return revokedFact(pkg, key.revokedAt);
  if (!pkg.storageBucket || !pkg.storageKey) return { fact: { kind: "LEGACY_UNBOUND" }, completenessVerified: null };

  const bytes = await checkSealBytesOnce(pkg, recordedFp);
  switch (bytes.kind) {
    case "FAILED":
      return { fact: { kind: "FAILED" }, completenessVerified: null };
    case "VERIFIED":
      return {
        fact: { kind: "LEGACY_VERIFIED", sealKeyId: key.keyId, sealKeyVersion: key.version, completenessVerified: bytes.complete },
        completenessVerified: bytes.complete,
      };
    case "TRANSIENT":
      // F-30 — storage unreadable NOW: not checked, never "legacy".
      return { fact: { kind: "NOT_CHECKED_NOW" }, completenessVerified: null };
    default:
      return { fact: { kind: "LEGACY_UNBOUND" }, completenessVerified: null };
  }
}

/**
 * The stored package's seal bytes, verified once per seal identity (the bytes
 * are immutable); a transient read failure is forgotten and retried.
 */
async function checkSealBytesOnce(pkg: SealCheckPackageRow, recordedFp: string): Promise<ByteCheck> {
  if (!pkg.storageBucket || !pkg.storageKey) return { kind: "TRANSIENT" };
  const memoKey = [pkg.id, pkg.sealSha256, recordedFp, pkg.storageBucket, pkg.storageKey, pkg.s3VersionId ?? ""].join("|");
  let pending = byteCheckMemo.get(memoKey);
  if (!pending) {
    pending = checkLegacySealBytes(pkg, recordedFp).catch((): ByteCheck => ({ kind: "TRANSIENT" }));
    byteCheckMemo.set(memoKey, pending);
  }
  const bytes = await pending;
  if (bytes.kind === "TRANSIENT") byteCheckMemo.delete(memoKey);
  return bytes;
}

/** The immutable part: the stored package's seal bytes, verified. Never reads the registry. */
async function checkLegacySealBytes(pkg: SealCheckPackageRow, recordedFp: string): Promise<ByteCheck> {
  let entries: Map<string, Uint8Array | SealEntryDigest>;
  let complete: boolean;
  try {
    ({ entries, complete } = await readPackageEntries(pkg.storageBucket!, pkg.storageKey!, pkg.s3VersionId ?? null));
  } catch {
    // Storage unreadable now: not checked, and checked again next time.
    return { kind: "TRANSIENT" };
  }

  const sealBytes = entries.get("package-seal.json");
  if (!(sealBytes instanceof Uint8Array) || sha256Hex(sealBytes) !== pkg.sealSha256!.toLowerCase()) {
    return { kind: "FAILED" };
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
    return { kind: "UNBOUND" };
  }

  const result = verifySealedPackageEntries({
    entries,
    sha256Hex,
    verifyEd25519: (message, signatureBase64, publicKeyPem) =>
      verifySignature(null, Buffer.from(message), createPublicKey(publicKeyPem), Buffer.from(signatureBase64, "base64")),
    decodeUtf8: (b) => Buffer.from(b).toString("utf8"),
    hexToBytes: (h) => Buffer.from(h, "hex"),
    // AUD-34: the canonical verifier binds the shipped key to the recorded one.
    publicKeyFingerprint: (pem) => publicFingerprintOfPem(Buffer.from(pem)),
    expectedKeyFingerprint: recordedFp,
  });
  const signatureFailed = result.failures.some(
    (f) =>
      f.check === "SEAL_PRESENT" ||
      f.check === "SIGNATURE_PRESENT" ||
      f.check === "SIGNATURE_VALID" ||
      f.check === "KEY_FINGERPRINT_BOUND",
  );
  if (signatureFailed) return { kind: "FAILED" };
  return { kind: "VERIFIED", complete: complete && result.ok };
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
