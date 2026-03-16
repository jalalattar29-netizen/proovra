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
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
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

function shortHash(h: string, head = 10, tail = 8): string {
  const t = safe(h, "");
  if (!t) return "N/A";
  if (t.length <= head + tail + 3) return t;
  return `${t.slice(0, head)}…${t.slice(-tail)}`;
}

function mmToPt(mm: number): number {
  return (mm * 72) / 25.4;
}

/**
 * Assets resolution:
 * - In dev (ts): services/worker/src/pdf/assets
 * - In prod (docker runner): dist/pdf/assets (copied by scripts/copy-assets.mjs)
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ASSETS_CANDIDATES: string[] = [
  path.resolve(__dirname, "assets"),
  path.resolve(__dirname, "../pdf/assets"),
  path.resolve(__dirname, "../assets"),
  path.resolve(process.cwd(), "src/pdf/assets"),
];

function tryReadAsset(filename: string): Buffer | null {
  for (const dir of ASSETS_CANDIDATES) {
    try {
      const p = path.join(dir, filename);
      if (!fs.existsSync(p)) continue;
      return fs.readFileSync(p);
    } catch {
      // keep trying
    }
  }
  return null;
}

const BRAND = {
  name: env("REPORT_BRAND_NAME") ?? "PROOVRA",
  title: "Verifiable Evidence Report",

  ink: "#0B1220",
  muted: "#475569",
  line: "rgba(11,18,32,0.12)",
  accent: "#163A70",
  accentSoft: "#D9E4F5",
  paper: "#F4F6F9",

  success: "#1F7A55"
};

function hr(doc: PDFDoc, y?: number): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const yy = typeof y === "number" ? y : doc.y;
  doc.save();
  doc.lineWidth(1).strokeColor(BRAND.line);
  doc.moveTo(x, yy).lineTo(x + w, yy).stroke();
  doc.restore();
}

function ensureSpace(doc: PDFDoc, neededHeight: number): void {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + neededHeight > bottom) doc.addPage();
}

/**
 * Silver background + watermark + seal (per page)
 */
function paintPageBackground(doc: PDFDoc): void {
  const bg = tryReadAsset("paper-silver.png");
  const pageW = doc.page.width;
  const pageH = doc.page.height;

  doc.save();
  doc.rect(0, 0, pageW, pageH).fill(BRAND.paper);

  if (bg) {
    try {
      doc.opacity(0.18);
      doc.image(bg, 0, 0, { width: pageW, height: pageH });
      doc.opacity(1);
    } catch {
      doc.opacity(1);
    }
  }

  const wm = tryReadAsset("logo.png");
  if (wm) {
    try {
      doc.opacity(0.055);
      const size = Math.min(pageW, pageH) * 0.62;
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
      doc.opacity(0.2);
      const size = mmToPt(48);
      const x = pageW - doc.page.margins.right - size + mmToPt(2);
      const y = doc.page.margins.top - mmToPt(2);
      doc.image(seal, x, y, { fit: [size, size] });
      doc.opacity(1);
    } catch {
      doc.opacity(1);
    }
  }

  doc.restore();
}

function drawBadge(doc: PDFDoc, text: string, x: number, y: number): void {
  const padX = 14;
  const padY = 7;

  doc.save();
  doc.font("Helvetica-Bold").fontSize(10.5);

  const tw = doc.widthOfString(text);
  const th = doc.currentLineHeight();

  doc.opacity(0.08);
  doc.roundedRect(x, y, tw + padX * 2, th + padY * 2, 8).fill(BRAND.accent);
  doc.opacity(1);

  doc.fillColor(BRAND.ink).text(text, x + padX, y + padY, { lineBreak: false });
  doc.restore();
}

