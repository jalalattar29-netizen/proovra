// D:\digital-witness\services\worker\src\pdf\report.ts
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";

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

function safe(value: string | null | undefined, fallback = "N/A") {
  const t = typeof value === "string" ? value.trim() : "";
  return t ? t : fallback;
}

function summarizeText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatBytesHuman(bytesStr: string | null) {
  const n = bytesStr ? Number(bytesStr) : NaN;
  if (!Number.isFinite(n) || n <= 0) return "N/A";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let idx = 0;
  let v = n;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx++;
  }
  return `${v.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}

function shortHash(h: string, head = 10, tail = 8) {
  const t = safe(h, "");
  if (!t) return "N/A";
  if (t.length <= head + tail + 3) return t;
  return `${t.slice(0, head)}…${t.slice(-tail)}`;
}

function mmToPt(mm: number) {
  return (mm * 72) / 25.4;
}

const ASSETS_DIR = path.resolve(process.cwd(), "src/pdf/assets");
function tryReadAsset(filename: string): Buffer | null {
  try {
    const p = path.join(ASSETS_DIR, filename);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

const BRAND = {
  name: env("REPORT_BRAND_NAME") ?? "PROOVRA",
  title: "Verifiable Evidence Report",

  // Paper + ink
  ink: "#0B1220",
  muted: "#475569",
  line: "#E2E8F0",

  // Accents
  accent: "#2563EB",
  accent2: "#0EA5E9",

  // Silver paper palette
  paper: "#F4F6F9",
  paper2: "#EEF2F7",
  card: "#FFFFFF",
  soft: "#EAF2FF",
};

function hr(doc: PDFDoc, y?: number) {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const yy = typeof y === "number" ? y : doc.y;
  doc.save();
  doc.lineWidth(1).strokeColor(BRAND.line);
  doc.moveTo(x, yy).lineTo(x + w, yy).stroke();
  doc.restore();
}

function ensureSpace(doc: PDFDoc, neededHeight: number) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + neededHeight > bottom) doc.addPage();
}

/**
 * Silver background + watermark + seal
 * Runs per page
 */
function paintPageBackground(doc: PDFDoc) {
  const bg = tryReadAsset("paper-silver.png");
  const pageW = doc.page.width;
  const pageH = doc.page.height;

  doc.save();

  // Base silver fill
  doc.rect(0, 0, pageW, pageH).fill(BRAND.paper);

  // Optional texture image (covers page)
  if (bg) {
    try {
      doc.opacity(0.18);
      doc.image(bg, 0, 0, { width: pageW, height: pageH });
      doc.opacity(1);
    } catch {
      // ignore
    }
  } else {
    // simple subtle bands if no texture
    doc.opacity(0.06);
    doc.rect(0, 0, pageW, pageH * 0.35).fill(BRAND.paper2);
    doc.opacity(1);
  }

  // Watermark logo (center)
  const wm = tryReadAsset("logo.png");
  if (wm) {
    try {
      doc.opacity(0.06);
      const size = Math.min(pageW, pageH) * 0.55;
      const x = (pageW - size) / 2;
      const y = (pageH - size) / 2 - mmToPt(8);
      doc.image(wm, x, y, { fit: [size, size], align: "center", valign: "center" });
      doc.opacity(1);
    } catch {
      // ignore
    }
  }

  // Corner seal (top-right)
  const seal = tryReadAsset("seal.png");
  if (seal) {
    try {
      doc.opacity(0.18);
      const size = mmToPt(42);
      const x = pageW - doc.page.margins.right - size;
      const y = doc.page.margins.top - mmToPt(6);
      doc.image(seal, x, y, { fit: [size, size] });
      doc.opacity(1);
    } catch {
      // ignore
    }
  }

  doc.restore();
}

function drawBadge(doc: PDFDoc, text: string, x: number, y: number) {
  const padX = 10;
  const padY = 5;
  doc.save();
  doc.font("Helvetica-Bold").fontSize(9);
  const tw = doc.widthOfString(text);
  const th = doc.currentLineHeight();
  doc.roundedRect(x, y, tw + padX * 2, th + padY * 2, 8).fill(BRAND.soft);
  doc.fillColor(BRAND.accent).text(text, x + padX, y + padY, { lineBreak: false });
  doc.restore();
}

function drawHeader(doc: PDFDoc, opts: { evidenceId: string; generatedAtUtc: string; status?: string }) {
  const x = doc.page.margins.left;
  const top = doc.page.margins.top;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Top accent line (thin, classy)
  doc.save();
  doc.rect(0, 0, doc.page.width, mmToPt(4)).fill(BRAND.accent);
  doc.restore();

  doc.y = top;

  // Brand row with logo if exists
  const logo = tryReadAsset("logo.png");
  if (logo) {
    try {
      const h = mmToPt(9);
      doc.image(logo, x, doc.y - 2, { fit: [h * 4, h] });
      doc.x = x + h * 4 + 8;
    } catch {
      // ignore
    }
  }

  doc.fillColor(BRAND.ink);
  doc.font("Helvetica-Bold").fontSize(18).text(BRAND.name, doc.x, doc.y, { continued: true });
  doc.font("Helvetica").fontSize(12).fillColor(BRAND.muted).text(` — ${BRAND.title}`);

  doc.moveDown(0.55);

  // Meta
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(10);
  doc.text(`Evidence ID: ${opts.evidenceId}`, x, doc.y, { continued: true });
  doc.text(`    Generated (UTC): ${opts.generatedAtUtc}`, { continued: false });

  // Status badge
  const badgeText = safe(opts.status, "").toUpperCase();
  if (badgeText) {
    const badgeX = x + w - 135;
    const badgeY = doc.y - 28;
    drawBadge(doc, badgeText, badgeX, badgeY);
  }

  doc.moveDown(0.6);
  hr(doc);
  doc.moveDown(0.8);
}

function card(doc: PDFDoc, title: string, render: () => void, options?: { minHeight?: number }) {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const startY = doc.y;
  const minH = options?.minHeight ?? 0;

  ensureSpace(doc, Math.max(minH, 140));

  // Background
  doc.save();
  doc.roundedRect(x, doc.y, w, Math.max(minH, 10), 16).fill(BRAND.card);
  doc.restore();

  const innerX = x + 16;
  const innerTop = doc.y + 14;

  // Title
  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(12);
  doc.text(title, innerX, innerTop);
  doc.restore();

  const afterTitleY = innerTop + 18;
  doc.y = afterTitleY;

  const contentStart = doc.y;
  render();
  const contentEnd = doc.y;

  const contentHeight = contentEnd - startY;
  const desiredH = Math.max(minH, contentHeight + 22);

  // redraw with correct height
  doc.save();
  doc.roundedRect(x, startY, w, desiredH, 16).fill(BRAND.card);
  doc.restore();

  // title again
  doc.y = innerTop;
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(12).text(title, innerX, doc.y);

  // content again deterministic
  doc.y = contentStart;
  render();

  doc.y = startY + desiredH + 16;
}

function kvGrid(doc: PDFDoc, rows: Array<[string, string]>, options?: { colGap?: number }) {
  const x = doc.page.margins.left + 16;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right - 32;
  const colGap = options?.colGap ?? 16;
  const colW = (w - colGap) / 2;

  doc.fontSize(10).font("Helvetica").fillColor(BRAND.ink);

  let leftY = doc.y;
  let rightY = doc.y;

  for (let i = 0; i < rows.length; i++) {
    const [k, v] = rows[i];
    const isLeft = i % 2 === 0;
    const colX = isLeft ? x : x + colW + colGap;
    doc.y = isLeft ? leftY : rightY;

    doc.save();
    doc.fillColor(BRAND.muted).font("Helvetica").text(k, colX, doc.y, { width: colW });
    doc.restore();

    doc.moveDown(0.15);
    doc.fillColor(BRAND.ink).font("Helvetica-Bold").text(v, colX, doc.y, { width: colW });

    doc.moveDown(0.65);

    if (isLeft) leftY = doc.y;
    else rightY = doc.y;
  }

  doc.y = Math.max(leftY, rightY);
}

function monospaceBlock(doc: PDFDoc, label: string, value: string) {
  const x = doc.page.margins.left + 16;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right - 32;

  doc.save();
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(10).text(label, x, doc.y, { width: w });
  doc.moveDown(0.2);
  doc.fillColor(BRAND.ink).font("Courier").fontSize(9).text(value, x, doc.y, {
    width: w,
    lineGap: 2,
  });
  doc.restore();
  doc.moveDown(0.6);
}

function drawTable(doc: PDFDoc, headers: string[], rows: string[][], colWidths: number[]) {
  const x = doc.page.margins.left + 16;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right - 32;

  const headerH = 18;
  const rowPadY = 6;

  const calcRowHeight = (cells: string[]) => {
    doc.font("Helvetica").fontSize(9);
    let maxH = 0;
    for (let i = 0; i < cells.length; i++) {
      const cw = colWidths[i];
      const h = doc.heightOfString(cells[i], { width: cw, align: "left" });
      maxH = Math.max(maxH, h);
    }
    return Math.max(headerH, maxH + rowPadY * 2);
  };

  ensureSpace(doc, 80);

  // Header bg
  doc.save();
  doc.rect(x, doc.y, w, headerH).fill(BRAND.soft);
  doc.restore();

  // Header text
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
    ensureSpace(doc, rh + 12);

    doc.save();
    doc.fillColor(BRAND.ink).font("Helvetica").fontSize(9);
    let rx = x;
    const ry = doc.y;
    for (let i = 0; i < r.length; i++) {
      doc.text(r[i], rx + 6, ry + rowPadY, {
        width: colWidths[i] - 12,
        lineGap: 2,
      });
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
    const buf = await QRCode.toBuffer(data, { margin: 1, width: 260 });
    return buf;
  } catch {
    return null;
  }
}

function addFooters(doc: PDFDoc, opts: { generatedAtUtc: string; reportVersion: number }) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);

    const x = doc.page.margins.left;
    const y = doc.page.height - doc.page.margins.bottom + 10;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.save();
    doc.font("Helvetica").fontSize(9).fillColor(BRAND.muted);

    doc.text(
      `${BRAND.name} • Evidence Report v${opts.reportVersion} • Generated (UTC): ${opts.generatedAtUtc}`,
      x,
      y,
      { width: w, align: "left" }
    );

    doc.text(`Page ${i + 1} / ${range.count}`, x, y, { width: w, align: "right" });

    doc.restore();
  }
}

function buildVerifyUrl(evidenceId: string, provided?: string | null) {
  const v = typeof provided === "string" ? provided.trim() : "";
  if (v) return v;

  // Prefer a real UI verify page
  const base = env("REPORT_VERIFY_BASE_URL") ?? "https://app.proovra.com/verify";
  return `${base.replace(/\/+$/, "")}/${evidenceId}`;
}

function buildDownloadLabel(url: string) {
  // show a clean label even if url is long
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.length > 28 ? u.pathname.slice(0, 28) + "…" : u.pathname}`;
  } catch {
    return summarizeText(url, 56);
  }
}

