/**
 * THE EIGHTEEN JOURNEYS.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS
 * ---------------------------------------------------------------------------
 * One named test per customer journey the Commercial + Evidence Output
 * Lifecycle closure had to make true. They are written as JOURNEYS rather than
 * as unit tests of the functions involved, because every defect this closure
 * fixed was a defect BETWEEN functions that were individually correct: the
 * admission policy was right and the settlement asked a different question; the
 * entitlement resolver was right and the browser asked the plan instead; the
 * generation authority was right and the idempotency key outlived the reason it
 * encoded.
 *
 * ---------------------------------------------------------------------------
 * HOW EACH ONE IS PROVEN, AND WHY THAT IS ENOUGH
 * ---------------------------------------------------------------------------
 * Two kinds of assertion, chosen per journey by what the journey actually is:
 *
 *   BEHAVIOUR   Where the journey is a DECISION, it is executed. The commercial
 *               policies are pure functions over explicit inputs, so a Free
 *               account's fourth record, a TEAM account's 501st, and a
 *               credit-funded record's entitlement are all really computed here
 *               — no database, no mocks, no fixtures that could drift.
 *
 *   WIRING      Where the journey is "the right function is called at the right
 *               place", it is asserted over the source. That is not a weaker
 *               proof of the same thing; it is a proof of a different thing,
 *               and it is the one that matters — a plan-only flag read at a
 *               call site is invisible to any test of the function that flag
 *               came from.
 *
 * Each test says which it is using, and names the symptom it would have caught.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  deriveEvidenceOutputState,
  isCommerciallyObsoleteTerminalReason,
  outputActionFor,
} from "@proovra/shared";
import {
  getPlanCapabilities,
  resolveEvidenceOutputEntitlements,
  resolvePersonalEvidenceAdmission,
  resolveWorkspaceEffectivePlan,
} from "@proovra/shared-billing";

const api = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
const web = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
const worker = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../worker/src/${rel}`, import.meta.url)),
    "utf8",
  );

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ===========================================================================

describe("SCENARIO 1 — FREE captures evidence and nothing looks broken", () => {
  it("BEHAVIOUR: the record is admitted, and its outputs are NOT_INCLUDED rather than pending", () => {
    expect(
      resolvePersonalEvidenceAdmission({
        plan: "FREE",
        currentRecordCount: 0,
        effectiveLifetimeRecordCap: getPlanCapabilities("FREE").maxEvidenceRecords,
        availableEvidenceCredits: 0,
      }),
    ).toEqual({ allowed: true, funding: "PLAN" });

    const outputs = resolveEvidenceOutputEntitlements({ plan: "FREE", funding: "PLAN" });
    expect(outputs.reportsIncluded).toBe(false);
    // Public verification is INCLUDED on Free and is not lost with the outputs.
    expect(outputs.publicVerifyIncluded).toBe(true);

    expect(
      deriveEvidenceOutputState({
        eligibility: "NOT_INCLUDED",
        generation: "NOT_REQUESTED",
        availability: "NO_ARTIFACT",
        finalized: true,
      }),
    ).toBe("NOT_INCLUDED");
  });

  it("WIRING: no generation is requested at completion, and the state carries a reason", () => {
    // The completion fan-out is gated on the RECORD's entitlement, so a Free
    // record produces no request at all — which is why "no row" had to stop
    // meaning "pending".
    const complete = strip(api("services/evidence-complete.service.ts"));
    expect(complete).toMatch(/shouldEnqueueReport:\s*resolveEvidenceOutputEntitlements\(/);
    expect(complete).toMatch(/if \(final\.shouldEnqueueReport\)/);

    const status = strip(api("services/evidence-artifact-status.service.ts"));
    expect(status).toMatch(/ineligibilityReason/);
  });

  it("WIRING: TSA still runs — 'basic integrity signals' includes a trusted timestamp", () => {
    // The timestamp is applied inside the finalize claim with NO commercial
    // gate, on every plan. Free evidence is signed, timestamped and verifiable.
    const complete = strip(api("services/evidence-complete.service.ts"));
    expect(complete).toMatch(/createEvidenceTimestamp\(\{\s*digestHex/);
    const gateBefore = complete.slice(0, complete.indexOf("createEvidenceTimestamp"));
    expect(gateBefore).not.toMatch(/reportsIncluded|canPlanGenerateReports/);
  });
});

describe("SCENARIO 2 — FREE hits its limit before anything is created", () => {
  it("BEHAVIOUR: the fourth record is refused", () => {
    expect(
      resolvePersonalEvidenceAdmission({
        plan: "FREE",
        currentRecordCount: 3,
        effectiveLifetimeRecordCap: 3,
        availableEvidenceCredits: 0,
      }),
    ).toEqual({ allowed: false, reason: "PLAN_ALLOWANCE_EXHAUSTED_NO_CREDITS" });
  });

  it("WIRING: admission runs BEFORE the row is inserted, so nothing is stranded", () => {
    /*
     * The order is the whole property. A record admitted after insertion would
     * leave a half-created row behind every refusal, and the customer would see
     * an evidence record that cannot be completed.
     */
    const svc = strip(api("services/evidence.service.ts"));
    const gate = svc.indexOf("assertWorkspaceAllowsEvidenceCreation");
    const insert = svc.indexOf("tx.evidence.create");
    expect(gate).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(gate);
  });
});

