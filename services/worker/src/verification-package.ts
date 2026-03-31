import archiver from "archiver";
import { PassThrough } from "stream";

type VerificationEvidenceFile = {
  name: string;
  buffer: Buffer;
};

type AnchorMode = "off" | "ready" | "active";

type AnchorPayload = {
  version: 1;
  evidenceId: string;
  reportVersion: number;
  fileSha256: string;
  fingerprintHash: string;
  lastEventHash: string | null;
  anchorHash: string;
  generatedAtUtc: string;
};

function normalizeFileName(name: string, fallback: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) return fallback;

  const normalized = trimmed
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);

  return normalized || fallback;
}

function normalizeAnchorMode(value: string | null | undefined): AnchorMode {
  const raw = String(value ?? "ready").trim().toLowerCase();
  if (raw === "off" || raw === "active") return raw;
  return "ready";
}

function buildAnchorReadmeSection(params: {
  anchorMode: AnchorMode;
  hasAnchorPayload: boolean;
  anchorProvider?: string | null;
  anchorPublicBaseUrl?: string | null;
}): string {
  const providerLine = params.anchorProvider
    ? `Provider: ${params.anchorProvider}`
    : "Provider: Not configured";
  const publicBaseLine = params.anchorPublicBaseUrl
    ? `Public base URL: ${params.anchorPublicBaseUrl}`
    : "Public base URL: Not configured";

  if (params.anchorMode === "off") {
    return `ANCHOR STATUS

Anchor publication is disabled for this environment.
No external publication claim is made for this package.
${providerLine}
${publicBaseLine}`;
  }

  if (params.anchorMode === "active") {
    return `ANCHOR STATUS

External anchor mode is enabled for this environment.
${
  params.hasAnchorPayload
    ? "This package includes anchor-ready payload material."
    : "This package does not include anchor payload material."
}
No external publication receipt or transaction identifier is attached inside this package yet.
${providerLine}
${publicBaseLine}`;
  }

  return `ANCHOR STATUS

Anchor-ready mode is enabled for this environment.
${
  params.hasAnchorPayload
    ? "This package includes anchor-ready integrity material."
    : "This package does not include anchor-ready integrity material."
}
No external publication receipt or transaction identifier is attached to this record yet.
${providerLine}
${publicBaseLine}`;
}

export async function createVerificationPackage(data: {
  evidenceBuffer?: Buffer;
  evidenceFiles?: VerificationEvidenceFile[];
  fingerprint: string;
  signature: string;
  timestampToken: string | null;
  publicKey: string;
  custody: unknown;
  evidenceId?: string;
  reportVersion?: number;
  signingKeyId?: string;
  signingKeyVersion?: number;
  anchor?: AnchorPayload | null;
  anchorMode?: AnchorMode | null;
  anchorProvider?: string | null;
  anchorPublicBaseUrl?: string | null;
}) {
  return new Promise<Buffer>((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const stream = new PassThrough();
    const chunks: Buffer[] = [];

    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };

    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    stream.on("end", succeed);
    stream.on("error", fail);
    archive.on("error", fail);
    archive.on("warning", (warning) => {
      fail(warning);
    });

    archive.pipe(stream);

    const evidenceFiles: VerificationEvidenceFile[] =
      Array.isArray(data.evidenceFiles) && data.evidenceFiles.length > 0
        ? data.evidenceFiles.filter(
            (file): file is VerificationEvidenceFile =>
              Boolean(file) &&
              typeof file.name === "string" &&
              Buffer.isBuffer(file.buffer)
          )
        : data.evidenceBuffer
          ? [{ name: "evidence-file", buffer: data.evidenceBuffer }]
          : [];

    if (evidenceFiles.length === 0) {
      fail(new Error("Verification package requires at least one evidence file"));
      return;
    }

    const anchorMode = normalizeAnchorMode(data.anchorMode);
    const anchorIncluded = Boolean(data.anchor);

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

    archive.append(data.fingerprint, {
      name: "fingerprint.json",
    });

    archive.append(data.signature, {
      name: "signature.txt",
    });

    if (data.timestampToken) {
      archive.append(data.timestampToken, {
        name: "timestamp.tsr",
      });
    }

    archive.append(data.publicKey, {
      name: "public-key.pem",
    });

    archive.append(JSON.stringify(data.custody, null, 2), {
      name: "custody.json",
    });

    if (data.anchor) {
      archive.append(JSON.stringify(data.anchor, null, 2), {
        name: "anchor.json",
      });
    }

    archive.append(
      JSON.stringify(
        {
          packageType: "PROOVRA_VERIFICATION_PACKAGE",
          version: 2,
          evidenceId: data.evidenceId ?? null,
          reportVersion: data.reportVersion ?? null,
          signingKeyId: data.signingKeyId ?? null,
          signingKeyVersion: data.signingKeyVersion ?? null,
          multipart: evidenceFiles.length > 1,
          fileCount: evidenceFiles.length,
          generatedAtUtc: new Date().toISOString(),
          anchorIncluded,
          anchorMode,
          anchorProvider: data.anchorProvider ?? null,
          anchorPublicBaseUrl: data.anchorPublicBaseUrl ?? null,
          externalPublicationAttached: false,
        },
        null,
        2
      ),
      {
        name: "package-manifest.json",
      }
    );

    archive.append(
      JSON.stringify(
        {
          verificationProfile: "FORENSIC_INTEGRITY",
          containsFingerprint: true,
          containsSignature: true,
          containsPublicKey: true,
          containsCustody: true,
          containsTimestamp: Boolean(data.timestampToken),
          containsAnchor: anchorIncluded,
          anchorMode,
          multipart: evidenceFiles.length > 1,
        },
        null,
        2
      ),
      {
        name: "integrity-summary.json",
      }
    );

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

anchor.json
Anchor-ready integrity payload that binds the fingerprint hash to the latest hashed custody event, when available.

package-manifest.json
Package metadata describing the verification bundle.

integrity-summary.json
High-level package integrity profile.

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
7) Review custody.json and, where present, anchor.json.

${buildAnchorReadmeSection({
  anchorMode,
  hasAnchorPayload: anchorIncluded,
  anchorProvider: data.anchorProvider,
  anchorPublicBaseUrl: data.anchorPublicBaseUrl,
})}

LEGAL NOTE

This package supports integrity verification of the recorded evidence state.
It does not independently establish authorship, truthfulness, legal admissibility,
or probative weight.
`;

    archive.append(readme, {
      name: "README.txt",
    });

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
  <li>anchor.json (if available)</li>
  <li>package-manifest.json</li>
  <li>integrity-summary.json</li>
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

    archive.finalize().catch(fail);
  });
}