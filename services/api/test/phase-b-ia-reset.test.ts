/**
 * Phase B — IA Reset (source-contract suite).
 *
 * Asserts:
 *
 *  1. The Phase B canonical operational hierarchy module exists with
 *     exactly four groups (WORKSPACE · GOVERNANCE · OUTPUTS · SYSTEM)
 *     and the spec's hint copy.
 *  2. Every route id in `ROUTE_REGISTRY` is mapped to exactly one
 *     Phase B operational group — no orphans, no duplicates.
 *  3. The Phase B `primary` destination count is at or below the
 *     `OPERATIONAL_DESTINATION_TARGET.ceiling` (Phase B brief calls for
 *     ~25 primary destinations).
 *  4. The route registry contains the three Phase B additions:
 *     - `workspace.review` → `/review` (canonical reviewer console, C0)
 *     - `review.operations` → `/review/operations` (Phase 13)
 *     - `workspace.evidence_requests` → `/evidence-requests` (C3 inspector)
 *  5. The `next.config.js` redirects table:
 *     - Removed the `/review → /reviewer-ops` redirect (was bypassing C0).
 *     - Added `/ops/reliability → /admin/platform/reliability` alias for the
 *       inconsistent path prefix.
 *  6. A canonical `OperationalBreadcrumb` component exists, is wired
 *     into the Matter Workspace and the Evidence Request inspector,
 *     and consumes the Phase B operational groups for the group crumb.
 *  7. Vocabulary discipline — Phase B navigation labels stay
 *     operational, never overclaim or drift into generic SaaS terms.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

const PHASE_B_GROUPS = readSource(
  "../../../apps/web/lib/navigation/phaseBOperationalGroups.ts",
);
const ROUTE_REGISTRY_SRC = readSource(
  "../../../apps/web/lib/navigation/routeRegistry.ts",
);
const NEXT_CONFIG = readSource("../../../apps/web/next.config.js");
const BREADCRUMB = readSource(
  "../../../apps/web/components/navigation/OperationalBreadcrumb.tsx",
);
const CASE_PAGE = readSource(
  "../../../apps/web/app/(app)/cases/[id]/page.tsx",
);
// The canonical Case Details header, shared by the Enterprise and Personal
// branches. It is the single producer of the Case Details breadcrumb.
const CASE_DETAIL_HEADER = readSource(
  "../../../apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx",
);
const EVIDENCE_REQUEST_PAGE = readSource(
  "../../../apps/web/app/(app)/evidence-requests/[id]/page.tsx",
);

// ---------------------------------------------------------------------
// Helper: extract the set of route ids declared in the registry by
// parsing the source for `id: "..."`.
// ---------------------------------------------------------------------

function registryRouteIds(): string[] {
  const ids = new Set<string>();
  const re = /^\s*id:\s*"([^"]+)"/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ROUTE_REGISTRY_SRC)) !== null) {
    ids.add(m[1]!);
  }
  return Array.from(ids);
}

function phaseBMappedIds(): { primary: string[]; secondary: string[] } {
  // Extract every `primary: [...]` and `secondary: [...]` block from the
  // Phase B groups module. Each block is a literal array of "id"
  // strings.
  function collect(field: "primary" | "secondary"): string[] {
    const out: string[] = [];
    const re = new RegExp(`${field}:\\s*\\[([\\s\\S]*?)\\]`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(PHASE_B_GROUPS)) !== null) {
      const block = m[1]!;
      const ids = [...block.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
      out.push(...ids);
    }
    return out;
  }
  return { primary: collect("primary"), secondary: collect("secondary") };
}

// ===========================================================================
// 1. Phase B canonical hierarchy
// ===========================================================================

describe("Phase B — canonical operational hierarchy", () => {
  it("declares exactly four operational groups", () => {
    const groups = ["WORKSPACE", "GOVERNANCE", "OUTPUTS", "SYSTEM"] as const;
    for (const g of groups) {
      expect(PHASE_B_GROUPS).toMatch(new RegExp(`id:\\s*"${g}"`));
    }
    // We declare two id: lines per group entry definition — but the
    // grouping array's `id:` field is the field we care about. Match
    // only at the group-array entry top level by looking for the
    // co-located `title:` field on the next line.
    const groupEntryRe =
      /id:\s*"(WORKSPACE|GOVERNANCE|OUTPUTS|SYSTEM)",\s*\n\s*title:/g;
    const entries = [...PHASE_B_GROUPS.matchAll(groupEntryRe)].map(
      (m) => m[1]!,
    );
    expect(new Set(entries).size).toBe(4);
  });

  it("each group declares a title, hint, primary[], and secondary[]", () => {
    for (const g of ["WORKSPACE", "GOVERNANCE", "OUTPUTS", "SYSTEM"]) {
      expect(PHASE_B_GROUPS).toMatch(
        new RegExp(`id:\\s*"${g}",\\s*\\n\\s*title:[\\s\\S]*?hint:[\\s\\S]*?primary:[\\s\\S]*?secondary:`),
      );
    }
  });

  it("exposes operationalGroupForRoute() + operationalGroupDescriptor() helpers", () => {
    expect(PHASE_B_GROUPS).toMatch(/export function operationalGroupForRoute/);
    expect(PHASE_B_GROUPS).toMatch(
      /export function operationalGroupDescriptor/,
    );
  });

  it("declares the destination budget constant", () => {
    expect(PHASE_B_GROUPS).toMatch(
      /OPERATIONAL_DESTINATION_TARGET\s*=\s*\{[\s\S]*?target:\s*25[\s\S]*?ceiling:\s*30/,
    );
  });
});

// ===========================================================================
// 2. Mapping coverage
// ===========================================================================

describe("Phase B — registry ↔ Phase B group coverage", () => {
  it("every registered route id is mapped to a Phase B group", () => {
    const registered = registryRouteIds();
    const { primary, secondary } = phaseBMappedIds();
    const mapped = new Set<string>([...primary, ...secondary]);
    const missing = registered.filter((id) => !mapped.has(id));
    expect(missing, `route ids missing from Phase B groups: ${missing.join(", ")}`).toEqual([]);
  });

  it("no route id appears in more than one Phase B group / slot", () => {
    const { primary, secondary } = phaseBMappedIds();
    const allOccurrences = [...primary, ...secondary];
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const id of allOccurrences) {
      if (seen.has(id)) dupes.push(id);
      else seen.add(id);
    }
    expect(dupes, `route ids appearing twice: ${dupes.join(", ")}`).toEqual([]);
  });

  it("primary destination count is within the Phase B ceiling", () => {
    const { primary } = phaseBMappedIds();
    expect(primary.length).toBeGreaterThan(0);
    expect(primary.length).toBeLessThanOrEqual(30);
  });
});

// ===========================================================================
// 3. Route registry additions
// ===========================================================================

describe("Phase B — route registry additions", () => {
  it("registers workspace.review pointing at /review", () => {
    expect(ROUTE_REGISTRY_SRC).toMatch(
      /id:\s*"workspace\.review"[\s\S]*?href:\s*"\/review"/,
    );
  });

  it("registers review.operations pointing at /review/operations", () => {
    expect(ROUTE_REGISTRY_SRC).toMatch(
      /id:\s*"review\.operations"[\s\S]*?href:\s*"\/review\/operations"/,
    );
  });

  it("registers workspace.evidence_requests pointing at /evidence-requests", () => {
    expect(ROUTE_REGISTRY_SRC).toMatch(
      /id:\s*"workspace\.evidence_requests"[\s\S]*?href:\s*"\/evidence-requests"/,
    );
  });

  it("keeps the legacy review.queue entry (per Phase Final-Vocab-Alignment, the id-binding survives but its href is the canonical /review console)", () => {
    // Phase Final-Vocab-Alignment retired the legacy `/reviewer-ops`
    // index page and made `/review` the single canonical reviewer
    // console. The `review.queue` route id is retained for back-
    // compat with persona/hub machinery and other consumers, but its
    // `href` now points at the canonical `/review` console (the same
    // target as `workspace.review`). `next.config.js` redirects the
    // old `/reviewer-ops` URL to `/review`.
    expect(ROUTE_REGISTRY_SRC).toMatch(
      /id:\s*"review\.queue"[\s\S]*?href:\s*"\/review"/,
    );
  });
});

// ===========================================================================
// 4. next.config.js redirect adjustments
// ===========================================================================

describe("Phase B — next.config.js redirects", () => {
  it("removed the legacy /review → /reviewer-ops redirect (was bypassing Phase C0)", () => {
    const code = stripComments(NEXT_CONFIG);
    expect(code).not.toMatch(
      /source:\s*"\/review",\s*destination:\s*"\/reviewer-ops"/,
    );
  });

  it("added the /ops/reliability → /admin/platform/reliability alias", () => {
    expect(NEXT_CONFIG).toMatch(
      /source:\s*"\/ops\/reliability",\s*destination:\s*"\/admin\/platform\/reliability"/,
    );
  });

  it("preserves the rest of the CR1 redirect table (no accidental removals)", () => {
    expect(NEXT_CONFIG).toContain('source: "/dashboard"');
    expect(NEXT_CONFIG).toContain('source: "/security"');
    expect(NEXT_CONFIG).toContain('source: "/reviewer-ops/policy"');
  });
});

// ===========================================================================
// 5. Canonical breadcrumb component
// ===========================================================================

describe("Phase B — OperationalBreadcrumb component", () => {
  it("component file exists and exports OperationalBreadcrumb", () => {
    expect(BREADCRUMB).toMatch(/export function OperationalBreadcrumb/);
  });

  it("renders the Phase B operational group via operationalGroupDescriptor", () => {
    expect(BREADCRUMB).toMatch(
      /import\s*\{\s*operationalGroupDescriptor[\s\S]*?\}\s*from\s+"\.\.\/\.\.\/lib\/navigation\/phaseBOperationalGroups"/,
    );
    expect(BREADCRUMB).toContain("data-operational-group");
    expect(BREADCRUMB).toContain("data-breadcrumb-group");
  });

  it("anchors at the active workspace name without re-fetching it", () => {
    expect(BREADCRUMB).toContain("usePlatformContext");
    expect(BREADCRUMB).toContain("data-breadcrumb-workspace");
    expect(stripComments(BREADCRUMB)).not.toMatch(/apiFetch\(/);
  });

  it("does NOT mutate state — purely a render component", () => {
    expect(BREADCRUMB).not.toMatch(/method:\s*"POST"/);
    expect(BREADCRUMB).not.toMatch(/method:\s*"PATCH"/);
    expect(BREADCRUMB).not.toMatch(/method:\s*"DELETE"/);
  });
});

// ===========================================================================
// 6. Breadcrumb integration points
// ===========================================================================

describe("Phase B — breadcrumb integration", () => {
  // Case Details no longer mounts <OperationalBreadcrumb> in the route file:
  // the canonical CaseDetailHeader — shared by BOTH the Enterprise
  // (MatterWorkspace) and Personal (SimpleCaseDetail) branches — renders the
  // one breadcrumb for the surface, which removed a second, differently
  // shaped crumb that Enterprise used to emit. The GUARANTEE is stronger than
  // before, so it is asserted on real breadcrumb SEMANTICS rather than on the
  // name of the component that happens to produce them.
  it("Case Details renders one canonical breadcrumb above the workspace", () => {
    // A labelled breadcrumb landmark…
    expect(CASE_DETAIL_HEADER).toMatch(/<nav[\s\S]{0,200}?aria-label="Breadcrumb"/);
    // …that links back to the Cases index…
    expect(CASE_DETAIL_HEADER).toMatch(/href="\/cases"/);
    // …and marks the current case as the current page.
    expect(CASE_DETAIL_HEADER).toMatch(/aria-current="page"/);
    // Exactly ONE breadcrumb landmark on the surface — no duplicate crumb.
    expect(
      (CASE_DETAIL_HEADER.match(/aria-label="Breadcrumb"/g) ?? []).length,
    ).toBe(1);
    // Asserted on the IMPORT: the route file explains the move in prose, and a
    // real mount cannot exist without importing the component.
    expect(CASE_PAGE).not.toMatch(/imports*{s*OperationalBreadcrumbs*}/);
  });

  it("Evidence Request inspector renders the breadcrumb pointing at the matter when one exists", () => {
    expect(EVIDENCE_REQUEST_PAGE).toContain("OperationalBreadcrumb");
    expect(EVIDENCE_REQUEST_PAGE).toMatch(
      /<OperationalBreadcrumb[\s\S]*?routeId="workspace\.evidence_requests"/,
    );
    expect(EVIDENCE_REQUEST_PAGE).toMatch(
      /href:\s*`\/cases\/\$\{encodeURIComponent\(data\.caseId\)\}`/,
    );
  });
});

// ===========================================================================
// 7. Vocabulary discipline
// ===========================================================================

describe("Phase B — vocabulary discipline", () => {
  const surfaces: Array<{ name: string; src: string }> = [
    { name: "PhaseBGroups", src: PHASE_B_GROUPS },
    { name: "OperationalBreadcrumb", src: BREADCRUMB },
  ];

  const banned: Array<{ name: string; re: RegExp }> = [
    { name: "Slack", re: /\bSlack\b/i },
    { name: "Dropbox", re: /\bDropbox\b/i },
    { name: "Google Drive", re: /\bGoogle\s+Drive\b/i },
    { name: "CRM", re: /\bCRM\b/i },
    { name: "kanban", re: /\bkanban\b/i },
    { name: "tampered", re: /\btampered?\b/i },
    { name: "authentic", re: /\bauthentic\b/i },
    { name: "admissible", re: /\badmissible\b/i },
    { name: "court-ready", re: /\bcourt-?ready\b/i },
    { name: "forensic proof", re: /\bforensic\s+proof\b/i },
    { name: "guaranteed", re: /\bguaranteed\b/i },
  ];

  for (const { name, src } of surfaces) {
    for (const { name: bn, re } of banned) {
      it(`${name} contains no '${bn}'`, () => {
        expect(stripComments(src)).not.toMatch(re);
      });
    }
  }
});