function drawHeader(
  doc: PDFDoc,
  opts: { evidenceId: string; generatedAtUtc: string; status?: string }
): void {
  const left = doc.page.margins.left;
  const top = doc.page.margins.top;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.save();
  doc.rect(0, 0, doc.page.width, mmToPt(3.2)).fill(BRAND.accent);
  doc.restore();

  doc.x = left;
  doc.y = top;

  const logo = tryReadAsset("logo.png");
  let brandX = left;
  if (logo) {
    try {
      const h = mmToPt(15);
      const logoW = h * 4.8;
      doc.image(logo, left, doc.y - 2, { fit: [logoW, h] });
      brandX = left + logoW + 14;
    } catch {
      brandX = left;
    }
  }

  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(22);
  doc.text(BRAND.name, brandX, doc.y + 1, { continued: true });

  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(13);
  doc.text(` — ${BRAND.title}`);

  const badgeText = safe(opts.status, "").toUpperCase();
  if (badgeText) {
    const bx = left + w - 145;
    const by = top + 16;
    drawBadge(doc, bx > left ? textClamp(doc, badgeText, 20) : badgeText, bx, by);
  }

  doc.moveDown(0.9);

  const metaW = w - 170;
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(10.5);
  doc.text(`Evidence ID: ${opts.evidenceId}`, left, doc.y, { width: metaW });
  doc.moveDown(0.25);
  doc.text(`Generated (UTC): ${opts.generatedAtUtc}`, left, doc.y, { width: metaW });

  doc.moveDown(0.8);
  hr(doc);
  doc.moveDown(1.0);
}

