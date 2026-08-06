/**
 * Phase IA-forward-path — latest-truth selection contract.
 *
 * After the OTS classifier promotes a row to ANCHORED, the upgrade
 * processor enqueues a report regen with
 * `forceRegenerate: true, regenerateReason: "ots_anchored"`. The
 * downstream consumers of that regen MUST:
 *
 *   1. The report processor MUST honour `forceRegenerate` — without
 *      that bypass the "evidence is already REPORTED" guard short-
 *      circuits the regen and the old version stays canonical.
 *   2. The report/package read sites MUST use
 *      `findFirst` + `orderBy: { version: "desc" }` so the moment v+1
 *      lands it becomes the canonical truth — no separate cutover.
 *   3. The public-verify / report / package endpoints all read the
 *      latest version using the same selection, so a regen-after-OTS-
 *      anchored is visible everywhere at once.
 *
 * These probes prove no caller is reading via a stale heuristic
 * (latest = createdAt desc, latest = the report with `isLatest = true`,
 * etc.) that would freeze the public surface at the pre-anchored
 * snapshot.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  CANONICAL_PAYLOAD_KEYS,
  FORBIDDEN_PAYLOAD_AUTHORITY_FIELDS,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("Phase IA-forward-path — report processor honours forceRegenerate", () => {
  const PROCESSOR = readSource("../../worker/src/processor.ts");

  /**
   * PHASE 12 — POINT 5 INVERTED these two assertions, and the inversion is the
   * point of the phase.
   *
   * `forceRegenerate` is not a parameter. It is the OUTCOME OF AN
   * AUTHORIZATION DECISION — the flag that lets the worker bypass the guard
   * refusing to overwrite an already-REPORTED artifact — and it was arriving
   * as an unverified boolean on a BullMQ payload. Anything able to write to
   * Redis could set it, and the worker would replace a finalised evidentiary
   * artifact on its word.
   *
   * So "reads forceRegenerate from job.data" is now the thing that must NEVER
   * be true. The behaviour it guarded is unchanged: the early-return guard
   * still consults the flag, but the flag is loaded from the durable
   * `ReportGenerationRequest` row that an authorized synchronous path
   * committed.
   */
  it("NEVER reads forceRegenerate from job.data — it is loaded from the durable request", () => {
    expect(PROCESSOR).not.toMatch(/job\.data\.forceRegenerate/);
    expect(PROCESSOR).not.toMatch(/job\.data\.regenerateReason/);
    // The authority: resolved from the request row before the generator runs.
    expect(PROCESSOR).toMatch(/resolveAndClaimReportRequest\(/);
    expect(PROCESSOR).toMatch(
      /const forceRegenerate = command\.forceRegenerate/,
    );
    // And the guard it feeds is untouched.
    expect(PROCESSOR).toMatch(
      /evidence\.status\s*===\s*EvidenceStatus\.REPORTED\s*&&\s*!forceRegenerate/,
    );
  });

  it("forceRegenerate cannot appear on a canonical queue payload at all", () => {
    // Belt and braces: the strict decoder refuses it by name, so even a
    // producer that tried to smuggle it back would be rejected before any DB
    // access rather than silently sanitised.
    expect(FORBIDDEN_PAYLOAD_AUTHORITY_FIELDS).toContain("forceRegenerate");
    expect(CANONICAL_PAYLOAD_KEYS).not.toContain("forceRegenerate");
  });

  it("the regenerate reason is bounded and comes from the durable request", () => {
    expect(PROCESSOR).toMatch(
      /const regenerateReason = command\.regenerateReason/,
    );
  });

  it("logs the regenerating status when forceRegenerate is true", () => {
    expect(PROCESSOR).toMatch(/status:\s*forceRegenerate\s*\?\s*"regenerating"\s*:\s*"started"/);
  });
});

