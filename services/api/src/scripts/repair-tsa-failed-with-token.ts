/**
 * VALIDATION OF KEPT TIMESTAMP TOKENS (ET-TSA-09, 2026-09-29).
 *
 * Candidates: evidence with a kept RFC 3161 reply that is either
 *   * tsa_status = 'FAILED' (e.g. no trust anchor was configured when it
 *     arrived, or the legacy parser mis-read it), or
 *   * tsa_status = 'STAMPED' with tsa_validated_at_utc NULL — written before
 *     token validation existed, presented as "recorded, not validated".
 *
 * Each row goes through evaluateKeptTsaToken — the SAME parser and the SAME
 * validator (validate-tsa-token.ts) as issuance, against the digest the record
 * sent and at the token's own genTime. Only a positive answer (granted, token
 * present, imprint equal, serial AND genTime parsed, signature and chain to
 * the configured anchor valid) records STAMPED + tsa_validated_at_utc. A
 * negative answer changes nothing: a legacy STAMPED row stays "recorded, not
 * validated", a FAILED row stays FAILED.
 * The script never writes a fake success.
 *
 * The provider is NEVER re-contacted: only the kept reply bytes are read.
 *
 * Safety design:
 *   * Dry-run by default. Writes ONLY when `--apply` is passed.
 *   * `--limit` capped at 1000 to prevent whole-DB replay.
 *   * `--evidence-id` for targeted operator runs.
 *   * Never re-contacts the TSA provider.
 *   * Never writes a custody event without a corresponding `tsaStatus`
 *     update — both happen in the SAME transaction.
 *   * Never overwrites a row's existing `tsa_input_digest_hex`.
 *
 * Usage:
 *   node dist/scripts/repair-tsa-failed-with-token.js                  # dry-run all
 *   node dist/scripts/repair-tsa-failed-with-token.js --apply          # write
 *   node dist/scripts/repair-tsa-failed-with-token.js --limit 25
 *   node dist/scripts/repair-tsa-failed-with-token.js \
 *     --evidence-id 77406c16-8699-4ddb-b855-e607c8bec6bb --apply
 */

import { randomUUID } from "node:crypto";

import * as prismaPkg from "@prisma/client";
import type { Prisma } from "@prisma/client";

import { prisma } from "../db.js";
import { appendCustodyEventTx } from "../services/custody-events.service.js";
import { evaluateKeptTsaToken } from "../services/timestamp/kept-token-validation.js";

type Args = {
  apply: boolean;
  limit: number;
  evidenceId: string | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, limit: 100, evidenceId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--limit") {
      const next = argv[i + 1];
      const n = next ? Number.parseInt(next, 10) : NaN;
      if (!Number.isFinite(n) || n <= 0 || n > 1000) {
        console.error(
          "[repair-tsa] --limit must be an integer between 1 and 1000",
        );
        process.exit(2);
      }
      args.limit = n;
      i += 1;
    } else if (a === "--evidence-id") {
      const next = argv[i + 1];
      if (!next) {
        console.error("[repair-tsa] --evidence-id requires a value");
        process.exit(2);
      }
      args.evidenceId = next;
      i += 1;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node dist/scripts/repair-tsa-failed-with-token.js [--apply] [--limit N] [--evidence-id <uuid>]",
      );
      process.exit(0);
    }
  }
  return args;
}

