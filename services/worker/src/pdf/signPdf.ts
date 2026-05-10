import fs from "node:fs";
import path from "node:path";
import { SignPdf } from "@signpdf/signpdf";
import { plainAddPlaceholder } from "@signpdf/placeholder-plain";
import { P12Signer } from "@signpdf/signer-p12";

function env(name: string): string | undefined {
  const v = process.env[name];
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t : undefined;
}

function resolveP12Path(): string {
  const configured =
    env("PDF_SIGNING_P12_PATH") || "/app/services/worker/keys/proovra-signing.p12";

  return path.isAbsolute(configured)
    ? configured
    : path.resolve(process.cwd(), configured);
}

export function isPdfSigningEnabled(): boolean {
  return (env("PDF_SIGNING_ENABLED") ?? "false").toLowerCase() === "true";
}

/**
 * Production safety guard.
 *
 * Issue #11: in production we must not silently emit unsigned PDFs while the
 * report visually implies a "signed report" semantic. Two acceptable paths:
 *   (a) PDF_SIGNING_ENABLED=true so the PDF artifact is signed, or
 *   (b) PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK=true to explicitly acknowledge that
 *       the operator has opted into unsigned PDFs (the report copy then
 *       distinguishes fingerprint signature from PDF artifact signature).
 *
 * In NODE_ENV=production with neither flag set, the worker refuses to
 * generate the report and surfaces a loud error so deploys can't slip
 * unsigned PDFs into a customer environment by accident.
 *
 * The fingerprint Ed25519 signature exists regardless of this PDF artifact
 * signature; the two are independent layers and both are described separately
 * in the report.
 */
export function assertPdfSigningProductionSafetyOrThrow(): void {
  const isProduction =
    (env("NODE_ENV") ?? "").toLowerCase() === "production";
  if (!isProduction) return;
  if (isPdfSigningEnabled()) return;

  const optOutAcknowledged =
    (env("PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK") ?? "").toLowerCase() ===
    "true";
  if (optOutAcknowledged) return;

  throw new Error(
    "PDF_SIGNING_ENABLED is not set in production. Either enable PDF artifact signing (PDF_SIGNING_ENABLED=true) or explicitly acknowledge the unsigned-artifact path (PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK=true)."
  );
}

/**
 * Returns whether the PDF artifact will be signed in the current environment.
 * The report copy uses this to distinguish fingerprint signature from PDF
 * artifact signature so the report does not imply something it didn't do.
 */
export function pdfArtifactSignatureExpected(): boolean {
  return isPdfSigningEnabled();
}

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error("Unexpected PDF binary type (expected Buffer or Uint8Array).");
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

async function signPdfBuffer(unsignedPdf: Buffer): Promise<Buffer> {
  const p12Path = resolveP12Path();
  const passphrase =
    env("PDF_SIGNING_P12_PASSWORD") ??
    env("PDF_SIGNING_P12_PASS") ??
    "";

  if (!fs.existsSync(p12Path)) {
    throw new Error(`PDF signing .p12 not found at ${p12Path}`);
  }

  const stat = fs.statSync(p12Path);
  if (!stat.isFile()) {
    throw new Error(`PDF signing path is not a file: ${p12Path}`);
  }

  const p12Buffer = fs.readFileSync(p12Path);
  if (!p12Buffer.length) {
    throw new Error("PDF signing .p12 is empty");
  }

  const safeSignatureLength = Math.max(
    12000,
    readPositiveIntEnv("PDF_SIGNING_SIGNATURE_LENGTH", 20000)
  );

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
    const signedUnknown: unknown = await signPdf.sign(pdfWithPlaceholder, signer);
    return asBuffer(signedUnknown);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to sign PDF: ${msg}`);
  }
}

export async function signPdfIfEnabled(pdf: Buffer): Promise<Buffer> {
  if (!isPdfSigningEnabled()) {
    return pdf;
  }

  return signPdfBuffer(pdf);
}