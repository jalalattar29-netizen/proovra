import PDFDocument from "pdfkit";

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

function safe(value: string | null | undefined, fallback = "N/A") {
  const t = typeof value === "string" ? value.trim() : "";
  return t ? t : fallback;
}

function summarizeText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

const BRAND = {
  name: "PROOVRA",
  title: "Verifiable Evidence Report",
  // عدّل هاي لتطابق ألوانك الأساسية (accent + dark)
  accent: "#2563EB",
  ink: "#0B1220",
  muted: "#4B5563",
  line: "#E5E7EB",
  card: "#F8FAFC",
  soft: "#EEF2FF",
};

function mmToPt(mm: number) {
  return (mm * 72) / 25.4;
}

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

function drawBadge(doc: PDFDoc, text: string, x: number, y: number) {
  const padX = 8;
  const padY = 4;
  doc.save();
  doc.font("Helvetica-Bold").fontSize(9);
  const tw = doc.widthOfString(text);
  const th = doc.currentLineHeight();
  doc.roundedRect(x, y, tw + padX * 2, th + padY * 2, 6).fill(BRAND.soft);
  doc.fillColor(BRAND.accent).text(text, x + padX, y + padY, { lineBreak: false });
  doc.restore();
}

function drawHeader(doc: PDFDoc, opts: { evidenceId: string; generatedAtUtc: string; status?: string }) {
  const x = doc.page.margins.left;
  const top = doc.page.margins.top;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Top accent bar
  doc.save();
  doc.rect(0, 0, doc.page.width, mmToPt(10)).fill(BRAND.accent);
  doc.restore();

  doc.y = top;

  // Brand + title
  doc.fillColor(BRAND.ink);
  doc.font("Helvetica-Bold").fontSize(18).text(BRAND.name, x, doc.y, { continued: true });
  doc.font("Helvetica").fontSize(12).fillColor(BRAND.muted).text(` — ${BRAND.title}`);

  doc.moveDown(0.6);

  // Meta row
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(10);
  doc.text(`Evidence ID: ${opts.evidenceId}`, x, doc.y, { continued: true });
  doc.text(`    Generated (UTC): ${opts.generatedAtUtc}`, { continued: false });

  // Status badge
  const badgeText = safe(opts.status, "").toUpperCase();
  if (badgeText) {
    const badgeX = x + w - 130;
    const badgeY = doc.y - 28;
    drawBadge(doc, badgeText, badgeX, badgeY);
  }

  doc.moveDown(0.6);
  hr(doc);
  doc.moveDown(0.8);
}

function card(
  doc: PDFDoc,
  title: string,
  render: () => void,
  options?: { minHeight?: number }
) {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const startY = doc.y;
  const minH = options?.minHeight ?? 0;

  ensureSpace(doc, Math.max(minH, 140));

  doc.save();
  doc.roundedRect(x, doc.y, w, Math.max(minH, 10), 14).fill(BRAND.card);
  doc.restore();

  const innerX = x + 14;
  const innerTop = doc.y + 12;

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(12);
  doc.text(title, innerX, innerTop);
  doc.restore();

  const afterTitleY = innerTop + 18;
  doc.y = afterTitleY;

  // Render contents inside card, then expand background to fit
  const contentStart = doc.y;
  render();
  const contentEnd = doc.y;

  const contentHeight = contentEnd - startY;
  const desiredH = Math.max(minH, contentHeight + 18);

  // Redraw card with correct height (PDFKit ما بيسمح edit بسهولة، فنرسم فوق)
  doc.save();
  doc.roundedRect(x, startY, w, desiredH, 14).fill(BRAND.card);
  doc.restore();

  // Re-draw title + contents again (عملي وبسيط)
  doc.y = innerTop;
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(12).text(title, innerX, doc.y);
  doc.y = afterTitleY;

  const prevY = doc.y;
  // move cursor and draw content مرة ثانية
  doc.y = prevY;

  // NOTE: since we rendered once already, we need to re-render for final.
  // To keep it deterministic, we call render() again and then set y accordingly.
  doc.y = contentStart;
  render();
  doc.y = startY + desiredH + 14;
}

function kvGrid(
  doc: PDFDoc,
  rows: Array<[string, string]>,
  options?: { colGap?: number }
) {
  const x = doc.page.margins.left + 14;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right - 28;

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

    doc.moveDown(0.2);
    doc.fillColor(BRAND.ink).font("Helvetica-Bold").text(v, colX, doc.y, { width: colW });

    doc.moveDown(0.6);

    if (isLeft) leftY = doc.y;
    else rightY = doc.y;
  }

  doc.y = Math.max(leftY, rightY);
}

