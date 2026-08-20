/**
 * Phase 7C — Internal Enterprise UX rebuild, source-contract guards.
 *
 * These fail if a core internal surface regresses to the old raw/unwrapped
 * layout or drops the shared design-system shell. They assert STRUCTURE
 * (shell adoption), not pixels — cheap, deterministic, CI-safe.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
// /cases — must render through the shared shell, not raw text/buttons.
// ---------------------------------------------------------------------------
test("/cases list renders through the shared PageShell (not a raw layout)", () => {
  const src = read("components/cases-experience/CasesIndex.tsx");
  assert.match(src, /PageShell/, "CasesIndex must use the shared PageShell");
  assert.match(src, /PageHeader/, "CasesIndex must use the shared PageHeader");
  // No bare unstyled top-level wrapper as the page root.
  assert.doesNotMatch(
    src,
    /return\s*\(\s*<div className="cases-list">/,
    "cases list must not render a raw unwrapped <div> root",
  );
});

// ---------------------------------------------------------------------------
// /collaboration-teams — must use the shell, not the raw `.cc-page` wrapper.
// ---------------------------------------------------------------------------
test("/collaboration-teams renders through the shared PageShell (no raw cc-page root)", () => {
  const src = read("app/(app)/collaboration-teams/page.tsx");
  assert.match(src, /PageShell/, "collaboration-teams must use the shared PageShell");
  assert.doesNotMatch(
    src,
    /<main className="cc-page"/,
    "collaboration-teams must not render the raw <main className='cc-page'> layout",
  );
});

// ---------------------------------------------------------------------------
// /admin/provisioning — no "admin workspace" dead-end; uses the fixed hook.
// ---------------------------------------------------------------------------
test("/admin/provisioning has no 'admin workspace' copy and uses useActiveWorkspaceId", () => {
  const src = read("app/(app)/admin/provisioning/page.tsx");
  assert.doesNotMatch(src, /admin workspace/i, "no 'admin workspace' concept may appear");
  assert.doesNotMatch(src, /Switch to your admin/i);
  assert.match(src, /useActiveWorkspaceId\(\)/);
  assert.doesNotMatch(src, /useTeamId\(\)/, "must not use the personal-mode-null useTeamId");
});

// ---------------------------------------------------------------------------
// /home — the operational cards are now first-class inline dashboard
// sections (no collapse/accordion). The old <details data-home-diagnostics>
// disclosure and the "Get things done" primary-action block were removed so
// the page reads like a real dense operations dashboard, not a landing page
// with a hidden drawer.
// ---------------------------------------------------------------------------
test("/home shows operational cards inline (no collapse) and drops the Get-things-done block", () => {
  const src = read("components/home-experience/SelfServeHomeDashboard.tsx");
  // No collapsible disclosure and no "Get things done" primary-action row.
  assert.doesNotMatch(
    src,
    /data-home-diagnostics|<details/,
    "Home must NOT hide operational cards behind a <details> disclosure",
  );
  assert.doesNotMatch(
    src,
    /Get things done/,
    "the 'Get things done' primary-action section must be removed",
  );
  // The operational cards still render as first-class content. (Storage
  // moved out of the dashboard into a compact sidebar widget.)
  assert.match(src, /VerificationHealthCard/, "verification health card renders inline");
  assert.match(src, /EvidenceActivityChart/, "evidence activity card renders inline");
  // The premium shell section primitive is in use.
  assert.match(src, /PageSection/, "Home must use the shared PageSection for premium grouping");
});

// ---------------------------------------------------------------------------
// /settings — account settings must render through the shared shell, not the
// bespoke silver-card hero layout, while preserving the security link-card
// contract markers.
// ---------------------------------------------------------------------------
test("/settings renders through the shared PageShell (no bespoke silver-card hero)", () => {
  const src = read("app/(app)/settings/page.tsx");
  assert.match(src, /PageShell/, "settings index must use the shared PageShell");
  assert.match(src, /PageHeader/, "settings index must use the shared PageHeader");
  // The old bespoke hero + silver-card chrome is gone.
  assert.doesNotMatch(
    src,
    /settings-silver-card__bg/,
    "settings index must not render the bespoke silver-card background chrome",
  );
  assert.doesNotMatch(
    src,
    /className="app-hero app-hero-full"/,
    "settings index must not render the raw marketing hero",
  );
  // Phase Final-D5-PT2 contract, updated for the 2026-07-17 IA refactor:
  // personal account security is now the in-page Security SECTION (the
  // old link-card became the section anchor); the gated workspace
  // Identity & Security link keeps its marker.
  assert.match(src, /id="security"/);
  assert.match(src, /data-cc-security-link-card/);
});

// (2026-07-20) The `/settings/persona` wizard PageShell test was removed
// with the workspace-persona / workflow-personalization feature — the
// route and its page no longer exist.

// ---------------------------------------------------------------------------
// /search — REDESIGN/SEARCH moved this console off PageShell/PageHeader and
// onto its own canonical shell (search.css + the app-* primitives).
// PageShell and PageHeader are themselves inline-styled wrappers, so
// consuming them re-imported presentation this route then had to override.
// What Phase 7C actually guaranteed — no bespoke inline-styled header panel,
// a token-driven page surface — is what is pinned here, now against the
// canonical shell.
// ---------------------------------------------------------------------------
test("/search renders the canonical search shell, not a bespoke inline-styled header", () => {
  const src = read("app/(app)/search/page.tsx");
  assert.match(src, /import "\.\/search\.css";/, "search must load its canonical stylesheet");
  assert.match(src, /<main className="search-page"/, "search must use the canonical page surface");
  assert.match(src, /<header className="search-header">/, "search must use the canonical header");
  assert.doesNotMatch(
    src,
    /<header style=\{headerStyle\}/,
    "search must not render the bespoke <header style={headerStyle}> panel",
  );
  assert.doesNotMatch(
    src,
    /style=\{pageStyle\}/,
    "the inline page surface must stay deleted, not re-introduced",
  );
});

// ---------------------------------------------------------------------------
// /governance — page wrapped in the shared PageShell.
// ---------------------------------------------------------------------------
test("/governance page uses the shared PageShell", () => {
  const src = read("app/(app)/governance/page.tsx");
  assert.match(src, /PageShell/, "governance page must use the shared PageShell");
});

// ---------------------------------------------------------------------------
// /cases — no legacy .cc-page wrapper or btn-primary/btn-secondary classes.
// ---------------------------------------------------------------------------
test("/cases has no legacy .cc-page wrapper or btn-primary/btn-secondary classes", () => {
  const src = read("components/cases-experience/CasesIndex.tsx");
  assert.doesNotMatch(src, /className="cc-page"/, "no .cc-page wrapper");
  assert.doesNotMatch(src, /className="btn-primary"/, "no legacy btn-primary");
  assert.doesNotMatch(src, /className="btn-secondary"/, "no legacy btn-secondary");
});

// ---------------------------------------------------------------------------
// /reports — terminal states migrated off raw .cc-page.
// ---------------------------------------------------------------------------
test("/reports has no raw .cc-page terminal states or btn-secondary buttons", () => {
  const src = read("components/reports-experience/ReportsIndex.tsx");
  assert.doesNotMatch(
    src,
    /<main className="cc-page"/,
    "reports terminal states must not use raw <main className='cc-page'>",
  );
  assert.doesNotMatch(src, /className="btn-secondary"/, "no legacy btn-secondary");
});

// ---------------------------------------------------------------------------
// Sidebar/header — the live shell CSS uses the new enterprise nav tokens;
// the live header is AppAccountToolbar (the dead AppTopbarV2 fragment
// was deleted in the product reset).
// ---------------------------------------------------------------------------
test("app shell sidebar uses the branded light surface + enterprise-dark nav ink", () => {
  const css = read("components/app-shell-v2/app-shell-v2.css");
  // The sidebar background is now the branded light artwork (not the old
  // dark --nav-surface-* gradient), shown naturally with no overlay.
  assert.match(
    css,
    /background-image:\s*url\(["']?\/assets\/cards\/sidebar\.png/,
    "sidebar must use the branded light background image",
  );
  // Foreground nav ink must be enterprise-dark for readability on the light
  // surface — never the old near-white nav ink.
  assert.match(
    css,
    /--nav-ink:\s*#1A1F2B/i,
    "primary nav labels must be enterprise-dark on the light sidebar",
  );
});

// ---------------------------------------------------------------------------
// Internal pages must import/use the shared shell components.
// ---------------------------------------------------------------------------
test("migrated internal pages import the shared design-system shell", () => {
  const shellUsers: ReadonlyArray<string> = [
    "app/(app)/investigation/page.tsx",
    "app/(app)/audit-transparency/page.tsx",
    "app/(app)/operations/page.tsx",
    "app/(app)/operations/readiness/page.tsx",
    "app/(app)/capture/page.tsx",
    "app/(app)/evidence/page.tsx",
    // 2026-07-17 IA refactor — /settings/security merged into the
    // unified /settings workspace (same shared shell).
    "app/(app)/settings/page.tsx",
    "components/reports-experience/ReportsIndex.tsx",
  ];
  for (const rel of shellUsers) {
    const src = read(rel);
    assert.match(
      src,
      /PageShell|PageHeader/,
      `${rel} must import/use the shared PageShell/PageHeader`,
    );
  }
});
