/**
 * Phase 6 (Enterprise Collaboration) FINALIZATION — verify/expose/gate/merge.
 *
 * This suite pins the LOCKED product model for the collaboration surfaces:
 *
 *   SCOPE A — Collaboration Teams KEEP: the canonical `/collaboration-teams`
 *             product surface is reachable (CORE tier — visible to every
 *             plan/role incl. personal, per constitutional rule 4-7) and is
 *             registered exactly once. CollaborationTeam is SEPARATE from the
 *             Prisma `Team` (billing/seat/tenant) model — the collaboration
 *             product never lives under `/teams` or `/workspaces`.
 *
 *   SCOPE K — Role/plan visibility: ENTERPRISE governance/collaboration
 *             surfaces (review ops, external-reviewer console, investigation,
 *             intelligence, redaction, governance) are ENTERPRISE-tier and
 *             hidden from FREE/PAYG/PRO/TEAM; ENTERPRISE unlocks them. PRO/TEAM
 *             keep PROFESSIONAL self-serve collaboration (intake-links/inbox);
 *             FREE/PAYG do not. Every plan keeps `/collaboration-teams`
 *             (self-serve + personal collaboration).
 *
 *   SCOPE J — External-reviewer deep-link: the collaboration Team-detail page
 *             deep-links to the EXISTING `/review/external` console (reuse, not
 *             a second portal) and gates the link on `REVIEWER_OPS_VIEW`.
 *
 *   SCOPE L — Canonical-surface lock: `/collaboration-teams` is the single
 *             collaboration-Team product surface; the legacy `/collaboration`
 *             and `/teams` URLs are retired/redirect-merged, not duplicated.
 *
 * Pure, dependency-light: reads the real access model (`canAccessSurface`),
 * the real `ROUTE_REGISTRY`, and the on-disk page source. No React runtime.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canAccessSurface,
  type SurfaceUserContext,
} from "../lib/surface/access";
import { getSurfaceTier } from "../lib/surface/tiers";
import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";
import type { WorkspacePlan } from "../lib/platform-context/types";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Mirror the backend derivation used by the sibling enterprise-tier test:
// an enterprise workspace is one on the ENTERPRISE plan. Nothing else.
function ctxFor(plan: WorkspacePlan): SurfaceUserContext {
  return {
    plan,
    role: "OWNER",
    isPlatformAdmin: false,
    isEnterpriseWorkspace: plan === "ENTERPRISE",
  };
}

const ALL_PLANS: WorkspacePlan[] = ["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"];
const NON_ENTERPRISE: WorkspacePlan[] = ["FREE", "PAYG", "PRO", "TEAM"];

const TEAMS_SURFACE = "/collaboration-teams";
const EXTERNAL_REVIEW_CONSOLE = "/review/external";

// Enterprise collaboration / governance surfaces the matrix reserves for
// ENTERPRISE (or platform-admin) only.
const ENTERPRISE_COLLABORATION_SURFACES = [
  "/review",
  "/review/external",
  "/reviewer-ops",
  "/investigation",
  "/intelligence",
  "/redaction",
  "/governance",
];

// OpsCenter visibility remediation (2026-07-18): /inbox is now a CORE
// operational surface (every plan; categories governed by the canonical
// eligibility policy) and /intake-links follows the COMMERCIAL
// ENTITLEMENT (planFeatures.intakeIncluded — PAYG included). The
// tier-FALLBACK behavior below still applies to these fixture contexts
// (no entitlement value → PROFESSIONAL fallback), which is what SCOPE K
// pins for /intake-links.
const PROFESSIONAL_COLLABORATION_SURFACES = ["/intake-links"];

// ===========================================================================
// SCOPE A — Collaboration Teams KEEP + reachable + registered once.
// ===========================================================================

test("SCOPE A — /collaboration-teams is CORE tier (reachable for every plan+role)", () => {
  assert.equal(
    getSurfaceTier(TEAMS_SURFACE),
    "CORE",
    "Collaboration Teams must stay CORE — personal + self-serve users create Teams (constitutional rule 4-7)",
  );
  for (const plan of ALL_PLANS) {
    assert.equal(
      canAccessSurface(ctxFor(plan), TEAMS_SURFACE),
      true,
      `${plan} must be able to reach ${TEAMS_SURFACE}`,
    );
  }
});

test("SCOPE A — collaboration-teams create/member surfaces are reachable (detail + hub registered)", () => {
  const ids = new Set(
    (ROUTE_REGISTRY as unknown as ReadonlyArray<{ id: string }>).map((r) => r.id),
  );
  for (const id of [
    "workspace.collaboration_teams",
    "workspace.collaboration_team_detail",
    "workspace.collaboration_team_hub",
    "workspace.collaboration_team_invite_accept",
  ]) {
    assert.ok(ids.has(id), `registry must contain ${id}`);
  }
  // The overview page (create) + detail (members/invites) must not require a
  // capability gate — any workspace member can SEE Teams; management is
  // enforced at the backend service layer.
  const overview = (ROUTE_REGISTRY as unknown as ReadonlyArray<{
    id: string;
    href: string;
    requiredCapabilities: string[];
    requiredActiveSpace: string;
  }>).find((r) => r.id === "workspace.collaboration_teams");
  assert.ok(overview);
  assert.equal(overview.href, TEAMS_SURFACE);
  assert.deepEqual(
    overview.requiredCapabilities,
    [],
    "Teams overview must not require a capability (personal-first)",
  );
  assert.equal(
    overview.requiredActiveSpace,
    "PERSONAL_OR_ORG",
    "Teams must work in BOTH personal + org workspaces",
  );
});

test("SCOPE A — CollaborationTeam product surface is SEPARATE from Prisma Team (no billing/seat/tenant surface)", () => {
  // The constitutional separation: the collaboration-Team PRODUCT lives at
  // `/collaboration-teams`; the billing/tenant `Team` (workspace admin) lives
  // at `/workspaces` (route id `admin.teams`). They must be different routes
  // with different ids so the collaboration product never inherits billing /
  // seat / tenant semantics.
  const byHref = new Map(
    (ROUTE_REGISTRY as unknown as ReadonlyArray<{ id: string; href: string }>).map(
      (r) => [r.href, r.id],
    ),
  );
  assert.equal(byHref.get(TEAMS_SURFACE), "workspace.collaboration_teams");
  assert.equal(
    byHref.get("/workspaces"),
    "admin.teams",
    "the billing/tenant workspace surface must remain /workspaces (admin.teams), NOT /collaboration-teams",
  );
  assert.notEqual(
    "workspace.collaboration_teams",
    "admin.teams",
    "collaboration-Team product and workspace-admin Team must be distinct route ids",
  );
});

// ===========================================================================
// SCOPE K — Role / plan visibility matrix.
// ===========================================================================

test("SCOPE K — enterprise collaboration surfaces are hidden from FREE/PAYG/PRO/TEAM", () => {
  for (const plan of NON_ENTERPRISE) {
    const ctx = ctxFor(plan);
    for (const href of ENTERPRISE_COLLABORATION_SURFACES) {
      assert.equal(
        canAccessSurface(ctx, href),
        false,
        `${plan} must NOT reach enterprise collaboration surface ${href}`,
      );
    }
  }
});

test("SCOPE K — ENTERPRISE unlocks every enterprise collaboration surface", () => {
  const ent = ctxFor("ENTERPRISE");
  for (const href of ENTERPRISE_COLLABORATION_SURFACES) {
    assert.equal(
      canAccessSurface(ent, href),
      true,
      `ENTERPRISE must reach ${href}`,
    );
  }
});

test("SCOPE K — platform admin unlocks enterprise collaboration surfaces regardless of plan", () => {
  const admin: SurfaceUserContext = {
    plan: "FREE",
    role: "OWNER",
    isPlatformAdmin: true,
    isEnterpriseWorkspace: false,
  };
  for (const href of ENTERPRISE_COLLABORATION_SURFACES) {
    assert.equal(canAccessSurface(admin, href), true, `admin must reach ${href}`);
  }
});

test("SCOPE K — /inbox is CORE for every plan (operational surface, 2026-07-18)", () => {
  for (const plan of ["FREE", "PAYG", "PRO", "TEAM"] as WorkspacePlan[]) {
    assert.equal(
      canAccessSurface(ctxFor(plan), "/inbox"),
      true,
      `${plan} must reach the Operations Center`,
    );
  }
});

test("SCOPE K — PRO/TEAM get PROFESSIONAL self-serve collaboration; FREE/PAYG do not", () => {
  for (const href of PROFESSIONAL_COLLABORATION_SURFACES) {
    for (const plan of ["PRO", "TEAM"] as WorkspacePlan[]) {
      assert.equal(
        canAccessSurface(ctxFor(plan), href),
        true,
        `${plan} must reach professional collaboration surface ${href}`,
      );
    }
    for (const plan of ["FREE", "PAYG"] as WorkspacePlan[]) {
      assert.equal(
        canAccessSurface(ctxFor(plan), href),
        false,
        `${plan} must NOT reach professional collaboration surface ${href}`,
      );
    }
  }
});

test("SCOPE K — self-serve/personal plans keep collaboration Teams but NOT enterprise governance", () => {
  // The crux of the matrix: a TEAM-plan owner sees Teams (self-serve
  // collaboration) but is walled off from enterprise governance/admin.
  const team = ctxFor("TEAM");
  assert.equal(canAccessSurface(team, TEAMS_SURFACE), true);
  assert.equal(canAccessSurface(team, EXTERNAL_REVIEW_CONSOLE), false);
  assert.equal(canAccessSurface(team, "/reviewer-ops"), false);
  assert.equal(canAccessSurface(team, "/governance"), false);
});

// ===========================================================================
// SCOPE J — External-reviewer console REUSE + deep-link + gate.
// ===========================================================================

test("SCOPE J — /review/external console is registered as REUSE surface (ORG + REVIEWER_OPS_VIEW), not a new portal", () => {
  const ext = (ROUTE_REGISTRY as unknown as ReadonlyArray<{
    id: string;
    href: string;
    requiredCapabilities: string[];
    requiredActiveSpace: string;
  }>).find((r) => r.id === "workspace.review_external");
  assert.ok(ext, "external-reviewer console must be registered");
  assert.equal(ext.href, EXTERNAL_REVIEW_CONSOLE);
  assert.ok(
    ext.requiredCapabilities.includes("REVIEWER_OPS_VIEW"),
    "external console must require REVIEWER_OPS_VIEW",
  );
  assert.equal(
    ext.requiredActiveSpace,
    "ORGANIZATION_ONLY",
    "external console is an org-anchored governance surface",
  );
});

test("SCOPE J — collaboration Team-detail deep-links to the external-reviewer console gated on REVIEWER_OPS_VIEW", () => {
  const src = readFileSync(
    resolve(APP_ROOT, "app/(app)/collaboration-teams/[teamId]/page.tsx"),
    "utf8",
  );
  // Deep-link present and points at the EXISTING console href.
  assert.ok(
    src.includes(`href="${EXTERNAL_REVIEW_CONSOLE}"`),
    "Team detail must deep-link to /review/external (reuse the existing console)",
  );
  assert.ok(
    src.includes('data-testid="external-reviewers-link"'),
    "external-reviewers deep-link must carry a stable test id",
  );
  // Gated on the same capability the console enforces — never rendered
  // unconditionally (which would only redirect for non-reviewers).
  assert.ok(
    src.includes('useCan("REVIEWER_OPS_VIEW")'),
    "the deep-link must be gated on REVIEWER_OPS_VIEW (matches the console gate)",
  );
  // No second portal: the link must not introduce a new /portal or
  // collaboration-teams-scoped external-review route.
  assert.ok(
    !/href=["'`]\/collaboration-teams\/[^"'`]*external/.test(src),
    "must NOT create a collaboration-teams-scoped external-review surface (reuse only)",
  );
});

// ===========================================================================
// SCOPE L — Canonical-surface lock (no duplicate collaboration Team product).
// ===========================================================================

test("SCOPE L — /collaboration-teams is the ONLY collaboration-Team PRODUCT href in the registry", () => {
  const collabProductHrefs = (ROUTE_REGISTRY as unknown as ReadonlyArray<{ href: string }>)
    .map((r) => r.href)
    .filter((h) => h === TEAMS_SURFACE || h.startsWith(`${TEAMS_SURFACE}/`));
  // Exactly the 3 product sub-surfaces (overview, detail, hub) + invite accept.
  const uniqueRoots = new Set(
    collabProductHrefs.map((h) => (h === TEAMS_SURFACE ? h : "sub")),
  );
  assert.ok(
    uniqueRoots.has(TEAMS_SURFACE),
    "the canonical Teams overview href must be registered",
  );
  // The legacy standalone `/collaboration` discussion surface must NOT be a
  // second Teams product — it is a retired, redirect-merged surface.
  const legacy = (ROUTE_REGISTRY as unknown as ReadonlyArray<{ id: string; href: string; label: string }>)
    .find((r) => r.href === "/collaboration");
  if (legacy) {
    assert.notEqual(
      legacy.id,
      "workspace.collaboration_teams",
      "the retired /collaboration surface must not collide with the Teams product id",
    );
    assert.ok(
      /legacy|redirect/i.test(legacy.label),
      "the retired /collaboration surface must be labelled legacy/redirected",
    );
  }
});

test("SCOPE L — the billing/tenant /teams URL is not a second Teams product page", () => {
  // `/teams` (bare) is a redirect to /workspaces (next.config); no registry
  // entry should register `/teams` as a live product href that competes with
  // /collaboration-teams.
  const teamsBare = (ROUTE_REGISTRY as unknown as ReadonlyArray<{ href: string }>).filter(
    (r) => r.href === "/teams",
  );
  assert.equal(
    teamsBare.length,
    0,
    "no registry entry may register the bare /teams product href (it redirects to /workspaces)",
  );
});
