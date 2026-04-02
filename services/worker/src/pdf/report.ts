import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signPdfIfEnabled } from "./signPdf.js";

type PDFDoc = InstanceType<typeof PDFDocument>;

export type ReportEvidence = {
  tsaProvider: string | null;
  tsaUrl: string | null;
  tsaSerialNumber: string | null;
  tsaGenTimeUtc: string | null;
  tsaTokenBase64: string | null;
  tsaMessageImprint: string | null;
  tsaHashAlgorithm: string | null;
  tsaStatus: string | null;
  tsaFailureReason: string | null;

  otsProofBase64?: string | null;
  otsHash?: string | null;
  otsStatus?: string | null;
  otsCalendar?: string | null;
  otsBitcoinTxid?: string | null;
  otsAnchoredAtUtc?: string | null;
  otsUpgradedAtUtc?: string | null;
  otsFailureReason?: string | null;

  id: string;
  status: string;
  capturedAtUtc: string | null;
  uploadedAtUtc: string | null;
  signedAtUtc: string | null;
  reportGeneratedAtUtc: string;
  mimeType: string | null;
  sizeBytes: string | null;
  durationSec: string | null;
  storageBucket: string;
  storageKey: string;
  publicUrl: string | null;
  storageRegion?: string | null;
  storageImmutable?: boolean | null;
  storageObjectLockMode?: string | null;
  storageObjectLockRetainUntilUtc?: string | null;
  storageObjectLockLegalHoldStatus?: string | null;
  gps: {
    lat: string | null;
    lng: string | null;
    accuracyMeters: string | null;
  };
  fileSha256: string;
  fingerprintCanonicalJson: string;
  fingerprintHash: string;
  signatureBase64: string;
  signingKeyId: string;
  signingKeyVersion: number;
  publicKeyPem: string;
};

export type ReportCustodyEvent = {
  sequence: number;
  atUtc: string;
  eventType: string;
  payloadSummary: string;
};

type ParsedFingerprintSummary = {
  multipart: boolean;
  itemCount: number;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  documentCount: number;
  mimeTypes: string[];
  partsCount: number;
};

type HeaderContext = {
  evidenceId: string;
  generatedAtUtc: string;
  status?: string;
};

function env(name: string): string | undefined {
  const v = process.env[name];
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t : undefined;
}

function safe(value: string | null | undefined, fallback = "N/A"): string {
  const t = typeof value === "string" ? value.trim() : "";
  return t ? t : fallback;
}

