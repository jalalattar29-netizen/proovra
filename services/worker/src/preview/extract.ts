import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { extractPdfTextWithPdfjs, openPdf } from "../pdf/pdfjs-runtime.js";
import ffmpegPath from "ffmpeg-static";

export type ExtractedPreview = {
  previewDataUrl: string | null;
  previewTextExcerpt: string | null;
  previewCaption: string | null;
};

type ExtractParams = {
  kind:
    | "image"
    | "video"
    | "audio"
    | "pdf"
    | "text"
    | "other";
  mimeType: string | null;
  buffer: Buffer;
};

const execFileAsync = promisify(execFile);
function bufferToDataUrl(
  buffer: Buffer,
  mimeType: string
): string {
  const base64 = buffer.toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

/** Characters no document can print: controls, escape sequences, non-characters. */
const UNPRINTABLE = /\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f\ufffe\uffff]/g;

function safeTextExcerpt(text: string, max = 500): string {
  const clean = text.replace(UNPRINTABLE, " ").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.length <= max) return clean;
  // Never end on half of a surrogate pair.
  return clean.slice(0, max).replace(/[\ud800-\udbff]$/, "") + "…";
}

/** Enough to tell what a file is, and more than an excerpt ever shows. */
const TEXT_SNIFF_BYTES = 64 * 1024;
/** A legacy single-byte file keeps its line controls; beyond this it is not prose. */
const MAX_CONTROL_RATIO = 0.02;

/**
 * IS THIS TEXT (RT-018). A declared type is the submitter's claim, and the bytes
 * decide what a report may print. UTF-16 is recognised by its mark and UTF-8 by
 * decoding strictly; a file that is neither but is mostly printable is treated
 * as a legacy single-byte text, the common case for older exports. A NUL or a
 * run of controls is binary, and a binary file gets no excerpt at all.
 */
function decodeTextEvidence(buffer: Buffer): string | null {
  const sample = buffer.subarray(0, TEXT_SNIFF_BYTES);
  if (sample.length === 0) return "";
  if (sample[0] === 0xff && sample[1] === 0xfe) return new TextDecoder("utf-16le").decode(sample);
  if (sample[0] === 0xfe && sample[1] === 0xff) return new TextDecoder("utf-16be").decode(sample);
  if (sample.includes(0)) return null;
  try {
    // `stream` so a character cut at the sample's end is not a decoding error.
    return new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
  } catch {
    let controls = 0;
    for (const byte of sample) if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) controls += 1;
    if (controls / sample.length > MAX_CONTROL_RATIO) return null;
    return new TextDecoder("windows-1252").decode(sample);
  }
}

function extensionFromMimeType(mimeType: string | null): string {
  const mime = (mimeType ?? "").trim().toLowerCase();
  if (mime === "video/mp4") return "mp4";
  if (mime === "video/webm") return "webm";
  if (mime === "video/quicktime") return "mov";
  if (mime === "audio/mpeg") return "mp3";
  if (mime === "audio/wav" || mime === "audio/x-wav") return "wav";
  if (mime === "audio/webm") return "webm";
  if (mime === "audio/ogg") return "ogg";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/plain") return "txt";
  if (mime.startsWith("image/")) return mime.split("/")[1] || "img";
  return "bin";
}

