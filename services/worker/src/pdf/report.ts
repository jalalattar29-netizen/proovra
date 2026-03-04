// D:\digital-witness\services\worker\src\pdf\report.ts
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
  line: "rgba(11,18,32,0.10)",

  accent: "#2563EB",

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

  // Base fill
  doc.rect(0, 0, pageW, pageH).fill(BRAND.paper);

  // Texture
  if (bg) {
    try {
      doc.opacity(0.22);
      doc.image(bg, 0, 0, { width: pageW, height: pageH });
      doc.opacity(1);
    } catch {
      doc.opacity(1);
    }
  }

  // Center watermark (make it lighter so text is crisp)
  const wm = tryReadAsset("logo.png");
  if (wm) {
    try {
      doc.opacity(0.035);
      const size = Math.min(pageW, pageH) * 0.58;
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
      doc.opacity(0.14);
      const size = mmToPt(40);
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

  // semi-transparent chip (not white card)
  doc.opacity(0.10);
  doc.roundedRect(x, y, tw + padX * 2, th + padY * 2, 8).fill(BRAND.accent);
  doc.opacity(1);

  doc.fillColor(BRAND.accent).text(text, x + padX, y + padY, { lineBreak: false });
  doc.restore();
}

function drawHeader(doc: PDFDoc, opts: { evidenceId: string; generatedAtUtc: string; status?: string }): void {
  const left = doc.page.margins.left;
  const top = doc.page.margins.top;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // top accent line
  doc.save();
  doc.rect(0, 0, doc.page.width, mmToPt(4)).fill(BRAND.accent);
  doc.restore();

  doc.x = left;
  doc.y = top;

  // logo (small)
  const logo = tryReadAsset("logo.png");
  let brandX = left;
  if (logo) {
    try {
      const h = mmToPt(8);
      doc.image(logo, left, doc.y - 1, { fit: [h * 3.8, h] });
      brandX = left + h * 3.8 + 8;
    } catch {
      brandX = left;
    }
  }

  // brand line
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(18);
  doc.text(BRAND.name, brandX, doc.y, { continued: true });

  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(12);
  doc.text(` — ${BRAND.title}`);

  doc.moveDown(0.45);

  // meta line
  const metaY = doc.y;
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(10);
  doc.text(`Evidence ID: ${opts.evidenceId}`, left, metaY, { continued: true });
  doc.text(`    Generated (UTC): ${opts.generatedAtUtc}`);

  // badge (top-right, aligned)
  const badgeText = safe(opts.status, "").toUpperCase();
  if (badgeText) {
    const bx = left + w - 135;
    const by = top + 6;
    drawBadge(doc, badgeText, bx, by);
  }

  doc.moveDown(0.55);
  hr(doc);
  doc.moveDown(0.65);
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
  doc.moveDown(0.9);
}

function kvGrid(doc: PDFDoc, rows: Array<[string, string]>, options?: { colGap?: number }): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const colGap = options?.colGap ?? 18;
  const colW = (w - colGap) / 2;

  doc.font("Helvetica").fontSize(10).fillColor(BRAND.ink);

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

function monospaceBlock(doc: PDFDoc, label: string, value: string): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.save();
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
  doc.text(label, x, doc.y, { width: w });
  doc.restore();

  doc.moveDown(0.2);

  // subtle background strip (not white card)
  const startY = doc.y;
  const h = Math.max(18, doc.heightOfString(value, { width: w, lineGap: 2 }) + 10);

  doc.save();
  doc.opacity(0.05);
  doc.rect(x - 4, startY - 4, w + 8, h + 8).fill(BRAND.ink);
  doc.opacity(1);
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Courier").fontSize(9);
  doc.text(value, x, startY, { width: w, lineGap: 2 });
  doc.restore();

  doc.y = startY + h;
  doc.moveDown(0.6);
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

  ensureSpace(doc, 120);

  // header strip (transparent, not white)
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

    // ✅ IMPORTANT: put footer INSIDE the content area to prevent auto page creation
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
    Subject: "Evidence Summary > Exhibit > Chain of Custody > Appendix",
    Keywords: `PROOVRA_REPORT_VERSION=${params.version};PROOVRA_GENERATED_AT=${params.generatedAtUtc}${buildToken}`,
    Creator: BRAND.name,
    Producer: BRAND.name,
    CreationDate: new Date(params.generatedAtUtc),
    ModDate: new Date(params.generatedAtUtc),
  };

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const verifyUrl = buildVerifyUrl(params.evidence.id, params.verifyUrl);
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
    doc.text(
      "Scan the QR code or open the link below to verify authenticity, signature, and chain of custody.",
      x,
      doc.y,
      { width: w, lineGap: 2 }
    );
    doc.moveDown(0.5);

    doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10);
    doc.text("Verify link:", x, doc.y);
    doc.moveDown(0.2);

    doc.fillColor(BRAND.accent).font("Helvetica").fontSize(9);
    doc.text(verifyUrl, x, doc.y, { width: w, link: verifyUrl, underline: true });
    doc.moveDown(0.6);

    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
    doc.text(
      "This report is cryptographically verifiable. Any modification to the original file or report data will be detected during verification.",
      x,
      doc.y,
      { width: w, lineGap: 2 }
    );
    doc.moveDown(0.2);
  });

  // QR verify (top-right)
  {
    const qrBuf = await tryGenerateQrPngBuffer(verifyUrl);
    if (qrBuf) {
      const x = doc.page.width - doc.page.margins.right - 128;
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
    doc.moveDown(0.6);

    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
    doc.text("To view or download the original evidence file, use the link / QR below.", x, doc.y, { width: w });
    doc.moveDown(0.35);

    if (downloadUrl !== "N/A") {
      const label = buildDownloadLabel(downloadUrl);

      doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10);
      doc.text("Download original evidence:", x, doc.y);
      doc.moveDown(0.2);

      doc.fillColor(BRAND.accent).font("Helvetica").fontSize(9);
      doc.text(label, x, doc.y, { width: w, link: downloadUrl, underline: true });
      doc.moveDown(0.5);
    } else {
      doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
      doc.text("Original download link: N/A", x, doc.y);
      doc.moveDown(0.5);
    }

    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9);
    doc.text(
      "Preview embedding (image/PDF first page/video thumbnail) can be added next by fetching the file from storage.",
      x,
      doc.y,
      { width: w, lineGap: 2 }
    );
    doc.moveDown(0.2);
  });

  // QR download
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

  // ===== APPENDIX A =====
  doc.addPage();
  drawHeader(doc, { evidenceId: params.evidence.id, generatedAtUtc: params.generatedAtUtc, status: params.evidence.status });

  section(doc, "Appendix A — Cryptographic Details", () => {
    monospaceBlock(doc, "File SHA-256", safe(params.evidence.fileSha256));
    monospaceBlock(doc, "Fingerprint Hash", safe(params.evidence.fingerprintHash));
    monospaceBlock(doc, "Signing Key ID / Version", `${safe(params.evidence.signingKeyId)} / ${params.evidence.signingKeyVersion}`);
    monospaceBlock(doc, "Signature (Base64)", safe(params.evidence.signatureBase64));
  });

  // ===== APPENDIX B =====
  doc.addPage();
  drawHeader(doc, { evidenceId: params.evidence.id, generatedAtUtc: params.generatedAtUtc, status: params.evidence.status });

  section(doc, "Appendix B — Fingerprint Canonical JSON", () => {
    monospaceBlock(doc, "Fingerprint Canonical JSON", safe(params.evidence.fingerprintCanonicalJson));
  });

  // ===== APPENDIX C =====
  doc.addPage();
  drawHeader(doc, { evidenceId: params.evidence.id, generatedAtUtc: params.generatedAtUtc, status: params.evidence.status });

  section(doc, "Appendix C — Signing Public Key (PEM)", () => {
    monospaceBlock(doc, "Public Key (PEM)", safe(params.evidence.publicKeyPem));
  });

  addFooters(doc, { generatedAtUtc: params.generatedAtUtc, reportVersion: params.version });

  const endPromise = new Promise<void>((resolve, reject) => {
    doc.once("end", resolve);
    doc.once("error", reject);
  });

  doc.end();
  await endPromise;

  const pdf = Buffer.concat(chunks);

  // Sign final PDF buffer (if enabled)
  return signPdfIfEnabled(pdf);
}