function summarizeText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatBytesHuman(bytesStr: string | null): string {
  const n = bytesStr ? Number(bytesStr) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return "N/A";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let idx = 0;
  let v = n;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx++;
  }
  return `${v.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}

function shortHash(h: string | null | undefined, head = 10, tail = 8): string {
  const t = safe(h, "");
  if (!t) return "N/A";
  if (t.length <= head + tail + 3) return t;
  return `${t.slice(0, head)}…${t.slice(-tail)}`;
}

function mmToPt(mm: number): number {
  return (mm * 72) / 25.4;
}

function parseFingerprintSummary(
  fingerprintCanonicalJson: string
): ParsedFingerprintSummary {
  const fallback: ParsedFingerprintSummary = {
    multipart: false,
    itemCount: 1,
    imageCount: 0,
    videoCount: 0,
    audioCount: 0,
    documentCount: 0,
    mimeTypes: [],
    partsCount: 0,
  };

  try {
    const parsed = JSON.parse(fingerprintCanonicalJson) as {
      file?: {
        multipart?: boolean;
        summary?: {
          itemCount?: number;
          imageCount?: number;
          videoCount?: number;
          audioCount?: number;
          documentCount?: number;
          mimeTypes?: string[];
        };
        parts?: Array<unknown>;
      };
    };

    const multipart = Boolean(parsed?.file?.multipart);
    const partsCount = Array.isArray(parsed?.file?.parts)
      ? parsed.file.parts.length
      : 0;
    const summary = parsed?.file?.summary;

    const itemCount =
      typeof summary?.itemCount === "number"
        ? summary.itemCount
        : multipart
          ? partsCount || 0
          : 1;

    return {
      multipart,
      itemCount,
      imageCount:
        typeof summary?.imageCount === "number" ? summary.imageCount : 0,
      videoCount:
        typeof summary?.videoCount === "number" ? summary.videoCount : 0,
      audioCount:
        typeof summary?.audioCount === "number" ? summary.audioCount : 0,
      documentCount:
        typeof summary?.documentCount === "number"
          ? summary.documentCount
          : 0,
      mimeTypes: Array.isArray(summary?.mimeTypes)
        ? summary.mimeTypes.filter(
            (v): v is string => typeof v === "string" && v.trim().length > 0
          )
        : [],
      partsCount,
    };
  } catch {
    return fallback;
  }
}

function normalizeTimestampStatus(
  status: string | null | undefined
): "SUCCESS" | "WARNING" | "DANGER" | "NEUTRAL" {
  const s = safe(status, "").toUpperCase();
  if (
    s === "GRANTED" ||
    s === "STAMPED" ||
    s === "VERIFIED" ||
    s === "SUCCEEDED"
  ) {
    return "SUCCESS";
  }
  if (s === "PENDING" || s === "UNAVAILABLE") {
    return "WARNING";
  }
  if (s) return "DANGER";
  return "NEUTRAL";
}

function normalizeOtsStatus(
  status: string | null | undefined
): "SUCCESS" | "WARNING" | "DANGER" | "NEUTRAL" {
  const s = safe(status, "").toUpperCase();
  if (s === "ANCHORED") return "SUCCESS";
  if (s === "PENDING") return "WARNING";
  if (s === "FAILED") return "DANGER";
  return "NEUTRAL";
}

function normalizeStorageProtectionStatus(
  immutable: boolean | null | undefined,
  mode: string | null | undefined,
  retainUntil: string | null | undefined
): "SUCCESS" | "WARNING" | "DANGER" | "NEUTRAL" {
  const normalizedMode = safe(mode, "").toUpperCase();
  if (
    immutable &&
    normalizedMode === "COMPLIANCE" &&
    safe(retainUntil, "") !== ""
  ) {
    return "SUCCESS";
  }
  if (immutable || normalizedMode === "GOVERNANCE") {
    return "WARNING";
  }
  if (normalizedMode) {
    return "DANGER";
  }
  return "NEUTRAL";
}

function evidenceStructureLabel(summary: ParsedFingerprintSummary): string {
  if (summary.itemCount <= 1) return "Single evidence item";
  return "Multipart evidence package";
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ASSETS_CANDIDATES: string[] = [
  path.resolve(__dirname, "assets"),
  path.resolve(__dirname, "../pdf/assets"),
  path.resolve(__dirname, "../assets"),
  path.resolve(process.cwd(), "src/pdf/assets"),
  path.resolve(process.cwd(), "services/worker/src/pdf/assets"),
];

function tryReadAsset(filename: string): Buffer | null {
  for (const dir of ASSETS_CANDIDATES) {
    try {
      const p = path.join(dir, filename);
      if (!fs.existsSync(p)) continue;
      return fs.readFileSync(p);
    } catch {
      // continue
    }
  }
  return null;
}

const BRAND = {
  name: env("REPORT_BRAND_NAME") ?? "PROOVRA",
  title: "Verifiable Evidence Report",

  ink: "#111827",
  muted: "#667085",
  line: "#D0D5DD",
  accent: "#1F3A5F",
  accentSoft: "#EAF1F8",
  paper: "#F8FAFC",

  success: "#245C4A",
  danger: "#8A3B2E",
  warning: "#8B6C1E",
};

let currentHeaderContext: HeaderContext | null = null;

function setHeaderContext(opts: HeaderContext): void {
  currentHeaderContext = opts;
}

function hr(doc: PDFDoc, y?: number): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const yy = typeof y === "number" ? y : doc.y;
  doc.save();
  doc.lineWidth(0.9).strokeColor(BRAND.line);
  doc.moveTo(x, yy).lineTo(x + w, yy).stroke();
  doc.restore();
}

function addPageWithHeader(doc: PDFDoc): void {
  doc.addPage();
  if (currentHeaderContext) {
    drawHeader(doc, currentHeaderContext);
  }
}

function ensureSpace(doc: PDFDoc, neededHeight: number): void {
  const bottom = doc.page.height - doc.page.margins.bottom - 10;
  if (doc.y + neededHeight > bottom) {
    addPageWithHeader(doc);
  }
}

function ensurePageWithHeader(
  doc: PDFDoc,
  neededHeight: number,
  opts?: HeaderContext
): void {
  if (opts) {
    setHeaderContext(opts);
  }

  const bottom = doc.page.height - doc.page.margins.bottom - 10;
  if (doc.y + neededHeight > bottom) {
    addPageWithHeader(doc);
  }
}

function paintPageBackground(doc: PDFDoc): void {
  const bg = tryReadAsset("paper-silver.png");
  const pageW = doc.page.width;
  const pageH = doc.page.height;

  doc.save();
  doc.rect(0, 0, pageW, pageH).fill(BRAND.paper);

  if (bg) {
    try {
      doc.opacity(0.16);
      doc.image(bg, 0, 0, { width: pageW, height: pageH });
      doc.opacity(1);
    } catch {
      doc.opacity(1);
    }
  }

  const wm = tryReadAsset("logo.png");
  if (wm) {
    try {
      doc.opacity(0.045);
      const size = Math.min(pageW, pageH) * 0.6;
      const x = (pageW - size) / 2;
      const y = (pageH - size) / 2 - mmToPt(6);
      doc.image(wm, x, y, { fit: [size, size] });
      doc.opacity(1);
    } catch {
      doc.opacity(1);
    }
  }

  const seal = tryReadAsset("seal.png");
  if (seal) {
    try {
      doc.opacity(0.16);
      const size = mmToPt(44);
      const x = pageW - doc.page.margins.right - size + mmToPt(2);
      const y = doc.page.margins.top - mmToPt(1.5);
      doc.image(seal, x, y, { fit: [size, size] });
      doc.opacity(1);
    } catch {
      doc.opacity(1);
    }
  }

  doc.restore();
}

function drawBadge(doc: PDFDoc, text: string, x: number, y: number): void {
  const padX = 11;
  const padY = 4;

  doc.save();
  doc.font("Helvetica-Bold").fontSize(9);

  const tw = doc.widthOfString(text);
  const th = doc.currentLineHeight();

  doc.fillColor(BRAND.accentSoft);
  doc.roundedRect(x, y, tw + padX * 2, th + padY * 2, 7).fill();

  doc.fillColor(BRAND.accent);
  doc.text(text, x + padX, y + padY, { lineBreak: false });
  doc.restore();
}

function drawCallout(
  doc: PDFDoc,
  opts: {
    title: string;
    body: string;
    tone?: "neutral" | "success" | "warning" | "danger";
  }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const tone = opts.tone ?? "neutral";
  const borderColor =
    tone === "success"
      ? BRAND.success
      : tone === "warning"
        ? BRAND.warning
        : tone === "danger"
          ? BRAND.danger
          : BRAND.accent;

  const fillColor =
    tone === "success"
      ? "#EEF8F3"
      : tone === "warning"
        ? "#FBF5E8"
        : tone === "danger"
          ? "#FCEDEA"
          : BRAND.accentSoft;

  doc.font("Helvetica-Bold").fontSize(10.2);
  const titleHeight = doc.heightOfString(opts.title, { width: w - 24 });

  doc.font("Helvetica").fontSize(9.3);
  const bodyHeight = doc.heightOfString(opts.body, {
    width: w - 24,
    lineGap: 1.5,
  });

  const blockHeight = titleHeight + bodyHeight + 18;
  ensureSpace(doc, blockHeight + 6);

  const y = doc.y;

  doc.save();
  doc.roundedRect(x, y, w, blockHeight, 9).fill(fillColor);
  doc
    .lineWidth(0.9)
    .strokeColor(borderColor)
    .roundedRect(x, y, w, blockHeight, 9)
    .stroke();
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10.2);
  doc.text(opts.title, x + 12, y + 8, { width: w - 24 });
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica").fontSize(9.3);
  doc.text(opts.body, x + 12, y + 23, { width: w - 24, lineGap: 1.5 });
  doc.restore();

  doc.y = y + blockHeight + 6;
}

function drawHeader(
  doc: PDFDoc,
  opts: { evidenceId: string; generatedAtUtc: string; status?: string }
): void {
  const left = doc.page.margins.left;
  const top = doc.page.margins.top;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.save();
  doc.rect(0, 0, doc.page.width, mmToPt(3)).fill(BRAND.accent);
  doc.restore();

  doc.x = left;
  doc.y = top;

  const logo = tryReadAsset("logo.png");
  let brandX = left;
  if (logo) {
    try {
      const h = mmToPt(14);
      const logoW = h * 4.6;
      doc.image(logo, left, doc.y - 2, { fit: [logoW, h] });
      brandX = left + logoW + 13;
    } catch {
      brandX = left;
    }
  }

  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(20.5);
  doc.text(BRAND.name, brandX, doc.y + 1, { continued: true });

  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(12.2);
  doc.text(` — ${BRAND.title}`);

  const badgeText = safe(opts.status, "").toUpperCase();
  if (badgeText) {
    const bx = left + w - 140;
    const by = top + 15;
    drawBadge(doc, textClamp(badgeText, 20), bx, by);
  }

  doc.moveDown(0.72);

  const metaW = w - 168;
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(10);
  doc.text(`Evidence ID: ${opts.evidenceId}`, left, doc.y, { width: metaW });
  doc.moveDown(0.18);
  doc.text(`Generated (UTC): ${opts.generatedAtUtc}`, left, doc.y, {
    width: metaW,
  });

  doc.moveDown(0.52);
  hr(doc);
  doc.moveDown(0.5);
}

function textClamp(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, Math.max(0, maxChars - 1))}…`
    : text;
}

function section(
  doc: PDFDoc,
  title: string,
  render: () => void,
  options?: { minSpace?: number }
): void {
  const minSpace = options?.minSpace ?? 52;

  ensureSpace(doc, minSpace);

  hr(doc);
  doc.moveDown(0.2);

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(12.5);
  doc.text(title, doc.page.margins.left, doc.y);
  doc.restore();

  doc.moveDown(0.12);
  render();
  doc.moveDown(0.2);
}

function safeParagraph(
  doc: PDFDoc,
  text: string,
  options?: { fontSize?: number; color?: string; gap?: number }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const fontSize = options?.fontSize ?? 9;
  const gap = options?.gap ?? 1.8;

  doc.font("Helvetica").fontSize(fontSize);
  const needed = doc.heightOfString(text, { width: w, lineGap: gap }) + 5;
  ensureSpace(doc, needed);

  doc.save();
  doc.fillColor(options?.color ?? BRAND.muted);
  doc.text(text, x, doc.y, { width: w, lineGap: gap });
  doc.restore();
}