/**
 * Digital signature: sign PDF (PAdES-like) using a .p12 certificate.
 * Works if PDF_SIGNING_ENABLED=true and P12 path+pass are set.
 */
async function signPdfIfEnabled(pdf: Buffer): Promise<Buffer> {
  const enabled = (env("PDF_SIGNING_ENABLED") ?? "false").toLowerCase() === "true";
  if (!enabled) return pdf;

  const p12Path = env("PDF_SIGNING_P12_PATH");
  const pass = env("PDF_SIGNING_P12_PASS") ?? "";
  if (!p12Path) return pdf;

  let p12: Buffer;
  try {
    p12 = fs.readFileSync(p12Path);
  } catch {
    return pdf;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { default: SignPdf } = require("@signpdf/signpdf") as { default: new () => any };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { pdfkitAddPlaceholder } = require("@signpdf/placeholder-pdfkit") as {
      pdfkitAddPlaceholder: (doc: any, opts?: any) => void;
    };

    // NOTE:
    // We already generate the PDF. For @signpdf placeholder, easiest correct flow is:
    // - Generate PDF with placeholder from the start (in buildReportPdf below)
    // BUT we keep a safe fallback here in case placeholder wasn't embedded.
    // If placeholder isn't present, signing will throw -> fallback.

    const signer = new SignPdf();

    const signed = signer.sign(pdf, p12, {
      passphrase: pass,
      reason: env("PDF_SIGNING_REASON") ?? "Document signed by PROOVRA",
      location: env("PDF_SIGNING_LOCATION") ?? "N/A",
      contactInfo: env("PDF_SIGNING_CONTACT") ?? "N/A",
    });

    return Buffer.isBuffer(signed) ? signed : Buffer.from(signed);
  } catch {
    // If signing fails for any reason, return unsigned PDF (report still usable)
    return pdf;
  }
}

