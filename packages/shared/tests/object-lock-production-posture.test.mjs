/**
 * AUD-010 — the production Object Lock posture rule shared by the API config,
 * the worker config, both startup bootstraps and API readiness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideObjectLockBootstrap, objectLockPostureViolations } from "../dist/index.js";

const CONTRACT = { S3_OBJECT_LOCK_ENABLED: "true", S3_OBJECT_LOCK_MODE: "COMPLIANCE" };
const VERIFIED = { mode: "verified", configured: { bucket: "b", defaultMode: null, defaultRetainDays: null } };

test("the exact contract has no violations (period unset, or >= 2920)", () => {
  assert.deepEqual(objectLockPostureViolations(CONTRACT), []);
  assert.deepEqual(objectLockPostureViolations({ ...CONTRACT, S3_OBJECT_LOCK_RETAIN_DAYS: "2920" }), []);
  assert.deepEqual(objectLockPostureViolations({ ...CONTRACT, S3_OBJECT_LOCK_RETAIN_DAYS: "3650" }), []);
  assert.deepEqual(objectLockPostureViolations({ ...CONTRACT, S3_OBJECT_LOCK_MODE: " compliance " }), []);
});

test("disabled, missing, GOVERNANCE and short periods are each violations", () => {
  assert.deepEqual(objectLockPostureViolations({}), ["object_lock_disabled", "object_lock_mode_not_compliance"]);
  assert.deepEqual(objectLockPostureViolations({ ...CONTRACT, S3_OBJECT_LOCK_ENABLED: "false" }), ["object_lock_disabled"]);
  assert.deepEqual(objectLockPostureViolations({ ...CONTRACT, S3_OBJECT_LOCK_MODE: "GOVERNANCE" }), [
    "object_lock_mode_not_compliance",
  ]);
  for (const days of ["365", "2919", "0", "-1", "abc", "2920.5"]) {
    assert.deepEqual(objectLockPostureViolations({ ...CONTRACT, S3_OBJECT_LOCK_RETAIN_DAYS: days }), [
      "object_lock_retain_days_below_contract",
    ], days);
  }
});

test("production bootstrap refuses every shortfall — no bypass exists", () => {
  const prod = (probe, env = CONTRACT) => decideObjectLockBootstrap(probe, { production: true, env });
  assert.equal(prod(VERIFIED).action, "start");
  assert.equal(prod({ mode: "disabled" }).action, "refuse");
  assert.equal(prod({ mode: "skipped", reason: "probe failed" }).action, "refuse");
  assert.equal(prod({ mode: "claimed-but-unsupported", bucket: "b", reason: "no lock" }).action, "refuse");
  // The environment is checked even when the bucket verified.
  assert.equal(prod(VERIFIED, { ...CONTRACT, S3_OBJECT_LOCK_MODE: "GOVERNANCE" }).action, "refuse");
  assert.equal(prod(VERIFIED, { ...CONTRACT, S3_OBJECT_LOCK_RETAIN_DAYS: "365" }).action, "refuse");
  // The old bypass variable changes nothing.
  assert.equal(
    prod({ mode: "claimed-but-unsupported", bucket: "b", reason: "x" }, { ...CONTRACT, OBJECT_LOCK_VERIFICATION_BYPASS: "true" }).action,
    "refuse",
  );
  // A weaker bucket DEFAULT retention is refused; COMPLIANCE >= 2920 is fine.
  const withDefault = (defaultMode, defaultRetainDays) => ({
    mode: "verified",
    configured: { bucket: "b", defaultMode, defaultRetainDays },
  });
  assert.equal(prod(withDefault("GOVERNANCE", 3000)).action, "refuse");
  assert.equal(prod(withDefault("COMPLIANCE", 365)).action, "refuse");
  assert.equal(prod(withDefault("COMPLIANCE", 2920)).action, "start");
});

test("outside production the same findings only warn", () => {
  const dev = (probe) => decideObjectLockBootstrap(probe, { production: false, env: {} });
  assert.deepEqual(dev({ mode: "disabled" }), { action: "start", level: "info", event: "object_lock.disabled" });
  assert.equal(dev({ mode: "skipped", reason: "x" }).level, "warn");
  assert.equal(dev({ mode: "claimed-but-unsupported", bucket: "b", reason: "x" }).level, "warn");
});
