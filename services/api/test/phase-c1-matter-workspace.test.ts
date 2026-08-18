/**
 * Phase C1 — Matter Workspace surfacing (source-contract suite).
 *
 * Source-contract style (same as A0 / A1 / A2 / A3 / B0 / C0). Asserts:
 *
 *   1. The canonical `/cases/[id]` page mounts the new
 *      `MatterWorkspace` component (not the legacy CaseWorkspace).
 *   2. A `/cases/[id]/classic` fallback route mounts the legacy
 *      scroll-spy CaseWorkspace, so mutations remain reachable.
 *   3. `MatterWorkspace.tsx` declares the eleven canonical tabs from
 *      the C1 spec (Overview · Evidence · Timeline · Graph · Holds ·
 *      Decisions · Risk · Communications · Assignments · Audit ·
 *      Export) and renders each via a focused tab component.
 *   4. Every tab has an explicit empty-state branch (no blank panels).
 *   5. The component is read-only — it never calls a mutation API.
 *   6. Vocabulary discipline: no overclaiming phrases.
 *   7. Phase A2 artifact vocabulary preserved — "Report PDF" vs
 *      "Verification Package ZIP" labels are present.
 *   8. The component consumes the Phase 32.8D matter envelope route
 *      (`/v1/cases/:id/matter-workspace`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const MATTER_UI = readSource(
  "../../../apps/web/components/cases-experience/MatterWorkspace.tsx",
);
const CANONICAL_PAGE = readSource(
  "../../../apps/web/app/(app)/cases/[id]/page.tsx",
);
// Phase Final-Closure-Remediation — the classic redirect page was
// deleted. Its behaviour now lives as a permanent redirect rule in
// `apps/web/next.config.js` (`/cases/:id/classic → /cases/:id`).
const NEXT_CONFIG = readSource("../../../apps/web/next.config.js");
const ROUTES = readSource("../src/routes/case-workspace.routes.ts");

describe("Phase C1 — canonical /cases/[id] mounts MatterWorkspace", () => {
  it("the canonical page imports and renders MatterWorkspace (not CaseWorkspace)", () => {
    expect(CANONICAL_PAGE).toContain("MatterWorkspace");
    expect(CANONICAL_PAGE).toMatch(/<MatterWorkspace[\s\S]*?caseId=/);
    // The canonical page must NOT import the legacy scroll-spy
    // surface directly — that lives on the classic fallback route.
    expect(CANONICAL_PAGE).not.toMatch(
      /import\s*\{\s*CaseWorkspace\s*\}\s*from/,
    );
  });

  it("the canonical page is wrapped in PageRouteGate with routeId workspace.cases", () => {
    expect(CANONICAL_PAGE).toContain("PageRouteGate");
    expect(CANONICAL_PAGE).toContain('routeId="workspace.cases"');
  });

  it("delegates row-open through onOpenEvidence (no inline mutation)", () => {
    // Phase G4.2 — the legacy classic scroll-spy surface is retired.
    // The canonical page no longer plumbs `onOpenClassic`; it only
    // exposes `onOpenEvidence` for cross-surface navigation to the
    // Evidence detail page. The classic URL itself redirects to the
    // canonical surface (see `/cases/[id]/classic/page.tsx`).
    expect(CANONICAL_PAGE).toContain("onOpenEvidence");
    expect(CANONICAL_PAGE).toMatch(
      /router\.push\(`\/evidence\/\$\{encodeURIComponent\(evidenceId\)\}`\)/,
    );
  });
});

describe("Phase C1 — /cases/[id]/classic redirects to canonical surface (Phase G4.2)", () => {
  it("classic fallback URL redirects to the canonical /cases/[id] via next.config.js", () => {
    // Phase G4.2 retired the classic scroll-spy view. Phase
    // Final-Closure-Remediation deleted the redirect-only page file
    // (`apps/web/app/(app)/cases/[id]/classic/page.tsx`) and moved the
    // redirect into `next.config.js` `redirects()` as a permanent 308
    // — behaviourally equivalent, but routing becomes the single
    // source of truth instead of a 14-line JSX shim.
    expect(NEXT_CONFIG).toMatch(
      /source:\s*["']\/cases\/:id\/classic["'][\s\S]{0,200}destination:\s*["']\/cases\/:id["']/,
    );
  });
});

describe("Phase C1 — MatterWorkspace declares the eleven canonical tabs", () => {
  it("TabId union covers exactly the eleven spec tabs", () => {
    expect(MATTER_UI).toMatch(/type TabId =[\s\S]*?"overview"/);
    expect(MATTER_UI).toMatch(/\|\s*"evidence"/);
    expect(MATTER_UI).toMatch(/\|\s*"timeline"/);
    expect(MATTER_UI).toMatch(/\|\s*"graph"/);
    expect(MATTER_UI).toMatch(/\|\s*"holds"/);
    expect(MATTER_UI).toMatch(/\|\s*"decisions"/);
    expect(MATTER_UI).toMatch(/\|\s*"risk"/);
    expect(MATTER_UI).toMatch(/\|\s*"communications"/);
    expect(MATTER_UI).toMatch(/\|\s*"assignments"/);
    expect(MATTER_UI).toMatch(/\|\s*"audit"/);
    expect(MATTER_UI).toMatch(/\|\s*"export"/);
  });

  it("TABS catalog declares all eleven tabs as displayable entries", () => {
    expect(MATTER_UI).toMatch(/const TABS:[\s\S]*?\[/);
    const ids = [
      "overview",
      "evidence",
      "timeline",
      "graph",
      "holds",
      "decisions",
      "risk",
      "communications",
      "assignments",
      "audit",
      "export",
    ];
    for (const id of ids) {
      expect(MATTER_UI).toMatch(
        new RegExp(`id:\\s*"${id}"[\\s\\S]*?label:`, ""),
      );
    }
  });

  it("each tab is rendered by a dedicated tab function component", () => {
    const components = [
      "OverviewTab",
      "EvidenceTab",
      "TimelineTab",
      "GraphTab",
      "HoldsTab",
      "DecisionsTab",
      "RiskTab",
      "CommunicationsTab",
      "AssignmentsTab",
      "AuditTab",
      "ExportTab",
    ];
    for (const name of components) {
      expect(MATTER_UI).toMatch(
        new RegExp(`function\\s+${name}\\s*\\(`, ""),
      );
      // And the function is referenced from the body switch.
      expect(MATTER_UI).toContain(`<${name}`);
    }
  });
});

describe("Phase C1 — empty-state discipline (no blank panels)", () => {
  it("each tab function has at least one EmptyState fallback", () => {
    const tabFns = [
      "OverviewTab",
      "EvidenceTab",
      "TimelineTab",
      "GraphTab",
      "HoldsTab",
      "DecisionsTab",
      "RiskTab",
      "CommunicationsTab",
      "AssignmentsTab",
      "AuditTab",
      "ExportTab",
    ];
    for (const name of tabFns) {
      const bodyMatch = MATTER_UI.match(
        new RegExp(
          `function\\s+${name}\\s*\\([\\s\\S]*?\\}\\s*\\n\\}\\s*\\n`,
          "",
        ),
      );
      expect(bodyMatch, `${name} should be parseable`).toBeTruthy();
      expect(bodyMatch![0], `${name} should declare <EmptyState`).toContain(
        "<EmptyState",
      );
    }
  });

  it("EmptyState renders a title + body (operationally meaningful)", () => {
    expect(MATTER_UI).toMatch(
      /function EmptyState\(\s*\{\s*title,\s*body\s*\}/,
    );
    expect(MATTER_UI).toContain('role="status"');
  });

  // The per-tab degraded signal kept its behaviour but moved from a bespoke
  // BEM class onto a stable data attribute carried by the canonical tab, so
  // the badge is now addressable by tests and automation without depending on
  // a styling class name.
  it("degraded sections render a per-tab badge in the navigation", () => {
    expect(MATTER_UI).toContain("data-matter-tab-degraded");
    // The badge must still be tied to the degraded STATUS, not rendered always.
    expect(MATTER_UI).toMatch(/status === "degraded"/);
    // …and it must still explain itself to the operator.
    expect(MATTER_UI).toMatch(/title="This section is degraded"/);
    expect(MATTER_UI).toMatch(/sectionStatus\[tab\.id\]/);
  });
});

describe("Phase C1 — read-only enforcement", () => {
  it("does not invoke POST / PATCH / DELETE via apiFetch", () => {
    expect(MATTER_UI).not.toMatch(/apiFetch\([^)]*method:\s*"POST"/);
    expect(MATTER_UI).not.toMatch(/apiFetch\([^)]*method:\s*"PATCH"/);
    expect(MATTER_UI).not.toMatch(/apiFetch\([^)]*method:\s*"DELETE"/);
  });

  it("delegates per-domain mutations through per-surface affordances (post-G4.2 classic retirement)", () => {
    // Phase G4.2 retired the legacy classic scroll-spy. MatterWorkspace
    // is now read-mostly: it delegates evidence drill-down through
    // `onOpenEvidence` (Evidence detail page owns mutations) and
    // governance / reviewer mutations live on their per-domain
    // surfaces. The `onOpenClassic` prop has been removed.
    expect(MATTER_UI).toContain("onOpenEvidence");
    expect(MATTER_UI).not.toMatch(/onOpenClassic[?:]/);
  });
});

describe("Phase C1 — vocabulary discipline", () => {
  it("no overclaiming or sensational phrases", () => {
    const banned = [
      /\btampered?\b/i,
      /\btamper-?proof\b/i,
      /\bauthentic\b/i,
      /\badmissible\b/i,
      /\bcourt-?ready\b/i,
      /\bforensic\s+proof\b/i,
      /\bguaranteed\b/i,
      /\bfactually\s+true\b/i,
    ];
    for (const re of banned) {
      expect(MATTER_UI).not.toMatch(re);
    }
  });

  it("preserves Phase A2 artifact vocabulary (Report PDF vs Verification Package ZIP)", () => {
    expect(MATTER_UI).toContain("Report PDF");
    expect(MATTER_UI).toContain("Verification Package ZIP");
  });

  it("explicitly disclaims that the risk projection asserts factual truth", () => {
    expect(MATTER_UI).toMatch(
      /never\s+asserts\s+factual\s+truth/i,
    );
  });
});

describe("Phase C1 — envelope wiring", () => {
  it("consumes the Phase 32.8D matter-workspace aggregator", () => {
    expect(MATTER_UI).toMatch(
      /\/v1\/cases\/\$\{encodeURIComponent\(caseId\)\}\/matter-workspace/,
    );
  });

  it("backend route /v1/cases/:id/matter-workspace remains registered", () => {
    expect(ROUTES).toContain('"/v1/cases/:id/matter-workspace"');
    expect(ROUTES).toContain("buildMatterWorkspace");
  });

  it("MatterEnvelope shape covers the eleven envelope facets", () => {
    const facets = [
      "commandSummary",
      "evidence",
      "relationships",
      "workflows",
      "reviewerCoordination",
      "governance",
      "custodyAndIntegrity",
      "timeline",
      "notes",
      "deliverables",
    ];
    for (const facet of facets) {
      expect(MATTER_UI).toContain(facet);
    }
    // risk + assignments + statusHistory live at the envelope root.
    expect(MATTER_UI).toMatch(/\brisk\b/);
    expect(MATTER_UI).toMatch(/\bassignments\b/);
    expect(MATTER_UI).toMatch(/\bstatusHistory\b/);
  });
});
