/**
 * PRODUCTION-CONTAINER SMOKE — the rendered-report gate, inside the built image.
 *
 *   docker run --rm -e PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK=true <worker-image> \
 *     node scripts/smoke-pdf-verification.mjs
 *
 * Production (2026-10-09) failed every report with "The API version 5.4.296
 * does not match the Worker version 5.6.205": two PDF.js builds in one process,
 * and the one that parsed a PDF first claimed the process-wide worker handler.
 * Unit tests passed because they load one build per process. This smoke runs in
 * the SHIPPED dependency layout and the order production hit:
 *
 *   1. LAYOUT — exactly one pdfjs-dist installed, and no package that bundles
 *      its own PDF.js (pdf-parse did) is present;
 *   2. HOSTILE ORDER — a PDF is parsed by the technical-metadata path first, as
 *      a long-lived worker that previewed an upload would have done;
 *   3. a representative PROOVRA report is rendered by the real renderer
 *      (Chromium), read back by the real `extractPdfText`, and checked by the
 *      real `assertRenderedReport` against canonical facts from the same record
 *      snapshot (OTS PENDING — the state production failed on);
 *   4. the required report facts are present in the extracted text;
 *   5. the metadata path still works AFTER report verification (other order).
 *
 * Every import is a module both the fixed and the defective builds ship, so the
 * same script FAILS against the defective layout (proven in CI and locally by
 * mounting it into the previous image). Prints one JSON line; exit 1 on failure.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, "..");
const dist = (p) => pathToFileURL(join(workerDir, "dist", p)).href;

const result = { ok: false, steps: {} };
const step = (name, value) => {
  result.steps[name] = value;
};

function findNodeModules(start) {
  const out = [];
  let dir = start;
  for (;;) {
    const nm = join(dir, "node_modules");
    if (existsSync(nm)) out.push(nm);
    const parent = dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

/** Every installed pdfjs-dist copy and every package known to bundle PDF.js. */
function pdfjsLayout() {
  const copies = [];
  const bundlers = [];
  const seen = new Set();
  const visit = (nm, depth) => {
    if (depth > 3 || seen.has(nm) || !existsSync(nm)) return;
    seen.add(nm);
    for (const entry of readdirSync(nm)) {
      if (entry.startsWith(".")) continue;
      const dirs = entry.startsWith("@") ? readdirSync(join(nm, entry)).map((e) => join(entry, e)) : [entry];
      for (const d of dirs) {
        const pkgDir = join(nm, d);
        const pj = join(pkgDir, "package.json");
        if (!existsSync(pj)) continue;
        let pkg;
        try {
          pkg = JSON.parse(readFileSync(pj, "utf8"));
        } catch {
          continue;
        }
        if (pkg.name === "pdfjs-dist") copies.push({ version: pkg.version, path: pkgDir });
        if (pkg.name === "pdf-parse") bundlers.push({ name: pkg.name, version: pkg.version, path: pkgDir });
        visit(join(pkgDir, "node_modules"), depth + 1);
      }
    }
  };
  for (const nm of findNodeModules(workerDir)) visit(nm, 0);
  return { copies, bundlers };
}

async function samplePdf(text) {
  const { default: PDFDocument } = await import("pdfkit");
  return new Promise((res) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => res(Buffer.concat(chunks)));
    doc.text(text);
    doc.end();
  });
}

const DIGEST = "3f2a9c1e5b7d4f6a8c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f1a3c5e7b9d2f4a";
const ROW = {
  tsaProvider: null, tsaUrl: null, tsaSerialNumber: null, tsaGenTimeUtc: null, tsaTokenBase64: null,
  tsaMessageImprint: null, tsaInputDigestHex: null, tsaInputKind: null, tsaHashAlgorithm: null,
  tsaStatus: null, tsaFailureReason: null, tsaFailureCode: null, tsaValidatedAtUtc: null,
  // The state production failed on: OTS initialized (PENDING) at issuance.
  otsProofBase64: null, otsHash: "b".repeat(64), otsStatus: "PENDING", otsCalendar: "smoke-calendar",
  otsBitcoinTxid: null, otsAnchoredAtUtc: null, otsUpgradedAtUtc: null, otsFailureReason: null, otsAnchorCheck: null,
};
const CUSTODY = [
  {
    sequence: 1,
    atUtc: "2026-10-09T08:00:00.000Z",
    eventType: "EVIDENCE_CREATED",
    payload: { evidenceId: "smoke-evidence" },
    prevEventHash: null,
    eventHash: "1".repeat(64),
    chainPosition: 1,
    chainLength: 1,
  },
];

/**
 * The worker's config validates these at import. Nothing here connects to a
 * database, queue or bucket, so unset values get inert local placeholders.
 */
const INERT_CONFIG = {
  DATABASE_URL: "postgresql://smoke:smoke@127.0.0.1:1/smoke",
  REDIS_URL: "redis://127.0.0.1:1",
  S3_ENDPOINT: "http://127.0.0.1:1",
  S3_ACCESS_KEY: "smoke",
  S3_SECRET_KEY: "smoke",
  S3_BUCKET: "smoke",
};
for (const [k, v] of Object.entries(INERT_CONFIG)) process.env[k] ||= v;

