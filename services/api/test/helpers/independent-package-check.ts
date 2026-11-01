/**
 * AN INDEPENDENT CHECK OF A SEALED PACKAGE. What a reviewer does with the
 * package and standard tools, following its README: nothing here imports
 * PROOVRA's verifier, so a defect shared by the builder and the verifier cannot
 * pass by agreeing with itself. Only node:crypto and the package's own files.
 *
 * Returns every failure it finds; an empty list means the package verifies.
 */
import { createHash, createPublicKey, verify } from "node:crypto";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

type Seal = {
  checksumsFile: string;
  checksumsSha256: string;
  fileCount: number;
  fileSha256: string | null;
  fingerprintHash: string | null;
  disclosureProfile?: string;
  reportFile: string | null;
  reportSha256: string;
  evidenceId?: string;
  packageId?: string;
};
type Sig = { sealSha256: string; signatureBase64: string; publicKeyFile: string };
type Index = { files: Array<{ path: string; sizeBytes: number; sha256: string }> };

export function independentlyCheckSealedPackage(entries: ReadonlyMap<string, Buffer>): string[] {
  const failures: string[] = [];
  const json = <T>(name: string): T | null => {
    const bytes = entries.get(name);
    if (!bytes) {
      failures.push(`${name} is absent`);
      return null;
    }
    try {
      return JSON.parse(bytes.toString("utf8")) as T;
    } catch {
      failures.push(`${name} is not JSON`);
      return null;
    }
  };

  const sealBytes = entries.get("package-seal.json");
  const seal = json<Seal>("package-seal.json");
  const sig = json<Sig>("package-seal.sig");
  if (!seal || !sig || !sealBytes) return failures;

  // 1. The seal: an Ed25519 signature over the 32 raw bytes of SHA-256(seal).
  const digest = sha256(sealBytes);
  if (digest !== sig.sealSha256) failures.push("the seal digest differs from the digest its signature names");
  const keyPem = entries.get(sig.publicKeyFile);
  if (!keyPem) failures.push(`${sig.publicKeyFile} is absent`);
  else {
    const valid = verify(null, Buffer.from(digest, "hex"), createPublicKey(keyPem), Buffer.from(sig.signatureBase64, "base64"));
    if (!valid) failures.push("the Ed25519 signature over the seal does not verify");
  }

  // 2. The checksum index is the one the seal names.
  const indexBytes = entries.get(seal.checksumsFile);
  const index = json<Index>(seal.checksumsFile);
  if (!index || !indexBytes) return failures;
  if (sha256(indexBytes) !== seal.checksumsSha256) failures.push("the checksum index differs from the sealed digest");
  if (index.files.length !== seal.fileCount) failures.push(`the seal counts ${seal.fileCount} entries, the index lists ${index.files.length}`);

  // 3. Every entry matches the index, and nothing lies outside it.
  const listed = new Set(index.files.map((f) => f.path));
  for (const f of index.files) {
    const bytes = entries.get(f.path);
    if (!bytes) failures.push(`${f.path} is missing`);
    else if (bytes.length !== f.sizeBytes || sha256(bytes) !== f.sha256) failures.push(`${f.path} differs from its checksum`);
  }
  for (const name of entries.keys()) {
    if (name.endsWith("/") || name === seal.checksumsFile || name === "package-seal.json" || name === "package-seal.sig") continue;
    if (!listed.has(name)) failures.push(`${name} is outside the checksum index`);
  }

  // 4. A multipart record: the item digests reproduce the certified digest.
  const manifest = entries.get("evidence-manifest.json");
  if (manifest && seal.fileSha256) {
    const files = (JSON.parse(manifest.toString("utf8")) as { files: Array<{ partIndex: number; sha256: string }> }).files;
    const composite = sha256(Buffer.from([...files].sort((a, b) => a.partIndex - b.partIndex).map((f) => f.sha256).join("|")));
    if (composite !== seal.fileSha256) failures.push("the item digests do not reproduce the certified file digest");
  }

  // 5. What the external profile withholds is still committed to.
  if (seal.disclosureProfile === "EXTERNAL_DISCLOSURE") {
    const disclosure = json<{ withheldFiles: Array<{ file: string; sha256: string | null }> }>("disclosure-manifest.json");
    const fingerprint = disclosure?.withheldFiles.find((f) => f.file === "fingerprint.json");
    if (seal.fingerprintHash && fingerprint?.sha256 !== seal.fingerprintHash) {
      failures.push("the withheld fingerprint.json digest is not the sealed fingerprintHash");
    }
    if (seal.reportFile !== null) failures.push("an external seal names an embedded report");
    if (!/^[a-f0-9]{64}$/.test(seal.reportSha256)) failures.push("an external seal does not commit to the withheld report");
  } else if (seal.reportFile) {
    const report = entries.get(seal.reportFile);
    if (!report || sha256(report) !== seal.reportSha256) failures.push("the embedded report differs from the sealed digest");
  }
  return failures;
}
