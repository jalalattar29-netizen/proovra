import fs from "node:fs";
import path from "node:path";
import { SignPdf } from "@signpdf/signpdf";
import { plainAddPlaceholder } from "@signpdf/placeholder-plain";
import { P12Signer } from "@signpdf/signer-p12";
import { assertWorkerSignerUsable } from "../signing/signer-control-guard.js";

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
 * Production safety guard (Phase B #11 + Phase C #7).
 *
 * In production we must not silently emit unsigned PDFs while the report
 * visually implies a "signed report" semantic. Two acceptable paths:
 *   (a) PDF_SIGNING_ENABLED=true so the PDF artifact is signed, or
 *   (b) PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK=true to explicitly acknowledge that
 *       the operator has opted into unsigned PDFs (the report copy then
 *       distinguishes fingerprint signature from PDF artifact signature).
 *
 * Production detection (Phase C #7): NODE_ENV alone is unreliable in real
 * deployments (containers / Vercel / Render / Fly often leave NODE_ENV
 * undefined or set it to non-standard values). We accept any of the
 * conventional production signals so the guard cannot be silently bypassed
 * by a missing env var:
 *
 *   PROOVRA_ENV   in {production, prod}
 *   APP_ENV       in {production, prod}
 *   DEPLOY_ENV    in {production, prod}
 *   VERCEL_ENV    == production
 *   RENDER        defined and truthy (Render sets RENDER=true)
 *   NODE_ENV      in {production, prod}
 *
 * If ANY of these signals indicates production, the safety check fires.
 *
 * The fingerprint Ed25519 signature exists regardless of this PDF artifact
 * signature; the two are independent layers and both are described separately
 * in the report.
 */
function isProductionShapedEnv(): boolean {
  const candidates = [
    env("PROOVRA_ENV"),
    env("APP_ENV"),
    env("DEPLOY_ENV"),
    env("VERCEL_ENV"),
    env("NODE_ENV"),
  ];
  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const value = raw.trim().toLowerCase();
    if (value === "production" || value === "prod") return true;
  }
  // Render sets RENDER=true and does not necessarily provide a -ENV variable.
  const renderFlag = (env("RENDER") ?? "").trim().toLowerCase();
  if (renderFlag === "true" || renderFlag === "1") return true;
  return false;
}

export function assertPdfSigningProductionSafetyOrThrow(): void {
  if (!isProductionShapedEnv()) return;
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
  // THE BOUNDARY. Read at execution time, on every job, from the database.
  // A report job queued before a revocation and run after it must not sign.
  await assertWorkerSignerUsable("report_pdf");

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

/**
 * Phase A2 — Bounded outcome of the PDF artifact signing step.
 *
 * The worker reports one of four signature outcomes per generated
 * Report PDF. The Report row persists the chosen status so the API
 * + frontend can render artifact trust without inferring from copy.
 *
 * Vocabulary intentionally matches `PdfSignatureStatus` in
 * `@proovra/shared` so the wire shape is identical and a future
 * frontend type-check can prove it.
 */
export type PdfSigningOutcome =
  | {
      status: "SIGNED";
      pdf: Buffer;
      signedAtUtc: Date;
      signerKeyId: string | null;
    }
  | {
      status: "UNSIGNED_OPT_OUT";
      pdf: Buffer;
      warning: string;
    }
  | {
      status: "SIGNING_UNAVAILABLE";
      pdf: Buffer;
      warning: string;
    };

function readSignerKeyIdLabel(): string | null {
  // Operator-facing key id LABEL. Never the certificate or private
  // key. The env var lets operators tag a rotation; if unset, we
  // fall back to a stable default.
  const explicit = env("PDF_SIGNING_KEY_ID_LABEL");
  if (explicit) return explicit.slice(0, 120);
  if (env("PDF_SIGNING_P12_PATH")) {
    return "operator_pkcs12";
  }
  return null;
}

/**
 * Phase A2 — Sign the PDF AND return the structured outcome.
 *
 * Behaviour vs the legacy `signPdfIfEnabled`:
 *   * When signing is enabled and succeeds → status SIGNED with the
 *     signed bytes, the moment of signing, and the operator-facing
 *     key id label.
 *   * When signing is disabled AND opt-out ACK is set → status
 *     UNSIGNED_OPT_OUT with the canonical operator warning copy.
 *   * When signing is disabled in a non-production environment
 *     without opt-out ACK → status SIGNING_UNAVAILABLE. The
 *     `assertPdfSigningProductionSafetyOrThrow` invariant means
 *     this can never happen in production — the assertion would
 *     have already thrown before reaching this point.
 *   * When signing is enabled but the actual signing call throws,
 *     the error propagates as before. The worker DLQ's the job.
 *     We do not invent a "SIGNING_FAILED" status to silently store
 *     an unsigned artifact — that's the wrong default for an
 *     evidence platform.
 */
export async function signPdfAndProjectOutcome(
  pdf: Buffer,
): Promise<PdfSigningOutcome> {
  if (isPdfSigningEnabled()) {
    const signed = await signPdfBuffer(pdf);
    return {
      status: "SIGNED",
      pdf: signed,
      signedAtUtc: new Date(),
      signerKeyId: readSignerKeyIdLabel(),
    };
  }

  const optOutAcknowledged =
    (env("PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK") ?? "").toLowerCase() === "true";

  if (optOutAcknowledged) {
    return {
      status: "UNSIGNED_OPT_OUT",
      pdf,
      warning:
        "This Report PDF artifact was generated without a PDF signature. The recorded integrity state and Verification Package ZIP remain independent of this artifact's signature.",
    };
  }

  // The production safety assertion in `buildReportPdfV2` runs
  // BEFORE we get here; reaching this branch means we are in a
  // non-production environment without signing configured. Surface
  // it as a distinct status the API can render so QA + operators
  // can distinguish dev/preview from a real opt-out.
  return {
    status: "SIGNING_UNAVAILABLE",
    pdf,
    warning:
      "This Report PDF was generated in a non-production environment where PDF artifact signing is not configured. Production deployments require PDF artifact signing or an explicit acknowledged opt-out.",
  };
}