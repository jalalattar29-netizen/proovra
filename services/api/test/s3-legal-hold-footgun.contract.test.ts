/**
 * S3 NATIVE LEGAL HOLD — THE FOOT-GUN, AND ITS ABSENCE.
 *
 * WHAT THIS EXISTS TO STOP COMING BACK
 * ---------------------------------------------------------------------------
 * `readObjectLockDefaults()` used to read `S3_OBJECT_LOCK_LEGAL_HOLD` and every
 * ordinary upload and retention call spread the result into its S3 request.
 * Two consequences, and the second is the one that mattered:
 *
 *   1. The production value is `OFF`, and `"OFF"` is a truthy string, so the
 *      guard `if (objectLock.legalHold)` passed and PROOVRA actively stamped
 *      `LegalHold=OFF` on every finalized object and every part — expressing a
 *      decision the application had never made.
 *
 *   2. The variable reads like an opt-out and behaved like an opt-in. Setting
 *      it to `ON` — one character, and it looks like "turn the feature on" —
 *      would have placed a NATIVE S3 legal hold on every newly finalized
 *      object. This codebase persists no S3 `VersionId`, imports no
 *      `GetObjectLegalHold`, and has no release path, so those holds could not
 *      be lifted by any code that exists. On a COMPLIANCE-mode bucket, no
 *      account — including root — can clear a legal hold it cannot address by
 *      version. The blast radius was every new evidence object, permanently.
 *
 * These are SOURCE assertions on purpose. The property is "no code path can
 * reach PutObjectLegalHold from configuration", and that is a statement about
 * the code, not about one execution of it — a behavioural test proves only the
 * path it happened to walk.
 *
 * WHAT IS DELIBERATELY UNCHANGED: Object Lock RETENTION. `S3_OBJECT_LOCK_MODE`
 * and `S3_OBJECT_LOCK_RETAIN_DAYS` still produce `ObjectLockMode` and
 * `ObjectLockRetainUntilDate` on every upload and still drive
 * `PutObjectRetention`. Removing the legal-hold stamp must never be allowed to
 * take retention with it, so that is asserted here too.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const src = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

/** Strip comments — this file's own prose names the banned symbols. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

/** Every module that builds an S3 request carrying Object Lock parameters. */
const STORAGE_MODULES = [
  "services/api/src/storage.ts",
  "services/worker/src/storage.ts",
  "services/api/src/services/uploads/storage-multipart.ts",
] as const;

describe("no configuration path can place a native S3 legal hold", () => {
  it("no storage module imports or issues PutObjectLegalHold", () => {
    for (const rel of STORAGE_MODULES) {
      const body = code(src(rel));
      expect(body, `${rel} must not reference PutObjectLegalHold`).not.toContain(
        "PutObjectLegalHold",
      );
    }
  });

  it("no storage module puts a legal-hold status on an S3 request", () => {
    // `ObjectLockLegalHoldStatus:` as a request KEY. The same identifier
    // appears lower-cased as a DB column and as a HeadObject response field;
    // reading what storage reports is fine, writing it from config is not.
    for (const rel of STORAGE_MODULES) {
      const body = code(src(rel));
      expect(
        body,
        `${rel} must not set ObjectLockLegalHoldStatus on a request`,
      ).not.toMatch(/ObjectLockLegalHoldStatus:\s*(?!true)/);
    }
  });

  it("no storage module reads the legacy env var into a request", () => {
    for (const rel of STORAGE_MODULES) {
      const body = code(src(rel));
      expect(
        body,
        `${rel} must not read S3_OBJECT_LOCK_LEGAL_HOLD`,
      ).not.toContain("S3_OBJECT_LOCK_LEGAL_HOLD");
    }
  });

  it("applyObjectRetention no longer accepts a legalHold parameter", () => {
    // The parameter was the loaded gun: its only caller passed the value
    // straight from the environment. Removing the read is not enough while a
    // future caller could still pass "ON" by hand with no saga behind it.
    for (const rel of [
      "services/api/src/storage.ts",
      "services/worker/src/storage.ts",
    ]) {
      const body = code(src(rel));
      const start = body.indexOf("export async function applyObjectRetention");
      expect(start, `${rel}: applyObjectRetention not found`).toBeGreaterThan(-1);
      const signature = body.slice(start, body.indexOf(") {", start));
      expect(signature).not.toContain("legalHold");
    }
  });
});

