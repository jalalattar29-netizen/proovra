/**
 * Phase 32.6.6 — Personal BASIC verification package regression
 * tests (source-contract).
 *
 * Product semantics fix: personal-workspace evidence (no teamId)
 * must support a BASIC verification package, NOT 410 with
 * `personal_workspace_no_team_governance_context`. Team evidence
 * continues to use the GOVERNED package flow — no governance
 * weakening.
 *
 * Confirmed wrong production behavior (closed by this phase):
 *   GET /v1/evidence/<personal-id>/verification-package → 410
 *   { code: "verification_package_unavailable",
 *     reason: "personal_workspace_no_team_governance_context",
 *     message: "Verification package is not available for personal-
 *               workspace evidence." }
 *
 * Correct behavior (this phase):
 *   * Personal evidence → 202 pending → 200 download (BASIC mode)
 *   * Team evidence → 200 download (GOVERNED mode), or 403/409/503
 *     when team governance gate denies (unchanged)
 *   * Personal evidence does NOT query workspaceGovernancePolicy
 *   * Access check (`getEvidenceWithReadAccess`) still gates 401/404
 *
 * Test surface:
 *   1. Worker `createVerificationPackage`: no longer throws
 *      PackageGateDeniedError for missing teamId; only for missing
 *      evidenceId. Personal-mode branch skips the eligibility gate.
 *   2. Worker processor: no longer pre-skips personal evidence;
 *      `personalWorkspacePackageSkipped` block is gone.
 *   3. Route `/v1/evidence/:id/verification-package`: the 410
 *      personal-workspace branch is gone; personal evidence falls
 *      through to the existing 202/200 path.
 *   4. Artifact-status helper: `unavailable` is now always false
 *      (personal-workspace path is no longer "unavailable").
 *   5. Package archive emits a `package-mode.json` notice
 *      declaring `personal_basic` vs `team_governed`.
 *   6. Governance fail-closed contract preserved: team evidence
 *      still runs `assertPackageEligibleOrDeny`.
 *   7. No forbidden vocabulary added to operator-facing text.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
function readWorker(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../worker/${rel}`, import.meta.url)),
    "utf8",
  );
}

const FORBIDDEN_VOCAB = [
  "fake",
  "forged",
  "manipulated",
  "tampered",
  "authentic",
  "admissible",
  "proves",
  "confirms",
] as const;

function assertNoForbiddenVocabInRange(label: string, source: string, start: number, end: number) {
  const slice = source.slice(start, end).toLowerCase();
  for (const word of FORBIDDEN_VOCAB) {
    const re = new RegExp(`\\b${word}\\b`);
    if (re.test(slice)) {
      throw new Error(
        `Phase 32.6.6 vocabulary violation in ${label}: forbidden token "${word}" appears in operator-facing source.`,
      );
    }
  }
}

// =============================================================================
// Part 1 — Worker createVerificationPackage personal-basic branch
// =============================================================================

describe("Phase 32.6.6 — createVerificationPackage personal-basic branch", () => {
  const SRC = readWorker("src/verification-package.ts");
  const fnIdx = SRC.indexOf("export async function createVerificationPackage");
  expect(fnIdx).toBeGreaterThan(-1);
  // The mode-selection block lives early in the function body; bound
  // the search range with extra slack so future input-type additions
  // (Phase 3 added isPersonalTeam, workspaceLabelAtPackageTime,
  // canonicalMaterials, etc.) cannot push the declaration past the
  // window. 12KB is comfortable; the actual offset is ~7KB today.
  const fn = SRC.slice(fnIdx, fnIdx + 12000);

  it("declares packageMode as `personal_basic | team_governed`", () => {
    expect(fn).toMatch(
      /packageMode\s*:\s*"personal_basic"\s*\|\s*"team_governed"\s*=\s*data\.teamId\s*&&\s*data\.isPersonalTeam\s*===\s*false\s*\?\s*"team_governed"\s*:\s*"personal_basic"/,
    );
    expect(fn).not.toMatch(
      /packageMode\s*:\s*"personal_basic"\s*\|\s*"team_governed"\s*=\s*data\.teamId\s*\?\s*"team_governed"\s*:\s*"personal_basic"/,
    );
  });

  it("does not treat teamId alone as a governance signal", () => {
    expect(fn).toMatch(/data\.isPersonalTeam\s*===\s*false/);
    expect(fn).toMatch(/:\s*"personal_basic"/);
    expect(SRC).toMatch(/workspaceScope/);
    expect(SRC).toMatch(/PERSONAL_ACCOUNT_WORKSPACE/);
  });

  it("personal mode skips the eligibility gate (gate runs only for team mode)", () => {
    // The gate import must live inside an `if (packageMode === "team_governed")` block.
    expect(fn).toMatch(
      /if\s*\(\s*packageMode\s*===\s*"team_governed"\s*\)\s*\{[\s\S]{0,400}assertPackageEligibleOrDeny/,
    );
  });

  it("throws only when evidenceId is missing (NOT when only teamId is missing)", () => {
    // The early-throw branch must check ONLY `!data.evidenceId`, not
    // `!data.teamId || !data.evidenceId`.
    expect(fn).toMatch(/if\s*\(\s*!data\.evidenceId\s*\)\s*\{[\s\S]{0,400}PackageGateDeniedError/);
    expect(fn).not.toMatch(/if\s*\(\s*!data\.teamId\s*\|\|\s*!data\.evidenceId\s*\)/);
  });

  it("preserves PackageGateDeniedError class (governance fail-closed contract intact)", () => {
    expect(SRC).toMatch(/export class PackageGateDeniedError/);
    expect(SRC).toMatch(/throw new PackageGateDeniedError/);
  });

  it("emits a `package-mode.json` notice declaring the mode", () => {
    expect(SRC).toMatch(/"package-mode\.json"/);
    expect(SRC).toMatch(/mode:\s*packageMode/);
    expect(SRC).toMatch(/No team governance context;\s*personal package/);
    expect(SRC).toMatch(/Team-governed package/);
  });

  it("personal-mode notice text uses neutral language (no overclaims in the literal strings)", () => {
    // Restrict the check to the two literal user-facing notice
    // strings emitted INSIDE the package-mode.json. The surrounding
    // source has legitimate disclaimers that include words like
    // "admissibility" / "confirm" / "authentic" — those are
    // disclaiming text the user's vocab rule does not target.
    const personalNotice = "No team governance context; personal package";
    const teamNotice =
      "Team-governed package; workspace governance policy applied at build time";
    expect(SRC).toContain(personalNotice);
    expect(SRC).toContain(teamNotice);
    for (const text of [personalNotice, teamNotice]) {
      const lower = text.toLowerCase();
      for (const word of FORBIDDEN_VOCAB) {
        const re = new RegExp(`\\b${word}\\b`);
        if (re.test(lower)) {
          throw new Error(
            `Phase 32.6.6 vocabulary violation: forbidden token "${word}" appears in user-facing notice string: ${text}`,
          );
        }
      }
    }
  });
});

// =============================================================================
// Part 2 — Worker processor no longer pre-skips personal evidence
// =============================================================================

describe("Phase 32.6.6 — worker processor no longer pre-skips personal evidence", () => {
  const SRC = readWorker("src/processor.ts");

  it("the `personalWorkspacePackageSkipped` block is removed", () => {
    expect(SRC).not.toMatch(/personalWorkspacePackageSkipped/);
  });

  it("the `verification_package.skipped_personal_workspace` log line is removed", () => {
    expect(SRC).not.toMatch(/verification_package\.skipped_personal_workspace/);
  });

  it("the package generation guard no longer requires evidence.teamId", () => {
    // The previous guard included `!!evidence.teamId`. Confirm that
    // condition has been removed from the prepare-finalized branch.
    const finalizedIdx = SRC.indexOf("prepared.verificationPackageIncluded &&");
    expect(finalizedIdx).toBeGreaterThan(-1);
    // Look at the ~400 chars following the verificationPackageIncluded
    // gate; the next condition should be `finalized.finalizedCustodyEvents.length > 0`
    // followed by `)` — NOT another `&&` followed by `!!evidence.teamId`.
    const tail = SRC.slice(finalizedIdx, finalizedIdx + 500);
    expect(tail).not.toMatch(/!!evidence\.teamId/);
  });

  it("PackageGateDeniedError catch arm is preserved (no governance weakening)", () => {
    expect(SRC).toMatch(/instanceof PackageGateDeniedError/);
    expect(SRC).toMatch(/package_generation_blocked_total/);
    expect(SRC).toMatch(/verification_package\.blocked_by_governance/);
  });

  it("`assertWorkspaceAllowsVerificationPackageArtifact` plan/billing gate retained", () => {
    expect(SRC).toMatch(/assertWorkspaceAllowsVerificationPackageArtifact/);
  });
});

// =============================================================================
// Part 3 — Route 410 personal-workspace branch removed
// =============================================================================

describe("Phase 32.6.6 — route /v1/evidence/:id/verification-package 410 retired", () => {
  const SRC = readApi("src/routes/evidence.routes.ts");

  it("no longer returns a live 410 with `verification_package_unavailable`", () => {
    // The explanatory comment mentioning the historical reason code
    // is permitted; what must NOT exist is a live `reply.code(410)`
    // emitting the unavailable code. The route now falls through to
    // 202 pending / 200 download for personal evidence.
    expect(SRC).not.toMatch(
      /reply\.code\(410\)[\s\S]{0,400}verification_package_unavailable/,
    );
    // And there must be no live `reason: "personal_workspace_..."` in
    // any response payload (a comment reference is OK; the live key/
    // value pair is not). The pattern matches a JSON-style line.
    expect(SRC).not.toMatch(
      /^\s*reason:\s*"personal_workspace_no_team_governance_context"/m,
    );
  });

  it("still returns 202 pending for finalized evidence without a package row", () => {
    expect(SRC).toMatch(/code:\s*"verification_package_pending"/);
    expect(SRC).toMatch(/reply\.code\(202\)/);
  });

  it("still returns 409 blocked for governance-denied package metadata", () => {
    expect(SRC).toMatch(/code:\s*"verification_package_blocked"/);
    expect(SRC).toMatch(/reply\.code\(409\)/);
  });

  it("still returns 404 for genuinely-missing package", () => {
    expect(SRC).toMatch(/code:\s*"verification_package_not_found"/);
  });

  it("team-governance gate path retained for team evidence (no weakening)", () => {
    // The `enforceSensitiveAction("download_package", ...)` call must
    // still exist for team evidence. Confirm presence by exact action
    // name and that it's gated by `evidenceForGate?.teamId`.
    expect(SRC).toMatch(/enforceSensitiveAction\("download_package"/);
    expect(SRC).toMatch(/if \(evidenceForGate\?\.teamId\)/);
  });
});

// =============================================================================
// Part 4 — Artifact-status helper personal-workspace path retired
// =============================================================================

describe("Phase 32.6.6 — artifact-status helper personal-workspace unavailable retired", () => {
  const SRC = readApi("src/services/evidence-artifact-status.service.ts");

  it("packageUnavailableForPersonalWorkspace is now constant `false`", () => {
    expect(SRC).toMatch(
      /packageUnavailableForPersonalWorkspace\s*=\s*false/,
    );
  });

  it("does NOT derive unavailable from `finalized && !params.evidenceTeamId`", () => {
    expect(SRC).not.toMatch(
      /packageUnavailableForPersonalWorkspace\s*=\s*finalized\s*&&\s*!params\.evidenceTeamId/,
    );
  });

  it("unavailableReason is always `null` (no enum value emitted)", () => {
    // Find the verificationPackage shape literal in the response and
    // confirm `unavailableReason: null` (no conditional).
    expect(SRC).toMatch(/unavailableReason:\s*null/);
    expect(SRC).not.toMatch(
      /unavailableReason:\s*packageUnavailableForPersonalWorkspace\s*\?\s*"personal_workspace_no_team_governance_context"/,
    );
  });

  it("blocked / blockedOutcome / blockedReason fields preserved", () => {
    expect(SRC).toMatch(/blocked:\s*packageBlocked/);
    expect(SRC).toMatch(/blockedOutcome:/);
    expect(SRC).toMatch(/blockedReason:/);
    expect(SRC).toMatch(/blockedAtUtc:/);
  });

  it("packagePending derivation still excludes blocked + unavailable", () => {
    expect(SRC).toMatch(
      /packagePending\s*=\s*\n?\s*finalized\s*&&\s*\n?\s*!latestPackage\s*&&\s*\n?\s*!packageUnavailableForPersonalWorkspace\s*&&\s*\n?\s*!packageBlocked/,
    );
  });
});

// =============================================================================
// Part 5 — Personal/team mode declared via the bounded packageMode catalog
// =============================================================================

describe("Phase 32.6.6 — package mode catalog is bounded", () => {
  const SRC = readWorker("src/verification-package.ts");

  it("only two modes exist: personal_basic and team_governed", () => {
    // Confirm the literal type union and that no other modes are
    // introduced. Allowlist of mode values:
    expect(SRC).toMatch(/"personal_basic"\s*\|\s*"team_governed"/);
    // No `enterprise_xxx` or other speculative modes.
    expect(SRC).not.toMatch(/"enterprise_\w+"/);
  });

  it("personal mode skips the package eligibility gate; team mode runs it", () => {
    const teamGatedIdx = SRC.indexOf(
      'if (packageMode === "team_governed")',
    );
    expect(teamGatedIdx).toBeGreaterThan(-1);
    const next2k = SRC.slice(teamGatedIdx, teamGatedIdx + 2000);
    expect(next2k).toMatch(/assertPackageEligibleOrDeny/);
  });
});