describe("SCENARIO 3 — a purchased credit funds a record and earns its outputs", () => {
  it("BEHAVIOUR: a credit-funded record on a FREE account earns report AND package", () => {
    // The account stays FREE — that is the design of the credit wallet — so
    // asking the plan alone is what refused a customer their own paid report.
    const outputs = resolveEvidenceOutputEntitlements({
      plan: "FREE",
      funding: "EVIDENCE_CREDIT",
    });
    expect(outputs).toEqual({
      reportsIncluded: true,
      verificationPackageIncluded: true,
      publicVerifyIncluded: true,
    });
  });

  it("WIRING: retry consumes no second credit — the ledger row is the idempotency key", () => {
    const enf = strip(api("services/billing-enforcement.service.ts"));
    // A record that already paid is settled before admission is asked again.
    const settle = enf.slice(enf.indexOf("export async function settleEvidenceCompletionFunding"));
    const ledgerCheck = settle.indexOf("evidenceCreditLedgerEntry.findUnique");
    const admissionCall = settle.indexOf("resolvePersonalEvidenceAdmission");
    expect(ledgerCheck).toBeGreaterThan(-1);
    expect(admissionCall).toBeGreaterThan(ledgerCheck);
  });

  it("WIRING: generation and regeneration touch the credit ledger nowhere", () => {
    // The ONE consumer of a credit is the completion settlement.
    const authority = strip(api("services/reports/report-generation-authority.service.ts"));
    expect(authority).not.toMatch(/consumeEvidenceCredit|creditsDelta/);
    const processorSrc = strip(worker("processor.ts"));
    expect(processorSrc).not.toMatch(/consumeEvidenceCredit/);
  });
});

describe("SCENARIO 4 — FREE upgrades to PRO and its history becomes generatable", () => {
  it("BEHAVIOUR: the historical record becomes ELIGIBLE_NOT_GENERATED and offers GENERATE", () => {
    const state = deriveEvidenceOutputState({
      eligibility: "ELIGIBLE",
      generation: "NOT_REQUESTED",
      availability: "NO_ARTIFACT",
      finalized: true,
    });
    expect(state).toBe("ELIGIBLE_NOT_GENERATED");
    expect(outputActionFor({ state, eligibility: "ELIGIBLE" })).toBe("GENERATE");
  });

  it("WIRING: nothing back-fills automatically — the action is the customer's", () => {
    // Billing reports a COUNT and a link. A plan change enqueues no work.
    const projection = strip(api("services/billing/billing-account-projection.service.ts"));
    expect(projection).toMatch(/historicalOutputEligibility/);
    expect(projection).not.toMatch(/requestReportGeneration|enqueue/);

    const planWriter = strip(api("services/billing/subscription-lifecycle.handlers.ts"));
    expect(planWriter).not.toMatch(/requestReportGeneration|enqueue/);
  });

  it("WIRING: the Generate action exists on the record's own page", () => {
    const tab = strip(web("app/(app)/evidence/[id]/_tabs/EvidenceArtifactsTab.tsx"));
    expect(tab).toMatch(/GenerateOutputsButton/);
    expect(tab).toMatch(/ELIGIBLE_NOT_GENERATED/);
    const actions = strip(
      web("app/(app)/evidence/[id]/_hooks/useEvidenceArtifactActions.ts"),
    );
    expect(actions).toMatch(/reports\/regenerate/);
  });
});

