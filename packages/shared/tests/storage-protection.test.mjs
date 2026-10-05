/**
 * Storage protection — one answer to "is this record's stored object protected?"
 * (evidence-output incident 2026-10-05: a COMPLIANCE lock still in force was
 * reported as "Storage protection incomplete" because `verified` — observed by a
 * live read — was read as "protected").
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  classifyStorageProtection,
  describeStorageProtection,
  storageProtectionAlert,
} from "../dist/storage-protection.js";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const FUTURE = "2036-10-05T12:00:00.000Z";
const PAST = "2026-01-01T00:00:00.000Z";

test("a COMPLIANCE or GOVERNANCE retention still in force is PROTECTED, whether recorded or observed", () => {
  for (const mode of ["COMPLIANCE", "GOVERNANCE", "compliance"]) {
    assert.equal(classifyStorageProtection({ mode, retainUntil: FUTURE, legalHold: "OFF" }, NOW), "PROTECTED");
  }
  assert.equal(classifyStorageProtection({ mode: "COMPLIANCE", retainUntil: new Date(FUTURE) }, NOW), "PROTECTED");
  assert.equal(storageProtectionAlert("PROTECTED"), null, "a protected record is not flagged");
});

test("a legal hold that is ON protects; one that is OFF does not", () => {
  assert.equal(classifyStorageProtection({ legalHold: "ON" }, NOW), "PROTECTED");
  assert.equal(classifyStorageProtection({ legalHold: "OFF" }, NOW), "NOT_APPLIED");
});

test("retention past its retain-until date is RETENTION_EXPIRED, not protected and not 'never applied'", () => {
  assert.equal(classifyStorageProtection({ mode: "COMPLIANCE", retainUntil: PAST }, NOW), "RETENTION_EXPIRED");
  assert.equal(storageProtectionAlert("RETENTION_EXPIRED").label, "Storage retention ended");
});

test("no lock in the metadata is NOT_APPLIED; an unreadable or absent object is UNCONFIRMED", () => {
  assert.equal(classifyStorageProtection({ mode: null, retainUntil: null, legalHold: null }, NOW), "NOT_APPLIED");
  assert.equal(classifyStorageProtection({ mode: "COMPLIANCE", retainUntil: null }, NOW), "NOT_APPLIED");
  assert.equal(classifyStorageProtection(null, NOW), "UNCONFIRMED");
  assert.equal(classifyStorageProtection({ readFailed: true, mode: "COMPLIANCE", retainUntil: FUTURE }, NOW), "UNCONFIRMED");
  assert.equal(storageProtectionAlert("NOT_APPLIED").label, "Storage protection incomplete");
  assert.match(storageProtectionAlert("NOT_APPLIED").detail, /this record's stored object/);
  assert.equal(storageProtectionAlert("UNCONFIRMED").label, "Storage protection not confirmed");
});

test("no alert or description claims platform configuration it cannot know", () => {
  for (const cls of ["RETENTION_EXPIRED", "NOT_APPLIED", "UNCONFIRMED"]) {
    assert.doesNotMatch(storageProtectionAlert(cls).detail, /configured/i);
  }
});

test("the Integrity description names mode, date and provenance", () => {
  const facts = { mode: "COMPLIANCE", retainUntil: FUTURE, source: "RECORDED" };
  assert.equal(
    describeStorageProtection(facts, "PROTECTED"),
    `Object Lock COMPLIANCE until ${FUTURE} (recorded at sealing)`,
  );
  assert.match(describeStorageProtection({ ...facts, source: "OBSERVED" }, "PROTECTED"), /observed on the stored object/);
  assert.equal(describeStorageProtection(null, "UNCONFIRMED"), "Not confirmed");
  assert.equal(describeStorageProtection({ mode: "COMPLIANCE", retainUntil: PAST }, "RETENTION_EXPIRED"), `Retention ended ${PAST}`);
});
