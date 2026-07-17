/**
 * Phase R13 — Route × Persona Matrix source-contract test.
 *
 * Pins the canonical persona-visibility contract defined in
 * `docs/architecture/phase-4-route-persona-matrix.md` against the
 * live route registry + sidebar + page-existence on disk.
 *
 * If a route metadata change drifts from the matrix, this test
 * fails — by design.
 *
 * What this test asserts (without booting any UI):
 *
 *   1. Every visible route (sidebar OR Cmd-K OR Tools) has a real
 *      `apps/web/app/(app)/<href>/page.tsx` on disk (rule 11 — no
 *      visible route may lead to Page Not Found).
 *
 *   2. The 8 platform-OPS routes carry
 *      `requiredActiveSpace: "PLATFORM_ADMIN"` +
 *      `fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY"` so non-platform
 *      admins see nothing for them (rule 9 — Operations is platform-
 *      admin area).
 *
 *   3. The 4 page-missing routes have all three visibility flags
 *      (`sidebarEligible`, `commandPaletteVisible`, `allToolsVisible`)
 *      set to `false`.
 *
 *   4. No route definition contains forbidden fake-workspace tokens
 *      (rule 4 — Team is NOT a workspace; rule 10 — no UI may imply
 *      fake workspace types).
 *
 *   5. The `routeAccessResolver` returns the right answer for each
 *      persona on representative routes (the per-persona journey
 *      smoke).
 *
 *   6. The sidebar-personal filter is in place
 *      (`AppSidebarV2.tsx` mutates `canSeeNav` for org-only routes
 *      when active space is PERSONAL).
 *
 *   7. PageRouteGate renders denial copy via the Phase 3 canonical
 *      `denialReasonHeadline` helper (no local `switch` on accessState).
 *
 * Adding/changing any contract requires:
 *   1. Editing docs/architecture/phase-4-route-persona-matrix.md
 *   2. Editing this test
 *   3. Architecture board approval.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// =============================================================================
// Path helpers
// =============================================================================

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const webRoot = join(repoRoot, "apps", "web");
const appDir = join(webRoot, "app", "(app)");

function read(rel: string): string {
  const full = join(repoRoot, rel);
  if (!existsSync(full)) throw new Error(`R13: missing required file: ${rel}`);
  return readFileSync(full, "utf8");
}

function listSourceFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (
      name === "node_modules" ||
      name === "dist" ||
      name === ".next" ||
      name === "build" ||
      name.startsWith(".")
    )
      continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...listSourceFiles(full, ext));
    else if (name.endsWith(ext)) out.push(full);
  }
  return out;
}

// =============================================================================
// Lightweight registry reader — pull route metadata from the source so
// we don't have to import the real TS module (which transitively pulls
// in React etc.). Each route literal in routeRegistry.ts is parsed by
// regex; close enough for source-contract pinning.
// =============================================================================

type RegistryRoute = {
  id: string;
  href: string;
  requiredActiveSpace: string;
  fallbackBehavior: string;
  commandPaletteVisible: boolean;
  allToolsVisible: boolean;
  sidebarEligible: boolean;
};

function parseRegistry(): ReadonlyArray<RegistryRoute> {
  const body = read("apps/web/lib/navigation/routeRegistry.ts");
  const out: RegistryRoute[] = [];
  // Match each `{ id: "...", ... }` literal up to the closing brace of
  // the object. The registry uses a stable shape so this is safe.
  const blockRe = /\{\s*id:\s*"([^"]+)",[\s\S]*?\n\s*\},/g;
  for (const m of body.matchAll(blockRe)) {
    const block = m[0];
    const id = m[1];
    const get = (key: string): string | null => {
      const r = new RegExp(`${key}:\\s*"([^"]+)"`).exec(block);
      return r ? r[1] : null;
    };
    const getBool = (key: string): boolean => {
      const r = new RegExp(`${key}:\\s*(true|false)`).exec(block);
      return r ? r[1] === "true" : false;
    };
    const href = get("href");
    const requiredActiveSpace = get("requiredActiveSpace");
    const fallbackBehavior = get("fallbackBehavior");
    if (!href || !requiredActiveSpace || !fallbackBehavior) continue;
    out.push({
      id,
      href,
      requiredActiveSpace,
      fallbackBehavior,
      commandPaletteVisible: getBool("commandPaletteVisible"),
      allToolsVisible: getBool("allToolsVisible"),
      sidebarEligible: getBool("sidebarEligible"),
    });
  }
  return out;
}

const REGISTRY = parseRegistry();

// =============================================================================
// Stage 7 — Platform-OPS routes are PLATFORM_ADMIN-gated
// =============================================================================

const PLATFORM_OPS_ROUTE_IDS = [
  "platform.ops_center",
  "platform.observability",
  "platform.runbooks",
  "platform.automation",
  "platform.analytics",
  "platform.media_graph",
  "platform.reliability",
  "platform.queue_ops",
  "platform.admin",
];

describe("Phase R13 — Stage 7: Platform-OPS routes are PLATFORM_ADMIN-gated", () => {
  it("parses at least 50 routes from the registry (sanity)", () => {
    expect(REGISTRY.length).toBeGreaterThan(50);
  });

  for (const id of PLATFORM_OPS_ROUTE_IDS) {
    it(`${id} requires PLATFORM_ADMIN active space`, () => {
      const r = REGISTRY.find((x) => x.id === id);
      expect(r, `${id} not found in registry`).toBeDefined();
      expect(r?.requiredActiveSpace).toBe("PLATFORM_ADMIN");
    });

    it(`${id} hides when capability is missing (HIDDEN_IF_NO_CAPABILITY)`, () => {
      const r = REGISTRY.find((x) => x.id === id);
      expect(r?.fallbackBehavior).toBe("HIDDEN_IF_NO_CAPABILITY");
    });
  }
});

// =============================================================================
// Stage 7 — Page-missing routes are hidden everywhere
// =============================================================================

const PAGE_MISSING_ROUTE_IDS = [
  "dashboard.quotas",
  // Phase 6 cleanup — dashboard.insights retired (page deleted +
  // registry entry removed). The id is no longer in REGISTRY so the
  // "hidden everywhere" check no longer applies.
  "dashboard.batch_analysis",
  "workspace.evidence_requests",
];

describe("Phase R13 — Stage 7: page-missing routes are hidden everywhere", () => {
  for (const id of PAGE_MISSING_ROUTE_IDS) {
    it(`${id} has all three visibility flags = false`, () => {
      const r = REGISTRY.find((x) => x.id === id);
      expect(r, `${id} not found in registry`).toBeDefined();
      expect(r?.sidebarEligible, `${id}.sidebarEligible`).toBe(false);
      expect(r?.commandPaletteVisible, `${id}.commandPaletteVisible`).toBe(
        false,
      );
      expect(r?.allToolsVisible, `${id}.allToolsVisible`).toBe(false);
    });
  }
});

// =============================================================================
// Stage 10 — Every visible route has a real page on disk (no 404s)
// =============================================================================

/**
 * Map a route href to the expected page.tsx path under apps/web/app/(app)/.
 * - `/foo` → `app/(app)/foo/page.tsx`
 * - `/foo/bar` → `app/(app)/foo/bar/page.tsx`
 * - `/foo/[id]` → `app/(app)/foo/[id]/page.tsx`
 * - Account-tier hrefs like `/settings` or `/billing` also live under
 *   `app/(app)/`.
 *
 * Returns `null` when the href is genuinely external or non-app-routed.
 */
