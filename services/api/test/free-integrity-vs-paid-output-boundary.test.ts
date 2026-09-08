/**
 * WHAT A FREE RECORD ACTUALLY GETS — the integrity layer, traced rather than
 * assumed.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 * The commercial closure that made Report and Verification Package
 * `NOT_INCLUDED` on FREE was reported as leaving the integrity layer alone:
 * "evidence capture, TSA, OTS and Public Verify are all unchanged and remain
 * included". Three of those four are true. OTS is not, and it was not true
 * before that change either.
 *
 * Following the execution path rather than the product copy:
 *
 *   `createOpenTimestamp` has exactly ONE call site, inside
 *   `processGenerateReportJob`. `enqueueOtsUpgradeJob` is reached from the
 *   report job's success path and from the upgrade's own reschedule, and the
 *   upgrade processor returns immediately for a record with no stored proof.
 *
 * So OTS anchoring is reachable ONLY through report generation. A FREE record
 * has never obtained one: before the closure its report job ran, contacted the
 * calendar at the top of the job, and then threw the stamp away when the
 * entitlement gate refused a few lines later — nothing was ever persisted.
 * After the closure the job is not enqueued, and nothing is persisted either.
 * The product outcome is identical; only a pointless outbound call is gone.
 *
 * ===========================================================================
 * THE CONFLICT, STATED RATHER THAN RESOLVED
 * ===========================================================================
 * The public Pricing page carries an "Every plan includes" strip, and
 * `OpenTimestamps (OTS)` is one of its entries — placed there deliberately,
 * beside hashing, RFC 3161 timestamps, signatures and custody, under a comment
 * naming that row as "the integrity layer ... the part no tier can weaken".
 *
 * That claim and the execution path disagree, and BOTH available fixes are
 * commercial decisions rather than engineering ones:
 *
 *   (a) make OTS an independent integrity process, so a FREE record anchors
 *       while Report and Package stay NOT_INCLUDED. This adds a stamping
 *       trigger and a persistence path outside the report transaction — real
 *       work in the integrity/custody layer, and a widening of what FREE
 *       receives;
 *   (b) withdraw the promise from the strip. That is removing something a
 *       published page offers the customer.
 *
 * Neither may be taken silently, so this file takes neither. It PINS both
 * halves so the disagreement cannot quietly deepen or quietly vanish: change
 * one side and the assertion for the other side fails, naming it.
 *
 * PRODUCT_DECISION_REQUIRED — resolve (a) or (b), then update this file.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getPlanCapabilities } from "@proovra/shared-billing";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const read = (...parts: string[]) =>
  readFileSync(resolve(REPO_ROOT, ...parts), "utf8");

/** Source with comments stripped — prose must not satisfy or break a rule. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const PROCESSOR = codeOnly(read("services", "worker", "src", "processor.ts"));
const OTS_UPGRADE = codeOnly(
  read("services", "worker", "src", "ots-upgrade.processor.ts"),
);
const PRICING = read("apps", "web", "app", "pricing", "page.tsx");

// ===========================================================================
// 1. THE EXECUTION TRUTH — OTS is reached only through report generation
// ===========================================================================

describe("OTS anchoring — the execution path", () => {
  it("is stamped in exactly one place, and that place is the report job", () => {
    /*
     * If this count moves, an independent stamping path was added — which is
     * resolution (a). The Pricing assertion below then becomes correct rather
     * than aspirational, and this file should be rewritten to say so.
     */
    const calls = PROCESSOR.match(/\bcreateOpenTimestamp\(\{/g) ?? [];
    expect(
      calls.length,
      "OTS is stamped once, inside processGenerateReportJob. A second site " +
        "means an independent anchoring path now exists — see (a) above.",
    ).toBe(1);
  });

  it("the upgrade queue is fed from the report success path, not from capture", () => {
    // The enqueue helper, and the one guarded call to it after a report was
    // finalized. Nothing on the capture or finalize path reaches it.
    expect(PROCESSOR).toMatch(/scheduleOtsUpgrade\)\s*\{[\s\S]{0,120}enqueueOtsUpgradeRetry\(/);
  });

  it("the upgrade is a no-op without a proof the report job stored", () => {
    // `otsProofBase64` is written only inside the report job's transaction, so
    // a record that never generated a report can never be upgraded either.
    expect(OTS_UPGRADE).toMatch(/if\s*\(!evidence\s*\|\|\s*!evidence\.otsProofBase64\)/);
  });
});

// ===========================================================================
// 2. THE COMMERCIAL TRUTH — what FREE is and is not entitled to
// ===========================================================================

describe("FREE — the plan-level output matrix", () => {
  const free = getPlanCapabilities("FREE");

  it("Report and Verification Package are NOT included", () => {
    expect(free.reportsIncluded).toBe(false);
    expect(free.verificationPackageIncluded).toBe(false);
  });

  it("Public Verify IS included, and does not depend on either artifact", () => {
    expect(free.publicVerifyIncluded).toBe(true);
    // The three are independent fields on the catalog row; public verification
    // is not derived from the presence of a report or a package anywhere.
    expect(getPlanCapabilities("PRO").publicVerifyIncluded).toBe(true);
  });

  it("a credit-funded record on FREE earns both artifacts", async () => {
    const { resolveEvidenceOutputEntitlements } = await import(
      "@proovra/shared-billing"
    );
    const funded = resolveEvidenceOutputEntitlements({
      plan: "FREE",
      funding: "EVIDENCE_CREDIT",
    });
    expect(funded.reportsIncluded).toBe(true);
    expect(funded.verificationPackageIncluded).toBe(true);
    expect(funded.publicVerifyIncluded).toBe(true);
  });
});

// ===========================================================================
// 3. THE OTHER HALF OF THE CONFLICT — what the customer is told
// ===========================================================================

describe("the published promise", () => {
  it("Pricing still lists OpenTimestamps among what every plan includes", () => {
    /*
     * Deliberately asserting the CURRENT copy, not the desired copy.
     *
     * If this fails, somebody edited the strip. That is resolution (b), and it
     * is a decision about what FREE is sold — it must be taken knowingly, with
     * the coupling above either fixed or accepted, not as a passing tidy-up.
     */
    expect(
      PRICING,
      "the OTS promise on Pricing was changed; see PRODUCT_DECISION_REQUIRED " +
        "at the top of this file before accepting it",
    ).toContain('label: "OpenTimestamps (OTS)"');
  });
});

// ===========================================================================
// 4. TSA — the absence that must stay absent
// ===========================================================================

describe("TSA has no retry, and this work added none", () => {
  it("no TSA queue, job, route or reconciler exists", () => {
    expect(PROCESSOR).not.toMatch(/enqueueTsa|tsaRetryQueue|retryTsa|TSA_RETRY/i);
    const routes = codeOnly(
      read("services", "api", "src", "routes", "evidence.routes.ts"),
    );
    expect(routes).not.toMatch(/tsa\/retry|retry-timestamp|retryTimestamp/i);
  });

  it("a FREE record's OTS state is NULL, so no counter can read it as failed", () => {
    /*
     * Every Operations probe narrows on `otsStatus: "FAILED"`. The column is
     * nullable with no default and is written only by the report job's
     * transaction and the upgrade processor, so a commercially excluded record
     * carries NULL — which matches no failure counter. A commercial exclusion
     * must never surface as an integrity failure.
     */
    const schema = read("services", "api", "prisma", "schema.prisma");
    expect(schema).toMatch(/otsStatus\s+String\?\s+@map\("ots_status"\)/);
    expect(schema).not.toMatch(/otsStatus\s+String\s+@default/);
  });
});
