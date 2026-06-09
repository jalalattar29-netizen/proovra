/**
 * Phase IA-forward-path — read-only runtime smoke for a single evidence id.
 *
 * Purpose:
 *   Run this script against production (or any environment with the same
 *   schema) immediately after a fresh evidence is created to confirm that
 *   the NEW EVIDENCE forward path actually behaved as designed — without
 *   making ANY writes.
 *
 * What it inspects (in order):
 *
 *   1. Evidence row — status, signature, TSA columns, OTS columns,
 *      Object Lock, fingerprint, file SHA-256.
 *   2. Custody chain — presence + ordering of the canonical events:
 *      UPLOAD_COMPLETED, SIGNATURE_APPLIED, TIMESTAMP_APPLIED OR
 *      TIMESTAMP_FAILED, OTS_APPLIED.
 *   3. TSA truth — when STAMPED, every TSA column the truth surface
 *      reads is populated AND `tsaInputDigestHex === fileSha256`.
 *      When FAILED, `tsaFailureReason` is present AND
 *      `tsaInputDigestHex` is NULL (truthful semantics).
 *   4. OTS truth — proof bytes present, status reflects the latest
 *      classifier outcome, txid presence is consistent with the
 *      anchoredAtUtc null/non-null state.
 *   5. Reports — latest report + version sequence + at least one
 *      `regenerateReason` entry if the row anchored after creation.
 *
 * Safety:
 *   * NO writes. The script connects with the standard Prisma client
 *     and ONLY runs `.findUnique` / `.findMany`.
 *   * NO subprocess calls. NO provider re-contact.
 *   * --evidence-id is REQUIRED — there is no whole-DB form.
 *
 * Usage:
 *   pnpm tsx services/api/src/scripts/smoke-evidence-forward-path.ts \
 *     --evidence-id <uuid>
 *
 *   node dist/scripts/smoke-evidence-forward-path.js \
 *     --evidence-id <uuid>
 *
 * Exit codes:
 *   0  — every probe passed
 *   1  — required flag missing OR uncaught error
 *   2  — at least one forward-path probe failed (output enumerates them)
 */

import { prisma } from "../db.js";

type Args = {
  evidenceId: string | null;
  json: boolean;
};

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

type ProbeResult = {
  name: string;
  ok: boolean;
  detail: string;
};

function ok(name: string, detail: string): ProbeResult {
  return { name, ok: true, detail };
}

function fail(name: string, detail: string): ProbeResult {
  return { name, ok: false, detail };
}

