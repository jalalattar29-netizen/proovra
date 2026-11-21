/**
 * PRO-G2-01 — RESTRICTED holder / source / access inventory. READ-ONLY.
 *
 *   node dist/scripts/trust-exposure-holder-inventory.js \
 *     [--since=2026-05-31T08:22:50Z] [--until=2026-11-21T02:21:41Z] \
 *     [--operator-domains=proovra.com] [--test-domains=example.com,...] [--summary]
 *
 *   EXPOSURE_INVENTORY_HASH_SALT=<secret, optional> keys the HMAC of email local
 *   parts; without it a random key is drawn per run (hashes then compare only
 *   inside one report). The salt is never printed.
 *
 * Defaults: the window is the defect's lifetime — from commit a386f9c62 (the
 * unscoped builder, 2026-05-31) to the first run of the fixed Worker
 * (2026-11-21T02:21:41Z). Both are overridable.
 *
 * Output: one JSON document on stdout. With `--summary`, counts only (no ids,
 * no domains). Without it the document carries package/record/workspace/user
 * ids, email DOMAINS and local-part HMACs: RESTRICTED — store it with the
 * incident record, never in a delivery bundle. No full email address, article
 * title, subprocessor name or token is ever printed.
 *
 * It writes nothing and has no write mode: every statement runs in a
 * `SET TRANSACTION READ ONLY` transaction, and write-like flags are refused.
 * It does not open any package (artifact contents: see
 * trust-manifest-sample-inspection.ts).
 */
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_OPERATOR_DOMAINS,
  DEFAULT_TEST_DOMAINS,
  G2_01_DEFECT_INTRODUCED_UTC,
  G2_01_FIX_EFFECTIVE_UTC,
  collectTrustExposureHolderInventory,
  type HolderInventory,
} from "../services/trust/trust-exposure-holder-inventory.js";

const KNOWN = new Set(["since", "until", "operator-domains", "test-domains", "summary", "batch", "limit"]);
const REFUSED = ["apply", "write", "fix", "execute", "notify", "revoke", "reissue", "send"];

export type HolderCliIo = {
  argv: string[];
  env: Record<string, string | undefined>;
  out: (s: string) => void;
  err: (s: string) => void;
};

function summaryOnly(inv: HolderInventory) {
  const rest: Partial<HolderInventory> = { ...inv };
  delete rest.packages;
  return rest;
}

export async function runTrustExposureHolderInventoryCli(io: HolderCliIo): Promise<number> {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const a of io.argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    const name = m?.[1] ?? a;
    if (REFUSED.includes(name)) {
      io.err(`refused: --${name} is not supported: this inventory is read-only and has no write mode.\n`);
      return 2;
    }
    if (!m || !KNOWN.has(name)) {
      io.err(`refused: unknown argument ${a.split("=")[0]}\n`);
      return 2;
    }
    if (m[2] === undefined) flags.add(name);
    else values.set(name, m[2]);
  }
  const time = (name: string, fallback: string): Date | null => {
    const raw = values.get(name) ?? fallback;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const since = time("since", G2_01_DEFECT_INTRODUCED_UTC);
  const until = time("until", G2_01_FIX_EFFECTIVE_UTC);
  if (!since || !until || since >= until) {
    io.err("refused: --since and --until must be ISO times with since < until\n");
    return 2;
  }
  const list = (name: string, fallback: readonly string[]) =>
    values.has(name)
      ? values.get(name)!.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)
      : [...fallback];
  const salt = io.env.EXPOSURE_INVENTORY_HASH_SALT && io.env.EXPOSURE_INVENTORY_HASH_SALT.length >= 16
    ? io.env.EXPOSURE_INVENTORY_HASH_SALT
    : randomBytes(32).toString("hex");
  const inv = await collectTrustExposureHolderInventory({
    since,
    until,
    hashSalt: salt,
    operatorDomains: list("operator-domains", DEFAULT_OPERATOR_DOMAINS),
    testDomains: list("test-domains", DEFAULT_TEST_DOMAINS),
    batch: values.has("batch") ? Number(values.get("batch")) : undefined,
    limit: values.has("limit") ? Number(values.get("limit")) : undefined,
  });
  const doc = {
    script: "trust-exposure-holder-inventory",
    classification: flags.has("summary") ? "SUMMARY_COUNTS_ONLY" : "RESTRICTED",
    localPartHashKey: io.env.EXPOSURE_INVENTORY_HASH_SALT && io.env.EXPOSURE_INVENTORY_HASH_SALT.length >= 16 ? "operator-supplied" : "random-per-run",
    ...(flags.has("summary") ? summaryOnly(inv) : inv),
    limits: [
      "database-inferred: replays the old unscoped reads from rows that exist now (hard-deleted rows invisible; withdrawn rows are 'possible'; a moved record is attributed to its current workspace)",
      "downloads are custody records (VERIFICATION_PACKAGE_DOWNLOADED / DOWNLOAD_AUTHORIZED verification_package); a download link issued is not proof a file moved, and a file already downloaded cannot be recalled",
      "what an issued ZIP actually carries is answered only by trust-manifest-sample-inspection",
    ],
  };
  io.out(`${JSON.stringify(doc, null, 2)}\n`);
  return 0;
}

async function main(): Promise<void> {
  await import("../env.js");
  const { prisma } = await import("../db.js");
  try {
    process.exitCode = await runTrustExposureHolderInventoryCli({
      argv: process.argv.slice(2),
      env: process.env,
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    });
  } catch (err) {
    process.stderr.write(`trust-exposure-holder-inventory failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
