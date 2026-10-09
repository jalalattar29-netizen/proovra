/**
 * OUTPUT VERIFICATION — every report and package is checked against the
 * RECORD before it is published (2026-10-07).
 *
 * The canonical facts (packages/shared canonical-artifact-facts) are derived
 * from a FRESH read of the record's columns and custody chain — not from the
 * payload the report was rendered from — and then:
 *
 *   assertRenderInputs     before rendering: the payload yields the same
 *                          timestamp, anchoring and identity states;
 *   assertRenderedReport   after rendering: the text EXTRACTED FROM THE PDF
 *                          BYTES states them, and nothing stronger;
 *   assertStagedPackage    after sealing: the FINAL ZIP is read back from disk
 *                          — every entry streamed and hashed (no original is
 *                          held in memory) — its seal verifies with THE
 *                          canonical verifier, its seal key is the registered
 *                          PACKAGE_SEAL key, its identity and profile rules
 *                          hold, and its sealed documents state the facts.
 *
 * A finding is a deterministic contradiction: the output is not published and
 * the run fails terminally (an operator incident), never "retried until it
 * agrees".
 */
import { extractPdfTextWithPdfjs } from "./pdf/pdfjs-runtime.js";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInflateRaw } from "node:zlib";

import {
  checkRenderedReportText,
  checkSealedPackageFacts,
  compareCanonicalFacts,
  compareIssuanceFactsToRecord,
  deriveCanonicalArtifactFacts,
  presentedTsaStatus,
  resolveOtsCustodyFacts,
  validatePackageConsistency,
  verifySealedPackageEntries,
  type CanonicalArtifactFacts,
  type CanonicalFactsFinding,
  type SealEntryDigest,
} from "@proovra/shared";
import { findRegisteredSigningKey } from "@proovra/shared-runtime";

import { Prisma, type CustodyEventType } from "@prisma/client";

import { prisma } from "./db.js";
import type { ReportEvidence } from "./report-v2/types.js";

export class OutputVerificationError extends Error {
  readonly retriable = false;
  constructor(
    readonly code:
      | "REPORT_RENDER_INPUT_INCONSISTENT"
      | "REPORT_OUTPUT_INCONSISTENT"
      | "PACKAGE_OUTPUT_INCONSISTENT"
      /** The rendered PDF could not be read back at all, so it was not checked and is never issued. */
      | "REPORT_PDF_VERIFICATION_FAILED",
    readonly findings: CanonicalFactsFinding[],
  ) {
    super(`${code}: ${findings.slice(0, 5).map((f) => `${f.check} (${f.detail})`).join("; ")}`);
    this.name = "OutputVerificationError";
  }
}

/**
 * THE timestamp/anchoring lifecycle columns a report states, and the custody
 * chain they are read with. OTS initialization, OTS upgrades and TSA
 * validation all write these AFTER a record is finalized, asynchronously to
 * report generation.
 */
const LIFECYCLE_SELECT = {
  tsaProvider: true,
  tsaUrl: true,
  tsaSerialNumber: true,
  tsaGenTimeUtc: true,
  tsaTokenBase64: true,
  tsaMessageImprint: true,
  tsaInputDigestHex: true,
  tsaInputKind: true,
  tsaHashAlgorithm: true,
  tsaStatus: true,
  tsaFailureReason: true,
  tsaFailureCode: true,
  tsaValidatedAtUtc: true,
  otsProofBase64: true,
  otsHash: true,
  otsStatus: true,
  otsCalendar: true,
  otsBitcoinTxid: true,
  otsAnchoredAtUtc: true,
  otsUpgradedAtUtc: true,
  otsFailureReason: true,
  otsAnchorCheck: true,
} as const;

const FACTS_SELECT = {
  ...LIFECYCLE_SELECT,
  fileSha256: true,
  acquisitionMode: true,
  identityLevelSnapshot: true,
  submittedByAuthProvider: true,
  submittedByEmail: true,
  submittedByUserId: true,
  workspaceNameSnapshot: true,
  organizationNameSnapshot: true,
  organizationVerifiedSnapshot: true,
} as const;