async function withTempFile<T>(params: {
  buffer: Buffer;
  extension: string;
  execute: (inputPath: string, tempDir: string) => Promise<T>;
}): Promise<T> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proovra-preview-"));
  const inputPath = path.join(tempDir, `input.${params.extension}`);

  try {
    await fs.writeFile(inputPath, params.buffer);
    return await params.execute(inputPath, tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runFfmpeg(args: string[]): Promise<void> {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static binary is unavailable");
  }

  await execFileAsync(ffmpegPath, args, {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function buildVideoPosterPreview(
  buffer: Buffer,
  mimeType: string | null
): Promise<string | null> {
  const extension = extensionFromMimeType(mimeType);

  try {
    return await withTempFile({
      buffer,
      extension,
      execute: async (inputPath, tempDir) => {
        const outputPath = path.join(tempDir, "poster.jpg");

        await runFfmpeg([
          "-y",
          "-ss",
          "00:00:01.000",
          "-i",
          inputPath,
          "-frames:v",
          "1",
          "-vf",
          "thumbnail,scale=1200:-1:force_original_aspect_ratio=decrease",
          outputPath,
        ]);

        const output = await fs.readFile(outputPath);
        return bufferToDataUrl(output, "image/jpeg");
      },
    });
  } catch {
    return null;
  }
}

async function buildAudioWaveformPreview(
  buffer: Buffer,
  mimeType: string | null
): Promise<string | null> {
  const extension = extensionFromMimeType(mimeType);

  try {
    return await withTempFile({
      buffer,
      extension,
      execute: async (inputPath, tempDir) => {
        const outputPath = path.join(tempDir, "waveform.png");

        await runFfmpeg([
          "-y",
          "-i",
          inputPath,
          "-filter_complex",
          "aformat=channel_layouts=mono,showwavespic=s=1200x360:colors=0x175CD3",
          "-frames:v",
          "1",
          outputPath,
        ]);

        const output = await fs.readFile(outputPath);
        return bufferToDataUrl(output, "image/png");
      },
    });
  } catch {
    return null;
  }
}

async function buildPdfFirstPagePreview(buffer: Buffer): Promise<string | null> {
  try {
    const canvasModule = (await import("@napi-rs/canvas")) as unknown as {
      createCanvas: (
        width: number,
        height: number
      ) => {
        getContext: (type: "2d") => unknown;
        toBuffer: (mimeType?: string) => Buffer;
      };
      DOMMatrix?: typeof globalThis.DOMMatrix;
      ImageData?: typeof globalThis.ImageData;
      Path2D?: typeof globalThis.Path2D;
    };

    if (canvasModule.DOMMatrix && !globalThis.DOMMatrix) {
      globalThis.DOMMatrix = canvasModule.DOMMatrix;
    }
    if (canvasModule.ImageData && !globalThis.ImageData) {
      globalThis.ImageData = canvasModule.ImageData;
    }
    if (canvasModule.Path2D && !globalThis.Path2D) {
      globalThis.Path2D = canvasModule.Path2D;
    }

    // The worker's one PDF.js build (see pdf/pdfjs-runtime.ts).
    const pdf = await openPdf(buffer, { disableFontFace: true });
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1.45 });

    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));
    const canvas = canvasModule.createCanvas(width, height);
    const context = canvas.getContext("2d");

    await page.render({
      canvasContext: context,
      viewport,
    }).promise;

    const rendered = canvas.toBuffer("image/png");
    await pdf.destroy?.();

    const optimized = await sharp(rendered)
      .resize(1200, 1600, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();

    return bufferToDataUrl(optimized, "image/png");
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapSvgLine(text: string, max = 76): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= max) {
      current = next;
      continue;
    }

    if (current) {
      lines.push(current);
      current = word;
    } else {
      lines.push(word.slice(0, max));
      current = word.slice(max);
    }
  }

  if (current) lines.push(current);
  return lines;
}

