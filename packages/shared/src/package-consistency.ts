/**
 * THE CROSS-ARTIFACT CONSISTENCY VALIDATOR (2026-10-07).
 *
 * One package's documents must not contradict one another. The worker runs
 * this over every package's entries BEFORE it seals them (a contradiction is
 * a generation failure, never a polished artifact), and the end-to-end proof
 * runs it again over the downloaded ZIP alongside the database rows, the PDF
 * text and Public Verify.
 *
 * Pure: entries in, findings out. Each finding names the two documents that
 * disagree and the field.
 */
import { DISCLOSURE_MANIFEST_FILE } from "./disclosure-profile.js";
import { resolveSnapshotSignalState } from "./trust-signal-state.js";

export type PackageConsistencyFinding = { check: string; detail: string };

export type PackageConsistencyExpectation = {
  packageId: string;
  evidenceId: string;
  reportVersion: number;
  disclosureProfile: "FULL_FORENSIC" | "EXTERNAL_DISCLOSURE";
  /** The digest the signature and the RFC 3161 token certify (seal input). */
  evidenceFileSha256: string | null;
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Every value of a key at any depth. */
function collect(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) for (const v of node) collect(v, key, out);
  else if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      collect(v, key, out);
    }
  }
  return out;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const INFRA_KEYS = ["storageBucket", "storageKey", "storageVersionId", "s3VersionId", "kmsKeyArn", "verificationMaterialRef"];

