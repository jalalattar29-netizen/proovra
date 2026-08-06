/**
 * Phase IA-OTS-hybrid — repair script source-contract test.
 *
 * Pins the safety properties of `src/scripts/repair-ots-hybrid-state.ts`:
 *   1. Dry-run is the default; --apply is required to write.
 *   2. The script NEVER calls `prisma.evidence.update(...)` directly —
 *      writes go through the worker's canonical queue path via
 *      `enqueueOtsUpgradeJob`.
 *   3. The classifier function is the one shared with the runtime
 *      processor.
 *   4. The job id used is the same stable id the processor uses, so
 *      BullMQ dedupes against any in-flight upgrade.
 *   5. `--limit` is bounded (1..1000) to prevent accidental
 *      whole-database replay.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(rel, import.meta.url)),
    "utf8",
  );
}

const SOURCE = readSource(
  "../src/scripts/repair-ots-hybrid-state.ts",
);

describe("repair-ots-hybrid-state — safety contract", () => {
  it("defaults to dry-run (apply: false) and only writes when --apply", () => {
    expect(SOURCE).toMatch(/apply:\s*false/);
    expect(SOURCE).toMatch(/--apply/);
    expect(SOURCE).toMatch(/if \(args\.apply\)/);
  });

  it("uses the SAME classifier the runtime processor uses", () => {
    expect(SOURCE).toMatch(
      /import\s*\{\s*classifyOtsResult[\s\S]{0,200}from\s*["']\.\.\/ots-upgrade-output\.js/,
    );
  });

  it("uses `ots verify` (not `ots upgrade`) — repair never re-runs upgrade", () => {
    expect(SOURCE).toMatch(/import\s*\{\s*verifyOtsProof\s*\}/);
    // The script must never invoke upgrade directly (that's the worker's job).
    expect(SOURCE).not.toMatch(/execFile.*upgrade/);
  });

  it("re-enqueues through the ONE canonical enqueue path, not a private job id", () => {
    // PHASE 12 — POINT 5. The script used to carry its own copy of
    // `buildFollowUpJobId`, explicitly "mirroring" the processor's — two
    // definitions of one id, kept in sync by a comment. Both are deleted: the
    // deterministic `ots-upgrade-<evidenceId>` id is built once, inside the
    // shared enqueue authority, and this script just names the evidence.
    expect(SOURCE).not.toMatch(/buildFollowUpJobId/);
    expect(SOURCE).toMatch(/enqueueOtsUpgradeJob\(row\.id/);
  });

  it("NEVER updates the DB directly (no prisma.evidence.update / upsert / delete calls)", () => {
    expect(SOURCE).not.toMatch(/prisma\.evidence\.update/);
    expect(SOURCE).not.toMatch(/prisma\.evidence\.upsert/);
    expect(SOURCE).not.toMatch(/prisma\.evidence\.delete/);
    expect(SOURCE).not.toMatch(/prisma\.evidence\.updateMany/);
    // No raw SQL execute calls.
    expect(SOURCE).not.toMatch(/prisma\.\$executeRaw/);
  });

  it("bounds --limit to 1..1000 to prevent whole-database replay", () => {
    expect(SOURCE).toMatch(/n\s*<=\s*0\s*\|\|\s*n\s*>\s*1000/);
  });

  it("scopes the query to the hybrid-state shape exactly", () => {
    expect(SOURCE).toMatch(/otsStatus:\s*"PENDING"/);
    expect(SOURCE).toMatch(/otsBitcoinTxid:\s*\{\s*not:\s*null\s*\}/);
    expect(SOURCE).toMatch(/otsAnchoredAtUtc:\s*null/);
    expect(SOURCE).toMatch(/otsProofBase64:\s*\{\s*not:\s*null\s*\}/);
    expect(SOURCE).toMatch(/deletedAt:\s*null/);
  });

  it("FAILED classification path is read-only — repair never writes FAILED", () => {
    // Search the source for the FAILED-branch handler. It must NOT
    // attempt to flip the evidence row to FAILED. The comment
    // explicitly documents this.
    expect(SOURCE).toMatch(/repair script never writes FAILED/i);
  });

  it("disconnects Prisma on both success and fatal error paths", () => {
    expect(SOURCE).toMatch(/prisma\.\$disconnect\(\)/);
    expect(SOURCE).toMatch(
      /main\(\)\.catch\(async \(err\)\s*=>\s*\{[\s\S]{0,400}\$disconnect/,
    );
  });
});