async function buildReviewerRepresentationCard(params: {
  eyebrow: string;
  title: string;
  subtitle: string;
  excerpt?: string | null;
  accent: string;
}): Promise<string | null> {
  const excerptLines = params.excerpt
    ? wrapSvgLine(safeTextExcerpt(params.excerpt, 360), 78).slice(0, 6)
    : [];

  const lineNodes = excerptLines
    .map(
      (line, index) =>
        `<text x="44" y="${184 + index * 22}" font-size="16" fill="#1F2937">${escapeHtml(
          line
        )}</text>`
    )
    .join("");

  const svg = `
    <svg width="1200" height="720" viewBox="0 0 1200 720" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="card-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#F8FAFC"/>
          <stop offset="100%" stop-color="#EEF2F7"/>
        </linearGradient>
        <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${params.accent}"/>
          <stop offset="100%" stop-color="#102A43"/>
        </linearGradient>
      </defs>
      <rect width="1200" height="720" rx="36" fill="url(#card-bg)"/>
      <rect x="0" y="0" width="1200" height="12" fill="url(#accent)"/>
      <rect x="44" y="44" width="250" height="34" rx="17" fill="#E2E8F0"/>
      <text x="62" y="66" font-size="16" font-weight="700" fill="#334155">${escapeHtml(
        params.eyebrow
      )}</text>
      <text x="44" y="126" font-size="42" font-weight="800" fill="#0F172A">${escapeHtml(
        params.title
      )}</text>
      <text x="44" y="158" font-size="18" fill="#475467">${escapeHtml(
        params.subtitle
      )}</text>
      ${
        excerptLines.length > 0
          ? `<rect x="36" y="188" width="1128" height="396" rx="24" fill="#FFFFFF" stroke="#D0D5DD"/>
             ${lineNodes}`
          : `<rect x="36" y="204" width="1128" height="188" rx="24" fill="#FFFFFF" stroke="#D0D5DD"/>
             <text x="56" y="258" font-size="22" font-weight="700" fill="#1D2939">Evidence snapshot</text>
             <text x="56" y="292" font-size="18" fill="#475467">This embedded card summarizes the preserved evidence item for report review.</text>
             <text x="56" y="326" font-size="18" fill="#475467">Original content remains separately preserved and should be reviewed through controlled verification when needed.</text>`
      }
      <rect x="36" y="624" width="1128" height="60" rx="18" fill="#0F172A"/>
      <text x="60" y="661" font-size="18" fill="#FFFFFF">Generated evidence snapshot for report inclusion. Original evidence remains preserved separately.</text>
    </svg>
  `;

  try {
    const rendered = await sharp(Buffer.from(svg))
      .jpeg({ quality: 88 })
      .toBuffer();

    return bufferToDataUrl(rendered, "image/jpeg");
  } catch {
    return null;
  }
}