type LifecycleRow = {
  tsaProvider: string | null;
  tsaUrl: string | null;
  tsaSerialNumber: string | null;
  tsaGenTimeUtc: Date | null;
  tsaTokenBase64: string | null;
  tsaMessageImprint: string | null;
  tsaInputDigestHex: string | null;
  tsaInputKind: string | null;
  tsaHashAlgorithm: string | null;
  tsaStatus: string | null;
  tsaFailureReason: string | null;
  tsaFailureCode: string | null;
  tsaValidatedAtUtc: Date | null;
  otsProofBase64: string | null;
  otsHash: string | null;
  otsStatus: string | null;
  otsCalendar: string | null;
  otsBitcoinTxid: string | null;
  otsAnchoredAtUtc: Date | null;
  otsUpgradedAtUtc: Date | null;
  otsFailureReason: string | null;
  otsAnchorCheck: string | null;
};

export type RecordCustodyEvent = {
  sequence: number;
  atUtc: Date;
  eventType: CustodyEventType;
  payload: Prisma.JsonValue;
  prevEventHash: string | null;
  eventHash: string | null;
};

/**
 * ONE consistent read of the record (2026-10-08): the lifecycle columns, the
 * identity columns and the custody chain in ONE repeatable-read transaction,
 * so an OTS initialization or TSA validation committing in between can never
 * split them. The report payload's lifecycle fields, the stored trust
 * snapshot, both packages and the output gates of one run all come from it.
 */
export type RecordSnapshot = {
  lifecycle: LifecycleRow;
  custody: RecordCustodyEvent[];
  facts: CanonicalArtifactFacts;
};

