/**
 * Phase IA-self-serve-simplification — pricing-aligned simplification.
 *
 * Pins three contracts:
 *
 *   1. Tier rules — workspaces / notifications / persona move to
 *      ENTERPRISE with per-rule redirect targets; exchange /
 *      integrations / workflows / communications / collaboration /
 *      evidence-lifecycle / packaging move to ENTERPRISE with the
 *      bounded redirect-target / notFound policy.
 *
 *   2. FREE Reports locked notice — FreeReportsLockedNotice renders
 *      above ReportsIndex when plan === "FREE". Plan-safe copy + 4
 *      bounded unlocks + 2 CTAs (Upgrade Pro / PAYG).
 *
 *   3. SelfServeHomeDashboard — does NOT contain enterprise
 *      terminology, builds quick actions per plan, gates Team
 *      activity / Invite teammate on PRO/TEAM, gates Upgrade CTA on
 *      FREE/PAYG.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  canAccessSurface,
  getDirectAccessDecision,
  type SurfaceUserContext,
} from "../../../apps/web/lib/surface/access.js";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

// ============================================================================
// Test personas
// ============================================================================

const FREE: SurfaceUserContext = {
  plan: "FREE",
  role: "OWNER",
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
};
const PAYG: SurfaceUserContext = {
  plan: "PAYG",
  role: "OWNER",
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
};
const PRO: SurfaceUserContext = {
  plan: "PRO",
  role: "OWNER",
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
};
const TEAM_OWNER: SurfaceUserContext = {
  plan: "TEAM",
  role: "OWNER",
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
};
const ENT_ADMIN: SurfaceUserContext = {
  plan: "TEAM",
  role: "ADMIN",
  isPlatformAdmin: false,
  isEnterpriseWorkspace: true,
};

// ============================================================================
// Phase 2 — settings-like surfaces moved out of standalone visibility
// ============================================================================

describe("Phase IA-self-serve-simplification — workspaces/notifications/persona hidden + redirected", () => {
  const SETTINGS_LIKE = [
    { path: "/workspaces", redirectTo: "/teams" },
    { path: "/notifications", redirectTo: "/settings" },
    { path: "/persona", redirectTo: "/settings" },
  ];

  for (const { path, redirectTo } of SETTINGS_LIKE) {
    for (const persona of [
      { name: "FREE", ctx: FREE },
      { name: "PAYG", ctx: PAYG },
      { name: "PRO", ctx: PRO },
      { name: "TEAM owner", ctx: TEAM_OWNER },
    ]) {
      it(`${persona.name} cannot see ${path} (hidden from sidebar/AllTools/cmd-K)`, () => {
        expect(canAccessSurface(persona.ctx, path)).toBe(false);
      });

      it(`${persona.name} direct URL ${path} redirects to ${redirectTo}`, () => {
        const d = getDirectAccessDecision(persona.ctx, path);
        expect(d.kind).toBe("redirect");
        if (d.kind === "redirect") {
          expect(d.to).toBe(redirectTo);
        }
      });
    }

    it(`Enterprise admin retains access to ${path}`, () => {
      expect(canAccessSurface(ENT_ADMIN, path)).toBe(true);
    });
  }
});

// ============================================================================
// Phase 3 — advanced surfaces hidden from PRO/TEAM with bounded redirects
// ============================================================================

describe("Phase IA-self-serve-simplification — advanced surfaces hidden from PRO/TEAM", () => {
  const ADVANCED = [
    { path: "/collaboration", policy: "redirect", redirectTo: "/inbox" },
    { path: "/evidence-lifecycle", policy: "redirect", redirectTo: "/evidence" },
    { path: "/exchange", policy: "redirect", redirectTo: "/reports" },
    { path: "/integrations", policy: "notFound" },
    { path: "/workflows", policy: "notFound" },
    { path: "/communications", policy: "notFound" },
    { path: "/packaging", policy: "notFound" },
  ];

  for (const { path, policy, redirectTo } of ADVANCED) {
    for (const persona of [
      { name: "FREE", ctx: FREE },
      { name: "PAYG", ctx: PAYG },
      { name: "PRO", ctx: PRO },
      { name: "TEAM owner", ctx: TEAM_OWNER },
    ]) {
      it(`${persona.name} cannot see ${path}`, () => {
        expect(canAccessSurface(persona.ctx, path)).toBe(false);
      });

      it(`${persona.name} direct URL ${path} → ${policy}${redirectTo ? ` (${redirectTo})` : ""}`, () => {
        const d = getDirectAccessDecision(persona.ctx, path);
        expect(d.kind).toBe(policy);
        if (d.kind === "redirect" && redirectTo) {
          expect(d.to).toBe(redirectTo);
        }
      });
    }

    it(`Enterprise admin retains access to ${path}`, () => {
      expect(canAccessSurface(ENT_ADMIN, path)).toBe(true);
    });
  }
});

// ============================================================================
// Phase 4 — FREE Reports locked notice + reports page wiring
// ============================================================================

describe("Phase IA-self-serve-simplification — FREE Reports locked notice", () => {
  const NOTICE = readWeb(
    "components/reports-experience/FreeReportsLockedNotice.tsx",
  );
  const PAGE = readWeb("app/(app)/reports/page.tsx");

  it("notice has the FreeReportsLockedNotice export", () => {
    expect(NOTICE).toMatch(/export function FreeReportsLockedNotice\(/);
  });

  it("notice copy matches the pricing brief", () => {
    expect(NOTICE).toMatch(
      /Reports are included with Pay-Per-Evidence, Pro, and Team/,
    );
  });

  it("notice lists the four unlocked outputs", () => {
    expect(NOTICE).toMatch(/PDF verification report/);
    expect(NOTICE).toMatch(/Verification package/);
    expect(NOTICE).toMatch(/Shareable verification link/);
    expect(NOTICE).toMatch(/Report history/);
  });

  it("notice has Upgrade-to-Pro CTA + Pay-Per-Evidence CTA", () => {
    expect(NOTICE).toMatch(/Upgrade to Pro/);
    expect(NOTICE).toMatch(/Complete with Pay-Per-Evidence/);
  });

  it("notice does NOT use any banned legal-overclaim copy", () => {
    for (const banned of [
      /legally admissible/i,
      /factually true/i,
      /guarantees authenticity/i,
    ]) {
      expect(NOTICE).not.toMatch(banned);
    }
  });

  it("reports/page.tsx imports FreeReportsLockedNotice + useSurfaceUserContext", () => {
    expect(PAGE).toMatch(
      /import\s*\{\s*FreeReportsLockedNotice\s*\}/,
    );
    expect(PAGE).toMatch(
      /import\s*\{\s*useSurfaceUserContext\s*\}/,
    );
  });

  it("reports/page.tsx detects FREE plan + renders notice ABOVE ReportsIndex", () => {
    expect(PAGE).toMatch(
      /const isFreePlan\s*=\s*surfaceUserCtx\.plan\s*===\s*"FREE"/,
    );
    expect(PAGE).toMatch(
      /\{isFreePlan \?\s*<FreeReportsLockedNotice \/>\s*:\s*null\}[\s\S]{0,200}<ReportsIndex/,
    );
  });
});

// ============================================================================
// Phase 5/6 — SelfServeHomeDashboard contract + terminology guard
// ============================================================================

describe("Phase IA-self-serve-simplification — SelfServeHomeDashboard", () => {
  // Phase IA-self-serve-home-rebuild — the scaffolding shape pinned
  // here has been replaced by the production self-serve Home. These
  // tests are rewritten to pin the NEW shape; the full per-section
  // + per-plan contract lives in
  // `phase-ia-self-serve-home-rebuild.test.ts`.
  const HOME = readWeb("components/home-experience/SelfServeHomeDashboard.tsx");
  const SECTIONS = readWeb("components/home-experience/HomeSections.tsx");

  it("exports SelfServeHomeDashboard", () => {
    expect(HOME).toMatch(/export function SelfServeHomeDashboard\(/);
  });

  it("consumes useHomeData (the data layer the new dashboard uses)", () => {
    expect(HOME).toMatch(/useHomeData/);
  });

  it("mounts the 11 production section components in 6 rows", () => {
    for (const name of [
      "WorkspaceSnapshot",
      "NextActionCard",
      "StorageUsageCard",
      "RecentEvidence",
      "RecentCases",
      "RecentReports",
      "PipelineSnapshot",
      "TeamActivityCard",
      "GettingStartedChecklist",
      "IntegrityAlerts",
      "TrustSummary",
    ]) {
      expect(HOME).toMatch(new RegExp(`<${name}\\b`));
    }
  });

  it("Recent Reports honours the FREE-plan locked-notice copy", () => {
    expect(SECTIONS).toMatch(
      /isFreePlan\s*\?[\s\S]{0,400}Pay-Per-Evidence, Pro, and Team/,
    );
  });

  it("Team Activity card is null-out when the view model returns null (PRO/TEAM gate lives in the normalizer)", () => {
    expect(SECTIONS).toMatch(
      /TeamActivityCard[\s\S]{0,500}if\s*\(!team\)\s*return\s*null/,
    );
  });

  it("Getting Started checklist is plan-aware via the view model `visible` field", () => {
    expect(SECTIONS).toMatch(
      /GettingStartedChecklist[\s\S]{0,500}steps\.filter\(\(s\)\s*=>\s*s\.visible\)/,
    );
  });

  it("Trust summary names the four bounded materials", () => {
    expect(SECTIONS).toMatch(/Digital signatures/);
    expect(SECTIONS).toMatch(/trusted timestamp/i);
    expect(SECTIONS).toMatch(/Object Lock/);
    expect(SECTIONS).toMatch(/public verification link/i);
  });

  it("Trust summary does NOT claim legal admissibility / factual truth / certified authenticity", () => {
    // Disclaimers (e.g. "Legal admissibility is decided by reviewers
    // and courts") are EXPECTED. What we ban is the affirmative
    // overclaim.
    expect(SECTIONS).toMatch(/Legal\s+admissibility is decided/);
    expect(SECTIONS).not.toMatch(/PROOVRA certifies legal/);
    expect(SECTIONS).not.toMatch(/guarantees admissibility/);
    expect(SECTIONS).not.toMatch(/proves authenticity/i);
  });
});

describe("Phase IA-self-serve-simplification — SelfServeHomeDashboard terminology guard", () => {
  const HOME_RAW = readWeb(
    "components/home-experience/SelfServeHomeDashboard.tsx",
  );
  // Strip block + line comments before scanning so the documentation
  // block at the top of the file (which legitimately enumerates the
  // banned phrases to document the contract) doesn't trip the guard.
  // We only care about RENDERED copy.
  const HOME = HOME_RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(
    /\/\/[^\n]*/g,
    "",
  );

  // The phrases below MUST NOT appear in self-serve home rendered copy.
  // They are enterprise/reviewer/governance language that confuses the
  // simplified GTM target.
  const BANNED_PHRASES: Array<{ phrase: RegExp; label: string }> = [
    { phrase: /Operational command surface/i, label: "Operational command surface" },
    { phrase: /Reviewer queue/i, label: "Reviewer queue" },
    { phrase: /Review escalations/i, label: "Review escalations" },
    { phrase: /Governance posture/i, label: "Governance posture" },
    { phrase: /Workload engine/i, label: "Workload engine" },
    { phrase: /SLA pressure/i, label: "SLA pressure" },
    { phrase: /Review operations/i, label: "Review operations" },
    { phrase: /Compliance posture/i, label: "Compliance posture" },
    { phrase: /Enterprise intelligence/i, label: "Enterprise intelligence" },
    { phrase: /Escalation storms/i, label: "Escalation storms" },
    { phrase: /Departmental rollout/i, label: "Departmental rollout" },
    { phrase: /Reviewer orchestration/i, label: "Reviewer orchestration" },
    { phrase: /Intelligence operations/i, label: "Intelligence operations" },
    { phrase: /Lifecycle operations/i, label: "Lifecycle operations" },
  ];

  for (const { phrase, label } of BANNED_PHRASES) {
    it(`does NOT contain enterprise term "${label}"`, () => {
      expect(HOME).not.toMatch(phrase);
    });
  }
});
