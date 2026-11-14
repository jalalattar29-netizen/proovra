/**
 * F-26a (2026-11-13) — THE SIGNED-IN RECORD PAGE AND PUBLIC VERIFY PRESENT ONE
 * VERDICT, FROM THE SAME FACTS.
 *
 * Defect: the record page presented the trust decision snapshotted at report
 * issuance unless a live hash/signature/custody check failed, while Public
 * Verify presented the live decision with the stored-bytes state applied. A
 * timestamp validated after issuance read "Not checked" on one page and
 * "Verified" on the other; a stored original since found substituted, or digest
 * columns that disagree with the signed fingerprint, left the record page on
 * the issued verdict while Public Verify required review.
 *
 * Both routes now call `resolvePresentedTrustDecision` (pinned below by source
 * contract); the snapshot is only the "since issue" comparison. Disclosure
 * policy shapes what surrounds the verdict, not the verdict: the resolver has
 * no disclosure input at all.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { StoredBytesIntegrity, TrustDecision } from "@proovra/shared";
import { describe, expect, it } from "vitest";

import {
  buildTrustDecisionConsistency,
  resolvePresentedTrustDecision,
} from "../src/services/trust-decision-consistency.service.js";

function decision(tsa: "passed" | "not_checked"): TrustDecision {
  return {
    verdict: "VERIFIED",
    level: "standard",
    tone: "success",
    presentationState: "VERIFIED",
    presentationTone: "success",
    summary: "Recorded integrity verified.",
    reviewerAction: "None.",
    integrityReviewRequired: false,
    signals: [
      { key: "core_integrity", label: "Core integrity", state: "VERIFIED", status: "passed", tone: "success", summary: "Core integrity verified", detail: "" },
      {
        key: "trusted_timestamp",
        label: "Trusted timestamp",
        state: tsa === "passed" ? "VERIFIED" : "NOT_CHECKED",
        status: tsa,
        tone: tsa === "passed" ? "success" : "neutral",
        summary: tsa === "passed" ? "RFC 3161 timestamp verified" : "Timestamp not yet validated",
        detail: "",
      },
    ],
  } as unknown as TrustDecision;
}

const SNAPSHOT_AT_ISSUE = decision("not_checked");
const LIVE_NOW = decision("passed");
const FRESH: StoredBytesIntegrity = {
  state: "verified_current",
  lastVerifiedAtUtc: "2026-11-13T10:00:00.000Z",
  lastCheckedAtUtc: "2026-11-13T10:00:00.000Z",
  failureCode: null,
  intervalDays: 30,
};
const SUBSTITUTED: StoredBytesIntegrity = { ...FRESH, state: "failed", failureCode: "DIGEST_MISMATCH" as never };

const facts = {
  liveTrustDecision: LIVE_NOW,
  snapshotTrustDecision: SNAPSHOT_AT_ISSUE,
  snapshotFromReport: true,
  canonicalHashMatches: true,
  signatureValid: true,
  custodyChainValid: true,
  storedBytes: FRESH,
  digestColumnsMatchSignedFingerprint: true as boolean | null,
};

const tsaOf = (d: TrustDecision) => d.signals.find((s) => s.key === "trusted_timestamp")?.status;
const coreOf = (d: TrustDecision) => d.signals.find((s) => s.key === "core_integrity")?.status;

describe("the presented verdict", () => {
  it("states the record NOW — a timestamp validated after issuance reads verified — and compares with the snapshot", () => {
    const presented = resolvePresentedTrustDecision(facts);
    expect(tsaOf(presented.trustDecision)).toBe("passed");
    expect(presented.source).toBe("REPORT_SNAPSHOT");
    expect(presented.liveCoreChecksFailed).toBe(false);
    const consistency = buildTrustDecisionConsistency({
      snapshotTrustDecision: SNAPSHOT_AT_ISSUE,
      liveTrustDecision: presented.trustDecision,
      source: presented.source,
    });
    expect(consistency.basis).toEqual({ kind: "LIVE" });
  });

  it("a substituted stored original fails core integrity on the presented verdict and drops the snapshot basis", () => {
    const presented = resolvePresentedTrustDecision({ ...facts, storedBytes: SUBSTITUTED });
    expect(coreOf(presented.trustDecision)).toBe("failed");
    expect(presented.storedBytesContradict).toBe(true);
    expect(presented.source).toBe("LIVE_SHARED_FALLBACK");
  });

  it("digest columns that disagree with the signed fingerprint fail core integrity", () => {
    const presented = resolvePresentedTrustDecision({ ...facts, digestColumnsMatchSignedFingerprint: false });
    expect(coreOf(presented.trustDecision)).toBe("failed");
    expect(presented.source).toBe("LIVE_SHARED_FALLBACK");
  });

  it("a package snapshot is named as such; no snapshot is the live fallback", () => {
    expect(resolvePresentedTrustDecision({ ...facts, snapshotFromReport: false }).source).toBe("VERIFICATION_PACKAGE_SNAPSHOT");
    expect(resolvePresentedTrustDecision({ ...facts, snapshotTrustDecision: null }).source).toBe("LIVE_SHARED_FALLBACK");
  });
});

describe("both routes present the verdict through the one resolver (source contract)", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/routes/evidence.routes.ts", import.meta.url)), "utf8");

  it("the record page and Public Verify each call resolvePresentedTrustDecision; the snapshot-preferring headline is gone", () => {
    expect(src.match(/= resolvePresentedTrustDecision\(\{/g)?.length).toBe(2);
    expect(src).not.toContain("liveCoreChecksFailed ? liveTrustDecision : snapshotTrustDecision ?? liveTrustDecision");
    // The record page applies the same stored-bytes state it displays.
    expect(src).toContain("storedBytes: ownerStoredBytes,");
  });
});