export async function loadRecordSnapshot(evidenceId: string): Promise<RecordSnapshot> {
  const [row, custody] = await prisma.$transaction(
    [
      prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: FACTS_SELECT }),
      prisma.custodyEvent.findMany({
        where: { evidenceId },
        orderBy: { sequence: "asc" },
        select: { sequence: true, atUtc: true, eventType: true, payload: true, prevEventHash: true, eventHash: true },
      }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  const facts = deriveCanonicalArtifactFacts(
    {
      ...row,
      tsaTokenPresent: Boolean(row.tsaTokenBase64),
      otsProofPresent: Boolean(row.otsProofBase64),
      identityLevelSnapshot: row.identityLevelSnapshot as string | null,
      submittedByAuthProvider: row.submittedByAuthProvider as string | null,
      acquisitionMode: row.acquisitionMode as string | null,
    },
    custody,
  );
  return { lifecycle: row as unknown as LifecycleRow, custody, facts };
}

/** THE record's facts, read fresh from the database (one consistent read). */
export async function loadCanonicalFacts(evidenceId: string): Promise<CanonicalArtifactFacts> {
  return (await loadRecordSnapshot(evidenceId)).facts;
}

/**
 * THE report payload's timestamp/anchoring fields from one lifecycle row and
 * the custody chain read with it — the one mapping, used when a run prepares
 * its payload and again when it takes its render snapshot. A STAMPED token
 * without a validation time is RECORDED_NOT_VALIDATED (ET-TSA-01); the OTS
 * status is the record's own (PENDING stays PENDING).
 */
export function reportLifecycleFields(
  row: LifecycleRow,
  custody: ReadonlyArray<{ eventType?: string | null; atUtc?: Date | string | null; payload?: unknown }>,
) {
  const otsCustodyFacts = resolveOtsCustodyFacts(custody, row.otsAnchorCheck ?? null);
  return {
    tsaProvider: row.tsaProvider ?? null,
    tsaUrl: row.tsaUrl ?? null,
    tsaSerialNumber: row.tsaSerialNumber ?? null,
    tsaGenTimeUtc: row.tsaGenTimeUtc?.toISOString() ?? null,
    tsaTokenBase64: row.tsaTokenBase64 ?? null,
    tsaMessageImprint: row.tsaMessageImprint ?? null,
    tsaInputDigestHex: row.tsaInputDigestHex ?? null,
    tsaInputKind: row.tsaInputKind ?? null,
    tsaHashAlgorithm: row.tsaHashAlgorithm ?? null,
    tsaStatus: presentedTsaStatus(row),
    tsaFailureReason: row.tsaFailureReason ?? null,
    tsaFailureCode: row.tsaFailureCode ?? null,
    tsaValidatedAtUtc: row.tsaValidatedAtUtc?.toISOString() ?? null,
    otsProofBase64: row.otsProofBase64 ?? null,
    otsHash: row.otsHash ?? null,
    otsStatus: row.otsStatus ?? null,
    otsCalendar: row.otsCalendar ?? null,
    otsBitcoinTxid: row.otsBitcoinTxid ?? null,
    otsAnchoredAtUtc: row.otsAnchoredAtUtc ? row.otsAnchoredAtUtc.toISOString() : null,
    otsUpgradedAtUtc: row.otsUpgradedAtUtc ? row.otsUpgradedAtUtc.toISOString() : null,
    otsFailureReason: row.otsFailureReason ?? null,
    otsAnchorCheck: row.otsAnchorCheck ?? null,
    otsAnchorCheckedAtUtc: otsCustodyFacts.anchorCheckedAtUtc,
    otsSubmittedAtUtc: otsCustodyFacts.submittedAtUtc,
  };
}

/**
 * The facts an issuance stated, against the record read later (a package
 * built for a committed report, a run whose snapshot was taken before an
 * asynchronous layer advanced): forward progress is compatible, anything else
 * is a contradiction (compareIssuanceFactsToRecord).
 */
export function assertIssuanceStillHolds(issuance: CanonicalArtifactFacts, later: CanonicalArtifactFacts): void {
  const findings = compareIssuanceFactsToRecord(issuance, later);
  if (findings.length) throw new OutputVerificationError("REPORT_RENDER_INPUT_INCONSISTENT", findings);
}

/** BEFORE RENDERING — the payload yields the record's facts. */
export function assertRenderInputs(
  record: CanonicalArtifactFacts,
  payload: ReportEvidence,
  custodyEvents: ReadonlyArray<{ eventType?: string | null; atUtc?: Date | string | null; payload?: unknown }>,
): void {
  const rendered = deriveCanonicalArtifactFacts(
    {
      fileSha256: payload.fileSha256,
      tsaStatus: payload.tsaStatus,
      tsaFailureCode: payload.tsaFailureCode ?? null,
      tsaTokenPresent: Boolean(payload.tsaTokenBase64),
      tsaValidatedAtUtc: payload.tsaValidatedAtUtc ?? null,
      otsStatus: payload.otsStatus ?? null,
      otsAnchoredAtUtc: payload.otsAnchoredAtUtc ?? null,
      otsAnchorCheck: payload.otsAnchorCheck ?? null,
      otsBitcoinTxid: payload.otsBitcoinTxid ?? null,
      otsProofPresent: Boolean(payload.otsProofBase64),
      otsUpgradedAtUtc: payload.otsUpgradedAtUtc ?? null,
      acquisitionMode: payload.acquisitionMode ?? null,
    },
    custodyEvents,
  );
  // The identity the report renders is the snapshot the payload carries.
  const findings = compareCanonicalFacts(record, {
    ...rendered,
    acquisition: payload.acquisitionIdentity ?? rendered.acquisition,
  });
  if (findings.length) throw new OutputVerificationError("REPORT_RENDER_INPUT_INCONSISTENT", findings);
}

/**
 * The text of a PDF, from its bytes — through the worker's ONE PDF.js build
 * (pdf/pdfjs-runtime.ts). It used to load pdf-parse, which bundles a SECOND
 * PDF.js (5.4.296) that collided with the worker's own (5.6.205) in any
 * process that had already parsed a PDF elsewhere: "The API version 5.4.296
 * does not match the Worker version 5.6.205" (production, 2026-10-09).
 */
export async function extractPdfText(pdf: Buffer): Promise<string> {
  return extractPdfTextWithPdfjs(pdf);
}

/** AFTER RENDERING — the PDF's own text states the facts. */
export async function assertRenderedReport(pdf: Buffer, facts: CanonicalArtifactFacts, reportVersion: number): Promise<void> {
  /*
   * A PDF THAT CANNOT BE READ IS NOT VERIFIED (2026-10-09). Reading the bytes
   * back is the gate, so an extraction failure refuses the report exactly like
   * a finding does: a stable, NON-retryable code, never a retry loop. Retrying
   * cannot help — the same bytes and the same runtime fail the same way (the
   * production PDF.js API/worker mismatch failed every attempt) — and a retry
   * loop is what left the page saying "Generating" while operators were told
   * retries were exhausted. TECHNICAL by class: once the runtime is fixed, the
   * existing supersession retries it.
   */
  let text: string;
  try {
    text = await extractPdfText(pdf);
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    const runtime = (err as { code?: unknown } | null)?.code === "PDFJS_RUNTIME_MISMATCH" ? "PDFJS_RUNTIME_MISMATCH" : name;
    throw new OutputVerificationError("REPORT_PDF_VERIFICATION_FAILED", [
      { check: "PDF_TEXT", detail: `the rendered PDF could not be read back (${runtime.slice(0, 64)})` },
    ]);
  }
  const findings = checkRenderedReportText(text, facts, { reportVersion });
  if (findings.length) throw new OutputVerificationError("REPORT_OUTPUT_INCONSISTENT", findings);
}

// ---------------------------------------------------------------------------
// The final ZIP, read back from disk.
// ---------------------------------------------------------------------------

type CentralEntry = { name: string; method: number; compressedSize: number; size: number; localOffset: number };

const SMALL_ENTRY = 4 * 1024 * 1024;
const TEXT_ENTRY = /\.(json|txt|md|sig|pem)$/;

async function readCentralDirectory(path: string): Promise<CentralEntry[]> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 22 + 0xffff + 20);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("ZIP_EOCD_NOT_FOUND");
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    // ZIP64: the EOCD64 locator precedes the EOCD.
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error("ZIP64_LOCATOR_NOT_FOUND");
      const eocd64Offset = Number(tail.readBigUInt64LE(loc + 8));
      const e64 = Buffer.alloc(56);
      await fh.read(e64, 0, 56, eocd64Offset);
      if (e64.readUInt32LE(0) !== 0x06064b50) throw new Error("ZIP64_EOCD_NOT_FOUND");
      count = Number(e64.readBigUInt64LE(32));
      cdSize = Number(e64.readBigUInt64LE(40));
      cdOffset = Number(e64.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const out: CentralEntry[] = [];
    let p = 0;
    for (let n = 0; n < count; n += 1) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("ZIP_BAD_CENTRAL_HEADER");
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let entrySize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      // ZIP64 extended information (0x0001): sizes and offset that overflowed.
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (entrySize === 0xffffffff) { entrySize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(cd.readBigUInt64LE(q)); }
        }
        x += 4 + len;
      }
      if (!name.endsWith("/")) out.push({ name, method, compressedSize, size: entrySize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** Stream one entry: its SHA-256 and size, and its bytes when small text. */
async function readEntry(path: string, e: CentralEntry): Promise<{ sha256: string; sizeBytes: number; bytes: Buffer | null }> {
  const fh = await open(path, "r");
  let dataStart: number;
  try {
    const local = Buffer.alloc(30);
    await fh.read(local, 0, 30, e.localOffset);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error("ZIP_BAD_LOCAL_HEADER");
    dataStart = e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  } finally {
    await fh.close();
  }
  const keep = TEXT_ENTRY.test(e.name) && e.size <= SMALL_ENTRY;
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  if (e.compressedSize > 0) {
    const raw = createReadStream(path, { start: dataStart, end: dataStart + e.compressedSize - 1 });
    const stream = e.method === 8 ? raw.pipe(createInflateRaw()) : e.method === 0 ? raw : null;
    if (!stream) throw new Error(`ZIP_UNSUPPORTED_METHOD:${e.method}`);
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      if (keep) chunks.push(chunk);
    }
  }
  return { sha256: hash.digest("hex"), sizeBytes, bytes: keep ? Buffer.concat(chunks) : null };
}

/**
 * AFTER SEALING — the staged ZIP, read back from disk, is the package it
 * claims to be and states the record's facts.
 */
export async function assertStagedPackage(input: {
  zipPath: string;
  facts: CanonicalArtifactFacts;
  expect: {
    packageId: string;
    evidenceId: string;
    reportVersion: number;
    disclosureProfile: "FULL_FORENSIC" | "EXTERNAL_DISCLOSURE";
    reportSha256: string;
    seal: { signingKeyId: string; signingKeyVersion: number; signingKeyFingerprint: string };
  };
}): Promise<void> {
  const entries = new Map<string, Uint8Array | SealEntryDigest>();
  const texts = new Map<string, string>();
  for (const e of await readCentralDirectory(input.zipPath)) {
    const r = await readEntry(input.zipPath, e);
    if (r.bytes) {
      entries.set(e.name, r.bytes);
      texts.set(e.name, r.bytes.toString("utf8"));
    } else {
      entries.set(e.name, { sha256: r.sha256, sizeBytes: r.sizeBytes });
    }
  }
  const findings: CanonicalFactsFinding[] = [];

  // 1. THE canonical seal verifier — the same one a recipient's tooling runs.
  const seal = verifySealedPackageEntries({
    entries,
    sha256Hex: (b) => createHash("sha256").update(b).digest("hex"),
    verifyEd25519: (message, signatureBase64, publicKeyPem) =>
      verifySignature(null, Buffer.from(message), createPublicKey(publicKeyPem), Buffer.from(signatureBase64, "base64")),
    decodeUtf8: (b) => Buffer.from(b).toString("utf8"),
    hexToBytes: (h) => Buffer.from(h, "hex"),
  });
  for (const f of seal.failures) findings.push({ check: `SEAL_${f.check}`, detail: f.detail });
  if (seal.seal) {
    if (seal.seal.reportSha256 !== input.expect.reportSha256.toLowerCase()) {
      findings.push({ check: "SEAL_REPORT", detail: "the seal does not commit to the committed report's digest" });
    }
  }

  // 2. The seal key is THE registered PACKAGE_SEAL key (registry read, not the package's word).
  const sigText = texts.get("package-seal.sig");
  let sig: { signingKeyId?: string; signingKeyVersion?: number | string; signingKeyFingerprint?: string } = {};
  try {
    sig = sigText ? JSON.parse(sigText) : {};
  } catch {
    sig = {};
  }
  const registered = await findRegisteredSigningKey(prisma, {
    keyId: input.expect.seal.signingKeyId,
    version: input.expect.seal.signingKeyVersion,
    purpose: "PACKAGE_SEAL",
  });
  if (!registered) findings.push({ check: "SEAL_KEY_REGISTERED", detail: "the seal key is not registered for PACKAGE_SEAL" });
  else {
    if (registered.revokedAt) findings.push({ check: "SEAL_KEY_REVOKED", detail: "the seal key is revoked" });
    if (registered.fingerprintSha256 !== input.expect.seal.signingKeyFingerprint) {
      findings.push({ check: "SEAL_KEY_FINGERPRINT", detail: "the registered key is not the key that sealed" });
    }
    if (sig.signingKeyFingerprint !== registered.fingerprintSha256) {
      findings.push({ check: "SEAL_KEY_FINGERPRINT", detail: "package-seal.sig names another key" });
    }
  }

  // 3. Identity, profile and disclosure rules between the sealed documents.
  for (const f of validatePackageConsistency({
    texts: new Map([...texts].filter(([p]) => /\.(json|txt|md)$/.test(p))),
    paths: [...entries.keys()],
    expect: {
      packageId: input.expect.packageId,
      evidenceId: input.expect.evidenceId,
      reportVersion: input.expect.reportVersion,
      disclosureProfile: input.expect.disclosureProfile,
      evidenceFileSha256: input.facts.evidenceFileSha256,
    },
  })) {
    findings.push({ check: `CONSISTENCY_${f.check}`, detail: f.detail });
  }

  // 4. The sealed documents state the RECORD's facts.
  const docs = new Map<string, unknown>();
  for (const [path, text] of texts) {
    if (!path.endsWith(".json")) continue;
    try {
      docs.set(path, JSON.parse(text));
    } catch {
      /* reported by the consistency check */
    }
  }
  findings.push(...checkSealedPackageFacts(docs, input.facts));

  if (findings.length) throw new OutputVerificationError("PACKAGE_OUTPUT_INCONSISTENT", findings);
}