function prettifySummaryText(input: string): string {
  const raw = safe(input, "");
  if (!raw || raw === "N/A") return "N/A";

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const parts = Object.entries(parsed).map(([k, v]) => {
      if (v === null || v === undefined) return `${k}: N/A`;
      if (typeof v === "object") return `${k}: ${JSON.stringify(v)}`;
      return `${k}: ${String(v)}`;
    });
    return parts.join(" • ");
  } catch {
    return raw
      .replace(/^\{/, "")
      .replace(/\}$/, "")
      .replace(/","/g, " • ")
      .replace(/":"/g, ": ")
      .replace(/"/g, "");
  }
}

function kvGrid(
  doc: PDFDoc,
  rows: Array<[string, string]>,
  options?: { colGap?: number }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colGap = options?.colGap ?? 16;
  const colW = (w - colGap) / 2;

  const calcCellHeight = (row?: [string, string]): number => {
    if (!row) return 0;
    const [k, v] = row;

    doc.font("Helvetica").fontSize(8.7);
    const keyH = doc.heightOfString(k, { width: colW });

    doc.font("Helvetica-Bold").fontSize(9.8);
    const valueH = doc.heightOfString(v, { width: colW });

    return keyH + valueH + 14;
  };

  const pairHeights: number[] = [];
  for (let i = 0; i < rows.length; i += 2) {
    pairHeights.push(
      Math.max(calcCellHeight(rows[i]), calcCellHeight(rows[i + 1]))
    );
  }

  const totalNeeded = pairHeights.reduce((a, b) => a + b, 0) + 4;
  ensureSpace(doc, totalNeeded);

  let currentY = doc.y;

  for (let i = 0; i < rows.length; i += 2) {
    const left = rows[i];
    const right = rows[i + 1];
    const rowHeight = pairHeights[i / 2];

    const renderCell = (row: [string, string] | undefined, colX: number) => {
      if (!row) return;
      const [k, v] = row;
      let y = currentY;

      doc.save();
      doc.fillColor(BRAND.muted).font("Helvetica").fontSize(8.7);
      doc.text(k, colX, y, { width: colW });
      doc.restore();

      y = doc.y + 1.5;

      doc.save();
      doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(9.8);
      doc.text(v, colX, y, { width: colW });
      doc.restore();
    };

    renderCell(left, x);
    renderCell(right, x + colW + colGap);

    currentY += rowHeight;
    doc.y = currentY;
  }
}

function monospaceStrip(
  doc: PDFDoc,
  label: string,
  value: string,
  options?: { maxChars?: number }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const maxChars = options?.maxChars;
  const finalValue =
    typeof maxChars === "number" ? summarizeText(value, maxChars) : value;

  const labelFontSize = 8.8;
  const codeFontSize = 8.8;
  const labelGapAfter = 5;
  const bottomPadding = 10;

  doc.font("Helvetica").fontSize(labelFontSize);
  const labelHeight = doc.heightOfString(label, { width: w });

  doc.font("Courier").fontSize(codeFontSize);
  const textHeight = doc.heightOfString(finalValue, {
    width: w,
    lineGap: 1.5,
  });
  const blockHeight = Math.max(16, textHeight + 8);

  const neededHeight =
    labelHeight + labelGapAfter + blockHeight + bottomPadding;
  ensureSpace(doc, neededHeight);

  const labelY = doc.y;

  doc.save();
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(labelFontSize);
  doc.text(label, x, labelY, { width: w });
  doc.restore();

  const blockY = doc.y + 3;

  doc.save();
  doc.opacity(0.045);
  doc.roundedRect(x - 3, blockY - 3, w + 6, blockHeight + 6, 7).fill(BRAND.ink);
  doc.opacity(1);
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Courier").fontSize(codeFontSize);
  doc.text(finalValue, x, blockY, {
    width: w,
    lineGap: 1.5,
  });
  doc.restore();

  doc.y = blockY + blockHeight;
  doc.moveDown(0.22);
}

function drawTable(
  doc: PDFDoc,
  headers: string[],
  rows: string[][],
  colWidths: number[]
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const headerH = 20;
  const rowPadY = 5;

  const calcRowHeight = (cells: string[]): number => {
    doc.font("Helvetica").fontSize(8.9);
    let maxH = 0;
    for (let i = 0; i < cells.length; i++) {
      const cw = colWidths[i];
      const h = doc.heightOfString(cells[i], {
        width: cw - 10,
        align: "left",
        lineGap: 1.5,
      });
      maxH = Math.max(maxH, h);
    }
    return Math.max(headerH, maxH + rowPadY * 2);
  };

  ensureSpace(doc, 120);

  const headerY = doc.y;

  doc.save();
  doc.opacity(0.06);
  doc.roundedRect(x, headerY, w, headerH, 5).fill(BRAND.accent);
  doc.opacity(1);
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(8.8);

  let cx = x;
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], cx + 5, headerY + 5.5, {
      width: colWidths[i] - 10,
      lineBreak: false,
    });
    cx += colWidths[i];
  }
  doc.restore();

  doc.y = headerY + headerH;
  hr(doc, doc.y);
  doc.moveDown(0.08);

  for (const r of rows) {
    const prettyRow = [...r];
    if (prettyRow[3]) {
      prettyRow[3] = prettifySummaryText(prettyRow[3]);
    }

    const rh = calcRowHeight(prettyRow);
    ensureSpace(doc, rh + 10);

    const rowY = doc.y;

    doc.save();
    doc.fillColor(BRAND.ink).font("Helvetica").fontSize(8.9);

    let rx = x;
    for (let i = 0; i < prettyRow.length; i++) {
      doc.text(prettyRow[i], rx + 5, rowY + rowPadY, {
        width: colWidths[i] - 10,
        lineGap: 1.5,
      });
      rx += colWidths[i];
    }
    doc.restore();

    doc.y = rowY + rh;
    hr(doc, doc.y);
    doc.moveDown(0.08);
  }
}

function drawQrBlock(
  doc: PDFDoc,
  opts: {
    title: string;
    qrBuffer: Buffer;
    size?: number;
    caption?: string;
    urlText?: string;
    urlLink?: string;
  }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const size = opts.size ?? 96;

  ensureSpace(doc, size + 60);

  const startY = doc.y;
  const blockH = Math.max(size + 16, 118);
  const textX = x + 14;
  const textW = w - size - 44;
  const qrX = x + w - size - 14;
  const qrY = startY + 11;

  doc.save();
  doc.opacity(0.035);
  doc.roundedRect(x, startY, w, blockH, 10).fill(BRAND.ink);
  doc.opacity(1);
  doc.restore();

  doc.save();
  doc.lineWidth(0.8).strokeColor(BRAND.line);
  doc.roundedRect(x, startY, w, blockH, 10).stroke();
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10);
  doc.text(opts.title, textX, startY + 12, { width: textW });
  doc.restore();

  let textY = startY + 30;

  if (opts.caption) {
    doc.save();
    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9.1);
    doc.text(opts.caption, textX, textY, {
      width: textW,
      lineGap: 1.5,
    });
    doc.restore();
    textY = doc.y + 5;
  }

  if (opts.urlText) {
    doc.save();
    doc.fillColor(BRAND.accent).font("Helvetica").fontSize(8.3);
    doc.text(opts.urlText, textX, textY, {
      width: textW,
      link: opts.urlLink,
      underline: Boolean(opts.urlLink),
      lineGap: 1.5,
    });
    doc.restore();
  }

  doc.image(opts.qrBuffer, qrX, qrY, { fit: [size, size] });

  doc.save();
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(7.7);
  doc.text("Scan QR", qrX, startY + blockH - 13, {
    width: size,
    align: "center",
    lineBreak: false,
  });
  doc.restore();

  doc.y = startY + blockH + 6;
}

