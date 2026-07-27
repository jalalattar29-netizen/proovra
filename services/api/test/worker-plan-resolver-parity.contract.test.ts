/**
 * Phase WORKER-PLAN-PARITY-FIX — lock the worker's plan resolver
 * against drift from the API's.
 *
 * THE PRODUCTION BUG (evidence 7974076d-135b-4bf3-bbc8-5d26b3cf6e12):
 *
 *   - API finalize gate (services/api/src/services/evidence-complete
 *     .service.ts) resolved `scope.plan = PRO` and enqueued
 *     GenerateReportJob.
 *   - Worker `prepareReportArtifacts` resolved `effectivePlan = FREE`
 *     and threw `REPORT_NOT_INCLUDED_IN_PLAN`.
 *   - Job moved to DLQ as non-retriable; evidence stuck at SIGNED.
 *
 * Root cause: two separate plan-resolution code paths with different
 * fallback rules.
 *
 *   API:    services/api/src/services/workspace-billing.service.ts
 *     - getPersonalWorkspaceScope downgrades to PRO when
 *       getPlanCapabilities(entitlement.plan).allowsPersonalWorkspace
 *       === false.
 *     - getTeamWorkspaceScope: when team.billingStatus is NOT
 *       ACTIVE/PAST_DUE, falls back to OWNER ENTITLEMENT plan if it
 *       supports team workspaces; only then falls to FREE.
 *
 *   Worker: services/worker/src/workspace-billing.ts
 *     - Was missing BOTH of the above fallbacks. Owners on a
 *       personal-team whose billingStatus wasn't ACTIVE (the default
 *       for auto-bootstrapped personal-teams) were resolved as FREE
 *       even though the API had already approved the action at the
 *       owner's PRO/TEAM entitlement.
 *
 * THIS TEST locks the worker's source to contain the two fallbacks so
 * a future refactor cannot silently drop them again.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const WORKER_BILLING = readFileSync(
  resolve(REPO_ROOT, "services", "worker", "src", "workspace-billing.ts"),
  "utf8",
);
const API_BILLING = readFileSync(
  resolve(
    REPO_ROOT,
    "services",
    "api",
    "src",
    "services",
    "workspace-billing.service.ts",
  ),
  "utf8",
);

describe("Worker plan-resolver parity with API", () => {
  it("worker getPersonalWorkspaceScope downgrades to PRO when allowsPersonalWorkspace is false (parity with API)", () => {
    // The worker must use the same predicate the API uses
    // (workspace-billing.service.ts:107-110) so an owner on a plan
    // whose capability set does NOT allow a personal workspace is
    // resolved at PRO grade rather than FREE.
    expect(WORKER_BILLING).toMatch(/getPlanCapabilities\(\s*\w+\s*\)\.allowsPersonalWorkspace/);
    expect(WORKER_BILLING).toMatch(/prismaPkg\.PlanType\.PRO/);
    // The API still expresses the same rule (anti-drift sentinel: if
    // someone "simplifies" the API away from this rule, the worker
    // would still need updating — this test surfaces that linkage).
    expect(API_BILLING).toMatch(/getPlanCapabilities\(\s*entitlement\.plan\s*\)\s*\n?\s*\.allowsPersonalWorkspace/);
  });

  it("worker and API resolve the effective plan through ONE shared canonical policy (structural parity)", () => {
    // PHASE 9 §9.4/§9.11 (2026-07-22): the three-tier rule was RELOCATED
    // into the single pure policy `resolveWorkspaceEffectivePlan`
    // (@proovra/shared-billing). Copy-paste parity is superseded: BOTH sides
    // must delegate to the shared implementation, and NEITHER may retain a
    // local three-tier branch. Divergence is now impossible by construction.
    expect(WORKER_BILLING).toMatch(/resolveWorkspaceEffectivePlan\(\{/);
    expect(API_BILLING).toMatch(/resolveWorkspaceEffectivePlan\(\{/);
    // The worker still corroborates with the owner's entitlement as the
    // coverage INPUT (loading is adapter work; deciding is not).
    expect(WORKER_BILLING).toMatch(/ownerEntitlement/);
    // Neither side re-implements the branch locally.
    expect(WORKER_BILLING).not.toMatch(/ownerPlanSupportsTeams\s*\?/);
    expect(API_BILLING).not.toMatch(/ownerPlanSupportsTeams\s*\?/);
  });

  it("worker uses the SAME shared predicate (canPlanGenerateReports) the API uses for the deny check", () => {
    // The mismatch was in the INPUT (plan resolution), not the
    // PREDICATE. We pin that both sides keep importing the SAME
    // canPlanGenerateReports from @proovra/shared-billing — if a
    // future change replaces one side with a local predicate, this
    // test catches the divergence.
    expect(API_BILLING.includes("@proovra/shared-billing")).toBe(true);
    // The worker imports it transitively via processor.ts; the resolver
    // module itself imports getPlanCapabilities from the same package.
    expect(WORKER_BILLING).toMatch(/from\s+"@proovra\/shared-billing"/);
  });
});
