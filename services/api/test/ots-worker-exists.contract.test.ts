/**
 * Phase CAPTURE-HARDENING — OTS truth contract.
 *
 * BACKGROUND
 *
 * Home / Trust State / Evidence Detail / Public Verify all surface
 * `Evidence.otsStatus` to the user. Those surfaces are honest IFF a
 * real worker actually writes the column through the
 * QUEUED/PENDING/UPGRADING/ANCHORED state machine.
 *
 * The OTS pipeline lives in the `services/worker/` workspace (NOT in
 * services/api). An earlier audit that searched only the api workspace
 * concluded "OTS missing"; this test exists so that mistake — or a
 * future code drift that removes the worker — fails CI loudly,
 * forcing the responsible operator to either restore the worker or
 * remove the UI claims that depend on it.
 *
 * WHAT THIS TEST LOCKS
 *
 *  1. The OTS state-machine module exists at the canonical path.
 *  2. The report processor calls createOpenTimestamp() to seed the
 *     proof when an evidence row is sealed.
 *  3. The OTS upgrade processor decides ANCHORED through the ONE state
 *     authority (resolveOtsAnchoring over the stored proof bytes); the
 *     retired chain-verifier subsystem does not exist.
 *  4. The trust-summary bucket reads that same state.
 *  5. The Home priority's href set matches the union the worker can
 *     actually write (no aspirational values).
 *
 * If any of these tests fails, the choices are:
 *   (a) restore the missing code, OR
 *   (b) hide the OTS UI surfaces in the same PR.
 * Never silently land partial implementations.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const WORKER_DIR = resolve(REPO_ROOT, "services", "worker", "src");
const OTS_STATE = resolve(WORKER_DIR, "ots-state.ts");
const OTS_SERVICE = resolve(WORKER_DIR, "ots.service.ts");
const PROCESSOR = resolve(WORKER_DIR, "processor.ts");
const LIFECYCLE = resolve(WORKER_DIR, "ots-lifecycle.ts");
const UPGRADE_PROCESSOR = resolve(WORKER_DIR, "ots-upgrade.processor.ts");
const TRUST_SUMMARY = resolve(
  REPO_ROOT,
  "services",
  "api",
  "src",
  "services",
  "dashboard",
  "trust-summary.service.ts",
);
const HOME_VM = resolve(
  REPO_ROOT,
  "apps",
  "web",
  "components",
  "home-experience",
  "home-view-model.ts",
);

describe("OTS truth contract — UI claims must remain backed by a real worker", () => {
  it("OTS state-machine module exists in the worker workspace", () => {
    expect(existsSync(OTS_STATE)).toBe(true);
  });

  it("OTS service module exists in the worker workspace", () => {
    expect(existsSync(OTS_SERVICE)).toBe(true);
  });

  it("the integrity lifecycle calls createOpenTimestamp() to seed the proof", () => {
    /*
     * OTS INTEGRITY DECOUPLING (2026-09-09) — this read the REPORT processor.
     *
     * The claim it was defending is unchanged and is what still matters: the
     * UI may say "OpenTimestamps" only because a real worker really stamps.
     * What changed is which worker path owns that, and it had to: stamping
     * inside the report job meant only plans that include reports ever reached
     * the calendar, while Pricing lists OTS under "Every plan includes".
     */
    const src = readFileSync(LIFECYCLE, "utf8");
    expect(src).toMatch(/createOpenTimestamp\s*\(/);
    expect(src).toMatch(
      /import\s*\{[^}]*createOpenTimestamp[^}]*\}\s*from\s*"\.\/ots\.service/,
    );
    // And the commercial pipeline is no longer one of its callers.
    const report = readFileSync(PROCESSOR, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    expect(report).not.toMatch(/createOpenTimestamp/);
  });

  it("OTS upgrade processor decides ANCHORED through the one state authority; no chain verifier exists (2026-10-13)", () => {
    const src = readFileSync(UPGRADE_PROCESSOR, "utf8");
    // The stored proof, executed against the record's digest, is the only
    // thing that makes a record ANCHORED.
    expect(src).toMatch(/resolveOtsAnchoring\(/);
    expect(src).not.toMatch(/resolveOtsChainVerifier|bitcoin-node|OTS_CHAIN_VERIFIER|OTS_BITCOIN_NODE_URL/);
    expect(existsSync(resolve(WORKER_DIR, "ots-chain-verifier.ts"))).toBe(false);
  });

  it("Trust-summary `otsBucket` reads the one OTS state", () => {
    const src = readFileSync(TRUST_SUMMARY, "utf8");
    expect(src).toMatch(/function\s+otsBucket/);
    // Every bucket comes from resolveRecordOtsAnchoring over the stored proof,
    // and every state has a bucket, or the Home counters would under-count.
    expect(src).toMatch(/resolveRecordOtsAnchoring\(/);
    for (const v of ["ANCHORED", "PENDING", "FAILED", "UNAVAILABLE", "NOT_REQUESTED"]) {
      expect(src).toMatch(new RegExp(`\\b${v}:`));
    }
  });

  it("Home `ots_pending` href values are all values the worker can write", () => {
    const homeSrc = readFileSync(HOME_VM, "utf8");
    const match = /HOME_OTS_PENDING_HREF\s*=\s*"([^"]+)"/.exec(homeSrc);
    expect(match, "HOME_OTS_PENDING_HREF constant must exist").toBeTruthy();
    const href = match![1]!;
    const qs = href.split("?")[1] ?? "";
    const values = (qs.split("=")[1] ?? "").split(",").map((s) => s.trim());
    // Every value must be one the worker bucket recognises as "pending".
    // ots-state.ts and trust-summary.ts both treat these as pending.
    const acceptedPending = new Set(["PENDING", "UPGRADING", "QUEUED"]);
    for (const v of values) {
      expect(
        acceptedPending.has(v),
        `${v} must be in the pending bucket (worker writes PENDING; UPGRADING/QUEUED are transient states)`,
      ).toBe(true);
    }
  });
});
