import fs from "node:fs";
import PDFDocument from "pdfkit";
import { SignPdf } from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";

// ملاحظة: TS عندك عم يغلب مع resolve تبع placeholder-pdfkit
// لذلك رح نجيبه import عادي (وإذا TS ضل شاكي، الشيم تحت بيحل)
import { pdfkitAddPlaceholder } from "@signpdf/placeholder-pdfkit";

type PDFDoc = InstanceType<typeof PDFDocument>;

function env(name: string): string | undefined {
  const v = process.env[name];
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t : undefined;
}

export function isPdfSigningEnabled() {
  return (env("PDF_SIGNING_ENABLED") ?? "false").toLowerCase() === "true";
}

/**
 * ✅ لازم تنندعى على PDFKit doc قبل doc.end()
 */
export function addSignaturePlaceholderToDoc(doc: PDFDoc) {
  if (!isPdfSigningEnabled()) return;

  pdfkitAddPlaceholder({
    pdf: doc,
    reason: env("PDF_SIGNING_REASON") || "PROOVRA evidence report signing",
    contactInfo: env("PDF_SIGNING_CONTACT") || "security@proovra.com",
    name: env("PDF_SIGNING_NAME") || "PROOVRA",
    location: env("PDF_SIGNING_LOCATION") || "Essen, DE",
  });
}

/**
 * ✅ يوقّع PDF جاهز (وفيه placeholder مسبقاً)
 * IMPORTANT: sign() عندك راجع Promise حسب typings => لازم async/await
 */
export async function signPdfBuffer(pdfWithPlaceholder: Buffer): Promise<Buffer> {
  const p12Path = env("PDF_SIGNING_P12_PATH") || "/app/services/worker/keys/proovra-signing.p12";
  const passphrase = env("PDF_SIGNING_P12_PASSWORD") || "";

  if (!fs.existsSync(p12Path)) {
    throw new Error(`PDF signing .p12 not found at ${p12Path}`);
  }

  const p12Buffer = fs.readFileSync(p12Path);
  const signer = new P12Signer(p12Buffer, { passphrase });

  const signPdf = new SignPdf();
  const signed = await signPdf.sign(pdfWithPlaceholder, signer);
  return signed;
}

export async function signPdfIfEnabled(pdfWithPlaceholder: Buffer): Promise<Buffer> {
  if (!isPdfSigningEnabled()) return pdfWithPlaceholder;
  return await signPdfBuffer(pdfWithPlaceholder);
}