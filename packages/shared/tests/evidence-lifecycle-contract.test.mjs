/**
 * PROOVRA Phase 1 — Evidence Lifecycle Contract tests.
 *
 * These tests pin the contract surface so later phases (which will
 * actually rewire writers/readers to consume it) cannot silently drop a
 * lifecycle step, miss a writer/timestamp/material declaration, or
 * misclassify a snapshot vs live material.
 *
 * The test deliberately avoids asserting any particular wording or DB
 * behavior — Phase 1 must not change behavior. It only validates the
 * contract shape and the snapshot/live semantics.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  EVIDENCE_LIFECYCLE_STEPS,
  EVIDENCE_LIFECYCLE_EVENT_NAMES,
  EVIDENCE_LIFECYCLE_MATERIALS,
  EVIDENCE_LIFECYCLE_FAILURE_CODES,
  EVIDENCE_LIFECYCLE_SNAPSHOT_SEMANTICS,
  EVIDENCE_LIFECYCLE_OUTPUT_TYPES,
  getLifecycleStepDefinition,
  listEvidenceLifecycleSteps,
  validateLifecycleStepInputs,
  deriveLifecycleMaterialAvailability,
  deriveLifecycleReadinessForOutput,
  getOutputRequirements,
} from "../dist/index.js";

const EXPECTED_STEPS = [
  "EvidenceCreated",
  "UploadAuthorized",
  "UploadCompleted",
  "DigestComputed",
  "CanonicalFingerprintCreated",
  "SignatureApplied",
  "TrustedTimestampRecorded",
  "StorageLocked",
  "CustodyChainUpdated",
  "OTSProofCreated",
  "ReportSnapshotCreated",
  "VerificationPackageCreated",
  "PublicVerifyPublished",
  "OTSAnchoredLater",
];

test("contract enumerates the 14 lifecycle steps from the Phase 1 spec", () => {
  assert.deepEqual([...EVIDENCE_LIFECYCLE_STEPS], EXPECTED_STEPS);
  assert.equal(EVIDENCE_LIFECYCLE_STEPS.length, 14);
});

test("listEvidenceLifecycleSteps returns 14 fully-populated definitions", () => {
  const defs = listEvidenceLifecycleSteps();
  assert.equal(defs.length, 14);

  for (const def of defs) {
    assert.ok(typeof def.id === "string" && def.id.length > 0, `id missing for ${JSON.stringify(def)}`);
    assert.ok(
      typeof def.eventName === "string" && def.eventName.includes("evidence."),
      `eventName must be namespaced under 'evidence.' for ${def.id}`,
    );
    assert.ok(
      typeof def.description === "string" && def.description.length > 16,
      `description too short for ${def.id}`,
    );
    assert.ok(
      typeof def.writerResponsibility === "string" && def.writerResponsibility.length > 8,
      `writerResponsibility missing for ${def.id}`,
    );
    assert.ok(
      typeof def.timestampMeaning === "string" && def.timestampMeaning.length > 8,
      `timestampMeaning missing for ${def.id}`,
    );
    assert.ok(Array.isArray(def.requiredInputs), `requiredInputs not an array for ${def.id}`);
    assert.ok(Array.isArray(def.producedMaterials), `producedMaterials not an array for ${def.id}`);
    assert.ok(
      def.producedMaterials.length > 0,
      `producedMaterials must be non-empty for ${def.id}`,
    );
    assert.ok(
      Array.isArray(def.failureCodes) && def.failureCodes.length > 0,
      `failureCodes must be non-empty for ${def.id}`,
    );
    assert.ok(
      typeof def.retryPolicy === "string" && def.retryPolicy.length > 8,
      `retryPolicy missing for ${def.id}`,
    );
    assert.ok(
      EVIDENCE_LIFECYCLE_SNAPSHOT_SEMANTICS.includes(def.snapshotSemantics),
      `snapshotSemantics ${def.snapshotSemantics} not a known value for ${def.id}`,
    );
    assert.ok(
      Array.isArray(def.downstreamConsumers) && def.downstreamConsumers.length > 0,
      `downstreamConsumers must be non-empty for ${def.id}`,
    );
    for (const consumer of def.downstreamConsumers) {
      assert.ok(
        EVIDENCE_LIFECYCLE_OUTPUT_TYPES.includes(consumer),
        `unknown downstream consumer ${consumer} on ${def.id}`,
      );
    }

    if (def.custodyEventType === null) {
      assert.equal(
        def.custodyEventGap,
        true,
        `${def.id} has no custodyEventType so custodyEventGap must be true`,
      );
      assert.ok(
        typeof def.custodyEventGapReason === "string" && def.custodyEventGapReason.length > 16,
        `${def.id} has a custody gap but no documented reason`,
      );
    } else {
      assert.equal(
        def.custodyEventGap,
        false,
        `${def.id} declares a custodyEventType so custodyEventGap must be false`,
      );
    }
  }
});

test("every step's requiredInputs and producedMaterials reference known materials", () => {
  const known = new Set(EVIDENCE_LIFECYCLE_MATERIALS);
  for (const step of EXPECTED_STEPS) {
    const def = getLifecycleStepDefinition(step);
    for (const m of def.requiredInputs) {
      assert.ok(known.has(m), `step ${step} requires unknown material ${m}`);
    }
    for (const m of def.producedMaterials) {
      assert.ok(known.has(m), `step ${step} produces unknown material ${m}`);
    }
  }
});

test("every step's failureCodes are bounded enum values", () => {
  const known = new Set(EVIDENCE_LIFECYCLE_FAILURE_CODES);
  for (const step of EXPECTED_STEPS) {
    const def = getLifecycleStepDefinition(step);
    for (const code of def.failureCodes) {
      assert.ok(known.has(code), `step ${step} uses unknown failure code ${code}`);
    }
  }
});

test("eventNames are unique and namespaced", () => {
  const names = Object.values(EVIDENCE_LIFECYCLE_EVENT_NAMES);
  assert.equal(new Set(names).size, names.length, "eventNames must be unique");
  for (const n of names) {
    assert.match(n, /^evidence\.[a-z0-9.]+$/, `bad event name shape: ${n}`);
  }
});

test("ReportSnapshotCreated is sealed report-snapshot-only", () => {
  const def = getLifecycleStepDefinition("ReportSnapshotCreated");
  assert.equal(def.snapshotSemantics, "report-snapshot-only");
  assert.equal(def.custodyEventType, "REPORT_GENERATED");
  assert.ok(
    def.producedMaterials.includes("report.row"),
    "ReportSnapshotCreated must produce report.row",
  );
  assert.ok(
    def.producedMaterials.includes("report.generatedAtUtc"),
    "ReportSnapshotCreated must produce report.generatedAtUtc",
  );
  assert.ok(
    def.producedMaterials.includes("report.trustDecisionSnapshot"),
    "ReportSnapshotCreated must produce report.trustDecisionSnapshot",
  );
});

test("VerificationPackageCreated is sealed package-snapshot-only", () => {
  const def = getLifecycleStepDefinition("VerificationPackageCreated");
  assert.equal(def.snapshotSemantics, "package-snapshot-only");
  assert.equal(def.custodyEventType, "VERIFICATION_PACKAGE_GENERATED");
  assert.ok(
    def.producedMaterials.includes("verificationPackage.row"),
    "VerificationPackageCreated must produce verificationPackage.row",
  );
  assert.ok(
    def.producedMaterials.includes("verificationPackage.trustDecisionSnapshot"),
    "VerificationPackageCreated must produce a snapshot of the trust decision",
  );
});

test("PublicVerifyPublished is a live publication state, not a snapshot", () => {
  const def = getLifecycleStepDefinition("PublicVerifyPublished");
  assert.equal(def.snapshotSemantics, "live");
  assert.ok(
    def.producedMaterials.includes("evidence.publicVerifyState"),
    "PublicVerifyPublished must produce evidence.publicVerifyState",
  );
});

test("OTSAnchoredLater is live-updating-after-snapshot", () => {
  const def = getLifecycleStepDefinition("OTSAnchoredLater");
  assert.equal(def.snapshotSemantics, "live-updating-after-snapshot");
  assert.equal(def.custodyEventType, "ANCHOR_PUBLISHED");
  assert.ok(
    def.producedMaterials.includes("evidence.otsStatus"),
    "OTSAnchoredLater must produce evidence.otsStatus",
  );
  assert.ok(
    def.producedMaterials.includes("evidence.otsBitcoinTxid"),
    "OTSAnchoredLater must produce evidence.otsBitcoinTxid",
  );
});

test("steps with custodyEventGap=true name a real reason", () => {
  const gaps = listEvidenceLifecycleSteps().filter((d) => d.custodyEventGap);
  // From the Phase 1 design: DigestComputed, CanonicalFingerprintCreated,
  // CustodyChainUpdated (meta-writer), PublicVerifyPublished (no enum yet).
  const gapIds = gaps.map((g) => g.id).sort();
  assert.deepEqual(gapIds, [
    "CanonicalFingerprintCreated",
    "CustodyChainUpdated",
    "DigestComputed",
    "PublicVerifyPublished",
  ]);
  for (const g of gaps) {
    assert.ok(
      typeof g.custodyEventGapReason === "string" && g.custodyEventGapReason.length > 16,
      `gap step ${g.id} must explain its custodyEventGapReason`,
    );
  }
});

test("output readiness — empty input means nothing is ready", () => {
  for (const out of EVIDENCE_LIFECYCLE_OUTPUT_TYPES) {
    const r = deriveLifecycleReadinessForOutput(out, {});
    assert.equal(r.outputType, out);
    assert.equal(r.ready, false, `${out} should not be ready with empty input`);
    assert.ok(r.unsatisfiedSteps.length > 0);
  }
});

test("output readiness — fully-populated input flips REPORT_SNAPSHOT to ready", () => {
  // Seed every material with a non-empty value.
  const input = {};
  for (const m of EVIDENCE_LIFECYCLE_MATERIALS) {
    input[m] = "present";
  }
  const r = deriveLifecycleReadinessForOutput("REPORT_SNAPSHOT", input);
  assert.equal(
    r.ready,
    true,
    `expected REPORT_SNAPSHOT to be ready when all materials are present; unsatisfied: ${JSON.stringify(r.unsatisfiedSteps)}`,
  );
});

test("material availability derivation reflects only present, non-empty values", () => {
  const input = {
    "evidence.fileSha256": "abc",
    "evidence.fingerprintHash": "",
    "evidence.signatureBase64": null,
    "evidence.publicVerifyState": "PUBLISHED",
  };
  const avail = deriveLifecycleMaterialAvailability(input);
  assert.equal(avail["evidence.fileSha256"], true);
  assert.equal(avail["evidence.fingerprintHash"], false);
  assert.equal(avail["evidence.signatureBase64"], false);
  assert.equal(avail["evidence.publicVerifyState"], true);
  assert.equal(avail["evidence.row"], false, "absent material defaults to false");
});

test("validateLifecycleStepInputs reports missing materials precisely", () => {
  const v = validateLifecycleStepInputs("SignatureApplied", {});
  assert.equal(v.ok, false);
  assert.deepEqual([...v.missing], ["evidence.fingerprintHash"]);

  const v2 = validateLifecycleStepInputs("SignatureApplied", {
    "evidence.fingerprintHash": "deadbeef",
  });
  assert.equal(v2.ok, true);
  assert.equal(v2.missing.length, 0);
});

test("getOutputRequirements lists steps in lifecycle order", () => {
  const order = new Map(EVIDENCE_LIFECYCLE_STEPS.map((s, i) => [s, i]));
  for (const out of EVIDENCE_LIFECYCLE_OUTPUT_TYPES) {
    const req = getOutputRequirements(out);
    let lastIdx = -1;
    for (const step of req) {
      const idx = order.get(step);
      assert.ok(idx !== undefined, `unknown step ${step} in ${out} requirements`);
      assert.ok(
        idx > lastIdx,
        `${out} requirements out of lifecycle order at ${step}`,
      );
      lastIdx = idx;
    }
  }
});

test("downstream-consumer wiring is internally consistent", () => {
  // If REPORT_SNAPSHOT requires step X, then step X's downstreamConsumers
  // must list REPORT_SNAPSHOT — that is the consistency invariant. Same
  // for every output type.
  for (const out of EVIDENCE_LIFECYCLE_OUTPUT_TYPES) {
    for (const stepId of getOutputRequirements(out)) {
      const def = getLifecycleStepDefinition(stepId);
      assert.ok(
        def.downstreamConsumers.includes(out),
        `step ${stepId} is required by ${out} but does not list it as downstream consumer`,
      );
    }
  }
});
