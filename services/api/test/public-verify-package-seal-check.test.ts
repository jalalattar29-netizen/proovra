/**
 * ONE SEAL CHECK FOR THE MATRIX AND THE PACKAGE CARD (2026-10-18).
 *
 * resolvePackageSealCheck decides the package rows every verification surface
 * states. Proven against a REAL format-5 package built here (archiver ZIP,
 * canonical seal, Ed25519 over the seal digest) and served from a doubled
 * object store, with the signing-key registry doubled:
 *
 *   - a keyed seal bound to a registered PACKAGE_SEAL key → PUBLISHED / VERIFIED
 *   - a keyed seal whose registered fingerprint differs → FAILED
 *   - a legacy seal (no key id) whose key PROOVRA publishes → LEGACY_VERIFIED,
 *     completeness verified from the stored entries — read only
 *   - a legacy seal whose key is not published → LEGACY_UNBOUND
 *     ("Sealed — seal not checked against a published PROOVRA key.")
 *   - a legacy seal whose signature does not verify → FAILED
 *   - a legacy seal whose stored seal is not the recorded seal → FAILED
 *   - storage unreachable → LEGACY_UNBOUND, and re-checked next time (not memoized)
 *   - a format <= 4 package → LEGACY; no package → NONE
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { PassThrough } from "node:stream";

import archiver from "archiver";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildVerificationMatrix, serializePackageSeal, buildPackageSeal } from "@proovra/shared";

const store = vi.hoisted(() => ({ object: null as Buffer | null, fail: false, reads: 0 }));
const registry = vi.hoisted(() => ({
  keyed: null as null | { publicKeyPem: string; revokedAt: Date | null; createdAt: Date; fingerprintSha256: string },
  byFingerprint: null as null | { keyId: string; version: number; publicKeyPem: string },
}));

vi.mock("../src/storage.js", () => ({
  headObject: async () => {
    if (store.fail || !store.object) throw new Error("storage unavailable");
    return { sizeBytes: store.object.length };
  },
  getObjectRange: async ({ range }: { range: string }) => {
    store.reads += 1;
    if (store.fail || !store.object) throw new Error("storage unavailable");
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!;
    return store.object.subarray(Number(a), Number(b) + 1);
  },
}));
vi.mock("../src/db.js", () => ({
  prisma: {
    signingKey: {
      findFirst: async ({ where }: { where: { fingerprintSha256: string } }) =>
        registry.byFingerprint && where.fingerprintSha256 ? registry.byFingerprint : null,
    },
  },
}));
vi.mock("@proovra/shared-runtime", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, findRegisteredSigningKey: async () => registry.keyed };
});

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

type Built = { zip: Buffer; sealSha256: string; fingerprint: string; pem: string };

async function buildPackage(opts: { tamperSignature?: boolean } = {}): Promise<Built> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const fingerprint = sha(publicKey.export({ type: "spki", format: "der" }) as Buffer);
  const report = Buffer.from("%PDF-1.7 issued report v1\n");
  const evidence = Buffer.from("preserved evidence bytes");
  const files: Array<[string, Buffer]> = [
    ["report/report-v1.pdf", report],
    ["evidence/item-1.bin", evidence],
    ["keys/package-seal-public-key.pem", Buffer.from(pem)],
  ];
  const checksums = Buffer.from(
    JSON.stringify({ schema: "PROOVRA_PACKAGE_CHECKSUMS", files: files.map(([path, b]) => ({ path, sizeBytes: b.length, sha256: sha(b) })) }),
  );
  const seal = buildPackageSeal({
    evidenceId: "11111111-1111-4111-8111-111111111111",
    reportVersion: 1,
    reportFile: "report/report-v1.pdf",
    reportSha256: sha(report),
    reportIssuedAtUtc: "2026-10-01T00:00:00.000Z",
    packageAssembledAtUtc: "2026-10-01T00:00:00.000Z",
    assembly: "WITH_REPORT_ISSUE",
    custodyThroughSequence: 7,
    proofMaterialsObservedAtUtc: "2026-10-01T00:00:00.000Z",
    fileSha256: sha(evidence),
    fingerprintHash: "f".repeat(64),
    checksumsSha256: sha(checksums),
    fileCount: files.length,
  });
  const sealBytes = Buffer.from(serializePackageSeal(seal));
  const sealSha256 = sha(sealBytes);
  const signature = sign(null, Buffer.from(opts.tamperSignature ? sha("other") : sealSha256, "hex"), privateKey).toString("base64");
  const sig = Buffer.from(
    JSON.stringify({
      schema: "PROOVRA_PACKAGE_SEAL_SIGNATURE",
      version: 1,
      signedFile: "package-seal.json",
      digestAlgorithm: "SHA-256",
      signatureAlgorithm: "ED25519",
      sealSha256,
      signatureBase64: signature,
      signingKeyId: null,
      signingKeyVersion: null,
      signingKeyFingerprint: fingerprint,
      publicKeyFile: "keys/package-seal-public-key.pem",
      signatureInput: "SHA-256(package-seal.json) raw bytes",
    }),
  );
  const archive = archiver("zip", { zlib: { level: 6 } });
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((r) => out.on("end", () => r()));
  archive.pipe(out);
  for (const [path, b] of files) archive.append(b, { name: path });
  archive.append(checksums, { name: "package-checksums.json" });
  archive.append(sealBytes, { name: "package-seal.json" });
  archive.append(sig, { name: "package-seal.sig" });
  await archive.finalize();
  await done;
  return { zip: Buffer.concat(chunks), sealSha256, fingerprint, pem };
}

const row = (b: Built, over: Record<string, unknown> = {}) => ({
  id: `pkg-${Math.random()}`,
  packageFormatVersion: 5,
  sealSha256: b.sealSha256,
  sealSigningKeySha256: b.fingerprint,
  sealSigningKeyId: null as string | null,
  sealSigningKeyVersion: null as number | null,
  storageBucket: "bucket",
  storageKey: "verification/x/v1.zip",
  s3VersionId: "v1",
  ...over,
});

const matrixRows = (fact: Parameters<typeof buildVerificationMatrix>[0]["packageSeal"]) => {
  const m = buildVerificationMatrix({ signals: [], identity: null, acquisitionMode: null, packageSeal: fact, publication: { kind: "DOCUMENT" } });
  return {
    signature: m.rows.find((r) => r.key === "package_signature")!,
    completeness: m.rows.find((r) => r.key === "package_completeness")!,
  };
};

describe("resolvePackageSealCheck — one seal authority", () => {
  let mod: typeof import("../src/services/public-verify/package-seal-check.service.js");
  let good: Built;

  beforeAll(async () => {
    mod = await import("../src/services/public-verify/package-seal-check.service.js");
    good = await buildPackage();
  });
  beforeEach(() => {
    mod.clearPackageSealCheckMemo();
    store.object = good.zip;
    store.fail = false;
    store.reads = 0;
    registry.keyed = null;
    registry.byFingerprint = null;
  });

  it("no package → NONE; a format <= 4 package → LEGACY (not checked, LEGACY_SEAL)", async () => {
    expect((await mod.resolvePackageSealCheck(null)).fact).toEqual({ kind: "NONE" });
    const legacy = await mod.resolvePackageSealCheck(row(good, { packageFormatVersion: 4 }));
    expect(legacy.fact).toEqual({ kind: "LEGACY" });
    expect(matrixRows(legacy.fact).signature.status).toBe("NOT_CHECKED");
  });

  it("a keyed seal bound to the registered PACKAGE_SEAL key is VERIFIED; a different registered fingerprint is FAILED", async () => {
    registry.keyed = { publicKeyPem: good.pem, revokedAt: null, createdAt: new Date(), fingerprintSha256: good.fingerprint };
    const bound = await mod.resolvePackageSealCheck(row(good, { sealSigningKeyId: "pkg-seal", sealSigningKeyVersion: 1 }));
    expect(bound.fact).toEqual({ kind: "PUBLISHED", sealKeyId: "pkg-seal", sealKeyVersion: 1 });
    expect(matrixRows(bound.fact).signature.status).toBe("VERIFIED");
    registry.keyed = { publicKeyPem: good.pem, revokedAt: null, createdAt: new Date(), fingerprintSha256: "0".repeat(64) };
    const mismatch = await mod.resolvePackageSealCheck(row(good, { sealSigningKeyId: "pkg-seal", sealSigningKeyVersion: 1 }));
    expect(mismatch.fact).toEqual({ kind: "FAILED" });
    expect(matrixRows(mismatch.fact).signature.status).toBe("FAILED");
  });

  it("a legacy seal whose key PROOVRA publishes verifies read-only — signature and every stored entry", async () => {
    registry.byFingerprint = { keyId: "pkg-seal", version: 1, publicKeyPem: good.pem };
    const check = await mod.resolvePackageSealCheck(row(good));
    expect(check.fact).toEqual({ kind: "LEGACY_VERIFIED", sealKeyId: "pkg-seal", sealKeyVersion: 1, completenessVerified: true });
    const rows = matrixRows(check.fact);
    expect(rows.signature.status).toBe("VERIFIED");
    expect(rows.completeness.status).toBe("VERIFIED");
    // Memoized: the immutable package is not read twice.
    const reads = store.reads;
    await mod.resolvePackageSealCheck({ ...row(good), id: "same" });
    await mod.resolvePackageSealCheck({ ...row(good), id: "same" });
    expect(store.reads - reads).toBeGreaterThan(0);
    const settled = store.reads;
    await mod.resolvePackageSealCheck({ ...row(good), id: "same" });
    expect(store.reads).toBe(settled);
  });

  it("a legacy seal whose key is not published is not checked: the one sentence, LEGACY_SEAL", async () => {
    const check = await mod.resolvePackageSealCheck(row(good));
    expect(check.fact).toEqual({ kind: "LEGACY_UNBOUND" });
    const rows = matrixRows(check.fact);
    expect(rows.signature.status).toBe("NOT_CHECKED");
    expect(rows.signature.statement).toBe("Sealed — seal not checked against a published PROOVRA key.");
    expect(rows.signature.qualifiers).toEqual(["LEGACY_SEAL"]);
  });

  it("a legacy seal that does not verify, or is not the recorded seal, is FAILED", async () => {
    const forged = await buildPackage({ tamperSignature: true });
    store.object = forged.zip;
    registry.byFingerprint = { keyId: "pkg-seal", version: 1, publicKeyPem: forged.pem };
    expect((await mod.resolvePackageSealCheck(row(forged))).fact).toEqual({ kind: "FAILED" });
    store.object = good.zip;
    registry.byFingerprint = { keyId: "pkg-seal", version: 1, publicKeyPem: good.pem };
    expect((await mod.resolvePackageSealCheck(row(good, { sealSha256: "a".repeat(64) }))).fact).toEqual({ kind: "FAILED" });
  });

  it("storage unavailable: not checked now, and checked again next time — never FAILED", async () => {
    registry.byFingerprint = { keyId: "pkg-seal", version: 1, publicKeyPem: good.pem };
    store.fail = true;
    const r = { ...row(good), id: "flaky" };
    expect((await mod.resolvePackageSealCheck(r)).fact).toEqual({ kind: "LEGACY_UNBOUND" });
    store.fail = false;
    expect((await mod.resolvePackageSealCheck(r)).fact.kind).toBe("LEGACY_VERIFIED");
  });
});
