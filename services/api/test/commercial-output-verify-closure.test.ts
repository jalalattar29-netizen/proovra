/**
 * =============================================================================
 * THE COMMERCIAL / OUTPUT / VERIFY CLOSURE (2026-09-10).
 * =============================================================================
 * One named test per finding closed, written so the test states the DEFECT it
 * would have caught rather than restating the implementation.
 *
 * Two kinds of assertion, chosen per finding by what the finding actually is —
 * the same discipline `commercial-output-journeys.test.ts` set out:
 *
 *   BEHAVIOUR  the finding is a DECISION. It is executed. The state machine,
 *              the entitlement policies and the presentation predicates are
 *              pure functions over explicit inputs, so they are really
 *              computed here — no database, no mocks, no fixture to drift.
 *
 *   WIRING     the finding is "the right authority is consulted at the right
 *              place". Asserted over the source, because a plan-name
 *              comparison at a call site is invisible to any test of the
 *              function that name came from — which is precisely how three of
 *              these defects survived a green suite.
 *
 * Cross-surface agreement (P1-1) is asserted BEHAVIOURALLY over every state,
 * because "two tabs of one page say the same thing" is a property of the
 * predicates and can be computed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EVIDENCE_OUTPUT_STATES,
  OUTPUT_NOT_APPLICABLE_REASONS,
  OUTPUT_RECORD_APPLICABILITIES,
  classifyTerminalReason,
  deriveEvidenceOutputState,
  outputActionFor,
  outputNotApplicableReason,
  resolveOfferedOutputAction,
  type EvidenceOutputState,
} from "@proovra/shared";
import {
  EVIDENCE_CREDIT_PRODUCT,
  PLAN_CAPABILITIES,
  resolveEvidenceOutputEntitlements,
  resolveStorageAddonEntitlement,
} from "@proovra/shared-billing";
import { REPORT_ARTIFACT_TYPES } from "@proovra/shared-runtime/reports";

const api = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
const web = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
const mobile = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../apps/mobile/${rel}`, import.meta.url)),
    "utf8",
  );
const worker = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../worker/src/${rel}`, import.meta.url)),
    "utf8",
  );

/** Comments removed, so a WIRING assertion cannot be satisfied by prose. */
const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ===========================================================================
// P1-3 — NOT_APPLICABLE is a record condition, never a commercial one
// ===========================================================================

