import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signPdfIfEnabled } from "./signPdf.js";

type PDFDoc = InstanceType<typeof PDFDocument>;

export type ReportEvidence = {
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

  // calmer blue
  accent: "#1E40AF",

  // silver paper tone
  paper: "#F4F6F9",
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

  // Center watermark
  const wm = tryReadAsset("logo.png");
  if (wm) {
    try {
      doc.opacity(0.028);
      const size = Math.min(pageW, pageH) * 0.62;
      const x = (pageW - size) / 2;
      const y = (pageH - size) / 2 - mmToPt(6);
      doc.image(wm, x, y, { fit: [size, size] });
      doc.opacity(1);
    } catch {
      doc.opacity(1);
    }
  }

  // Corner seal
  const seal = tryReadAsset("seal.png");
  if (seal) {
    try {
      doc.opacity(0.12);
      const size = mmToPt(38);
      const x = pageW - doc.page.margins.right - size;
      const y = doc.page.margins.top - mmToPt(6);
      doc.image(seal, x, y, { fit: [size, size] });
      doc.opacity(1);
    } catch {
      doc.opacity(1);
    }
  }

  doc.restore();
}

function drawBadge(doc: PDFDoc, text: string, x: number, y: number): void {
  const padX = 10;
  const padY = 5;

  doc.save();
  doc.font("Helvetica-Bold").fontSize(9);

  const tw = doc.widthOfString(text);
  const th = doc.currentLineHeight();

  doc.opacity(0.08);
  doc.roundedRect(x, y, tw + padX * 2, th + padY * 2, 8).fill(BRAND.accent);
  doc.opacity(1);

  // badge text readable
  doc.fillColor(BRAND.ink).text(text, x + padX, y + padY, { lineBreak: false });
  doc.restore();
}

function drawHeader(doc: PDFDoc, opts: { evidenceId: string; generatedAtUtc: string; status?: string }): void {
  const left = doc.page.margins.left;
  const top = doc.page.margins.top;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // top accent line
  doc.save();
  doc.rect(0, 0, doc.page.width, mmToPt(3.2)).fill(BRAND.accent);
  doc.restore();

  doc.x = left;
  doc.y = top;

  // logo bigger
  const logo = tryReadAsset("logo.png");
  let brandX = left;
  if (logo) {
    try {
      const h = mmToPt(10);
      doc.image(logo, left, doc.y - 1, { fit: [h * 4.8, h] });
      brandX = left + h * 4.8 + 10;
    } catch {
      brandX = left;
    }
  }

  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(18);
  doc.text(BRAND.name, brandX, doc.y, { continued: true });

  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(12);
  doc.text(` — ${BRAND.title}`);

  const badgeText = safe(opts.status, "").toUpperCase();
  if (badgeText) {
    const bx = left + w - 135;
    const by = top + 6;
    drawBadge(doc, badgeText, bx, by);
  }

  doc.moveDown(0.6);

  const metaW = w - 150;
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(10);
  doc.text(`Evidence ID: ${opts.evidenceId}`, left, doc.y, { width: metaW });
  doc.moveDown(0.25);
  doc.text(`Generated (UTC): ${opts.generatedAtUtc}`, left, doc.y, { width: metaW });

  doc.moveDown(0.55);
  hr(doc);
  doc.moveDown(0.75);
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

function kvGrid(doc: PDFDoc, rows: Array<[string, string]>, options?: { colGap?: number }): void {
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

function monospaceStrip(doc: PDFDoc, label: string, value: string, options?: { maxChars?: number }): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const maxChars = options?.maxChars;
  const finalValue = typeof maxChars === "number" ? summarizeText(value, maxChars) : value;

  doc.save();
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
  doc.text(label, x, doc.y, { width: w });
  doc.restore();

  doc.moveDown(0.2);

  const startY = doc.y;
  const h = Math.max(18, doc.heightOfString(finalValue, { width: w, lineGap: 2 }) + 10);

  doc.save();
  doc.opacity(0.05);
  doc.rect(x - 4, startY - 4, w + 8, h + 8).fill(BRAND.ink);
  doc.opacity(1);
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Courier").fontSize(9);
  doc.text(finalValue, x, startY, { width: w, lineGap: 2 });
  doc.restore();

  doc.y = startY + h;
  doc.moveDown(0.65);
}

function drawTable(doc: PDFDoc, headers: string[], rows: string[][], colWidths: number[]): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const headerH = 18;
  const rowPadY = 6;

  const calcRowHeight = (cells: string[]): number => {
    doc.font("Helvetica").fontSize(9);
    let maxH = 0;
    for (let i = 0; i < cells.length; i++) {
      const cw = colWidths[i];
      const h = doc.heightOfString(cells[i], { width: cw, align: "left" });
      maxH = Math.max(maxH, h);
    }
    return Math.max(headerH, maxH + rowPadY * 2);
  };

  ensureSpace(doc, 140);

  doc.save();
  doc.opacity(0.06);
  doc.rect(x, doc.y, w, headerH).fill(BRAND.accent);
  doc.opacity(1);
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(9);
  let cx = x;
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], cx + 6, doc.y + 5, { width: colWidths[i] - 12 });
    cx += colWidths[i];
  }
  doc.restore();

  doc.y += headerH;
  hr(doc, doc.y);
  doc.moveDown(0.2);

  for (const r of rows) {
    const rh = calcRowHeight(r);
    ensureSpace(doc, rh + 18);

    doc.save();
    doc.fillColor(BRAND.ink).font("Helvetica").fontSize(9);

    let rx = x;
    const ry = doc.y;
    for (let i = 0; i < r.length; i++) {
      doc.text(r[i], rx + 6, ry + rowPadY, { width: colWidths[i] - 12, lineGap: 2 });
      rx += colWidths[i];
    }
    doc.restore();

    doc.y = ry + rh;
    hr(doc, doc.y);
    doc.moveDown(0.2);
  }
}

