/**
 * PROOVRA Phase 10 — Route ownership source-contract test.
 *
 * Pins the constitutional URL separation between:
 *   - `/workspaces`  → workspace admin (registry id: `admin.teams`,
 *                      a historical id whose canonical href is the
 *                      Workspaces list).
 *   - `/collaboration-teams` → the canonical Collaboration Team product
 *                      (registry id: `workspace.collaboration_teams`).
 *   - `/teams`       → legacy alias. ONLY allowed as a 308 redirect
 *                      target in next.config.js; MUST NOT appear as
 *                      any registry entry's canonical href.
 *
 * Constitutional rules (Phase 10):
 *   - Team is NOT a Workspace.
 *   - /collaboration-teams is the canonical Team product.
 *   - /teams is legacy → 308 → /workspaces.
 *   - The Sidebar consumes registry hrefs; it MUST NOT hard-code the
 *     legacy `/teams` literal.
 *
 * Test style: source-contract (file-text assertions). No DB I/O.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEB_ROOT = resolve(REPO_ROOT, "apps/web");

const ROUTE_REGISTRY_PATH = resolve(WEB_ROOT, "lib/navigation/routeRegistry.ts");
const NEXT_CONFIG_PATH = resolve(WEB_ROOT, "next.config.js");
const SIDEBAR_PATH = resolve(
  WEB_ROOT,
  "components/app-shell-v2/AppSidebarV2.tsx",
);

// ---------------------------------------------------------------------------
// Route registry
// ---------------------------------------------------------------------------

describe("Phase 10 — route registry route-ownership", () => {
  const registry = readFileSync(ROUTE_REGISTRY_PATH, "utf8");

  it("admin.teams entry exists and points to /workspaces (the workspace list)", () => {
    expect(registry).toMatch(
      /id:\s*"admin\.teams"[\s\S]{0,400}href:\s*"\/workspaces"/,
    );
  });

  it("workspace.collaboration_teams entry exists and points to /collaboration-teams (the Team product)", () => {
    expect(registry).toMatch(
      /id:\s*"workspace\.collaboration_teams"[\s\S]{0,400}href:\s*"\/collaboration-teams"/,
    );
  });

  it("no registry entry uses the legacy href '/teams' (only a redirect target, not a canonical href)", () => {
    // Bounded literal match: `href: "/teams"` exactly (the registry
    // formats hrefs with a single space). A multi-line variant would
    // still parse if it appears.
    const offenders: string[] = [];
    const re = /href:\s*"\/teams"(?!\/)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(registry)) !== null) {
      offenders.push(m[0]);
    }
    expect(
      offenders,
      `legacy /teams href found in registry: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// next.config.js redirect
// ---------------------------------------------------------------------------

describe("Phase 10 — next.config.js still 308-redirects /teams → /workspaces", () => {
  const cfg = readFileSync(NEXT_CONFIG_PATH, "utf8");

  it("the /teams → /workspaces redirect is present", () => {
    expect(cfg).toMatch(
      /source:\s*"\/teams"[\s\S]{0,200}destination:\s*"\/workspaces"/,
    );
  });
});

// ---------------------------------------------------------------------------
// Sidebar does not hard-code the legacy /teams href
// ---------------------------------------------------------------------------

describe("Phase 10 — AppSidebarV2 does not hard-code href=\"/teams\"", () => {
  const sidebar = readFileSync(SIDEBAR_PATH, "utf8");

  it("the sidebar source does not contain the literal href=\"/teams\"", () => {
    // The sidebar must derive hrefs from the registry; a literal
    // `href="/teams"` would bypass the canonical /workspaces redirect
    // and confuse the IA.
    expect(sidebar).not.toMatch(/href="\/teams"/);
  });
});
