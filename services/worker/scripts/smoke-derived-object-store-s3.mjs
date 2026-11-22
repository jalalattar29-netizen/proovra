#!/usr/bin/env node
/**
 * closure3/store (FV2-RESIDUAL-6) — the derived-intent reconciler's object
 * store (`s3DerivedObjectStore`, the code the scheduler runs) against ONE
 * designated, ISOLATED test bucket. Every answer the reconciler decides on is
 * checked against the real store: exact-key version listing with sizes,
 * creation times, retention and legal hold; a delete that Object Lock refuses;
 * incomplete multipart uploads found and aborted; request cancellation.
 *
 * NEVER CUSTOMER EVIDENCE. The run refuses to start unless ALL hold:
 *   - the bucket name contains "reconciler-test" and is not a known
 *     production bucket;
 *   - the bucket carries the tag  purpose=closure3-reconciler-test;
 *   - the bucket has Object Lock enabled (hence versioning);
 *   - the bucket holds NO object outside the prefix closure3-reconciler-test/.
 * Everything is written under closure3-reconciler-test/<run id>/ with
 * GOVERNANCE retention of one day (never COMPLIANCE) or a legal hold, and is
 * removed at the end (legal holds released, versions deleted with governance
 * bypass, uploads aborted); the run fails if anything of it is left.
 *
 * Usage (credentials from the standard AWS chain, e.g. AWS_PROFILE):
 *   pnpm --filter proovra-worker exec tsx scripts/smoke-derived-object-store-s3.mjs \
 *     --bucket <isolated-reconciler-test-bucket> --region eu-central-1 [--endpoint http://127.0.0.1:59000]
 * The worker's configuration is parsed when its module loads; the command
 * line in the closure report supplies inert values for it (no database,
 * Redis or worker bucket is contacted).
 */
import { randomBytes, randomUUID } from "node:crypto";

import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketTaggingCommand,
  GetObjectLockConfigurationCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutObjectLegalHoldCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";

import { s3DerivedObjectStore } from "../src/derived-storage-intent.ts";

const PRODUCTION_BUCKETS = new Set(["proovra-evidence-prod-eu"]);
const ROOT = "closure3-reconciler-test/";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const bucket = arg("bucket");
const region = arg("region") ?? "eu-central-1";
const endpoint = arg("endpoint");
if (!bucket) throw new Error("--bucket is required");
if (!bucket.includes("reconciler-test") || PRODUCTION_BUCKETS.has(bucket)) {
  throw new Error(`REFUSED: ${bucket} is not a designated reconciler test bucket`);
}

const client = new S3Client({
  region,
  ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});
const store = s3DerivedObjectStore(client);
const signal = () => AbortSignal.timeout(30_000);
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  if (!ok) console.error(`FAIL ${name}`, detail ?? "");
}

// ---- guards -----------------------------------------------------------------
const tags = await client.send(new GetBucketTaggingCommand({ Bucket: bucket })).catch((err) => {
  throw new Error(`REFUSED: the bucket's tags cannot be read (${String(err?.name ?? err)}); it must carry purpose=closure3-reconciler-test`);
});
if (!(tags.TagSet ?? []).some((t) => t.Key === "purpose" && t.Value === "closure3-reconciler-test")) {
  throw new Error("REFUSED: the bucket lacks the tag purpose=closure3-reconciler-test");
}
const lockCfg = await client.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
if (lockCfg.ObjectLockConfiguration?.ObjectLockEnabled !== "Enabled") {
  throw new Error("REFUSED: Object Lock is not enabled on the bucket");
}
let token;
do {
  const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token, MaxKeys: 1000 }));
  const foreign = (page.Contents ?? []).find((o) => !String(o.Key).startsWith(ROOT));
  if (foreign) throw new Error(`REFUSED: the bucket holds an object outside ${ROOT} (${String(foreign.Key).slice(0, 40)}...)`);
  token = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (token);

const prefix = `${ROOT}${new Date().toISOString().slice(0, 10)}-${randomUUID()}/`;
console.log(JSON.stringify({ bucket, region, endpoint: endpoint ?? "aws", prefix }));

