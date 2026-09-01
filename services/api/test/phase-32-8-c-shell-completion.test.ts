/**
 * Phase 32.8C FINAL-4 — Header/Topbar + Dashboard Control Surface
 * Completion.
 *
 * Source-contract tests for:
 *
 *  PART 1 — Topbar workspace cluster no longer renders "WorkspaceWorkspace"
 *  PART 2 — Workspace menu count no longer says "0 available"
 *  PART 3 — Workspace switcher renders grouped sections (Personal /
 *           Team workspaces)
 *  PART 4 — Topbar CSS structure exists (workspace pill + menu)
 *  PART 5 — Dashboard renders a persona-aware priority strip
 *  PART 6 — Bulk actions toolbar renders permission-aware chips
 *  PART 7 — No raw UUID anywhere in shell rendering paths
 *  PART 8 — No-regression invariants
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

// Product-reset: AppTopbarV2 (dead duplicate topbar) deleted; contract
// retargeted to the live AppAccountToolbar.
const TOPBAR = readWeb("components/app-shell-v2/AppAccountToolbar.tsx");
const TOPBAR_CSS = readWeb("components/app-shell-v2/app-shell-v2.css");
const CC_TSX = readWeb("components/command-center/CommandCenter.tsx");
const CC_CSS = readWeb("components/command-center/command-center.css");

// =============================================================================
// PART 1 — Topbar workspace cluster
// =============================================================================

describe("Phase 32.8C FINAL-4 — topbar workspace cluster", () => {
  // account-menu refactor 2026-07-21 — the standalone workspace cluster/chip is
  // retired. The active workspace now surfaces as a badge inside the folded
  // account menu (data-account-menu-header-workspace), with labels still from
  // `getWorkspaceLabels`.
  it("account-menu workspace badge uses bounded labels (Personal Space / Organization workspace)", () => {
    // ENTERPRISE TENANT MODEL — fallback labels come from
    // `getWorkspaceLabels` which uses the canonical activeSpace section.
    expect(TOPBAR).toMatch(/Personal Space/);
    expect(TOPBAR).toMatch(/Organization workspace/);
    // The active-workspace badge replaces the retired data-workspace-name chip.
    expect(TOPBAR).toMatch(/data-account-menu-header-workspace/);
  });

  // OBSOLETE — Phase 32.8 Foundation removed the literal "Member"
  // fallback. The scope-line now reports "Role unavailable" if role
  // can't be resolved. See phase-32-8-foundation-platform-context.test.ts.
  it("never repeats 'Workspace' as a literal twice in the label fallback chain", () => {
    // The bug was: `name: "Workspace"` AND `scopeLine: "Workspace"`.
    // Verify the label resolver no longer emits two "Workspace" literals.
    const fn = TOPBAR.match(/function getWorkspaceLabels[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    const occurrences = fn![0].match(/"Workspace"/g) ?? [];
    expect(occurrences.length).toBeLessThanOrEqual(1);
  });
});

// =============================================================================
// PART 2 — Workspace menu count text
// =============================================================================

describe("Phase 32.8C FINAL-4 — workspace menu count text", () => {
  it("does NOT render the bare '0 available' count text", () => {
    expect(TOPBAR).not.toMatch(/\{workspaceList\.length\}\s*available/);
  });

  it("workspace count strip lives on the canonical switcher PANEL, not the account menu (P3/P4 domain remediation 2026-07-21)", () => {
    // The persistent context chip's panel carries the bounded count strip
    // again ("Only Personal Space" / "N workspaces"); the account menu
    // carries no count strip at all.
    expect(TOPBAR).toMatch(/data-context-switcher-count/); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).toMatch(/"Only Personal Space"/); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).toMatch(/\$\{menu\.workspaces\.total\} workspaces`/); // (P3/P4 domain remediation 2026-07-21)
    const acctIdx = TOPBAR.indexOf("data-app-topbar-account-menu");
    expect(acctIdx).toBeGreaterThan(-1);
    expect(TOPBAR.slice(acctIdx)).not.toMatch(/data-context-switcher-count/); // (P3/P4 domain remediation 2026-07-21)
  });

  it("switcher visibility is gated on the resolved switchable total (account-menu refactor 2026-07-21)", () => {
    // The switcher renders only when there is at least one switchable space,
    // decided from the resolver's `workspaces.total`.
    expect(TOPBAR).toMatch(/menu\.workspaces\.total/);
  });
});

// =============================================================================
// PART 3 — Grouped switcher sections
// =============================================================================

describe("Phase 32.8C FINAL-4 — grouped workspace switcher", () => {
  it("renders PERSONAL / OWNED / per-ORGANIZATION groups — no ACTIONS group (P3/P4 domain remediation 2026-07-21)", () => {
    // The persistent context chip's canonical panel renders three group
    // kinds: Personal, Your workspaces (OWNED), and one ORGANIZATION group
    // per organization. The retired ACTIONS group (create/join/manage)
    // stays gone.
    expect(TOPBAR).toMatch(/data-context-group="PERSONAL"/); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).toMatch(/data-context-group="OWNED"/); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).toMatch(/data-context-group="ORGANIZATION"/); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).toMatch(/data-context-organization=\{group\.organizationId\}/); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).not.toMatch(/data-context-group="ACTIONS"/); // (P3/P4 domain remediation 2026-07-21)
    // The groups live in the ONE canonical panel owned by the chip.
    const panels = TOPBAR.match(/data-app-context-switcher/g) ?? []; // (P3/P4 domain remediation 2026-07-21)
    expect(panels.length).toBe(1); // (P3/P4 domain remediation 2026-07-21)
  });

  it("panel is headed 'Switch workspace' with 'Your workspaces' group label + per-option scope chips (P3/P4 domain remediation 2026-07-21)", () => {
    // The panel header reads "Switch workspace"; the OWNED group is
    // labelled "Your workspaces"; each option carries a scope chip keyed by
    // its canonical kind with bounded chip copy.
    expect(TOPBAR).toMatch(/>Switch workspace</); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).toMatch(/>\s*Your workspaces\s*</); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).toMatch(/data-workspace-scope-chip=\{option\.kind\}/); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).toMatch(/chip="Personal"/); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).toMatch(/chip="Workspace"/); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).toMatch(/chip="Organization"/); // (P3/P4 domain remediation 2026-07-21)
  });

  it("active workspace is visually marked (is-active + aria-current)", () => {
    // The shared SwitcherOption marks the active space via the is-active
    // class modifier on the menu item, plus aria-current="true".
    expect(TOPBAR).toMatch(/app-topbar-v2-workspace-menu-item is-active/); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).toMatch(/aria-current=\{option\.active \? "true" : undefined\}/); // (P3/P4 domain remediation 2026-07-21)
  });

  it("menu items expose the workspace scope chip", () => {
    expect(TOPBAR).toMatch(/data-workspace-scope-chip/);
  });
});

// =============================================================================
// PART 4 — Topbar CSS structure
// =============================================================================

describe("Phase 32.8C FINAL-4 — topbar CSS", () => {
  it("defines the workspace pill button styles", () => {
    expect(TOPBAR_CSS).toMatch(/\.app-topbar-v2-workspace-button\s*\{/);
    // P7-2 grouped the copy selector with siblings (comma-grouped rule) —
    // the style is still defined, now as `.app-topbar-v2-workspace-copy,`.
    expect(TOPBAR_CSS).toMatch(/\.app-topbar-v2-workspace-copy\s*[,{]/);
    expect(TOPBAR_CSS).toMatch(/data-workspace-name/);
  });

  it("defines the dropdown menu container + grouped section styles", () => {
    // The `.app-topbar-v2-workspace-menu` container rule is authored as a
    // COMMA-GROUPED selector (it shares the dropdown surface styles with
    // `.app-topbar-v2-account-menu`), so the selector head is followed by
    // a comma rather than `{`. Match either form ([,{]) — the assertion
    // still proves the dropdown-container rule exists, just tolerant of
    // the grouped authoring. The trailing `[,{]` (not `-`) keeps this
    // distinct from `-menu-group` / `-menu-group-label` below.
    expect(TOPBAR_CSS).toMatch(/\.app-topbar-v2-workspace-menu\s*[,{]/);
    expect(TOPBAR_CSS).toMatch(/\.app-topbar-v2-workspace-menu-group\s*[,{]/);
    expect(TOPBAR_CSS).toMatch(/\.app-topbar-v2-workspace-menu-group-label\s*[,{]/);
  });

  it("defines the active-state outline for the current workspace", () => {
    expect(TOPBAR_CSS).toMatch(/\.app-topbar-v2-workspace-menu-item\.is-active/);
  });

  it("defines the empty-state styling", () => {
    expect(TOPBAR_CSS).toMatch(/\.app-topbar-v2-workspace-menu-empty\s*\{/);
  });
});

// =============================================================================
// PART 5 — Persona-aware priority strip
// =============================================================================

describe("Phase 32.8C FINAL-4 — persona priority strip", () => {
  it("reads persona + sectionOrder from envelope.capabilityMatrix", () => {
    expect(CC_TSX).toMatch(/envelope\.capabilityMatrix\?\.persona/);
    expect(CC_TSX).toMatch(/envelope\.capabilityMatrix\?\.sectionOrder/);
  });

  it("renders the priority strip when sectionOrder is non-empty", () => {
    expect(CC_TSX).toMatch(/data-cc-persona-priority\b/);
    expect(CC_TSX).toMatch(/data-cc-persona-priority-item/);
    expect(CC_TSX).toMatch(/data-cc-persona-priority-rank/);
  });

  it("priority items render anchor links to existing section ids", () => {
    expect(CC_TSX).toMatch(/href=\{`#\$\{sectionId\}`/);
  });

  it("page root carries data-cc-persona for tests + CSS hooks", () => {
    expect(CC_TSX).toMatch(/data-cc-persona=\{persona \?\? "VIEWER"\}/);
  });

  it("hero meta renders a persona chip when persona is known", () => {
    expect(CC_TSX).toMatch(/data-cc-persona-chip/);
  });

  it("strip is capped at 8 priority items", () => {
    expect(CC_TSX).toMatch(/sectionOrder\.slice\(0,\s*8\)/);
  });

  it("CSS defines the priority strip layout", () => {
    expect(CC_CSS).toMatch(/\.ec-persona-priority\s*\{/);
    expect(CC_CSS).toMatch(/\.ec-persona-priority-list\s*\{/);
  });
});

// =============================================================================
// PART 6 — Bulk actions toolbar
// =============================================================================

describe("Phase 32.8C FINAL-4 — bulk actions toolbar", () => {
  it("renders the toolbar component", () => {
    expect(CC_TSX).toMatch(/function BulkActionsToolbar\(/);
    expect(CC_TSX).toMatch(/data-cc-bulk-actions-toolbar/);
    expect(CC_TSX).toMatch(/data-cc-bulk-actions-available/);
  });

  it("renders all 8 bounded bulk action chips", () => {
    for (const k of [
      "bulk_assign_workflows",
      "bulk_escalate_workflows",
      "bulk_resolve_workflows",
      "bulk_acknowledge_incidents",
      "bulk_suppress_incidents",
      "bulk_schedule_retry",
      "bulk_add_mitigation",
      "bulk_dismiss_recommendations",
    ]) {
      // The action key appears in the actions array; the JSX renders
      // `data-cc-bulk-action={a.key}` so we look for the key literal.
      expect(CC_TSX).toContain(`key: "${k}"`);
    }
  });

  it("disabled chips render a clear reason ('Requires team workspace' / 'Requires ADMIN or OWNER')", () => {
    expect(CC_TSX).toMatch(/"Requires workspace"/);
    expect(CC_TSX).toMatch(/"Requires ADMIN or OWNER"/);
  });

  it("schedule-retry chip explicitly notes retry-intent semantics", () => {
    expect(CC_TSX).toMatch(/Records retry intent only — never invokes the queue/);
  });

  it("permission gating reads from envelope.capabilityMatrix.capabilities", () => {
    expect(CC_TSX).toMatch(/capabilities\.bulkActions/);
    expect(CC_TSX).toMatch(/capabilities\.workflowActions/);
    expect(CC_TSX).toMatch(/capabilities\.incidentActions/);
  });

  it("toolbar is read-only: chips link to /admin/platform/observability, no inline mutations", () => {
    const block = CC_TSX.match(
      /function BulkActionsToolbar\([\s\S]*?\n\}\s*\n/,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/\/admin\/platform\/observability/);
    expect(block![0]).not.toMatch(/<button/);
    expect(block![0]).not.toMatch(/onClick/);
    expect(block![0]).not.toMatch(/method:\s*"POST"/);
  });

  it("footnote explicitly states the dashboard is read-only", () => {
    // ADM-013 PHASE 1 — the sentence is unchanged; the em dash it used to sit behind is
    // not. The footnote was wrapped in `{canObservability ? … : …}`, so which
    // of two sentences a reader saw depended on a PLATFORM capability on a
    // WORKSPACE dashboard. Both sentences said the dashboard is read-only, so
    // the branch bought nothing and cost the reader a different explanation
    // for the same fact. It is now unconditional.
    expect(CC_TSX).toMatch(
      /dashboard is read-only[\s\S]{0,40}chips above link to the canonical surface/,
    );
    expect(CC_TSX).toMatch(
      /Bulk actions are executed on the Operations Center page[\s\S]{0,120}href="\/operations"/,
    );
  });
});

// =============================================================================
// PART 7 — No raw UUID anywhere
// =============================================================================

describe("Phase 32.8C FINAL-4 — no raw UUID in shell rendering paths", () => {
  it("topbar workspace name slot never references workspaceId as a fallback (account-menu refactor 2026-07-21)", () => {
    // Selector updated to the folded account-menu badge, which renders the
    // resolved workspace name and never the raw id.
    const badge = TOPBAR.match(
      /data-account-menu-header-workspace[\s\S]*?<\/span>/,
    );
    expect(badge).not.toBeNull();
    expect(badge![0]).not.toMatch(/workspaceId/);
  });

  it("workspace switcher menu items never fall back to w.id as display text", () => {
    expect(TOPBAR).not.toMatch(/\{w\.name \?\? w\.id\}/);
    expect(TOPBAR).not.toMatch(/w\.name \|\| w\.id/);
  });

  it("type allows nullable workspace name (so we can fall back to a scope label, not an id)", () => {
    // The live toolbar falls back from activeSpace.displayName to the
    // bounded "Organization workspace" scope label — never the raw id.
    expect(TOPBAR).toMatch(/displayName \?\?[\s\S]{0,80}Organization workspace/);
  });
});

// =============================================================================
// PART 8 — No-regression invariants
// =============================================================================

describe("Phase 32.8C FINAL-4 — no-regression invariants", () => {
  it("dashboard remains read-only at page-load (no POST on render)", () => {
    expect(CC_TSX).not.toMatch(/method:\s*"POST"/);
  });

  it("topbar fix did not break sidebar or runtime banner integration", () => {
    expect(TOPBAR).toMatch(/onToggleMobileSidebar/);
  });

  it("persona priority strip never renders raw UUIDs", () => {
    const strip = CC_TSX.match(
      /<nav\s+className="ec-persona-priority"[\s\S]*?<\/nav>/,
    );
    expect(strip).not.toBeNull();
    // No UUID-like {workspace.workspaceId} references inside the strip.
    expect(strip![0]).not.toMatch(/workspaceId/);
  });

  it("bulk toolbar is gated by scope + persona — never bypasses auth", () => {
    expect(CC_TSX).toMatch(
      /canAct:\s*capabilities\.bulkActions/,
    );
  });

  it("no marketing copy / fake AI / 'powered by' / lorem ipsum", () => {
    for (const banned of ["lorem ipsum", "powered by AI", "AI-powered"]) {
      expect(CC_TSX).not.toMatch(new RegExp(banned, "i"));
      expect(TOPBAR).not.toMatch(new RegExp(banned, "i"));
    }
  });

  it("topbar workspace pill never renders 'WorkspaceWorkspace' adjacent string literals", () => {
    // Defensive: ensure no JSX renders "Workspace" + "Workspace" with no
    // separator. The risky spot was the cluster name + scope-line.
    expect(TOPBAR).not.toMatch(/"Workspace"\s*\}\s*<\/strong>[\s\S]{0,40}"Workspace"/);
  });
});
