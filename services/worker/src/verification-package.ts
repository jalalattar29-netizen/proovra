import archiver from "archiver";
import { PassThrough } from "stream";

type VerificationEvidenceFile = {
  name: string;
  buffer: Buffer;
};

function normalizeFileName(name: string, fallback: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) return fallback;

  return trimmed
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

export async function createVerificationPackage(data: {
  evidenceBuffer?: Buffer;
  evidenceFiles?: VerificationEvidenceFile[];
  fingerprint: string;
  signature: string;
  timestampToken: string | null;
  publicKey: string;
  custody: unknown;
}) {
  return new Promise<Buffer>((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const stream = new PassThrough();
    const chunks: Buffer[] = [];

    stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));

    archive.on("error", reject);
    stream.on("error", reject);

    archive.pipe(stream);

    const evidenceFiles: VerificationEvidenceFile[] =
      Array.isArray(data.evidenceFiles) && data.evidenceFiles.length > 0
        ? data.evidenceFiles
        : data.evidenceBuffer
          ? [{ name: "evidence-file", buffer: data.evidenceBuffer }]
          : [];

    if (evidenceFiles.length === 0) {
      reject(new Error("Verification package requires at least one evidence file"));
      return;
    }

    /* =========================
       Evidence files
    ========================== */

    if (evidenceFiles.length === 1) {
      const file = evidenceFiles[0];
      archive.append(file.buffer, {
        name: normalizeFileName(file.name, "evidence-file"),
      });
    } else {
      evidenceFiles.forEach((file, index) => {
        archive.append(file.buffer, {
          name: `evidence-parts/${String(index + 1).padStart(4, "0")}-${normalizeFileName(
            file.name,
            `part-${index + 1}`
          )}`,
        });
      });

      archive.append(
        JSON.stringify(
          {
            multipart: true,
            partCount: evidenceFiles.length,
            files: evidenceFiles.map((file, index) => ({
              index: index + 1,
              name: normalizeFileName(file.name, `part-${index + 1}`),
              sizeBytes: file.buffer.length,
            })),
          },
          null,
          2
        ),
        {
          name: "evidence-manifest.json",
        }
      );
    }

    /* =========================
       Fingerprint
    ========================== */

    archive.append(data.fingerprint, {
      name: "fingerprint.json",
    });

    /* =========================
       Signature
    ========================== */

    archive.append(data.signature, {
      name: "signature.txt",
    });

    /* =========================
       Timestamp
    ========================== */

    if (data.timestampToken) {
      archive.append(data.timestampToken, {
        name: "timestamp.tsr",
      });
    }

    /* =========================
       Public key
    ========================== */

    archive.append(data.publicKey, {
      name: "public-key.pem",
    });

    /* =========================
       Custody
    ========================== */

    archive.append(JSON.stringify(data.custody, null, 2), {
      name: "custody.json",
    });

    /* =========================
       README
    ========================== */

    const readme = `PROOVRA Evidence Verification Package

This package allows independent verification of the digital evidence.

FILES INCLUDED

${
  evidenceFiles.length === 1
    ? `evidence-file (or original file name)
Original uploaded evidence.`
    : `evidence-parts/
All evidence parts included in this multipart evidence set.

evidence-manifest.json
Lists all included evidence parts and sizes.`
}

fingerprint.json
Canonical fingerprint used to generate the signature.

signature.txt
Ed25519 signature of the fingerprint.

timestamp.tsr
RFC3161 timestamp token issued by a trusted timestamp authority, when available.

public-key.pem
Public key used to verify the signature.

custody.json
Chain of custody events recorded by the system.

HOW TO VERIFY

1) Extract the package.
2) Review fingerprint.json.
3) If this is a single-file evidence item:
   - Calculate SHA256 hash of the included evidence file.
   - Compare with the fingerprint content.
4) If this is a multipart evidence item:
   - Review the parts listed in fingerprint.json and evidence-manifest.json.
   - Calculate SHA256 hash for each included part.
   - Rebuild the multipart hash according to the platform rules.
5) Verify Ed25519 signature using public-key.pem.
6) Verify timestamp token using RFC3161 verification tools, if included.

This package is self-contained and can be reviewed offline.
`;

    archive.append(readme, {
      name: "README.txt",
    });

    /* =========================
       Offline verifier
    ========================== */

    const verifyHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>PROOVRA Evidence Verifier</title>
<style>
body{font-family:Arial,sans-serif;padding:40px;background:#f8fafc;color:#0f172a}
h1{color:#1f3a5f}
.box{padding:20px;border:1px solid #cbd5e1;border-radius:12px;background:#ffffff;max-width:900px}
code{background:#eef2ff;padding:2px 6px;border-radius:6px}
</style>
</head>
<body>
<h1>PROOVRA Evidence Verification</h1>
<div class="box">
<p>This package contains the material required to review and verify the evidence.</p>

<p><strong>Included files:</strong></p>
<ul>
  <li>Evidence file(s)</li>
  <li>fingerprint.json</li>
  <li>signature.txt</li>
  <li>timestamp.tsr (if available)</li>
  <li>public-key.pem</li>
  <li>custody.json</li>
</ul>

<p>For multipart evidence, open <code>evidence-manifest.json</code> and review the files inside <code>evidence-parts/</code>.</p>
<p>Use cryptographic tools to verify the signature and timestamp.</p>
<p>This verification does not require access to PROOVRA servers.</p>
</div>
</body>
</html>`;

    archive.append(verifyHtml, {
      name: "verify.html",
    });

    archive.finalize().catch(reject);
  });
}