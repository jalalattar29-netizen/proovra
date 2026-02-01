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

function summarizeText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function addSectionTitle(doc: PDFDoc, title: string) {
  doc.moveDown(0.5);
  doc.fontSize(14).text(title, { underline: true });
  doc.moveDown(0.2);
  doc.fontSize(10);
}

function addKeyValue(doc: PDFDoc, label: string, value: string | null) {
  const safe = value ?? "N/A";
  doc.text(`${label}: ${safe}`);
}

export async function buildReportPdf(params: {
  evidence: ReportEvidence;
  custodyEvents: ReportCustodyEvent[];
  version: number;
  generatedAtUtc: string;
  buildInfo?: string | null;
}): Promise<Buffer> {
  const doc = new PDFDocument({ autoFirstPage: true, margin: 50 });
  const chunks: Buffer[] = [];

  doc.on("data", (chunk) => chunks.push(chunk));

  doc.fontSize(18).text("Digital Witness — Verifiable Evidence Report", {
    align: "center",
  });
  doc.moveDown(0.5);
  doc.fontSize(10);

  addSectionTitle(doc, "Evidence Summary");
  addKeyValue(doc, "Evidence ID", params.evidence.id);
  addKeyValue(doc, "Status", params.evidence.status);
  addKeyValue(doc, "Captured At (UTC)", params.evidence.capturedAtUtc);
  addKeyValue(doc, "Uploaded At (UTC)", params.evidence.uploadedAtUtc);
  addKeyValue(doc, "Signed At (UTC)", params.evidence.signedAtUtc);
  addKeyValue(
    doc,
    "Report Generated At (UTC)",
    params.evidence.reportGeneratedAtUtc
  );
  addKeyValue(doc, "MIME Type", params.evidence.mimeType);
  addKeyValue(doc, "Size Bytes", params.evidence.sizeBytes);
  addKeyValue(doc, "Duration Seconds", params.evidence.durationSec);
  addKeyValue(doc, "Storage Bucket", params.evidence.storageBucket);
  addKeyValue(doc, "Storage Key", params.evidence.storageKey);
  addKeyValue(doc, "Public URL", params.evidence.publicUrl);
  addKeyValue(doc, "GPS Lat", params.evidence.gps.lat);
  addKeyValue(doc, "GPS Lng", params.evidence.gps.lng);
  addKeyValue(doc, "GPS Accuracy Meters", params.evidence.gps.accuracyMeters);

  addSectionTitle(doc, "Cryptographic Details");
  addKeyValue(doc, "File SHA-256", params.evidence.fileSha256);
  addKeyValue(
    doc,
    "Fingerprint Canonical JSON (Summary)",
    summarizeText(params.evidence.fingerprintCanonicalJson, 200)
  );
  addKeyValue(doc, "Fingerprint Hash", params.evidence.fingerprintHash);
  addKeyValue(doc, "Signature (Base64)", params.evidence.signatureBase64);
  addKeyValue(doc, "Signing Key ID", params.evidence.signingKeyId);
  addKeyValue(
    doc,
    "Signing Key Version",
    `${params.evidence.signingKeyVersion}`
  );

  doc.moveDown(0.3);
  doc.text("Verification Instructions:", { underline: true });
  doc.text("1) Compute SHA-256 of the original file and compare to File SHA-256.");
  doc.text(
    "2) Verify the Ed25519 signature over the fingerprint hash using the public key."
  );

  addSectionTitle(doc, "Chain of Custody");
  doc.text("Sequence | At (UTC) | Event Type | Payload Summary");
  doc.moveDown(0.2);
  for (const ev of params.custodyEvents) {
    doc.text(`${ev.sequence} | ${ev.atUtc} | ${ev.eventType} | ${ev.payloadSummary}`);
  }

  doc.addPage();
  addSectionTitle(doc, "Appendix A — Fingerprint Canonical JSON");
  doc.text(params.evidence.fingerprintCanonicalJson);

  doc.addPage();
  addSectionTitle(doc, "Appendix B — Signing Public Key (PEM)");
  doc.text(params.evidence.publicKeyPem);

  doc.addPage();
  addSectionTitle(doc, "Report Footer");
  addKeyValue(doc, "Report Version", `${params.version}`);
  addKeyValue(doc, "Generated At (UTC)", params.generatedAtUtc);
  addKeyValue(doc, "System", "Digital Witness");
  if (params.buildInfo) {
    addKeyValue(doc, "Build", params.buildInfo);
  }

  doc.end();

  await new Promise<void>((resolve) => {
    doc.on("end", () => resolve());
  });

  return Buffer.concat(chunks);
}