describe("Phase IA-forward-path — every report/package read site selects the LATEST version", () => {
  const ROUTES = readSource("../src/routes/evidence.routes.ts");

  it("every prisma.report.findFirst call orders by version desc", () => {
    // Capture each findFirst against the report table along with the
    // following ~12 lines and assert the orderBy lands inside that
    // window. There is no findFirst+createAt-desc on reports anywhere
    // in evidence.routes.ts.
    const sites = [
      ...ROUTES.matchAll(
        /prisma\.report\.findFirst\(\{[\s\S]{0,1200}?orderBy:\s*\{\s*version:\s*"desc"\s*\}/g,
      ),
    ];
    // There are several distinct call sites (evidence header, public
    // verify, latest probe). All must use the version-desc selection.
    expect(sites.length).toBeGreaterThanOrEqual(4);
  });

  it("no prisma.report.findFirst orders by createdAt — that would freeze on a delayed regen write", () => {
    expect(ROUTES).not.toMatch(
      /prisma\.report\.findFirst\(\{[\s\S]{0,1200}?orderBy:\s*\{\s*createdAt/,
    );
  });

  it("every prisma.verificationPackage.findFirst call orders by version desc", () => {
    const sites = [
      ...ROUTES.matchAll(
        /prisma\.verificationPackage\.findFirst\(\{[\s\S]{0,1200}?orderBy:\s*\{\s*version:\s*"desc"\s*\}/g,
      ),
    ];
    expect(sites.length).toBeGreaterThanOrEqual(3);
  });

  it("no prisma.verificationPackage.findFirst orders by createdAt", () => {
    // Walk each call site individually: split the source on
    // `prisma.verificationPackage.findFirst(` and assert that the
    // SECOND token of each split (the call body, up to the next `})`)
    // contains an orderBy version-desc and NOT createdAt. We do this
    // explicitly because a regex with `[\s\S]{0,N}?` can leak past the
    // closing `})` of one findFirst and pick up the orderBy of an
    // adjacent findFirst (e.g. verificationView right after).
    const pieces = ROUTES.split("prisma.verificationPackage.findFirst(");
    expect(pieces.length).toBeGreaterThan(1);
    for (let i = 1; i < pieces.length; i += 1) {
      // The call body ends at the first `})` that balances out — we
      // approximate it as "up to the next 600 chars" which is enough
      // for any of the 4 call sites in this file.
      const body = pieces[i]!.slice(0, 600);
      expect(body, `verificationPackage.findFirst call #${i} body`).toMatch(
        /orderBy:\s*\{\s*version:\s*"desc"\s*\}/,
      );
      // The body's orderBy clause must NOT order by createdAt.
      const orderByMatch = body.match(/orderBy:\s*\{[^}]+\}/);
      expect(orderByMatch?.[0] ?? "").not.toMatch(/createdAt/);
    }
  });
});

describe("Phase IA-forward-path — OTS-anchored regen produces a version bump", () => {
  const UP = readSource("../../worker/src/ots-upgrade.processor.ts");

  it("FULLY_ANCHORED enqueues with forceRegenerate: true + regenerateReason ots_anchored", () => {
    const idx = UP.indexOf('if (classification.kind === "FULLY_ANCHORED")');
    expect(idx).toBeGreaterThan(-1);
    // Phase IA-OTS-info-fallback — widened slice (2500 → 5500) +
    // expanded inner gaps (400 → 1200) so the additional
    // custody-payload fields the info probe adds don't push
    // `enqueueReportJob` out of the matched window.
    const block = UP.slice(idx, idx + 5500);
    expect(block).toMatch(
      /enqueueReportJob\(evidenceId,\s*\{[\s\S]{0,1200}forceRegenerate:\s*true[\s\S]{0,1200}regenerateReason:\s*"ots_anchored"/,
    );
  });

  it("ANCHOR_MATERIAL_RECOVERED (PENDING) does NOT enqueue with forceRegenerate", () => {
    // The only forceRegenerate call inside the pending branch is gated
    // on `txidRecoveredWhileAnchored` (a legacy edge case: ANCHORED row
    // discovers its txid). Bare ANCHOR_MATERIAL_RECOVERED / STILL_PENDING
    // must NOT trigger a regen.
    const branchIdx = UP.indexOf(
      'classification.kind === "ANCHOR_MATERIAL_RECOVERED"',
    );
    expect(branchIdx).toBeGreaterThan(-1);
    const block = UP.slice(branchIdx, branchIdx + 4000);
    // Within this branch, the ONLY enqueueReportJob is the legacy
    // txidRecoveredWhileAnchored one.
    const regens = block.match(/enqueueReportJob\(/g) ?? [];
    expect(regens.length).toBeLessThanOrEqual(1);
    if (regens.length === 1) {
      expect(block).toMatch(
        /if \(txidRecoveredWhileAnchored\)[\s\S]{0,400}enqueueReportJob/,
      );
    }
  });
});
