/**
 * Phase IA-OTS-hybrid-fix — runtime OTS diagnostic for one evidence row.
 *
 * Read-only forensic probe. Answers the question:
 *   "Why does this PENDING + bitcoinTxid evidence not become ANCHORED?"
 *
 * Captures (exactly the 10 steps the operator brief calls for):
 *   1. Reads the persisted ots_proof_base64 from the DB and writes
 *      it to a temp proof.ots.
 *   2. Runs `ots verify -d <ots_hash> <proof.ots>`; captures stdout,
 *      stderr, exit code.
 *   3. Runs `ots upgrade <proof.ots>`; captures stdout, stderr, exit
 *      code.
 *   4. Re-runs `ots verify` against the upgraded proof; captures
 *      stdout, stderr, exit code.
 *   5. Reports whether the proof file changed size after upgrade.
 *   6. Inspects the upgraded proof bytes for known Bitcoin block
 *      attestation markers (raw bytes — no calendar round-trip).
 *   7. Calls the in-process `parseOtsVerifyOutput` + `classifyOtsResult`
 *      so the operator sees exactly which parser regex matched and
 *      why verify.verified is false.
 *
 * Writes nothing back to the DB. The upgrade IS destructive on the
 * temp file (rewrites it), but the persisted base64 in the DB is
 * untouched.
 *
 * Usage:
 *   pnpm tsx services/worker/src/scripts/diagnose-ots-evidence.ts \
 *     --evidence-id 5fd0889a-47c4-4064-9e83-e27e62375e73
 *
 *   node dist/scripts/diagnose-ots-evidence.js \
 *     --evidence-id 5fd0889a-47c4-4064-9e83-e27e62375e73 --json
 *
 * Exit codes:
 *   0  — diagnostic ran to completion (regardless of verify outcome)
 *   1  — fatal (missing args, no evidence row, OTS binary missing)
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { prisma } from "../db.js";
import {
  classifyOtsResult,
  parseOtsInfoOutput,
  parseOtsUpgradeOutput,
  parseOtsVerifyOutput,
  type OtsInfoOutput,
  type OtsVerifyOutput,
} from "../ots-upgrade-output.js";
import { resolveOtsBin, resolveOtsTimeoutMs } from "../ots.service.js";

const execFileAsync = promisify(execFile);

type Args = { evidenceId: string | null; json: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { evidenceId: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--evidence-id") {
      args.evidenceId = (argv[i + 1] ?? "").trim() || null;
      i += 1;
    } else if (a === "--json") {
      args.json = true;
    }
  }
  return args;
}

type CommandResult = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errored: boolean;
  errorMessage: string | null;
};

async function runCommand(
  bin: string,
  args: string[],
  cwd: string,
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(bin, args, {
      cwd,
      timeout: resolveOtsTimeoutMs(),
    });
    return {
      command: `${bin} ${args.join(" ")}`,
      exitCode: 0,
      stdout: result.stdout?.toString() ?? "",
      stderr: result.stderr?.toString() ?? "",
      errored: false,
      errorMessage: null,
    };
  } catch (error) {
    const e = error as {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    const exitCode =
      typeof e.code === "number"
        ? e.code
        : typeof e.code === "string" && /^\d+$/.test(e.code)
          ? Number.parseInt(e.code, 10)
          : null;
    return {
      command: `${bin} ${args.join(" ")}`,
      exitCode,
      stdout: (e.stdout ?? "").toString(),
      stderr: (e.stderr ?? "").toString(),
      errored: true,
      errorMessage: e.message ?? null,
    };
  }
}

// =============================================================================
// Byte-level inspection of an upgraded OTS proof.
//
// The OpenTimestamps binary format encodes attestations with magic byte
// sequences. We look for the bytes the official client uses to mark a
// Bitcoin block attestation (in the proof OTS format, the Bitcoin
// attestation tag begins with the magic "\x05\x88\x96\x0d\x73\xd7\x19\x01"
// — eight bytes that prefix the block-height attestation header).
//
// This is a heuristic — the OTS format can wrap the attestation in
// different envelopes — so we report what we observe, NEVER assert
// "the proof IS anchored" from byte inspection alone. The authoritative
// signal is `ots verify`.
// =============================================================================
const BITCOIN_BLOCK_ATTESTATION_MAGIC = Buffer.from([
  0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01,
]);

// Pending-attestation magic ("pending calendar attestation marker"):
// the OTS spec uses a different 8-byte prefix for pending-marker
// attestations attached during stamp/upgrade. We surface its presence
// so the operator can tell whether the proof is "calendar-pending"
// (txid bound but block attestation not yet shipped) vs fully empty.
const PENDING_ATTESTATION_MAGIC = Buffer.from([
  0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e,
]);

type ProofInspection = {
  sizeBytes: number;
  hasBitcoinBlockAttestation: boolean;
  hasPendingAttestation: boolean;
  txidLikeHexCount: number;
};

function inspectProof(buf: Buffer): ProofInspection {
  // Count 64-hex-char sequences in a hex dump of the proof — a proxy
  // for "how many txid-shaped byte runs does the proof carry?" This
  // is NOT authoritative; it's a smell test for forensic comparison
  // between before/after.
  const hex = buf.toString("hex");
  const txidLikeMatches = hex.match(/[a-f0-9]{64}/g);
  return {
    sizeBytes: buf.length,
    hasBitcoinBlockAttestation: buf.includes(BITCOIN_BLOCK_ATTESTATION_MAGIC),
    hasPendingAttestation: buf.includes(PENDING_ATTESTATION_MAGIC),
    txidLikeHexCount: txidLikeMatches?.length ?? 0,
  };
}

// =============================================================================
// Which parser regex matched / missed for the verify output.
// =============================================================================
type VerifyParserTrace = {
  matched_success_marker: boolean;
  matched_bitcoin_block_attests_pattern: boolean;
  matched_incomplete_predicates: Array<string>;
  unmatched_incomplete_predicates: Array<string>;
};

function traceVerifyParse(text: string): VerifyParserTrace {
  const lower = text.toLowerCase();
  const incompletePredicates: Array<{
    name: string;
    match: () => boolean;
  }> = [
    {
      name: 'lower.includes("calendar attestation incomplete")',
      match: () => lower.includes("calendar attestation incomplete"),
    },
    {
      name: 'lower.includes("pending confirmation")',
      match: () => lower.includes("pending confirmation"),
    },
    {
      name: 'lower.includes("pending confirmations")',
      match: () => lower.includes("pending confirmations"),
    },
    {
      name: 'lower.includes("not yet anchored")',
      match: () => lower.includes("not yet anchored"),
    },
    {
      name: 'lower.includes("not fully confirmed")',
      match: () => lower.includes("not fully confirmed"),
    },
    {
      name: 'lower.includes("no attestations")',
      match: () => lower.includes("no attestations"),
    },
    {
      name: '/got\\s+0\\s+attestation/i',
      match: () => /got\s+0\s+attestation/i.test(text),
    },
  ];

  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const p of incompletePredicates) {
    if (p.match()) matched.push(p.name);
    else unmatched.push(p.name);
  }

  return {
    matched_success_marker: lower.includes("success!"),
    matched_bitcoin_block_attests_pattern:
      /bitcoin\s+block\s+\d+\s+attests/i.test(text),
    matched_incomplete_predicates: matched,
    unmatched_incomplete_predicates: unmatched,
  };
}

// =============================================================================
// Why verify.verified is false — bounded explanation derived from the
// parsed output. Pure, no shell.
// =============================================================================
function explainWhyNotVerified(verify: OtsVerifyOutput): string {
  if (verify.verified) {
    return "verify.verified IS true.";
  }
  if (verify.incompleteOutput) {
    return (
      "verify.verified=false because parseOtsVerifyOutput matched an INCOMPLETE " +
      "predicate (calendar attestation incomplete / pending confirmation / " +
      "not yet anchored / no attestations / got 0 attestation(s)) AND did not " +
      "match the SUCCESS marker ('success!') or the bitcoin-block-attests " +
      "pattern (/bitcoin\\s+block\\s+\\d+\\s+attests/i)."
    );
  }
  if (verify.raw.length === 0) {
    return "verify.verified=false because the command produced empty output.";
  }
  return (
    "verify.verified=false because the command output did not contain the " +
    "SUCCESS marker ('success!') or the bitcoin-block-attests pattern " +
    "(/bitcoin\\s+block\\s+\\d+\\s+attests/i)."
  );
}

// =============================================================================
// Main probe.
// =============================================================================
type DiagnosticReport = {
  evidenceId: string;
  evidenceColumns: Record<string, string | number | null>;
  step1_proof_written_to: string;
  step2_initial_verify: CommandResult & {
    parsed_verify: OtsVerifyOutput;
    parser_trace: VerifyParserTrace;
    why_not_verified: string;
  };
  step3_upgrade: CommandResult & {
    parsed_upgrade: ReturnType<typeof parseOtsUpgradeOutput>;
  };
  step4_post_upgrade_verify: CommandResult & {
    parsed_verify: OtsVerifyOutput;
    parser_trace: VerifyParserTrace;
    why_not_verified: string;
  };
  step5_size_change: {
    bytes_before: number;
    bytes_after: number;
    delta_bytes: number;
  };
  step6_attestation_inspection: {
    before: ProofInspection;
    after: ProofInspection;
  };
  // Phase IA-OTS-info-fallback — `ots info` is the deterministic
  // offline signal the classifier uses to promote to ANCHORED when
  // verify fails because the container has no local Bitcoin RPC.
  step6b_post_upgrade_info: CommandResult & {
    parsed_info: OtsInfoOutput;
    file_hash_matches_expected: boolean;
    expected_file_hash: string | null;
  };
  step7_classifier_outcome_now: ReturnType<typeof classifyOtsResult>;
  diagnosis_summary: string[];
};

async function diagnose(evidenceId: string): Promise<DiagnosticReport> {
  // Read the evidence row.
  const ev = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      id: true,
      createdAt: true,
      otsStatus: true,
      otsHash: true,
      otsProofBase64: true,
      otsBitcoinTxid: true,
      otsAnchoredAtUtc: true,
      otsUpgradedAtUtc: true,
      otsFailureReason: true,
      otsCalendar: true,
    },
  });
  if (!ev) {
    throw new Error(`evidence ${evidenceId} not found`);
  }
  if (!ev.otsHash || !ev.otsProofBase64) {
    throw new Error(
      `evidence ${evidenceId} is missing otsHash or otsProofBase64 — cannot run verify`,
    );
  }

  const evidenceColumns: Record<string, string | number | null> = {
    otsStatus: ev.otsStatus ?? null,
    otsHash: ev.otsHash ?? null,
    otsBitcoinTxid: ev.otsBitcoinTxid ?? null,
    otsAnchoredAtUtc: ev.otsAnchoredAtUtc?.toISOString() ?? null,
    otsUpgradedAtUtc: ev.otsUpgradedAtUtc?.toISOString() ?? null,
    otsFailureReason: ev.otsFailureReason ?? null,
    otsCalendar: ev.otsCalendar ?? null,
    otsProofBase64Length: ev.otsProofBase64.length,
  };

  // Step 1 — write proof to temp file.
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ots-diagnose-"));
  const proofFile = path.join(workDir, "proof.ots");
  const initialBytes = Buffer.from(ev.otsProofBase64, "base64");
  await fs.writeFile(proofFile, initialBytes);
  const inspectionBefore = inspectProof(initialBytes);

  // Step 2 — initial verify against persisted proof.
  const bin = resolveOtsBin();
  const initialVerify = await runCommand(
    bin,
    ["verify", "-d", ev.otsHash.toLowerCase(), proofFile],
    workDir,
  );
  const initialVerifyMerged =
    `${initialVerify.stdout}\n${initialVerify.stderr}`;
  const initialVerifyParsed = parseOtsVerifyOutput(
    initialVerify.stdout,
    initialVerify.stderr,
  );
  const initialVerifyTrace = traceVerifyParse(initialVerifyMerged);

  // Step 3 — upgrade.
  const upgrade = await runCommand(bin, ["upgrade", proofFile], workDir);
  const upgradeParsed = parseOtsUpgradeOutput(upgrade.stdout, upgrade.stderr);

  // Read the (possibly rewritten) proof and re-inspect.
  const upgradedBytes = await fs.readFile(proofFile);
  const inspectionAfter = inspectProof(upgradedBytes);

  // Step 4 — verify against upgraded proof.
  const postVerify = await runCommand(
    bin,
    ["verify", "-d", ev.otsHash.toLowerCase(), proofFile],
    workDir,
  );
  const postVerifyMerged = `${postVerify.stdout}\n${postVerify.stderr}`;
  const postVerifyParsed = parseOtsVerifyOutput(
    postVerify.stdout,
    postVerify.stderr,
  );
  const postVerifyTrace = traceVerifyParse(postVerifyMerged);

  // Step 6b — `ots info` against the upgraded proof. This is the
  // offline-only signal the classifier uses to promote to
  // FULLY_ANCHORED when verify fails because the container has no
  // local Bitcoin RPC. info parses file hash + block heights +
  // pending calendars from the proof bytes directly.
  const infoCmd = await runCommand(bin, ["info", proofFile], workDir);
  const infoParsed = parseOtsInfoOutput(infoCmd.stdout, infoCmd.stderr);
  const expectedFileHash = ev.otsHash?.toLowerCase() ?? null;
  const fileHashMatches =
    infoParsed.fileHash != null &&
    expectedFileHash != null &&
    infoParsed.fileHash === expectedFileHash;

  // Step 7 — classifier output given the actual outputs.
  const classifier = classifyOtsResult({
    upgrade: upgradeParsed,
    verify: postVerifyParsed,
    info: infoParsed,
    expectedFileHashHex: ev.otsHash,
    existingTxid: ev.otsBitcoinTxid,
    commandErrored: upgrade.errored,
    mergedErrorText: upgrade.errored
      ? `${upgrade.stderr}\n${upgrade.stdout}`
      : null,
  });

  // Cleanup the temp dir.
  await fs.rm(workDir, { recursive: true, force: true });

  // Summarize.
  const summary: string[] = [];
  if (postVerifyParsed.verified) {
    summary.push(
      "VERIFY SUCCEEDED after upgrade. The classifier will return FULLY_ANCHORED on the next processor run; the row should flip to ANCHORED.",
    );
  } else if (postVerifyParsed.incompleteOutput) {
    summary.push(
      "VERIFY remains INCOMPLETE after upgrade. The Bitcoin block attestation has not yet been shipped by the calendar — the proof is genuinely still pending.",
    );
  } else if (postVerify.errored) {
    summary.push(
      `VERIFY command errored (exit ${postVerify.exitCode ?? "n/a"}). Check stderr for the real reason; the classifier will fall back to the legacy heuristic only if the upgrade output is unambiguous.`,
    );
  }
  if (inspectionAfter.sizeBytes === inspectionBefore.sizeBytes) {
    summary.push(
      "Upgrade did NOT change the proof size. The calendar produced no new attestation material this round — re-running the upgrade later (after the calendar's batch cycle) is the next step.",
    );
  } else {
    summary.push(
      `Upgrade modified the proof: ${inspectionBefore.sizeBytes} → ${inspectionAfter.sizeBytes} bytes (Δ ${inspectionAfter.sizeBytes - inspectionBefore.sizeBytes}).`,
    );
  }
  if (
    inspectionAfter.hasBitcoinBlockAttestation &&
    !postVerifyParsed.verified
  ) {
    summary.push(
      "PARSER GAP CANDIDATE: the upgraded proof bytes contain the Bitcoin-block-attestation magic, but parseOtsVerifyOutput did NOT match a SUCCESS marker. Inspect the verify stdout/stderr — if it actually says 'Success!' but the parser misses it, that's a real parser bug.",
    );
  }
  if (
    classifier.kind === "FULLY_ANCHORED" &&
    classifier.phase === "anchored_via_info" &&
    !postVerifyParsed.verified
  ) {
    summary.push(
      `INFO-FALLBACK PROMOTION: ots verify failed (likely no local Bitcoin RPC) but ots info confirmed BitcoinBlockHeaderAttestation(${classifier.blockHeight ?? "n/a"}) AND the file hash matches evidence.otsHash. The processor will promote this row to ANCHORED on the next run.`,
    );
  }
  if (
    infoParsed.bitcoinBlockHeights.length > 0 &&
    !fileHashMatches
  ) {
    summary.push(
      `INFO HAS BLOCK BUT HASH MISMATCH: the proof carries a BitcoinBlockHeaderAttestation but its embedded file hash (${infoParsed.fileHash ?? "n/a"}) does NOT match evidence.otsHash (${expectedFileHash ?? "n/a"}). This is a defensive block — the proof bytes don't belong to this evidence and the classifier will NOT promote to ANCHORED.`,
    );
  }
  if (
    inspectionAfter.hasPendingAttestation &&
    !inspectionAfter.hasBitcoinBlockAttestation
  ) {
    summary.push(
      "Proof carries the PENDING-attestation marker but no Bitcoin-block-attestation magic yet. The calendar is still rolling up; this is the legitimate pending state.",
    );
  }

  return {
    evidenceId,
    evidenceColumns,
    step1_proof_written_to: proofFile,
    step2_initial_verify: {
      ...initialVerify,
      parsed_verify: initialVerifyParsed,
      parser_trace: initialVerifyTrace,
      why_not_verified: explainWhyNotVerified(initialVerifyParsed),
    },
    step3_upgrade: { ...upgrade, parsed_upgrade: upgradeParsed },
    step4_post_upgrade_verify: {
      ...postVerify,
      parsed_verify: postVerifyParsed,
      parser_trace: postVerifyTrace,
      why_not_verified: explainWhyNotVerified(postVerifyParsed),
    },
    step5_size_change: {
      bytes_before: inspectionBefore.sizeBytes,
      bytes_after: inspectionAfter.sizeBytes,
      delta_bytes: inspectionAfter.sizeBytes - inspectionBefore.sizeBytes,
    },
    step6_attestation_inspection: {
      before: inspectionBefore,
      after: inspectionAfter,
    },
    step6b_post_upgrade_info: {
      ...infoCmd,
      parsed_info: infoParsed,
      file_hash_matches_expected: fileHashMatches,
      expected_file_hash: expectedFileHash,
    },
    step7_classifier_outcome_now: classifier,
    diagnosis_summary: summary,
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.evidenceId) {
    process.stdout.write(
      "[diagnose-ots-evidence] --evidence-id <uuid> is required\n",
    );
    return 1;
  }

  try {
    const result = await diagnose(args.evidenceId);
    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      const lines: string[] = [];
      lines.push(`[diagnose-ots-evidence] evidenceId=${result.evidenceId}`);
      lines.push("");
      lines.push("== Evidence row (current DB values) ==");
      for (const [k, v] of Object.entries(result.evidenceColumns)) {
        lines.push(`  ${k}: ${v ?? "null"}`);
      }
      lines.push("");
      lines.push(`Step 1 — proof written to: ${result.step1_proof_written_to}`);
      lines.push("");
      lines.push("Step 2 — initial verify (against persisted proof):");
      lines.push(`  command: ${result.step2_initial_verify.command}`);
      lines.push(
        `  exitCode: ${result.step2_initial_verify.exitCode ?? "null"}`,
      );
      lines.push(`  stdout:\n${indent(result.step2_initial_verify.stdout)}`);
      lines.push(`  stderr:\n${indent(result.step2_initial_verify.stderr)}`);
      lines.push(
        `  parsed_verify: verified=${result.step2_initial_verify.parsed_verify.verified}, incompleteOutput=${result.step2_initial_verify.parsed_verify.incompleteOutput}, blockHeight=${result.step2_initial_verify.parsed_verify.blockHeight}, anchoredAtUtc=${result.step2_initial_verify.parsed_verify.anchoredAtUtc ?? "null"}`,
      );
      lines.push(
        `  parser_trace.matched_success_marker: ${result.step2_initial_verify.parser_trace.matched_success_marker}`,
      );
      lines.push(
        `  parser_trace.matched_bitcoin_block_attests_pattern: ${result.step2_initial_verify.parser_trace.matched_bitcoin_block_attests_pattern}`,
      );
      lines.push(
        `  parser_trace.matched_incomplete_predicates: ${result.step2_initial_verify.parser_trace.matched_incomplete_predicates.join(" | ") || "(none)"}`,
      );
      lines.push(
        `  why_not_verified: ${result.step2_initial_verify.why_not_verified}`,
      );
      lines.push("");
      lines.push("Step 3 — upgrade:");
      lines.push(`  command: ${result.step3_upgrade.command}`);
      lines.push(`  exitCode: ${result.step3_upgrade.exitCode ?? "null"}`);
      lines.push(`  stdout:\n${indent(result.step3_upgrade.stdout)}`);
      lines.push(`  stderr:\n${indent(result.step3_upgrade.stderr)}`);
      lines.push(
        `  parsed_upgrade: txid=${result.step3_upgrade.parsed_upgrade.txid ?? "null"}, anchoredOutput=${result.step3_upgrade.parsed_upgrade.anchoredOutput}, pendingOutput=${result.step3_upgrade.parsed_upgrade.pendingOutput}`,
      );
      lines.push("");
      lines.push("Step 4 — verify (against upgraded proof):");
      lines.push(`  command: ${result.step4_post_upgrade_verify.command}`);
      lines.push(
        `  exitCode: ${result.step4_post_upgrade_verify.exitCode ?? "null"}`,
      );
      lines.push(
        `  stdout:\n${indent(result.step4_post_upgrade_verify.stdout)}`,
      );
      lines.push(
        `  stderr:\n${indent(result.step4_post_upgrade_verify.stderr)}`,
      );
      lines.push(
        `  parsed_verify: verified=${result.step4_post_upgrade_verify.parsed_verify.verified}, incompleteOutput=${result.step4_post_upgrade_verify.parsed_verify.incompleteOutput}, blockHeight=${result.step4_post_upgrade_verify.parsed_verify.blockHeight}, anchoredAtUtc=${result.step4_post_upgrade_verify.parsed_verify.anchoredAtUtc ?? "null"}`,
      );
      lines.push(
        `  parser_trace.matched_success_marker: ${result.step4_post_upgrade_verify.parser_trace.matched_success_marker}`,
      );
      lines.push(
        `  parser_trace.matched_bitcoin_block_attests_pattern: ${result.step4_post_upgrade_verify.parser_trace.matched_bitcoin_block_attests_pattern}`,
      );
      lines.push(
        `  parser_trace.matched_incomplete_predicates: ${result.step4_post_upgrade_verify.parser_trace.matched_incomplete_predicates.join(" | ") || "(none)"}`,
      );
      lines.push(
        `  why_not_verified: ${result.step4_post_upgrade_verify.why_not_verified}`,
      );
      lines.push("");
      lines.push("Step 5 — proof file size change:");
      lines.push(
        `  bytes_before: ${result.step5_size_change.bytes_before}, bytes_after: ${result.step5_size_change.bytes_after}, delta: ${result.step5_size_change.delta_bytes}`,
      );
      lines.push("");
      lines.push("Step 6 — byte-level attestation inspection:");
      lines.push(
        `  before: hasBitcoinBlockAttestation=${result.step6_attestation_inspection.before.hasBitcoinBlockAttestation}, hasPendingAttestation=${result.step6_attestation_inspection.before.hasPendingAttestation}, txidLikeHexCount=${result.step6_attestation_inspection.before.txidLikeHexCount}`,
      );
      lines.push(
        `  after:  hasBitcoinBlockAttestation=${result.step6_attestation_inspection.after.hasBitcoinBlockAttestation}, hasPendingAttestation=${result.step6_attestation_inspection.after.hasPendingAttestation}, txidLikeHexCount=${result.step6_attestation_inspection.after.txidLikeHexCount}`,
      );
      lines.push("");
      lines.push("Step 6b — `ots info` against upgraded proof:");
      lines.push(`  command: ${result.step6b_post_upgrade_info.command}`);
      lines.push(
        `  exitCode: ${result.step6b_post_upgrade_info.exitCode ?? "null"}`,
      );
      lines.push(
        `  stdout:\n${indent(result.step6b_post_upgrade_info.stdout)}`,
      );
      lines.push(
        `  stderr:\n${indent(result.step6b_post_upgrade_info.stderr)}`,
      );
      lines.push(
        `  parsed_info.fileHash: ${result.step6b_post_upgrade_info.parsed_info.fileHash ?? "null"}`,
      );
      lines.push(
        `  expected_file_hash (evidence.otsHash): ${result.step6b_post_upgrade_info.expected_file_hash ?? "null"}`,
      );
      lines.push(
        `  file_hash_matches_expected: ${result.step6b_post_upgrade_info.file_hash_matches_expected}`,
      );
      lines.push(
        `  parsed_info.txid: ${result.step6b_post_upgrade_info.parsed_info.txid ?? "null"}`,
      );
      lines.push(
        `  parsed_info.bitcoinBlockHeights: ${result.step6b_post_upgrade_info.parsed_info.bitcoinBlockHeights.length === 0 ? "(none)" : result.step6b_post_upgrade_info.parsed_info.bitcoinBlockHeights.join(",")}`,
      );
      lines.push(
        `  parsed_info.pendingCalendars: ${result.step6b_post_upgrade_info.parsed_info.pendingCalendars.length === 0 ? "(none)" : result.step6b_post_upgrade_info.parsed_info.pendingCalendars.join(" | ")}`,
      );
      lines.push("");
      lines.push("Step 7 — classifier outcome NOW:");
      lines.push(`  kind: ${result.step7_classifier_outcome_now.kind}`);
      lines.push(`  txid: ${result.step7_classifier_outcome_now.txid ?? "null"}`);
      lines.push(
        `  anchoredAtUtc: ${result.step7_classifier_outcome_now.anchoredAtUtc ?? "null"}`,
      );
      lines.push(
        `  blockHeight: ${result.step7_classifier_outcome_now.blockHeight ?? "null"}`,
      );
      lines.push(`  phase: ${result.step7_classifier_outcome_now.phase}`);
      lines.push(`  reason: ${result.step7_classifier_outcome_now.reason}`);
      lines.push("");
      lines.push("== Diagnosis summary ==");
      for (const s of result.diagnosis_summary) lines.push(`  - ${s}`);
      process.stdout.write(lines.join("\n") + "\n");
    }
    return 0;
  } catch (err) {
    process.stderr.write(
      `[diagnose-ots-evidence] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

function indent(s: string): string {
  return (s || "").trimEnd().split("\n").map((l) => `    ${l}`).join("\n");
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    await prisma.$disconnect().catch(() => {});
    process.stderr.write(
      `[diagnose-ots-evidence] crash: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
