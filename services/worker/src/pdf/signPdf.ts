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
  throw new Error("Unexpected signPdf result type");
}

function signPdfBuffer(unsignedPdf: Buffer): Buffer {
  const p12Path = env("PDF_SIGNING_P12_PATH") ?? "/app/services/worker/keys/proovra-signing.p12";
  const passphrase = env("PDF_SIGNING_P12_PASSWORD") ?? "";

  if (!fs.existsSync(p12Path)) {
    throw new Error(`PDF signing .p12 not found at ${p12Path}`);
  }

  const p12Buffer = fs.readFileSync(p12Path);

  // 1) Add signature placeholder into the PDF (required for proper PDF signature)
  const pdfWithPlaceholder = plainAddPlaceholder({
    pdfBuffer: unsignedPdf,
    reason: env("PDF_SIGNING_REASON") ?? "PROOVRA evidence report signing",
    contactInfo: env("PDF_SIGNING_CONTACT") ?? "security@proovra.com",
    name: env("PDF_SIGNING_NAME") ?? "PROOVRA",
    location: env("PDF_SIGNING_LOCATION") ?? "Essen, DE",
  });

  // 2) Sign with P12
  const signer = new P12Signer(p12Buffer, { passphrase });
  const signPdf = new SignPdf();

  const result: unknown = signPdf.sign(pdfWithPlaceholder, signer);
  return asBuffer(result);
}

export async function signPdfIfEnabled(pdf: Buffer): Promise<Buffer> {
  if (!isPdfSigningEnabled()) return pdf;
  // signPdf.sign is sync; we keep async wrapper for your pipeline consistency
  return signPdfBuffer(pdf);
}