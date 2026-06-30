/**
 * PDF technical-metadata parser (worker side).
 *
 * Uses pdfjs-dist (already a worker dependency, used by the preview
 * pipeline) to read page count + document info dictionary (Producer,
 * Creator, CreationDate, ModDate). Never throws — degrades to
 * FAILED/UNSUPPORTED. Does NOT extract page text (that is the OCR
 * pipeline's job).
 */

import {
  TECHNICAL_METADATA_SCHEMA_VERSION,
  type MetadataStatus,
  type TechnicalMetadata,
} from "@proovra/shared-runtime/technical-metadata";
import { unparsedMetadata } from "@proovra/shared-runtime/technical-metadata";
import { logger } from "../logger.js";

const PARSER_VERSION = "pdfjs-dist";

/** Convert a PDF date string ("D:YYYYMMDDHHmmSS+TZ") to ISO-8601. */
function pdfDateToIso(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.match(
    /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/,
  );
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00"] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function bounded(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t.slice(0, 128);
}

export async function parsePdfMetadata(
  bytes: Buffer,
  mimeType: string | null,
): Promise<TechnicalMetadata> {
  try {
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
      getDocument: (options: Record<string, unknown>) => {
        promise: Promise<{
          numPages: number;
          getMetadata: () => Promise<{
            info?: Record<string, unknown>;
          }>;
          destroy?: () => Promise<void> | void;
        }>;
      };
    };

    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
    });
    const pdf = await loadingTask.promise;
    const pageCount = pdf.numPages;
    let info: Record<string, unknown> = {};
    try {
      const meta = await pdf.getMetadata();
      info = meta.info ?? {};
    } catch {
      /* info dict optional */
    }
    await pdf.destroy?.();

    const producer = bounded(info.Producer);
    const creator = bounded(info.Creator);
    const creationDate = pdfDateToIso(info.CreationDate);
    const modificationDate = pdfDateToIso(info.ModDate);
    const encrypted =
      typeof info.IsEncrypted === "boolean" ? info.IsEncrypted : null;
    const signed =
      typeof info.IsSignaturesPresent === "boolean"
        ? info.IsSignaturesPresent
        : null;

    const hasAny = Boolean(
      producer || creator || creationDate || modificationDate,
    );
    const metadataStatus: MetadataStatus = hasAny ? "PRESENT" : "MISSING";

    return {
      schemaVersion: TECHNICAL_METADATA_SCHEMA_VERSION,
      mediaKind: "PDF",
      mimeType,
      parseResult: "OK",
      metadataStatus,
      parserName: "pdfjs-dist",
      parserVersion: PARSER_VERSION,
      pageCount,
      producer,
      creator,
      creationDate,
      modificationDate,
      encrypted,
      signed,
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message.slice(0, 120) : "unknown" },
      "technical_metadata.pdf.parse_failed",
    );
    return unparsedMetadata(mimeType, "FAILED", PARSER_VERSION, "n/a");
  }
}
