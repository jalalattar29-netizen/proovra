/**
 * AUD-34 (2026-10-20) — THE ISSUANCE GATE BINDS THE SHIPPED SEAL KEY.
 *
 * assertStagedPackage runs THE canonical seal verifier before a package is
 * published. It checked the registry's key against the fingerprint the
 * signature file NAMES, but the verifier itself trusted the PEM the package
 * ships: a staged package that names PROOVRA's fingerprint while shipping (and
 * being signed by) another key passed the seal checks. The verifier is now
 * given the fingerprint function and the expected key, and the gate refuses
 * with SEAL_KEY_FINGERPRINT_BOUND. Real ZIPs (archiver), real Ed25519.
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import archiver from "archiver";
import { buildPackageSeal, serializePackageSeal } from "@proovra/shared";
import { describe, expect, it, vi } from "vitest";

const proovra = generateKeyPairSync("ed25519");
const attacker = generateKeyPairSync("ed25519");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const fpOf = (k: typeof proovra) => sha(k.publicKey.export({ type: "spki", format: "der" }) as Buffer);
const pemOf = (k: typeof proovra) => k.publicKey.export({ type: "spki", format: "pem" }).toString();
const PROOVRA_FP = fpOf(proovra);

vi.mock("../src/db.js", () => ({ prisma: {} }));
vi.mock("@proovra/shared-runtime", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    findRegisteredSigningKey: async () => ({ fingerprintSha256: PROOVRA_FP, revokedAt: null, publicKeyPem: pemOf(proovra) }),
  };
});

const REPORT = Buffer.from("%PDF-1.7 report v1\n");

async function stagedZip(signer: typeof proovra, namedFingerprint: string | null = PROOVRA_FP): Promise<string> {
  const files: Array<[string, Buffer]> = [
    ["report/report-v1.pdf", REPORT],
    ["keys/package-seal-public-key.pem", Buffer.from(pemOf(signer))],
  ];
  const checksums = Buffer.from(
    JSON.stringify({ schema: "PROOVRA_PACKAGE_CHECKSUMS", files: files.map(([path, b]) => ({ path, sizeBytes: b.length, sha256: sha(b) })) }),
  );
  const seal = buildPackageSeal({
    evidenceId: "11111111-1111-4111-8111-111111111111",
    reportVersion: 1,
    reportFile: "report/report-v1.pdf",
    reportSha256: sha(REPORT),
    reportIssuedAtUtc: "2026-10-01T00:00:00.000Z",
    packageAssembledAtUtc: "2026-10-01T00:00:00.000Z",
    assembly: "WITH_REPORT_ISSUE",
    custodyThroughSequence: 1,
    proofMaterialsObservedAtUtc: "2026-10-01T00:00:00.000Z",
    fileSha256: "a".repeat(64),
    fingerprintHash: "b".repeat(64),
    checksumsSha256: sha(checksums),
    fileCount: files.length,
  });
  const sealBytes = Buffer.from(serializePackageSeal(seal));
  const sealSha256 = sha(sealBytes);
  const sig = Buffer.from(
    JSON.stringify({
      schema: "PROOVRA_PACKAGE_SEAL_SIGNATURE",
      version: 1,
      signedFile: "package-seal.json",
      digestAlgorithm: "SHA-256",
      signatureAlgorithm: "ED25519",
      sealSha256,
      signatureBase64: sign(null, Buffer.from(sealSha256, "hex"), signer.privateKey).toString("base64"),
      signingKeyId: "pkg-seal",
      signingKeyVersion: "1",
      // The forged package NAMES PROOVRA's fingerprint, whatever key it ships.
      signingKeyFingerprint: namedFingerprint,
      publicKeyFile: "keys/package-seal-public-key.pem",
      signatureInput: "SHA-256(package-seal.json) raw bytes",
    }),
  );
  const archive = archiver("zip", { zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  archive.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((r) => archive.on("end", () => r()));
  for (const [path, b] of files) archive.append(b, { name: path });
  archive.append(checksums, { name: "package-checksums.json" });
  archive.append(sealBytes, { name: "package-seal.json" });
  archive.append(sig, { name: "package-seal.sig" });
  await archive.finalize();
  await done;
  const path = join(mkdtempSync(join(tmpdir(), "aud34-")), "staged.zip");
  writeFileSync(path, Buffer.concat(chunks));
  return path;
}

async function findingsOf(zipPath: string): Promise<string[]> {
  const { assertStagedPackage, OutputVerificationError } = await import("../src/output-verification.js");
  try {
    await assertStagedPackage({
      zipPath,
      facts: {} as never,
      expect: {
        packageId: "22222222-2222-4222-8222-222222222222",
        evidenceId: "11111111-1111-4111-8111-111111111111",
        reportVersion: 1,
        disclosureProfile: "FULL_FORENSIC",
        reportSha256: sha(REPORT),
        seal: { signingKeyId: "pkg-seal", signingKeyVersion: 1, signingKeyFingerprint: PROOVRA_FP },
      },
    });
    return [];
  } catch (e) {
    if (!(e instanceof OutputVerificationError)) throw e;
    return e.findings.map((f) => f.check);
  }
}

describe("assertStagedPackage binds the shipped seal key (AUD-34)", () => {
  it("a package naming PROOVRA's fingerprint but shipping and signed by another key is refused", async () => {
    const checks = await findingsOf(await stagedZip(attacker));
    expect(checks).toContain("SEAL_KEY_FINGERPRINT_BOUND");
    // The seal itself verifies with the shipped key: only the binding catches it.
    expect(checks).not.toContain("SEAL_SIGNATURE_VALID");
  });

  it("a package that names NO key and ships another key is refused by the recorded fingerprint alone", async () => {
    // Nothing in the signature file contradicts the shipped key: only the
    // comparison with the key PROOVRA recorded can catch it.
    const checks = await findingsOf(await stagedZip(attacker, null));
    expect(checks).toContain("SEAL_KEY_FINGERPRINT_BOUND");
  });

  it("the genuine package raises no key-binding or signature finding", async () => {
    const checks = await findingsOf(await stagedZip(proovra));
    expect(checks.filter((c) => c.startsWith("SEAL_"))).toEqual([]);
  });
});
