/**
 * Phase EMERGENCY-RECOVERY — workspace-bootstrap + recovery surface
 * source-contract tests.
 *
 * Goal: verify the structural guarantees that prevent every regression
 * the user reported ("No workspace selected", broken header, blank
 * shell, "Switch to a workspace" copy on every operator surface). All
 * tests are file-driven so they run in any environment without a live
 * database — they assert that the right wiring is in place, not the
 * runtime behavior of Prisma itself (covered by integration tests).
 *
 * Parts:
 *   1  Schema — Team.isPersonal field declared + migration present
 *   2  Bootstrap service — exports + concurrency + idempotency wiring
 *   3  Platform-context builder — bootstrap wired in BEFORE workspace
 *      resolution; stale-currentWorkspaceId falls back to personal
 *   4  Recovery actions — bounded enum + structured CTAs
 *   5  Frontend wiring — useWorkspaceId + WorkspaceRecoveryPanel + shell
 *      integration + Reports/Search migration
 *   6  Capability separation — personal does NOT grant team-only ops
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  resolveCapabilities,
} from "../src/services/platform-context/capability-registry.js";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

/**
 * Strip JS/TS comments so source-contract negative-matches don't
 * trip on documentation that mentions a forbidden token.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const SCHEMA = readApi("prisma/schema.prisma");
const MIGRATION = readApi(
  "prisma/migrations/20260720100000_personal_workspace_bootstrap/migration.sql",
);
const BOOTSTRAP = readApi(
  "src/services/platform-context/workspace-bootstrap.service.ts",
);
const SVC = readApi(
  "src/services/platform-context/platform-context.service.ts",
);
const TYPES = readApi("src/services/platform-context/types.ts");

const WEB_TYPES = readWeb("lib/platform-context/types.ts");
const WEB_INDEX = readWeb("lib/platform-context/index.ts");
const WEB_GATE = readWeb("lib/platform-context/useTeamWorkspaceGate.ts");
const WEB_RECOVERY = readWeb("lib/platform-context/WorkspaceRecoveryPanel.tsx");
const WEB_SHELL = readWeb("components/app-shell-v2/AppShellV2.tsx");
const WEB_REPORTS = readWeb(
  "components/reports-experience/ReportsIndex.tsx",
);
const WEB_SEARCH = readWeb("app/(app)/search/page.tsx");

// =============================================================================
// PART 1 — Schema + migration
// =============================================================================

describe("Phase EMERGENCY-RECOVERY — schema", () => {
  it("Team model declares an isPersonal boolean field", () => {
    expect(SCHEMA).toMatch(
      /isPersonal\s+Boolean\s+@default\(false\)\s+@map\("is_personal"\)/,
    );
  });

  it("migration adds the is_personal column idempotently", () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS "is_personal"/);
    expect(MIGRATION).toMatch(/BOOLEAN NOT NULL DEFAULT false/);
  });

  it("migration adds a partial unique index on (owner_user_id) WHERE is_personal", () => {
    expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/);
    expect(MIGRATION).toMatch(/"teams_owner_personal_uniq"/);
    expect(MIGRATION).toMatch(/WHERE "is_personal" = TRUE/);
  });
});

// =============================================================================
// PART 2 — Bootstrap service
// =============================================================================

describe("Phase EMERGENCY-RECOVERY — workspace-bootstrap service", () => {
  it("exports ensurePersonalWorkspace + PersonalWorkspaceBootstrapResult", () => {
    expect(BOOTSTRAP).toMatch(/export async function ensurePersonalWorkspace/);
    expect(BOOTSTRAP).toMatch(/export type PersonalWorkspaceBootstrapResult/);
  });

  it("uses a fast-path findFirst before attempting create (idempotency)", () => {
    expect(BOOTSTRAP).toMatch(
      /client\.team\.findFirst[\s\S]{0,200}ownerUserId:\s*input\.userId/,
    );
  });

  it("creates Team + OWNER TeamMember inside a transaction", () => {
    expect(BOOTSTRAP).toMatch(/client\.\$transaction\(async \(tx\)/);
    expect(BOOTSTRAP).toMatch(/tx\.team\.create/);
    expect(BOOTSTRAP).toMatch(/tx\.teamMember\.create/);
    expect(BOOTSTRAP).toMatch(/role:\s*"OWNER"/);
    expect(BOOTSTRAP).toMatch(/status:\s*"ACTIVE"/);
  });

  it("catches P2002 unique-violation and re-fetches the winner (concurrency safety)", () => {
    expect(BOOTSTRAP).toMatch(/code === "P2002"/);
    expect(BOOTSTRAP).toMatch(/client\.team\.findFirst[\s\S]{0,160}isPersonal:\s*true/);
  });

  it("name composition is bounded to NAME_MAX = 120 chars", () => {
    expect(BOOTSTRAP).toMatch(/const NAME_MAX\s*=\s*120/);
    expect(BOOTSTRAP).toMatch(/label\.length\s*>\s*NAME_MAX/);
  });

  it("never writes audit / billing / governance side-effects (only Team + TeamMember)", () => {
    const code = stripComments(BOOTSTRAP);
    expect(code).not.toMatch(/auditLog\b/);
    expect(code).not.toMatch(/auditEvent\.create/);
    expect(code).not.toMatch(/legalHold\.|retentionPolicy\.|entitlement\.create/i);
    // The only allowed Prisma writers in the bootstrap.
    expect(code).toMatch(/tx\.team\.create/);
    expect(code).toMatch(/tx\.teamMember\.create/);
  });
});

// =============================================================================
// PART 3 — Platform-context builder wiring
// =============================================================================

describe("Phase EMERGENCY-RECOVERY — platform-context builder", () => {
  it("imports ensurePersonalWorkspace from the bootstrap service", () => {
    expect(SVC).toMatch(
      /import\s*\{\s*ensurePersonalWorkspace\s*\}\s*from\s*"\.\/workspace-bootstrap\.service\.js"/,
    );
  });

  it("calls ensurePersonalWorkspace BEFORE the team.findUnique workspace lookup", () => {
    const bootstrapCall = SVC.indexOf("ensurePersonalWorkspace({");
    const teamLookup = SVC.indexOf("prisma.team.findUnique");
    expect(bootstrapCall).toBeGreaterThan(0);
    expect(teamLookup).toBeGreaterThan(0);
    expect(bootstrapCall).toBeLessThan(teamLookup);
  });

  it("records bootstrap diagnostics (attempted/created/reused/activeWorkspaceUpdated)", () => {
    expect(SVC).toMatch(/bootstrap\.attempted\s*=\s*true/);
    expect(SVC).toMatch(/bootstrap\.created\s*=/);
    expect(SVC).toMatch(/bootstrap\.reused\s*=/);
    expect(SVC).toMatch(/bootstrap\.activeWorkspaceUpdated\s*=\s*true/);
  });

  it("falls back to personal team when currentWorkspaceId is stale", () => {
    expect(SVC).toMatch(/personal_bootstrap_after_stale/);
  });

  it("distinguishes scope via team.isPersonal, not heuristics", () => {
    expect(SVC).toMatch(/team\.isPersonal\s*\?\s*"PERSONAL"\s*:\s*"TEAM"/);
  });

  it("emits recoveryActions via buildRecoveryActions helper", () => {
    expect(SVC).toMatch(/recoveryActions:\s*buildRecoveryActions/);
    expect(SVC).toMatch(/function buildRecoveryActions/);
  });
});

// =============================================================================
// PART 4 — Recovery action enum + bounded shape
// =============================================================================

describe("Phase EMERGENCY-RECOVERY — recovery actions", () => {
  it("backend types declare the bounded PlatformContextRecoveryAction enum", () => {
    expect(TYPES).toMatch(/export type PlatformContextRecoveryAction/);
    expect(TYPES).toMatch(/"create_personal_workspace"/);
    expect(TYPES).toMatch(/"create_team"/);
    expect(TYPES).toMatch(/"open_settings"/);
    expect(TYPES).toMatch(/"retry"/);
  });

  it("frontend types mirror PlatformContextRecoveryAction with same ids", () => {
    expect(WEB_TYPES).toMatch(/export type PlatformContextRecoveryAction/);
    expect(WEB_TYPES).toMatch(/"create_personal_workspace"/);
    expect(WEB_TYPES).toMatch(/"create_team"/);
    expect(WEB_TYPES).toMatch(/"open_settings"/);
    expect(WEB_TYPES).toMatch(/"retry"/);
  });

  it("envelope declares recoveryActions: ReadonlyArray<...> on both sides", () => {
    // The optional `?` may differ across backend/frontend; both shapes are accepted.
    expect(TYPES).toMatch(
      /recoveryActions\??:\s*ReadonlyArray<PlatformContextRecoveryAction>/,
    );
    expect(WEB_TYPES).toMatch(
      /recoveryActions\??:\s*ReadonlyArray<PlatformContextRecoveryAction>/,
    );
  });

  it("healthy envelope produces an empty recovery list", () => {
    expect(SVC).toMatch(/Healthy envelope[\s\S]{0,80}return \[\];?/);
  });
});

// =============================================================================
// PART 5 — Frontend wiring (hooks, recovery panel, shell, page migration)
// =============================================================================

describe("Phase EMERGENCY-RECOVERY — frontend wiring", () => {
  it("useTeamWorkspaceGate exports a new useWorkspaceId helper", () => {
    expect(WEB_GATE).toMatch(/export function useWorkspaceId\(\): string \| null/);
    expect(WEB_GATE).toMatch(/envelope\.workspace\.status !== "active"/);
  });

  it("platform-context index re-exports useWorkspaceId + WorkspaceRecoveryPanel", () => {
    expect(WEB_INDEX).toMatch(/useWorkspaceId/);
    expect(WEB_INDEX).toMatch(/WorkspaceRecoveryPanel/);
  });

  it("WorkspaceRecoveryPanel renders bounded actions from envelope.recoveryActions", () => {
    expect(WEB_RECOVERY).toMatch(/envelope\?\.recoveryActions/);
    expect(WEB_RECOVERY).toMatch(/data-workspace-recovery-panel/);
    expect(WEB_RECOVERY).toMatch(/data-workspace-recovery-action/);
    expect(WEB_RECOVERY).toMatch(/action\.id === "retry"/);
    expect(WEB_RECOVERY).toMatch(/refresh\(\)/);
  });

  it("AppShellV2 swaps content for WorkspaceRecoveryPanel when recoveryActions present", () => {
    expect(WEB_SHELL).toMatch(/WorkspaceRecoveryPanel/);
    expect(WEB_SHELL).toMatch(/recoveryActions/);
    expect(WEB_SHELL).toMatch(/needsRecovery\s*\?\s*<WorkspaceRecoveryPanel/);
  });

  it("Reports migrated from useTeamWorkspaceGate → useWorkspaceId", () => {
    expect(WEB_REPORTS).not.toMatch(/useTeamWorkspaceGate/);
    expect(WEB_REPORTS).toMatch(/useWorkspaceId/);
    // Empty-state CTA copy must no longer say "Switch to a workspace
    // to use ..." (the legacy team-gated marker). Permission-denied
    // reasons may still mention "switch to a workspace you have
    // access to" as a corrective hint — that's an authorisation
    // explanation, not a workspace-gate banner. We assert the
    // legacy CTA phrasing specifically.
    expect(WEB_REPORTS).not.toMatch(/Switch to a workspace to use/i);
  });

  it("Search migrated from useTeamId → useWorkspaceId", () => {
    expect(WEB_SEARCH).not.toMatch(/import\s*\{[^}]*useTeamId[^}]*\}/);
    expect(WEB_SEARCH).toMatch(/useWorkspaceId/);
    expect(WEB_SEARCH).not.toMatch(/Switch to a workspace to use Evidence Discovery/i);
  });
});

// =============================================================================
// PART 6 — Capability separation (personal vs team)
// =============================================================================

describe("Phase EMERGENCY-RECOVERY — capability separation", () => {
  function caps(args: {
    scope: "PERSONAL" | "TEAM";
    role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
    plan: "FREE" | "PAYG" | "PRO" | "TEAM";
    isPlatformAdmin?: boolean;
  }) {
    return resolveCapabilities({
      scope: args.scope,
      role: args.role,
      plan: args.plan,
      isPlatformAdmin: args.isPlatformAdmin ?? false,
    });
  }

  it("personal OWNER on FREE has product capabilities but NOT team-only operator caps", () => {
    const c = caps({ scope: "PERSONAL", role: "OWNER", plan: "FREE" });
    expect(c.EVIDENCE_VIEW).toBe(true);
    expect(c.EVIDENCE_CAPTURE).toBe(true);
    expect(c.REPORTS_VIEW).toBe(true);
    expect(c.SEARCH_VIEW).toBe(true);
    // Team-only operator surfaces must NOT activate in personal mode.
    expect(c.REVIEWER_OPS_VIEW).toBe(false);
    expect(c.REVIEWER_OPS_ACT).toBe(false);
    expect(c.GOVERNANCE_ACT).toBe(false);
    expect(c.LEGAL_HOLD_PLACE).toBe(false);
    expect(c.TEAM_MANAGE).toBe(false);
    expect(c.PLATFORM_ADMIN).toBe(false);
  });

  it("personal OWNER on PRO still does NOT inherit team operator caps", () => {
    const c = caps({ scope: "PERSONAL", role: "OWNER", plan: "PRO" });
    expect(c.REVIEWER_OPS_ACT).toBe(false);
    expect(c.GOVERNANCE_ACT).toBe(false);
    expect(c.LEGAL_HOLD_RELEASE).toBe(false);
  });

  it("team OWNER on TEAM plan retains the full operator capability set", () => {
    const c = caps({ scope: "TEAM", role: "OWNER", plan: "TEAM" });
    expect(c.REVIEWER_OPS_VIEW).toBe(true);
    expect(c.GOVERNANCE_VIEW).toBe(true);
    expect(c.TEAM_MANAGE).toBe(true);
  });
});
