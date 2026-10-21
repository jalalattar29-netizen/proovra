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
import { enclosingSource } from "../../../scripts/source-contract/index.mjs";
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
    // And the decision it feeds: only a durable forceRegenerate mints a new
    // report on a REPORTED record; without it, the run completes the pair for
    // the existing report (package-only), never a second report.
    expect(PROCESSOR).toMatch(
      /\} else if \(forceRegenerate\) \{\s*runMode = "NEW_REPORT";\s*\} else if \(evidence\.status === EvidenceStatus\.REPORTED\) \{/,
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
      // The call body is the whole `findFirst(…)` call, as parsed
      // (WCC-NEW-027) — never a character window that could run on into an
      // adjacent call. Split token i is occurrence i - 1 of the marker.
      const body = enclosingSource(ROUTES, "prisma.verificationPackage.findFirst(", "call", {
        occurrence: i - 1,
        fileName: "evidence.routes.ts",
      });
      /*
       * RELIABILITY CLOSURE (2026-09-09) — a call that PINS a version is not
       * selecting the latest one, and must not be asked to order.
       *
       * The historical-download routes read `where: { evidenceId, version }`,
       * where `version` is the number the caller asked for. Ordering there
       * would be meaningless — the predicate already identifies exactly one
       * row — and requiring it would be requiring the wrong thing. The
       * invariant this test exists for is unchanged and still enforced for
       * every call that does NOT pin a version: a read of "the latest" must
       * order by version desc, so a delayed regeneration write cannot freeze
       * the page on v1.
       */
      // (2026-10-07) The where may be wrapped in the canonical package predicate
      // (`primaryPublishedPackageWhere({...})`, `publishedProfilePackageWhere("X", {...})`);
      // the pin is read inside it the same way.
      const pinsAnExactVersion =
        /where:\s*(?:(?:primaryPublished|published|publishedProfile)PackageWhere\((?:"[A-Z_]+",\s*)?)?\{[^}]*\bversion\b\s*[,}]/.test(body);
      if (pinsAnExactVersion) continue;
      expect(body, `verificationPackage.findFirst call #${i} body`).toMatch(
        /orderBy:\s*\{\s*version:\s*"desc"\s*\}/,
      );
      // The body's orderBy clause must NOT order by createdAt.
      const orderByMatch = body.match(/orderBy:\s*\{[^}]+\}/);
      expect(orderByMatch?.[0] ?? "").not.toMatch(/createdAt/);
    }
  });
});

describe("Phase IA-forward-path — a CHAIN-VERIFIED proof gets exactly one automatic version (2026-10-15)", () => {
  const UP = readSource("../../worker/src/ots-upgrade.processor.ts");
  const VERSION = readSource("../../worker/src/ots-anchored-version.ts");

  it("only an independent chain VERIFIED runs the downstream version decision; nothing else in the processor requests a report", () => {
    // SUPERSEDES Decision C (2026-09-29): the product contract now issues ONE
    // automatic report + package version when the latest report stated a
    // not-yet-anchored proof — through the existing versioning, idempotent per
    // proof, previous versions preserved, no charge.
    // REVISED 2026-10-15: a recorded attestation (ANCHORED, not independently
    // checked) is not a new verifiable fact; the version follows the Bitcoin
    // main-chain check only.
    expect(UP).toMatch(/if \(transition\.anchoring\.verification === "CHAIN_VERIFIED"\) \{\s*await requestChainVerifiedReportVersion\(/);
    expect(UP).not.toMatch(/requestAnchoredReportVersion\(/);
    expect(UP).not.toMatch(/enqueueReportJob\(|requestReportGenerationFromWorker\(|forceRegenerate:/);
  });

  it("the decision is idempotent per proof and goes through the existing request authority", () => {
    // F-10 (independent forward audit): the first request uses the proof key;
    // a technically failed one is re-asked under the next retry key.
    expect(VERSION).toMatch(/clientRequestKey: requestKey/);
    expect(VERSION).toMatch(/otsChainVerifiedRetryKey(/);
    expect(VERSION).toMatch(/ots-chain-verified:\$\{proof\}:\$\{block\}/);
    expect(VERSION).toMatch(/createReportGenerationRequest\(prisma, \{/);
    expect(VERSION).toMatch(/purpose: "ots_upgrade_completed"/);
    expect(VERSION).toMatch(/latest_report_chain_verified/);
    expect(VERSION).toMatch(/not_chain_verified/);
    expect(VERSION).toMatch(/no_report_yet/);
  });
});
