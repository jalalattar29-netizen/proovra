// D:\digital-witness\services\worker\src\pdf\signPdf.ts
import fs from "node:fs";
import { SignPdf } from "@signpdf/signpdf";
import { plainAddPlaceholder } from "@signpdf/placeholder-plain";
import { P12Signer } from "@signpdf/signer-p12";

function env(name: string): string | undefined {
  const v = process.env[name];
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t : undefined;
}

export function isPdfSigningEnabled(): boolean {
  return (env("PDF_SIGNING_ENABLED") ?? "false").toLowerCase() === "true";
}

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error("Unexpected PDF binary type (expected Buffer/Uint8Array).");
}

async function signPdfBuffer(unsignedPdf: Buffer): Promise<Buffer> {
  const p12Path = env("PDF_SIGNING_P12_PATH") || "/app/services/worker/keys/proovra-signing.p12";
  const passphrase = env("PDF_SIGNING_P12_PASSWORD") || "";

  if (!fs.existsSync(p12Path)) {
    throw new Error(`PDF signing .p12 not found at ${p12Path}`);
  }

  const p12Buffer = fs.readFileSync(p12Path);

  // ✅ Allocate enough room for signature + cert chain (avoid "No ByteRangeStrings found" / overflow issues)
  const signatureLength = Number(env("PDF_SIGNING_SIGNATURE_LENGTH") ?? "20000");
  const safeSignatureLength = Number.isFinite(signatureLength) && signatureLength > 8000 ? signatureLength : 20000;

  let pdfWithPlaceholder: Buffer;
  try {
    const pdfWithPlaceholderUnknown: unknown = plainAddPlaceholder({
      pdfBuffer: unsignedPdf,
      reason: env("PDF_SIGNING_REASON") || "PROOVRA evidence report signing",
      contactInfo: env("PDF_SIGNING_CONTACT") || "security@proovra.com",
      name: env("PDF_SIGNING_NAME") || "PROOVRA Digital Witness",
      location: env("PDF_SIGNING_LOCATION") || "Essen, DE",
      signatureLength: safeSignatureLength,
    });

    pdfWithPlaceholder = asBuffer(pdfWithPlaceholderUnknown);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to add PDF signature placeholder: ${msg}`);
  }

  try {
    const signer = new P12Signer(p12Buffer, { passphrase });
    const signPdf = new SignPdf();

    const signedUnknown: unknown = signPdf.sign(pdfWithPlaceholder, signer);
    return asBuffer(signedUnknown);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to sign PDF: ${msg}`);
  }
}

export async function signPdfIfEnabled(pdf: Buffer): Promise<Buffer> {
  if (!isPdfSigningEnabled()) return pdf;
  return signPdfBuffer(pdf);
}