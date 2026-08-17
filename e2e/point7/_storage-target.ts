/**
 * PHASE 13 (NEW-077) — THE DISPOSABLE-STORAGE TARGET, AND THE GUARD ON IT.
 *
 * Deliberately DEPENDENCY-FREE. `resetDisposableMultipartUploads()` aborts real
 * multipart uploads, so its guard is the part most worth pinning in a test — and
 * the guard has to be importable WITHOUT dragging in the browser harness, which
 * pulls `pg` and an AWS client that are not resolvable from other packages'
 * TypeScript projects. Keeping the constants and the refusal here lets the guard
 * be tested from anywhere while there is still exactly one implementation of it.
 *
 * WHY THESE VALUES ARE FROZEN RATHER THAN READ FROM ENV
 * ---------------------------------------------------------------------------
 * `services/api/test/setup/test-bootstrap.mjs` is a `--import` preload in every
 * Point-7 process. It SCRUBS every environment key containing `S3_` and then
 * re-applies its own local fakes unconditionally, so whatever the repository's
 * env files say, the API under Point 7 is configured with exactly the values
 * below. Reading env here would let the spec and the process under test disagree
 * while both looked correct — and would let a misconfiguration point a
 * destructive helper at a remote bucket.
 *
 * Mirrored verbatim from `test-bootstrap.mjs`.
 */
export const P7_STORAGE = {
  endpoint: "http://127.0.0.1:59000",
  region: "auto",
  accessKeyId: "point7-local-minio",
  secretAccessKey: "point7-local-minio-secret",
  bucket: "point7-local-bucket",
  forcePathStyle: true,
} as const;

/** The MinIO origin, for route-level correlation of presigned part PUTs. */
export const P7_STORAGE_ORIGIN = P7_STORAGE.endpoint;

export class UnsafeStorageResetError extends Error {}

/**
 * Loopback-only, disposable-bucket-only.
 *
 * Exported so a test can prove the REFUSALS rather than the abort: a future edit
 * that points the reset at a configured endpoint instead of the frozen constants
 * must fail in a test, not in a bucket.
 */
export function assertDisposableStorageTarget(input: {
  endpoint: string;
  bucket: string;
}): void {
  let host = "";
  try {
    host = new URL(input.endpoint).hostname.toLowerCase();
  } catch {
    throw new UnsafeStorageResetError(
      `refusing a storage reset against an unparseable endpoint: ${input.endpoint}`,
    );
  }
  // Exact hostname equality, never a substring test: `127.0.0.1.evil.example.com`
  // and `localhost.attacker.test` are remote hosts that merely CONTAIN a
  // loopback literal, and substring thinking is how this class of guard fails.
  const loopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!loopback) {
    throw new UnsafeStorageResetError(
      `refusing a storage reset against non-loopback host "${host}" — this ` +
        "helper aborts real multipart uploads and may only ever address the " +
        "disposable local MinIO",
    );
  }
  if (input.bucket !== P7_STORAGE.bucket) {
    throw new UnsafeStorageResetError(
      `refusing a storage reset against bucket "${input.bucket}" — only the ` +
        `known disposable bucket "${P7_STORAGE.bucket}" may be reset`,
    );
  }
}