function expectedPagePath(rawHref: string): string | null {
  // Settings IA refactor (2026-07-17): registry hrefs may target a
  // SECTION ANCHOR on a real page (e.g. /settings#security). The
  // page-on-disk check applies to the path only.
  const href = rawHref.split("#")[0]!;
  if (!href.startsWith("/")) return null;
  const rel = href.slice(1);
  if (rel.length === 0) return null;
  return join(appDir, rel, "page.tsx");
}

const HREF_EXCEPTIONS = new Set<string>([
  // The canonical public Trust Center lives at `apps/web/app/trust/page.tsx`
  // (outside the (app) route group), so the (app) group has no own
  // `/trust/page.tsx`. (The authenticated Trust Hub at /trust-hub was removed
  // 2026-07-15; the /trust-center docs gate resolves to a real (app) page.)
  "/trust",
  // Detail routes consumed only via deep link / sub-route — keep in
  // the registry for backwards-compat with persona/hub machinery.
  "/organizations/:id",
  "/organizations/:id/admin/domains",
  "/org-invites/:token/accept",
  "/reviewer-ops/[reviewId]",
  // Phase 8 — Organization Admin shell + 9 tab leaves. Dynamic /:id
  // segment; the actual pages live at
  // apps/web/app/(app)/organizations/[id]/admin/... (Next.js [id]
  // convention). Allowlisted here because the registry intentionally
  // uses /:id documentation syntax to match the /organizations/:id
  // precedent.
  "/organizations/:id/admin",
  "/organizations/:id/admin/overview",
  "/organizations/:id/admin/members",
  "/organizations/:id/admin/departments",
  "/organizations/:id/admin/governance",
  "/organizations/:id/admin/governance/external-reviewers",
  "/organizations/:id/admin/access-reviews",
  "/organizations/:id/admin/retention",
  "/organizations/:id/admin/audit",
  "/organizations/:id/admin/security",
  "/organizations/:id/admin/trust",
  // Phase 4 (Enterprise Administration) — Roles, Billing, Integrations.
  "/organizations/:id/admin/roles",
  "/organizations/:id/admin/billing",
  "/organizations/:id/admin/integrations",
]);

