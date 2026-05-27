#!/usr/bin/env node
/**
 * Phase A0 — Historic integrity-survivor diagnostic.
 *
 * READ-ONLY. This script never mutates evidence. It identifies rows
 * that pre-date the Phase A0 hard-gate and may have reached SIGNED /
 * REPORTED with a hash that does not match the server-side
 * recomputation. Three output modes:
 *
 *   * `--list-suspects` (default)
 *       Lists every SIGNED / REPORTED Evidence row WITHOUT
 *       recomputing the SHA-256. This is a cheap query — useful
 *       to size the population before deciding a remediation
 *       strategy.
 *
 *   * `--recompute-sample N`
 *       For a bounded sample of N rows (default 50, max 500),
 *       streams the stored object(s) from S3, recomputes the
 *       canonical fileSha256 the same way `evidence-complete.service`
 *       did at completion, and compares to the persisted value.
 *       Reports `match` / `mismatch` / `read_error`. NO database
 *       writes; NO custody events appended.
 *
 *   * `--export-csv <path>`
 *       Writes the suspect list (or sampled recompute results) to a
 *       CSV the operator can take to an incident review.
 *
 * Hard rules:
 *   * Never mutates Evidence, CustodyEvent, Report, or any other
 *     table.
 *   * Never enqueues a worker job.
 *   * Bounded queries (`take` caps). No streaming the full table.
 *   * Refuses to run unless DATABASE_URL is set; refuses on a
 *     production host unless `INTEGRITY_DIAGNOSTIC_ALLOW_REMOTE=1`
 *     is set explicitly.
 *
 * Remediation strategy (operator-side, NOT this script):
 *
 *   When this script identifies a real mismatch, the runbook at
 *   `docs/operations/integrity-survivors-runbook.md` describes the
 *   four bounded responses an operator may choose:
 *
 *     a) flag-only          (default; require human review)
 *     b) soft quarantine    (admin-only; sets a non-public flag)
 *     c) report invalidation (admin-only; new Report version with
 *                            a withdrawal entry — the original is
 *                            preserved)
 *     d) manual review queue (admin assigns to a reviewer who
 *                            decides per row)
 *
 *   THIS SCRIPT DOES NOT PERFORM ANY OF THESE ACTIONS. It only
 *   produces the evidence the operator needs to choose.
 *
 * Usage:
 *
 *   node scripts/identify-integrity-survivors.mjs --list-suspects
 *   node scripts/identify-integrity-survivors.mjs --recompute-sample 100
 *   node scripts/identify-integrity-survivors.mjs --recompute-sample 50 \
 *     --export-csv ./tmp/integrity-survivors.csv
 */

import { createHash } from "node:crypto";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);

function getFlagValue(name, fallback = null) {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return fallback;
  return args[idx + 1] ?? fallback;
}

function hasFlag(name) {
  return args.includes(`--${name}`);
}

const mode = hasFlag("recompute-sample")
  ? "recompute"
  : hasFlag("list-suspects")
    ? "list"
    : "list";

const sampleLimitRaw = getFlagValue("recompute-sample", "50");
const sampleLimit = Math.min(
  500,
  Math.max(1, Number.parseInt(sampleLimitRaw, 10) || 50),
);

const exportCsvPath = getFlagValue("export-csv", null);
const allowRemote = process.env.INTEGRITY_DIAGNOSTIC_ALLOW_REMOTE === "1";

const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
if (!databaseUrl) {
  console.error(
    "[integrity-survivors] REFUSED: DATABASE_URL is not set. Diagnostic refuses to run.",
  );
  process.exit(2);
}

function parseHost(url) {
  try {
    const parsed = new URL(url);
    return parsed.host.toLowerCase();
  } catch {
    return "(unparseable)";
  }
}

const host = parseHost(databaseUrl);
const isLocal =
  host.startsWith("localhost") ||
  host.startsWith("127.0.0.1") ||
  host.startsWith("::1") ||
  host.includes("host.docker.internal") ||
  host.startsWith("postgres:");

if (!isLocal && !allowRemote) {
  console.error(
    "[integrity-survivors] REFUSED: DATABASE_URL host appears non-local " +
      `("${host}"). To run against a non-local target, set ` +
      "INTEGRITY_DIAGNOSTIC_ALLOW_REMOTE=1 explicitly.",
  );
  process.exit(3);
}

process.stderr.write("\n");
process.stderr.write(
  "──────────────────────────────────────────────────────────\n",
);
process.stderr.write("  PROOVRA integrity survivors diagnostic (Phase A0)\n");
process.stderr.write(
  "──────────────────────────────────────────────────────────\n",
);
process.stderr.write(`  mode      : ${mode}\n`);
process.stderr.write(`  host      : ${host}\n`);
process.stderr.write(`  sample    : ${mode === "recompute" ? sampleLimit : "n/a"}\n`);
process.stderr.write(`  export    : ${exportCsvPath ?? "(stdout)"}\n`);
process.stderr.write(
  "──────────────────────────────────────────────────────────\n\n",
);

// Lazy-load Prisma so the refusal paths above never spin up a client
// against a remote DB.
const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();

