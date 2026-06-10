/**
 * Phase IA-OTS-info-fallback — runtime forward-path contract tests.
 *
 * Pins the `ots info` parser + the classifier branch that promotes a
 * PENDING + bitcoinTxid row to FULLY_ANCHORED when:
 *
 *   * `ots verify` fails because the container has no local Bitcoin RPC
 *     ("Could not connect to Bitcoin node: /home/app/.bitcoin/.cookie
 *     missing"),
 *   * AND `ots info` parses an embedded BitcoinBlockHeaderAttestation,
 *   * AND the embedded `File sha256 hash` matches `evidence.otsHash`,
 *   * AND a Bitcoin txid is known (from upgrade output, info output,
 *     or the persisted DB column).
 *
 * Strict-rules invariants pinned (each test below):
 *
 *   1. info with matching hash + txid + BitcoinBlockHeaderAttestation
 *      → FULLY_ANCHORED.
 *   2. info with txid but no BitcoinBlockHeaderAttestation
 *      → NOT promoted (remains ANCHOR_MATERIAL_RECOVERED / STILL_PENDING).
 *   3. info with BitcoinBlockHeaderAttestation but wrong file hash
 *      → NOT promoted (defensive: proof bytes don't belong to this
 *      evidence).
 *   4. verify fails (no Bitcoin node) + info confirms anchor
 *      → FULLY_ANCHORED via info branch.
 *   5. Processor enqueues report regen ONLY in the FULLY_ANCHORED arm
 *      (source-contract grep).
 *   6. Processor never re-enqueues a follow-up after FULLY_ANCHORED
 *      (source-contract grep).
 *   7. The ACTIVE report generation path (`report-v2/build-report-pdf.ts`)
 *      does NOT import the legacy `pdf/report.ts`.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  classifyOtsResult,
  parseOtsInfoOutput,
  parseOtsUpgradeOutput,
  parseOtsVerifyOutput,
} from "../src/ots-upgrade-output.js";

// The exact runtime values from the operator brief, used as the
// "current production evidence" shape throughout.
const TXID =
  "5d1156f9a225bdb60a59f79adff076dd4ffc079d05e133d689afc3495a12a756";
const EVIDENCE_HASH =
  "21d709d333031b30f2f080769ec0c9e09947b0e2e5d4e386a1a0e03b866aca6f";
const BLOCK_HEIGHT = 953006;

// Synthetic `ots info` outputs covering each scenario the operator
// brief specifies. The shapes follow what the OpenTimestamps CLI
// actually emits.
const INFO_FULLY_ANCHORED = `File sha256 hash: ${EVIDENCE_HASH}
Timestamp:
prepend 5e80a16d18cfc1ee
sha256
append 17b66cd5d4ce42b3
sha256
prepend 7e64f15c0bd9b4
sha256
Transaction id ${TXID}
-> BitcoinBlockHeaderAttestation(${BLOCK_HEIGHT})`;

const INFO_TXID_BUT_NO_BLOCK = `File sha256 hash: ${EVIDENCE_HASH}
Timestamp:
prepend 5e80a16d18cfc1ee
sha256
Transaction id ${TXID}
-> PendingAttestation('https://a.pool.opentimestamps.org')
-> PendingAttestation('https://b.pool.opentimestamps.org')`;

const INFO_BLOCK_BUT_WRONG_HASH = `File sha256 hash: deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef
Timestamp:
prepend 5e80a16d18cfc1ee
sha256
Transaction id ${TXID}
-> BitcoinBlockHeaderAttestation(${BLOCK_HEIGHT})`;

const INFO_ONLY_PENDING = `File sha256 hash: ${EVIDENCE_HASH}
Timestamp:
prepend 5e80a16d18cfc1ee
sha256
-> PendingAttestation('https://a.pool.opentimestamps.org')`;

// The actual stderr the operator captured from the container.
const VERIFY_STDERR_NO_BITCOIN_NODE =
  "Could not connect to Bitcoin node: /home/app/.bitcoin/.cookie missing";

// ============================================================================
// parseOtsInfoOutput — direct unit coverage
// ============================================================================

describe("Phase IA-OTS-info-fallback — parseOtsInfoOutput", () => {
  it("extracts File sha256 hash, txid, all BitcoinBlockHeaderAttestation heights, and PendingAttestation calendars", () => {
    const out = parseOtsInfoOutput(INFO_FULLY_ANCHORED);
    expect(out.fileHash).toBe(EVIDENCE_HASH);
    expect(out.txid).toBe(TXID);
    expect(out.bitcoinBlockHeights).toEqual([BLOCK_HEIGHT]);
    expect(out.pendingCalendars).toEqual([]);
  });

  it("captures every BitcoinBlockHeaderAttestation when the proof has multiple", () => {
    const text = `File sha256 hash: ${EVIDENCE_HASH}
-> BitcoinBlockHeaderAttestation(800001)
-> BitcoinBlockHeaderAttestation(953006)`;
    const out = parseOtsInfoOutput(text);
    expect(out.bitcoinBlockHeights).toEqual([800001, 953006]);
  });

  it("captures every PendingAttestation calendar URL", () => {
    const out = parseOtsInfoOutput(INFO_TXID_BUT_NO_BLOCK);
    expect(out.pendingCalendars).toEqual([
      "https://a.pool.opentimestamps.org",
      "https://b.pool.opentimestamps.org",
    ]);
  });

  it("returns null fileHash when the line is absent (corrupt or stripped output)", () => {
    const out = parseOtsInfoOutput("Timestamp:\nprepend 5e80a16d18cfc1ee");
    expect(out.fileHash).toBeNull();
  });

  it("accepts the alternative `Bitcoin transaction:` shape some clients emit", () => {
    const text = `File sha256 hash: ${EVIDENCE_HASH}
Bitcoin transaction: ${TXID}
-> BitcoinBlockHeaderAttestation(${BLOCK_HEIGHT})`;
    const out = parseOtsInfoOutput(text);
    expect(out.txid).toBe(TXID);
  });

  it("normalizes the file hash to lowercase for direct comparison with evidence.otsHash", () => {
    const text = `File sha256 hash: ${EVIDENCE_HASH.toUpperCase()}
-> BitcoinBlockHeaderAttestation(${BLOCK_HEIGHT})`;
    const out = parseOtsInfoOutput(text);
    expect(out.fileHash).toBe(EVIDENCE_HASH);
  });
});

// ============================================================================
// classifyOtsResult — info-confirms branch
// ============================================================================

describe("Phase IA-OTS-info-fallback — classifier info-confirms branch", () => {
  // Scenario 1 (from operator brief).
  it("info with matching hash + txid + BitcoinBlockHeaderAttestation → FULLY_ANCHORED via anchored_via_info", () => {
    const upgrade = parseOtsUpgradeOutput(
      "",
      `Bitcoin transaction: ${TXID}\nPending confirmation in Bitcoin blockchain`,
    );
    const verify = parseOtsVerifyOutput("", VERIFY_STDERR_NO_BITCOIN_NODE);
    const info = parseOtsInfoOutput(INFO_FULLY_ANCHORED);

    const result = classifyOtsResult({
      upgrade,
      verify,
      info,
      expectedFileHashHex: EVIDENCE_HASH,
      existingTxid: null,
      commandErrored: false,
    });

    expect(result.kind).toBe("FULLY_ANCHORED");
    expect(result.phase).toBe("anchored_via_info");
    expect(result.blockHeight).toBe(BLOCK_HEIGHT);
    // anchoredAtUtc is null on this branch — the processor falls
    // back to `upgradedAt` per the operator spec.
    expect(result.anchoredAtUtc).toBeNull();
    expect(result.txid).toBe(TXID);
    expect(result.reason).toMatch(/ots info confirmed Bitcoin block 953006/);
  });

  // Scenario 2 (from operator brief).
  it("info with txid but no BitcoinBlockHeaderAttestation → NOT promoted (remains ANCHOR_MATERIAL_RECOVERED)", () => {
    const verify = parseOtsVerifyOutput("", VERIFY_STDERR_NO_BITCOIN_NODE);
    const info = parseOtsInfoOutput(INFO_TXID_BUT_NO_BLOCK);

    const result = classifyOtsResult({
      upgrade: parseOtsUpgradeOutput("", ""),
      verify,
      info,
      expectedFileHashHex: EVIDENCE_HASH,
      existingTxid: TXID,
      commandErrored: false,
    });

    expect(result.kind).not.toBe("FULLY_ANCHORED");
    expect(result.kind).toBe("ANCHOR_MATERIAL_RECOVERED");
  });

  // Scenario 3 (from operator brief).
  it("info with BitcoinBlockHeaderAttestation but wrong file hash → NOT promoted", () => {
    const verify = parseOtsVerifyOutput("", VERIFY_STDERR_NO_BITCOIN_NODE);
    const info = parseOtsInfoOutput(INFO_BLOCK_BUT_WRONG_HASH);

    const result = classifyOtsResult({
      upgrade: parseOtsUpgradeOutput("", ""),
      verify,
      info,
      expectedFileHashHex: EVIDENCE_HASH,
      existingTxid: TXID,
      commandErrored: false,
    });

    expect(result.kind).not.toBe("FULLY_ANCHORED");
    // Falls through to ANCHOR_MATERIAL_RECOVERED because the
    // persisted txid is still defensible — it's only the proof
    // bytes that don't match this evidence.
    expect(result.kind).toBe("ANCHOR_MATERIAL_RECOVERED");
  });

  // Scenario 4 (from operator brief): the exact runtime case.
  it("verify fails due to missing Bitcoin node + info anchored → ANCHORED", () => {
    // Replicates the operator's runtime stderr: verify exits non-zero
    // and prints the .cookie-missing message. The classifier sees
    // verify=null (the processor passes null for non-VERIFIED/
    // INCOMPLETE statuses) AND info confirms the anchor.
    const result = classifyOtsResult({
      upgrade: parseOtsUpgradeOutput(
        "",
        `Bitcoin transaction: ${TXID}\nPending confirmation in Bitcoin blockchain`,
      ),
      verify: null, // verify call returned ERROR upstream
      info: parseOtsInfoOutput(INFO_FULLY_ANCHORED),
      expectedFileHashHex: EVIDENCE_HASH,
      existingTxid: null,
      commandErrored: false,
    });

    expect(result.kind).toBe("FULLY_ANCHORED");
    expect(result.phase).toBe("anchored_via_info");
    expect(result.blockHeight).toBe(BLOCK_HEIGHT);
    expect(result.txid).toBe(TXID);
  });

  // Additional defensive cases.
  it("info has only PendingAttestation (no block attestation, no txid) + verify INCOMPLETE → STILL_PENDING", () => {
    const result = classifyOtsResult({
      upgrade: parseOtsUpgradeOutput("", "Pending confirmations"),
      verify: parseOtsVerifyOutput("", "Calendar attestation incomplete"),
      info: parseOtsInfoOutput(INFO_ONLY_PENDING),
      expectedFileHashHex: EVIDENCE_HASH,
      existingTxid: null,
      commandErrored: false,
    });
    expect(result.kind).toBe("STILL_PENDING");
  });

  it("info with matching hash + block but NO txid available anywhere → NOT promoted (strict rule)", () => {
    // Construct an info output that has the file hash + block height
    // but no txid line, AND no txid is fresh on upgrade or persisted.
    const text = `File sha256 hash: ${EVIDENCE_HASH}
-> BitcoinBlockHeaderAttestation(${BLOCK_HEIGHT})`;
    const result = classifyOtsResult({
      upgrade: parseOtsUpgradeOutput("", ""),
      verify: null,
      info: parseOtsInfoOutput(text),
      expectedFileHashHex: EVIDENCE_HASH,
      existingTxid: null,
      commandErrored: false,
    });
    expect(result.kind).not.toBe("FULLY_ANCHORED");
    // The branch requires a defensible txid (strict rule "do NOT
    // anchor from txid alone" implies txid + block + hash; without
    // txid we cannot anchor).
    expect(result.kind).toBe("STILL_PENDING");
  });

  it("verify SUCCESS still wins when info also confirms (verify is the canonical signal)", () => {
    const verify = parseOtsVerifyOutput(
      "",
      `Bitcoin block 953006 attests existence as of 2026-06-09 23:00:00 UTC\nSuccess!`,
    );
    const result = classifyOtsResult({
      upgrade: parseOtsUpgradeOutput("", `Bitcoin transaction: ${TXID}`),
      verify,
      info: parseOtsInfoOutput(INFO_FULLY_ANCHORED),
      expectedFileHashHex: EVIDENCE_HASH,
      existingTxid: null,
      commandErrored: false,
    });
    expect(result.kind).toBe("FULLY_ANCHORED");
    // The phase should be the verify-side "anchored", not
    // "anchored_via_info", because verify won.
    expect(result.phase).toBe("anchored");
  });
});

// ============================================================================
// Source-contract: processor wiring
// ============================================================================

describe("Phase IA-OTS-info-fallback — processor source contract", () => {
  function readProcessor(): string {
    return readFileSync(
      fileURLToPath(
        new URL("../src/ots-upgrade.processor.ts", import.meta.url),
      ),
      "utf8",
    );
  }

  it("processor calls getOtsProofInfo and passes the parsed info + expectedFileHashHex to the classifier", () => {
    const src = readProcessor();
    expect(src).toMatch(/getOtsProofInfo\s*\(\s*\{\s*proofBase64\s*\}/);
    expect(src).toMatch(
      /classifyOtsResult\(\{[\s\S]{0,400}info,[\s\S]{0,200}expectedFileHashHex:\s*evidence\.otsHash/,
    );
  });

  it("processor records `anchored_via_info` phase in the custody payload when classifier returns that phase", () => {
    const src = readProcessor();
    expect(src).toMatch(/classification\.phase === "anchored_via_info"/);
    expect(src).toMatch(/"ots_info_no_verify_available"/);
  });

  it("report regen is gated to the FULLY_ANCHORED branch only (no `ots_anchored` regen on ANCHOR_MATERIAL_RECOVERED)", () => {
    const src = readProcessor();
    const fullAnchoredBranch = src.indexOf(
      'if (classification.kind === "FULLY_ANCHORED")',
    );
    expect(fullAnchoredBranch).toBeGreaterThan(-1);
    const otsAnchoredRegenIdx = src.indexOf(
      'regenerateReason: "ots_anchored"',
    );
    expect(otsAnchoredRegenIdx).toBeGreaterThan(fullAnchoredBranch);
  });

  it("FULLY_ANCHORED branch returns BEFORE any enqueueOtsUpgradeJob (no follow-up after ANCHORED)", () => {
    const src = readProcessor();
    // The "ots.upgrade.anchored" log line is the last statement in
    // the FULLY_ANCHORED arm; the return; immediately follows.
    const anchoredLogRet = src.search(
      /"ots\.upgrade\.anchored"\s*\)\s*;\s*return;/,
    );
    expect(anchoredLogRet).toBeGreaterThan(-1);
  });
});

// ============================================================================
// Source-contract: ACTIVE report path does NOT import legacy pdf/report.ts
// ============================================================================

describe("Phase IA-OTS-info-fallback — legacy PDF code is not on the active path", () => {
  it("report-v2/build-report-pdf.ts does NOT import from ../pdf/report.js", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL("../src/report-v2/build-report-pdf.ts", import.meta.url),
      ),
      "utf8",
    );
    // Imports the signer (`../pdf/signPdf.js`) — allowed. Must NOT
    // import the legacy `../pdf/report.js`.
    expect(src).not.toMatch(/from\s+["']\.\.\/pdf\/report(?:\.js)?["']/);
  });

  it("no other report-v2 module imports the legacy pdf/report.ts (defense in depth)", () => {
    const files = [
      "../src/report-v2/build-view-model.ts",
      "../src/report-v2/render-html.ts",
      "../src/report-v2/render-pdf.ts",
      "../src/report-v2/truth-model.ts",
      "../src/report-v2/normalizers.ts",
      "../src/report-v2/technical-model.ts",
    ];
    for (const rel of files) {
      const src = readFileSync(
        fileURLToPath(new URL(rel, import.meta.url)),
        "utf8",
      );
      expect(
        src,
        `${rel} must not import the legacy pdf/report module`,
      ).not.toMatch(/from\s+["']\.\.\/pdf\/report(?:\.js)?["']/);
    }
  });
});

// ============================================================================
// Service-layer contracts: getOtsProofInfo wrapper shape
// ============================================================================

describe("Phase IA-OTS-info-fallback — getOtsProofInfo contract", () => {
  function readService(): string {
    return readFileSync(
      fileURLToPath(new URL("../src/ots.service.ts", import.meta.url)),
      "utf8",
    );
  }

  it("ots.service.ts exports getOtsProofInfo", () => {
    expect(readService()).toMatch(
      /export\s+async\s+function\s+getOtsProofInfo\s*\(/,
    );
  });

  it("getOtsProofInfo runs `ots info <proof.ots>` (not verify, not upgrade)", () => {
    const src = readService();
    expect(src).toMatch(/\["info",\s*proofFile\]/);
  });

  it("getOtsProofInfo returns the bounded status union { DISABLED | PARSED | BINARY_MISSING | ERROR }", () => {
    const src = readService();
    expect(src).toMatch(/status:\s*"DISABLED"/);
    expect(src).toMatch(/status:\s*"PARSED"/);
    expect(src).toMatch(/status:\s*"BINARY_MISSING"/);
    expect(src).toMatch(/status:\s*"ERROR"/);
  });

  it("getOtsProofInfo NEVER persists (no Prisma writes)", () => {
    const src = readService();
    // The wrapper writes the proof to a TEMP file (not the DB) and
    // never calls Prisma at all. Catch any future regression.
    expect(src).not.toMatch(/prisma\.[a-z]+\.(update|create|delete|upsert)/i);
  });
});

// ============================================================================
// Smoke + diagnose scripts surface the info probe
// ============================================================================

describe("Phase IA-OTS-info-fallback — operator scripts surface info output", () => {
  it("smoke-ots-retry-state.ts probes info_status / info_fileHash / info_blockHeights", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL(
          "../src/scripts/smoke-ots-retry-state.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/getOtsProofInfo/);
    expect(src).toMatch(/name: "info_status"/);
    expect(src).toMatch(/name: "info_fileHash"/);
    expect(src).toMatch(/name: "info_blockHeights"/);
    expect(src).toMatch(/name: "info_pendingCalendars"/);
  });

  it("diagnose-ots-evidence.ts runs `ots info` and reports the parsed structure", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL(
          "../src/scripts/diagnose-ots-evidence.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/\["info",\s*proofFile\]/);
    expect(src).toMatch(/step6b_post_upgrade_info/);
    expect(src).toMatch(/parsed_info\.bitcoinBlockHeights/);
    expect(src).toMatch(/file_hash_matches_expected/);
  });
});