async function tryGenerateQrPngBuffer(data: string): Promise<Buffer | null> {
  try {
    const QRCodeModule = (await import("qrcode")) as {
      toBuffer?: (
        text: string,
        opts?: Record<string, unknown>
      ) => Promise<Buffer>;
      default?: {
        toBuffer?: (
          text: string,
          opts?: Record<string, unknown>
        ) => Promise<Buffer>;
      };
    };

    const toBuffer = QRCodeModule.toBuffer ?? QRCodeModule.default?.toBuffer;

    if (!toBuffer) {
      throw new Error("qrcode.toBuffer not found");
    }

    return await toBuffer(data, {
      margin: 1,
      width: 240,
    });
  } catch (error) {
    console.error("[PDF][QR] Failed to generate QR:", error);
    return null;
  }
}

function addFooters(
  doc: PDFDoc,
  opts: { generatedAtUtc: string; reportVersion: number }
): void {
  const range = doc.bufferedPageRange();

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);

    const x = doc.page.margins.left;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const y = doc.page.height - doc.page.margins.bottom - 20;

    doc.save();
    doc.font("Helvetica").fontSize(8.6).fillColor(BRAND.muted);

    doc.text(
      `${BRAND.name} • Evidence Report v${opts.reportVersion} • Generated (UTC): ${opts.generatedAtUtc}`,
      x,
      y,
      { width: w, align: "left" }
    );
    doc.text(`Page ${i + 1} / ${range.count}`, x, y, {
      width: w,
      align: "right",
    });

    doc.restore();
  }
}

function buildVerifyUrl(evidenceId: string, provided?: string | null): string {
  const v = typeof provided === "string" ? provided.trim() : "";
  if (v) return v;

  const base = (
    env("REPORT_VERIFY_BASE_URL") ?? "https://app.proovra.com/verify"
  )
    .trim()
    .replace(/\/+$/, "");

  return `${base}/${encodeURIComponent(evidenceId)}`;
}

function estimateEvidenceSummarySectionHeight(
  doc: PDFDoc,
  rows: Array<[string, string]>
): number {
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colGap = 16;
  const colW = (w - colGap) / 2;

  const calcCellHeight = (row?: [string, string]): number => {
    if (!row) return 0;
    const [k, v] = row;

    doc.font("Helvetica").fontSize(8.7);
    const keyH = doc.heightOfString(k, { width: colW });

    doc.font("Helvetica-Bold").fontSize(9.8);
    const valueH = doc.heightOfString(v, { width: colW });

    return keyH + valueH + 14;
  };

  let gridHeight = 0;
  for (let i = 0; i < rows.length; i += 2) {
    gridHeight += Math.max(calcCellHeight(rows[i]), calcCellHeight(rows[i + 1]));
  }

  return 18 + 10 + gridHeight + 12;
}

function estimateForensicIntegrityStatementHeight(
  doc: PDFDoc,
  opts: { verifyUrl: string; structureLabel: string }
): number {
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.font("Helvetica").fontSize(10.2);
  const intro1 = doc.heightOfString(
    "This report was generated by the PROOVRA Digital Evidence Integrity System.",
    { width: w, lineGap: 1.8 }
  );

  doc.font("Helvetica").fontSize(9.8);
  const intro2 = doc.heightOfString(
    "PROOVRA applies cryptographic integrity controls, structured evidence fingerprinting, trusted timestamping records, OpenTimestamps proofing, and immutable storage protection designed to preserve the integrity state of the submitted evidence at the time of completion.",
    { width: w, lineGap: 1.8 }
  );

  doc.font("Helvetica-Bold").fontSize(10.1);
  const h1 = doc.heightOfString("Integrity materials included in this report:", {
    width: w,
  });
  const h2 = doc.heightOfString("Independent review may include:", {
    width: w,
  });

  doc.font("Helvetica").fontSize(9.8);
  const bullets = [
    opts.structureLabel === "Single evidence item"
      ? "• A SHA-256 cryptographic hash of the original evidence file"
      : "• A SHA-256 cryptographic hash representing the multipart evidence set",
    "• A canonical fingerprint record describing the evidence state and metadata",
    "• A fingerprint hash derived from the canonical record",
    "• A digital signature generated using the PROOVRA signing key",
    "• A trusted RFC 3161 timestamp token issued by the configured Time Stamping Authority, when available",
    "• An OpenTimestamps proof for the evidence digest, when available",
    "• A chain of custody timeline documenting relevant system events",
    "• Immutable storage controls using AWS S3 Object Lock, when enabled for the evidence object",
  ];

  const steps =
    opts.structureLabel === "Single evidence item"
      ? [
          "1. Obtaining the original evidence file",
          "2. Computing the SHA-256 hash of the evidence file",
          "3. Comparing the computed hash with the value listed in this report",
          "4. Verifying the digital signature using the provided public key",
          "5. Verifying the RFC 3161 timestamp token, when present",
          "6. Verifying the OpenTimestamps proof, when present",
          "7. Reviewing the recorded chain of custody events",
          "8. Reviewing immutable storage protection details, when present",
        ]
      : [
          "1. Obtaining the complete multipart evidence set",
          "2. Reviewing the canonical fingerprint and listed evidence parts",
          "3. Validating the multipart composite hash against the included materials",
          "4. Verifying the digital signature using the provided public key",
          "5. Verifying the RFC 3161 timestamp token, when present",
          "6. Verifying the OpenTimestamps proof, when present",
          "7. Reviewing the recorded chain of custody events",
          "8. Reviewing immutable storage protection details, when present",
        ];

  const bulletsHeight = bullets.reduce(
    (sum, item) => sum + doc.heightOfString(item, { width: w, lineGap: 1.8 }),
    0
  );

  const stepsHeight = steps.reduce(
    (sum, item) => sum + doc.heightOfString(item, { width: w, lineGap: 1.8 }),
    0
  );

  doc.font("Helvetica").fontSize(9.2);
  const note = doc.heightOfString(
    "Where present, the RFC 3161 timestamp provides evidence that the signed integrity state existed at or before the issuance time recorded by the Time Stamping Authority. Where present, OpenTimestamps provides additional independent public-proof anchoring information tied to the evidence hash.",
    { width: w, lineGap: 1.8 }
  );

  doc.font("Helvetica-Bold").fontSize(10.2);
  const legalTitle = doc.heightOfString("Legal Notice", { width: w - 24 });

  doc.font("Helvetica").fontSize(9.3);
  const legalBody = doc.heightOfString(
    "Cryptographic verification confirms integrity of the recorded evidence state only. It does not independently establish authorship, factual accuracy, legal admissibility, context, or probative weight. These issues remain subject to judicial, administrative, or expert evaluation under the applicable law and procedure.",
    { width: w - 24, lineGap: 1.5 }
  );
  const legalBlock = legalTitle + legalBody + 24;

  doc.font("Helvetica-Bold").fontSize(9.2);
  const linkLabel = doc.heightOfString("Verification link:", { width: w });

  doc.font("Helvetica").fontSize(8.8);
  const link = doc.heightOfString(opts.verifyUrl, {
    width: w,
    lineGap: 1.5,
  });

  return (
    28 +
    intro1 +
    intro2 +
    h1 +
    bulletsHeight +
    h2 +
    stepsHeight +
    note +
    legalBlock +
    linkLabel +
    link
  );
}

