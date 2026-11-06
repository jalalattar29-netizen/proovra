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
 * NOTHING ABOUT THE PACKAGE IS WRITTEN. An issued package, its row and its
 * storage object are immutable; this reads them. The one write is the shared
 * memo of the immutable byte check (REPORT-014, package_seal_byte_checks).
 *
 * WHAT IS REMEMBERED (2026-10-20, AUD-05). The key registry is NOT immutable: a
 * key can be revoked at any time. The whole answer used to be memoized per
 * package, so a revocation stayed "PUBLISHED" until the process restarted.
 * Now the registry is read on every check (one indexed row), and only the
 * expensive, immutable part — re-reading the stored package and verifying its
 * seal bytes — is memoized. A storage failure is not memoized, so a transient
 * outage is re-checked on the next request and is never stated as FAILED.
 *
 * WHAT A FIRST VIEW COSTS (REPORT-014). The first check of a package in a
 * process reads it back on a public request, so it must not stop the API: entries
 * are inflated and hashed without holding the event loop, a few checks run at
 * once, and the memo has a ceiling.
 *
 * ZIP64 (REPORT-005). A package past 4 GiB is read through its ZIP64 records.
 * It is beyond the completeness bound, so its seal is checked and its
 * completeness is not stated; that answer is final, never a promised re-check.
 */
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";

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
/** A ceiling, oldest out: forgetting a check costs one re-read, nothing else. */
const DEFAULT_MEMOIZED_BYTE_CHECKS = 2048;
let maxMemoizedByteChecks = DEFAULT_MEMOIZED_BYTE_CHECKS;
const MAX_CONCURRENT_BYTE_CHECKS = 2;
const HASH_SLICE_BYTES = 4 * 1024 * 1024;
const ZIP_32_BIT_SENTINEL = 0xffffffff;
const inflateRawAsync = promisify(inflateRaw);

let activeByteChecks = 0;
const waitingByteChecks: Array<() => void> = [];

/** At most a few packages are read back at once; the rest queue. */
async function inByteCheckSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeByteChecks >= MAX_CONCURRENT_BYTE_CHECKS) {
    await new Promise<void>((resolve) => waitingByteChecks.push(resolve));
  } else {
    activeByteChecks += 1;
  }
  try {
    return await run();
  } finally {
    // A waiter inherits this slot; otherwise it is freed.
    const next = waitingByteChecks.shift();
    if (next) next();
    else activeByteChecks -= 1;
  }
}

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

/** Test seam: how many byte checks are remembered, under what ceiling. */
export function packageSealCheckMemoSize(ceiling: number = DEFAULT_MEMOIZED_BYTE_CHECKS): number {
  maxMemoizedByteChecks = ceiling;
  return byteCheckMemo.size;
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
    pending = rememberedOrChecked(pkg, recordedFp, memoKey).catch((): ByteCheck => ({ kind: "TRANSIENT" }));
    if (byteCheckMemo.size >= maxMemoizedByteChecks) {
      byteCheckMemo.delete(byteCheckMemo.keys().next().value as string);
    }
    byteCheckMemo.set(memoKey, pending);
  }
  const bytes = await pending;
  if (bytes.kind === "TRANSIENT") byteCheckMemo.delete(memoKey);
  return bytes;
}

/**
 * REPORT-014 — the definitive outcome of this seal identity, from the shared
 * store when any process already checked it; otherwise read the bytes once and
 * store a definitive outcome (never a transient one). A store that cannot be
 * read or written only costs a re-read, never a different answer.
 */
