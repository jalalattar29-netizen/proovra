/**
 * FINAL-VERIFY-7 / LEGACY-A..D — READ-ONLY inventory of rows pointing at the
 * legacy bucket `proovra-prod-assets` (Cloudflare R2). No write mode.
 *
 *   node dist/scripts/legacy-bucket-inventory.js [--bucket=proovra-prod-assets] [--objects] [--summary]
 *
 * Prints one JSON document:
 *   - summary: records by class (A soft-deleted / B live team-bound / C live
 *     team-less), sealed vs unsealed, with report / package / derived assets,
 *     under legal hold / retention / object lock, and the records the capture
 *     reaper's released-objects path retries every run;
 *   - records: one row per evidence record (ids, states and counts only; no
 *     title, no person);
 *   - bucketTimeline: which bucket records were created in, and when;
 *   - with --objects: every object the rows expect (table, row id, key, size,
 *     whether a SHA-256 is recorded) — the input of legacy-bucket-object-locator.
 * --summary drops the per-record rows and objects.
 *
 * Every statement runs inside `SET TRANSACTION READ ONLY`; write-like flags are
 * refused. It never contacts an object store.
 */
import { pathToFileURL } from "node:url";

import type { PrismaClient } from "@prisma/client";

import {
  LEGACY_BUCKET,
  bucketTimeline,
  collectExpectedObjects,
  collectLegacyRecords,
  type LegacyRecord,
} from "../services/ops/legacy-bucket-inventory.js";

const KNOWN = new Set(["bucket", "objects", "summary"]);
const REFUSED = ["apply", "write", "fix", "repoint", "delete", "mark", "execute", "copy"];

export type LegacyInventoryIo = { argv: string[]; client: PrismaClient; out: (s: string) => void; err: (s: string) => void };

function tally(records: LegacyRecord[]) {
  const by = (f: (r: LegacyRecord) => string) => {
    const o: Record<string, number> = {};
    for (const r of records) o[f(r)] = (o[f(r)] ?? 0) + 1;
    return o;
  };
  return {
    records: records.length,
    byClass: by((r) => r.class),
    byClassAndStatus: by((r) => `${r.class}:${r.status}`),
    sealed: records.filter((r) => r.sealed).length,
    unsealed: records.filter((r) => !r.sealed).length,
    withReportInLegacyBucket: records.filter((r) => r.reportsInLegacyBucket > 0).length,
    withAnyVerificationPackage: records.filter((r) => r.verificationPackages > 0).length,
    withPackageInLegacyBucket: records.filter((r) => r.verificationPackagesInLegacyBucket > 0).length,
    withDerivedAssetsInLegacyBucket: records.filter((r) => r.derivedAssetsInLegacyBucket > 0).length,
    withActiveLegalHold: records.filter((r) => r.activeLegalHolds > 0).length,
    withRetentionUntil: records.filter((r) => r.retentionUntilUtc !== null).length,
    withObjectLockMode: records.filter((r) => r.objectLockMode !== null).length,
    captureReaperRetries: records.filter((r) => r.captureReaperRetries).length,
    captureReaperRetriesIds: records.filter((r) => r.captureReaperRetries).map((r) => r.evidenceId),
    lifecycleStates: by((r) => r.lifecycleState),
  };
}

export async function runLegacyBucketInventoryCli(io: LegacyInventoryIo): Promise<number> {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const a of io.argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (m && REFUSED.includes(m[1]!)) {
      io.err(`refused: --${m[1]} is not supported: this inventory is read-only and has no write mode.\n`);
      return 2;
    }
    if (!m || !KNOWN.has(m[1]!)) {
      io.err(`refused: unknown argument ${a.split("=")[0]}\n`);
      return 2;
    }
    if (m[2] === undefined) flags.add(m[1]!);
    else values.set(m[1]!, m[2]);
  }
  const bucket = values.get("bucket") ?? LEGACY_BUCKET;
  const records = await collectLegacyRecords(io.client, bucket);
  const objects = flags.has("objects") && !flags.has("summary") ? await collectExpectedObjects(io.client, bucket) : null;
  const doc = {
    script: "legacy-bucket-inventory",
    readOnly: true,
    bucket,
    summary: tally(records),
    bucketTimeline: await bucketTimeline(io.client),
    ...(flags.has("summary") ? {} : { records }),
    ...(objects
      ? {
          expectedObjects: objects.map((o) => ({ ...o, sha256: undefined, hasSha256: o.sha256 !== null })),
          expectedObjectsByTable: objects.reduce<Record<string, number>>((a, o) => ((a[o.table] = (a[o.table] ?? 0) + 1), a), {}),
        }
      : {}),
    notes: [
      "A row's bucket NAME is the only location it stores; production resolves every bucket against one global S3 endpoint (S3_ENDPOINT).",
      "captureReaperRetries = the rows removeReleasedReservationObjects selects every run; with the AWS endpoint they fail NoSuchBucket and nothing is deleted.",
    ],
  };
  io.out(`${JSON.stringify(doc, null, 2)}\n`);
  return 0;
}

async function main(): Promise<void> {
  await import("../env.js");
  const { prisma } = await import("../db.js");
  try {
    process.exitCode = await runLegacyBucketInventoryCli({
      argv: process.argv.slice(2),
      client: prisma,
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    });
  } catch (err) {
    process.stderr.write(`legacy-bucket-inventory failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