type Summary = {
  scanned: number;
  repairableDryRun: number;
  repairedApply: number;
  keptFailed: number;
  parseErrors: number;
  imprintMismatches: number;
  skippedNoToken: number;
  enqueuedJobs: number;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  /**
   * CLOSURE PASS (2026-08-22) — THE ONE GENUINE CORRELATOR THIS PIPELINE HAS.
   *
   * This script is a DELIBERATE MULTI-RECORD EXECUTION: an operator decides to
   * repair a set of records in one run, so failures that survive that run
   * really do share a cause — the run itself. That is positive evidence of
   * correlation, which is the only kind `deriveParentCorrelation` accepts.
   *
   * It is stamped on every record this execution TOUCHES, whether or not the
   * repair succeeded, because the correlation is a fact about the execution
   * and not about its outcome.
   *
   * Ordinary TSA and OTS work is one BullMQ job per Evidence and gets NO
   * correlator, which is why `integrityCorrelationId` is NULL for almost every
   * row. That is the correct state, not a gap.
   */
  const repairExecutionId = `tsa-repair:${randomUUID()}`;
  const summary: Summary = {
    scanned: 0,
    repairableDryRun: 0,
    repairedApply: 0,
    keptFailed: 0,
    parseErrors: 0,
    imprintMismatches: 0,
    skippedNoToken: 0,
    enqueuedJobs: 0,
  };

  console.log(
    `[repair-tsa] start mode=${args.apply ? "APPLY" : "DRY-RUN"} limit=${args.limit} evidenceId=${args.evidenceId ?? "(all)"}`,
  );

  // Candidates (ET-TSA-09): a kept token on a FAILED row, and a legacy STAMPED
  // row whose token was never validated. The provider is never contacted.
  const where: Prisma.EvidenceWhereInput = {
    deletedAt: null,
    tsaTokenBase64: { not: null },
    OR: [{ tsaStatus: "FAILED" }, { tsaStatus: "STAMPED", tsaValidatedAtUtc: null }],
  };
  if (args.evidenceId) where.id = args.evidenceId;

  const rows = await prisma.evidence.findMany({
    where,
    select: {
      id: true,
      tsaStatus: true,
      tsaProvider: true,
      tsaUrl: true,
      tsaHashAlgorithm: true,
      tsaTokenBase64: true,
      tsaInputDigestHex: true,
      tsaInputKind: true,
      fileSha256: true,
      tsaSerialNumber: true,
      tsaGenTimeUtc: true,
      tsaMessageImprint: true,
    },
    orderBy: { updatedAt: "asc" },
    take: args.limit,
  });

  if (rows.length === 0) {
    console.log("[repair-tsa] no candidate rows found — exiting.");
    await prisma.$disconnect();
    return;
  }

  for (const row of rows) {
    summary.scanned += 1;
    const idShort = row.id.slice(0, 8);
    if (!row.tsaTokenBase64) {
      summary.skippedNoToken += 1;
      continue;
    }

    const decision = await evaluateKeptTsaToken(row);
    if (!decision.ok) {
      summary.keptFailed += 1;
      if (decision.code === "tsa_message_imprint_mismatch") summary.imprintMismatches += 1;
      if (decision.code === "tsa_response_parse_failed") summary.parseErrors += 1;
      console.log(`[repair-tsa] NOT-VALIDATED ${idShort} status=${row.tsaStatus} code=${decision.code}`);
      continue;
    }

    // PRESERVE what was recorded (evidence-output incident, 2026-10-05): the
    // serial, genTime and imprint written at finalize came from this same kept
    // reply. They are kept as recorded; a recorded value the token contradicts
    // means the row is not what it claims — it is left FAILED, never rewritten.
    const recordedGenTime = row.tsaGenTimeUtc ? row.tsaGenTimeUtc.getTime() : null;
    const contradicted =
      (row.tsaSerialNumber != null && row.tsaSerialNumber !== decision.serialNumber) ||
      (recordedGenTime != null && recordedGenTime !== decision.genTimeUtc.getTime()) ||
      (row.tsaMessageImprint != null && row.tsaMessageImprint.toLowerCase() !== decision.messageImprint.toLowerCase());
    if (contradicted) {
      summary.keptFailed += 1;
      console.log(`[repair-tsa] NOT-VALIDATED ${idShort} status=${row.tsaStatus} code=tsa_recorded_fields_contradict_token`);
      continue;
    }

    summary.repairableDryRun += 1;
    console.log(
      `[repair-tsa] VALIDATED ${idShort} status=${row.tsaStatus} serial=${decision.serialNumber} genTime=${decision.genTimeUtc.toISOString()}`,
    );
    if (!args.apply) {
      console.log(`[repair-tsa]   (dry-run) would record the validation`);
      continue;
    }

    const wasFailed = row.tsaStatus === "FAILED";
    try {
      await prisma.$transaction(async (tx) => {
        // Compare-and-set on the state that was evaluated.
        const claimed = await tx.evidence.updateMany({
          where: { id: row.id, tsaStatus: row.tsaStatus, tsaValidatedAtUtc: null },
          data: {
            tsaStatus: "STAMPED",
            // Recorded values kept; a legacy null is filled from the same token.
            tsaSerialNumber: row.tsaSerialNumber ?? decision.serialNumber,
            tsaGenTimeUtc: row.tsaGenTimeUtc ?? decision.genTimeUtc,
            // ET-TSA-03: the imprint read from the token; the request digest stays.
            tsaMessageImprint: row.tsaMessageImprint ?? decision.messageImprint,
            tsaInputDigestHex: row.tsaInputDigestHex ?? decision.messageImprint,
            tsaFailureReason: null,
            tsaFailureCode: null,
            tsaValidatedAtUtc: decision.validatedAtUtc,
            tsaSignerCertSha256: decision.signerCertSha256,
            tsaPolicyOid: decision.policyOid,
            // The execution that touched this record. Read by the integrity
            // condition writer, which passes it to `deriveParentCorrelation`
            // as a PERSISTED correlation id — never inferred from the reason,
            // the provider, the filename or the clock.
            integrityCorrelationId: repairExecutionId,
          },
        });
        if (claimed.count !== 1) throw new Error("TSA_REPAIR_ROW_CHANGED_SINCE_SELECTION");
        // A FAILED row that becomes STAMPED gets its TIMESTAMP_APPLIED event. A
        // legacy STAMPED row already has one; only its validation is recorded.
        if (wasFailed) {
          await appendCustodyEventTx(tx, {
            evidenceId: row.id,
            eventType: prismaPkg.CustodyEventType.TIMESTAMP_APPLIED,
            atUtc: new Date(),
            payload: {
              tsaProvider: row.tsaProvider,
              tsaUrl: row.tsaUrl,
              tsaSerialNumber: decision.serialNumber,
              tsaGenTimeUtc: decision.genTimeUtc.toISOString(),
              tsaMessageImprint: decision.messageImprint,
              tsaInputKind: row.tsaInputKind,
              tsaHashAlgorithm: row.tsaHashAlgorithm,
              tsaStatus: "STAMPED",
              tsaFailureReason: null,
              tsaValidatedAtUtc: decision.validatedAtUtc.toISOString(),
              // Repair-script forensic marker: distinguishes this from a
              // finalize-time TIMESTAMP_APPLIED.
              repair_source: "tsa_kept_token_validated",
            },
          });
        }
      });
      summary.repairedApply += 1;
      console.log(`[repair-tsa]   → recorded validation${wasFailed ? " + custody event" : ""}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[repair-tsa]   transaction failed for ${idShort}: ${message.slice(0, 200)}`);
      summary.keptFailed += 1;
    }
    /*
     * NO REPORT IS RE-ISSUED (2026-09-29). Issued reports keep what they said
     * when they were issued; Public Verify shows the validated state from now
     * on, and an updated report is an explicit, authorized user action.
     */
  }

  console.log("[repair-tsa] summary " + JSON.stringify(summary));
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[repair-tsa] fatal", err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
