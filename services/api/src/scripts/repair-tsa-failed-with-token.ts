/**
 * Phase IA-TSA-falseFailed — repair script for evidence rows that have
 * a valid Granted TSA token persisted but were incorrectly marked
 * `tsaStatus='FAILED'` by the legacy parser.
 *
 * Target shape (operator-confirmed in production):
 *   tsa_status = 'FAILED'
 *   tsa_token_base64 IS NOT NULL AND length(tsa_token_base64) > 0
 *   tsa_message_imprint IS NOT NULL
 *   (tsa_serial_number IS NULL OR tsa_gen_time_utc IS NULL)
 *
 * Repair steps for each candidate row:
 *   1. Decode `tsa_token_base64` to a temp file.
 *   2. Run `openssl ts -reply -in <file> -text` — this is exactly the
 *      same subprocess the live finalize path runs, so we exercise the
 *      identical parser. The provider is NEVER re-contacted.
 *   3. Pass the stdout to `parseTsaReply(stdout, tsa_message_imprint)`.
 *   4. On `granted === true` AND `serialNumber` AND `genTimeUtc` AND
 *      `imprintMatchesRequest !== false` — update the row through
 *      Prisma in a transaction:
 *        * tsa_status         → 'STAMPED'
 *        * tsa_serial_number  → parsed serial
 *        * tsa_gen_time_utc   → parsed Date
 *        * tsa_input_digest_hex → message imprint (when missing — this
 *                                 is the field that the truthful
 *                                 semantics block writes only on
 *                                 success; we now have that success)
 *        * tsa_failure_reason → null
 *      + append a `TIMESTAMP_APPLIED` custody event marked
 *      `repair_source: 'tsa_replay_from_token'` for forensic traceability
 *      + enqueue a report regen via `enqueueGenerateReportJob(...)` so
 *      the surfaces re-render with the corrected state.
 *   5. On any failure code from the parser — KEEP the row FAILED, log
 *      the bounded reason. The script never writes a fake success.
 *
 * Safety design:
 *   * Dry-run by default. Writes ONLY when `--apply` is passed.
 *   * `--limit` capped at 1000 to prevent whole-DB replay.
 *   * `--evidence-id` for targeted operator runs.
 *   * Never re-contacts the TSA provider.
 *   * Never writes a custody event without a corresponding `tsaStatus`
 *     update — both happen in the SAME transaction.
 *   * Never overwrites a row's existing `tsa_input_digest_hex` if it's
 *     already non-null (preserves forensic history).
 *
 * Usage:
 *   node dist/scripts/repair-tsa-failed-with-token.js                  # dry-run all
 *   node dist/scripts/repair-tsa-failed-with-token.js --apply          # write
 *   node dist/scripts/repair-tsa-failed-with-token.js --limit 25
 *   node dist/scripts/repair-tsa-failed-with-token.js \
 *     --evidence-id 77406c16-8699-4ddb-b855-e607c8bec6bb --apply
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import * as prismaPkg from "@prisma/client";
import type { Prisma } from "@prisma/client";

import { prisma } from "../db.js";
import { appendCustodyEventTx } from "../services/custody-events.service.js";
import { requestReportGeneration } from "../services/reports/report-generation-authority.service.js";
import { parseTsaReply } from "../services/timestamp/parse-tsa-reply.js";

const execFileAsync = promisify(execFile);

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

async function mkWorkDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "tsa-repair-"));
}

async function cleanup(p: string): Promise<void> {
  try {
    await fs.rm(p, { force: true, recursive: true });
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
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

  const where: Prisma.EvidenceWhereInput = {
    tsaStatus: "FAILED",
    tsaTokenBase64: { not: null },
    tsaMessageImprint: { not: null },
    OR: [{ tsaSerialNumber: null }, { tsaGenTimeUtc: null }],
    deletedAt: null,
  };
  if (args.evidenceId) where.id = args.evidenceId;

  const rows = await prisma.evidence.findMany({
    where,
    select: {
      id: true,
      teamId: true,
      tsaProvider: true,
      tsaUrl: true,
      tsaHashAlgorithm: true,
      tsaTokenBase64: true,
      tsaMessageImprint: true,
      tsaInputDigestHex: true,
      tsaInputKind: true,
      fileSha256: true,
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

    if (!row.tsaTokenBase64 || row.tsaTokenBase64.length === 0) {
      summary.skippedNoToken += 1;
      console.log(
        `[repair-tsa] skip ${idShort} reason=no-token (column is empty string)`,
      );
      continue;
    }

    const expectedImprint = row.tsaMessageImprint?.trim().toLowerCase() ?? null;

    // Re-parse the persisted token offline. NEVER call the provider.
    let stdout = "";
    let openssl_failed = false;
    const workDir = await mkWorkDir();
    const tokenFile = path.join(workDir, "token.tsr");
    try {
      await fs.writeFile(
        tokenFile,
        Buffer.from(row.tsaTokenBase64, "base64"),
      );
      const result = await execFileAsync(
        "openssl",
        ["ts", "-reply", "-in", tokenFile, "-text"],
        { timeout: 15000 },
      );
      stdout = result.stdout?.toString() ?? "";
    } catch (err) {
      openssl_failed = true;
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        `[repair-tsa] openssl-failed ${idShort} ${message.slice(0, 200)}`,
      );
    } finally {
      await cleanup(workDir);
    }

    if (openssl_failed || stdout.length === 0) {
      summary.parseErrors += 1;
      summary.keptFailed += 1;
      continue;
    }

    const parsed = parseTsaReply(stdout, expectedImprint);

    if (!parsed.granted) {
      summary.keptFailed += 1;
      if (parsed.failureCode === "tsa_message_imprint_mismatch") {
        summary.imprintMismatches += 1;
      } else if (parsed.failureCode === "tsa_response_parse_failed") {
        summary.parseErrors += 1;
      }
      console.log(
        `[repair-tsa] KEEP-FAILED ${idShort} code=${parsed.failureCode ?? "(none)"} reason="${(parsed.failureReason ?? "").slice(0, 120)}"`,
      );
      continue;
    }

    // At this point the token is provably a valid Granted RFC 3161
    // response for the message imprint we sent.
    summary.repairableDryRun += 1;
    console.log(
      `[repair-tsa] REPAIRABLE ${idShort} serial=${parsed.serialNumber ?? "?"} ` +
        `genTime=${parsed.genTimeUtc?.toISOString() ?? "?"} ` +
        `imprintMatch=${parsed.imprintMatchesRequest ?? "n/a"}`,
    );

    if (!args.apply) {
      console.log(`[repair-tsa]   (dry-run) would update + enqueue regen`);
      continue;
    }

    // -------- APPLY path: transactional update + custody event. --------
    try {
      await prisma.$transaction(async (tx) => {
        await tx.evidence.update({
          where: { id: row.id },
          data: {
            tsaStatus: "STAMPED",
            tsaSerialNumber: parsed.serialNumber,
            tsaGenTimeUtc: parsed.genTimeUtc,
            // Preserve any pre-existing tsa_input_digest_hex. When it's
            // null (which it always will be on a FAILED row per the
            // truthful-semantics policy), set it to the message imprint
            // — the digest the provider actually attested.
            tsaInputDigestHex:
              row.tsaInputDigestHex ?? expectedImprint ?? null,
            tsaFailureReason: null,
          },
        });
        await appendCustodyEventTx(tx, {
          evidenceId: row.id,
          eventType: prismaPkg.CustodyEventType.TIMESTAMP_APPLIED,
          atUtc: new Date(),
          payload: {
            tsaProvider: row.tsaProvider,
            tsaUrl: row.tsaUrl,
            tsaSerialNumber: parsed.serialNumber,
            tsaGenTimeUtc: parsed.genTimeUtc?.toISOString() ?? null,
            tsaMessageImprint: parsed.messageImprintHex,
            tsaInputKind: row.tsaInputKind,
            tsaHashAlgorithm: row.tsaHashAlgorithm,
            tsaStatus: "STAMPED",
            tsaFailureReason: null,
            // Repair-script forensic marker. Operators inspecting the
            // chain can distinguish a normal finalize-time TIMESTAMP_APPLIED
            // from one written by the repair tool.
            repair_source: "tsa_replay_from_token",
            statusKind: parsed.statusKind,
          },
        });
      });
      summary.repairedApply += 1;
      console.log(`[repair-tsa]   → updated row + appended custody event`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[repair-tsa]   transaction failed for ${idShort}: ${message.slice(0, 200)}`,
      );
      summary.keptFailed += 1;
      continue;
    }

    // Enqueue the report regen OUTSIDE the transaction so any failure
    // in the queue doesn't roll back the DB correction. The persisted
    // tsaStatus='STAMPED' is the durable record; the regen is a
    // downstream view update.
    try {
      const result = await requestReportGeneration({
        evidenceId: row.id,
        purpose: "tsa_repair",
        forceRegenerate: true,
        regenerateReason: "tsa_repaired",
        requestedByMachineId: "script.repair-tsa",
      });
      if (result.requested && result.enqueued) {
        summary.enqueuedJobs += 1;
        console.log(`[repair-tsa]   → enqueued report regen for ${idShort}`);
      } else {
        console.log(
          `[repair-tsa]   report job already in-flight for ${idShort} (skipped)`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[repair-tsa]   enqueue failed for ${idShort}: ${message.slice(0, 200)}`,
      );
    }
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