try {
  // ---- 1. listVersions: exact key, sizes, creation time, retention, legal hold
  const key = `${prefix}derived-assets/rec/part/image_thumbnail-x.webp`;
  const retainUntil = new Date(Date.now() + 24 * 3600 * 1000);
  const free = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: randomBytes(1234) }));
  const retained = await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: randomBytes(4321), ObjectLockMode: "GOVERNANCE", ObjectLockRetainUntilDate: retainUntil }),
  );
  const held = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: randomBytes(77), ObjectLockLegalHoldStatus: "ON" }));
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: `${key}.other`, Body: randomBytes(5) }));
  const listed = await store.listVersions({ bucket, key }, signal());
  const byId = new Map(listed.map((v) => [v.versionId, v]));
  check("listVersions returns exactly the key's 3 data versions", listed.length === 3, listed.map((v) => v.versionId));
  check("unlocked version: size, no hold, no retention", byId.get(free.VersionId)?.sizeBytes === 1234 && !byId.get(free.VersionId)?.legalHold && byId.get(free.VersionId)?.retainUntil === null);
  check("retained version: size and retain-until in the future", byId.get(retained.VersionId)?.sizeBytes === 4321 && byId.get(retained.VersionId)?.retainUntil?.getTime() > Date.now());
  check("legal-hold version: size and hold ON", byId.get(held.VersionId)?.sizeBytes === 77 && byId.get(held.VersionId)?.legalHold === true);
  check("every version reports its creation time", listed.every((v) => v.lastModified instanceof Date));

  // ---- 2. deleteVersion: unlocked removed; retention and legal hold refuse
  check("unlocked version deleted", (await store.deleteVersion({ bucket, key, versionId: free.VersionId }, signal())) === true);
  check("retained version refused", (await store.deleteVersion({ bucket, key, versionId: retained.VersionId }, signal())) === false);
  check("legal-hold version refused", (await store.deleteVersion({ bucket, key, versionId: held.VersionId }, signal())) === false);
  const after = (await store.listVersions({ bucket, key }, signal())).map((v) => v.versionId).sort();
  check("the listing proves exactly the locked versions remain", JSON.stringify(after) === JSON.stringify([retained.VersionId, held.VersionId].sort()), after);

  // ---- 3. incomplete multipart uploads of exactly the key
  const mkey = `${prefix}derived-assets/rec/part/combined.mp4`;
  const mpu = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: mkey }));
  await client.send(new UploadPartCommand({ Bucket: bucket, Key: mkey, UploadId: mpu.UploadId, PartNumber: 1, Body: randomBytes(5 * 1024 * 1024) }));
  const otherMpu = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: `${mkey}.x` }));
  const pending = await store.listMultipartUploads({ bucket, key: mkey }, signal());
  check("listMultipartUploads returns exactly the key's upload, with its initiation time", pending.length === 1 && pending[0].uploadId === mpu.UploadId && pending[0].initiated instanceof Date);
  await store.abortMultipartUpload({ bucket, key: mkey, uploadId: mpu.UploadId }, signal());
  check("abort proven by listing again", (await store.listMultipartUploads({ bucket, key: mkey }, signal())).length === 0);
  check("an aborted upload stored no object", (await store.listVersions({ bucket, key: mkey }, signal())).length === 0);
  await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: `${mkey}.x`, UploadId: otherMpu.UploadId }));

  // ---- 4. cancellation
  const c = new AbortController();
  c.abort();
  check("an aborted signal sends nothing", await store.listVersions({ bucket, key }, c.signal).then(() => false, () => true));
} finally {
  // ---- cleanup: this run's prefix only
  const v = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }));
  for (const x of [...(v.Versions ?? []), ...(v.DeleteMarkers ?? [])]) {
    await client.send(new PutObjectLegalHoldCommand({ Bucket: bucket, Key: x.Key, VersionId: x.VersionId, LegalHold: { Status: "OFF" } })).catch(() => undefined);
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: x.Key, VersionId: x.VersionId, BypassGovernanceRetention: true })).catch((e) => console.error("cleanup", String(e)));
  }
  const u = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix }));
  for (const x of u.Uploads ?? []) await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: x.Key, UploadId: x.UploadId })).catch(() => undefined);
  const left = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }));
  check("cleanup: nothing of this run is left", (left.Versions ?? []).length === 0 && (left.DeleteMarkers ?? []).length === 0);
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