function textClamp(doc: PDFDoc, text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, Math.max(0, maxChars - 1))}…`
    : text;
}

function buildEvidencePageUrl(evidenceId: string): string {
  const base = (env("REPORT_APP_BASE_URL") ?? "https://app.proovra.com")
    .trim()
    .replace(/\/+$/, "");
  return `${base}/evidence/${encodeURIComponent(evidenceId)}`;
}

function buildVerificationPackageApiUrl(evidenceId: string): string {
  const base = (env("REPORT_API_BASE_URL") ?? "https://api.proovra.com")
    .trim()
    .replace(/\/+$/, "");
  return `${base}/v1/evidence/${encodeURIComponent(evidenceId)}/verification-package`;
}

function section(doc: PDFDoc, title: string, render: () => void): void {
  ensureSpace(doc, 120);

  const x = doc.page.margins.left;

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(13);
  doc.text(title, x, doc.y);
  doc.restore();

  doc.moveDown(0.25);
  hr(doc);
  doc.moveDown(0.55);

  render();
  doc.moveDown(0.85);
}

  function safeParagraph(
  doc: PDFDoc,
  text: string,
  options?: { fontSize?: number; color?: string; gap?: number }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const fontSize = options?.fontSize ?? 9;
  const gap = options?.gap ?? 2;

  doc.font("Helvetica").fontSize(fontSize);
  const needed = doc.heightOfString(text, { width: w, lineGap: gap }) + 8;
  ensureSpace(doc, needed);

  doc.save();
  doc.fillColor(options?.color ?? BRAND.muted);
  doc.text(text, x, doc.y, { width: w, lineGap: gap });
  doc.restore();
}

function kvGrid(
  doc: PDFDoc,
  rows: Array<[string, string]>,
  options?: { colGap?: number }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const colGap = options?.colGap ?? 18;
  const colW = (w - colGap) / 2;

  let leftY = doc.y;
  let rightY = doc.y;

  for (let i = 0; i < rows.length; i++) {
    const [k, v] = rows[i];
    const isLeft = i % 2 === 0;
    const colX = isLeft ? x : x + colW + colGap;
    doc.y = isLeft ? leftY : rightY;

    doc.save();
    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
    doc.text(k, colX, doc.y, { width: colW });
    doc.restore();

    doc.moveDown(0.15);

    doc.save();
    doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10);
    doc.text(v, colX, doc.y, { width: colW });
    doc.restore();

    doc.moveDown(0.65);

    if (isLeft) leftY = doc.y;
    else rightY = doc.y;
  }

  doc.y = Math.max(leftY, rightY);
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

  const labelFontSize = 9;
  const codeFontSize = 9;
  const labelGapAfter = 8;
  const bottomPadding = 16;

  doc.font("Helvetica").fontSize(labelFontSize);
  const labelHeight = doc.heightOfString(label, { width: w });

  doc.font("Courier").fontSize(codeFontSize);
  const textHeight = doc.heightOfString(finalValue, {
    width: w,
    lineGap: 2,
  });
  const blockHeight = Math.max(18, textHeight + 10);

  const neededHeight = labelHeight + labelGapAfter + blockHeight + bottomPadding;
  ensureSpace(doc, neededHeight);

  const labelY = doc.y;

  doc.save();
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(labelFontSize);
  doc.text(label, x, labelY, { width: w });
  doc.restore();

  const blockY = doc.y + 4;

  doc.save();
  doc.opacity(0.05);
  doc.roundedRect(x - 4, blockY - 4, w + 8, blockHeight + 8, 8).fill(BRAND.ink);
  doc.opacity(1);
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Courier").fontSize(codeFontSize);
  doc.text(finalValue, x, blockY, {
    width: w,
    lineGap: 2,
  });
  doc.restore();

  doc.y = blockY + blockHeight;
  doc.moveDown(0.65);
}

function drawTable(
  doc: PDFDoc,
  headers: string[],
  rows: string[][],
  colWidths: number[]
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const headerH = 22;
  const rowPadY = 6;

  const calcRowHeight = (cells: string[]): number => {
    doc.font("Helvetica").fontSize(9);
    let maxH = 0;
    for (let i = 0; i < cells.length; i++) {
      const cw = colWidths[i];
      const h = doc.heightOfString(cells[i], {
        width: cw - 12,
        align: "left",
        lineGap: 2,
      });
      maxH = Math.max(maxH, h);
    }
    return Math.max(headerH, maxH + rowPadY * 2);
  };

  ensureSpace(doc, 140);

  const headerY = doc.y;

  doc.save();
  doc.opacity(0.06);
  doc.roundedRect(x, headerY, w, headerH, 6).fill(BRAND.accent);
  doc.opacity(1);
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(9);

  let cx = x;
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], cx + 6, headerY + 6, {
      width: colWidths[i] - 12,
      align: i === 0 ? "left" : "left",
      lineBreak: false,
    });
    cx += colWidths[i];
  }
  doc.restore();

  doc.y = headerY + headerH;
  hr(doc, doc.y);
  doc.moveDown(0.2);

  for (const r of rows) {
    const rh = calcRowHeight(r);
    ensureSpace(doc, rh + 18);

    const rowY = doc.y;

    doc.save();
    doc.fillColor(BRAND.ink).font("Helvetica").fontSize(9);

    let rx = x;
    for (let i = 0; i < r.length; i++) {
      doc.text(r[i], rx + 6, rowY + rowPadY, {
        width: colWidths[i] - 12,
        lineGap: 2,
      });
      rx += colWidths[i];
    }
    doc.restore();

    doc.y = rowY + rh;
    hr(doc, doc.y);
    doc.moveDown(0.2);
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
  const size = opts.size ?? 104;

  const labelSpace = 18;
  ensureSpace(doc, size + 100);

  const startY = doc.y;
  const blockH = Math.max(size + 26, 138);
  const textX = x + 18;
  const textW = w - size - 56;
  const qrX = x + w - size - 18;
  const qrY = startY + 12;

  doc.save();
  doc.opacity(0.04);
  doc.roundedRect(x, startY, w, blockH, 12).fill(BRAND.ink);
  doc.opacity(1);
  doc.restore();

  doc.save();
  doc.lineWidth(0.8).strokeColor(BRAND.line);
  doc.roundedRect(x, startY, w, blockH, 12).stroke();
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10.5);
  doc.text(opts.title, textX, startY + 14, { width: textW });
  doc.restore();

  let textY = startY + 36;

  if (opts.caption) {
    doc.save();
    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9.5);
    doc.text(opts.caption, textX, textY, {
      width: textW,
      lineGap: 2,
    });
    doc.restore();
    textY = doc.y + 8;
  }

  if (opts.urlText) {
    doc.save();
    doc.fillColor(BRAND.accent).font("Helvetica").fontSize(8.5);
    doc.text(opts.urlText, textX, textY, {
      width: textW,
      link: opts.urlLink,
      underline: Boolean(opts.urlLink),
      lineGap: 2,
    });
    doc.restore();
  }

  doc.image(opts.qrBuffer, qrX, qrY, { fit: [size, size] });

  doc.save();
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(8);
  doc.text("Scan QR", qrX, startY + blockH + 4, {
    width: size,
    align: "center",
    lineBreak: false,
  });
  doc.restore();

  doc.y = startY + blockH + labelSpace + 8;
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
      width: 260,
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
    const y = doc.page.height - doc.page.margins.bottom - 14;

    doc.save();
    doc.font("Helvetica").fontSize(9).fillColor(BRAND.muted);

    doc.text(
      `${BRAND.name} • Evidence Report v${opts.reportVersion} • Generated (UTC): ${opts.generatedAtUtc}`,
      x,
      y,
      {
        width: w,
        align: "left",
      }
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

  const base = (env("REPORT_VERIFY_BASE_URL") ?? "https://app.proovra.com/verify")
    .trim()
    .replace(/\/+$/, "");
  if (base.includes("?")) {
    return `${base}&evidenceId=${encodeURIComponent(evidenceId)}`;
  }
  return `${base}?evidenceId=${encodeURIComponent(evidenceId)}`;
}

function buildDownloadLabel(url: string): string {
  try {
    const u = new URL(url);
    const p =
      u.pathname.length > 32 ? `${u.pathname.slice(0, 32)}…` : u.pathname;
    return `${u.hostname}${p}`;
  } catch {
    return summarizeText(url, 56);
  }
}

function renderForensicIntegrityStatement(
  doc: PDFDoc,
  opts: { verifyUrl: string }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  safeParagraph(
    doc,
    "This report was generated by the PROOVRA Digital Evidence Integrity System.",
    { fontSize: 10, color: BRAND.ink }
  );
  doc.moveDown(0.35);

  safeParagraph(
    doc,
    "PROOVRA provides cryptographic mechanisms designed to preserve and verify the integrity of digital evidence. When an evidence item is completed, integrity artifacts are generated to detect any subsequent modification.",
    { fontSize: 10, color: BRAND.ink }
  );
  doc.moveDown(0.35);

  safeParagraph(doc, "These artifacts include:", {
    fontSize: 10,
    color: BRAND.ink,
  });
  doc.moveDown(0.2);

  const bullets = [
    "A SHA-256 cryptographic hash of the original file",
    "A canonical fingerprint record describing evidence metadata",
    "A fingerprint hash derived from the canonical record",
    "A digital signature generated using the PROOVRA signing key",
    "A custody timeline documenting system events related to the evidence",
  ];

  for (const b of bullets) {
    safeParagraph(doc, `• ${b}`, { fontSize: 10, color: BRAND.ink });
  }

  doc.moveDown(0.35);

  safeParagraph(doc, "Independent verification may be performed by:", {
    fontSize: 10,
    color: BRAND.ink,
  });
  doc.moveDown(0.2);

  const steps = [
    "Obtaining the original evidence file",
    "Computing the SHA-256 hash of the file",
    "Comparing the computed hash with the value listed in this report",
    "Validating the digital signature using the provided public key",
    "Reviewing the recorded chain of custody events",
  ];

  for (let i = 0; i < steps.length; i++) {
    safeParagraph(doc, `${i + 1}. ${steps[i]}`, {
      fontSize: 10,
      color: BRAND.ink,
    });
  }

  doc.moveDown(0.35);

  safeParagraph(
    doc,
    "Important Notice: Cryptographic verification confirms data integrity only. It does not establish authorship, origin, context, or factual accuracy of the content contained in the evidence.",
    { fontSize: 9, color: BRAND.muted }
  );
  doc.moveDown(0.25);

  safeParagraph(
    doc,
    "Determination of evidentiary admissibility, authenticity, and legal relevance remains the responsibility of courts or competent authorities.",
    { fontSize: 9, color: BRAND.muted }
  );
  doc.moveDown(0.35);

  safeParagraph(doc, "Verification link:", {
    fontSize: 9,
    color: BRAND.muted,
  });
  doc.moveDown(0.15);

  const needed = doc.heightOfString(opts.verifyUrl, {
    width: w,
    lineGap: 2,
  }) + 8;
  ensureSpace(doc, needed);

  doc.fillColor(BRAND.accent).font("Helvetica").fontSize(9);
  doc.text(opts.verifyUrl, x, doc.y, {
    width: w,
    link: opts.verifyUrl,
    underline: true,
    lineGap: 2,
  });
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
      "Evidence Summary > Exhibit > Chain of Custody > Technical Appendix",
    Keywords: `PROOVRA_REPORT_VERSION=${params.version};PROOVRA_GENERATED_AT=${params.generatedAtUtc}${buildToken}`,
    Creator: BRAND.name,
    Producer: BRAND.name,
    CreationDate: new Date(params.generatedAtUtc),
    ModDate: new Date(params.generatedAtUtc),
  };

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const verifyUrl = buildVerifyUrl(params.evidence.id, params.verifyUrl);
  const technicalUrl = verifyUrl.includes("?")
    ? `${verifyUrl}&tab=technical`
    : `${verifyUrl}?tab=technical`;

  // stable app route, not raw storage URL
  const downloadUrl = safe(
    params.downloadUrl ?? buildEvidencePageUrl(params.evidence.id),
    ""
  );

  const verificationPackageUrl = buildVerificationPackageApiUrl(params.evidence.id);

  // ===== PAGE 1 =====
  drawHeader(doc, {
    evidenceId: params.evidence.id,
    generatedAtUtc: params.generatedAtUtc,
    status: params.evidence.status,
  });

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(16);
  doc.text("Evidence Overview", doc.page.margins.left, doc.y);
  doc.restore();
  doc.moveDown(0.35);

  section(doc, "Evidence Summary", () => {
    kvGrid(doc, [
      ["Evidence ID", safe(params.evidence.id)],
      ["Status", safe(params.evidence.status).toUpperCase()],
      ["Captured (UTC)", safe(params.evidence.capturedAtUtc)],
      ["Uploaded (UTC)", safe(params.evidence.uploadedAtUtc)],
      ["Signed (UTC)", safe(params.evidence.signedAtUtc)],
      ["Report Generated (UTC)", safe(params.evidence.reportGeneratedAtUtc)],
      ["MIME Type", safe(params.evidence.mimeType)],
      ["Size", formatBytesHuman(params.evidence.sizeBytes)],
      [
        "Duration",
        params.evidence.durationSec ? `${params.evidence.durationSec} sec` : "N/A",
      ],
      ["File SHA-256", shortHash(params.evidence.fileSha256)],
      ["Fingerprint Hash", shortHash(params.evidence.fingerprintHash)],
      ["Timestamp Provider", safe(params.evidence.tsaProvider)],
      ["Timestamp Time (UTC)", safe(params.evidence.tsaGenTimeUtc)],
    ]);
  });

  section(doc, "Quick Verification", () => {
    const x = doc.page.margins.left;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(10);
    doc.text(
      "Use the verification page to review integrity details and recorded custody events for this evidence item.",
      x,
      doc.y,
      {
        width: w,
        lineGap: 2,
      }
    );
    doc.moveDown(0.45);

    doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10);
    doc.text("Verify link:", x, doc.y, { width: w });
    doc.moveDown(0.2);

    doc.fillColor(BRAND.accent).font("Helvetica").fontSize(9);
    doc.text(verifyUrl, x, doc.y, {
      width: w,
      link: verifyUrl,
      underline: true,
    });
    doc.moveDown(0.55);

    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
    doc.text(
      "Integrity verification confirms the file and integrity artifacts were not modified after completion. It does not prove authorship, origin, or factual accuracy of the content.",
      x,
      doc.y,
      { width: w, lineGap: 2 }
    );
  });

  {
    const qrBuf = await tryGenerateQrPngBuffer(verifyUrl);
    if (qrBuf) {
      drawQrBlock(doc, {
        title: "Open verification page",
        qrBuffer: qrBuf,
        size: 108,
        caption:
          "Scan to review verification details and chain of custody for this evidence item.",
        urlText: summarizeText(verifyUrl, 90),
        urlLink: verifyUrl,
      });
    }
  }

  // ===== PAGE 2: EXHIBIT =====
  doc.addPage();
  drawHeader(doc, {
    evidenceId: params.evidence.id,
    generatedAtUtc: params.generatedAtUtc,
    status: params.evidence.status,
  });

  section(doc, "Exhibit", () => {
    const x = doc.page.margins.left;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    const t = safe(params.evidence.mimeType, "unknown");
    const size = formatBytesHuman(params.evidence.sizeBytes);
    const dur = params.evidence.durationSec
      ? `${params.evidence.durationSec} sec`
      : "N/A";

    doc.fillColor(BRAND.ink).font("Helvetica").fontSize(10);
    doc.text(`Type: ${t}    •    Size: ${size}    •    Duration: ${dur}`, x, doc.y, {
      width: w,
    });
    doc.moveDown(0.55);

    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
    doc.text(
      "Use the original evidence link below to open or download the stored file associated with this report.",
      x,
      doc.y,
      { width: w, lineGap: 2 }
    );
    doc.moveDown(0.35);

    if (downloadUrl !== "N/A") {
      const label = buildDownloadLabel(downloadUrl);

      doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10);
      doc.text("Download original evidence:", x, doc.y, { width: w });
      doc.moveDown(0.2);

      doc.fillColor(BRAND.accent).font("Helvetica").fontSize(9);
      doc.text(label, x, doc.y, {
        width: w,
        link: downloadUrl,
        underline: true,
      });
      doc.moveDown(0.65);
    } else {
      doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
      doc.text("Original download link: N/A", x, doc.y, { width: w });
      doc.moveDown(0.5);
    }

    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
    doc.text(
      "Note: A preview thumbnail can be embedded later by fetching the file from storage.",
      x,
      doc.y,
      { width: w, lineGap: 2 }
    );
  });

  if (downloadUrl !== "N/A") {
    const qrBuf = await tryGenerateQrPngBuffer(downloadUrl);
    if (qrBuf) {
      drawQrBlock(doc, {
        title: "Download original evidence",
        qrBuffer: qrBuf,
        size: 112,
        caption:
          "Scan to open the original evidence page for this item.",
        urlText: summarizeText(downloadUrl, 90),
        urlLink: downloadUrl,
      });
    }
  }

  // ===== PAGE 3: CHAIN =====
  doc.addPage();
  drawHeader(doc, {
    evidenceId: params.evidence.id,
    generatedAtUtc: params.generatedAtUtc,
    status: params.evidence.status,
  });

  section(doc, "Chain of Custody", () => {
    const innerW =
      doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colWidths = [
      Math.max(44, innerW * 0.1),
      Math.max(128, innerW * 0.24),
      Math.max(120, innerW * 0.2),
      innerW -
        (Math.max(44, innerW * 0.1) +
          Math.max(128, innerW * 0.24) +
          Math.max(120, innerW * 0.2)),
    ];

    const headers = ["Seq", "At (UTC)", "Event", "Summary"];
    const rows = params.custodyEvents.map((ev) => [
      String(ev.sequence),
      safe(ev.atUtc),
      safe(ev.eventType),
      safe(ev.payloadSummary),
    ]);

    drawTable(doc, headers, rows, colWidths);
  });

  // ===== PAGE 4: Technical Appendix =====
  doc.addPage();
  drawHeader(doc, {
    evidenceId: params.evidence.id,
    generatedAtUtc: params.generatedAtUtc,
    status: params.evidence.status,
  });

  section(doc, "Technical Appendix — Cryptographic Materials", () => {
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

    monospaceStrip(
      doc,
      "Verification Package",
      `verification/${params.evidence.id}/package.zip`
    );

section(doc, "Timestamp Authority", () => {
  kvGrid(doc, [
    ["Timestamp Provider", safe(params.evidence.tsaProvider)],
    ["Timestamp URL", safe(params.evidence.tsaUrl)],
    ["Serial Number", safe(params.evidence.tsaSerialNumber)],
    ["Generation Time (UTC)", safe(params.evidence.tsaGenTimeUtc)],
    ["Hash Algorithm", safe(params.evidence.tsaHashAlgorithm)],
  ]);
});
    monospaceStrip(
      doc,
      "Timestamp Message Imprint",
      safe(params.evidence.tsaMessageImprint)
    );
{
  const status = safe(params.evidence.tsaStatus);

  const color =
    status.toUpperCase() === "GRANTED"
      ? BRAND.success
      : BRAND.ink;

  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.save();
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
  doc.text("Timestamp Status", x, doc.y, { width: w });
  doc.restore();

  doc.moveDown(0.2);

  doc.save();
  doc.fillColor(color).font("Helvetica-Bold").fontSize(11);
  doc.text(status.toUpperCase(), x, doc.y, { width: w });
  doc.restore();

  doc.moveDown(0.8);
}

    if (params.evidence.tsaTokenBase64) {
      monospaceStrip(
        doc,
        "Timestamp Token (Base64) (excerpt)",
        safe(params.evidence.tsaTokenBase64),
        {
          maxChars: 320,
        }
      );
    }

    if (params.evidence.tsaFailureReason) {
      monospaceStrip(
        doc,
        "Timestamp Failure Reason",
        safe(params.evidence.tsaFailureReason),
        {
          maxChars: 320,
        }
      );
    }

safeParagraph(
  doc,
  "Full technical materials can be retrieved via the Technical QR or verification page. Integrity verification is jurisdiction-dependent and does not replace legal advice."
);
  });

  {
    const qrBuf = await tryGenerateQrPngBuffer(technicalUrl);

    if (qrBuf) {
      drawQrBlock(doc, {
        title: "Technical materials",
        qrBuffer: qrBuf,
        size: 108,
        caption:
          "Scan to open the technical verification view for this evidence item.",
        urlText: summarizeText(technicalUrl, 90),
        urlLink: technicalUrl,
      });
    }

    const vpQr = await tryGenerateQrPngBuffer(verificationPackageUrl);

    if (vpQr) {
      drawQrBlock(doc, {
        title: "Verification Package",
        qrBuffer: vpQr,
        size: 104,
        caption:
          "Download the independent verification package containing the original file, integrity metadata, and signature.",
        urlText: summarizeText(verificationPackageUrl, 90),
        urlLink: verificationPackageUrl,
      });
    }
  }

  // ===== PAGE 5: Forensic Integrity Statement =====
  doc.addPage();
  drawHeader(doc, {
    evidenceId: params.evidence.id,
    generatedAtUtc: params.generatedAtUtc,
    status: params.evidence.status,
  });

  section(doc, "Forensic Integrity Statement", () => {
    renderForensicIntegrityStatement(doc, { verifyUrl });
  });

  {
    const qrBuf = await tryGenerateQrPngBuffer(verifyUrl);
    if (qrBuf) {
      drawQrBlock(doc, {
        title: "Verify page",
        qrBuffer: qrBuf,
        size: 104,
        caption: "Scan to reopen the main verification page for this evidence item.",
        urlText: summarizeText(verifyUrl, 90),
        urlLink: verifyUrl,
      });
    }
  }

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