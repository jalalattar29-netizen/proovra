#!/usr/bin/env node
/**
 * UC-1 ACCEPTANCE — create the disposable object-storage bucket (MinIO only).
 *
 * The UC-1 lifecycle is storage-backed end to end: the capture uploads parts via
 * a canonical presigned S3 PUT, the worker uploads the Report and Verification
 * Package to S3, and public Verify reads the package back to compute integrity.
 * The canonical local-fixture env deliberately points S3 at a dead address ("a
 * fixture that has no storage"), which is correct for UI fixtures but makes the
 * capture->report->package->verify chain impossible. The acceptance harness
 * therefore runs a disposable MinIO and creates its bucket with this script.
 *
 * SAFETY: refuses any S3 endpoint that is not a LOCAL host. It only creates a
 * bucket; it never deletes or writes objects, and never touches Production.
 */
import { S3Client, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";

function assertLocalEndpoint(raw) {
  if (!raw) throw new Error("S3_ENDPOINT is required");
  const host = new URL(raw).hostname.toLowerCase();
  const local = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  if (!local.has(host)) {
    throw new Error(`REFUSED: S3_ENDPOINT host '${host}' is not local. Acceptance uses disposable storage only.`);
  }
}

async function main() {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION ?? "us-east-1";
  if (!bucket) throw new Error("S3_BUCKET is required");
  assertLocalEndpoint(endpoint);

  const s3 = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? "",
      secretAccessKey: process.env.S3_SECRET_KEY ?? "",
    },
  });

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    process.stdout.write(`bucket '${bucket}' already exists\n`);
    return;
  } catch {
    /* not found — create it below */
  }

  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    process.stdout.write(`created bucket '${bucket}'\n`);
  } catch (err) {
    const name = err?.name ?? "";
    if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") {
      process.stdout.write(`bucket '${bucket}' already present\n`);
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  process.stderr.write(`uc1-ensure-bucket FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
