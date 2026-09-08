/**
 * COMMERCIAL + EVIDENCE OUTPUT LIFECYCLE CLOSURE — the invariants.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PINS, AND WHY EACH ONE IS HERE
 * ---------------------------------------------------------------------------
 * Every assertion below corresponds to a defect that reached production. They
 * are grouped by the question they protect, and each one names the symptom it
 * would have caught, because a guard whose reason is not written down is a
 * guard the next person deletes.
 *
 * The source-contract checks (regex over real file text) are deliberate: the
 * defects were not logic errors inside a function, they were the WRONG SOURCE
 * being read at a call site. A unit test over the function cannot see that; a
 * search over the file can.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  classifyTerminalReason,
  deriveEvidenceOutputState,
  isCommerciallyObsoleteTerminalReason,
  outputActionFor,
  projectReportRequestState,
} from "@proovra/shared";
import {
  getPlanCapabilities,
  resolveEvidenceOutputEntitlements,
  resolvePersonalEvidenceAdmission,
  resolveWorkspaceIntakeEntitlement,
} from "@proovra/shared-billing";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}
function readWorker(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../worker/src/${rel}`, import.meta.url)),
    "utf8",
  );
}

/** Comments describe defects and legitimately quote the old code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ===========================================================================
// A. EFFECTIVE PLAN — one authority, and no raw column in a customer surface
// ===========================================================================

describe("effective plan has one authority", () => {
  it("workspace-admin projects the resolved plan, never the raw column, as `effectivePlan`", () => {
    const src = readApi("services/workspace-admin/workspace-admin.service.ts");
    const code = stripComments(src);
    // The symptom: `plan: String(team.billingPlan)` rendered as "Plan" — always
    // FREE on a Personal Workspace, whatever the owner paid.
    expect(code).toMatch(/resolveCommercialContext\(/);
    expect(code).toMatch(/effectivePlan/);
    expect(code).not.toMatch(/\bplan:\s*String\(team\.billingPlan\)/);
  });

  it("the raw column survives only under a name that says what it is", () => {
    const code = stripComments(
      readApi("services/workspace-admin/workspace-admin.service.ts"),
    );
    expect(code).toMatch(/persistedBillingPlan:\s*String\(team\.billingPlan\)/);
  });

  it("GET /v1/teams/:id sends the effective plan alongside the raw columns", () => {
    const code = stripComments(readApi("routes/teams.routes.ts"));
    expect(code).toMatch(/effectivePlan:\s*commercial\.plan/);
  });

  it("the workspace admin panel renders effectivePlan and never the persisted column", () => {
    const code = stripComments(
      readWeb("components/workspace-admin/WorkspaceAdminPanel.tsx"),
    );
    expect(code).toMatch(/env\.workspace\.effectivePlan/);
    expect(code).not.toMatch(/env\.workspace\.persistedBillingPlan/);
  });

  it("the People page never falls back to the raw column and never fabricates FREE", () => {
    const code = stripComments(readWeb("app/(app)/teams/[id]/page.tsx"));
    // The symptom: `effectivePlan ?? billingPlan` with a "FREE" default, on a
    // response that never carried `effectivePlan` at all.
    expect(code).not.toMatch(/team\?\.effectivePlan\s*\?\?\s*team\?\.billingPlan/);
    expect(code).not.toMatch(/normalizePlanLabel\([^)]*,\s*"FREE"\)/);
  });

  it("platform context resolves the active workspace plan through the canonical scope resolver", () => {
    const code = stripComments(
      readApi("services/platform-context/platform-context.service.ts"),
    );
    // The canonical PUBLIC resolver, with an explicit subject. Phase 9 pins the
    // count of files reaching past it at zero, so this projection may not use
    // the lower-level scope adapters even though they are cheaper per call.
    expect(code).toMatch(/resolveCommercialContext\(/);

    /*
     * The symptom: a private `entitlement.findFirst` overlay onto
     * `team.billingPlan` — a SECOND implementation of the effective-plan
     * decision, whose own comment recorded the incident that came from the two
     * copies disagreeing.
     *
     * Counted rather than forbidden. Exactly ONE entitlement read may remain,
     * and it answers a DIFFERENT question: `accountPlan`, the account-tier plan
     * that follows the user rather than any workspace. A second one would be
     * the workspace overlay coming back.
     */
    const entitlementReads = code.match(/prisma\.entitlement\.findFirst\(/g) ?? [];
    expect(entitlementReads).toHaveLength(1);
  });

  it("the Personal Space plan does not depend on which workspace is selected", () => {
    const code = stripComments(
      readApi("services/platform-context/platform-context.service.ts"),
    );
    // The symptom: `workspace.scope === "PERSONAL" ? workspace.plan : null`,
    // so switching to an organization rendered "Plan: —" for your own space.
    expect(code).toMatch(/personalSpacePlan/);
    expect(code).not.toMatch(
      /plan:\s*workspace\.scope === "PERSONAL" \? workspace\.plan : null/,
    );
  });
});