async function tryGenerateQrPngBuffer(data: string): Promise<Buffer | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const QRCode = require("qrcode") as {
      toBuffer: (text: string, opts?: Record<string, unknown>) => Promise<Buffer>;
    };
    return await QRCode.toBuffer(data, { margin: 1, width: 260 });
  } catch {
    return null;
  }
}

function addFooters(doc: PDFDoc, opts: { generatedAtUtc: string; reportVersion: number }): void {
  const range = doc.bufferedPageRange();

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);

    const x = doc.page.margins.left;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    const y = doc.page.height - doc.page.margins.bottom - 14;

    doc.save();
    doc.font("Helvetica").fontSize(9).fillColor(BRAND.muted);

    doc.text(`${BRAND.name} • Evidence Report v${opts.reportVersion} • Generated (UTC): ${opts.generatedAtUtc}`, x, y, {
      width: w,
      align: "left",
    });
    doc.text(`Page ${i + 1} / ${range.count}`, x, y, { width: w, align: "right" });

    doc.restore();
  }
}

function buildVerifyUrl(evidenceId: string, provided?: string | null): string {
  const v = typeof provided === "string" ? provided.trim() : "";
  if (v) return v;

  const base = (env("REPORT_VERIFY_BASE_URL") ?? "https://app.proovra.com/verify").trim().replace(/\/+$/, "");
  if (base.includes("?")) return `${base}&evidenceId=${encodeURIComponent(evidenceId)}`;
  return `${base}?evidenceId=${encodeURIComponent(evidenceId)}`;
}

function buildDownloadLabel(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname.length > 32 ? `${u.pathname.slice(0, 32)}…` : u.pathname;
    return `${u.hostname}${p}`;
  } catch {
    return summarizeText(url, 56);
  }
}

