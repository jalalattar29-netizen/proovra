/**
 * INTEGRITY IS NOT SOLD. COMMERCIAL OUTPUTS ARE.
 *
 * ===========================================================================
 * THE CONFLICT THIS FILE OPENED, AND THE DECISION THAT CLOSED IT
 * ===========================================================================
 * A previous pass traced OpenTimestamps through executable source and found
 * exactly one stamping call site, inside `processGenerateReportJob`. The
 * consequence was that OTS anchoring was reachable only through report
 * generation: a Free record has no report job, so it never obtained an anchor,
 * while the public Pricing page listed OpenTimestamps in its "Every plan
 * includes" strip beside hashing, RFC 3161 timestamps, signatures and custody.
 *
 * That was raised as PRODUCT_DECISION_REQUIRED rather than resolved, because
 * both available fixes changed what Free is sold and neither was an
 * engineering call.
 *
 * THE DECISION: OTS is part of the base integrity layer. Every finalized
 * record enters the lifecycle, on every plan. Report and Verification Package
 * remain commercial outputs and are unchanged.
 *
 * This file now pins that resolution — the decoupling, and the boundary that
 * must NOT move with it.
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
const LIFECYCLE = codeOnly(read("services", "worker", "src", "ots-lifecycle.ts"));
const UPGRADE = codeOnly(
  read("services", "worker", "src", "ots-upgrade.processor.ts"),
);
const COMPLETE = codeOnly(
  read("services", "api", "src", "services", "evidence-complete.service.ts"),
);
const PRICING = read("apps", "web", "app", "pricing", "page.tsx");

// ===========================================================================
// 1. THE DECOUPLING
// ===========================================================================

describe("OTS is reached from finalization, not from report generation", () => {
  it("finalization enters the OTS lifecycle through the one request authority", () => {
    /*
     * Through the AUTHORITY, not the queue. Enqueueing directly from here made
     * a second API-side producer for `UPGRADE_OTS` — the Operations remediation
     * executor was the first — and the registry's central claim is one producer
     * module per work name. The audit engine reported the pair as
     * `parallelAuthorities = 1`, which is exactly what it exists to catch.
     */
    const idx = COMPLETE.indexOf("requestEvidenceOtsAnchoring({");
    expect(idx, "evidence completion must enter the OTS lifecycle").toBeGreaterThan(-1);
    expect(COMPLETE).toMatch(/trigger:\s*"evidence\.completed"/);
    // And it does not reach past the authority to the transport.
    expect(COMPLETE).not.toMatch(/enqueueCanonicalWork/);

    /*
     * THE ENQUEUE MUST NOT SIT INSIDE A COMMERCIAL CONDITION.
     *
     * The window from the top of the post-commit tail to the enqueue is
     * checked for the report entitlement flag: if `shouldEnqueueReport` ever
     * came to guard this call, integrity would once again be sold with an
     * artifact — which is the entire defect this change removed.
     */
    const tail = COMPLETE.indexOf("if (final.shouldEnqueueReport)");
    expect(tail).toBeGreaterThan(idx);
  });

  it("nothing commercial can reach the initializer — it takes an evidence id", () => {
    // The guarantee stated as an absence in the signature: there is no
    // parameter through which a plan, an entitlement or a funding source could
    // be supplied, so no caller can make integrity conditional.
    const sig = LIFECYCLE.slice(
      LIFECYCLE.indexOf("export async function ensureEvidenceOtsInitialized"),
      LIFECYCLE.indexOf("): Promise<OtsInitializationOutcome>"),
    );
    expect(sig).toMatch(/evidenceId:\s*string/);
    expect(sig).not.toMatch(/plan|funding|entitle|credit|reportsIncluded/i);
  });

  it("the whole lifecycle module is free of commercial vocabulary", () => {
    expect(LIFECYCLE).not.toMatch(
      /getPlanCapabilities|resolveEvidenceOutputEntitlements|resolveEvidenceFunding|billingPlan|"FREE"|"PRO"|"TEAM"|"ENTERPRISE"/,
    );
  });

  it("the report job neither creates, writes nor schedules OTS", () => {
    expect(PROCESSOR).not.toMatch(/createOpenTimestamp/);
    expect(PROCESSOR).not.toMatch(/buildOtsEvidenceUpdateData/);
    expect(PROCESSOR).not.toMatch(/enqueueOtsUpgrade(Job|Retry)/);
    expect(PROCESSOR).not.toMatch(/scheduleOtsUpgrade/);
  });

  it("there is exactly ONE production writer of the initial proof", () => {
    // One caller of the stamp, in one module. A second would be a second
    // authority, and the two could disagree about a record's anchor.
    expect((LIFECYCLE.match(/createOpenTimestamp\(/g) ?? []).length).toBe(1);
    expect((UPGRADE.match(/createOpenTimestamp\(/g) ?? []).length).toBe(0);
  });

  it("initialization and upgrade share one queue and one state machine", () => {
    // Not a second queue: the upgrade processor is the entry point for both
    // phases, and both persist through `buildOtsEvidenceUpdateData`.
    expect(UPGRADE).toMatch(/ensureEvidenceOtsInitialized\(/);
    expect(LIFECYCLE).toMatch(/buildOtsEvidenceUpdateData\(/);
    expect(UPGRADE).toMatch(/buildOtsEvidenceUpdateData\(/);
  });
});

// ===========================================================================
// 2. IDEMPOTENCY AND THE RACE
// ===========================================================================

describe("one record, one logical OTS lifecycle", () => {
  it("a record that already holds a proof is left alone", () => {
    expect(LIFECYCLE).toMatch(
      /if\s*\(evidence\.otsProofBase64\)[\s\S]{0,120}already_initialized/,
    );
  });

  it("the write is conditional on the proof still being unset", () => {
    /*
     * THE RACE GUARD. Two concurrent initializations must produce one stored
     * proof. `updateMany` with `otsProofBase64: null` in the predicate means
     * the loser matches zero rows and discards its own stamp, rather than
     * overwriting a proof that an upgrade may already have advanced.
     */
    expect(LIFECYCLE).toMatch(
      /updateMany\(\{[\s\S]{0,200}otsProofBase64:\s*null/,
    );
    expect(LIFECYCLE).toMatch(/claimed\.count === 0/);
  });

  it("the custody event is written in the same transaction as the claim", () => {
    const idx = LIFECYCLE.indexOf("prisma.$transaction");
    expect(idx).toBeGreaterThan(-1);
    const block = LIFECYCLE.slice(idx, idx + 2200);
    expect(block).toMatch(/updateMany\(/);
    expect(block).toMatch(/appendCustodyEventTx\(tx,/);
  });

  it("the external calendar call happens OUTSIDE any transaction", () => {
    // A network call inside a transaction holds a connection for as long as
    // the calendar takes to answer. The stamp is taken first; only the
    // persistence is transactional.
    const stampIdx = LIFECYCLE.indexOf("await createOpenTimestamp({");
    const txIdx = LIFECYCLE.indexOf("prisma.$transaction");
    expect(stampIdx).toBeGreaterThan(-1);
    expect(txIdx).toBeGreaterThan(stampIdx);
  });

  it("a thrown stamp leaves the record never-attempted, not FAILED", () => {
    /*
     * A missing binary or a dead network is an OUTAGE, not a per-record
     * integrity failure. Writing FAILED for it would mint an operational
     * condition for every record captured during the outage, each needing an
     * operator to clear it afterwards.
     */
    expect(LIFECYCLE).toMatch(/catch\s*\(error\)[\s\S]{0,900}ots\.init\.attempt_failed/);
  });
});

// ===========================================================================
// 3. THE COMMERCIAL BOUNDARY — unchanged, and it must stay unchanged
// ===========================================================================

describe("FREE — the plan-level output matrix", () => {
  const free = getPlanCapabilities("FREE");

  it("Report and Verification Package are still NOT included", () => {
    // The decoupling gave Free an anchor. It must not have given it an
    // artifact: OTS is integrity, and integrity grants no commercial output.
    expect(free.reportsIncluded).toBe(false);
    expect(free.verificationPackageIncluded).toBe(false);
  });

  it("Public Verify IS included, and does not depend on either artifact", () => {
    expect(free.publicVerifyIncluded).toBe(true);
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
  });

  it("no anchored state can be read as an entitlement", () => {
    /*
     * The inference to forbid is `otsAnchored === true -> reportsIncluded`.
     * The entitlement resolver takes a plan and a funding source, and there is
     * no third input — so an anchor cannot participate in the decision even by
     * accident.
     */
    const entitlements = codeOnly(
      read("packages", "shared-billing", "src", "plan-catalog.ts"),
    );
    const fn = entitlements.slice(
      entitlements.indexOf("export function resolveEvidenceOutputEntitlements"),
      entitlements.indexOf("export function resolveWorkspaceIntakeEntitlement"),
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).not.toMatch(/ots|anchor/i);
  });
});

// ===========================================================================
// 4. THE PROMISE THE DECOUPLING NOW KEEPS
// ===========================================================================

describe("the published promise", () => {
  it("Pricing lists OpenTimestamps among what every plan includes", () => {
    // It said this before the source could support it. Now it can.
    expect(PRICING).toContain('label: "OpenTimestamps (OTS)"');
  });
});

// ===========================================================================
// 5. TSA — the absence that must stay absent
// ===========================================================================

describe("TSA has no retry, and this work added none", () => {
  it("no TSA queue, job, route or reconciler exists", () => {
    expect(PROCESSOR).not.toMatch(/enqueueTsa|tsaRetryQueue|retryTsa|TSA_RETRY/i);
    expect(LIFECYCLE).not.toMatch(/tsa/i);
    const routes = codeOnly(
      read("services", "api", "src", "routes", "evidence.routes.ts"),
    );
    expect(routes).not.toMatch(/tsa\/retry|retry-timestamp|retryTimestamp/i);
  });

  it("the reconciliation script cannot touch TSA either", () => {
    const script = codeOnly(
      read(
        "services",
        "worker",
        "src",
        "scripts",
        "reconcile-ots-never-attempted.ts",
      ),
    );
    /*
     * The rule is "it reads and writes no TSA state", not "the word never
     * appears": the script's own operator output names TSA deliberately, to
     * say that capture, TSA and OTS anchor stay three distinct times. Pinning
     * the word would forbid the sentence that keeps the semantics honest, so
     * the columns and any retry verb are what is forbidden.
     */
    expect(script).not.toMatch(/\btsa[A-Z]\w*/);
    expect(script).not.toMatch(/tsa_[a-z]/);
    expect(script).not.toMatch(/retryTsa|enqueueTsa|TSA_RETRY/i);
  });

  it("a never-attempted record's OTS state is NULL, so no counter reads it as failed", () => {
    /*
     * Every Operations probe narrows on `otsStatus: "FAILED"`. The column is
     * nullable with no default, and NULL means NEVER ATTEMPTED — which is a
     * different fact from a stamp that was made and did not work.
     */
    const schema = read("services", "api", "prisma", "schema.prisma");
    expect(schema).toMatch(/otsStatus\s+String\?\s+@map\("ots_status"\)/);
    expect(schema).not.toMatch(/otsStatus\s+String\s+@default/);
  });
});