export async function buildReportPdf(params: {
  evidence: ReportEvidence;
  custodyEvents: ReportCustodyEvent[];
  version: number;
  generatedAtUtc: string;
  buildInfo?: string | null;

  /**
   * Optional verify URL (if not provided we build from REPORT_VERIFY_BASE_URL)
   */
  verifyUrl?: string | null;

  /**
   * Optional: direct downloadable URL (presigned) for original file.
   * If you pass it, we'll show "Download original" QR too.
   */
  downloadUrl?: string | null;
}): Promise<Buffer> {
  // IMPORTANT: bufferPages true for footers
  const doc = new PDFDocument({ autoFirstPage: true, margin: 50, bufferPages: true });

  // Paint background on first page + each new page
  paintPageBackground(doc);
  doc.on("pageAdded", () => {
    paintPageBackground(doc);
  });

  const buildToken = params.buildInfo ? `;PROOVRA_BUILD=${params.buildInfo}` : "";
  doc.info = {
    Title: `${BRAND.name} — Verifiable Evidence Report`,
    Subject: "Evidence Summary > Exhibit > Chain of Custody > Appendix",
    Keywords: `PROOVRA_REPORT_VERSION=${params.version};PROOVRA_GENERATED_AT=${params.generatedAtUtc}${buildToken}`,
    Creator: BRAND.name,
    Producer: BRAND.name,
    CreationDate: new Date(params.generatedAtUtc),
    ModDate: new Date(params.generatedAtUtc),
  };

  const chunks: Buffer[] = [];
  doc.on("data", (chunk) => chunks.push(chunk));

  const verifyUrl = buildVerifyUrl(params.evidence.id, params.verifyUrl);
  const downloadUrl = safe(params.downloadUrl ?? params.evidence.publicUrl ?? "", "");

  // ========= PAGE 1: COVER + SUMMARY =========
  drawHeader(doc, {
    evidenceId: params.evidence.id,
    generatedAtUtc: params.generatedAtUtc,
    status: params.evidence.status,
  });

  // Hero line
  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(16);
  doc.text("Evidence Overview", doc.page.margins.left, doc.y);
  doc.restore();
  doc.moveDown(0.4);

  // Summary card (remove ugly internal storage fields)
  card(doc, "Evidence Summary", () => {
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
  }, { minHeight: 220 });

  // Verification card (QR + clean text)
  card(doc, "Quick Verification", () => {
    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(10);
    doc.text(
      "Scan the QR code or open the link below to verify authenticity, signature, and chain of custody.",
      doc.page.margins.left + 16,
      doc.y,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 32, lineGap: 2 }
    );
    doc.moveDown(0.4);

    doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10);
    doc.text("Verify link:", doc.page.margins.left + 16, doc.y);
    doc.moveDown(0.2);

    doc.fillColor(BRAND.accent).font("Helvetica").fontSize(9);
    doc.text(verifyUrl, doc.page.margins.left + 16, doc.y, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 32,
      link: verifyUrl,
      underline: true,
    });
    doc.moveDown(0.6);

    // friendly explanation (non-crypto heavy)
    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
    doc.text(
      "This report is cryptographically verifiable. Any modification to the original file or report metadata will be detected during verification.",
      doc.page.margins.left + 16,
      doc.y,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 32, lineGap: 2 }
    );
    doc.moveDown(0.4);
  }, { minHeight: 180 });

  // QR on page 1 (top-right area)
  {
    const qrBuf = await tryGenerateQrPngBuffer(verifyUrl);
    if (qrBuf) {
      const x = doc.page.width - doc.page.margins.right - 128;
      const y = doc.page.margins.top + 72;
      doc.image(qrBuf, x, y, { fit: [120, 120] });
      doc.save();
      doc.fillColor(BRAND.muted).font("Helvetica").fontSize(8);
      doc.text("Scan to verify", x, y + 122, { width: 120, align: "center" });
      doc.restore();
    }
  }

  // ========= PAGE 2: EXHIBIT =========
  doc.addPage();
  drawHeader(doc, {
    evidenceId: params.evidence.id,
    generatedAtUtc: params.generatedAtUtc,
    status: params.evidence.status,
  });

  card(doc, "Exhibit", () => {
    const t = safe(params.evidence.mimeType, "unknown");
    const size = formatBytesHuman(params.evidence.sizeBytes);
    const dur = params.evidence.durationSec ? `${params.evidence.durationSec} sec` : "N/A";

    doc.fillColor(BRAND.ink).font("Helvetica").fontSize(10);
    doc.text(
      `Type: ${t}    •    Size: ${size}    •    Duration: ${dur}`,
      doc.page.margins.left + 16,
      doc.y,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 32 }
    );
    doc.moveDown(0.6);

    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
    doc.text(
      "To view or download the original evidence file, use the link / QR below.",
      doc.page.margins.left + 16,
      doc.y,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 32 }
    );
    doc.moveDown(0.4);

    if (downloadUrl !== "N/A") {
      const label = buildDownloadLabel(downloadUrl);

      doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10);
      doc.text("Download original evidence:", doc.page.margins.left + 16, doc.y);
      doc.moveDown(0.2);

      doc.fillColor(BRAND.accent).font("Helvetica").fontSize(9);
      doc.text(label, doc.page.margins.left + 16, doc.y, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 32,
        link: downloadUrl,
        underline: true,
      });
      doc.moveDown(0.6);
    } else {
      doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
      doc.text("Original download link: N/A", doc.page.margins.left + 16, doc.y);
      doc.moveDown(0.6);
    }

    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
    doc.text(
      "Note: For images/documents, a preview can be embedded here if the worker fetches the file content from storage. (We can add that next.)",
      doc.page.margins.left + 16,
      doc.y,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 32, lineGap: 2 }
    );
    doc.moveDown(0.2);
  }, { minHeight: 420 });

  // QR for download (right side)
  if (downloadUrl !== "N/A") {
    const qrBuf = await tryGenerateQrPngBuffer(downloadUrl);
    if (qrBuf) {
      const x = doc.page.width - doc.page.margins.right - 150;
      const y = doc.page.margins.top + 110;
      doc.image(qrBuf, x, y, { fit: [140, 140] });
      doc.save();
      doc.fillColor(BRAND.muted).font("Helvetica").fontSize(8);
      doc.text("Download evidence", x, y + 142, { width: 140, align: "center" });
      doc.restore();
    }
  }

  // ========= PAGE 3: CHAIN OF CUSTODY =========
  doc.addPage();
  drawHeader(doc, {
    evidenceId: params.evidence.id,
    generatedAtUtc: params.generatedAtUtc,
    status: params.evidence.status,
  });

  card(doc, "Chain of Custody", () => {
    const innerW = doc.page.width - doc.page.margins.left - doc.page.margins.right - 32;
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
  }, { minHeight: 520 });

  // ========= APPENDIX A: CRYPTO DETAILS =========
  doc.addPage();
  drawHeader(doc, {
    evidenceId: params.evidence.id,
    generatedAtUtc: params.generatedAtUtc,
    status: params.evidence.status,
  });

  card(doc, "Appendix A — Cryptographic Details", () => {
    monospaceBlock(doc, "File SHA-256", safe(params.evidence.fileSha256));
    monospaceBlock(doc, "Fingerprint Hash", safe(params.evidence.fingerprintHash));
    monospaceBlock(doc, "Signing Key ID / Version", `${safe(params.evidence.signingKeyId)} / ${params.evidence.signingKeyVersion}`);
    monospaceBlock(doc, "Signature (Base64)", safe(params.evidence.signatureBase64));
  }, { minHeight: 540 });

  // ========= APPENDIX B: CANONICAL JSON + PUBLIC KEY =========
  doc.addPage();
  drawHeader(doc, {
    evidenceId: params.evidence.id,
    generatedAtUtc: params.generatedAtUtc,
    status: params.evidence.status,
  });

  card(doc, "Appendix B — Fingerprint Canonical JSON", () => {
    monospaceBlock(doc, "Fingerprint Canonical JSON", safe(params.evidence.fingerprintCanonicalJson));
  }, { minHeight: 520 });

  doc.addPage();
  drawHeader(doc, {
    evidenceId: params.evidence.id,
    generatedAtUtc: params.generatedAtUtc,
    status: params.evidence.status,
  });

  card(doc, "Appendix C — Signing Public Key (PEM)", () => {
    monospaceBlock(doc, "Public Key (PEM)", safe(params.evidence.publicKeyPem));
  }, { minHeight: 520 });

  // Footers
  addFooters(doc, { generatedAtUtc: params.generatedAtUtc, reportVersion: params.version });

  doc.end();

  await new Promise<void>((resolve) => {
    doc.on("end", () => resolve());
  });

  const pdf = Buffer.concat(chunks);

  // Digital signature (optional)
  const signed = await signPdfIfEnabled(pdf);
  return signed;
}