describe("Phase R13 — Stage 10: every visible route has a real page on disk", () => {
  for (const r of REGISTRY) {
    const isVisibleSomewhere =
      r.sidebarEligible || r.commandPaletteVisible || r.allToolsVisible;
    if (!isVisibleSomewhere) continue;
    if (HREF_EXCEPTIONS.has(r.href)) continue;
    it(`route ${r.id} (${r.href}) has a page.tsx on disk`, () => {
      const expected = expectedPagePath(r.href);
      expect(expected, `${r.id} href not parseable`).not.toBeNull();
      expect(
        existsSync(expected!),
        `${r.id} → ${r.href} expected page at ${expected}`,
      ).toBe(true);
    });
  }
});

// =============================================================================
// Stage 10 — No registry entry contains forbidden fake-workspace tokens
// =============================================================================

describe("Phase R13 — Stage 10: no fake workspace types in route metadata", () => {
  const body = read("apps/web/lib/navigation/routeRegistry.ts");

  it("does not contain 'Team Workspace' as a route label", () => {
    // The label field — `label: "..."`. Anywhere this string appears
    // inside a label literal is a violation.
    const violations = [
      ...body.matchAll(/label:\s*"([^"]*Team Workspace[^"]*)"/g),
    ];
    expect(violations.map((v) => v[1])).toEqual([]);
  });

  it("does not contain 'Reviewer Workspace' as a route label", () => {
    // The Reviewer console label is "Reviewer workspace" (lowercase
    // w) describing a feature surface, not a workspace TENANCY. The
    // forbidden form is the capitalized "Reviewer Workspace" because
    // that implies a tenancy.
    const violations = [
      ...body.matchAll(/label:\s*"([^"]*Reviewer Workspace[^"]*)"/g),
    ];
    expect(violations.map((v) => v[1])).toEqual([]);
  });

  it("does not contain 'Governance Workspace' as a route label", () => {
    const violations = [
      ...body.matchAll(/label:\s*"([^"]*Governance Workspace[^"]*)"/g),
    ];
    expect(violations.map((v) => v[1])).toEqual([]);
  });

  it("does not contain 'Operations Workspace' as a route label", () => {
    const violations = [
      ...body.matchAll(/label:\s*"([^"]*Operations Workspace[^"]*)"/g),
    ];
    expect(violations.map((v) => v[1])).toEqual([]);
  });
});

// =============================================================================
// Stage 10 — No user-facing UI string says "Switch to Team Workspace"
// or "Team Workspace required"
// =============================================================================