// `mimeType` was the trailing parameter and was never read: sharp sniffs the
// container from the buffer itself, so the caller's declared type had no
// influence on the result. Dropping it removes a parameter that implied the
// preview honoured a MIME hint it actually ignored.
async function extractImagePreview(buffer: Buffer): Promise<ExtractedPreview> {
  try {
    const resized = await sharp(buffer)
      .resize(800, 800, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .toBuffer();

    return {
      previewDataUrl: bufferToDataUrl(resized, "image/jpeg"),
      previewTextExcerpt: null,
      previewCaption: "Image preview",
    };
  } catch {
    return {
      previewDataUrl: null,
      previewTextExcerpt: null,
      previewCaption: "Image preview unavailable",
    };
  }
}

async function extractPdfPreview(
  buffer: Buffer
): Promise<ExtractedPreview> {
  try {
    const firstPagePreview = await buildPdfFirstPagePreview(buffer);
    let textExcerpt: string | null = null;

    try {
      const text = await extractPdfTextWithPdfjs(buffer);
      textExcerpt = safeTextExcerpt(text.replace(/-- d+ of d+ --/g, " ")) || null;
    } catch {
      textExcerpt = null;
    }

    const reviewCard = await buildReviewerRepresentationCard({
      eyebrow: "PDF document",
      title: "Document snapshot",
      subtitle:
        "Structured representation generated from the preserved PDF evidence item.",
      excerpt: textExcerpt || "No extractable PDF text was available for this document.",
      accent: "#7C3AED",
    });

    return {
      previewDataUrl: firstPagePreview ?? reviewCard,
      previewTextExcerpt: textExcerpt || null,
      previewCaption: firstPagePreview
        ? "PDF first-page reviewer preview"
        : "Reviewer PDF representation",
    };
  } catch {
    return {
      previewDataUrl: null,
      previewTextExcerpt: null,
      previewCaption: "PDF preview unavailable",
    };
  }
}

async function extractTextPreview(
  buffer: Buffer
): Promise<ExtractedPreview> {
  try {
    const text = decodeTextEvidence(buffer);
    if (text === null) {
      return {
        previewDataUrl: await buildReviewerRepresentationCard({
          eyebrow: "Evidence file",
          title: "Binary content",
          subtitle:
            "This file was declared as text, but its bytes are not readable text, so no excerpt is shown.",
          accent: "#475467",
        }),
        previewTextExcerpt: null,
        previewCaption: "Binary content, no text excerpt",
      };
    }
    const excerpt = safeTextExcerpt(text);
    const reviewCard = await buildReviewerRepresentationCard({
      eyebrow: "Text evidence",
      title: "Text evidence excerpt",
      subtitle:
        "Structured representation generated from the preserved text evidence item.",
      excerpt: excerpt || "No readable text excerpt was available for this evidence item.",
      accent: "#0F766E",
    });

    return {
      previewDataUrl: reviewCard,
      previewTextExcerpt: excerpt || null,
      previewCaption: "Reviewer text representation",
    };
  } catch {
    return {
      previewDataUrl: null,
      previewTextExcerpt: null,
      previewCaption: "Text preview unavailable",
    };
  }
}

async function extractMediaPlaceholder(
  type: "video" | "audio",
  buffer: Buffer,
  mimeType: string | null
): Promise<ExtractedPreview> {
  const mediaPreview =
    type === "video"
      ? await buildVideoPosterPreview(buffer, mimeType)
      : await buildAudioWaveformPreview(buffer, mimeType);

  const previewDataUrl = await buildReviewerRepresentationCard({
    eyebrow: type === "video" ? "Video evidence" : "Audio evidence",
    title:
      type === "video"
        ? "Video snapshot"
        : "Audio snapshot",
    subtitle:
      type === "video"
        ? "Structured representation generated from the preserved video evidence item. Playback is handled through the verification workflow."
        : "Structured representation generated from the preserved audio evidence item. Playback is handled through the verification workflow.",
    excerpt:
      type === "video"
        ? "This report includes a snapshot of the preserved video item. Original video playback is intentionally handled through controlled verification instead of direct PDF embedding."
        : "This report includes a snapshot of the preserved audio item. Original audio playback is intentionally handled through controlled verification instead of direct PDF embedding.",
    accent: type === "video" ? "#1D4ED8" : "#C2410C",
  });

  return {
    previewDataUrl: mediaPreview ?? previewDataUrl,
    previewTextExcerpt: null,
    previewCaption:
      type === "video"
        ? mediaPreview
          ? "Video poster reviewer preview"
          : "Reviewer video representation"
        : mediaPreview
          ? "Audio waveform reviewer preview"
          : "Reviewer audio representation",
  };
}

export async function extractPreviewForAsset(
  params: ExtractParams
): Promise<ExtractedPreview> {
  const { kind, mimeType, buffer } = params;

  try {
    switch (kind) {
      case "image":
        return await extractImagePreview(buffer);

      case "pdf":
        return await extractPdfPreview(buffer);

      case "text":
        return await extractTextPreview(buffer);

      case "video":
        return await extractMediaPlaceholder("video", buffer, mimeType);

      case "audio":
        return await extractMediaPlaceholder("audio", buffer, mimeType);

      default:
        return {
          previewDataUrl: await buildReviewerRepresentationCard({
            eyebrow: "Evidence file",
            title: "Structured evidence summary",
            subtitle:
              "Structured representation generated for a preserved evidence item that is not previewed inline as native media.",
            excerpt: mimeType
              ? `Recorded MIME type: ${mimeType}`
              : "No MIME type was recorded for this evidence item.",
            accent: "#475467",
          }),
          previewTextExcerpt: null,
          previewCaption: "Structured evidence representation",
        };
    }
  } catch {
    return {
      previewDataUrl: null,
      previewTextExcerpt: null,
      previewCaption: "Preview extraction failed",
    };
  }
}