async function rememberedOrChecked(pkg: SealCheckPackageRow, recordedFp: string, memoKey: string): Promise<ByteCheck> {
  const identitySha256 = createHash("sha256").update(memoKey, "utf8").digest("hex");
  try {
    const row = await prisma.packageSealByteCheck.findUnique({
      where: { identitySha256 },
      select: { outcome: true, complete: true },
    });
    if (row?.outcome === "VERIFIED") return { kind: "VERIFIED", complete: row.complete };
    if (row?.outcome === "FAILED") return { kind: "FAILED" };
    if (row?.outcome === "UNBOUND") return { kind: "UNBOUND" };
  } catch {
    /* the store is a cache of an immutable fact: fall through to the bytes */
  }
  const checked = await inByteCheckSlot(() => checkLegacySealBytes(pkg, recordedFp));
  if (checked.kind !== "TRANSIENT") {
    await prisma.packageSealByteCheck
      .createMany({
        data: [{ identitySha256, packageId: pkg.id, outcome: checked.kind, complete: checked.kind === "VERIFIED" ? checked.complete : false }],
        skipDuplicates: true,
      })
      .catch(() => undefined);
  }
  return checked;
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

/** The same digest in slices, giving the event loop a turn between them. */
async function sha256HexInSlices(bytes: Uint8Array): Promise<string> {
  const hash = createHash("sha256");
  for (let at = 0; at < bytes.length; at += HASH_SLICE_BYTES) {
    hash.update(bytes.subarray(at, at + HASH_SLICE_BYTES));
    await new Promise((resolve) => setImmediate(resolve));
  }
  return hash.digest("hex");
}

/** The location of the central directory, through the ZIP64 records when it is past 32 bits. */
async function centralDirectoryOf(
  tail: Buffer,
  eocd: number,
  range: (start: number, end: number) => Promise<Buffer>,
): Promise<{ offset: number; size: number }> {
  const size = tail.readUInt32LE(eocd + 12);
  const offset = tail.readUInt32LE(eocd + 16);
  if (size !== ZIP_32_BIT_SENTINEL && offset !== ZIP_32_BIT_SENTINEL) return { offset, size };
  const locator = eocd - 20;
  if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) throw new Error("no zip64 locator");
  const recordAt = Number(tail.readBigUInt64LE(locator + 8));
  const record = await range(recordAt, recordAt + 55);
  if (record.readUInt32LE(0) !== 0x06064b50) throw new Error("no zip64 end of central directory");
  return { size: Number(record.readBigUInt64LE(40)), offset: Number(record.readBigUInt64LE(48)) };
}

/** A central record's 64-bit values live in its ZIP64 extra, in this order, only where the 32-bit field is the sentinel. */
function resolveZip64Sizes(
  extra: Buffer,
  entry: Pick<CentralEntry, "size" | "compressedSize" | "localHeaderOffset">,
): Pick<CentralEntry, "size" | "compressedSize" | "localHeaderOffset"> {
  const out = { ...entry };
  for (let p = 0; p + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(p);
    const length = extra.readUInt16LE(p + 2);
    if (id === 0x0001) {
      let at = p + 4;
      for (const field of ["size", "compressedSize", "localHeaderOffset"] as const) {
        if (out[field] === ZIP_32_BIT_SENTINEL) {
          out[field] = Number(extra.readBigUInt64LE(at));
          at += 8;
        }
      }
      break;
    }
    p += 4 + length;
  }
  return out;
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
  const directory = await centralDirectoryOf(tail, eocd, range);
  const cd = await range(directory.offset, directory.offset + directory.size - 1);
  const central: CentralEntry[] = [];
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    central.push({
      method: cd.readUInt16LE(p + 10),
      name: cd.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
      ...resolveZip64Sizes(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), {
        compressedSize: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        localHeaderOffset: cd.readUInt32LE(p + 42),
      }),
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
    // An entry that will not inflate within its bound is unreadable for good: it
    // is simply not among the entries, which the seal check then states.
    const bytes =
      e.method === 0
        ? raw
        : e.method === 8
          ? await inflateRawAsync(raw, { maxOutputLength: MAX_ENTRY_BYTES }).catch(() => null)
          : null;
    if (!bytes) {
      complete = false;
      continue;
    }
    entries.set(e.name, material ? new Uint8Array(bytes) : { sha256: await sha256HexInSlices(bytes), sizeBytes: bytes.length });
  }
  return { entries, complete };
}
