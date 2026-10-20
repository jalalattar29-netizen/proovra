/**
 * THE CANONICAL RECORD DIGEST (2026-10-20, forward remediation AUD-53).
 *
 * One interpretation of a record's stored digest for every output: the raw
 * file digest for a single file (the legacy composite column read-compatible
 * only), the composite for a multipart record. Executed against the BUILT module.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { resolveCanonicalRecordDigest } from "../dist/index.js";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const raw = sha("the original bytes");

test("a single-file record stored in the raw form reads RAW", () => {
  assert.deepEqual(resolveCanonicalRecordDigest({ storedDigest: raw, partDigests: [raw] }, sha), { canonical: raw, form: "RAW" });
});

test("the legacy single-part composite column reads as the RAW file digest — one form in every output", () => {
  assert.deepEqual(resolveCanonicalRecordDigest({ storedDigest: sha(raw), partDigests: [raw] }, sha), {
    canonical: raw,
    form: "LEGACY_SINGLE_PART_COMPOSITE",
  });
  // A record with no part row is resolved against the SIGNED fingerprint's digest.
  assert.deepEqual(resolveCanonicalRecordDigest({ storedDigest: sha(raw), partDigests: [], signedSingleDigest: raw }, sha), {
    canonical: raw,
    form: "LEGACY_SINGLE_PART_COMPOSITE",
  });
  // Case is not a different digest.
  assert.equal(resolveCanonicalRecordDigest({ storedDigest: sha(raw).toUpperCase(), partDigests: [raw.toUpperCase()] }, sha).canonical, raw);
});

test("a multipart record keeps its composite; nothing is re-derived", () => {
  const composite = sha(`${raw}|${sha("second")}`);
  assert.deepEqual(resolveCanonicalRecordDigest({ storedDigest: composite, partDigests: [raw, sha("second")] }, sha), {
    canonical: composite,
    form: "MULTIPART_COMPOSITE",
  });
});

test("a digest that is neither form is returned AS STORED — the integrity gate refuses it, this does not hide it", () => {
  const wrong = sha("not this file");
  assert.deepEqual(resolveCanonicalRecordDigest({ storedDigest: wrong, partDigests: [raw] }, sha), { canonical: wrong, form: "UNKNOWN" });
  assert.deepEqual(resolveCanonicalRecordDigest({ storedDigest: null, partDigests: [raw] }, sha), { canonical: null, form: "UNKNOWN" });
});
