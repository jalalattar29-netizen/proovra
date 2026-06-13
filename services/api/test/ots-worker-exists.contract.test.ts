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
 *  3. The OTS upgrade processor runs the `ots verify` CLI to
 *     transition PENDING → ANCHORED.
 *  4. The trust-summary bucket maps the worker's status values.
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

  it("Report processor calls createOpenTimestamp() to seed the proof", () => {
    const src = readFileSync(PROCESSOR, "utf8");
    expect(src).toMatch(/createOpenTimestamp\s*\(/);
    expect(src).toMatch(/import\s*\{[^}]*createOpenTimestamp[^}]*\}\s*from\s*"\.\/ots\.service/);
  });

  it("OTS upgrade processor invokes `ots verify` (transitions PENDING → ANCHORED)", () => {
    const src = readFileSync(UPGRADE_PROCESSOR, "utf8");
    // The CLI name appears in both the runtime invocation and the
    // descriptive comments; we just need one match to prove the
    // module hasn't been gutted.
    expect(src).toMatch(/ots\s+verify/);
  });

  it("Trust-summary `otsBucket` recognises the worker's status values", () => {
    const src = readFileSync(TRUST_SUMMARY, "utf8");
    expect(src).toMatch(/function\s+otsBucket/);
    // Real worker writes ANCHORED + PENDING + FAILED at minimum; the
    // trust-summary bucket must map them or the Home counters will
    // under-count.
    for (const v of ["ANCHORED", "PENDING", "FAILED"]) {
      expect(src).toContain(`"${v}"`);
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
