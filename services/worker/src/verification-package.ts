import archiver from "archiver"
import { PassThrough } from "stream"

export async function createVerificationPackage(data: {
  evidenceBuffer: Buffer
  fingerprint: string
  signature: string
  timestampToken: string | null
  publicKey: string
  custody: unknown
}) {

  return new Promise<Buffer>((resolve, reject) => {

    const archive = archiver("zip")

    const stream = new PassThrough()

    const chunks: Buffer[] = []

    stream.on("data", (c) => chunks.push(c))

    stream.on("end", () => resolve(Buffer.concat(chunks)))

    archive.on("error", reject)

    archive.pipe(stream)

    /* =========================
       Evidence
    ========================== */

    archive.append(data.evidenceBuffer, {
      name: "evidence-file"
    })

    /* =========================
       Fingerprint
    ========================== */

    archive.append(data.fingerprint, {
      name: "fingerprint.json"
    })

    /* =========================
       Signature
    ========================== */

    archive.append(data.signature, {
      name: "signature.txt"
    })

    /* =========================
       Timestamp
    ========================== */

    if (data.timestampToken) {

      archive.append(data.timestampToken, {
        name: "timestamp.tsr"
      })

    }

    /* =========================
       Public key
    ========================== */

    archive.append(data.publicKey, {
      name: "public-key.pem"
    })

    /* =========================
       Custody
    ========================== */

    archive.append(
      JSON.stringify(data.custody, null, 2),
      {
        name: "custody.json"
      }
    )

    /* =========================
       README
    ========================== */

    const readme = `
PROOVRA Evidence Verification Package

This package allows independent verification of the digital evidence.

FILES INCLUDED

evidence-file
Original uploaded evidence.

fingerprint.json
Canonical fingerprint used to generate the signature.

signature.txt
Ed25519 signature of the fingerprint.

timestamp.tsr
RFC3161 timestamp token issued by a trusted timestamp authority.

public-key.pem
Public key used to verify the signature.

custody.json
Chain of custody events recorded by the system.

HOW TO VERIFY

1) Calculate SHA256 hash of evidence-file.

2) Compare with fingerprint.json value.

3) Verify Ed25519 signature using public-key.pem.

4) Verify timestamp token using RFC3161 verification tools.

This evidence package is self-contained and can be verified offline.
`

    archive.append(readme, {
      name: "README.txt"
    })

    /* =========================
       Offline verifier
    ========================== */

    const verifyHtml = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>PROOVRA Evidence Verifier</title>
<style>
body{font-family:Arial;padding:40px}
h1{color:#2b4cff}
.box{padding:20px;border:1px solid #ccc;border-radius:8px}
</style>
</head>
<body>

<h1>PROOVRA Evidence Verification</h1>

<div class="box">
<p>This package contains all data required to verify the evidence.</p>

<p>Files included:</p>

<ul>
<li>evidence-file</li>
<li>fingerprint.json</li>
<li>signature.txt</li>
<li>timestamp.tsr</li>
<li>public-key.pem</li>
<li>custody.json</li>
</ul>

<p>Use cryptographic tools to verify the signature and timestamp.</p>

<p>This verification does not require access to PROOVRA servers.</p>

</div>

</body>
</html>
`

    archive.append(verifyHtml, {
      name: "verify.html"
    })

    archive.finalize()

  })

}