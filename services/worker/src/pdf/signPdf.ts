// D:\digital-witness\services\worker\src\pdf\signPdf.ts
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function env(name: string): string | undefined {
  const v = process.env[name];
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t : undefined;
}

export function isPdfSigningEnabled(): boolean {
  return (env("PDF_SIGNING_ENABLED") ?? "false").toLowerCase() === "true";
}

/**
 * Sign PDF buffer if signing is enabled and P12 is available.
 * Safe behavior: if anything fails, return original unsigned PDF.
 */
export function signPdfIfEnabled(unsignedPdf: Buffer): Buffer {
  if (!isPdfSigningEnabled()) return unsignedPdf;

  const p12Path = env("PDF_SIGNING_P12_PATH") ?? "/app/services/worker/keys/proovra-signing.p12";
  const p12Pass = env("PDF_SIGNING_P12_PASS") ?? "";

  if (!p12Path || !fs.existsSync(p12Path)) {
    return unsignedPdf;
  }

  let p12Buf: Buffer;
  try {
    p12Buf = fs.readFileSync(p12Path);
  } catch {
    return unsignedPdf;
  }

  // ---- 1) Add placeholder (buffer-based) ----
  let pdfWithPlaceholder: Buffer = unsignedPdf;
  try {
    const placeholderMod = require("@signpdf/placeholder-pdfkit");
    const plainAddPlaceholder =
      placeholderMod?.plainAddPlaceholder ??
      placeholderMod?.default?.plainAddPlaceholder;

    if (typeof plainAddPlaceholder !== "function") {
      // If the installed package doesn't expose buffer placeholder, we can't sign safely.
      return unsignedPdf;
    }

    pdfWithPlaceholder = plainAddPlaceholder({
      pdfBuffer: unsignedPdf,
      reason: env("PDF_SIGNING_REASON") ?? "PROOVRA Evidence Report Signature",
      contactInfo: env("PDF_SIGNING_CONTACT") ?? "security@proovra.com",
      name: env("PDF_SIGNING_NAME") ?? "PROOVRA",
      location: env("PDF_SIGNING_LOCATION") ?? "Germany",
    });
  } catch {
    return unsignedPdf;
  }

  // ---- 2) Try signing (supports different @signpdf APIs) ----
  try {
    const signpdfMod = require("@signpdf/signpdf");
    const SignPdf =
      signpdfMod?.default ??
      signpdfMod?.SignPdf ??
      signpdfMod;

    const signer = new SignPdf();

    // Attempt A: signer.sign(pdf, p12, { passphrase, ...meta })
    try {
      const out = signer.sign(pdfWithPlaceholder, p12Buf, {
        passphrase: p12Pass,
        reason: env("PDF_SIGNING_REASON") ?? "PROOVRA Evidence Report Signature",
        location: env("PDF_SIGNING_LOCATION") ?? "Germany",
        contactInfo: env("PDF_SIGNING_CONTACT") ?? "security@proovra.com",
        name: env("PDF_SIGNING_NAME") ?? "PROOVRA",
      });
      return Buffer.isBuffer(out) ? out : Buffer.from(out);
    } catch {
      // continue fallback
    }

    // Attempt B: signer.sign(pdf, p12, passphrase)
    try {
      const out = signer.sign(pdfWithPlaceholder, p12Buf, p12Pass);
      return Buffer.isBuffer(out) ? out : Buffer.from(out);
    } catch {
      // continue fallback
    }

    // Attempt C (fallback): P12 -> PEM key+cert using node-forge, then signer.sign(pdf, key, cert)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const forge = require("node-forge");

      const p12Der = forge.util.createBuffer(p12Buf.toString("binary"));
      const p12Asn1 = forge.asn1.fromDer(p12Der);
      const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, p12Pass);

      const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
      const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];
      if (!keyBag?.key) return unsignedPdf;
      const keyPem = forge.pki.privateKeyToPem(keyBag.key);

      const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
      const certBag = certBags[forge.pki.oids.certBag]?.[0];
      if (!certBag?.cert) return unsignedPdf;
      const certPem = forge.pki.certificateToPem(certBag.cert);

      const out = signer.sign(
        pdfWithPlaceholder,
        Buffer.from(keyPem),
        Buffer.from(certPem)
      );
      return Buffer.isBuffer(out) ? out : Buffer.from(out);
    } catch {
      return unsignedPdf;
    }
  } catch {
    return unsignedPdf;
  }
}

/**
 * Backward-compatible name if you were calling signPdfBuffer()
 */
export function signPdfBuffer(unsignedPdf: Buffer): Buffer {
  // If you prefer to "fail hard", change to throw here.
  return signPdfIfEnabled(unsignedPdf);
}