/**
 * PRO-G2-01 — EXACT ACCESS-PATH INVENTORY of the CROSS_PARTY packages.
 * READ-ONLY. RESTRICTED OUTPUT (ids, email domains, local-part HMACs).
 *
 *   node dist/scripts/trust-exposure-access-paths.js [--summary]
 *
 *   EXPOSURE_INVENTORY_HASH_SALT=<secret, optional, >= 16 chars> keys the HMAC of
 *   reviewer / owner local parts (random per run without it). Never printed.
 *
 * Per affected CROSS_PARTY package (window: the defect's lifetime, as the holder
 * inventory): every distinct LIVE share-link record (id, purpose and family,
 * created, expires, uses / max uses, revocable yes/no and why, the creating
 * workspace and whether it is the holder, the record it is attached to and the
 * packages that share that record), every external-review grant covering the
 * record (EVIDENCE, PACKAGE or CASE scope), the recipient-ownership
 * classification, and the download counts with their meaning. The summary
 * gives distinct live link records, affected packages, the links-per-package
 * and packages-per-link distributions, and grants.
 *
 * NEVER PRINTED: a token, a token hash, a view-session hash, a URL, a reviewer
 * address or an audience label. The serialised report is scanned against every
 * secret value read and against bearer shapes; on a hit nothing is printed and
 * the exit code is 1. Write-like flags are refused (exit 2).
 */
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

import type { PrismaClient } from "@prisma/client";

import { DOWNLOAD_MEANING, collectCrossPartyAccessInventory, guardedJson } from "../services/trust/g2-01-cross-party-access.js";

const KNOWN = new Set(["summary"]);
const REFUSED = ["apply", "write", "fix", "execute", "notify", "revoke", "reissue", "send", "contain"];

export type AccessPathsCliIo = {
  argv: string[];
  env: Record<string, string | undefined>;
  client: PrismaClient;
  out: (s: string) => void;
  err: (s: string) => void;
  now?: Date;
};

export async function runTrustExposureAccessPathsCli(io: AccessPathsCliIo): Promise<number> {
  const flags = new Set<string>();
  for (const a of io.argv) {
    const m = /^--([a-z-]+)$/.exec(a);
    const name = m?.[1] ?? a.split("=")[0]!.replace(/^--/, "");
    if (REFUSED.includes(name)) {
      io.err(`refused: --${name} is not supported: this inventory is read-only (containment: contain-cross-party-share-links).\n`);
      return 2;
    }
    if (!m || !KNOWN.has(name)) {
      io.err(`refused: unknown argument ${a.split("=")[0]}\n`);
      return 2;
    }
    flags.add(name);
  }
  const salted = (io.env.EXPOSURE_INVENTORY_HASH_SALT ?? "").length >= 16;
  const inv = await collectCrossPartyAccessInventory(io.client, {
    hashSalt: salted ? io.env.EXPOSURE_INVENTORY_HASH_SALT! : randomBytes(32).toString("hex"),
    now: io.now,
  });
  const { secrets, links, grants, packages, ...head } = inv;
  const doc = {
    script: "trust-exposure-access-paths",
    classification: flags.has("summary") ? "SUMMARY_COUNTS_ONLY" : "RESTRICTED",
    localPartHashKey: salted ? "operator-supplied" : "random-per-run",
    ...head,
    ...(flags.has("summary") ? {} : { links, grants, packages }),
    downloadMeaning: DOWNLOAD_MEANING,
    limits: [
      "the CROSS_PARTY package set is the holder inventory's (database-inferred replay); artifact contents are answered only by trust-manifest-sample-inspection",
      "a share link opens the record's public verify page (integrity metadata), never the package ZIP or its trust manifests",
      "CASE-scope grants are matched on every case link (a superset of the portal's restricted-case refinement)",
    ],
  };
  const text = guardedJson(doc, secrets);
  if (text === null) {
    io.err("refused: the report would contain token, hash, address or URL material; nothing was printed\n");
    return 1;
  }
  io.out(text);
  return 0;
}

async function main(): Promise<void> {
  await import("../env.js");
  const { prisma } = await import("../db.js");
  try {
    process.exitCode = await runTrustExposureAccessPathsCli({
      argv: process.argv.slice(2),
      env: process.env,
      client: prisma,
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    });
  } catch (err) {
    process.stderr.write(`trust-exposure-access-paths failed: ${err instanceof Error ? err.name : "error"}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
