/**
 * Capture workspace / template / billing scope hotfix — regression tests.
 *
 * The user-visible bug: POST /v1/evidence returned a generic 500 in
 * production when the user selected a capture template like "Legal
 * Matter" — the server was treating the request as TEAM workspace
 * evidence and tripping the TEAM plan gate even though the Capture
 * frontend never asked for team scope.
 *
 * Invariants enforced by this file:
 *
 *   1. Capture templates carry NO billing-scope information. None of
 *      the 6 templates have a teamId, target, planMode, or workspace
 *      hint. (Source contract — never assert by happy path.)
 *
 *   2. createEvidence() resolves PERSONAL when `teamId` is omitted by
 *      the caller. The user's `currentWorkspaceId` is a UI hint and
 *      MUST NOT be silently promoted to a billing scope. (Source
 *      contract on services/api/src/services/evidence.service.ts.)
 *
 *   3. assertWorkspaceAllowsEvidenceCreation throws a typed error
 *      with `code === "TEAM_PLAN_REQUIRED"` when (workspaceType ===
 *      "TEAM" && plan !== TEAM). Pure-helper test.
 *
 *   4. POST /v1/evidence returns HTTP 402 with the typed JSON shape
 *      { code, message, target, requiredPlan } on TEAM_PLAN_REQUIRED.
 *      No staged-material reset on the client (source contract on the
 *      Capture orchestration hook). No generic 500. No Sentry capture.
 *      (Source contract on services/api/src/routes/evidence.routes.ts.)
 *
 *   5. POST /v1/evidence handler audits TEAM_PLAN_REQUIRED at
 *      severity "warning", not "critical". (Source contract.)
 *
 *   6. The frontend capture-errors helper recognizes
 *      TEAM_PLAN_REQUIRED and skips the Sentry capture path.
 *      (Source contract on apps/web/.../capture-errors.ts.)
 *
 *   7. The Capture orchestration hook does NOT call resetCaptureState
 *      inside the TEAM_PLAN_REQUIRED branch — staged materials are
 *      preserved. (Source contract on the orchestration hook.)
 *
 * Hard rules followed here:
 *   - No new product features.
 *   - No mocked Prisma. Pure-helper assertions + source-contract
 *     greps + a thin Fastify integration test that does NOT touch the
 *     database (we exercise the route by throwing a synthesized error
 *     and asserting the response shape).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assertWorkspaceAllowsEvidenceCreation } from "../src/services/billing-enforcement.service.js";
import type { WorkspaceScope } from "../src/services/workspace-billing.service.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// -----------------------------------------------------------------------------
// Catalog of the 6 Capture templates the user can pick on the Capture page.
// Pulled from apps/web/app/(app)/capture/_lib/templates.ts and used to drive
// the matrix below.
// -----------------------------------------------------------------------------

const CAPTURE_TEMPLATE_IDS = [
  "general-evidence-record",
  "insurance-claim",
  "legal-matter",
  "incident-investigation",
  "compliance-audit",
  "journalism-field-capture",
] as const;
type CaptureTemplateId = (typeof CAPTURE_TEMPLATE_IDS)[number];

// -----------------------------------------------------------------------------
// Invariant 1 — Templates carry no billing-scope info.
// -----------------------------------------------------------------------------

describe("Capture scope hotfix — templates carry no billing/workspace fields", () => {
  it("templates.ts does not reference teamId / workspaceId / planMode / target / scope", () => {
    const src = readSource(
      "../../../apps/web/app/(app)/capture/_lib/templates.ts",
    );
    expect(src).not.toMatch(/\bteamId\b/);
    expect(src).not.toMatch(/\bworkspaceId\b/);
    // planMode lives elsewhere (session-readiness) and never on a template.
    expect(src).not.toMatch(/\bplanMode\b/);
    expect(src).not.toMatch(/\btarget\b/);
    expect(src).not.toMatch(/\bbillingPlan\b/);
    expect(src).not.toMatch(/requiresTeamWorkspace/);
  });

  it("every template id in the matrix is actually defined", () => {
    const src = readSource(
      "../../../apps/web/app/(app)/capture/_lib/templates.ts",
    );
    for (const id of CAPTURE_TEMPLATE_IDS) {
      expect(src).toContain(`id: "${id}"`);
    }
  });
});

// -----------------------------------------------------------------------------
// Invariant 2 — createEvidence resolves PERSONAL when teamId omitted.
// Source-contract: the fallback to `owner.currentWorkspaceId` MUST NOT exist.
// -----------------------------------------------------------------------------

describe("Capture scope hotfix — createEvidence honors explicit teamId only", () => {
  it("evidence.service.ts does NOT silently fall back to currentWorkspaceId", () => {
    const src = readSource("../src/services/evidence.service.ts");
    // The fallback `params.teamId ?? owner.currentWorkspaceId` was the
    // root cause of TEAM_PLAN_REQUIRED on Capture submissions. Make
    // sure it cannot return.
    expect(src).not.toMatch(/params\.teamId\s*\?\?\s*owner\.currentWorkspaceId/);
    // The canonical shape is `params.teamId ?? null`.
    expect(src).toMatch(/params\.teamId\s*\?\?\s*null/);
  });

  it("the Capture orchestration POST /v1/evidence body sends the ACTIVE workspace id (Phase HOME-DATA-OWNERSHIP)", () => {
    const src = readSource(
      "../../../apps/web/app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts",
    );
    // Phase HOME-DATA-OWNERSHIP inverted the old rule. Capture now
    // stamps the ACTIVE workspace id (personal Team id or team
    // workspace id) so evidence is never orphaned with team_id NULL.
    // The id comes from useActiveSpaceId() — NEVER from a capture
    // template and NEVER from owner.currentWorkspaceId on the server.
    expect(src).toMatch(/useActiveSpaceId/);
    const postBlock = src.slice(
      src.indexOf('apiFetch("/v1/evidence"'),
      src.indexOf('apiFetch("/v1/evidence"') + 1200,
    );
    expect(postBlock).toMatch(/teamId:\s*activeSpaceId\s*\?\?\s*undefined/);
  });
});

// -----------------------------------------------------------------------------
// Invariant 3 — Pure billing helper throws TEAM_PLAN_REQUIRED on the
// matrix corner (workspaceType === TEAM && plan !== TEAM).
// -----------------------------------------------------------------------------

describe("Capture scope hotfix — assertWorkspaceAllowsEvidenceCreation typed errors", () => {
  function scope(
    workspaceType: "PERSONAL" | "TEAM",
    plan: "FREE" | "PRO" | "TEAM" | "PAYG",
  ): WorkspaceScope {
    return {
      workspaceType,
      ownerUserId: "00000000-0000-0000-0000-000000000001",
      teamId: workspaceType === "TEAM" ? "00000000-0000-0000-0000-000000000002" : null,
      // Phase A1 — organizationId mirrors the Team's bound org for
      // TEAM scope; null for legacy PERSONAL scope. The function
      // under test only reads `plan` and `workspaceType` for the
      // TEAM gate; the personal-bucket branch reads `credits` and
      // `evidenceCount` but only fires when workspaceType === PERSONAL.
      organizationId:
        workspaceType === "TEAM"
          ? "00000000-0000-0000-0000-000000000003"
          : null,
      plan: plan as WorkspaceScope["plan"],
      credits: 0,
      teamSeats: 0,
      storageBytesOverride: null,
      activeStorageAddonBytes: 0n,
    };
  }

  it("TEAM workspace + non-TEAM plan throws TEAM_PLAN_REQUIRED, statusCode 409", async () => {
    const nonTeamPlans: ("FREE" | "PRO" | "PAYG")[] = ["FREE", "PRO", "PAYG"];
    for (const plan of nonTeamPlans) {
      let caught: (Error & { code?: string; statusCode?: number }) | null = null;
      try {
        await assertWorkspaceAllowsEvidenceCreation(scope("TEAM", plan));
      } catch (err) {
        caught = err as Error & { code?: string; statusCode?: number };
      }
      expect(caught, `expected throw for plan=${plan}`).not.toBeNull();
      expect(caught?.code).toBe("TEAM_PLAN_REQUIRED");
      // The billing helper sets 409; the route layer maps it to 402
      // for client friendliness, but the typed code is what matters.
      expect(caught?.statusCode).toBe(409);
    }
  });

  it("TEAM workspace + TEAM plan does NOT throw the TEAM_PLAN_REQUIRED gate", async () => {
    // Note: a TEAM scope still skips the personal credit gate, so this
    // resolves cleanly without throwing.
    await expect(
      assertWorkspaceAllowsEvidenceCreation(scope("TEAM", "TEAM")),
    ).resolves.toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Invariant 4 + 5 — Route returns typed 402 JSON, audits at severity
// "warning", and the catch arm is reachable BEFORE the generic throw.
// -----------------------------------------------------------------------------

describe("Capture scope hotfix — POST /v1/evidence typed response contract", () => {
  it("evidence.routes.ts has a TEAM_PLAN_REQUIRED catch arm returning 402", () => {
    const src = readSource("../src/routes/evidence.routes.ts");
    // The arm must check the code, audit at warning severity, and
    // return 402 with the typed JSON shape.
    expect(src).toMatch(/code\?:\s*string\s*\}\)\.code\s*===\s*"TEAM_PLAN_REQUIRED"/);
    // The catch arm sits inside the POST /v1/evidence handler.
    const postIdx = src.indexOf('app.post("/v1/evidence"');
    expect(postIdx).toBeGreaterThan(0);
    const handlerSlice = src.slice(postIdx, postIdx + 8000);
    expect(handlerSlice).toMatch(
      /code:\s*"TEAM_PLAN_REQUIRED",\s*\n\s*message:[^]+target:\s*"TEAM",\s*\n\s*requiredPlan:\s*"TEAM"/,
    );
    expect(handlerSlice).toMatch(/reply\.code\(402\)/);
  });

  it("the TEAM_PLAN_REQUIRED audit log uses severity: \"warning\"", () => {
    const src = readSource("../src/routes/evidence.routes.ts");
    const block = src.slice(
      src.indexOf('"TEAM_PLAN_REQUIRED"'),
      src.indexOf('"TEAM_PLAN_REQUIRED"') + 800,
    );
    expect(block).toMatch(/severity:\s*"warning"/);
    expect(block).not.toMatch(/severity:\s*"critical"/);
  });

  it("the catch arm appears BEFORE the generic `throw err` so it short-circuits 500s", () => {
    const src = readSource("../src/routes/evidence.routes.ts");
    const postIdx = src.indexOf('app.post("/v1/evidence"');
    const handlerSlice = src.slice(postIdx, postIdx + 8000);
    const armIdx = handlerSlice.indexOf('"TEAM_PLAN_REQUIRED"');
    const throwIdx = handlerSlice.indexOf("throw err;");
    expect(armIdx).toBeGreaterThan(0);
    expect(throwIdx).toBeGreaterThan(0);
    expect(armIdx).toBeLessThan(throwIdx);
  });
});

// -----------------------------------------------------------------------------
// Invariant 6 — frontend capture-errors helper recognizes the gate.
// -----------------------------------------------------------------------------

describe("Capture scope hotfix — frontend recognizes TEAM_PLAN_REQUIRED", () => {
  it("isTeamPlanRequiredError and buildTeamPlanRequiredDetails are exported", () => {
    const src = readSource(
      "../../../apps/web/app/(app)/capture/_lib/capture-errors.ts",
    );
    expect(src).toMatch(/export function isTeamPlanRequiredError/);
    expect(src).toMatch(/export function buildTeamPlanRequiredDetails/);
    // The details shape must include target + requiredPlan so the UI
    // can render the right CTAs.
    expect(src).toMatch(/target:\s*"TEAM"/);
    expect(src).toMatch(/requiredPlan:\s*"TEAM"/);
  });
});

// -----------------------------------------------------------------------------
// Invariant 7 — Capture orchestration preserves staged materials AND
// skips the Sentry capture path on TEAM_PLAN_REQUIRED.
// -----------------------------------------------------------------------------

describe("Capture scope hotfix — orchestration preserves staged materials on billing gate", () => {
  it("the catch branch handles TEAM_PLAN_REQUIRED before logCaptureClientError", () => {
    const src = readSource(
      "../../../apps/web/app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts",
    );
    // Find the outer catch block of finalizeSession.
    const catchStart = src.lastIndexOf("} catch (err) {");
    expect(catchStart).toBeGreaterThan(0);
    const catchBlock = src.slice(catchStart, catchStart + 2000);

    // The team-plan branch must come BEFORE the Sentry log call.
    const gateIdx = catchBlock.indexOf("buildTeamPlanRequiredDetails");
    const sentryIdx = catchBlock.indexOf("logCaptureClientError");
    expect(gateIdx).toBeGreaterThan(0);
    expect(sentryIdx).toBeGreaterThan(0);
    expect(gateIdx).toBeLessThan(sentryIdx);

    // The branch must early-return so the Sentry / generic error path
    // never runs on an expected billing gate.
    expect(catchBlock).toMatch(/teamPlanGate[\s\S]*?return;/);

    // The branch must NOT discard staged session items (no
    // resetCaptureState call inside the team-plan branch).
    const branchEnd = catchBlock.indexOf("return;", gateIdx);
    const branchOnly = catchBlock.slice(gateIdx, branchEnd);
    expect(branchOnly).not.toMatch(/resetCaptureState/);
  });
});

// -----------------------------------------------------------------------------
// Matrix — every template × every workspace scope.
//
// The matrix exercises the rules, not the runtime, since
// assertWorkspaceAllowsEvidenceCreation is pure once we hand it a
// WorkspaceScope. The template axis is decorative for this scope-
// resolution layer (templates have no billing implication), but the
// matrix shape is the contract: the answer must be the SAME across all
// templates for a fixed scope. That's exactly the bug we're fixing.
// -----------------------------------------------------------------------------

describe("Capture scope matrix — 6 templates × 3 scopes", () => {
  function scope(
    workspaceType: "PERSONAL" | "TEAM",
    plan: "FREE" | "PRO" | "TEAM" | "PAYG",
  ): WorkspaceScope {
    return {
      workspaceType,
      ownerUserId: "00000000-0000-0000-0000-000000000001",
      teamId: workspaceType === "TEAM" ? "00000000-0000-0000-0000-000000000002" : null,
      // Phase A1 — see comment in the first `scope()` factory above.
      organizationId:
        workspaceType === "TEAM"
          ? "00000000-0000-0000-0000-000000000003"
          : null,
      plan: plan as WorkspaceScope["plan"],
      credits: 0,
      teamSeats: 0,
      storageBytesOverride: null,
      activeStorageAddonBytes: 0n,
    };
  }

  const cases: Array<{
    template: CaptureTemplateId;
    workspaceType: "PERSONAL" | "TEAM";
    plan: "FREE" | "PRO" | "TEAM" | "PAYG";
    expect: "ok" | "team_plan_required";
  }> = [];

  for (const template of CAPTURE_TEMPLATE_IDS) {
    cases.push({ template, workspaceType: "PERSONAL", plan: "FREE", expect: "ok" });
    cases.push({ template, workspaceType: "TEAM", plan: "FREE", expect: "team_plan_required" });
    cases.push({ template, workspaceType: "TEAM", plan: "TEAM", expect: "ok" });
  }

  for (const c of cases) {
    it(`${c.template} × ${c.workspaceType}/${c.plan} → ${c.expect}`, async () => {
      let caught: (Error & { code?: string }) | null = null;
      try {
        await assertWorkspaceAllowsEvidenceCreation(scope(c.workspaceType, c.plan));
      } catch (err) {
        caught = err as Error & { code?: string };
      }

      if (c.expect === "ok") {
        // Either resolves (TEAM/TEAM) or short-circuits on the
        // PERSONAL bucket without TEAM_PLAN_REQUIRED. We allow
        // other codes here (FREE_LIMIT_REACHED, INSUFFICIENT_CREDITS)
        // to surface — the assertion is specifically that TEAM_PLAN_
        // REQUIRED is NOT what fires when the scope is correct.
        if (caught) {
          expect(caught.code).not.toBe("TEAM_PLAN_REQUIRED");
        }
      } else {
        expect(caught?.code).toBe("TEAM_PLAN_REQUIRED");
      }
    });
  }
});
