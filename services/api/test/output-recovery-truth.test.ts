/**
 * OUTPUT RECOVERY TRUTH (2026-10-12) — the API half.
 *
 *   * The supersession ordinal is parsed from the writer's `<baseKey>:s<n>`
 *     identity. The pattern once lacked its digit escape (`/:s(d+)$/`), so
 *     every ordinal read 0 and an exhausted chain offered "Retry" forever
 *     while the writer collapsed each click onto its terminal head.
 *   * A request the authority declined carries a bounded reason, so the web
 *     never reads a plan refusal as "a newer version already exists".
 *   * The new-version concurrency cap is keyed on the canonical workspace,
 *     so a Personal record stored with team_id NULL is capped too.
 *   * The output facts carry the ET-COM-06 first-issuance rule.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MAX_TERMINAL_SUPERSESSIONS, resolveEvidenceOutputActions } from "@proovra/shared";

import {
  declinedOutcomeReason,
  supersessionOrdinalOf,
} from "../src/services/reports/output-recovery.service.js";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
}

const BASE = "REPORT:00000000-0000-0000-0000-000000000001:v0";

describe("supersession ordinal", () => {
  it("parses the writer's :s<n> suffix", () => {
    expect(supersessionOrdinalOf(BASE)).toBe(0);
    expect(supersessionOrdinalOf(`${BASE}:s1`)).toBe(1);
    expect(supersessionOrdinalOf(`${BASE}:s5`)).toBe(5);
    expect(supersessionOrdinalOf(`${BASE}:s12`)).toBe(12);
    expect(supersessionOrdinalOf(null)).toBe(0);
    // The broken pattern matched a literal "d"; that is not an ordinal.
    expect(supersessionOrdinalOf(`${BASE}:sd`)).toBe(0);
  });

  it("the head after the budget is spent settles to ESCALATED_TO_OPERATOR, not Retry", () => {
    const decide = (key: string) =>
      resolveEvidenceOutputActions({
        record: "FINALIZED",
        reportEligibility: "ELIGIBLE",
        packageEligibility: "ELIGIBLE",
        latestReportVersion: null,
        packageAtLatestReport: false,
        latestPackageVersion: null,
        packageBlockedByGovernance: false,
        reportRequest: {
          state: "FAILED_TERMINAL",
          terminalReasonCode: "REPORT_RENDER_FAILED",
          supersessionOrdinal: supersessionOrdinalOf(key),
        },
        packageRequest: null,
        restrictions: {
          lifecycleState: "ACTIVE",
          legalHold: false,
          workspaceSuspended: false,
          workspaceClosed: false,
          workspaceResolved: true,
        },
        callerMayGenerate: true,
        callerMaySupersede: true,
        newVersionFitsStorage: true,
      }).report;
    // Five supersessions offered (base .. :s4); the sixth identity is the
    // writer's last (:s5) and its failure is escalated.
    for (let n = 0; n < MAX_TERMINAL_SUPERSESSIONS; n += 1) {
      const key = n === 0 ? BASE : `${BASE}:s${n}`;
      expect(decide(key).action, key).toBe("RETRY");
    }
    expect(decide(`${BASE}:s${MAX_TERMINAL_SUPERSESSIONS}`)).toEqual({
      action: "NONE",
      reason: "ESCALATED_TO_OPERATOR",
      operation: null,
    });
  });
});

describe("a declined request carries a bounded reason", () => {
  it("maps the authority's outcomes to the shared vocabulary", () => {
    expect(declinedOutcomeReason("NOT_INCLUDED", "not_included_in_plan")).toBe("NOT_INCLUDED");
    expect(declinedOutcomeReason("NOT_INCLUDED", "first_issuance_awaits_confirmed_payment")).toBe(
      "AWAITING_CONFIRMED_PAYMENT",
    );
    expect(declinedOutcomeReason("ENTITLEMENT_UNAVAILABLE", "entitlement_unresolved")).toBe(
      "ENTITLEMENT_UNAVAILABLE",
    );
    expect(declinedOutcomeReason("WORKSPACE_UNRESOLVED", "evidence_workspace_unresolved")).toBe(
      "WORKSPACE_UNRESOLVED",
    );
    // No truthful lifecycle reason: left null, read by its outcome.
    expect(declinedOutcomeReason("REQUEST_PERSIST_FAILED", "request_persist_failed")).toBeNull();
  });

  it("fromRequested uses it", () => {
    const src = readApi("services/reports/output-recovery.service.ts");
    expect(src).toMatch(/reason: declinedOutcomeReason\(requested\.outcome, requested\.reason\)/);
    expect(src).not.toMatch(/kind: "declined", outcome: requested\.outcome, reason: null/);
  });
});

describe("source contracts", () => {
  it("the output facts carry the ET-COM-06 first-issuance rule", () => {
    const src = readApi("services/reports/output-recovery.service.ts");
    expect(src).toMatch(/firstIssuanceAwaitsConfirmedPayment:\s*\n?\s*latestReport == null &&/);
    expect(src).toMatch(/mayIssueHistoricalFirstOutputs === false/);
  });

  it("the new-version concurrency cap is keyed on the canonical workspace", () => {
    const src = readApi("routes/evidence.routes.ts");
    expect(src).toMatch(/const capWorkspaceId = isNewVersion\s*\?\s*await resolveEvidenceWorkspaceId\(evidenceRecord, prisma\)/);
    expect(src).toMatch(/if \(isNewVersion && capWorkspaceId\)/);
    expect(src).not.toMatch(/if \(isNewVersion && evidenceRecord\.teamId\)/);
  });
});