function renderForensicIntegrityStatement(
  doc: PDFDoc,
  opts: { verifyUrl: string; structureLabel: string }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  safeParagraph(
    doc,
    "This report was generated by the PROOVRA Digital Evidence Integrity System.",
    { fontSize: 10.2, color: BRAND.ink }
  );
  doc.moveDown(0.15);

  safeParagraph(
    doc,
    "PROOVRA applies cryptographic integrity controls, structured evidence fingerprinting, trusted timestamping records, OpenTimestamps proofing, and immutable storage protection designed to preserve the integrity state of the submitted evidence at the time of completion.",
    { fontSize: 9.8, color: BRAND.ink }
  );
  doc.moveDown(0.18);

  doc.save();
  doc.fillColor(BRAND.accent).font("Helvetica-Bold").fontSize(10.1);
  doc.text("Integrity materials included in this report:", x, doc.y, { width: w });
  doc.restore();
  doc.moveDown(0.12);

  const bullets = [
    opts.structureLabel === "Single evidence item"
      ? "A SHA-256 cryptographic hash of the original evidence file"
      : "A SHA-256 cryptographic hash representing the multipart evidence set",
    "A canonical fingerprint record describing the evidence state and metadata",
    "A fingerprint hash derived from the canonical record",
    "A digital signature generated using the PROOVRA signing key",
    "A trusted RFC 3161 timestamp token issued by the configured Time Stamping Authority, when available",
    "An OpenTimestamps proof, when available",
    "A custody timeline documenting relevant system events",
    "Immutable storage protection using AWS S3 Object Lock, when available",
  ];

  for (const b of bullets) {
    safeParagraph(doc, `• ${b}`, { fontSize: 9.8, color: BRAND.ink });
  }

  doc.moveDown(0.16);

  doc.save();
  doc.fillColor(BRAND.accent).font("Helvetica-Bold").fontSize(10.1);
  doc.text("Independent review may include:", x, doc.y, { width: w });
  doc.restore();
  doc.moveDown(0.12);

  const steps =
    opts.structureLabel === "Single evidence item"
      ? [
          "Obtaining the original evidence file",
          "Computing the SHA-256 hash of the evidence file",
          "Comparing the computed hash with the value listed in this report",
          "Verifying the digital signature using the provided public key",
          "Verifying the RFC 3161 timestamp token, when present",
          "Verifying the OpenTimestamps proof, when present",
          "Reviewing the recorded chain of custody events",
          "Reviewing immutable storage details, when present",
        ]
      : [
          "Obtaining the complete multipart evidence set",
          "Reviewing the canonical fingerprint and listed evidence parts",
          "Validating the multipart composite hash against the included materials",
          "Verifying the digital signature using the provided public key",
          "Verifying the RFC 3161 timestamp token, when present",
          "Verifying the OpenTimestamps proof, when present",
          "Reviewing the recorded chain of custody events",
          "Reviewing immutable storage details, when present",
        ];

  for (let i = 0; i < steps.length; i++) {
    safeParagraph(doc, `${i + 1}. ${steps[i]}`, {
      fontSize: 9.8,
      color: BRAND.ink,
    });
  }

  doc.moveDown(0.16);

  safeParagraph(
    doc,
    "Where present, the RFC 3161 timestamp provides evidence that the signed integrity state existed at or before the issuance time recorded by the Time Stamping Authority. Where present, OpenTimestamps provides additional public-proof anchoring tied to the evidence digest.",
    { fontSize: 9.2, color: BRAND.muted }
  );
  doc.moveDown(0.16);

  drawCallout(doc, {
    title: "Legal Notice",
    body:
      "Cryptographic verification confirms integrity of the recorded evidence state only. It does not independently establish authorship, factual accuracy, legal admissibility, context, or probative weight. These issues remain subject to judicial, administrative, or expert evaluation under the applicable law and procedure.",
    tone: "warning",
  });

  const labelHeight = doc.heightOfString("Verification link:", { width: w });
  const linkHeight = doc.heightOfString(opts.verifyUrl, {
    width: w,
    lineGap: 1.5,
  });

  ensureSpace(doc, labelHeight + linkHeight + 12);

  doc.save();
  doc.fillColor(BRAND.accent).font("Helvetica-Bold").fontSize(9.2);
  doc.text("Verification link:", x, doc.y, { width: w });
  doc.restore();
  doc.moveDown(0.08);

  doc.save();
  doc.fillColor(BRAND.accent).font("Helvetica").fontSize(8.8);
  doc.text(opts.verifyUrl, x, doc.y, {
    width: w,
    link: opts.verifyUrl,
    underline: true,
    lineGap: 1.5,
  });
  doc.restore();
}

