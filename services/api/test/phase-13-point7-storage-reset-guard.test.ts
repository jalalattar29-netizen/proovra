/**
 * PHASE 13 (NEW-077) — THE DISPOSABLE-STORAGE RESET REFUSES THE WRONG TARGET.
 *
 * `resetDisposableMultipartUploads()` aborts real multipart uploads. That is the
 * right thing to do to a disposable local bucket before a scenario whose
 * precondition is stated over the whole bucket, and a destructive mistake against
 * anything else. So the guard — not the abort — is what is worth pinning: a
 * future edit that points this helper at a configured endpoint instead of the
 * frozen local constants must fail here rather than in a bucket.
 *
 * Only the guard is exercised; nothing in this file talks to storage.
 */

import { describe, it, expect } from "vitest";

/**
 * Imported from `_storage-target` rather than from `_org-upload-fixtures`: the
 * latter pulls the browser harness (`pg`) and the AWS client, neither of which
 * resolves in this package's TypeScript project. The guard was extracted into a
 * dependency-free module precisely so it stays testable from here, with one
 * implementation.
 */
import {
  P7_STORAGE,
  UnsafeStorageResetError,
  assertDisposableStorageTarget,
} from "../../../e2e/point7/_storage-target";

const BUCKET = P7_STORAGE.bucket;

describe("Point-7 disposable storage reset — target guard", () => {
  it("accepts the frozen local MinIO endpoint and the known disposable bucket", () => {
    expect(() =>
      assertDisposableStorageTarget({
        endpoint: P7_STORAGE.endpoint,
        bucket: BUCKET,
      }),
    ).not.toThrow();
  });

  it("accepts the loopback aliases, since the runner may address any of them", () => {
    for (const endpoint of [
      "http://127.0.0.1:59000",
      "http://localhost:59000",
    ]) {
      expect(() =>
        assertDisposableStorageTarget({ endpoint, bucket: BUCKET }),
      ).not.toThrow();
    }
  });

  it("REFUSES a non-loopback endpoint — R2, AWS, or any remote host", () => {
    for (const endpoint of [
      "https://abc123.r2.cloudflarestorage.com",
      "https://s3.eu-central-1.amazonaws.com",
      "https://storage.proovra.com",
      "http://10.0.0.5:9000",
      "http://192.168.1.20:9000",
    ]) {
      expect(
        () => assertDisposableStorageTarget({ endpoint, bucket: BUCKET }),
        `${endpoint} must be refused`,
      ).toThrow(UnsafeStorageResetError);
    }
  });

  it("REFUSES an unknown bucket even on loopback", () => {
    for (const bucket of [
      "proovra-production",
      "proovra-evidence",
      "",
      `${BUCKET}-2`,
    ]) {
      expect(
        () =>
          assertDisposableStorageTarget({
            endpoint: P7_STORAGE.endpoint,
            bucket,
          }),
        `bucket "${bucket}" must be refused`,
      ).toThrow(UnsafeStorageResetError);
    }
  });

  it("REFUSES an unparseable endpoint rather than guessing", () => {
    expect(() =>
      assertDisposableStorageTarget({ endpoint: "not a url", bucket: BUCKET }),
    ).toThrow(UnsafeStorageResetError);
  });

  it("the guard is total — a refusal is always the typed error, never a silent pass", () => {
    // A hostname that merely CONTAINS a loopback literal is still remote, and
    // substring thinking is how this class of guard usually fails.
    for (const endpoint of [
      "https://127.0.0.1.evil.example.com",
      "https://localhost.attacker.test",
    ]) {
      expect(
        () => assertDisposableStorageTarget({ endpoint, bucket: BUCKET }),
        `${endpoint} must be refused`,
      ).toThrow(UnsafeStorageResetError);
    }
  });
});
