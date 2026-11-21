/**
 * FINAL-VERIFY-7 / LEGACY-A..D — CANDIDATE-OBJECT LOCATOR for the legacy
 * bucket on Cloudflare R2. READ-ONLY: HeadObject and GetObject only.
 *
 *   LEGACY_R2_ACCOUNT_ID=<account id> \
 *   LEGACY_R2_ACCESS_KEY_ID=<scoped READ-ONLY R2 token key id> \
 *   LEGACY_R2_SECRET_ACCESS_KEY=<its secret> \
 *   node dist/scripts/legacy-bucket-object-locator.js [--bucket=proovra-prod-assets] [--no-hash] [--max-hash-bytes=<n>]
 *
 * Endpoint: https://<account>.r2.cloudflarestorage.com, region "auto",
 * path-style addressing. (`LEGACY_S3_ENDPOINT` replaces the derived endpoint;
 * it must be https unless it is a loopback test store.) The credentials are
 * read from the environment, used for this process only and never printed;
 * error output names the error class only.
 *
 * For each database row that expects an object in the bucket (see
 * legacy-bucket-inventory --objects) it HEADs the EXACT stored key (and the
 * recorded version, when the row has one), compares the size, and — unless
 * --no-hash, or the object is larger than --max-hash-bytes — streams the
 * object through SHA-256 and compares it with the SHA-256 the database
 * recorded for those bytes. R2 ETags are MD5 only for single-part uploads, so
 * an ETag is reported but never used as identity.
 *
 * Output: one JSON document with a per-row match table. Nothing is written:
 * no row, no object, no copy, no pointer change.
 *
 * Outcomes: MATCH_SHA256 · SIZE_MATCH_SHA256_MISMATCH · SIZE_MISMATCH ·
 * SIZE_MATCH_NO_DB_SHA256 (the row records no hash of these bytes) ·
 * SIZE_MATCH_HASH_SKIPPED · NOT_FOUND · ACCESS_DENIED · ERROR.
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { PrismaClient } from "@prisma/client";

import { LEGACY_BUCKET, collectExpectedObjects, type ExpectedObject } from "../services/ops/legacy-bucket-inventory.js";

const KNOWN = new Set(["bucket", "no-hash", "max-hash-bytes"]);
const REFUSED = ["apply", "write", "fix", "repoint", "delete", "copy", "put", "mark", "execute"];

export type LocatorOutcome =
  | "MATCH_SHA256"
  | "SIZE_MATCH_SHA256_MISMATCH"
  | "SIZE_MISMATCH"
  | "SIZE_MATCH_NO_DB_SHA256"
  | "SIZE_MATCH_HASH_SKIPPED"
  | "NOT_FOUND"
  | "ACCESS_DENIED"
  | "ERROR";

/** The only two operations the locator can perform. */
export type ReadOnlyObjectStore = {
  head: (p: { bucket: string; key: string; versionId: string | null }) => Promise<{ sizeBytes: number | null; etag: string | null }>;
  sha256: (p: { bucket: string; key: string; versionId: string | null }) => Promise<string>;
};

export type LocatorIo = {
  argv: string[];
  env: Record<string, string | undefined>;
  client: PrismaClient;
  /** Injected in tests; built from the env otherwise. */
  store?: ReadOnlyObjectStore;
  out: (s: string) => void;
  err: (s: string) => void;
};

export function resolveLegacyEndpoint(env: Record<string, string | undefined>): string {
  const explicit = env.LEGACY_S3_ENDPOINT?.trim();
  if (explicit) {
    const u = new URL(explicit);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !loopback) throw new Error("LEGACY_S3_ENDPOINT must be https");
    return explicit;
  }
  const account = env.LEGACY_R2_ACCOUNT_ID?.trim() ?? "";
  if (!/^[0-9a-f]{32}$/.test(account)) throw new Error("LEGACY_R2_ACCOUNT_ID must be the 32-hex Cloudflare account id");
  return `https://${account}.r2.cloudflarestorage.com`;
}

export function buildReadOnlyR2Store(env: Record<string, string | undefined>): ReadOnlyObjectStore {
  const accessKeyId = env.LEGACY_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.LEGACY_R2_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) throw new Error("LEGACY_R2_ACCESS_KEY_ID and LEGACY_R2_SECRET_ACCESS_KEY are required");
  const s3 = new S3Client({
    endpoint: resolveLegacyEndpoint(env),
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return {
    head: async ({ bucket, key, versionId }) => {
      const r = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }));
      return { sizeBytes: r.ContentLength ?? null, etag: r.ETag ? r.ETag.replace(/"/g, "") : null };
    },
    sha256: async ({ bucket, key, versionId }) => {
      const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }));
      const h = createHash("sha256");
      for await (const chunk of r.Body as AsyncIterable<Uint8Array>) h.update(chunk);
      return h.digest("hex");
    },
  };
}