export async function buildReportPdf(params: {
  evidence: ReportEvidence;
  custodyEvents: ReportCustodyEvent[];
  version: number;
  generatedAtUtc: string;
  buildInfo?: string | null;
  verifyUrl?: string | null;
  downloadUrl?: string | null;
}): Promise<Buffer> {
  const doc = new PDFDocument({
    autoFirstPage: true,
    margin: 50,
    bufferPages: true,
  });

  paintPageBackground(doc);
  doc.on("pageAdded", () => paintPageBackground(doc));

  const buildToken = params.buildInfo
    ? `;PROOVRA_BUILD=${params.buildInfo}`
    : "";

  doc.info = {
    Title: `${BRAND.name} — Verifiable Evidence Report`,
    Subject:
      "Evidence Summary > Chain of Custody > Technical Appendix > Verification",
    Keywords: `PROOVRA_REPORT_VERSION=${params.version};PROOVRA_GENERATED_AT=${params.generatedAtUtc}${buildToken}`,
    Creator: BRAND.name,
    Producer: BRAND.name,
    CreationDate: new Date(params.generatedAtUtc),
    ModDate: new Date(params.generatedAtUtc),
  };

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const finalDisplayStatus = "REPORTED";
  const verifyUrl = buildVerifyUrl(params.evidence.id, params.verifyUrl);
  const technicalUrl = verifyUrl.includes("?")
    ? `${verifyUrl}&tab=technical`
    : `${verifyUrl}?tab=technical`;

  const fingerprintSummary = parseFingerprintSummary(
    params.evidence.fingerprintCanonicalJson
  );
  const structureLabel = evidenceStructureLabel(fingerprintSummary);

  const headerContext: HeaderContext = {
    evidenceId: params.evidence.id,
    generatedAtUtc: params.generatedAtUtc,
    status: finalDisplayStatus,
  };

  setHeaderContext(headerContext);
  drawHeader(doc, headerContext);

  {
    const x = doc.page.margins.left;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    const verified =
      Boolean(params.evidence.fileSha256) &&
      Boolean(params.evidence.fingerprintHash) &&
      Boolean(params.evidence.signatureBase64);

    const verdict = verified
      ? "Integrity Verified"
      : "Integrity Review Required";

    const color = verified ? BRAND.success : BRAND.danger;

    ensureSpace(doc, 190);

    doc.save();
    doc.fillColor(color).font("Helvetica-Bold").fontSize(13.2);
    doc.text(verdict, x, doc.y, { width: w });
    doc.restore();

    doc.moveDown(0.22);

    if (verified) {
      safeParagraph(doc, "• File hash matches the recorded fingerprint state", {
        fontSize: 9.8,
        color: BRAND.ink,
      });
      safeParagraph(doc, "• Digital signature materials are present", {
        fontSize: 9.8,
        color: BRAND.ink,
      });
      safeParagraph(
        doc,
        `• ${structureLabel} detected (${Math.max(1, fingerprintSummary.itemCount)} item${Math.max(1, fingerprintSummary.itemCount) === 1 ? "" : "s"})`,
        { fontSize: 9.8, color: BRAND.ink }
      );

      const tsaTone = normalizeTimestampStatus(params.evidence.tsaStatus);
      if (tsaTone === "SUCCESS") {
        safeParagraph(doc, "• Trusted RFC 3161 timestamp record available", {
          fontSize: 9.8,
          color: BRAND.ink,
        });
      } else if (tsaTone === "WARNING") {
        safeParagraph(doc, "• RFC 3161 timestamp record is pending or unavailable", {
          fontSize: 9.8,
          color: BRAND.ink,
        });
      } else if (tsaTone === "DANGER") {
        safeParagraph(doc, "• RFC 3161 timestamp record reported a failure state", {
          fontSize: 9.8,
          color: BRAND.ink,
        });
      }

      const otsTone = normalizeOtsStatus(params.evidence.otsStatus);
      if (otsTone === "SUCCESS") {
        safeParagraph(doc, "• OpenTimestamps proof is anchored", {
          fontSize: 9.8,
          color: BRAND.ink,
        });
      } else if (otsTone === "WARNING") {
        safeParagraph(doc, "• OpenTimestamps proof exists and is still pending anchor completion", {
          fontSize: 9.8,
          color: BRAND.ink,
        });
      } else if (otsTone === "DANGER") {
        safeParagraph(doc, "• OpenTimestamps proof reported a failure state", {
          fontSize: 9.8,
          color: BRAND.ink,
        });
      }

      const storageTone = normalizeStorageProtectionStatus(
        params.evidence.storageImmutable,
        params.evidence.storageObjectLockMode,
        params.evidence.storageObjectLockRetainUntilUtc
      );

      if (storageTone === "SUCCESS") {
        safeParagraph(
          doc,
          "• Immutable storage protection verified (AWS S3 Object Lock / COMPLIANCE)",
          { fontSize: 9.8, color: BRAND.ink }
        );
      } else if (storageTone === "WARNING") {
        safeParagraph(
          doc,
          "• Storage protection is present but not fully verified as COMPLIANCE immutable storage",
          { fontSize: 9.8, color: BRAND.ink }
        );
      } else if (storageTone === "DANGER") {
        safeParagraph(
          doc,
          "• Storage protection information indicates a non-compliant state",
          { fontSize: 9.8, color: BRAND.ink }
        );
      }
    } else {
      safeParagraph(doc, "• Evidence integrity could not be fully verified", {
        fontSize: 9.8,
        color: BRAND.ink,
      });
    }

    doc.moveDown(0.18);

    drawCallout(doc, {
      title: "Scope of this conclusion",
      body: verified
        ? "This result supports integrity of the recorded evidence state at completion. It does not, by itself, prove authorship, truthfulness of content, or legal admissibility."
        : "This report should be reviewed manually. Missing or incomplete integrity materials may limit technical verification.",
      tone: verified ? "success" : "danger",
    });

    drawCallout(doc, {
      title: "Important legal limitation",
      body:
        "PROOVRA verifies integrity of the recorded digital evidence state. It does not independently establish who created the content, whether the depicted event is true, or whether a court or authority must accept the material.",
      tone: "warning",
    });

    hr(doc);
    doc.moveDown(0.25);
  }

  {
    const evidenceSummaryRows: Array<[string, string]> = [
      ["Evidence ID", safe(params.evidence.id)],
      ["Status", finalDisplayStatus],
      ["Display Label", "Verified / Reported"],
      ["Captured (UTC)", safe(params.evidence.capturedAtUtc)],
      ["Uploaded (UTC)", safe(params.evidence.uploadedAtUtc)],
      ["Signed (UTC)", safe(params.evidence.signedAtUtc)],
      ["Report Generated (UTC)", safe(params.evidence.reportGeneratedAtUtc)],
      ["Evidence Structure", structureLabel],
      ["Size", formatBytesHuman(params.evidence.sizeBytes)],
      [
        "Duration",
        params.evidence.durationSec
          ? `${params.evidence.durationSec} sec`
          : "N/A",
      ],
      ["File SHA-256", shortHash(params.evidence.fileSha256)],
      ["Fingerprint Hash", shortHash(params.evidence.fingerprintHash)],
      ["Signing Key", safe(params.evidence.signingKeyId)],
      ["Signing Key Version", String(params.evidence.signingKeyVersion)],
      ["RFC 3161 Provider", safe(params.evidence.tsaProvider)],
      ["RFC 3161 Time (UTC)", safe(params.evidence.tsaGenTimeUtc)],
      ["RFC 3161 Status", safe(params.evidence.tsaStatus)],
      ["OTS Status", safe(params.evidence.otsStatus)],
      ["OTS Anchored (UTC)", safe(params.evidence.otsAnchoredAtUtc)],
      ["Storage Region", safe(params.evidence.storageRegion)],
      ["Object Lock Mode", safe(params.evidence.storageObjectLockMode)],
      [
        "Retention Until (UTC)",
        safe(params.evidence.storageObjectLockRetainUntilUtc),
      ],
      [
        "Legal Hold",
        safe(params.evidence.storageObjectLockLegalHoldStatus, "OFF"),
      ],
      [
        "Immutable Storage",
        params.evidence.storageImmutable ? "Verified" : "Not Fully Verified",
      ],
    ];

    if (fingerprintSummary.itemCount > 1) {
      evidenceSummaryRows.push(
        ["Total Items", String(fingerprintSummary.itemCount)],
        ["Image Items", String(fingerprintSummary.imageCount)],
        ["Video Items", String(fingerprintSummary.videoCount)],
        ["Audio Items", String(fingerprintSummary.audioCount)],
        ["Document Items", String(fingerprintSummary.documentCount)],
        ["Fingerprint Parts", String(fingerprintSummary.partsCount)],
        [
          "Package MIME Types",
          fingerprintSummary.mimeTypes.length > 0
            ? summarizeText(fingerprintSummary.mimeTypes.join(", "), 80)
            : "N/A",
        ],
        ["Initial MIME at Creation", safe(params.evidence.mimeType)]
      );
    } else {
      evidenceSummaryRows.push(
        ["Total Items", "1"],
        ["MIME Type", safe(params.evidence.mimeType)]
      );
    }

    const neededHeight = estimateEvidenceSummarySectionHeight(
      doc,
      evidenceSummaryRows
    );
    const availableHeight =
      doc.page.height - doc.page.margins.bottom - 10 - doc.y;

    if (availableHeight < neededHeight) {
      addPageWithHeader(doc);
    }

    doc.save();
    doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(15);
    doc.text("Evidence Overview", doc.page.margins.left, doc.y);
    doc.restore();
    doc.moveDown(0.14);

    kvGrid(doc, evidenceSummaryRows);
    doc.moveDown(0.12);
  }

  addPageWithHeader(doc);

  section(
    doc,
    "Quick Verification",
    () => {
      const x = doc.page.margins.left;
      const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      safeParagraph(
        doc,
        "Use the verification page to review integrity details, custody events, technical validation materials, OpenTimestamps status, and immutable storage protection associated with this evidence record.",
        { fontSize: 9.7, color: BRAND.muted, gap: 1.8 }
      );
      doc.moveDown(0.14);

      ensureSpace(
        doc,
        doc.heightOfString("Verify link:", { width: w }) +
          doc.heightOfString(verifyUrl, { width: w }) +
          12
      );

      doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(9.8);
      doc.text("Verify link:", x, doc.y, { width: w });
      doc.moveDown(0.08);

      doc.fillColor(BRAND.accent).font("Helvetica").fontSize(8.9);
      doc.text(verifyUrl, x, doc.y, {
        width: w,
        link: verifyUrl,
        underline: true,
      });
      doc.moveDown(0.18);

      safeParagraph(
        doc,
        "Technical verification supports detection of post-completion changes. It does not independently determine authorship, authenticity of real-world events, or legal effect.",
        { fontSize: 9.2, color: BRAND.muted, gap: 1.8 }
      );
    },
    { minSpace: 64 }
  );

  {
    const qrBuf = await tryGenerateQrPngBuffer(verifyUrl);
    if (qrBuf) {
      drawQrBlock(doc, {
        title: "Open verification page",
        qrBuffer: qrBuf,
        size: 102,
        caption: "Scan to open the public verification page for this evidence record.",
        urlText: summarizeText(verifyUrl, 90),
        urlLink: verifyUrl,
      });
    }
  }

  ensurePageWithHeader(doc, 220);

  section(
    doc,
    "Immutable Storage Protection",
    () => {
      const mode = safe(params.evidence.storageObjectLockMode);
      const retainUntil = safe(params.evidence.storageObjectLockRetainUntilUtc);
      const legalHold = safe(
        params.evidence.storageObjectLockLegalHoldStatus,
        "OFF"
      );
      const immutable =
        params.evidence.storageImmutable === true &&
        mode.toUpperCase() === "COMPLIANCE" &&
        retainUntil !== "N/A";

      kvGrid(doc, [
        ["Storage Provider", "AWS S3 Object Lock"],
        ["Immutable Storage", immutable ? "Verified" : "Not Fully Verified"],
        ["Object Lock Mode", mode],
        ["Retention Until (UTC)", retainUntil],
        ["Legal Hold", legalHold],
        ["Storage Region", safe(params.evidence.storageRegion)],
        ["Bucket", safe(params.evidence.storageBucket)],
        ["Object Key", summarizeText(safe(params.evidence.storageKey), 72)],
      ]);

      doc.moveDown(0.14);

      drawCallout(doc, {
        title: immutable
          ? "Immutable storage verified"
          : "Immutable storage requires review",
        body: immutable
          ? "This evidence object is recorded as protected by AWS S3 Object Lock in COMPLIANCE mode. This is designed to prevent deletion or overwrite until the listed retention date expires."
          : "Immutable storage details are incomplete or not fully verified in this report. Review the verification page or backend metadata before relying on storage immutability conclusions.",
        tone: immutable ? "success" : "warning",
      });
    },
    { minSpace: 120 }
  );

  ensurePageWithHeader(doc, 190);

  section(
    doc,
    "Trusted Timestamping",
    () => {
      kvGrid(doc, [
        ["RFC 3161 Provider", safe(params.evidence.tsaProvider)],
        ["RFC 3161 URL", safe(params.evidence.tsaUrl)],
        ["RFC 3161 Serial", safe(params.evidence.tsaSerialNumber)],
        ["RFC 3161 Time (UTC)", safe(params.evidence.tsaGenTimeUtc)],
        ["RFC 3161 Hash Algorithm", safe(params.evidence.tsaHashAlgorithm)],
        ["RFC 3161 Status", safe(params.evidence.tsaStatus)],

        ["OTS Status", safe(params.evidence.otsStatus)],
        ["OTS Calendar", safe(params.evidence.otsCalendar)],
        ["OTS Anchored At (UTC)", safe(params.evidence.otsAnchoredAtUtc)],
        ["OTS Upgraded At (UTC)", safe(params.evidence.otsUpgradedAtUtc)],
        ["OTS Bitcoin TxID", shortHash(params.evidence.otsBitcoinTxid)],
        ["OTS Hash", shortHash(params.evidence.otsHash)],
      ]);

      doc.moveDown(0.14);

      const otsTone = normalizeOtsStatus(params.evidence.otsStatus);
      drawCallout(doc, {
        title:
          otsTone === "SUCCESS"
            ? "OpenTimestamps anchored"
            : otsTone === "WARNING"
              ? "OpenTimestamps pending"
              : otsTone === "DANGER"
                ? "OpenTimestamps failed"
                : "OpenTimestamps unavailable",
        body:
          otsTone === "SUCCESS"
            ? "An OpenTimestamps proof has been generated and upgraded to an anchored state. This provides additional independent public-proof evidence tied to the recorded evidence digest."
            : otsTone === "WARNING"
              ? "An OpenTimestamps proof is present but has not yet been upgraded to a final anchored state."
              : otsTone === "DANGER"
                ? `OpenTimestamps reported a failure state. ${safe(params.evidence.otsFailureReason, "")}`.trim()
                : "No OpenTimestamps proof is recorded for this evidence item.",
        tone:
          otsTone === "SUCCESS"
            ? "success"
            : otsTone === "WARNING"
              ? "warning"
              : otsTone === "DANGER"
                ? "danger"
                : "neutral",
      });
    },
    { minSpace: 120 }
  );

  ensurePageWithHeader(doc, 180);

  section(
    doc,
    "Access to Original Evidence",
    () => {
      safeParagraph(
        doc,
        "The original evidence file is not publicly exposed through this report. Access to the underlying stored evidence remains controlled by the authorized account or workspace with the relevant permissions.",
        { fontSize: 9.4, color: BRAND.ink, gap: 1.8 }
      );
      doc.moveDown(0.14);

      if (fingerprintSummary.itemCount > 1) {
        drawCallout(doc, {
          title: "Multipart evidence package",
          body: `This evidence record contains ${fingerprintSummary.itemCount} items grouped into a single signed evidence package. Integrity review should consider the complete package rather than an isolated item only.`,
          tone: "neutral",
        });
      } else {
        drawCallout(doc, {
          title: "Single evidence item",
          body: "This evidence record represents a single signed evidence item. Integrity review should evaluate the file hash, fingerprint hash, signature, timestamp records, OpenTimestamps proof status, custody chain, and immutable storage protection together.",
          tone: "neutral",
        });
      }

      safeParagraph(
        doc,
        "Use the verification page and technical appendix in this report to review the integrity materials associated with the evidence record.",
        { fontSize: 8.9, color: BRAND.muted, gap: 1.8 }
      );
    },
    { minSpace: 84 }
  );

  ensurePageWithHeader(doc, 220);

  section(
    doc,
    "Chain of Custody",
    () => {
      const innerW =
        doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const colWidths = [
        Math.max(44, innerW * 0.08),
        Math.max(118, innerW * 0.24),
        Math.max(132, innerW * 0.22),
        innerW -
          (Math.max(44, innerW * 0.08) +
            Math.max(118, innerW * 0.24) +
            Math.max(132, innerW * 0.22)),
      ];

      const headers = ["Seq", "At (UTC)", "Event", "Summary"];
      const rows = params.custodyEvents.map((ev) => [
        String(ev.sequence),
        safe(ev.atUtc),
        safe(ev.eventType),
        safe(ev.payloadSummary),
      ]);

      drawTable(doc, headers, rows, colWidths);
    },
    { minSpace: 110 }
  );

  ensurePageWithHeader(doc, 360);

  section(
    doc,
    "Technical Appendix — Cryptographic Materials",
    () => {
      monospaceStrip(doc, "File SHA-256", safe(params.evidence.fileSha256));
      monospaceStrip(doc, "Fingerprint Hash", safe(params.evidence.fingerprintHash));
      monospaceStrip(
        doc,
        "Signing Key ID / Version",
        `${safe(params.evidence.signingKeyId)} / ${params.evidence.signingKeyVersion}`
      );
      monospaceStrip(
        doc,
        "Signature (Base64) (excerpt)",
        safe(params.evidence.signatureBase64),
        { maxChars: 260 }
      );
      monospaceStrip(
        doc,
        "Public Key (PEM) (excerpt)",
        safe(params.evidence.publicKeyPem),
        { maxChars: 260 }
      );
      monospaceStrip(
        doc,
        "Fingerprint Canonical JSON (excerpt)",
        safe(params.evidence.fingerprintCanonicalJson),
        { maxChars: 320 }
      );

      if (fingerprintSummary.itemCount > 1) {
        ensureSpace(doc, 180);

        doc.save();
        doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10.6);
        doc.text("Multipart Evidence Summary", doc.page.margins.left, doc.y);
        doc.restore();
        doc.moveDown(0.14);

        kvGrid(doc, [
          ["Structure", structureLabel],
          ["Total Items", String(fingerprintSummary.itemCount)],
          ["Fingerprint Parts", String(fingerprintSummary.partsCount)],
          ["Images", String(fingerprintSummary.imageCount)],
          ["Videos", String(fingerprintSummary.videoCount)],
          ["Audio", String(fingerprintSummary.audioCount)],
          ["Documents", String(fingerprintSummary.documentCount)],
          [
            "MIME Types",
            fingerprintSummary.mimeTypes.length > 0
              ? summarizeText(fingerprintSummary.mimeTypes.join(", "), 80)
              : "N/A",
          ],
        ]);

        doc.moveDown(0.12);

        safeParagraph(
          doc,
          "For multipart evidence, integrity is evaluated against the completed evidence package as represented in the canonical fingerprint. Review should therefore consider the complete set of evidence items, not an isolated part only.",
          { fontSize: 9, color: BRAND.muted }
        );
        doc.moveDown(0.14);
      }

      ensureSpace(doc, 220);

      doc.save();
      doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10.6);
      doc.text("RFC 3161 Time Stamping Authority", doc.page.margins.left, doc.y);
      doc.restore();
      doc.moveDown(0.14);

      kvGrid(doc, [
        ["Timestamp Provider", safe(params.evidence.tsaProvider)],
        ["Timestamp URL", safe(params.evidence.tsaUrl)],
        ["Serial Number", safe(params.evidence.tsaSerialNumber)],
        ["Generation Time (UTC)", safe(params.evidence.tsaGenTimeUtc)],
        ["Hash Algorithm", safe(params.evidence.tsaHashAlgorithm)],
        ["Timestamp Status", safe(params.evidence.tsaStatus)],
      ]);

      ensureSpace(doc, 70);
      monospaceStrip(
        doc,
        "Timestamp Message Imprint",
        safe(params.evidence.tsaMessageImprint),
        { maxChars: 140 }
      );

      if (params.evidence.tsaTokenBase64) {
        monospaceStrip(
          doc,
          "Timestamp Token (Base64) (excerpt)",
          safe(params.evidence.tsaTokenBase64),
          { maxChars: 220 }
        );
      }

      {
        const status = safe(params.evidence.tsaStatus).toUpperCase();
        const tone = normalizeTimestampStatus(status);
        const x = doc.page.margins.left;
        const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

        const color =
          tone === "SUCCESS"
            ? BRAND.success
            : tone === "WARNING"
              ? BRAND.warning
              : tone === "DANGER"
                ? BRAND.danger
                : BRAND.muted;

        ensureSpace(doc, 42);

        doc.save();
        doc.fillColor(BRAND.muted).font("Helvetica").fontSize(8.8);
        doc.text("RFC 3161 Timestamp Status", x, doc.y, { width: w });
        doc.restore();

        doc.moveDown(0.06);

        doc.save();
        doc.fillColor(color).font("Helvetica-Bold").fontSize(10.6);
        doc.text(status || "UNAVAILABLE", x, doc.y, { width: w });
        doc.restore();

        doc.moveDown(0.2);
      }

      if (params.evidence.tsaFailureReason) {
        monospaceStrip(
          doc,
          "Timestamp Failure / Detail",
          summarizeText(safe(params.evidence.tsaFailureReason), 160),
          { maxChars: 160 }
        );
      }

      ensureSpace(doc, 220);

      doc.save();
      doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10.6);
      doc.text("OpenTimestamps", doc.page.margins.left, doc.y);
      doc.restore();
      doc.moveDown(0.14);

      kvGrid(doc, [
        ["OTS Status", safe(params.evidence.otsStatus)],
        ["OTS Calendar", safe(params.evidence.otsCalendar)],
        ["OTS Anchored At (UTC)", safe(params.evidence.otsAnchoredAtUtc)],
        ["OTS Upgraded At (UTC)", safe(params.evidence.otsUpgradedAtUtc)],
        ["OTS Bitcoin TxID", safe(params.evidence.otsBitcoinTxid)],
        ["OTS Hash", safe(params.evidence.otsHash)],
      ]);

      if (params.evidence.otsProofBase64) {
        monospaceStrip(
          doc,
          "OTS Proof (Base64) (excerpt)",
          safe(params.evidence.otsProofBase64),
          { maxChars: 220 }
        );
      }

      if (params.evidence.otsFailureReason) {
        monospaceStrip(
          doc,
          "OTS Failure / Detail",
          summarizeText(safe(params.evidence.otsFailureReason), 160),
          { maxChars: 160 }
        );
      }

      {
        const status = safe(params.evidence.otsStatus).toUpperCase();
        const tone = normalizeOtsStatus(status);
        const x = doc.page.margins.left;
        const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

        const color =
          tone === "SUCCESS"
            ? BRAND.success
            : tone === "WARNING"
              ? BRAND.warning
              : tone === "DANGER"
                ? BRAND.danger
                : BRAND.muted;

        ensureSpace(doc, 42);

        doc.save();
        doc.fillColor(BRAND.muted).font("Helvetica").fontSize(8.8);
        doc.text("OpenTimestamps Status", x, doc.y, { width: w });
        doc.restore();

        doc.moveDown(0.06);

        doc.save();
        doc.fillColor(color).font("Helvetica-Bold").fontSize(10.6);
        doc.text(status || "UNAVAILABLE", x, doc.y, { width: w });
        doc.restore();

        doc.moveDown(0.2);
      }

      safeParagraph(
        doc,
        "Full technical materials can be retrieved via the technical verification view. Technical validation is a forensic support mechanism and does not replace legal advice, procedural review, or expert examination where required.",
        { fontSize: 8.9, color: BRAND.muted }
      );
    },
    { minSpace: 120 }
  );

  {
    const qrBuf = await tryGenerateQrPngBuffer(technicalUrl);
    if (qrBuf) {
      drawQrBlock(doc, {
        title: "Technical materials",
        qrBuffer: qrBuf,
        size: 100,
        caption:
          "Scan to open the technical verification view for this evidence item.",
        urlText: summarizeText(technicalUrl, 90),
        urlLink: technicalUrl,
      });
    }
  }

  const forensicBlockHeight = estimateForensicIntegrityStatementHeight(doc, {
    verifyUrl,
    structureLabel,
  });

  ensurePageWithHeader(doc, forensicBlockHeight + 40);

  section(
    doc,
    "Forensic Integrity Statement",
    () => {
      renderForensicIntegrityStatement(doc, {
        verifyUrl,
        structureLabel,
      });
    },
    { minSpace: 140 }
  );

  addFooters(doc, {
    generatedAtUtc: params.generatedAtUtc,
    reportVersion: params.version,
  });

  const endPromise = new Promise<void>((resolve, reject) => {
    doc.once("end", resolve);
    doc.once("error", reject);
  });

  doc.end();
  await endPromise;

  const pdf = Buffer.concat(chunks);
  return signPdfIfEnabled(pdf);
}