async function main() {
  // 1. LAYOUT
  const layout = pdfjsLayout();
  step("layout", {
    pdfjsCopies: layout.copies.map((c) => c.version),
    pdfjsBundlers: layout.bundlers.map((b) => `${b.name}@${b.version}`),
  });
  const layoutOk = new Set(layout.copies.map((c) => c.version)).size === 1 && layout.bundlers.length === 0;

  const verification = await import(dist("output-verification.js"));
  const metadata = await import(dist("technical-metadata/pdf-parser.js"));
  const { buildReportPdfV2 } = await import(dist("report-v2/build-report-pdf.js"));
  const shared = await import("@proovra/shared");

  // 2. HOSTILE ORDER — the metadata path parses a PDF first.
  const upload = await samplePdf("An uploaded PDF the worker previewed earlier.");
  const meta = await metadata.parsePdfMetadata(upload, "application/pdf");
  step("metadataFirst", { parseResult: meta?.parseResult ?? null, pageCount: meta?.pageCount ?? meta?.document?.pageCount ?? null });

  // 3. A representative PROOVRA report, rendered and verified for real.
  const facts = shared.deriveCanonicalArtifactFacts(
    { ...ROW, fileSha256: DIGEST, tsaTokenPresent: false, otsProofPresent: false },
    CUSTODY,
  );
  const input = {
    evidence: {
      id: "smoke-evidence",
      title: "Container smoke evidence",
      status: "SIGNED",
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      capturedAtUtc: "2026-10-09T08:00:00.000Z",
      uploadedAtUtc: "2026-10-09T08:00:30.000Z",
      signedAtUtc: "2026-10-09T08:01:00.000Z",
      reportGeneratedAtUtc: "2026-10-09T08:02:00.000Z",
      reportVersion: 1,
      mimeType: "text/plain",
      sizeBytes: "52",
      durationSec: null,
      storageBucket: "smoke-bucket",
      storageKey: "evidence/smoke-evidence/original",
      publicUrl: null,
      gps: { lat: null, lng: null, accuracyMeters: null },
      fileSha256: DIGEST,
      fingerprintCanonicalJson: '{"smoke":1}',
      fingerprintHash: "c".repeat(64),
      signatureBase64: "c21va2U=",
      signingKeyId: "smoke_ed25519",
      signingKeyVersion: 1,
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nSMOKE\n-----END PUBLIC KEY-----\n",
      acquisitionMode: null,
      contentSummary: {
        structure: "single", itemCount: 1, previewableItemCount: 1, downloadableItemCount: 1,
        imageCount: 0, videoCount: 0, audioCount: 0, documentCount: 1, otherCount: 0,
      },
      // The payload's lifecycle fields from the SAME row the facts came from.
      ...verification.reportLifecycleFields(ROW, CUSTODY),
    },
    custodyEvents: CUSTODY,
    version: 1,
    generatedAtUtc: "2026-10-09T08:02:00.000Z",
    publication: null,
  };
  const pdf = await buildReportPdfV2(input);
  step("render", { bytes: pdf.length, header: pdf.subarray(0, 5).toString("latin1") });
  // Optional: keep the rendered report for inspection (an OS temp path).
  if (process.env.SMOKE_PDF_OUT) (await import("node:fs")).writeFileSync(process.env.SMOKE_PDF_OUT, pdf);

  const text = await verification.extractPdfText(pdf);
  await verification.assertRenderedReport(pdf, facts, 1);
  const flat = text.replace(/\s+/g, " ");
  // 4. Required report facts, read from the PDF itself.
  const required = {
    digest: text.replace(/\s/g, "").includes(DIGEST),
    version: /\bv1\b/.test(flat),
    limitation: flat.includes(shared.VERIFICATION_LIMITATION.replace(/\s+/g, " ")),
    otsPending: /pending/i.test(flat),
  };
  step("verify", { textChars: text.length, required });

  // 5. The other order: the metadata path still works after verification.
  const metaAfter = await metadata.parsePdfMetadata(await samplePdf("after"), "application/pdf");
  step("metadataAfter", { parseResult: metaAfter?.parseResult ?? null });

  let runtime = null;
  if (existsSync(join(workerDir, "dist", "pdf", "pdfjs-runtime.js"))) {
    const rt = await import(dist("pdf/pdfjs-runtime.js"));
    const api = await rt.loadPdfjs();
    rt.assertOwnWorkerHandler(api.version);
    runtime = { apiVersion: api.version, packageVersion: rt.resolvedPdfjsPackageVersion() };
  }
  step("runtime", runtime);

  const failures = [];
  if (!layoutOk) failures.push("PDFJS_LAYOUT_NOT_SINGLE");
  for (const [k, v] of Object.entries(required)) if (!v) failures.push(`REPORT_FACT_MISSING:${k}`);
  if (meta?.parseResult === "FAILED" || metaAfter?.parseResult === "FAILED") failures.push("METADATA_PARSE_FAILED");
  if (runtime && runtime.apiVersion !== runtime.packageVersion) failures.push("PDFJS_RUNTIME_VERSION");
  // The image must say which source built it (CI passes the commit it built).
  const expectedSha = process.env.SMOKE_EXPECT_RELEASE_SHA;
  if (expectedSha && process.env.APP_RELEASE_SHA !== expectedSha) failures.push("RELEASE_SHA_MISMATCH");
  result.ok = failures.length === 0;
  result.failures = failures;
}

try {
  await main();
} catch (err) {
  result.ok = false;
  result.error = { name: err?.name ?? "Error", message: String(err?.message ?? err).slice(0, 600) };
  if (process.env.SMOKE_DEBUG) console.error(err);
}
result.releaseSha = process.env.APP_RELEASE_SHA || null;
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.ok ? 0 : 1);