function monospaceBlock(doc: PDFDoc, label: string, value: string) {
  const x = doc.page.margins.left + 14;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right - 28;

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

function drawTable(
  doc: PDFDoc,
  headers: string[],
  rows: string[][],
  colWidths: number[]
) {
  const x = doc.page.margins.left + 14;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right - 28;

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

  // Header background
  ensureSpace(doc, 80);
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

  // Header line
  doc.y += headerH;
  hr(doc, doc.y);
  doc.moveDown(0.2);

  // Rows
  for (const r of rows) {
    const rh = calcRowHeight(r);
    ensureSpace(doc, rh + 12);

    // Row text
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

    // Row divider
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
    const buf = await QRCode.toBuffer(data, { margin: 1, width: 220 });
    return buf;
  } catch {
    return null;
  }
}

function addFooters(doc: PDFDoc, opts: { generatedAtUtc: string; reportVersion: number }) {
  const range = doc.bufferedPageRange(); // { start, count }
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);

    const x = doc.page.margins.left;
    const y = doc.page.height - doc.page.margins.bottom + 10;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.save();
    doc.font("Helvetica").fontSize(9).fillColor(BRAND.muted);

    doc.text(
      `${BRAND.name} • Report v${opts.reportVersion} • Generated (UTC): ${opts.generatedAtUtc}`,
      x,
      y,
      { width: w, align: "left" }
    );

    doc.text(`Page ${i + 1} / ${range.count}`, x, y, { width: w, align: "right" });

    doc.restore();
  }
}