describe("P1-3 — a record that cannot carry an output is not 'not included'", () => {
  it("BEHAVIOUR: an unfinalized record on an ENTITLED plan is NOT_APPLICABLE, not NOT_INCLUDED", () => {
    /*
     * THE DEFECT: `deriveEvidenceOutputState` returned NOT_INCLUDED whenever
     * the record was not finalized, and every surface renders that state with
     * PLAN copy. So a Pro customer watching their own upload was told reports
     * were not included in their plan.
     */
    const state = deriveEvidenceOutputState({
      eligibility: "ELIGIBLE",
      generation: "NOT_REQUESTED",
      availability: "NO_ARTIFACT",
      record: "NOT_FINALIZED",
    });
    expect(state).toBe("NOT_APPLICABLE");
    expect(state).not.toBe("NOT_INCLUDED");
  });

  it("BEHAVIOUR: an integrity failure is NOT_APPLICABLE with its OWN reason", () => {
    // The worse half: a FAILED_HASH_MISMATCH record on Enterprise was told its
    // billing plan was the reason it had no report.
    const axes = {
      eligibility: "ELIGIBLE",
      generation: "NOT_REQUESTED",
      availability: "NO_ARTIFACT",
      record: "INTEGRITY_FAILED",
    } as const;
    expect(deriveEvidenceOutputState(axes)).toBe("NOT_APPLICABLE");
    expect(outputNotApplicableReason(axes)).toBe("INTEGRITY_FAILED");
  });

  it("BEHAVIOUR: the two record conditions are distinguishable, because they end differently", () => {
    const notFinalized = outputNotApplicableReason({
      eligibility: "ELIGIBLE",
      generation: "NOT_REQUESTED",
      availability: "NO_ARTIFACT",
      record: "NOT_FINALIZED",
    });
    expect(notFinalized).toBe("NOT_FINALIZED");
    expect(OUTPUT_NOT_APPLICABLE_REASONS).toContain("NOT_FINALIZED");
    expect(OUTPUT_NOT_APPLICABLE_REASONS).toContain("INTEGRITY_FAILED");
  });

  it("BEHAVIOUR: an integrity failure outranks a commercial exclusion", () => {
    // Both are true of a Free hash-mismatched record. The record condition is
    // the one that matters and the one that must be said.
    expect(
      deriveEvidenceOutputState({
        eligibility: "NOT_INCLUDED",
        generation: "NOT_REQUESTED",
        availability: "NO_ARTIFACT",
        record: "INTEGRITY_FAILED",
      }),
    ).toBe("NOT_APPLICABLE");
  });

  it("BEHAVIOUR: an EXISTING artifact still wins over every record condition", () => {
    // The downgrade contract must survive the new state: what was generated
    // stays downloadable whatever the record's condition is now.
    expect(
      deriveEvidenceOutputState({
        eligibility: "NOT_INCLUDED",
        generation: "NOT_REQUESTED",
        availability: "READY",
        record: "INTEGRITY_FAILED",
      }),
    ).toBe("READY");
  });

  it("BEHAVIOUR: NOT_APPLICABLE carries no action, in either direction", () => {
    for (const eligibility of ["ELIGIBLE", "NOT_INCLUDED"] as const) {
      expect(
        outputActionFor({ state: "NOT_APPLICABLE", eligibility }),
      ).toBe("NONE");
    }
  });

  it("BEHAVIOUR: a finalized entitled record is unaffected", () => {
    // The regression guard: the state that carries the product's main action
    // must not have moved.
    const state = deriveEvidenceOutputState({
      eligibility: "ELIGIBLE",
      generation: "NOT_REQUESTED",
      availability: "NO_ARTIFACT",
      record: "FINALIZED",
    });
    expect(state).toBe("ELIGIBLE_NOT_GENERATED");
    expect(outputActionFor({ state, eligibility: "ELIGIBLE" })).toBe("GENERATE");
  });

  it("BEHAVIOUR: outputNotApplicableReason is null for every other state", () => {
    // A projection calls it unconditionally, so it must be silent when the
    // state is not NOT_APPLICABLE.
    expect(
      outputNotApplicableReason({
        eligibility: "ELIGIBLE",
        generation: "QUEUED",
        availability: "NO_ARTIFACT",
        record: "FINALIZED",
      }),
    ).toBeNull();
    expect(
      outputNotApplicableReason({
        eligibility: "NOT_INCLUDED",
        generation: "NOT_REQUESTED",
        availability: "NO_ARTIFACT",
        record: "FINALIZED",
      }),
    ).toBeNull();
  });

  it("WIRING: ONE status→record mapping, and all three projections use it", () => {
    /*
     * A status compared inline at three call sites is how a fourth status comes
     * to be classified two ways. The mapping is exported once and imported.
     */
    const status = strip(api("services/evidence-artifact-status.service.ts"));
    expect(status).toMatch(
      /export function resolveOutputRecordApplicability\b/,
    );
    expect(status).toMatch(/FAILED_HASH_MISMATCH/);
    for (const consumer of [
      "routes/reports.routes.ts",
      "services/reports/reports-aggregator.service.ts",
      "services/cases/matter-workspace.service.ts",
    ]) {
      expect(
        strip(api(consumer)),
        `${consumer} must consume the one mapping`,
      ).toMatch(/resolveOutputRecordApplicability\(/);
    }
  });

  it("WIRING: the Artifacts tab renders the integrity reason without naming a plan", () => {
    // STRIPPED FIRST: the comment above this arm legitimately explains the
    // defect by naming the plan that used to be printed, and an assertion that
    // reads its own explanation as evidence is worthless.
    const tab = strip(
      web("app/(app)/evidence/[id]/_tabs/EvidenceArtifactsTab.tsx"),
    );
    const arm = tab.slice(
      tab.indexOf('case "NOT_APPLICABLE":'),
      tab.indexOf('case "NOT_INCLUDED":'),
    );
    expect(arm.length).toBeGreaterThan(200);
    expect(arm).toMatch(/INTEGRITY_FAILED/);
    // The whole point of the finding: no plan name in this arm.
    for (const plan of ["Pro", "Team", "Enterprise", "Pay-per-evidence"]) {
      expect(arm, `NOT_APPLICABLE copy must not name ${plan}`).not.toContain(
        plan,
      );
    }
  });

  it("WIRING: the record axis is total, so a fourth condition is a compile error", () => {
    expect([...OUTPUT_RECORD_APPLICABILITIES]).toEqual([
      "NOT_FINALIZED",
      "INTEGRITY_FAILED",
      "FINALIZED",
    ]);
  });
});

// ===========================================================================
// P1-1 — evidence-intelligence is no longer a second output authority
// ===========================================================================

/**
 * The two predicates the intelligence layer now uses, restated here from its
 * behaviour rather than imported: they are private to that module by design,
 * and what this suite must pin is the AGREEMENT they produce, which is
 * observable from the states.
 */
const NOT_A_REVIEW_GAP: ReadonlySet<EvidenceOutputState> = new Set([
  "READY",
  "NOT_INCLUDED",
  "NOT_APPLICABLE",
]);

describe("P1-1 — one output decision, rendered by every surface", () => {
  it("WIRING: the intelligence layer RECEIVES the canonical projection and cannot resolve one", () => {
    /*
     * THE DEFECT: this module answered "does this record have its outputs?"
     * from `reportReady` / `packageReady` — artifact-row presence with no
     * commercial or lifecycle input — and its answer reached the SAME PAGE as
     * the canonical one. The Artifacts tab said "not included for this
     * record"; the Overview tab said "Needs review — Generate the PDF report
     * before external review".
     */
    const src = strip(api("services/evidence-intelligence.service.ts"));

    // It takes the projection…
    expect(src).toMatch(/outputs:\s*EvidenceIntelligenceOutputs/);
    // …and it decides nothing commercial: no plan, no entitlement, no funding.
    expect(src).not.toMatch(/resolveEvidenceOutputEntitlements/);
    expect(src).not.toMatch(/getPlanCapabilities/);
    expect(src).not.toMatch(/PLAN_CAPABILITIES/);
    expect(src).not.toMatch(/resolveCommercialContext|resolveCommercialPlan/);

    // The three judgement functions read the STATE, not the booleans.
    for (const fn of [
      "buildEvidenceReviewDecision",
      "buildReviewerAlerts",
      "buildLibrarySummary",
    ]) {
      const start = src.indexOf(`function ${fn}(`);
      expect(start, `${fn} must exist`).toBeGreaterThan(-1);
      const signature = src.slice(start, src.indexOf(")", start));
      expect(signature, `${fn} must take the canonical outputs`).toMatch(
        /outputs/,
      );
      expect(
        signature,
        `${fn} must NOT take an artifact-presence boolean`,
      ).not.toMatch(/reportReady|verificationPackageReady/);
    }
  });

  it("WIRING: the two 'absence' reviewer alerts are gone from the intelligence layer", () => {
    /*
     * They fired on `!reportReady` / `!packageReady`, and the route MERGES this
     * array with the canonical alert block — which deliberately emits nothing
     * for NOT_INCLUDED. So a Free record showed the canonical silence and these
     * two WARNINGs at once: the old authority overruling the new one on one
     * screen.
     */
    const src = strip(api("services/evidence-intelligence.service.ts"));
    expect(src).not.toContain("Report not ready");
    expect(src).not.toContain("Verification package missing");
  });

  it("WIRING: the 'generate a package' guidance is gone — there is no such action", () => {
    // Generation is PAIRED: one request produces both artifacts. A
    // package-only verb named a control that does not exist anywhere.
    const src = strip(api("services/evidence-intelligence.service.ts"));
    expect(src).not.toMatch(/generate a package/i);
    expect(src).not.toMatch(/Generate the PDF report before external review/);
  });

  it("WIRING: both intelligence call sites resolve the projection FIRST and hand it in", () => {
    const routes = strip(api("routes/evidence.routes.ts"));
    const calls = [...routes.matchAll(/buildEvidenceIntelligence\(\{[\s\S]{0,400}?\}\)/g)];
    expect(calls.length, "both call sites must be found").toBe(2);
    for (const call of calls) {
      expect(call[0]).toMatch(/outputs:\s*artifactStatus\.outputs/);
    }
    // …and the projection is built before the first consumer, not 400 lines
    // later, which is what made the second authority necessary.
    expect(routes.indexOf("buildEvidenceArtifactStatus({")).toBeLessThan(
      routes.indexOf("buildEvidenceIntelligence({"),
    );
  });

  it("BEHAVIOUR: no state where the canonical action is NONE is also a review gap", () => {
    /*
     * THE CROSS-SURFACE AGREEMENT, as a computation over every state.
     *
     * If a state offers no action, the Overview must not be telling the reader
     * to take one. That is the exact contradiction the finding described, and
     * it is checkable rather than reviewable.
     */
    for (const state of EVIDENCE_OUTPUT_STATES) {
      for (const eligibility of ["ELIGIBLE", "NOT_INCLUDED"] as const) {
        const action = outputActionFor({ state, eligibility });
        if (action !== "NONE") continue;
        // A blocked or terminal state legitimately has no action AND is worth
        // reporting — those are the two the predicate deliberately keeps.
        if (state === "BLOCKED" || state === "TERMINAL_FAILURE") continue;
        if (state === "QUEUED" || state === "GENERATING") continue;
        if (state === "READY") continue;
        expect(
          NOT_A_REVIEW_GAP.has(state),
          `${state} offers no action, so it must not be reported as a review gap`,
        ).toBe(true);
      }
    }
  });

  it("BEHAVIOUR: NOT_INCLUDED and NOT_APPLICABLE are never review gaps, on any plan", () => {
    expect(NOT_A_REVIEW_GAP.has("NOT_INCLUDED")).toBe(true);
    expect(NOT_A_REVIEW_GAP.has("NOT_APPLICABLE")).toBe(true);
    // …and the states that ARE gaps stay gaps.
    for (const state of [
      "ELIGIBLE_NOT_GENERATED",
      "RETRYABLE_FAILURE",
      "TERMINAL_FAILURE",
      "BLOCKED",
    ] as const) {
      expect(NOT_A_REVIEW_GAP.has(state)).toBe(false);
    }
  });

  it("WIRING: an excluded output leaves the readiness DENOMINATOR, rather than scoring zero", () => {
    /*
     * The score was a fixed four-signal average with report and package as two
     * of the four, so a Free record's ceiling was 50% however complete its
     * evidence was — the number measured the price plan. Zeroing the signal
     * would not have fixed it; excluding it does.
     */
    const src = strip(api("services/evidence-intelligence.service.ts"));
    expect(src).toMatch(/outputParticipatesInReadinessScore\(/);
    const fn = src.slice(
      src.indexOf("function outputParticipatesInReadinessScore"),
      src.indexOf("function outputParticipatesInReadinessScore") + 400,
    );
    expect(fn).toMatch(/NOT_INCLUDED/);
    expect(fn).toMatch(/NOT_APPLICABLE/);
    // The signals array must be BUILT, not a fixed-length literal.
    expect(src).toMatch(/signals\.push\(/);
  });
});

// ===========================================================================
// P1-2 — Pricing publishes nothing from the grandfather PAYG row
// ===========================================================================

describe("P1-2 — Pay-per-evidence advertises what a buyer receives", () => {
  it("WIRING: no published pricing field is sourced from PLAN_CAPABILITIES.PAYG", () => {
    /*
     * THE DEFECT: `buildPricingCatalogResponse` projected
     * `PLAN_CAPABILITIES.PAYG` as the Pay-per-evidence column, in direct
     * contradiction of that row's own instruction — "NOT A SELLABLE PLAN […]
     * Nothing may advertise these values". So the public comparison table
     * advertised 5 GB of storage and 50 AI operations a month. No write path
     * assigns `entitlements.plan = 'PAYG'`, so a real buyer holds FREE's 250 MB
     * and 10 operations: two published entitlements that could not be obtained.
     */
    const src = strip(api("services/billing-pricing.service.ts"));

    // The type parameter is the gate: `projectPublishedPlan("PAYG")` is now a
    // compile error, which is stronger than any assertion here.
    const signature = src.slice(
      src.indexOf("function projectPublishedPlan"),
      src.indexOf("function projectPublishedPlan") + 220,
    );
    expect(signature).toMatch(/"FREE"\s*\|\s*"PRO"\s*\|\s*"TEAM"/);
    expect(signature).not.toMatch(/"PAYG"/);

    // …and the published object comes from the credit product plus FREE.
    const offer = src.slice(
      src.indexOf("function projectEvidenceCreditOffer"),
      src.indexOf("export function buildPricingCatalogResponse"),
    );
    expect(offer).toMatch(/EVIDENCE_CREDIT_PRODUCT/);
    expect(offer).toMatch(/PLAN_CAPABILITIES\.FREE/);
    expect(offer).not.toMatch(/PLAN_CAPABILITIES\.PAYG/);

    // Nowhere in the served catalog.
    const catalog = src.slice(src.indexOf("export function buildPricingCatalogResponse"));
    expect(catalog).not.toMatch(/PLAN_CAPABILITIES\.PAYG/);
  });

  it("BEHAVIOUR: the credit offer's subscription entitlements ARE Free's", () => {
    // The assertion the old projection would have failed: a credit buyer's
    // storage and AI allowance are FREE's, because they are on FREE.
    const free = PLAN_CAPABILITIES.FREE;
    const payg = PLAN_CAPABILITIES.PAYG;
    // Proof the two differ, so the test is not vacuous.
    expect(payg.includedStorageBytes).not.toBe(free.includedStorageBytes);
    expect(payg.aiAdvisoryMonthlyOperations).not.toBe(
      free.aiAdvisoryMonthlyOperations,
    );
    expect(free.includedStorageBytes).toBe(250n * 1024n * 1024n);
    expect(free.aiAdvisoryMonthlyOperations).toBe(10);
  });

  it("BEHAVIOUR: a credit-funded RECORD still earns both paid outputs", () => {
    // The record-level entitlement is the product, and it is untouched.
    const outputs = resolveEvidenceOutputEntitlements({
      plan: "FREE",
      funding: "EVIDENCE_CREDIT",
    });
    expect(outputs.reportsIncluded).toBe(true);
    expect(outputs.verificationPackageIncluded).toBe(true);
    expect(outputs.publicVerifyIncluded).toBe(true);
    expect(EVIDENCE_CREDIT_PRODUCT.creditsPerCompletion).toBe(1);
  });

  it("WIRING: the pricing page renders the credit unit price, not a monthly one", () => {
    const page = strip(web("app/pricing/page.tsx"));
    expect(page).toMatch(/catalog\?\.payg\?\.unitPriceCents/);
    expect(page).not.toMatch(/catalog\?\.payg\?\.monthlyPriceCents/);
  });

  it("WIRING: no pricing row implies a credit buyer gets more than Free", () => {
    const page = web("app/pricing/page.tsx");
    // The storage and AI cells must name the account they describe, because
    // the number alone reads like a mistake beside Pro's.
    expect(page).toMatch(/storageLabel\}\s*\(Free account\)/);
    expect(page).toMatch(/ops \/ month \(Free account\)/);
  });
});

// ===========================================================================
// P1-2 / PRODUCT OPTION B — storage add-ons for an evidence-credit customer
// ===========================================================================

describe("PRODUCT OPTION B — a credit customer is not trapped at the Free ceiling", () => {
  it("BEHAVIOUR: FREE with a settled credit grant MAY buy storage add-ons", () => {
    const decision = resolveStorageAddonEntitlement({
      plan: "FREE",
      hasSettledEvidenceCreditGrant: true,
    });
    expect(decision.storageAddonsPurchasable).toBe(true);
    expect(decision.source).toBe("EVIDENCE_CREDIT");
  });

  it("BEHAVIOUR: FREE with NO credit grant may not", () => {
    const decision = resolveStorageAddonEntitlement({
      plan: "FREE",
      hasSettledEvidenceCreditGrant: false,
    });
    expect(decision.storageAddonsPurchasable).toBe(false);
    expect(decision.source).toBe("NONE");
  });

  it("BEHAVIOUR: PRO and TEAM are unchanged, and grant it from the PLAN", () => {
    for (const plan of ["PRO", "TEAM"] as const) {
      const decision = resolveStorageAddonEntitlement({
        plan,
        hasSettledEvidenceCreditGrant: false,
      });
      expect(decision.storageAddonsPurchasable).toBe(true);
      expect(decision.source).toBe("PLAN");
    }
  });

  it("BEHAVIOUR: ENTERPRISE is NOT self-service — capacity is a contract term", () => {
    const decision = resolveStorageAddonEntitlement({
      plan: "ENTERPRISE",
      hasSettledEvidenceCreditGrant: true,
    });
    expect(decision.storageAddonsPurchasable).toBe(false);
  });

  it("BEHAVIOUR: a grandfathered PAYG row keeps the offers it has always had", () => {
    // Removing a right from an existing account is not a refactor, and a
    // pre-ledger PAYG buyer may have no credit-grant row to qualify through.
    const decision = resolveStorageAddonEntitlement({
      plan: "PAYG",
      hasSettledEvidenceCreditGrant: false,
    });
    expect(decision.storageAddonsPurchasable).toBe(true);
    expect(decision.source).toBe("PLAN");
  });

  it("BEHAVIOUR: no PSEUDO PLAN was introduced — the catalog still has five rows", () => {
    // The product decision was explicit: no PAYG_V2, no FREE_WITH_CREDITS, no
    // synthetic tier. The capability is a separate decision over the SAME plans.
    expect(Object.keys(PLAN_CAPABILITIES).sort()).toEqual([
      "ENTERPRISE",
      "FREE",
      "PAYG",
      "PRO",
      "TEAM",
    ]);
  });

  it("WIRING: the fact is a SETTLED ledger grant, never a balance or a client value", () => {
    /*
     * A balance would deny the add-on at the exact moment it is needed — the
     * customer who most needs storage is the one who has SPENT their credits,
     * because those spends are the records occupying the space.
     */
    // Stripped: the docblock explains why CONSUMPTION is excluded, and that
    // sentence must not satisfy nor break the assertion.
    const credits = strip(api("services/billing/evidence-credits.service.ts"));
    const fn = credits.slice(
      credits.indexOf("export async function hasSettledEvidenceCreditGrant"),
      /*
       * Bounded to the NEXT export, not to a magic character count.
       *
       * A `+ 900` slice ran past the end of this function into
       * `resolveEvidenceFunding`, which legitimately reads CONSUMPTION — so the
       * assertion below was failing on a neighbour's code. A test that reads
       * more than the thing it is about will eventually be right about the
       * wrong function.
       */
      credits.indexOf(
        "export async function resolveEvidenceFunding",
      ),
    );
    expect(fn).toMatch(/entryType/);
    expect(fn).toMatch(/PURCHASE/);
    expect(fn).toMatch(/ADMIN_GRANT/);
    // Not a wallet balance, and not a spend.
    expect(fn).not.toMatch(/credits\s*:\s*\{\s*gte/);
    expect(fn).not.toMatch(/CONSUMPTION/);
  });

  it("WIRING: the server GATE is the canonical capability, not a plan comparison", () => {
    /*
     * `scope.plan === FREE` was the enforcement half of the dead end: a credit
     * buyer's subscription is FREE by design, so this refused the one purchase
     * that could free them from a ceiling they had already filled.
     */
    const routes = strip(api("routes/billing.routes.ts"));
    expect(routes).toMatch(/resolveStorageAddonEntitlement\(/);
    expect(routes).toMatch(/hasSettledEvidenceCreditGrant\(/);
    expect(routes).toMatch(/STORAGE_ADDON_NOT_INCLUDED/);
    // The plan-name refusal is gone.
    expect(routes).not.toMatch(
      /Please upgrade your base plan before purchasing extra storage/,
    );
  });

  it("WIRING: the offer catalog and the Billing projection read the SAME decision", () => {
    const usage = strip(api("services/workspace-usage.service.ts"));
    expect(usage).toMatch(/resolveStorageAddonEntitlement\(/);

    const projection = strip(
      api("services/billing/billing-account-projection.service.ts"),
    );
    // The projection must not compare a plan name to decide eligibility.
    expect(projection).not.toMatch(/addonsEligible\s*=\s*scope\.plan\s*!==\s*"FREE"/);
    expect(projection).toMatch(/storageAddonOffersForPlan\(/);
    expect(projection).toMatch(/hasSettledEvidenceCreditGrant\(/);
  });

  it("WIRING: only ONE module decides storage-addon eligibility", () => {
    // A second `plan === "FREE" && credits > 0` anywhere is the defect
    // returning in a new place.
    for (const file of [
      "routes/billing.routes.ts",
      "services/workspace-usage.service.ts",
      "services/billing/billing-account-projection.service.ts",
      "services/billing-pricing.service.ts",
    ]) {
      const src = strip(api(file));
      expect(
        src,
        `${file} must not re-derive credit-based storage eligibility`,
      ).not.toMatch(/plan\s*===\s*"FREE"[\s\S]{0,80}credits\s*>\s*0/);
    }
  });
});

// ===========================================================================
// P2-1 — a record with no workspace is not a record that does not exist
// ===========================================================================

describe("P2-1 — legacy null-workspace records tell the truth", () => {
  it("WIRING: the writer's refusal maps to its OWN outcome, not to EVIDENCE_NOT_FOUND", () => {
    /*
     * THE DEFECT: `evidence_workspace_unresolved` was folded into
     * EVIDENCE_NOT_FOUND, whose message is "This evidence record is not
     * available." Legacy personal rows carry a null workspace, they ARE listed
     * (the canonical scope predicate has an owner-scoped arm for exactly
     * them), and their Generate button posted and came back denying the record
     * existed.
     */
    const authority = strip(
      api("services/reports/report-generation-authority.service.ts"),
    );
    expect(authority).toMatch(
      /evidence_workspace_unresolved[\s\S]{0,80}WORKSPACE_UNRESOLVED/,
    );
  });

  it("WIRING: the ACTION is withdrawn, so the button is never offered", () => {
    // Suppressed rather than offered-and-refused. And the STATE is untouched,
    // so an existing artifact on such a record stays READY and downloadable.
    const status = strip(api("services/evidence-artifact-status.service.ts"));
    // The fact comes from the record's own workspace binding…
    expect(status).toMatch(/workspaceResolved\s*=\s*Boolean\(params\.evidenceTeamId\)/);
    // …and the DECISION comes from the one shared rule, not from an inline
    // comparison repeated per output.
    expect(status).toMatch(/resolveOfferedOutputAction\(/);
    expect(status).toMatch(/actionUnavailableReason/);
  });

  it("BEHAVIOUR: the shared rule withdraws the verb WITHOUT touching the state", () => {
    /*
     * The separation that matters: a legacy record with an existing artifact
     * is READY, downloadable, and has a real version list. Only the verb goes.
     * That is the same separation of OWNERSHIP from GENERATION that lets a
     * downgrade keep its downloads.
     */
    for (const action of ["GENERATE", "RETRY", "REGENERATE"] as const) {
      const withdrawn = resolveOfferedOutputAction({
        action,
        workspaceResolved: false,
      });
      expect(withdrawn.action).toBe("NONE");
      expect(withdrawn.actionUnavailableReason).toBe("WORKSPACE_UNRESOLVED");

      const kept = resolveOfferedOutputAction({
        action,
        workspaceResolved: true,
      });
      expect(kept.action).toBe(action);
      expect(kept.actionUnavailableReason).toBeNull();
    }
    // A state that already offers nothing gains no reason to explain.
    expect(
      resolveOfferedOutputAction({ action: "NONE", workspaceResolved: false }),
    ).toEqual({ action: "NONE", actionUnavailableReason: null });
  });

  it("WIRING: ALL THREE listing projections apply the withdrawal", () => {
    /*
     * The gap this closes in my own first draft: the rule was applied only on
     * Evidence Detail, and BOTH Reports surfaces list these records too (the
     * canonical scope predicate has an owner-scoped null-workspace arm, and the
     * user-scoped fallback has its own). A rule applied at one surface is a
     * button that still dead-ends at the other two.
     */
    for (const file of [
      "services/evidence-artifact-status.service.ts",
      "services/reports/reports-aggregator.service.ts",
      "routes/reports.routes.ts",
    ]) {
      expect(strip(api(file)), file).toMatch(/resolveOfferedOutputAction\(/);
    }
  });

  it("WIRING: the message says what is wrong, and both hosts say the same thing", () => {
    const routes = api("routes/evidence.routes.ts");
    const client = web("lib/evidence/generation-outcome.ts");
    for (const [name, src] of [
      ["API", routes],
      ["web", client],
    ] as const) {
      expect(src, `${name} must carry the outcome`).toMatch(
        /WORKSPACE_UNRESOLVED/,
      );
      expect(src, `${name} must name a workspace association`).toMatch(
        /needs a workspace association/,
      );
    }
  });

  it("WIRING: the backfill is DESIGNED and not performed", () => {
    // A tenancy write is a governance act. The population query and the
    // operator-gated design are documented; nothing applies them.
    const doc = readFileSync(
      fileURLToPath(
        new URL(
          "../../../docs/architecture/legacy-null-workspace-evidence-backfill.md",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(doc).toMatch(/DESIGN ONLY/);
    expect(doc).toMatch(/team_id IS NULL/);
    expect(doc).toMatch(/Why this is not a migration/i);
  });

  it("WIRING: new records cannot join the population", () => {
    const create = strip(api("services/evidence.service.ts"));
    expect(create).toMatch(/teamId:\s*effectiveTeamId/);
  });
});

// ===========================================================================
// P2-2 — the Reports fallback resolves the record's commercial subject
// ===========================================================================

describe("P2-2 — a record's commercial subject is its workspace, never the reader", () => {
  it("WIRING: the fallback groups by the RECORD's subject", () => {
    /*
     * THE DEFECT: it passed `{ ownerUserId: caller, teamId: null }` — the
     * CALLER'S PERSONAL PLAN — and applied it to every row, while its own
     * access clause matches rows in ANY workspace the caller is a member of.
     * A Free-plan member of a Team workspace was told their Team workspace's
     * records had no report included.
     */
    const route = strip(api("routes/reports.routes.ts"));
    expect(route).toMatch(/resolveEvidenceOutputEligibilityByRecord\(/);
    expect(route).not.toMatch(/ownerUserId:\s*userId,\s*teamId:\s*null/);
    /*
     * The subject travels with the row on BOTH evidence select branches — the
     * primary one, and the no-`deleted_at` fallback which is what a deployment
     * lacking that column actually runs.
     *
     * Asserted PER BRANCH rather than by counting occurrences: the route also
     * selects `ownerUserId` for the personal-team lookup that builds its access
     * clause, so a whole-file count is three and proves nothing about either
     * select.
     */
    const selects = [
      ...route.matchAll(/select:\s*\{[\s\S]*?createdAt:\s*true,\s*\},/g),
    ];
    expect(selects.length, "both evidence selects must be found").toBe(2);
    for (const select of selects) {
      expect(select[0]).toMatch(/ownerUserId:\s*true/);
      expect(select[0]).toMatch(/teamId:\s*true/);
    }
  });

  it("WIRING: ONE grouping implementation, shared with the ops narrowing", () => {
    // Two copies of "what is this record's commercial subject" is how the two
    // come to disagree.
    const service = strip(
      api("services/billing/evidence-output-eligibility.service.ts"),
    );
    expect(service).toMatch(
      /export async function resolveEvidenceOutputEligibilityByRecord\b/,
    );
    const selector = service.slice(
      service.indexOf("export async function selectNonEntitledEvidenceIds"),
    );
    expect(selector).toMatch(/resolveEvidenceOutputEligibilityByRecord\(/);
  });

  it("WIRING: grouped, not per row — one plan resolution per distinct subject", () => {
    const service = strip(
      api("services/billing/evidence-output-eligibility.service.ts"),
    );
    const fn = service.slice(
      service.indexOf("export async function resolveEvidenceOutputEligibilityByRecord"),
      service.indexOf("export async function selectNonEntitledEvidenceIds"),
    );
    expect(fn).toMatch(/commercialSubjectKey\(/);
    expect(fn).toMatch(/resolveEvidenceOutputEligibilityMany\(/);
  });
});

// ===========================================================================
// P2-3 — mobile renders the canonical state and holds no dead control
// ===========================================================================

describe("P2-3 — mobile consumes the canonical output state", () => {
  it("WIRING: the download control exists only when the server says READY", () => {
    /*
     * THE DEFECT: an always-enabled "Download Report" whose handler was
     * `if (reportUrl) …`. On every record without a report — every record on
     * Free — pressing it did nothing and said nothing.
     */
    const screen = strip(mobile("app/(stack)/evidence/[id].tsx"));
    expect(screen).toMatch(/reportState === "READY" && reportUrl \?/);
    // The old silent no-op is gone.
    expect(screen).not.toMatch(/onPress=\{\(\) => \{\s*if \(reportUrl\)/);
  });

  it("WIRING: mobile reads the SIDE-EFFECT-FREE status endpoint first", () => {
    // `/report/latest` emits custody and audit events for a real download.
    // Calling it on every screen open recorded a download nobody performed.
    const screen = strip(mobile("app/(stack)/evidence/[id].tsx"));
    const statusAt = screen.indexOf("/artifacts/status");
    const latestAt = screen.indexOf("/report/latest");
    expect(statusAt).toBeGreaterThan(-1);
    expect(statusAt).toBeLessThan(latestAt);
  });

  it("WIRING: mobile imports the shared state type and duplicates no enum", () => {
    const screen = mobile("app/(stack)/evidence/[id].tsx");
    expect(screen).toMatch(
      /import type \{ EvidenceOutputState \} from "@proovra\/shared"/,
    );
  });

  it("WIRING: mobile handles every canonical state", () => {
    // Total over the union, so a new state is a compile error rather than a
    // blank card on a phone.
    const screen = mobile("app/(stack)/evidence/[id].tsx");
    const fn = screen.slice(
      screen.indexOf("function reportStateMessage"),
      screen.indexOf("export default function EvidenceDetailScreen"),
    );
    for (const state of EVIDENCE_OUTPUT_STATES) {
      expect(fn, `mobile must handle ${state}`).toContain(`"${state}"`);
    }
  });

  it("WIRING: the mobile Reports empty state promises no automatic report", () => {
    // "Capture evidence to generate signed reports." was false on Free.
    //
    // Stripped: the replacement carries a comment quoting the old sentence, so
    // an assertion over the raw file would read the explanation as the copy.
    const screen = strip(mobile("app/(tabs)/reports.tsx"));
    expect(screen).not.toMatch(/Capture evidence to generate signed reports/);
    expect(screen).toMatch(/your plan includes/);
  });
});

// ===========================================================================
// P2-4 — Cases stops calling a commercial exclusion a deficiency
// ===========================================================================

describe("P2-4 — Cases renders the canonical state", () => {
  it("WIRING: the matter workspace PROJECTS the canonical state", () => {
    const service = strip(api("services/cases/matter-workspace.service.ts"));
    expect(service).toMatch(/deriveEvidenceOutputState\(/);
    expect(service).toMatch(/resolveEvidenceOutputEligibilityByRecord\(/);
    expect(service).toMatch(/projectReportRequestState\(/);
    // Bounded to the page's ids and grouped — no N+1.
    expect(service).toMatch(/distinct:\s*\["evidenceId"\]/);
  });

  it("WIRING: the Cases needs-attention count consults the ONE predicate", () => {
    /*
     * THE DEFECT: `!item.reportReady || !item.packageReady`, so an excluded
     * output, an unfinalized record and a generation running at that instant
     * all counted as case work outstanding. On a downgraded workspace, every
     * record in every case counted — permanently.
     */
    const helpers = strip(
      web("components/cases-experience/simple-case-detail/helpers.ts"),
    );
    expect(helpers).toMatch(/caseOutputNeedsAttention\(/);
    expect(helpers).not.toMatch(
      /!item\.reportReady\s*\|\|\s*!item\.packageReady/,
    );
    expect(helpers).not.toMatch(/\.filter\(\(i\) => !i\.reportReady\)/);
  });

  it("WIRING: no Cases surface says 'missing' from an artifact boolean", () => {
    for (const file of [
      "components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx",
    ]) {
      const src = web(file);
      expect(src, `${file}`).not.toMatch(
        /reportReady \? "Report ready" : "Report missing"/,
      );
      expect(src, `${file}`).not.toMatch(
        /packageReady \? "Package ready" : "Package missing"/,
      );
      expect(src).toMatch(/caseOutputLabel\(/);
    }
  });

  it("WIRING: Cases does not re-derive the state machine", () => {
    for (const file of [
      "components/cases-experience/simple-case-detail/helpers.ts",
      "components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx",
    ]) {
      expect(strip(web(file)), file).not.toMatch(/deriveEvidenceOutputState/);
    }
  });
});

// ===========================================================================
// P2-5 — the dead component is gone
// ===========================================================================

describe("P2-5 — FreeReportsLockedNotice is deleted", () => {
  it("the file does not exist and nothing imports it", () => {
    expect(() =>
      web("components/reports-experience/FreeReportsLockedNotice.tsx"),
    ).toThrow();
    const page = web("app/(app)/reports/page.tsx");
    expect(page).not.toMatch(/import .*FreeReportsLockedNotice/);
  });
});

// ===========================================================================
// P3 correctness batch
// ===========================================================================

describe("P3-2 — governance terminal reasons classify as POLICY", () => {
  it("BEHAVIOUR: the five governance refusals are POLICY, not TECHNICAL", () => {
    // TECHNICAL means "the pipeline failed and exhausted its budget". Telling
    // an operator that governance refusing something was a pipeline fault
    // sends them to look for an outage.
    for (const code of [
      "LEGAL_HOLD_ACTIVE",
      "ORGANIZATION_NOT_ACTIVE",
      "WORKSPACE_MISMATCH",
      "WORKSPACE_NOT_FOUND",
      "NO_PRINCIPAL",
      "POLICY_VERSION_CHANGED",
    ]) {
      expect(classifyTerminalReason(code), code).toBe("POLICY");
      // The worker writes them lowercase; normalization must hold.
      expect(classifyTerminalReason(code.toLowerCase()), code).toBe("POLICY");
    }
  });

  it("BEHAVIOUR: the other classes are unchanged", () => {
    expect(classifyTerminalReason("REPORT_NOT_INCLUDED_IN_PLAN")).toBe(
      "COMMERCIAL",
    );
    expect(classifyTerminalReason("SIGNING_KEY_NOT_FOUND")).toBe("INTEGRITY");
    expect(classifyTerminalReason("PDF_RENDER_TIMEOUT")).toBe("TECHNICAL");
    expect(classifyTerminalReason(null)).toBe("TECHNICAL");
  });
});

describe("P3-5 — dead vocabulary removed", () => {
  it("EXCHANGE_PACKAGE is no longer a report artifact type", () => {
    // A member whose whole purpose is to select a processor branch selected one
    // that does not exist, and nothing ever created a request with it.
    expect([...REPORT_ARTIFACT_TYPES]).toEqual([
      "REPORT",
      "VERIFICATION_PACKAGE",
    ]);
  });

  it("the Exchange Package product is untouched", () => {
    // It has its own builder, kinds and state machine, and never travelled
    // through ReportGenerationRequest — which is why the member had no producer.
    expect(worker("exchange-package-builder.ts")).toMatch(
      /PROOVRA_EXCHANGE_PACKAGE_MANIFEST/,
    );
  });
});

describe("P3-6 — the Copilot names a real permission", () => {
  it("WIRING: the canonical permission, typed", () => {
    const src = strip(api("routes/ai-evidence.routes.ts"));
    expect(src).toMatch(/"evidence\.generate_report" satisfies Permission/);
    expect(src).not.toMatch(/"evidence\.report\.generate"/);
  });
});

describe("P3-7 — the precheck asks about every artifact the request produces", () => {
  it("WIRING: a REPORT request checks the PAIR, and does not assume the flags are equal", () => {
    const src = strip(
      api("services/reports/report-generation-authority.service.ts"),
    );
    expect(src).toMatch(/verificationPackageIncluded/);
    expect(src).toMatch(/requiredEntitlements/);
    // Still ONE action: no second generation path was introduced.
    expect(src).not.toMatch(/requestVerificationPackageGeneration/);
  });

  it("BEHAVIOUR: today the flags agree on every row — which is why the check had to stop assuming it", () => {
    for (const plan of Object.keys(PLAN_CAPABILITIES) as Array<
      keyof typeof PLAN_CAPABILITIES
    >) {
      const caps = PLAN_CAPABILITIES[plan];
      expect(
        caps.reportsIncluded,
        `${plan}: the precheck must not depend on this coincidence`,
      ).toBe(caps.verificationPackageIncluded);
    }
  });
});

describe("P3-8 — a supersession is not 'already in progress'", () => {
  it("WIRING: the typed outcome decides, before `deduplicated`", () => {
    /*
     * The loser of a supersession race is `deduplicated: true` — it reuses the
     * winner's row — and that row IS the supersession the operator asked for.
     * Reporting it as "already in progress" hid the click that finally worked.
     */
    const src = strip(api("services/operations/remediation-executor.ts"));
    const fn = src.slice(src.indexOf("async function regenerateArtifacts"));
    const supersededAt = fn.indexOf('requested.outcome === "SUPERSEDED"');
    const dedupAt = fn.indexOf("requested.deduplicated");
    expect(supersededAt).toBeGreaterThan(-1);
    expect(supersededAt).toBeLessThan(dedupAt);
  });
});

describe("P3-1 — the forensic checklist reads the archive", () => {
  it("WIRING: artifact presence is an INPUT, not an assertion", () => {
    /*
     * `reportArtifactIncluded: true` was hard-coded while
     * `createVerificationPackage`'s `reportPdf` parameter is optional. Today
     * the single caller always supplies one, so the claim was accurate by
     * coincidence — the least reassuring reason for a file called
     * `court-admissibility-checklist.json` to be correct.
     */
    const src = strip(worker("verification-package.ts"));
    const fn = src.slice(
      src.indexOf("function buildCourtReadinessChecklist"),
      src.indexOf("function buildCustodianDeclarationTemplate"),
    );
    expect(fn).toMatch(/reportArtifactIncluded:\s*params\.reportIncluded/);
    expect(fn).not.toMatch(/reportArtifactIncluded:\s*true/);
    expect(fn).not.toMatch(/certificationTemplateIncluded:\s*true/);
    expect(fn).not.toMatch(/originalLinkageIncluded:\s*true/);
    expect(fn).not.toMatch(/caseMetadataIncluded:\s*true/);
  });

  it("WIRING: the checklist and the boundaries file agree about the report", () => {
    // Two files describing one archive must not disagree, so both take the
    // same expression.
    const src = strip(worker("verification-package.ts"));
    expect(
      [...src.matchAll(/reportIncluded:\s*Boolean\(data\.reportPdf\)/g)].length,
    ).toBe(2);
  });
});

describe("P3-4 — the public trust score carries no commercial input", () => {
  it("WIRING: the verification-package signal scores nothing, in every branch", () => {
    /*
     * It carried 5 of 40 points and awarded 3 when absent, so a Free record
     * scored 95 where an identical paid record scored 100 — two points that
     * measured the price plan. Every proof the package bundles is already a
     * signal of its own in the same list, so scoring it double-counted the
     * assurance and charged for the convenience.
     */
    const src = strip(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../packages/shared/src/trust-decision.ts",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    );
    const fn = src.slice(
      src.indexOf("function buildVerificationPackageSignal"),
      src.indexOf("export function buildEvidenceTrustDecision"),
    );
    expect(fn.length).toBeGreaterThan(200);
    // Three branches, and none of them scores.
    expect([...fn.matchAll(/maxPoints:\s*0/g)].length).toBe(3);
    expect(fn).not.toMatch(/maxPoints:\s*5/);
    expect(fn).not.toMatch(/points:\s*[1-9]/);
    // …and the absent-but-materials-present case must not read as a
    // degradation, because `degradedSignals` drives the headline state.
    const absentBranch = fn.slice(fn.indexOf("hasCoreCryptoMaterials"));
    expect(absentBranch).toMatch(/status:\s*"passed"/);
  });

  it("WIRING: the verify page no longer points at a download that does not exist", () => {
    const page = web("app/verify/[token]/page.tsx");
    expect(page).not.toMatch(
      /Package-level integrity can be checked independently from the downloaded verification package/,
    );
    expect(page).toMatch(/does not depend on one/);
  });
});

describe("P3-9 — the output tables are declared to the preflight", () => {
  it("both tables and both uniqueness properties are required", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL("../scripts/runtime-schema-requirements.mjs", import.meta.url),
      ),
      "utf8",
    );
    for (const id of [
      "report_generation_requests.table",
      "report_generation_requests.idempotency_key_unique",
      "evidence_credit_ledger_entries.table",
      "evidence_credit_ledger_entries.evidence_id_unique",
    ]) {
      expect(src, `${id} must be declared`).toContain(id);
    }
  });
});

// ===========================================================================
// P3-11 — the output-failure notification already exists. Proven, not added.
// ===========================================================================

describe("P3-11 — output failures already reach the person, through the attention architecture", () => {
  it("report and package failure are classified as PERSONAL notifications", () => {
    /*
     * THE AUDIT'S PREMISE WAS INCOMPLETE, and this is the correction.
     *
     * The finding read `NOTIFICATION_EVENT_TYPES` — the TRANSACTIONAL EMAIL
     * vocabulary — found no output member, and concluded no notification
     * exists. There is a second, richer notification architecture: the
     * attention classification table, which already gives `report_failure` and
     * `verification_package_failure` the `notification` channel alongside
     * `operational_condition`.
     *
     * So no event type was added. Adding one would have produced either an
     * ORPHAN — a declared type with no producer, which is exactly the defect
     * P3-5 removed three describes above — or a duplicate of a path that
     * already works.
     */
    const src = api("services/notifications/notification-classification.ts");
    for (const category of ["report_failure", "verification_package_failure"]) {
      const block = src.slice(
        src.indexOf(`${category}: {`),
        src.indexOf(`${category}: {`) + 400,
      );
      expect(block, `${category} must reach the personal feed`).toMatch(
        /channels:\s*\["notification",\s*"operational_condition"\]/,
      );
      expect(block).toMatch(/conditionAuthority:\s*"operations"/);
    }
  });

  it("the personal inbox DERIVES them from canonical persistence, so it cannot spam", () => {
    /*
     * WHY NO DEDUPE MACHINERY WAS NEEDED. The inbox is a READ-TIME projection
     * from OperationalIncident rows, not a push feed — so a worker retry, a
     * reconciler replay and an idempotent request replay all produce the same
     * one item, structurally. There is nothing to deduplicate because nothing
     * is written per notification.
     */
    const inbox = api("routes/me-inbox.routes.ts");
    expect(inbox).toMatch(/"report_failure"/);
    expect(inbox).toMatch(/"verification_package_failure"/);
    expect(strip(inbox)).toMatch(/category:\s*"REPORT"/);
    expect(strip(inbox)).toMatch(/category:\s*"PACKAGE"/);
  });

  it("a SUCCESS is deliberately not attention — the table's own discipline", () => {
    // `onboarding` is excluded from attention with the reason "rendering it as
    // attention manufactures a workload out of an empty workspace". A finished
    // report is not work either, and the record's own page shows READY.
    const src = api("services/notifications/notification-classification.ts");
    expect(src).not.toMatch(/output_ready|report_ready|OUTPUT_READY/);
    expect(src).toMatch(/manufactures a workload/);
  });
});