export function validatePackageConsistency(input: {
  /** ZIP path -> UTF-8 text of every JSON / text entry (binary entries may be omitted). */
  texts: ReadonlyMap<string, string>;
  /** Every entry path in the package (for presence checks). */
  paths: ReadonlyArray<string>;
  expect: PackageConsistencyExpectation;
}): PackageConsistencyFinding[] {
  const findings: PackageConsistencyFinding[] = [];
  const f = (check: string, detail: string) => findings.push({ check, detail });
  const parsed = new Map<string, unknown>();
  for (const [path, text] of input.texts) {
    if (!path.endsWith(".json")) continue;
    try {
      parsed.set(path, JSON.parse(text));
    } catch {
      f("JSON_VALID", `${path} is not valid JSON`);
    }
  }
  const e = input.expect;

  // 1. One package identity in every document that states its own. (Custody
  // payloads may name OTHER packages — e.g. an earlier download — and are not
  // this package's identity statement, so only top-level fields count.)
  for (const [path, doc] of parsed) {
    if (isObj(doc) && "packageId" in doc && doc.packageId !== e.packageId) {
      f("PACKAGE_ID", `${path} states packageId ${JSON.stringify(doc.packageId)}, expected ${e.packageId}`);
    }
  }
  for (const required of ["package-manifest.json", "package-mode.json", "custody/attestations.json", "signers/signer-registry-snapshot.json", "signers/historical-verification-material.json"]) {
    const doc = parsed.get(required);
    if (isObj(doc) && !("packageId" in doc)) f("PACKAGE_ID", `${required} states no packageId`);
  }

  // 2. The manifest agrees with the package's identity and the certified digest.
  const manifest = parsed.get("package-manifest.json");
  if (!isObj(manifest)) f("MANIFEST_PRESENT", "package-manifest.json is missing");
  else {
    if (manifest.evidenceId !== e.evidenceId) f("EVIDENCE_ID", `manifest evidenceId ${String(manifest.evidenceId)}`);
    if (manifest.reportVersion !== e.reportVersion) f("REPORT_VERSION", `manifest reportVersion ${String(manifest.reportVersion)}`);
    if (manifest.disclosureProfile !== e.disclosureProfile) f("DISCLOSURE_PROFILE", `manifest profile ${String(manifest.disclosureProfile)}`);
    if ((manifest.evidenceFileSha256 ?? null) !== (e.evidenceFileSha256?.toLowerCase() ?? null)) {
      f("EVIDENCE_DIGEST", `manifest evidenceFileSha256 ${String(manifest.evidenceFileSha256)} vs ${String(e.evidenceFileSha256)}`);
    }
  }

  // 3. The anchoring claim in the manifest is the trust decision's state.
  const trust = parsed.get("trust-decision.json");
  const signals = isObj(trust) && Array.isArray(trust.signals) ? (trust.signals as Json[]) : [];
  const anchoring = signals.find((s) => s.key === "bitcoin_anchoring");
  const anchoringPassed = anchoring ? resolveSnapshotSignalState(anchoring as never) === "PASSED" : false;
  if (isObj(manifest) && Boolean(manifest.publicAnchoringVerified) !== anchoringPassed) {
    f("OTS_STATE", `manifest publicAnchoringVerified=${String(manifest.publicAnchoringVerified)} but trust-decision anchoring is ${anchoring ? String(anchoring.state ?? anchoring.status) : "absent"}`);
  }
  if (anchoring && anchoring.state !== "PASSED" && (anchoring.status === "passed")) {
    f("OTS_STATE", "trust-decision anchoring status is passed without a PASSED state");
  }

  // 4. The timestamp validation record and the trust decision state the same timestamp.
  const tsaRecord = parsed.get("timestamp-validation.json");
  const tsaSignal = signals.find((s) => s.key === "trusted_timestamp");
  if (isObj(tsaRecord) && tsaSignal) {
    const state = resolveSnapshotSignalState(tsaSignal as never);
    if (tsaRecord.trustState !== state) f("TSA_STATE", `timestamp-validation.json ${String(tsaRecord.trustState)} vs trust-decision ${state}`);
    if (Boolean(tsaRecord.tokenFile) !== input.paths.includes("timestamp.tsr")) {
      f("TSA_TOKEN", "timestamp-validation.json tokenFile disagrees with the presence of timestamp.tsr");
    }
  }

  // 5. Every signal's status is its state's projection; no unchecked layer reads passed.
  for (const s of signals) {
    if (s.status === "passed" && s.state !== undefined && s.state !== "PASSED") {
      f("SIGNAL_STATE", `${String(s.key)} status passed with state ${String(s.state)}`);
    }
  }

  // 6. The disclosure profile is what the package contains.
  const disclosure = parsed.get(DISCLOSURE_MANIFEST_FILE);
  if (!isObj(disclosure)) f("DISCLOSURE_MANIFEST", `${DISCLOSURE_MANIFEST_FILE} is missing`);
  else if (disclosure.disclosureProfile !== e.disclosureProfile) f("DISCLOSURE_MANIFEST", `profile ${String(disclosure.disclosureProfile)}`);
  if (e.disclosureProfile === "EXTERNAL_DISCLOSURE") {
    if (input.paths.some((p) => p.startsWith("reports/"))) f("EXTERNAL_WITHHOLDS_REPORT", "a report is present");
    if (input.paths.some((p) => p.startsWith("evidence-parts/"))) f("EXTERNAL_WITHHOLDS_ORIGINALS", "evidence parts are present");
    if (input.paths.includes("map-preview.png")) f("EXTERNAL_WITHHOLDS_LOCATION", "map-preview.png is present");
    for (const [path, text] of input.texts) {
      if (path === "fingerprint.json" || path === "README.txt") continue; // signed canonical text / instructions
      const m = text.match(EMAIL);
      if (m) f("EXTERNAL_NO_EMAIL", `${path} contains ${m[0]}`);
    }
    for (const [path, doc] of parsed) {
      for (const k of INFRA_KEYS) {
        for (const v of collect(doc, k)) {
          if (typeof v === "string" && v !== "[withheld]" && v !== "package-manifest-public-key.pem") {
            f("EXTERNAL_NO_INFRASTRUCTURE", `${path} → ${k}`);
          }
        }
      }
    }
  }

  // 7. The README states the identity and the digest it tells the verifier to use.
  const readme = input.texts.get("README.txt") ?? "";
  if (!readme.includes(e.packageId)) f("README_PACKAGE_ID", "README.txt does not state the package id");
  if (e.evidenceFileSha256 && !readme.includes(e.evidenceFileSha256.toLowerCase())) {
    f("README_DIGEST", "README.txt does not state evidenceFileSha256");
  }
  if (/fileSha256 from package-manifest\.json/.test(readme)) f("README_DIGEST", "README.txt references a field the manifest does not have");

  return findings;
}