export async function buildReportPdf(params: {
  evidence: ReportEvidence;
  custodyEvents: ReportCustodyEvent[];
  version: number;
  generatedAtUtc: string;
  buildInfo?: string | null;

  /**
   * OPTIONAL: URL that your verify page uses (e.g. https://proovra.com/verify?evidenceId=...)
   * If provided, we render it + QR code (if qrcode is installed).
   */
  verifyUrl?: string | null;
}): Promise<Buffer> {
  // IMPORTANT: bufferPages true to allow adding footers after content
  const doc = new PDFDocument({ autoFirstPage: true, margin: 50, bufferPages: true });

  const buildToken = params.buildInfo ? `;PROOVRA_BUILD=${params.buildInfo}` : "";
  doc.info = {
    Title: "PROOVRA — Verifiable Evidence Report",
    Subject:
      "PROOVRA_SECTION_ORDER: Evidence Summary > Verification > Cryptographic Details > Chain of Custody > Appendix A > Appendix B",
    Keywords: `PROOVRA_REPORT_VERSION=${params.version};PROOVRA_GENERATED_AT=${params.generatedAtUtc}${buildToken}`,
    Creator: "PROOVRA",
    Producer: "PROOVRA",
    CreationDate: new Date(params.generatedAtUtc),
    ModDate: new Date(params.generatedAtUtc),
  };

  const chunks: Buffer[] = [];
  doc.on("data", (chunk) => chunks.push(chunk));

  // ===== Page 1 Header =====
  drawHeader(doc, {
    evidenceId: params.evidence.id,
    generatedAtUtc: params.generatedAtUtc,
    status: params.evidence.status,
  });

  // ===== Evidence Summary Card =====
  card(doc, "Evidence Summary", () => {
    kvGrid(doc, [
      ["Captured (UTC)", safe(params.evidence.capturedAtUtc)],
      ["Uploaded (UTC)", safe(params.evidence.uploadedAtUtc)],
      ["Signed (UTC)", safe(params.evidence.signedAtUtc)],
      ["Report Generated (UTC)", safe(params.evidence.reportGeneratedAtUtc)],
      ["MIME Type", safe(params.evidence.mimeType)],
      ["Size (bytes)", safe(params.evidence.sizeBytes)],
      ["Duration (sec)", safe(params.evidence.durationSec)],
      ["Storage Bucket", safe(params.evidence.storageBucket)],
      ["Storage Key", safe(params.evidence.storageKey)],
      ["Public URL", safe(params.evidence.publicUrl)],
      ["GPS (lat,lng)", `${safe(params.evidence.gps.lat)} , ${safe(params.evidence.gps.lng)}`],
      ["GPS Accuracy (m)", safe(params.evidence.gps.accuracyMeters)],
    ]);
  }, { minHeight: 210 });

  // ===== Verification Card =====
  const verifyUrl = safe(params.verifyUrl ?? "", "");
  const qrData = verifyUrl || (params.evidence.publicUrl ?? "");

  card(doc, "Verification", () => {
    doc.font("Helvetica").fontSize(10).fillColor(BRAND.ink);

    doc.fillColor(BRAND.muted).font("Helvetica").text("How to verify this evidence:", doc.page.margins.left + 14, doc.y);
    doc.moveDown(0.2);

    doc.fillColor(BRAND.ink).font("Helvetica").text(
      "1) Compute SHA-256 of the original file and compare with the File SHA-256 below.\n" +
        "2) Verify the Ed25519 signature over the fingerprint hash using the public key in Appendix B.",
      doc.page.margins.left + 14,
      doc.y,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 28, lineGap: 2 }
    );
    doc.moveDown(0.6);

    monospaceBlock(doc, "File SHA-256", safe(params.evidence.fileSha256));
    monospaceBlock(doc, "Fingerprint Hash", safe(params.evidence.fingerprintHash));
    monospaceBlock(doc, "Signing Key ID / Version", `${safe(params.evidence.signingKeyId)} / ${params.evidence.signingKeyVersion}`);

    if (qrData) {
      doc.save();
      doc.fillColor(BRAND.muted).font("Helvetica").fontSize(10).text("Verify link:", doc.page.margins.left + 14, doc.y);
      doc.restore();

      doc.moveDown(0.2);
      doc.fillColor(BRAND.accent).font("Helvetica").fontSize(9).text(qrData, doc.page.margins.left + 14, doc.y, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 28,
        link: qrData,
        underline: true,
      });
      doc.moveDown(0.6);
    }
  }, { minHeight: 240 });

  // QR image (outside card, on same page if fits)
  if (qrData) {
    const qrBuf = await tryGenerateQrPngBuffer(qrData);
    if (qrBuf) {
      const x = doc.page.width - doc.page.margins.right - 120;
      const y = doc.page.margins.top + 70;
      doc.image(qrBuf, x, y, { fit: [110, 110] });
      doc.save();
      doc.fillColor(BRAND.muted).font("Helvetica").fontSize(8).text("Scan to verify", x, y + 112, {
        width: 110,
        align: "center",
      });
      doc.restore();
    }
  }

  // ===== Cryptographic Details =====
  doc.moveDown(0.6);
  card(doc, "Cryptographic Details", () => {
    monospaceBlock(doc, "Signature (Base64)", summarizeText(safe(params.evidence.signatureBase64), 380));
    monospaceBlock(doc, "Fingerprint Canonical JSON (summary)", summarizeText(safe(params.evidence.fingerprintCanonicalJson), 500));
  }, { minHeight: 200 });

  // ===== Chain of Custody =====
  doc.moveDown(0.2);
  card(doc, "Chain of Custody", () => {
    const innerW = doc.page.width - doc.page.margins.left - doc.page.margins.right - 28;
    // columns: seq | at | type | summary
    const colWidths = [
      Math.max(44, innerW * 0.10),
      Math.max(120, innerW * 0.24),
      Math.max(120, innerW * 0.22),
      innerW - (Math.max(44, innerW * 0.10) + Math.max(120, innerW * 0.24) + Math.max(120, innerW * 0.22)),
    ];

    const headers = ["Seq", "At (UTC)", "Event", "Summary"];
    const rows = params.custodyEvents.map((ev) => [
      String(ev.sequence),
      safe(ev.atUtc),
      safe(ev.eventType),
      safe(ev.payloadSummary),
    ]);

    drawTable(doc, headers, rows, colWidths);
  }, { minHeight: 260 });

  // ===== Appendix A =====
  doc.addPage();
  drawHeader(doc, {
    evidenceId: params.evidence.id,
    generatedAtUtc: params.generatedAtUtc,
    status: params.evidence.status,
  });

  card(doc, "Appendix A — Fingerprint Canonical JSON", () => {
    monospaceBlock(doc, "Fingerprint Canonical JSON", safe(params.evidence.fingerprintCanonicalJson));
  }, { minHeight: 500 });

  // ===== Appendix B =====
  doc.addPage();
  drawHeader(doc, {
    evidenceId: params.evidence.id,
    generatedAtUtc: params.generatedAtUtc,
    status: params.evidence.status,
  });

  card(doc, "Appendix B — Signing Public Key (PEM)", () => {
    monospaceBlock(doc, "Public Key (PEM)", safe(params.evidence.publicKeyPem));
  }, { minHeight: 420 });

  // ===== Footer on all pages =====
  addFooters(doc, { generatedAtUtc: params.generatedAtUtc, reportVersion: params.version });

  doc.end();

  await new Promise<void>((resolve) => {
    doc.on("end", () => resolve());
  });

  return Buffer.concat(chunks);
}