function classifyError(e: unknown): LocatorOutcome {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  const status = err?.$metadata?.httpStatusCode;
  if (err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.name === "NoSuchVersion" || status === 404) return "NOT_FOUND";
  if (err?.name === "AccessDenied" || err?.name === "Forbidden" || status === 403 || status === 401) return "ACCESS_DENIED";
  return "ERROR";
}

export type LocatorRow = {
  table: ExpectedObject["table"];
  rowId: string;
  evidenceId: string;
  key: string;
  dbSizeBytes: number | null;
  objectSizeBytes: number | null;
  sha256Basis: string;
  etag: string | null;
  outcome: LocatorOutcome;
  errorName?: string;
};

export async function locateLegacyObjects(
  expected: ExpectedObject[],
  store: ReadOnlyObjectStore,
  opts: { hash: boolean; maxHashBytes: number },
): Promise<LocatorRow[]> {
  const out: LocatorRow[] = [];
  for (const o of expected) {
    const base = { table: o.table, rowId: o.rowId, evidenceId: o.evidenceId, key: o.key, dbSizeBytes: o.sizeBytes, sha256Basis: o.sha256Basis };
    let head: { sizeBytes: number | null; etag: string | null };
    try {
      head = await store.head({ bucket: o.bucket, key: o.key, versionId: o.versionId });
    } catch (e) {
      out.push({ ...base, objectSizeBytes: null, etag: null, outcome: classifyError(e), errorName: (e as Error)?.name ?? "error" });
      continue;
    }
    const row = { ...base, objectSizeBytes: head.sizeBytes, etag: head.etag };
    if (o.sizeBytes !== null && head.sizeBytes !== o.sizeBytes) {
      out.push({ ...row, outcome: "SIZE_MISMATCH" });
      continue;
    }
    if (!o.sha256) {
      out.push({ ...row, outcome: "SIZE_MATCH_NO_DB_SHA256" });
      continue;
    }
    if (!opts.hash || (head.sizeBytes ?? 0) > opts.maxHashBytes) {
      out.push({ ...row, outcome: "SIZE_MATCH_HASH_SKIPPED" });
      continue;
    }
    try {
      const sha = await store.sha256({ bucket: o.bucket, key: o.key, versionId: o.versionId });
      out.push({ ...row, outcome: sha === o.sha256 ? "MATCH_SHA256" : "SIZE_MATCH_SHA256_MISMATCH" });
    } catch (e) {
      out.push({ ...row, outcome: classifyError(e), errorName: (e as Error)?.name ?? "error" });
    }
  }
  return out;
}

export async function runLegacyBucketObjectLocatorCli(io: LocatorIo): Promise<number> {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const a of io.argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (m && REFUSED.includes(m[1]!)) {
      io.err(`refused: --${m[1]} is not supported: the locator only reads (HEAD / GET).\n`);
      return 2;
    }
    if (!m || !KNOWN.has(m[1]!)) {
      io.err(`refused: unknown argument ${a.split("=")[0]}\n`);
      return 2;
    }
    if (m[2] === undefined) flags.add(m[1]!);
    else values.set(m[1]!, m[2]);
  }
  const maxRaw = values.get("max-hash-bytes");
  if (maxRaw !== undefined && !/^\d+$/.test(maxRaw)) {
    io.err("refused: --max-hash-bytes must be a whole number of bytes\n");
    return 2;
  }
  let store: ReadOnlyObjectStore;
  try {
    store = io.store ?? buildReadOnlyR2Store(io.env);
  } catch (e) {
    io.err(`refused: ${(e as Error).message}\n`);
    return 2;
  }
  const bucket = values.get("bucket") ?? LEGACY_BUCKET;
  const expected = await collectExpectedObjects(io.client, bucket);
  const rows = await locateLegacyObjects(expected, store, {
    hash: !flags.has("no-hash"),
    maxHashBytes: maxRaw !== undefined ? Number(maxRaw) : Number.MAX_SAFE_INTEGER,
  });
  const byOutcome: Record<string, number> = {};
  const byTableOutcome: Record<string, number> = {};
  for (const r of rows) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    byTableOutcome[`${r.table}:${r.outcome}`] = (byTableOutcome[`${r.table}:${r.outcome}`] ?? 0) + 1;
  }
  io.out(
    `${JSON.stringify(
      {
        script: "legacy-bucket-object-locator",
        readOnly: true,
        bucket,
        endpointKind: io.env.LEGACY_S3_ENDPOINT ? "explicit" : "cloudflare-r2",
        expectedObjects: rows.length,
        byOutcome,
        byTableOutcome,
        rows,
        note: "MATCH_SHA256 is the only identity proof. ETag is informative (MD5 only for single-part uploads).",
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

async function main(): Promise<void> {
  await import("../env.js");
  const { prisma } = await import("../db.js");
  try {
    process.exitCode = await runLegacyBucketObjectLocatorCli({
      argv: process.argv.slice(2),
      env: process.env,
      client: prisma,
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    });
  } catch (err) {
    process.stderr.write(`legacy-bucket-object-locator failed: ${err instanceof Error ? err.name : "error"}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