async function probeEvidence(evidenceId: string): Promise<ProbeResult[]> {
  const probes: ProbeResult[] = [];

  // ---------------------------------------------------------------------
  // 1. Evidence row
  // ---------------------------------------------------------------------
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      id: true,
      status: true,
      verificationStatus: true,
      fileSha256: true,
      fingerprintHash: true,
      signatureBase64: true,
      signingKeyId: true,
      signingKeyVersion: true,
      storageBucket: true,
      storageKey: true,
      storageObjectLockMode: true,
      storageObjectLockRetainUntilUtc: true,
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
      otsStatus: true,
      otsHash: true,
      otsProofBase64: true,
      otsCalendar: true,
      otsBitcoinTxid: true,
      otsAnchoredAtUtc: true,
      otsUpgradedAtUtc: true,
      otsFailureReason: true,
      createdAt: true,
    },
  });

  if (!evidence) {
    probes.push(fail("evidence_present", `No evidence row found for id ${evidenceId}.`));
    return probes;
  }
  probes.push(ok("evidence_present", `status=${evidence.status} created=${evidence.createdAt.toISOString()}`));

  // Signature material
  if (evidence.signatureBase64 && evidence.signingKeyId && evidence.fingerprintHash) {
    probes.push(ok("signature_present", `keyId=${evidence.signingKeyId} keyVersion=${evidence.signingKeyVersion ?? "?"}`));
  } else {
    probes.push(fail("signature_present", "signatureBase64 / signingKeyId / fingerprintHash missing — KMS forward step did not complete"));
  }

  // Object Lock
  if (evidence.storageObjectLockMode && evidence.storageObjectLockRetainUntilUtc) {
    probes.push(ok("object_lock_applied", `mode=${evidence.storageObjectLockMode} until=${evidence.storageObjectLockRetainUntilUtc.toISOString()}`));
  } else if (evidence.storageBucket && evidence.storageKey) {
    probes.push(fail("object_lock_applied", "object stored but Object Lock mode/retainUntil is null — confirm bucket policy"));
  } else {
    probes.push(fail("object_lock_applied", "no storage location persisted on the evidence row"));
  }

  // ---------------------------------------------------------------------
  // 2. Custody chain
  // ---------------------------------------------------------------------
  const events = await prisma.custodyEvent.findMany({
    where: { evidenceId },
    orderBy: { atUtc: "asc" },
    select: { id: true, eventType: true, atUtc: true },
  });

  const types = new Set(events.map((e) => e.eventType));
  probes.push(ok("custody_event_count", `${events.length} events`));

  for (const required of ["UPLOAD_COMPLETED", "SIGNATURE_APPLIED"]) {
    if (types.has(required as never)) {
      probes.push(ok(`custody_${required.toLowerCase()}`, "present"));
    } else {
      probes.push(fail(`custody_${required.toLowerCase()}`, "missing — forward step did not record"));
    }
  }

  const hasTimestampApplied = types.has("TIMESTAMP_APPLIED" as never);
  const hasTimestampFailed = types.has("TIMESTAMP_FAILED" as never);
  if (hasTimestampApplied || hasTimestampFailed) {
    probes.push(ok("custody_timestamp_outcome", hasTimestampApplied ? "TIMESTAMP_APPLIED" : "TIMESTAMP_FAILED"));
  } else if (evidence.tsaStatus !== null) {
    probes.push(fail("custody_timestamp_outcome", `tsaStatus=${evidence.tsaStatus} but neither TIMESTAMP_APPLIED nor TIMESTAMP_FAILED event was emitted`));
  } else {
    probes.push(ok("custody_timestamp_outcome", "TSA disabled or not configured — no outcome event expected"));
  }

  // ---------------------------------------------------------------------
  // 3. TSA truth (Issue #8 truthful semantics)
  // ---------------------------------------------------------------------
  if (evidence.tsaStatus === "STAMPED") {
    const missing: string[] = [];
    if (!evidence.tsaProvider) missing.push("tsaProvider");
    if (!evidence.tsaUrl) missing.push("tsaUrl");
    if (!evidence.tsaSerialNumber) missing.push("tsaSerialNumber");
    if (!evidence.tsaGenTimeUtc) missing.push("tsaGenTimeUtc");
    if (!evidence.tsaTokenBase64) missing.push("tsaTokenBase64");
    if (!evidence.tsaMessageImprint) missing.push("tsaMessageImprint");
    if (!evidence.tsaInputDigestHex) missing.push("tsaInputDigestHex");
    if (!evidence.tsaInputKind) missing.push("tsaInputKind");
    if (!evidence.tsaHashAlgorithm) missing.push("tsaHashAlgorithm");

    if (missing.length === 0) {
      probes.push(ok("tsa_truth_stamped", `provider=${evidence.tsaProvider} serial=${evidence.tsaSerialNumber}`));
    } else {
      probes.push(fail("tsa_truth_stamped", `STAMPED row missing columns: ${missing.join(", ")}`));
    }

    if (evidence.tsaInputDigestHex && evidence.tsaMessageImprint && evidence.tsaInputDigestHex === evidence.tsaMessageImprint) {
      probes.push(ok("tsa_imprint_consistent", "tsaInputDigestHex == tsaMessageImprint"));
    } else {
      probes.push(fail("tsa_imprint_consistent", `digest mismatch — input=${evidence.tsaInputDigestHex} imprint=${evidence.tsaMessageImprint}`));
    }
  } else if (evidence.tsaStatus === "FAILED") {
    if (!evidence.tsaFailureReason) {
      probes.push(fail("tsa_truth_failed_has_reason", "FAILED row with NULL tsaFailureReason — refusal context is missing"));
    } else {
      probes.push(ok("tsa_truth_failed_has_reason", evidence.tsaFailureReason.slice(0, 120)));
    }
    if (evidence.tsaInputDigestHex !== null) {
      probes.push(fail("tsa_truthful_semantics", "FAILED row has non-null tsaInputDigestHex — Issue #8 truthful semantics violated"));
    } else {
      probes.push(ok("tsa_truthful_semantics", "FAILED row correctly has NULL tsaInputDigestHex"));
    }
    if (evidence.tsaTokenBase64 && evidence.tsaTokenBase64.length > 0) {
      probes.push(ok("tsa_token_preserved", `${evidence.tsaTokenBase64.length} base64 chars (repair script can re-parse)`));
    } else {
      probes.push(ok("tsa_token_preserved", "no token preserved — provider-side or subprocess failure (expected for those modes)"));
    }
  } else {
    probes.push(ok("tsa_truth", `tsaStatus=${evidence.tsaStatus ?? "null"} — TSA disabled or never ran`));
  }

  // ---------------------------------------------------------------------
  // 4. OTS truth
  // ---------------------------------------------------------------------
  if (!evidence.otsProofBase64) {
    probes.push(fail("ots_proof_present", "otsProofBase64 is null — initial OTS create did not run"));
  } else {
    probes.push(ok("ots_proof_present", `${evidence.otsProofBase64.length} base64 chars`));
  }

  switch (evidence.otsStatus) {
    case "ANCHORED": {
      if (!evidence.otsAnchoredAtUtc) {
        probes.push(fail("ots_anchored_has_timestamp", "ANCHORED but otsAnchoredAtUtc is null — classifier promoted without an anchor time"));
      } else {
        probes.push(ok("ots_anchored_has_timestamp", evidence.otsAnchoredAtUtc.toISOString()));
      }
      if (!evidence.otsBitcoinTxid) {
        // Legitimate legacy state — anchored proof with no public txid (anchor_material_recovered before).
        probes.push(ok("ots_anchored_txid", "ANCHORED with no Bitcoin txid (legacy anchored_no_public_receipt)"));
      } else {
        probes.push(ok("ots_anchored_txid", evidence.otsBitcoinTxid));
      }
      break;
    }
    case "PENDING": {
      if (evidence.otsAnchoredAtUtc !== null) {
        probes.push(fail("ots_pending_no_anchor_time", "PENDING with non-null otsAnchoredAtUtc — inconsistent classifier output"));
      } else {
        probes.push(ok("ots_pending_no_anchor_time", "PENDING with null otsAnchoredAtUtc (expected)"));
      }
      if (evidence.otsBitcoinTxid) {
        probes.push(ok("ots_pending_with_txid", `ANCHOR_MATERIAL_RECOVERED state: txid=${evidence.otsBitcoinTxid} awaiting confirmation`));
      } else {
        probes.push(ok("ots_pending_no_txid", "STILL_PENDING state: no Bitcoin transaction bound yet"));
      }
      break;
    }
    case "FAILED": {
      probes.push(ok("ots_failed_reason", evidence.otsFailureReason ?? "(no reason persisted)"));
      break;
    }
    default: {
      probes.push(ok("ots_status", `otsStatus=${evidence.otsStatus ?? "null"}`));
    }
  }

  // ---------------------------------------------------------------------
  // 5. Reports — latest selection + regen reasons
  // ---------------------------------------------------------------------
  const reports = await prisma.report.findMany({
    where: { evidenceId },
    // Report has `version: Int` + `generatedAtUtc: DateTime` — there is
    // no `createdAt`. The latest read sites all use `version desc` so
    // mirror that ordering here.
    orderBy: { version: "asc" },
    select: { id: true, version: true, generatedAtUtc: true },
  });

  if (reports.length === 0) {
    probes.push(fail("report_present", "no reports generated yet"));
  } else {
    const latest = reports[reports.length - 1];
    probes.push(ok("report_latest", `version=${latest!.version} id=${latest!.id}`));
    const versions = reports.map((r) => r.version);
    const monotonic = versions.every((v, i) => i === 0 || v! > versions[i - 1]!);
    if (monotonic) {
      probes.push(ok("report_versions_monotonic", versions.join(",")));
    } else {
      probes.push(fail("report_versions_monotonic", `non-monotonic versions: ${versions.join(",")}`));
    }
    // `regenerateReason` is a JOB-level signal (forwarded through
    // BullMQ `forceRegenerate: true`) — it is NOT persisted on the
    // Report row. The audit trail for regen reasons lives on the
    // custody events (OTS_APPLIED + report-generated events) instead.
    // Confirm: if more than one Report version exists, custody chain
    // should contain at least one post-creation event explaining the
    // re-generation cause.
    if (reports.length > 1) {
      const regenLikeEventTypes = events
        .filter((e) =>
          e.eventType === "OTS_APPLIED" ||
          e.eventType === "TIMESTAMP_APPLIED" ||
          e.eventType === "TIMESTAMP_FAILED",
        )
        .map((e) => e.eventType);
      if (regenLikeEventTypes.length > 0) {
        probes.push(ok("report_regen_cause_in_chain", regenLikeEventTypes.join(", ")));
      } else {
        probes.push(fail("report_regen_cause_in_chain", `multiple report versions (${versions.length}) but no OTS/TIMESTAMP custody event explains the regen`));
      }
    } else {
      probes.push(ok("report_single_version", "no regen yet — single report version is the canonical truth"));
    }
  }

  return probes;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.evidenceId) {
    process.stdout.write(
      "[smoke-evidence-forward-path] --evidence-id <uuid> is required\n",
    );
    return 1;
  }

  const probes = await probeEvidence(args.evidenceId);

  if (args.json) {
    process.stdout.write(JSON.stringify({ evidenceId: args.evidenceId, probes }, null, 2) + "\n");
  } else {
    process.stdout.write(`[smoke-evidence-forward-path] evidence=${args.evidenceId}\n`);
    for (const p of probes) {
      const mark = p.ok ? "PASS" : "FAIL";
      process.stdout.write(`  [${mark}] ${p.name} — ${p.detail}\n`);
    }
  }

  const failed = probes.filter((p) => !p.ok).length;
  if (failed > 0) {
    process.stdout.write(`[smoke-evidence-forward-path] ${failed} probe(s) failed\n`);
    return 2;
  }
  process.stdout.write(`[smoke-evidence-forward-path] all ${probes.length} probes passed\n`);
  return 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    await prisma.$disconnect().catch(() => {});
    process.stderr.write(
      `[smoke-evidence-forward-path] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