function renderForensicIntegrityStatement(doc: PDFDoc, opts: { verifyUrl: string }): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.fillColor(BRAND.ink).font("Helvetica").fontSize(10);
  doc.text("This report was generated by the PROOVRA Digital Evidence Integrity System.", x, doc.y, { width: w, lineGap: 2 });

  doc.moveDown(0.6);

  doc.text(
    "PROOVRA provides cryptographic mechanisms designed to preserve and verify the integrity of digital evidence. When an evidence item is completed, integrity artifacts are generated to detect any subsequent modification.",
    x,
    doc.y,
    { width: w, lineGap: 2 }
  );

  doc.moveDown(0.6);

  doc.text("These artifacts include:", x, doc.y, { width: w });
  doc.moveDown(0.3);

  const bullets = [
    "A SHA-256 cryptographic hash of the original file",
    "A canonical fingerprint record describing evidence metadata",
    "A fingerprint hash derived from the canonical record",
    "A digital signature generated using the PROOVRA signing key",
    "A custody timeline documenting system events related to the evidence",
  ];

  doc.font("Helvetica").fontSize(10).fillColor(BRAND.ink);
  for (const b of bullets) {
    doc.text(`• ${b}`, x, doc.y, { width: w, lineGap: 2 });
  }

  doc.moveDown(0.65);

  doc.text("Independent verification may be performed by:", x, doc.y, { width: w });
  doc.moveDown(0.3);

  const steps = [
    "Obtaining the original evidence file",
    "Computing the SHA-256 hash of the file",
    "Comparing the computed hash with the value listed in this report",
    "Validating the digital signature using the provided public key",
    "Reviewing the recorded chain of custody events",
  ];

  for (let i = 0; i < steps.length; i++) {
    doc.text(`${i + 1}. ${steps[i]}`, x, doc.y, { width: w, lineGap: 2 });
  }

  doc.moveDown(0.65);

  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
  doc.text(
    "Important Notice: Cryptographic verification confirms data integrity only. It does not establish authorship, origin, context, or factual accuracy of the content contained in the evidence.",
    x,
    doc.y,
    { width: w, lineGap: 2 }
  );

  doc.moveDown(0.55);

  doc.text(
    "Determination of evidentiary admissibility, authenticity, and legal relevance remains the responsibility of courts or competent authorities.",
    x,
    doc.y,
    { width: w, lineGap: 2 }
  );

  doc.moveDown(0.65);

  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
  doc.text("Verification link:", x, doc.y, { width: w });
  doc.moveDown(0.2);

  doc.fillColor(BRAND.accent).font("Helvetica").fontSize(9);
  doc.text(opts.verifyUrl, x, doc.y, { width: w, link: opts.verifyUrl, underline: true });
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
  const doc = new PDFDocument({ autoFirstPage: true, margin: 50, bufferPages: true });

  paintPageBackground(doc);
  doc.on("pageAdded", () => paintPageBackground(doc));

  const buildToken = params.buildInfo ? `;PROOVRA_BUILD=${params.buildInfo}` : "";
  doc.info = {
    Title: `${BRAND.name} — Verifiable Evidence Report`,
    Subject: "Evidence Summary > Exhibit > Chain of Custody > Technical Appendix",
    Keywords: `PROOVRA_REPORT_VERSION=${params.version};PROOVRA_GENERATED_AT=${params.generatedAtUtc}${buildToken}`,
    Creator: BRAND.name,
    Producer: BRAND.name,
    CreationDate: new Date(params.generatedAtUtc),
    ModDate: new Date(params.generatedAtUtc),
  };

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const verifyUrl = buildVerifyUrl(params.evidence.id, params.verifyUrl);

  // ✅ Technical deep-link (لـ QR الثاني)
  const technicalUrl = verifyUrl.includes("?")
    ? `${verifyUrl}&tab=technical`
    : `${verifyUrl}?tab=technical`;

  const downloadUrl = safe(params.downloadUrl ?? params.evidence.publicUrl ?? "", "");

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
      ["Duration", params.evidence.durationSec ? `${params.evidence.durationSec} sec` : "N/A"],
      ["File SHA-256", shortHash(params.evidence.fileSha256)],
      ["Fingerprint Hash", shortHash(params.evidence.fingerprintHash)],
    ]);
  });

  section(doc, "Quick Verification", () => {
    const x = doc.page.margins.left;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(10);
    doc.text("Scan the QR code or open the link below to verify integrity and chain of custody.", x, doc.y, {
      width: w,
      lineGap: 2,
    });
    doc.moveDown(0.5);

    doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10);
    doc.text("Verify link:", x, doc.y, { width: w });
    doc.moveDown(0.2);

    doc.fillColor(BRAND.accent).font("Helvetica").fontSize(9);
    doc.text(verifyUrl, x, doc.y, { width: w, link: verifyUrl, underline: true });
    doc.moveDown(0.55);

    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
    doc.text(
      "Integrity verification confirms the file and integrity artifacts were not modified after completion. It does not prove authorship or factual accuracy.",
      x,
      doc.y,
      { width: w, lineGap: 2 }
    );
  });

  // ✅ QR #1: Verify (top-right)
  {
    const qrBuf = await tryGenerateQrPngBuffer(verifyUrl);
    if (qrBuf) {
      const x = doc.page.width - doc.page.margins.right - 130;
      const y = doc.page.margins.top + 64;
      doc.image(qrBuf, x, y, { fit: [118, 118] });
      doc.save();
      doc.fillColor(BRAND.muted).font("Helvetica").fontSize(8);
      doc.text("Scan to verify", x, y + 120, { width: 118, align: "center" });
      doc.restore();
    }
  }

  // ===== PAGE 2: EXHIBIT =====
  doc.addPage();
  drawHeader(doc, { evidenceId: params.evidence.id, generatedAtUtc: params.generatedAtUtc, status: params.evidence.status });

  section(doc, "Exhibit", () => {
    const x = doc.page.margins.left;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    const t = safe(params.evidence.mimeType, "unknown");
    const size = formatBytesHuman(params.evidence.sizeBytes);
    const dur = params.evidence.durationSec ? `${params.evidence.durationSec} sec` : "N/A";

    doc.fillColor(BRAND.ink).font("Helvetica").fontSize(10);
    doc.text(`Type: ${t}    •    Size: ${size}    •    Duration: ${dur}`, x, doc.y, { width: w });
    doc.moveDown(0.55);

    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
    doc.text("To view or download the original evidence file, use the link / QR below.", x, doc.y, { width: w });
    doc.moveDown(0.35);

    if (downloadUrl !== "N/A") {
      const label = buildDownloadLabel(downloadUrl);
      doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10);
      doc.text("Download original evidence:", x, doc.y, { width: w });
      doc.moveDown(0.2);

      doc.fillColor(BRAND.accent).font("Helvetica").fontSize(9);
      doc.text(label, x, doc.y, { width: w, link: downloadUrl, underline: true });
      doc.moveDown(0.5);
    } else {
      doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
      doc.text("Original download link: N/A", x, doc.y, { width: w });
      doc.moveDown(0.5);
    }

    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
    doc.text("Note: A preview thumbnail can be embedded later by fetching the file from storage.", x, doc.y, {
      width: w,
      lineGap: 2,
    });
  });

  // QR download
  if (downloadUrl !== "N/A") {
    const qrBuf = await tryGenerateQrPngBuffer(downloadUrl);
    if (qrBuf) {
      const x = doc.page.width - doc.page.margins.right - 155;
      const y = doc.page.margins.top + 100;
      doc.image(qrBuf, x, y, { fit: [140, 140] });
      doc.save();
      doc.fillColor(BRAND.muted).font("Helvetica").fontSize(8);
      doc.text("Download evidence", x, y + 142, { width: 140, align: "center" });
      doc.restore();
    }
  }

  // ===== PAGE 3: CHAIN =====
  doc.addPage();
  drawHeader(doc, { evidenceId: params.evidence.id, generatedAtUtc: params.generatedAtUtc, status: params.evidence.status });

  section(doc, "Chain of Custody", () => {
    const innerW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colWidths = [
      Math.max(44, innerW * 0.10),
      Math.max(128, innerW * 0.24),
      Math.max(120, innerW * 0.20),
      innerW - (Math.max(44, innerW * 0.10) + Math.max(128, innerW * 0.24) + Math.max(120, innerW * 0.20)),
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
  drawHeader(doc, { evidenceId: params.evidence.id, generatedAtUtc: params.generatedAtUtc, status: params.evidence.status });

  section(doc, "Technical Appendix — Cryptographic Materials", () => {
    monospaceStrip(doc, "File SHA-256", safe(params.evidence.fileSha256));
    monospaceStrip(doc, "Fingerprint Hash", safe(params.evidence.fingerprintHash));
    monospaceStrip(doc, "Signing Key ID / Version", `${safe(params.evidence.signingKeyId)} / ${params.evidence.signingKeyVersion}`);
    monospaceStrip(doc, "Signature (Base64) (excerpt)", safe(params.evidence.signatureBase64), { maxChars: 520 });
    monospaceStrip(doc, "Public Key (PEM) (excerpt)", safe(params.evidence.publicKeyPem), { maxChars: 520 });
    monospaceStrip(doc, "Fingerprint Canonical JSON (excerpt)", safe(params.evidence.fingerprintCanonicalJson), { maxChars: 700 });

    const x = doc.page.margins.left;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
    doc.text(
      "Full technical materials can be retrieved via the Technical QR or verification page. Integrity verification is jurisdiction-dependent and does not replace legal advice.",
      x,
      doc.y,
      { width: w, lineGap: 2 }
    );
  });

  // ✅ QR #2: Technical (bottom-right of technical page, after section)
  {
    const size = 118;
    ensureSpace(doc, size + 40);

    const qrBuf = await tryGenerateQrPngBuffer(technicalUrl);
    if (qrBuf) {
      const x = doc.page.width - doc.page.margins.right - 130;
      const y = doc.y;

      doc.image(qrBuf, x, y, { fit: [size, size] });

      doc.save();
      doc.fillColor(BRAND.muted).font("Helvetica").fontSize(8);
      doc.text("Technical materials", x, y + size + 2, { width: size, align: "center" });
      doc.restore();

      doc.moveDown(3.0);
    }
  }

  // ===== PAGE 5: Forensic Integrity Statement =====
  doc.addPage();
  drawHeader(doc, { evidenceId: params.evidence.id, generatedAtUtc: params.generatedAtUtc, status: params.evidence.status });

  section(doc, "Forensic Integrity Statement", () => {
    renderForensicIntegrityStatement(doc, { verifyUrl });
  });

  // (اختياري ممتاز) QR صغير لصفحة التحقق داخل صفحة الـ Statement
  {
    const size = 104;
    ensureSpace(doc, size + 30);

    const qrBuf = await tryGenerateQrPngBuffer(verifyUrl);
    if (qrBuf) {
      const x = doc.page.width - doc.page.margins.right - 120;
      const y = doc.y;

      doc.image(qrBuf, x, y, { fit: [size, size] });

      doc.save();
      doc.fillColor(BRAND.muted).font("Helvetica").fontSize(8);
      doc.text("Verify page", x, y + size + 2, { width: size, align: "center" });
      doc.restore();

      doc.moveDown(2.6);
    }
  }

  addFooters(doc, { generatedAtUtc: params.generatedAtUtc, reportVersion: params.version });

  const endPromise = new Promise<void>((resolve, reject) => {
    doc.once("end", resolve);
    doc.once("error", reject);
  });

  doc.end();
  await endPromise;

  const pdf = Buffer.concat(chunks);
  return signPdfIfEnabled(pdf);
}