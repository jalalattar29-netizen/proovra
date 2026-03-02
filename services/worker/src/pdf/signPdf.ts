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

// إذا true: أي فشل بالتوقيع يوقع الـ job (strict mode)
// إذا false: أي فشل بالتوقيع بيرجع PDF بدون توقيع (recommended)
function isStrict(): boolean {
  return (env("PDF_SIGNING_STRICT") ?? "false").toLowerCase() === "true";
}

async function signPdfBuffer(unsignedPdf: Buffer): Promise<Buffer> {
  const p12Path = env("PDF_SIGNING_P12_PATH") || "/app/services/worker/keys/proovra-signing.p12";
  const passphrase = env("PDF_SIGNING_P12_PASSWORD") || "";

  if (!fs.existsSync(p12Path)) {
    throw new Error(`PDF signing .p12 not found at ${p12Path}`);
  }

  const p12Buffer = fs.readFileSync(p12Path);

  const pdfWithPlaceholder = plainAddPlaceholder({
    pdfBuffer: unsignedPdf,
    reason: env("PDF_SIGNING_REASON") || "PROOVRA evidence report signing",
    contactInfo: env("PDF_SIGNING_CONTACT") || "security@proovra.com",
    name: env("PDF_SIGNING_NAME") || "PROOVRA",
    location: env("PDF_SIGNING_LOCATION") || "Essen, DE",
  });

  const signer = new P12Signer(p12Buffer, { passphrase });
  const signPdf = new SignPdf();

  // بعض الإصدارات ترجع Buffer وبعضها Uint8Array
  const signed = await signPdf.sign(pdfWithPlaceholder, signer);
  return Buffer.isBuffer(signed) ? signed : Buffer.from(signed);
}

export async function signPdfIfEnabled(pdf: Buffer): Promise<Buffer> {
  if (!isPdfSigningEnabled()) return pdf;

  try {
    return await signPdfBuffer(pdf);
  } catch (err) {
    if (isStrict()) throw err;
    // fallback: لا تخرب التقرير كله
    console.warn("[pdf-sign] signing failed, returning unsigned PDF:", err);
    return pdf;
  }
}