// ===========================================================================
// B. OUTPUT ELIGIBILITY — per RECORD, never per plan alone
// ===========================================================================

describe("output eligibility is a per-record question", () => {
  it("a credit-funded record earns its outputs on a FREE account", () => {
    const outputs = resolveEvidenceOutputEntitlements({
      plan: "FREE",
      funding: "EVIDENCE_CREDIT",
    });
    expect(outputs.reportsIncluded).toBe(true);
    expect(outputs.verificationPackageIncluded).toBe(true);
    expect(outputs.publicVerifyIncluded).toBe(true);
  });

  it("a plan-funded FREE record does not", () => {
    const outputs = resolveEvidenceOutputEntitlements({
      plan: "FREE",
      funding: "PLAN",
    });
    expect(outputs.reportsIncluded).toBe(false);
    expect(outputs.verificationPackageIncluded).toBe(false);
    // Public verification is included on FREE and is never the thing a paid
    // record loses.
    expect(outputs.publicVerifyIncluded).toBe(true);
  });

  it("the evidence capability snapshot asks the record-aware resolver", () => {
    const code = stripComments(readApi("routes/evidence.routes.ts"));
    expect(code).toMatch(/resolveEvidenceOutputEligibility\(/);
    // The symptom: `reportsIncluded: Boolean(caps.reportsIncluded)` — the plan
    // alone — used by the browser as a hard download precondition.
    expect(code).not.toMatch(/reportsIncluded:\s*Boolean\(caps\.reportsIncluded\)/);
  });

  it("the browser no longer blocks a download on the workspace plan", () => {
    const code = stripComments(readWeb("app/(app)/evidence/[id]/page.tsx"));
    expect(code).not.toMatch(/if \(!workspaceCaps\.reportsIncluded\)/);
    expect(code).not.toMatch(/if \(!workspaceCaps\.verificationPackageIncluded\)/);
  });

  it("the plan-only output gates are gone", () => {
    const code = readApi("services/billing-enforcement.service.ts");
    // Proven zero-consumer before deletion. They are removed rather than left
    // dormant because a dormant plan-only gate is what the next change reuses.
    expect(code).not.toMatch(/export async function assertWorkspaceAllowsReport\b/);
    expect(code).not.toMatch(
      /export async function assertWorkspaceAllowsVerificationPackage\b/,
    );
  });
});

// ===========================================================================
// C. THE STATE MACHINE — NOT_INCLUDED is real, and "pending" means pending
// ===========================================================================

describe("the output state machine", () => {
  const finalized = true;

  it("an excluded output is NOT_INCLUDED, never pending", () => {
    // THE headline defect: a Free finalized record reported `pending: true`
    // forever, on every surface, because absence was read as pending.
    expect(
      deriveEvidenceOutputState({
        eligibility: "NOT_INCLUDED",
        generation: "NOT_REQUESTED",
        availability: "NO_ARTIFACT",
        finalized,
      }),
    ).toBe("NOT_INCLUDED");
  });

  it("an entitled record with nothing produced is ELIGIBLE_NOT_GENERATED and offers GENERATE", () => {
    const state = deriveEvidenceOutputState({
      eligibility: "ELIGIBLE",
      generation: "NOT_REQUESTED",
      availability: "NO_ARTIFACT",
      finalized,
    });
    expect(state).toBe("ELIGIBLE_NOT_GENERATED");
    expect(outputActionFor({ state, eligibility: "ELIGIBLE" })).toBe("GENERATE");
  });

  it("an existing artifact stays READY after entitlement lapses, and stops offering a new version", () => {
    // The downgrade contract: what was generated is preserved and downloadable;
    // only NEW production follows the current plan.
    const state = deriveEvidenceOutputState({
      eligibility: "NOT_INCLUDED",
      generation: "NOT_REQUESTED",
      availability: "READY",
      finalized,
    });
    expect(state).toBe("READY");
    expect(outputActionFor({ state, eligibility: "NOT_INCLUDED" })).toBe("NONE");
    expect(outputActionFor({ state, eligibility: "ELIGIBLE" })).toBe("REGENERATE");
  });

  it("a retryable failure offers RETRY; a terminal one offers nothing unless it was commercial", () => {
    expect(
      outputActionFor({ state: "RETRYABLE_FAILURE", eligibility: "ELIGIBLE" }),
    ).toBe("RETRY");
    expect(
      outputActionFor({
        state: "TERMINAL_FAILURE",
        eligibility: "ELIGIBLE",
        terminalReasonClass: "INTEGRITY",
      }),
    ).toBe("NONE");
    // The upgrade case: the old refusal is history, and this is a FIRST
    // generation under the entitlement now held — so the verb is GENERATE.
    expect(
      outputActionFor({
        state: "TERMINAL_FAILURE",
        eligibility: "ELIGIBLE",
        terminalReasonClass: "COMMERCIAL",
      }),
    ).toBe("GENERATE");
  });

  it("projects the persisted request states without leaking the worker's vocabulary", () => {
    expect(projectReportRequestState("QUEUED")).toBe("QUEUED");
    expect(projectReportRequestState("PROCESSING")).toBe("PROCESSING");
    expect(projectReportRequestState("FAILED_RETRYABLE")).toBe("RETRYABLE_FAILURE");
    expect(projectReportRequestState("FAILED_TERMINAL")).toBe("TERMINAL_FAILURE");
    expect(projectReportRequestState("BLOCKED_POLICY")).toBe("BLOCKED");
    expect(projectReportRequestState("BLOCKED_STALE")).toBe("BLOCKED");
    // A finished request is not an ongoing operation; the artifact is axis 3.
    expect(projectReportRequestState("SUCCEEDED")).toBe("NOT_REQUESTED");
  });

  it("only commercial terminal reasons are superseded by a change of entitlement", () => {
    expect(isCommerciallyObsoleteTerminalReason("REPORT_NOT_INCLUDED_IN_PLAN")).toBe(true);
    expect(isCommerciallyObsoleteTerminalReason("VERIFICATION_PACKAGE_NOT_INCLUDED")).toBe(true);
    // Buying something does not repair a hash mismatch or an exhausted budget.
    expect(isCommerciallyObsoleteTerminalReason("EVIDENCE_INTEGRITY_FAILED")).toBe(false);
    expect(isCommerciallyObsoleteTerminalReason("retry_budget_exhausted")).toBe(false);
    expect(isCommerciallyObsoleteTerminalReason(null)).toBe(false);
    expect(classifyTerminalReason("REPORT_NOT_INCLUDED_IN_PLAN")).toBe("COMMERCIAL");
    expect(classifyTerminalReason("EVIDENCE_INTEGRITY_FAILED")).toBe("INTEGRITY");
  });

  it("the artifact-status projection takes the record's owner and derives all three axes", () => {
    const code = stripComments(readApi("services/evidence-artifact-status.service.ts"));
    expect(code).toMatch(/evidenceOwnerUserId/);
    expect(code).toMatch(/reportGenerationRequest/);
    expect(code).toMatch(/deriveEvidenceOutputState/);
    // The symptom: `const reportPending = finalized && !latestReport;`
    expect(code).not.toMatch(/reportPending\s*=\s*finalized\s*&&\s*!latestReport/);
  });

  it("the reports aggregator can reach `failed` and `unavailable`", () => {
    const code = stripComments(readApi("services/reports/reports-aggregator.service.ts"));
    expect(code).toMatch(/deriveEvidenceOutputState/);
    expect(code).toMatch(/FAILED_RETRYABLE/);
    // The symptom: `case "report_failed": return { id: { in: [] } }` — a filter
    // that matched nothing, beside a control gated on the state it never
    // produced.
    expect(code).not.toMatch(/case "report_failed":\s*return \{ id: \{ in: \[\] \} \}/);
  });

  it("the Reports page drives its action from the lifecycle, not from absence", () => {
    const code = stripComments(readWeb("components/reports-experience/ReportsIndex.tsx"));
    expect(code).toMatch(/generationVerb/);
    expect(code).not.toMatch(
      /state:\s*row\.report\.available \? "ready" : "not_requested"/,
    );
  });

  it("the package endpoint answers a commercial refusal instead of eternal pending", () => {
    const code = stripComments(readApi("routes/evidence.routes.ts"));
    expect(code).toMatch(/verification_package_not_included/);
  });
});

// ===========================================================================
// D. ADMISSION — allowance, then wallet, on every plan that has one
// ===========================================================================

describe("evidence admission", () => {
  it("FREE admits three records and then asks for a credit", () => {
    const within = resolvePersonalEvidenceAdmission({
      plan: "FREE",
      currentRecordCount: 2,
      effectiveLifetimeRecordCap: 3,
      availableEvidenceCredits: 0,
    });
    expect(within).toEqual({ allowed: true, funding: "PLAN" });

    const exhausted = resolvePersonalEvidenceAdmission({
      plan: "FREE",
      currentRecordCount: 3,
      effectiveLifetimeRecordCap: 3,
      availableEvidenceCredits: 0,
    });
    expect(exhausted).toEqual({
      allowed: false,
      reason: "PLAN_ALLOWANCE_EXHAUSTED_NO_CREDITS",
    });

    const funded = resolvePersonalEvidenceAdmission({
      plan: "FREE",
      currentRecordCount: 3,
      effectiveLifetimeRecordCap: 3,
      availableEvidenceCredits: 1,
    });
    expect(funded).toEqual({ allowed: true, funding: "EVIDENCE_CREDIT" });
  });

  it("TEAM's exhausted rolling allowance falls through to the wallet, like PRO's lifetime one", () => {
    // The asymmetry this closes: the monthly branch returned before the wallet
    // was ever consulted, so TEAM customers held paid, unspendable credits.
    const code = stripComments(readApi("services/billing-enforcement.service.ts"));
    expect(code).toMatch(/contractEvidenceCapIsHardMaximum/);
    // The rolling branch reaches the SAME pure policy PRO uses.
    expect(code).toMatch(/monthlyAdmission = resolvePersonalEvidenceAdmission/);
  });

  it("a contracted Enterprise capacity is a hard maximum a consumer credit may not raise", () => {
    const code = readApi("services/billing/enterprise-contract-limits.ts");
    expect(code).toMatch(/export function contractEvidenceCapIsHardMaximum/);
    // Stated, not inferred: the contract model has no overflow field, and
    // silence resolves to the safe reading rather than to a guess.
    expect(code).toMatch(/negotiated/i);
  });
});

// ===========================================================================
// E. INTAKE — the Pricing contract the plan flag contradicted
// ===========================================================================

describe("intake entitlement", () => {
  it("a funded wallet opens intake on a plan that excludes it", () => {
    expect(getPlanCapabilities("FREE").intakeIncluded).toBe(false);
    expect(
      resolveWorkspaceIntakeEntitlement({
        plan: "FREE",
        billingShape: "SINGLE_OCCUPANT",
        availableEvidenceCredits: 1,
      }),
    ).toEqual({ intakeIncluded: true, source: "EVIDENCE_CREDIT" });
  });

  it("an empty wallet does not", () => {
    expect(
      resolveWorkspaceIntakeEntitlement({
        plan: "FREE",
        billingShape: "SINGLE_OCCUPANT",
        availableEvidenceCredits: 0,
      }),
    ).toEqual({ intakeIncluded: false, source: "NONE" });
  });

  it("a shared workspace is never opened by a member's personal wallet", () => {
    expect(
      resolveWorkspaceIntakeEntitlement({
        plan: "FREE",
        billingShape: "SHARED",
        availableEvidenceCredits: 10,
      }),
    ).toEqual({ intakeIncluded: false, source: "NONE" });
  });

  it("the gate and the projected feature flag read the same rule", () => {
    expect(
      stripComments(readApi("services/billing-enforcement.service.ts")),
    ).toMatch(/resolveWorkspaceIntakeEntitlement/);
    expect(
      stripComments(readApi("services/platform-context/platform-context.service.ts")),
    ).toMatch(/resolveWorkspaceIntakeEntitlement/);
  });
});

// ===========================================================================
// F. OPERATIONS — a commercial decision is not an operational failure
// ===========================================================================

describe("operations population", () => {
  it("the artifact backlogs exclude records the product never generates for", () => {
    expect(stripComments(readApi("services/operations/operations-source-probes.ts")))
      .toMatch(/outputEntitledWhere/);
    expect(stripComments(readApi("services/dashboard/command-center-counters.ts")))
      .toMatch(/outputEntitledWhere/);
  });

  it("the worker opens no incident for a commercial denial", () => {
    const code = stripComments(readWorker("processor.ts"));
    expect(code).toMatch(/isCommercialDenialError/);

    /*
     * The symptom: the denial took the non-retriable DLQ path and
     * `recordReportFailureIncident({ severity: "CRITICAL" })` with it.
     *
     * Asserted STRUCTURALLY — the denial branch discards and rethrows, and it
     * does so BEFORE the DLQ block — rather than by proximity, which a log
     * statement of any length would break for no reason connected to the rule.
     */
    const denialAt = code.indexOf("if (isPlanDenial)");
    const dlqAt = code.indexOf("reportDlqQueue.add");
    const incidentAt = code.indexOf("recordReportFailureIncident({");
    expect(denialAt).toBeGreaterThan(-1);
    // Both the DLQ move and the incident belong to the FAILURE path, which the
    // denial branch returns before ever reaching.
    expect(dlqAt).toBeGreaterThan(denialAt);
    expect(incidentAt).toBeGreaterThan(denialAt);

    // The branch itself ends where the failure path begins — at the first
    // `captureException`, which a commercial outcome must never reach.
    const captureAt = code.indexOf("captureException(error", denialAt);
    expect(captureAt).toBeGreaterThan(denialAt);
    const denialBranch = code.slice(denialAt, captureAt);
    expect(denialBranch).toMatch(/job\.discard\(\)/);
    expect(denialBranch).toMatch(/throw error/);
    expect(denialBranch).not.toMatch(/recordReportFailureIncident/);
    expect(denialBranch).not.toMatch(/reportDlqQueue/);
  });

  it("the reconciler retires an exhausted retry budget instead of re-enqueueing forever", () => {
    const code = stripComments(readWorker("report-generation-authority.ts"));
    expect(code).toMatch(/REPORT_RECONCILE_MAX_ATTEMPTS/);
    expect(code).toMatch(/retry_budget_exhausted/);
  });

  it("remediation reports a terminal failure as terminal, not as satisfied", () => {
    const code = stripComments(readApi("services/operations/remediation-executor.ts"));
    // The symptom: every terminal state mapped to ALREADY_SATISFIED —
    // "Nothing to do — this has already completed" — on a record that had
    // terminally failed.
    expect(code).toMatch(/terminalState === "SUCCEEDED"/);
    expect(code).toMatch(/not_included_in_plan/);
  });
});

// ===========================================================================
// G. TSA — the absence is the correctness property
// ===========================================================================

describe("TSA has no retry, and nothing implies one", () => {
  it("no TSA queue, job or retry route is introduced", () => {
    const worker = stripComments(readWorker("processor.ts"));
    expect(worker).not.toMatch(/enqueueTsa|tsaRetryQueue|retryTsa|TSA_RETRY/i);
    const routes = stripComments(readApi("routes/evidence.routes.ts"));
    expect(routes).not.toMatch(/tsa\/retry|retry-timestamp|retryTimestamp/i);
  });

  it("the command-center catalog no longer advises retrying a timestamp", () => {
    const code = readApi("services/dashboard/command-center.service.ts");
    const tsaBlock = code.slice(
      code.indexOf("tsa_failed: {"),
      code.indexOf("ots_failed: {"),
    );
    expect(tsaBlock.length).toBeGreaterThan(0);
    // The symptom: "retry anchoring if appropriate" on a condition the
    // remediation registry classifies NO_SAFE_REMEDIATION_AUTHORITY.
    expect(tsaBlock).not.toMatch(/retry anchoring/i);
    expect(tsaBlock).toMatch(/cannot be obtained after the fact/i);
  });

  it("the remediation registry still refuses TSA and still offers OTS", () => {
    const code = readApi("services/operations/remediation-registry.ts");
    expect(code).toMatch(/tsa_failure:\s*\{\s*disposition:\s*"NO_SAFE_REMEDIATION_AUTHORITY"/);
    expect(code).toMatch(/ots_failure:\s*\{\s*disposition:\s*"DIRECT_REMEDIATION"/);
  });
});

// ===========================================================================
// H. VERSIONING — append-only, never overwritten
// ===========================================================================

describe("artifact versioning is append-only", () => {
  it("the worker creates a new version at a version-scoped key and never updates one", () => {
    const code = stripComments(readWorker("processor.ts"));
    expect(code).toMatch(/currentMaxReport\._max\.version \?\? 0\) \+ 1/);
    expect(code).toMatch(/reports\/\$\{evidence\.id\}\/v\$\{provisionalVersion\}\.pdf/);
    expect(code).toMatch(/verification\/\$\{evidence\.id\}\/v\$\{provisionalVersion\}\.zip/);
    expect(code).toMatch(/tx\.report\.create\(|tx\.verificationPackage\.create\(/);
    expect(code).not.toMatch(/tx\.report\.update\(\{\s*where:\s*\{\s*evidenceId/);
  });
});