describe("Object Lock RETENTION is untouched", () => {
  it("mode and retain-until are still derived from configuration", () => {
    for (const rel of STORAGE_MODULES) {
      const body = code(src(rel));
      expect(body, `${rel} must still read the mode`).toContain(
        "S3_OBJECT_LOCK_MODE",
      );
      expect(body, `${rel} must still read the retain days`).toContain(
        "S3_OBJECT_LOCK_RETAIN_DAYS",
      );
    }
  });

  it("every upload path still stamps ObjectLockMode and ObjectLockRetainUntilDate", () => {
    for (const rel of STORAGE_MODULES) {
      const body = code(src(rel));
      expect(body, `${rel} must still stamp the mode`).toContain(
        "ObjectLockMode",
      );
      expect(body, `${rel} must still stamp the retain-until`).toContain(
        "ObjectLockRetainUntilDate",
      );
    }
  });

  it("PutObjectRetention still exists in both hosts", () => {
    for (const rel of [
      "services/api/src/storage.ts",
      "services/worker/src/storage.ts",
    ]) {
      expect(code(src(rel)), `${rel} must keep PutObjectRetention`).toContain(
        "PutObjectRetentionCommand",
      );
    }
  });

  it("finalization still applies default retention", () => {
    // The caller, not just the primitive: an upload path that stopped calling
    // it would leave objects unprotected while every assertion above passed.
    const complete = code(src("services/api/src/services/evidence-complete.service.ts"));
    expect(complete).toContain("applyDefaultObjectRetention");
    expect(complete).toContain("EVIDENCE_RETENTION_APPLY_FAILED");
  });
});

describe("the legacy variable is refused rather than ignored", () => {
  it("the worker refuses to start on ON", () => {
    const cfg = src("services/worker/src/config.ts");
    expect(cfg).toContain("S3_OBJECT_LOCK_LEGAL_HOLD");
    expect(cfg).toMatch(/refine\(\(v\) => v !== "ON"/);
    // OFF and unset must remain acceptable — production is set to OFF today
    // and a refusal there would be an outage, not a safety improvement.
    expect(cfg).toMatch(/\.enum\(\["ON", "OFF"\]\)\s*\n?\s*\.optional\(\)/);
  });

  it("the API raises a startup violation on ON, in every environment", () => {
    const cfg = src("services/api/src/config/index.ts");
    expect(cfg).toContain("s3_native_legal_hold_unsupported");
    expect(cfg).toMatch(
      /process\.env\.S3_OBJECT_LOCK_LEGAL_HOLD[\s\S]{0,80}=== "ON"/,
    );
  });

  it("the API's violation collector actually fires on ON and is silent on OFF", async () => {
    const previous = process.env.S3_OBJECT_LOCK_LEGAL_HOLD;
    const { collectStartupViolations } = await import(
      "../src/config/index.js"
    );
    try {
      const has = () =>
        collectStartupViolations().some(
          (v) => v.reason === "s3_native_legal_hold_unsupported",
        );

      process.env.S3_OBJECT_LOCK_LEGAL_HOLD = "ON";
      expect(has(), "ON must raise the violation").toBe(true);

      process.env.S3_OBJECT_LOCK_LEGAL_HOLD = "on";
      expect(has(), "case must not be an escape hatch").toBe(true);

      process.env.S3_OBJECT_LOCK_LEGAL_HOLD = "OFF";
      expect(has(), "OFF is inert and must not block startup").toBe(false);

      delete process.env.S3_OBJECT_LOCK_LEGAL_HOLD;
      expect(has(), "unset is inert and must not block startup").toBe(false);
    } finally {
      if (previous === undefined) delete process.env.S3_OBJECT_LOCK_LEGAL_HOLD;
      else process.env.S3_OBJECT_LOCK_LEGAL_HOLD = previous;
    }
  });
});

describe("the application remains the sole legal-hold authority", () => {
  it("destruction still consults the union evaluator, not storage metadata", () => {
    // The point of removing the stamp is that nothing gained a second opinion
    // about hold state. `storageObjectLockLegalHoldStatus` is a display
    // snapshot; it must not have become an input to any destructive decision.
    const executor = code(
      src("packages/shared-runtime/src/evidence-destruction/executor.ts"),
    );
    expect(executor).toContain("legalHold: input.legalHold");
    expect(executor).not.toContain("storageObjectLockLegalHoldStatus");

    for (const rel of [
      "services/worker/src/processor.ts",
      "services/worker/src/governance/destruction-orchestrator.worker.ts",
      "services/api/src/services/lifecycle/destruction-governance.service.ts",
      "services/api/src/services/governance-lifecycle/destruction-review.service.ts",
    ]) {
      expect(src(rel), `${rel} must resolve the hold from the evaluator`).toContain(
        "evaluateEffectiveLegalHold",
      );
    }
  });
});