describe("SCENARIO 5 — a commercial FAILED_TERMINAL cannot lock a now-eligible record", () => {
  it("BEHAVIOUR: only a commercial terminal reason is obsoleted by a change of entitlement", () => {
    expect(isCommerciallyObsoleteTerminalReason("REPORT_NOT_INCLUDED_IN_PLAN")).toBe(true);
    expect(isCommerciallyObsoleteTerminalReason("VERIFICATION_PACKAGE_NOT_INCLUDED")).toBe(true);
    expect(isCommerciallyObsoleteTerminalReason("EVIDENCE_INTEGRITY_FAILED")).toBe(false);
    expect(isCommerciallyObsoleteTerminalReason("retry_budget_exhausted")).toBe(false);
  });

  it("BEHAVIOUR: the now-eligible record's action is GENERATE, not a dead retry", () => {
    expect(
      outputActionFor({
        state: "TERMINAL_FAILURE",
        eligibility: "ELIGIBLE",
        terminalReasonClass: "COMMERCIAL",
      }),
    ).toBe("GENERATE");
  });

  it("WIRING: the writer supersedes the old row instead of collapsing onto it", () => {
    const writer = readFileSync(
      fileURLToPath(
        new URL(
          "../../../packages/shared-runtime/src/reports/report-generation-request.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const code = strip(writer);
    expect(code).toMatch(/priorAtBaseKey/);
    expect(code).toMatch(/isCommerciallyObsoleteTerminalReason/);
    // A supersession ordinal derived from DB state, not a clock: two concurrent
    // callers compute the same key and the unique index still elects one.
    expect(code).toMatch(/\$\{baseKey\}:s\$\{supersessions \+ 1\}/);
    // The old row is never rewritten and never deleted.
    expect(code).not.toMatch(/reportGenerationRequest\.(update|delete)/);
  });
});

describe("SCENARIO 6 — PRO's lifetime allowance is exhausted and a credit continues", () => {
  it("BEHAVIOUR: at the cap with a credit, the next record is credit-funded", () => {
    expect(
      resolvePersonalEvidenceAdmission({
        plan: "PRO",
        currentRecordCount: 100,
        effectiveLifetimeRecordCap: 100,
        availableEvidenceCredits: 1,
      }),
    ).toEqual({ allowed: true, funding: "EVIDENCE_CREDIT" });
  });
});

describe("SCENARIO 7 — TEAM's rolling allowance is exhausted and a credit continues", () => {
  it("BEHAVIOUR: TEAM reaches the same wallet PRO does, through the same policy", () => {
    // The rolling allowance is expressed to the lifetime-shaped policy as an
    // exhausted cap, which is the whole of the change: one algorithm, not two.
    expect(
      resolvePersonalEvidenceAdmission({
        plan: "TEAM",
        currentRecordCount: 0,
        effectiveLifetimeRecordCap: 0,
        availableEvidenceCredits: 1,
      }),
    ).toEqual({ allowed: true, funding: "EVIDENCE_CREDIT" });
  });

  it("WIRING: the monthly branch no longer returns before the wallet is consulted", () => {
    const enf = strip(api("services/billing-enforcement.service.ts"));
    const gate = enf.slice(
      enf.indexOf("export async function assertWorkspaceAllowsEvidenceCreation"),
      enf.indexOf("export async function countPersonalEvidenceRecords"),
    );
    expect(gate).toMatch(/monthlyAdmission = resolvePersonalEvidenceAdmission/);
    // And settlement asks the same question, so an admitted record is charged.
    expect(enf).toMatch(/priorMonthlyCount/);
  });
});

describe("SCENARIO 8 — TEAM at its allowance with no credit is blocked before creation", () => {
  it("BEHAVIOUR: no wallet, no admission", () => {
    expect(
      resolvePersonalEvidenceAdmission({
        plan: "TEAM",
        currentRecordCount: 0,
        effectiveLifetimeRecordCap: 0,
        availableEvidenceCredits: 0,
      }),
    ).toEqual({ allowed: false, reason: "PLAN_ALLOWANCE_EXHAUSTED_NO_CREDITS" });
  });

  it("WIRING: the refusal names a remedy rather than just a limit", () => {
    const enf = api("services/billing-enforcement.service.ts");
    expect(enf).toMatch(/buy evidence credits to continue now/);
  });
});

describe("SCENARIO 9 — PRO downgrades to FREE and keeps what it generated", () => {
  it("BEHAVIOUR: an existing artifact stays READY and stays downloadable", () => {
    expect(
      deriveEvidenceOutputState({
        eligibility: "NOT_INCLUDED",
        generation: "NOT_REQUESTED",
        availability: "READY",
        finalized: true,
      }),
    ).toBe("READY");
  });

  it("WIRING: neither download route carries a commercial gate, and neither does the client", () => {
    const routes = strip(api("routes/evidence.routes.ts"));
    const reportRoute = routes.slice(
      routes.indexOf('"/v1/evidence/:id/report/latest"'),
      routes.indexOf('"/v1/evidence/:id/artifacts/status"'),
    );
    expect(reportRoute).not.toMatch(/reportsIncluded|REPORT_NOT_INCLUDED/);

    const actions = strip(
      web("app/(app)/evidence/[id]/_hooks/useEvidenceArtifactActions.ts"),
    );
    expect(actions).not.toMatch(/reportsIncluded|verificationPackageIncluded/);
  });

  it("BEHAVIOUR: new production follows the current plan — no Regenerate is offered", () => {
    expect(
      outputActionFor({ state: "READY", eligibility: "NOT_INCLUDED" }),
    ).toBe("NONE");
  });
});

describe("SCENARIO 10 — a credit-funded record survives the downgrade with its outputs", () => {
  it("BEHAVIOUR: funding, not the current plan, decides what that record is owed", () => {
    // The account is FREE both before and after; the record's entitlement is
    // attached to the RECORD and does not lapse with a subscription.
    expect(
      resolveEvidenceOutputEntitlements({ plan: "FREE", funding: "EVIDENCE_CREDIT" })
        .reportsIncluded,
    ).toBe(true);
  });

  it("WIRING: the funding row is the authority, read identically by both hosts", () => {
    expect(strip(api("services/billing/evidence-credits.service.ts"))).toMatch(
      /export async function resolveEvidenceFunding\b/,
    );
    expect(strip(worker("workspace-billing.ts"))).toMatch(
      /export async function resolveEvidenceFundingSource\b/,
    );
  });
});

describe("SCENARIO 11 — TEAM downgrades to PRO holding more records than PRO includes", () => {
  it("BEHAVIOUR: the frozen cap admits nothing new but invalidates nothing existing", () => {
    // 350 held, cap frozen at 350: the history is intact and record 351 needs a
    // credit or a higher plan — which is what the customer chose.
    expect(
      resolvePersonalEvidenceAdmission({
        plan: "PRO",
        currentRecordCount: 350,
        effectiveLifetimeRecordCap: 350,
        availableEvidenceCredits: 0,
      }),
    ).toEqual({ allowed: false, reason: "PLAN_ALLOWANCE_EXHAUSTED_NO_CREDITS" });
    expect(
      resolvePersonalEvidenceAdmission({
        plan: "PRO",
        currentRecordCount: 350,
        effectiveLifetimeRecordCap: 350,
        availableEvidenceCredits: 1,
      }),
    ).toEqual({ allowed: true, funding: "EVIDENCE_CREDIT" });
  });

  it("WIRING: the freeze happens in the ONE writer of the plan, and clears on an uncapped plan", () => {
    const billing = strip(api("services/billing.service.ts"));
    const setter = billing.slice(billing.indexOf("export async function setPersonalPlan"));
    expect(setter).toMatch(/nextCaps\.maxEvidenceRecords === null/);
    expect(setter).toMatch(/legacyRecordCapOverride: null/);
    expect(setter).toMatch(/countPersonalEvidenceRecords/);
    // No SECOND override field was introduced for the same number.
    expect(billing).not.toMatch(/downgradeRecordCap|grandfatherCap/);
  });
});

describe("SCENARIO 12 — a TSA failure is not retried, and nothing pretends otherwise", () => {
  it("WIRING: no TSA queue, job, route or button exists", () => {
    expect(strip(worker("processor.ts"))).not.toMatch(/enqueueTsa|tsaRetry|TSA_RETRY/i);
    expect(strip(api("routes/evidence.routes.ts"))).not.toMatch(
      /tsa\/retry|retry-timestamp|retryTimestamp/i,
    );
    const registry = api("services/operations/remediation-registry.ts");
    expect(registry).toMatch(
      /tsa_failure:\s*\{\s*disposition:\s*"NO_SAFE_REMEDIATION_AUTHORITY"/,
    );
  });

  it("WIRING: the operator is told the truth rather than offered a retry", () => {
    const cc = api("services/dashboard/command-center.service.ts");
    const tsa = cc.slice(cc.indexOf("tsa_failed: {"), cc.indexOf("ots_failed: {"));
    expect(tsa).not.toMatch(/retry anchoring/i);
  });
});

describe("SCENARIO 13 — the safe stored-token TSA repair is preserved", () => {
  it("WIRING: the repair re-parses the STORED token and never re-contacts the provider", () => {
    const script = api("scripts/repair-tsa-failed-with-token.ts");
    expect(script).toMatch(/Never re-contacts the TSA provider/);
    expect(script).toMatch(/tsaStatus:\s*"STAMPED"/);
    // And it asks for a fresh artifact under the bounded repair purpose.
    expect(script).toMatch(/purpose:\s*"tsa_repair"/);
    // It is an operator CLI, not a route or a button.
    expect(strip(api("routes/evidence.routes.ts"))).not.toMatch(/repair-tsa/);
  });
});

describe("SCENARIO 14 — a late OTS anchor produces a NEW artifact version", () => {
  it("WIRING: anchoring asks for a forced regeneration, gated on current entitlement", () => {
    const ots = strip(worker("ots-upgrade.processor.ts"));
    expect(ots).toMatch(/purpose:\s*"ots_upgrade_completed"/);
    expect(ots).toMatch(/forceRegenerate:\s*true/);
    // The producer both OTS and lifecycle recovery reach checks eligibility, so
    // a record the plan excludes gets no doomed request.
    expect(strip(worker("processor.ts"))).toMatch(/report\.enqueue\.skipped_not_included/);
  });

  it("WIRING: the new version is created beside the old one, never over it", () => {
    const p = strip(worker("processor.ts"));
    expect(p).toMatch(/currentMaxReport\._max\.version \?\? 0\) \+ 1/);
    expect(p).toMatch(/v\$\{provisionalVersion\}\.pdf/);
    expect(p).toMatch(/v\$\{provisionalVersion\}\.zip/);
  });
});

describe("SCENARIO 15 — a FREE workspace does not pollute Operations", () => {
  it("WIRING: the artifact backlogs and the pipeline conditions are entitlement-narrowed", () => {
    expect(strip(api("services/dashboard/command-center-counters.ts"))).toMatch(
      /outputEntitledWhere/,
    );
    expect(strip(api("services/operations/operations-source-probes.ts"))).toMatch(
      /outputEntitledWhere/,
    );
  });

  it("WIRING: a commercial denial opens no incident", () => {
    const p = strip(worker("processor.ts"));
    const denial = p.indexOf("if (isPlanDenial) {");
    const capture = p.indexOf("captureException(error", denial);
    expect(p.slice(denial, capture)).not.toMatch(/recordReportFailureIncident/);
  });
});

describe("SCENARIO 16 — a real technical failure is visible and retryable", () => {
  it("BEHAVIOUR: a retryable failure surfaces as RETRYABLE_FAILURE and offers RETRY", () => {
    const state = deriveEvidenceOutputState({
      eligibility: "ELIGIBLE",
      generation: "RETRYABLE_FAILURE",
      availability: "NO_ARTIFACT",
      finalized: true,
    });
    expect(state).toBe("RETRYABLE_FAILURE");
    expect(outputActionFor({ state, eligibility: "ELIGIBLE" })).toBe("RETRY");
  });

  it("WIRING: a real fault still DLQs and still opens an incident", () => {
    const p = strip(worker("processor.ts"));
    expect(p).toMatch(/reportDlqQueue\.add\(/);
    expect(p).toMatch(/recordReportFailureIncident\(\{/);
  });

  it("WIRING: the retry budget is bounded and its exhaustion is terminal", () => {
    const auth = strip(worker("report-generation-authority.ts"));
    expect(auth).toMatch(/REPORT_RECONCILE_MAX_ATTEMPTS/);
    expect(auth).toMatch(/terminalReasonCode:\s*"retry_budget_exhausted"/);
  });
});

describe("SCENARIO 17 — a terminal failure is never reported as satisfied", () => {
  it("WIRING: only SUCCEEDED is ALREADY_SATISFIED", () => {
    const exec = strip(api("services/operations/remediation-executor.ts"));
    expect(exec).toMatch(/terminalState === "SUCCEEDED"/);
    expect(exec).toMatch(/outcome\("NOT_ELIGIBLE", requested\.requestId\)/);
  });

  it("BEHAVIOUR: a non-commercial terminal failure offers no customer action", () => {
    for (const cls of ["INTEGRITY", "POLICY", "TECHNICAL"] as const) {
      expect(
        outputActionFor({
          state: "TERMINAL_FAILURE",
          eligibility: "ELIGIBLE",
          terminalReasonClass: cls,
        }),
      ).toBe("NONE");
    }
  });
});

describe("SCENARIO 18 — active attention clears from domain truth; history remains", () => {
  it("WIRING: the inbox withholds a notification whose condition has closed, without mutating it", () => {
    const inbox = strip(api("routes/me-inbox.routes.ts"));
    expect(inbox).toMatch(/resolvedIncidentIds/);
    // The row is READ, never written.
    const block = inbox.slice(
      inbox.indexOf("const governanceCandidates"),
      inbox.indexOf("const governanceRows"),
    );
    expect(block).not.toMatch(/governanceNotification\.(update|delete)/);
  });

  it("WIRING: the incident resolver closes from positive domain evidence, not from absence", () => {
    const integrity = api("services/operations/evidence-integrity-conditions.service.ts");
    expect(integrity).toMatch(/Unreadable or gone: NOT proof of recovery/);
    expect(integrity).toMatch(/AUTO_RESOLVE_SOURCE_RECOVERY/);
  });
});

// ===========================================================================
// The commercial-plan resolution itself, as the journeys assume it.
// ===========================================================================

describe("the effective plan a journey starts from", () => {
  it("BEHAVIOUR: a Personal Workspace resolves at its OWNER's entitlement", () => {
    // Which is why reading `Team.billingPlan` reported FREE for a PRO customer:
    // that column has one writer and it is Enterprise provisioning.
    expect(
      resolveWorkspaceEffectivePlan({
        workspaceKind: "PERSONAL",
        billingPlan: "FREE",
        billingStatus: "INACTIVE",
        ownerPlan: "PRO",
      }),
    ).toEqual({ plan: "PRO", source: "PERSONAL_ENTITLEMENT" });
  });

  it("BEHAVIOUR: an unprovable subject fails closed to FREE", () => {
    expect(
      resolveWorkspaceEffectivePlan({
        workspaceKind: "UNKNOWN",
        billingPlan: "ENTERPRISE",
        billingStatus: "ACTIVE",
        ownerPlan: "TEAM",
      }),
    ).toEqual({ plan: "FREE", source: "NONE" });
  });
});
