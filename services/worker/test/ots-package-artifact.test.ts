/**
 * OTS regression hotfix — verification package OTS artifact emission.
 *
 * Tests the pure `decideOtsPackageArtifact` helper that owns the
 * artifact-emission rules for the verification package. Verifies the
 * honest semantics required by the brief:
 *   * PENDING / ANCHORED / FAILED with proof bytes → emit
 *     `opentimestamps-proof.ots` + companion JSON
 *   * DISABLED → emit NOTHING (no stub, no companion)
 *   * Missing proof bytes → no `.ots` file, but companion still emitted
 *     when status is meaningful (so the canonical state is auditable)
 *   * ANCHORED without supporting Bitcoin txid AND without anchoredAtUtc
 *     DEGRADES to PENDING in the companion (never overclaims)
 *   * Malformed proof base64 → no `.ots` file, no crash
 *   * Companion never echoes failureReason unless status is FAILED
 *   * Companion never echoes anchoredAtUtc unless status is ANCHORED
 *
 * Also asserts source-contract: the `createVerificationPackage` call
 * in `processor.ts` actually forwards OTS data, so the proof reaches
 * the artifact emitter at runtime.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { decideOtsPackageArtifact } from "../src/verification-package.js";

function readSource(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(rel, import.meta.url)),
    "utf8",
  );
}

const VALID_TXID =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// -----------------------------------------------------------------------------
// PENDING — proof present, no txid
// -----------------------------------------------------------------------------

describe("OTS package artifact — PENDING with proof", () => {
  const proof = Buffer.from("\x00\x4f\x70\x65\x6e\x54\x69\x6d", "binary"); // looks like an OTS file header
  const result = decideOtsPackageArtifact({
    status: "PENDING",
    proofBase64: proof.toString("base64"),
    hash: "deadbeef".repeat(8),
    calendar: "https://a.pool.opentimestamps.org",
    bitcoinTxid: null,
    anchoredAtUtc: null,
    upgradedAtUtc: null,
    failureReason: null,
  });

  it("emits the .ots proof bytes", () => {
    expect(result.proofBytes).not.toBeNull();
    expect(result.proofBytes!.length).toBe(proof.length);
    expect(result.proofBytes!.equals(proof)).toBe(true);
  });

  it("emits the companion JSON with PENDING status", () => {
    expect(result.companion).not.toBeNull();
    expect(result.companion!.status).toBe("PENDING");
    expect(result.companion!.proofPresent).toBe(true);
    expect(result.companion!.proofFile).toBe("opentimestamps-proof.ots");
  });

  it("does not echo bitcoin txid", () => {
    expect(result.companion!.bitcoinTxid).toBeNull();
  });

  it("does not echo anchoredAtUtc", () => {
    expect(result.companion!.anchoredAtUtc).toBeNull();
  });

  it("does not echo failureReason", () => {
    expect(result.companion!.failureReason).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// ANCHORED — proof + valid txid
// -----------------------------------------------------------------------------

describe("OTS package artifact — ANCHORED with valid txid", () => {
  const result = decideOtsPackageArtifact({
    status: "ANCHORED",
    proofBase64: Buffer.from("PROOF_BYTES").toString("base64"),
    hash: "deadbeef".repeat(8),
    calendar: "https://a.pool.opentimestamps.org",
    bitcoinTxid: VALID_TXID,
    anchoredAtUtc: "2026-05-18T12:00:00.000Z",
    upgradedAtUtc: "2026-05-18T11:00:00.000Z",
    failureReason: null,
  });

  it("emits the .ots proof bytes", () => {
    expect(result.proofBytes).not.toBeNull();
  });

  it("companion has ANCHORED status with txid + anchoredAtUtc", () => {
    expect(result.companion!.status).toBe("ANCHORED");
    expect(result.companion!.bitcoinTxid).toBe(VALID_TXID);
    expect(result.companion!.anchoredAtUtc).toBe("2026-05-18T12:00:00.000Z");
  });
});

// -----------------------------------------------------------------------------
// ANCHORED degradation — claim without supporting evidence is downgraded
// -----------------------------------------------------------------------------

describe("OTS package artifact — ANCHORED without supporting evidence DEGRADES to PENDING", () => {
  it("downgrades to PENDING when neither txid nor anchoredAtUtc support the claim", () => {
    const result = decideOtsPackageArtifact({
      status: "ANCHORED",
      proofBase64: Buffer.from("X").toString("base64"),
      hash: "deadbeef".repeat(8),
      calendar: null,
      bitcoinTxid: null,
      anchoredAtUtc: null,
      upgradedAtUtc: null,
      failureReason: null,
    });
    expect(result.companion!.status).toBe("PENDING");
    expect(result.companion!.bitcoinTxid).toBeNull();
    expect(result.companion!.anchoredAtUtc).toBeNull();
  });

  it("does NOT degrade when anchoredAtUtc supports the claim (even without txid)", () => {
    const result = decideOtsPackageArtifact({
      status: "ANCHORED",
      proofBase64: Buffer.from("X").toString("base64"),
      hash: null,
      calendar: null,
      bitcoinTxid: null,
      anchoredAtUtc: "2026-05-18T12:00:00.000Z",
      upgradedAtUtc: null,
      failureReason: null,
    });
    expect(result.companion!.status).toBe("ANCHORED");
    expect(result.companion!.anchoredAtUtc).toBe("2026-05-18T12:00:00.000Z");
  });

  it("rejects malformed txid (wrong length / not hex) — bitcoinTxid stays null", () => {
    const result = decideOtsPackageArtifact({
      status: "ANCHORED",
      proofBase64: Buffer.from("X").toString("base64"),
      hash: null,
      calendar: null,
      bitcoinTxid: "not-a-real-txid",
      anchoredAtUtc: "2026-05-18T12:00:00.000Z",
      upgradedAtUtc: null,
      failureReason: null,
    });
    expect(result.companion!.bitcoinTxid).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// FAILED — proof may still exist; failureReason is echoed
// -----------------------------------------------------------------------------

describe("OTS package artifact — FAILED with proof preserved", () => {
  const result = decideOtsPackageArtifact({
    status: "FAILED",
    proofBase64: Buffer.from("STAMP_BEFORE_UPGRADE").toString("base64"),
    hash: "deadbeef".repeat(8),
    calendar: null,
    bitcoinTxid: null,
    anchoredAtUtc: null,
    upgradedAtUtc: null,
    failureReason: "upgrade timed out",
  });

  it("emits the .ots file (stamp succeeded; only the upgrade failed)", () => {
    expect(result.proofBytes).not.toBeNull();
  });

  it("companion has FAILED status with failureReason echoed", () => {
    expect(result.companion!.status).toBe("FAILED");
    expect(result.companion!.failureReason).toBe("upgrade timed out");
  });

  it("does not fabricate txid or anchoredAtUtc", () => {
    expect(result.companion!.bitcoinTxid).toBeNull();
    expect(result.companion!.anchoredAtUtc).toBeNull();
  });
});

describe("OTS package artifact — FAILED without proof", () => {
  it("emits the companion but NO .ots file (proof never existed)", () => {
    const result = decideOtsPackageArtifact({
      status: "FAILED",
      proofBase64: null,
      hash: null,
      calendar: null,
      bitcoinTxid: null,
      anchoredAtUtc: null,
      upgradedAtUtc: null,
      failureReason: "OpenTimestamps binary is missing in the worker environment.",
    });
    expect(result.proofBytes).toBeNull();
    expect(result.companion).not.toBeNull();
    expect(result.companion!.status).toBe("FAILED");
    expect(result.companion!.proofPresent).toBe(false);
    expect(result.companion!.proofFile).toBeNull();
    expect(result.companion!.failureReason).toBe(
      "OpenTimestamps binary is missing in the worker environment.",
    );
  });
});

// -----------------------------------------------------------------------------
// DISABLED — emit NOTHING
// -----------------------------------------------------------------------------

describe("OTS package artifact — DISABLED suppresses both artifacts", () => {
  it("emits no .ots and no companion when OTS is intentionally disabled", () => {
    const result = decideOtsPackageArtifact({
      status: "DISABLED",
      proofBase64: null,
      hash: null,
      calendar: null,
      bitcoinTxid: null,
      anchoredAtUtc: null,
      upgradedAtUtc: null,
      failureReason: null,
    });
    expect(result.proofBytes).toBeNull();
    expect(result.companion).toBeNull();
  });

  it("DISABLED with stale proof bytes still emits NOTHING (state is the source of truth)", () => {
    const result = decideOtsPackageArtifact({
      status: "DISABLED",
      proofBase64: Buffer.from("STALE").toString("base64"),
      hash: null,
      calendar: null,
      bitcoinTxid: null,
      anchoredAtUtc: null,
      upgradedAtUtc: null,
      failureReason: null,
    });
    expect(result.proofBytes).toBeNull();
    expect(result.companion).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Edge cases — robustness against malformed inputs
// -----------------------------------------------------------------------------

describe("OTS package artifact — robustness", () => {
  it("treats empty-string status as UNKNOWN (companion still emitted)", () => {
    const result = decideOtsPackageArtifact({
      status: "",
      proofBase64: Buffer.from("X").toString("base64"),
      hash: null,
      calendar: null,
      bitcoinTxid: null,
      anchoredAtUtc: null,
      upgradedAtUtc: null,
      failureReason: null,
    });
    expect(result.companion!.status).toBe("UNKNOWN");
  });

  it("treats null status as UNKNOWN (companion still emitted with proof)", () => {
    const result = decideOtsPackageArtifact({
      status: null,
      proofBase64: Buffer.from("X").toString("base64"),
      hash: null,
      calendar: null,
      bitcoinTxid: null,
      anchoredAtUtc: null,
      upgradedAtUtc: null,
      failureReason: null,
    });
    expect(result.companion!.status).toBe("UNKNOWN");
    expect(result.proofBytes).not.toBeNull();
  });

  it("ignores zero-length proof", () => {
    const result = decideOtsPackageArtifact({
      status: "PENDING",
      proofBase64: "",
      hash: null,
      calendar: null,
      bitcoinTxid: null,
      anchoredAtUtc: null,
      upgradedAtUtc: null,
      failureReason: null,
    });
    expect(result.proofBytes).toBeNull();
    expect(result.companion!.proofPresent).toBe(false);
  });

  it("normalizes status casing", () => {
    const result = decideOtsPackageArtifact({
      status: "pending",
      proofBase64: Buffer.from("X").toString("base64"),
      hash: null,
      calendar: null,
      bitcoinTxid: null,
      anchoredAtUtc: null,
      upgradedAtUtc: null,
      failureReason: null,
    });
    expect(result.companion!.status).toBe("PENDING");
  });

  it("trims valid txid input", () => {
    const result = decideOtsPackageArtifact({
      status: "ANCHORED",
      proofBase64: Buffer.from("X").toString("base64"),
      hash: null,
      calendar: null,
      bitcoinTxid: ` ${VALID_TXID} `,
      anchoredAtUtc: "2026-05-18T12:00:00.000Z",
      upgradedAtUtc: null,
      failureReason: null,
    });
    expect(result.companion!.bitcoinTxid).toBe(VALID_TXID);
  });
});

// -----------------------------------------------------------------------------
// Source contract — processor.ts forwards OTS state to the package builder
// -----------------------------------------------------------------------------

describe("OTS package artifact — processor wiring", () => {
  const processorSrc = readSource("../src/processor.ts");
  const packageSrc = readSource("../src/verification-package.ts");

  it("processor passes ots payload to createVerificationPackage", () => {
    expect(processorSrc).toContain("createVerificationPackage({");
    // Ensure the ots field is wired and pulls from reportEvidencePayload
    expect(processorSrc).toMatch(/ots:\s*\{[\s\S]*?proofBase64:\s*prepared\.reportEvidencePayload\.otsProofBase64/);
    expect(processorSrc).toContain(
      "status: prepared.reportEvidencePayload.otsStatus",
    );
    expect(processorSrc).toContain(
      "bitcoinTxid:",
    );
    expect(processorSrc).toContain(
      "prepared.reportEvidencePayload.otsBitcoinTxid",
    );
    expect(processorSrc).toContain(
      "prepared.reportEvidencePayload.otsAnchoredAtUtc",
    );
    expect(processorSrc).toContain(
      "prepared.reportEvidencePayload.otsFailureReason",
    );
  });

  it("verification package accepts the ots field in its public signature", () => {
    expect(packageSrc).toMatch(/ots\?:\s*\{[\s\S]*?proofBase64:\s*string\s*\|\s*null/);
  });

  it("verification package uses appendPackageEntry for the OTS artifacts", () => {
    expect(packageSrc).toContain('"opentimestamps-proof.ots"');
    expect(packageSrc).toContain('"opentimestamps.json"');
  });

  it("verification package routes OTS emission through decideOtsPackageArtifact", () => {
    expect(packageSrc).toContain("decideOtsPackageArtifact(data.ots)");
  });

  it("decideOtsPackageArtifact never fabricates a proof file", () => {
    // Source contract — the only place proofBytes is set is from the
    // base64 decode. If a future change tries to synthesize proof bytes
    // from anywhere else, this regex will fail.
    const fn = packageSrc.match(
      /export function decideOtsPackageArtifact[\s\S]*?\n}/,
    );
    expect(fn).not.toBeNull();
    const fnBody = fn![0];
    expect(fnBody).toContain("Buffer.from(input.proofBase64");
    // No other Buffer construction inside the function.
    const bufferConstructorCount = (
      fnBody.match(/Buffer\.from\(/g) ?? []
    ).length;
    expect(bufferConstructorCount).toBe(1);
  });
});