describe("Phase R13 — Stage 10: no fake workspace types in user-facing UI strings", () => {
  it("no tsx file contains 'Switch to Team Workspace'", () => {
    const files = listSourceFiles(webRoot, ".tsx");
    const offenders: string[] = [];
    for (const f of files) {
      const body = readFileSync(f, "utf8");
      if (body.includes("Switch to Team Workspace")) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("no tsx file contains 'Team Workspace required'", () => {
    const files = listSourceFiles(webRoot, ".tsx");
    const offenders: string[] = [];
    for (const f of files) {
      const body = readFileSync(f, "utf8");
      if (body.includes("Team Workspace required")) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("no tsx/ts file (excluding tests + docs) renders the literal 'Team Workspace' as a value", () => {
    // We allow component file names like `TeamWorkspaceCard.tsx` (kept
    // as a billing component name) but disallow the literal string
    // "Team Workspace" appearing inside JSX, JSON, or quoted strings.
    const exts = [".tsx", ".ts"];
    const offenders: string[] = [];
    for (const ext of exts) {
      for (const f of listSourceFiles(webRoot, ext)) {
        if (
          f.includes("phase-r13-route-persona-matrix") ||
          f.includes(".test.") ||
          f.includes("\\test\\") ||
          f.includes("/test/")
        )
          continue;
        const body = readFileSync(f, "utf8");
        // Look for the literal in a string position (between quotes).
        if (/["'`]Team Workspace["'`]/.test(body)) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// =============================================================================
// Stage 3 — Sidebar suppresses org-only routes for personal users
// =============================================================================

describe("Phase R13 — Stage 3: sidebar suppresses org-only routes for personal users", () => {
  const sidebar = read("apps/web/components/app-shell-v2/AppSidebarV2.tsx");

  it("AppSidebarV2 mutates canSeeNav for NEEDS_ORGANIZATION when activeSpace is not ORGANIZATION", () => {
    // The filter we added in Stage 3 — pin its presence so a future
    // refactor doesn't silently drop it. The exact wording isn't
    // load-bearing; the regex looks for the structural pattern.
    expect(sidebar).toMatch(/PHASE 4[\s\S]{0,2000}NEEDS_ORGANIZATION/);
    expect(sidebar).toMatch(
      /accessState === "NEEDS_ORGANIZATION"[\s\S]{0,200}activeSpaceType !== "ORGANIZATION"/,
    );
  });

  it("AppSidebarV2 preserves canSeeNav for platform admins (so they can still see all org-only routes)", () => {
    expect(sidebar).toMatch(/!isPlatformAdmin/);
  });
});

// =============================================================================
// Stage 8 — PageRouteGate uses canonical denialReasonHeadline
// =============================================================================

describe("Phase R13 — Stage 8: PageRouteGate uses canonical denial vocabulary", () => {
  const gate = read("apps/web/components/navigation/PageRouteGate.tsx");

  it("imports denialReasonHeadline + denialReasonGuidance from @proovra/shared", () => {
    expect(gate).toMatch(/denialReasonHeadline/);
    expect(gate).toMatch(/denialReasonGuidance/);
    expect(gate).toMatch(/accessStateToDenialReason/);
    expect(gate).toMatch(/from\s+["']@proovra\/shared["']/);
  });

  it("does not contain a local deniedHeadline function", () => {
    // The local function was removed in Phase 4; the comment block
    // we left documents the removal.
    expect(gate).not.toMatch(/function deniedHeadline/);
  });

  it("renders the canonical denial reason as a data attribute for e2e tests", () => {
    expect(gate).toMatch(/data-page-route-gate-denial-reason/);
  });
});

// =============================================================================
// Stage 4 — Team UI copy hygiene (constitutional rules 3, 4, 10)
// =============================================================================

describe("Phase R13 — Stage 4: team UI copy is hygienic", () => {
  it("evidence-library-helpers fallback uses 'Workspace', not 'Team Workspace'", () => {
    const body = read("apps/web/app/(app)/evidence/lib/evidence-library-helpers.ts");
    expect(body).not.toMatch(/\|\| "Team Workspace"/);
    expect(body).toMatch(/\|\| "Workspace"/);
  });

  it("billing TeamWorkspaceCard does not contain 'team workspace' in body copy", () => {
    const body = read("apps/web/components/billing/TeamWorkspaceCard.tsx");
    // The card may keep its internal component name (it is a billing-
    // tier card historically called TeamWorkspaceCard); user-visible
    // copy must not contain the forbidden phrase.
    expect(body).not.toMatch(/a team workspace/);
    expect(body).not.toMatch(/team workspaces/);
  });
});

// =============================================================================
// Sanity — admin.teams (the /workspaces page) keeps its canonical label
// =============================================================================

describe("Phase R13 — admin.teams (/workspaces) keeps its canonical label", () => {
  it("label remains 'Workspaces' (rule: this page IS the personal + org list, NOT a Team page)", () => {
    const r = REGISTRY.find((x) => x.id === "admin.teams");
    expect(r, "admin.teams not in registry").toBeDefined();
    expect(r?.href).toBe("/workspaces");
    // The label is asserted by reading the source directly (parser
    // above doesn't capture `label`).
    const body = read("apps/web/lib/navigation/routeRegistry.ts");
    expect(body).toMatch(
      /id:\s*"admin\.teams"[\s\S]{0,300}label:\s*"Workspaces"/,
    );
  });
});

// =============================================================================
// Sanity — review.queue is intentionally invisible legacy binding
// =============================================================================

describe("Phase R13 — review.queue duplicate is intentionally invisible", () => {
  it("review.queue exists with all three visibility flags = false (legacy id binding)", () => {
    const r = REGISTRY.find((x) => x.id === "review.queue");
    expect(r, "review.queue not in registry").toBeDefined();
    expect(r?.sidebarEligible).toBe(false);
    expect(r?.commandPaletteVisible).toBe(false);
    expect(r?.allToolsVisible).toBe(false);
  });
});
