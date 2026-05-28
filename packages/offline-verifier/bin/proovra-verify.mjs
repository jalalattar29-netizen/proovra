#!/usr/bin/env node
/**
 * PROOVRA Offline Verifier — CLI.
 *
 *   proovra-verify <path-to-package.zip> [--json] [--strict] [--out result.json]
 *
 * Exit codes:
 *   0  — overall === "verified"
 *   1  — overall === "failed"
 *   2  — overall === "partial" AND --strict is set
 *   2  — overall === "partial" without --strict still exits 0
 *
 * NEVER prints secrets, raw evidence content, or signatures. The
 * result JSON carries bounded enums + warning codes only.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { verifyPackage } from "../dist/verifier-core.js";
import {
  createNodePackageReader,
  nodeCryptoAdapter,
} from "../dist/node-adapter.js";

function fail(msg) {
  process.stderr.write(`proovra-verify: ${msg}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "Usage: proovra-verify <package.zip> [--json] [--strict] [--out FILE]",
      "",
      "Verifies a PROOVRA Verification Package OFFLINE. No PROOVRA API",
      "or AWS credentials are required. Runs entirely on your machine.",
      "",
      "Options:",
      "  --json         Emit the full JSON result to stdout.",
      "  --strict       Exit non-zero when overall status is `partial`.",
      "  --out FILE     Write the JSON result to FILE.",
      "  -h, --help     Show this help.",
      "",
      "Exit codes:",
      "  0  overall=verified  (or partial without --strict)",
      "  1  overall=failed",
      "  2  overall=partial AND --strict, or argument error",
      "",
      "This verifier is bounded. It NEVER claims legal admissibility,",
      "authorship, or content truth. See ATTESTATION-VERIFICATION.md",
      "inside the package for the bounded outcome model.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

let zipPath = null;
let asJson = false;
let strict = false;
let outFile = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--json") {
    asJson = true;
  } else if (a === "--strict") {
    strict = true;
  } else if (a === "--out") {
    outFile = args[i + 1];
    i++;
    if (!outFile) fail("--out requires a file path");
  } else if (!a.startsWith("--")) {
    zipPath = a;
  } else {
    fail(`unknown option: ${a}`);
  }
}
if (!zipPath) fail("path to a Verification Package ZIP is required");

let reader;
try {
  reader = createNodePackageReader(resolve(zipPath));
} catch (err) {
  fail(`could not open package: ${err instanceof Error ? err.name : "unknown"}`);
}

const result = await verifyPackage({
  reader,
  crypto: nodeCryptoAdapter,
});

if (outFile) {
  writeFileSync(resolve(outFile), JSON.stringify(result, null, 2), "utf8");
}

if (asJson) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else {
  process.stdout.write(formatHuman(result) + "\n");
}

if (result.overall.status === "failed") process.exit(1);
if (result.overall.status === "partial" && strict) process.exit(2);
process.exit(0);

function formatHuman(r) {
  const lines = [];
  const tick = (s) =>
    s === "verified"
      ? "[OK]"
      : s === "failed"
        ? "[FAIL]"
        : s === "missing"
          ? "[MISSING]"
          : s === "unsupported"
            ? "[UNSUPPORTED]"
            : s === "partial"
              ? "[PARTIAL]"
              : s === "pending"
                ? "[PENDING]"
                : `[${s.toUpperCase()}]`;
  lines.push("PROOVRA Offline Verifier");
  lines.push("=========================");
  lines.push("");
  lines.push(`Overall:               ${tick(r.overall.status)} ${r.summary}`);
  lines.push("");
  lines.push(`Package status:        ${tick(r.package.status)}`);
  lines.push(`  checksums:           ${tick(r.package.checksumsStatus)} (${r.package.filesIndexed} files indexed)`);
  lines.push(`  manifest:            ${tick(r.package.manifestStatus)}`);
  lines.push(`  signature:           ${tick(r.package.signatureStatus)}`);
  if (r.package.extraFiles > 0) {
    lines.push(`  extra files:         ${r.package.extraFiles}`);
  }
  if (r.package.checksumFailures.length > 0) {
    lines.push(`  failures:`);
    for (const f of r.package.checksumFailures.slice(0, 20)) {
      lines.push(`    - ${f.path} (${f.reason})`);
    }
  }
  lines.push("");
  lines.push(`Artifact integrity:    ${tick(r.artifactIntegrity.status)} (${r.artifactIntegrity.itemsChecked} items)`);
  lines.push(`Report signature:      ${tick(r.reportSignature.status)} ${r.reportSignature.detail ?? ""}`);
  lines.push("");
  lines.push(`Custody attestations:  ${tick(r.custodyAttestations.status)}`);
  lines.push(`  expected:            ${r.custodyAttestations.attestationsExpected}`);
  lines.push(`  checked:             ${r.custodyAttestations.attestationsChecked}`);
  lines.push(`  structurally ok:     ${r.custodyAttestations.attestationsVerified}`);
  if (r.custodyAttestations.failures.length > 0) {
    lines.push(`  failures:`);
    for (const f of r.custodyAttestations.failures.slice(0, 10)) {
      lines.push(`    - ${f.custodyEventId.slice(0, 16)}… (${f.reason})`);
    }
  }
  lines.push("");
  lines.push(`Timestamping:`);
  lines.push(`  TSA:                 ${tick(r.timestamping.tsaStatus)} ${r.timestamping.tsaDetail ?? ""}`);
  lines.push(`  OTS:                 ${tick(r.timestamping.otsStatus)} ${r.timestamping.otsDetail ?? ""}`);
  lines.push("");
  if (r.overall.warnings.length > 0) {
    lines.push("Warnings:");
    for (const w of r.overall.warnings) lines.push(`  ! ${w}`);
    lines.push("");
  }
  if (r.overall.limitations.length > 0) {
    lines.push("Limitations:");
    for (const l of r.overall.limitations) lines.push(`  - ${l}`);
  }
  return lines.join("\n");
}