try {
  if (mode === "list") {
    const suspects = await prisma.evidence.findMany({
      where: {
        deletedAt: null,
        status: { in: ["SIGNED", "REPORTED"] },
        fileSha256: { not: null },
      },
      select: {
        id: true,
        teamId: true,
        organizationId: true,
        status: true,
        verificationStatus: true,
        fileSha256: true,
        hashSemantics: true,
        latestReportVersion: true,
        verificationPackageVersion: true,
        createdAt: true,
        signedAtUtc: true,
        reportGeneratedAtUtc: true,
      },
      orderBy: { signedAtUtc: "desc" },
      take: 10_000,
    });

    process.stderr.write(
      `[integrity-survivors] found ${suspects.length} suspect rows ` +
        "(SIGNED / REPORTED with fileSha256 set). " +
        "Run --recompute-sample to verify against stored bytes.\n\n",
    );

    if (exportCsvPath) {
      const dir = dirname(exportCsvPath);
      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const rows = [
        [
          "evidenceId",
          "teamId",
          "organizationId",
          "status",
          "verificationStatus",
          "fileSha256",
          "hashSemantics",
          "latestReportVersion",
          "verificationPackageVersion",
          "createdAt",
          "signedAtUtc",
          "reportGeneratedAtUtc",
        ].join(","),
        ...suspects.map((row) =>
          [
            row.id,
            row.teamId ?? "",
            row.organizationId ?? "",
            row.status,
            row.verificationStatus ?? "",
            row.fileSha256 ?? "",
            row.hashSemantics ?? "",
            row.latestReportVersion ?? "",
            row.verificationPackageVersion ?? "",
            row.createdAt?.toISOString() ?? "",
            row.signedAtUtc?.toISOString() ?? "",
            row.reportGeneratedAtUtc?.toISOString() ?? "",
          ].join(","),
        ),
      ].join("\n");
      writeFileSync(exportCsvPath, `${rows}\n`, "utf8");
      process.stderr.write(`[integrity-survivors] wrote ${exportCsvPath}\n`);
    } else {
      for (const row of suspects.slice(0, 50)) {
        process.stdout.write(
          `${row.id}\t${row.status}\t${row.fileSha256?.slice(0, 16) ?? "(null)"}\t${row.signedAtUtc?.toISOString() ?? ""}\n`,
        );
      }
      if (suspects.length > 50) {
        process.stderr.write(
          `[integrity-survivors] (truncated; rerun with --export-csv to see all ${suspects.length} rows)\n`,
        );
      }
    }
  } else {
    // recompute mode — bounded sample. Reads S3 streams; this is
    // intentionally slow. The script does NOT recompute the entire
    // population; that is an operator decision documented in the
    // runbook.
    const sample = await prisma.evidence.findMany({
      where: {
        deletedAt: null,
        status: { in: ["SIGNED", "REPORTED"] },
        fileSha256: { not: null },
      },
      select: {
        id: true,
        teamId: true,
        fileSha256: true,
        hashSemantics: true,
        storageBucket: true,
        storageKey: true,
      },
      orderBy: { signedAtUtc: "desc" },
      take: sampleLimit,
    });

    process.stderr.write(
      `[integrity-survivors] sampled ${sample.length} of N (limit=${sampleLimit}). ` +
        "Recomputing single-file SHA-256 only — multipart records are " +
        "flagged 'multipart_skipped' and require the worker's part-level " +
        "logic to verify.\n\n",
    );

    process.stdout.write(
      "evidenceId,teamId,status,result,storedSha256Preview,computedSha256Preview\n",
    );

    let matched = 0;
    let mismatched = 0;
    let skipped = 0;
    let errored = 0;

    for (const row of sample) {
      if (row.hashSemantics === "multipart_composite") {
        process.stdout.write(
          `${row.id},${row.teamId ?? ""},sample,multipart_skipped,${row.fileSha256?.slice(0, 12) ?? ""},\n`,
        );
        skipped += 1;
        continue;
      }
      if (!row.storageBucket || !row.storageKey) {
        process.stdout.write(
          `${row.id},${row.teamId ?? ""},sample,no_storage_key,${row.fileSha256?.slice(0, 12) ?? ""},\n`,
        );
        skipped += 1;
        continue;
      }

      try {
        // Lazy-load the storage module so the script does not require
        // S3 credentials when running --list-suspects only.
        const storage = await import("../src/storage.js");
        const stream = await storage.getObjectStream({
          bucket: row.storageBucket,
          key: row.storageKey,
        });
        const sha = createHash("sha256");
        for await (const chunk of stream) {
          sha.update(chunk);
        }
        const computed = sha.digest("hex");
        if (computed === row.fileSha256) {
          matched += 1;
          process.stdout.write(
            `${row.id},${row.teamId ?? ""},sample,match,${row.fileSha256?.slice(0, 12) ?? ""},${computed.slice(0, 12)}\n`,
          );
        } else {
          mismatched += 1;
          process.stdout.write(
            `${row.id},${row.teamId ?? ""},sample,MISMATCH,${row.fileSha256?.slice(0, 12) ?? ""},${computed.slice(0, 12)}\n`,
          );
        }
      } catch (err) {
        errored += 1;
        process.stdout.write(
          `${row.id},${row.teamId ?? ""},sample,read_error,${row.fileSha256?.slice(0, 12) ?? ""},\n`,
        );
        process.stderr.write(
          `[integrity-survivors] ${row.id} read_error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    process.stderr.write(
      `\n[integrity-survivors] sample summary: match=${matched} mismatch=${mismatched} skipped=${skipped} errored=${errored}\n`,
    );
    if (mismatched > 0) {
      process.stderr.write(
        "[integrity-survivors] One or more mismatches found in the sample. " +
          "DO NOT mutate evidence automatically. " +
          "Open docs/operations/integrity-survivors-runbook.md and follow " +
          "the operator-side remediation flow.\n",
      );
    }
  }
} finally {
  await prisma.$disconnect();
}
