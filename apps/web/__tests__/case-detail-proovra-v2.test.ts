/**
 * Phase CASE-DETAIL-PROOVRA-V2 — contract for the Case Details surface.
 *
 * HISTORY / WHAT THIS FILE NOW PINS
 * ---------------------------------
 * An earlier revision of this phase shipped a PARALLEL design layer:
 * `components/proovra-v2/*` (its own stylesheet, its own primitives, its own
 * icon set) plus a `useProovraV2Surface()` hook that stamped
 * `:root[data-pv2-surface]` at runtime so route-scoped rules could restyle the
 * shared shell. That architecture was rejected: it left two valid answers to
 * "which Button / Card / Tabs / Icon / Surface does this page use?".
 *
 * The parallel layer has been CONSOLIDATED into the existing canonical
 * authorities and deleted. This file now pins the consolidation itself
 * alongside every behavioural guarantee the previous revision protected:
 *
 *   1. ONE authority per responsibility. No `components/proovra-v2`, no
 *      `useProovraV2Surface`, no `data-pv2-surface`, no `proovra-v2.css`
 *      import, no `.pv2-*` class anywhere in the repository.
 *   2. Case data comes from the SAME single envelope call as before, and
 *      every displayed number is derived from it (nothing hardcoded to the
 *      Figma sample values).
 *   3. Authorization-driven affordances still gate on the SAME server
 *      projections (`viewer.can*`, `viewer.disabledReasons.*`).
 *   4. Tab routing, Case-ID copy, evidence search, and the remove-from-case
 *      confirmation keep their existing wiring and spec-locked copy.
 *   5. The Copilot stays advisory: same component, same props, no `aiEnabled`
 *      override and no new AI endpoint.
 *   6. Loading / empty / error / restricted states all still exist.
 *   7. The accepted accessibility corrections survive the consolidation —
 *      readable warning ink, upright disclosure chips, logical-property RTL,
 *      one logo in the mobile drawer, canonical hero primary.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), "utf8");

const SIMPLE_DETAIL = read(
  "apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx",
);
const GLOBALS = read("apps/web/app/globals.css");
const APP_LAYOUT = read("apps/web/app/(app)/layout.tsx");
const CASE_PAGE = read("apps/web/app/(app)/cases/[id]/page.tsx");
const COPILOT = read("apps/web/components/ai-copilot/CaseCopilotPanel.tsx");
const SHELL_CSS = read("apps/web/components/app-shell-v2/app-shell-v2.css");
const CASES_CSS = read(
  "apps/web/components/cases-experience/cases-experience.css",
);
const PRIMITIVES_CSS = read(
  "apps/web/components/app-primitives/app-primitives.css",
);
const TOKENS_CSS = read("apps/web/lib/design-tokens/tokens.css");
const CASES_INDEX = read("apps/web/components/cases-experience/CasesIndex.tsx");
const HELPERS = read(
  "apps/web/components/cases-experience/simple-case-detail/helpers.ts",
);

/** Source text with comments removed — so a doc comment describing a banned
 *  literal never trips a "this literal must not appear" assertion. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

/** Body of a top-level `function <name>(` declaration, brace-balanced. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  let depth = 0;
  let i = src.indexOf("{", start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  throw new Error(`unbalanced body for ${name}`);
}

/** The regions this phase owns. */
const REDESIGNED = [
  "CaseDetailHeader",
  "OverviewTab",
  "EvidenceTab",
  "CaseDetailPlane",
] as const;

/** Every tracked source file under apps/web (no build output, no deps). */
function sourceFiles(): string[] {
  const roots = ["app", "components", "lib", "hooks", "__tests__"].map((d) =>
    resolve(repoRoot, "apps/web", d),
  );
  const out: string[] = [];
  const skip = new Set(["node_modules", ".next", "dist", "coverage"]);
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|css|mjs|js)$/.test(name)) out.push(full);
    }
  };
  roots.forEach(walk);
  return out;
}

// ===========================================================================
// 1. CONSOLIDATION — the parallel V2 layer is gone, not merely unused
// ===========================================================================

test("the parallel proovra-v2 layer no longer exists on disk", () => {
  assert.equal(
    existsSync(resolve(repoRoot, "apps/web/components/proovra-v2")),
    false,
    "components/proovra-v2 must not exist — its responsibilities were merged into the canonical authorities",
  );
});

test("zero references to the parallel layer survive anywhere in apps/web", () => {
  // THIS file documents the removed names in prose; every other source file
  // must be clean. The banned tokens are matched against code, not comments.
  const banned = [
    "components/proovra-v2",
    "useProovraV2Surface",
    "data-pv2-surface",
    "proovra-v2.css",
    "pv2-",
    "--pv2-",
  ];
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    // Test files may NAME the removed layer in prose (this file and the
    // Case Details branch contract both document what was deleted); only
    // production sources must be clean.
    if (file.includes("__tests__")) continue;
    const body = code(readFileSync(file, "utf8"));
    for (const needle of banned) {
      if (body.includes(needle)) {
        offenders.push(`${file.replace(repoRoot, "")} :: ${needle}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `parallel-layer references remain:\n${offenders.join("\n")}`);
});

test("globals.css no longer imports a parallel stylesheet", () => {
  assert.equal(GLOBALS.includes("proovra-v2"), false);
  // The canonical sheet set is unchanged and each is imported exactly once.
  const imports = GLOBALS.split("\n").filter((l) => l.trim().startsWith("@import"));
  for (const sheet of [
    "lib/design-tokens/tokens.css",
    "app-shell-v2/app-shell-v2.css",
    "app-primitives/app-primitives.css",
    "cases-experience/cases-experience.css",
  ]) {
    assert.equal(
      imports.filter((l) => l.includes(sheet)).length,
      1,
      `${sheet} must be imported exactly once`,
    );
  }
});

test("no route-activated styling mechanism remains", () => {
  // Nothing may stamp a document-level attribute to switch design systems.
  assert.doesNotMatch(
    code(SIMPLE_DETAIL),
    /document\.documentElement\.setAttribute/,
    "Case Details must render from its own components + styles, not a runtime root attribute",
  );
  assert.doesNotMatch(code(SIMPLE_DETAIL), /useEffect\([^)]*root\.setAttribute/);
});

test("the (app) layout still mounts the SAME shared AppShellV2 (no parallel shell)", () => {
  assert.match(APP_LAYOUT, /<AppShellV2 onLogout=\{handleLogout\}>/);
  assert.doesNotMatch(APP_LAYOUT, /data-pv2-surface/);
});

test("the shell stylesheet carries no page-scoped override for this route", () => {
  // A route-specific shell override is what made one page disagree with the
  // shell every other page renders inside.
  assert.doesNotMatch(SHELL_CSS, /data-pv2-surface/);
  assert.doesNotMatch(CASES_CSS, /\.app-shell-v2-content\s*\{/);
  assert.doesNotMatch(CASES_CSS, /\.app-account-toolbar/);
  assert.doesNotMatch(CASES_CSS, /\.app-sidebar-v2/);
  assert.doesNotMatch(CASES_CSS, /--header-h\s*:/);
});

test("the case route still switches between MatterWorkspace and SimpleCaseDetail unchanged", () => {
  assert.match(CASE_PAGE, /useEnterpriseSurfaceAccess/);
  assert.match(CASE_PAGE, /<MatterWorkspace caseId=\{caseId\}/);
  assert.match(
    CASE_PAGE,
    /<SimpleCaseDetail caseId=\{caseId\} onOpenEvidence=\{onOpenEvidence\} \/>/,
  );
});

// ===========================================================================
// 1b. ONE AUTHORITY PER RESPONSIBILITY
// ===========================================================================

test("Case Details renders buttons from the ONE canonical action authority", () => {
  const body = code(SIMPLE_DETAIL);
  // The canonical actions are defined once, in app-primitives.css.
  for (const cls of [
    ".app-primary-action",
    ".app-secondary-action",
    ".app-ghost-action",
    ".app-secondary-action--block",
  ]) {
    assert.ok(
      PRIMITIVES_CSS.includes(cls),
      `${cls} must be defined in app-primitives.css`,
    );
  }
  // The page uses them and declares no button skin of its own.
  assert.match(body, /className="app-secondary-action app-secondary-action--block"/);
  assert.match(body, /className="app-header-primary-action"/);
  // The local `CaseButton` is a NAME for the canonical actions, not a skin.
  const btn = fnBody(SIMPLE_DETAIL, "CaseButton");
  assert.doesNotMatch(btn, /background|border|boxShadow|borderRadius|height/);
  assert.match(SIMPLE_DETAIL, /const CASE_BUTTON_CLASS: Record<[\s\S]{0,220}?primary: "app-primary-action"/);
});

test("Case Details renders ONE tabs authority — the canonical .app-tabs", () => {
  assert.match(PRIMITIVES_CSS, /^\.app-tabs \{/m);
  assert.match(PRIMITIVES_CSS, /^\.app-tab \{/m);
  assert.match(SIMPLE_DETAIL, /className="app-tabs"/);
  assert.match(
    SIMPLE_DETAIL,
    /className=\{activeTab === tab\.id \? "app-tab is-active" : "app-tab"\}/,
  );
  // The duplicate authority was DELETED, not aliased: no sheet may define
  // `.case-tabs` / `.case-tab` and no surface may emit them.
  assert.doesNotMatch(CASES_CSS, /\.case-tabs?\b/);
  for (const src of [SIMPLE_DETAIL, CASES_INDEX]) {
    assert.doesNotMatch(src, /"case-tabs?"/);
  }
});

test("Case Details renders ONE card/surface authority — .app-panel", () => {
  assert.match(PRIMITIVES_CSS, /^\.app-panel \{/m);
  assert.match(PRIMITIVES_CSS, /^\.app-inner-surface \{/m);
  assert.match(SIMPLE_DETAIL, /className="app-panel app-panel__body"/);
  // No second surface class is invented for this page.
  assert.doesNotMatch(CASES_CSS, /\.case-detail-surface/);
});

test("Case Details renders ONE icon authority — lucide-react", () => {
  assert.match(
    SIMPLE_DETAIL,
    /import \{ Copy, FileText, Plus, Search, Share2, ShieldCheck \} from "lucide-react";/,
  );
  // No second icon library, and no emoji standing in for an icon.
  assert.doesNotMatch(SIMPLE_DETAIL, /react-icons|@heroicons/);
  assert.doesNotMatch(
    code(SIMPLE_DETAIL),
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
    "no emoji may stand in for an icon",
  );
  // Icons stay decorative: every glyph is aria-hidden.
  const body = code(SIMPLE_DETAIL);
  const glyphs = [...body.matchAll(/<(Copy|FileText|Plus|Search|Share2|ShieldCheck)\b[^/]*\/>/g)];
  assert.ok(glyphs.length >= 7, `expected the icon set to be used, found ${glyphs.length}`);
  for (const match of glyphs) {
    const tag = match[0];
    // Either the glyph is aria-hidden itself, or it sits inside the shell's
    // canonical `<span aria-hidden="true">` icon wrapper.
    const before = body.slice(Math.max(0, match.index - 120), match.index);
    assert.ok(
      /aria-hidden="true"/.test(tag) || /aria-hidden="true">\s*$/.test(before),
      `icon must be decorative (aria-hidden): ${tag}`,
    );
  }
});

test("Case Details declares no semantic colour of its own", () => {
  // Every colour on this surface resolves through a canonical token or class.
  const caseBlock = CASES_CSS.slice(CASES_CSS.indexOf("CASE DETAILS — page presentation"));
  const inks = [...caseBlock.matchAll(/color:\s*([^;]+);/g)].map((m) => m[1].trim());
  for (const ink of inks) {
    assert.ok(
      ink.includes("var(--") || ink === "inherit" || ink === "currentColor",
      `Case Details CSS must read a token, got raw value: ${ink}`,
    );
  }
});

// ===========================================================================
// 2. Data — one envelope, everything derived
// ===========================================================================

test("case data still comes from the single matter-workspace envelope call", () => {
  assert.match(
    SIMPLE_DETAIL,
    /apiFetch\(\s*\n?\s*`\/v1\/cases\/\$\{caseId\}\/matter-workspace`,?\s*\n?\s*\)/,
  );
  // No second header round-trip was reintroduced.
  assert.doesNotMatch(SIMPLE_DETAIL, /apiFetch\(`\/v1\/cases\/\$\{caseId\}`\)/);
});

test("every KPI value is derived from the envelope — the Figma sample is never hardcoded", () => {
  const block = SIMPLE_DETAIL.slice(
    SIMPLE_DETAIL.indexOf("const kpis:"),
    SIMPLE_DETAIL.indexOf("const summaryRows:"),
  );
  assert.ok(block.length > 0, "KPI block not found");
  assert.match(block, /value: String\(evidenceCount\)/);
  assert.match(block, /deliverables\.reportsReady/);
  assert.match(block, /deliverables\.packagesReady/);
  // The Figma mock renders "3 of 3" for a three-record case. That is DATA,
  // and it must never appear as a literal in shipped code.
  assert.doesNotMatch(code(SIMPLE_DETAIL), /3 of 3/);
  // The mock's case name must not be baked in either.
  assert.doesNotMatch(code(SIMPLE_DETAIL), /Bilal/);
});

test("the four Overview metrics keep their canonical labels and hints", () => {
  for (const label of [
    "Evidence records",
    "End-to-end ready",
    "Reports",
    "Verification links",
  ]) {
    assert.ok(
      SIMPLE_DETAIL.includes(`label: "${label}"`),
      `missing KPI label ${label}`,
    );
  }
  for (const hint of [
    "Linked to this case",
    "Report + package present",
    "Records with a report",
    "Records with a package",
  ]) {
    assert.ok(SIMPLE_DETAIL.includes(hint), `missing KPI hint ${hint}`);
  }
  // Rendered by the canonical KPI grid + card, label above value.
  assert.match(SIMPLE_DETAIL, /className="app-grid-kpis"/);
  assert.match(
    SIMPLE_DETAIL,
    /app-kpi-card__label">\{kpi\.label\}[\s\S]{0,200}?app-kpi-card__value">\{kpi\.value\}[\s\S]{0,200}?app-kpi-card__meta">\{kpi\.hint\}/,
  );
});

test("the case summary panel still surfaces every existing field", () => {
  const block = SIMPLE_DETAIL.slice(
    SIMPLE_DETAIL.indexOf("const summaryRows:"),
    SIMPLE_DETAIL.indexOf("return (", SIMPLE_DETAIL.indexOf("const summaryRows:")),
  );
  for (const label of [
    "Status",
    "Priority",
    "Reference",
    "Created",
    "Last updated",
  ]) {
    assert.ok(block.includes(`label: "${label}"`), `summary row ${label} lost`);
  }
  // Rendered as a real definition list.
  assert.match(SIMPLE_DETAIL, /<dl className="case-detail-kv">/);
  assert.match(SIMPLE_DETAIL, /<dt className="case-detail-kv-key">\{row\.label\}<\/dt>/);
  assert.match(SIMPLE_DETAIL, /<dd className="case-detail-kv-val">\{row\.value\}<\/dd>/);
});

// ===========================================================================
// 3. Authorization — same server projections, no client-side widening
// ===========================================================================

test("Add evidence stays gated on viewer.canLinkEvidence with the server's reason", () => {
  assert.match(
    SIMPLE_DETAIL,
    /disabled=\{!canLinkEvidence\}[\s\S]{0,200}?data-simple-case-action="add-evidence"/,
  );
  assert.match(
    SIMPLE_DETAIL,
    /title=\{linkEvidenceDisabledReason \?\? undefined\}/,
  );
  // The rail + attention-panel duplicates read the same projection.
  assert.match(SIMPLE_DETAIL, /disabled=\{!viewer\.canLinkEvidence\}/);
  assert.match(
    SIMPLE_DETAIL,
    /title=\{viewer\.disabledReasons\.linkEvidence \?\? undefined\}/,
  );
});

test("Remove-from-case still gates ONLY on the viewer unlink flags", () => {
  assert.match(
    SIMPLE_DETAIL,
    /!\(\s*\n?\s*viewer\.canUnlinkEvidence \|\|\s*\n?\s*viewer\.canUnlinkLegacyEvidence\s*\n?\s*\)/,
  );
  assert.match(
    SIMPLE_DETAIL,
    /title=\{\s*\n?\s*viewer\.disabledReasons\.unlinkEvidence \?\?\s*\n?\s*viewer\.disabledReasons\.unlinkLegacyEvidence/,
  );
  // It keeps the shared semantic danger action.
  assert.match(SIMPLE_DETAIL, /className="cases-remove-action"/);
  assert.match(CASES_CSS, /^\.cases-remove-action \{/m);
});

test("the surface introduces no client-side capability decisions", () => {
  assert.doesNotMatch(SIMPLE_DETAIL, /role === "(OWNER|ADMIN|MEMBER)"/);
  assert.doesNotMatch(SIMPLE_DETAIL, /accountPlan/);
  assert.doesNotMatch(SIMPLE_DETAIL, /isPlatformAdmin/);
});

// ===========================================================================
// 4. Tabs / Case ID / search / remove confirmation
// ===========================================================================

test("the five tabs keep their canonical order, ids and data attributes", () => {
  const block = SIMPLE_DETAIL.slice(
    SIMPLE_DETAIL.indexOf("const TAB_ORDER"),
    SIMPLE_DETAIL.indexOf("];", SIMPLE_DETAIL.indexOf("const TAB_ORDER")),
  );
  const ids = [...block.matchAll(/id: "([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, [
    "overview",
    "evidence",
    "reports",
    "notes",
    "settings",
  ]);
  assert.match(SIMPLE_DETAIL, /data-simple-case-tab=\{tab\.id\}/);
  assert.match(SIMPLE_DETAIL, /onClick=\{\(\) => setActiveTab\(tab\.id\)\}/);
});

test("the tab bar is a real tablist with per-tab aria-selected", () => {
  assert.match(SIMPLE_DETAIL, /role="tablist"/);
  assert.match(SIMPLE_DETAIL, /role="tab"/);
  assert.match(SIMPLE_DETAIL, /aria-selected=\{activeTab === tab\.id\}/);
});

test("Case ID copy keeps the clipboard write and the success toast", () => {
  assert.match(SIMPLE_DETAIL, /data-simple-case-id/);
  assert.match(
    SIMPLE_DETAIL,
    /navigator\.clipboard\?\.writeText\(caseDetail\.id\)[\s\S]{0,120}?addToast\("Case ID copied\.", "success"\)/,
  );
  // The identifier must stay LTR + selectable inside an RTL document.
  assert.match(
    CASES_CSS,
    /\.case-detail-copy-value \{[\s\S]{0,220}?direction: ltr;[\s\S]{0,120}?unicode-bidi: isolate;/,
  );
  // The control reuses the canonical secondary action rather than a new skin.
  assert.match(
    SIMPLE_DETAIL,
    /className="app-secondary-action case-detail-copy"/,
  );
});

test("evidence search keeps its client-side haystack semantics", () => {
  const block = SIMPLE_DETAIL.slice(
    SIMPLE_DETAIL.indexOf("const visibleItems"),
    SIMPLE_DETAIL.indexOf(": items;", SIMPLE_DETAIL.indexOf("const visibleItems")),
  );
  for (const field of [
    "getDisplayTitle(item)",
    "item.type",
    "item.status",
    "item.id",
    "item.id.slice(0, 8)",
  ]) {
    assert.ok(block.includes(field), `search haystack lost ${field}`);
  }
  assert.match(SIMPLE_DETAIL, /data-simple-case-evidence-search/);
  assert.match(SIMPLE_DETAIL, /data-simple-case-evidence-no-match/);
  // Rendered by the canonical search field, using its documented full-width
  // variant rather than a second search component.
  assert.match(
    SIMPLE_DETAIL,
    /className="app-search-field app-search-field--block"/,
  );
  assert.match(SIMPLE_DETAIL, /className="app-search-input"/);
  assert.match(PRIMITIVES_CSS, /^\.app-search-field--block \{/m);
  // The leading icon and the input's leading padding must be LOGICAL so the
  // field mirrors in Arabic.
  assert.match(
    PRIMITIVES_CSS,
    /\.app-search-icon \{[\s\S]{0,320}?inset-inline-start: 14px;/,
  );
  assert.match(
    PRIMITIVES_CSS,
    /\.app-search-input \{[\s\S]{0,320}?padding-inline: 38px 14px;/,
  );
  assert.match(SIMPLE_DETAIL, /aria-label="Search linked evidence"/);
});

test("remove-from-case still runs the canonical confirm with the preservation copy", () => {
  assert.match(
    SIMPLE_DETAIL,
    /confirmLabel: "Remove from case",\s*\n[\s\S]{0,400}?tone: "danger",\s*\n\s*testId: "simple-case-evidence-remove",/,
  );
  assert.match(
    SIMPLE_DETAIL,
    /"This removes the evidence from this case only\. The evidence record itself will remain preserved\."/,
  );
  assert.match(
    SIMPLE_DETAIL,
    /apiFetch\(`\/v1\/cases\/\$\{caseId\}\/evidence\/\$\{evidenceId\}`,\s*\{\s*\n?\s*method: "DELETE",\s*\n?\s*\}\)/,
  );
});

// ===========================================================================
// 5. AI — still advisory, still policy-gated, nothing enabled
// ===========================================================================

test("the Copilot is the same component with the same props — only its position moved", () => {
  assert.match(SIMPLE_DETAIL, /<CaseCopilotPanel\s*\n\s*caseId=\{caseId\}\s*\n\s*linkedEvidence=/);
  // No aiEnabled override: workspace policy denial stays server-decided and
  // is rendered by the panel's own policy_denied / provider_unavailable paths.
  assert.doesNotMatch(code(SIMPLE_DETAIL), /aiEnabled/);
  // No AI endpoint is called from the case surface itself.
  assert.doesNotMatch(code(SIMPLE_DETAIL), /\/v1\/ai\//);
  // It sits in the rail of the shared two-column grid, with no styling wrapper.
  assert.match(
    SIMPLE_DETAIL,
    /<div className="case-detail-split case-detail-split--wide-rail">/,
  );
});

test("the Copilot renders from the canonical primitives, never a route-scoped skin", () => {
  // The panel used to emit `app-card` / `app-btn`, which had NO definition
  // anywhere; a route-scoped `.pv2-copilot-rail` block styled them for one
  // page only. It now uses the shared classes, defined once.
  assert.match(COPILOT, /className="app-panel app-panel__body"/);
  assert.match(COPILOT, /className="app-inner-surface app-panel__body"/);
  assert.match(COPILOT, /className="app-secondary-action"/);
  assert.match(COPILOT, /className="app-primary-action app-primary-action--block"/);
  assert.doesNotMatch(COPILOT, /className="app-card|className="app-btn/);
  for (const cls of [".app-chip", ".app-chip-row", ".app-alert"]) {
    assert.ok(
      PRIMITIVES_CSS.includes(cls),
      `${cls} must be defined once in app-primitives.css`,
    );
  }
});

test("the Copilot disclosure is never rewritten and never adds claims", () => {
  for (const disclosure of ["AI-generated", "Advisory only", "Metadata only"]) {
    assert.ok(COPILOT.includes(disclosure), `disclosure "${disclosure}" lost`);
  }
  assert.match(COPILOT, /advisoryBoundary/);
  assert.match(COPILOT, /processingMode: "METADATA_ONLY"/);
  // No stylesheet may inject copy into this surface.
  assert.doesNotMatch(CASES_CSS, /[^-]content:\s*"(?!["·])/);
});

// ===========================================================================
// 6. States
// ===========================================================================

test("loading / restricted / not-found / unavailable states all still render", () => {
  for (const attr of [
    "data-simple-case-detail-loading",
    "data-simple-case-detail-auth",
    "data-simple-case-detail-not-found",
    "data-simple-case-detail-unavailable",
  ]) {
    assert.ok(SIMPLE_DETAIL.includes(attr), `state ${attr} lost`);
  }
  // 401 → restricted, 404 → not found, everything else → unavailable.
  assert.match(SIMPLE_DETAIL, /e\.statusCode === 401[\s\S]{0,120}?status: "auth_error"/);
  assert.match(SIMPLE_DETAIL, /e\.statusCode === 404[\s\S]{0,120}?status: "not_found"/);
  // Every state renders from the ONE canonical empty-state / skeleton, with a
  // tone rather than a parallel component per state.
  assert.match(SIMPLE_DETAIL, /className="app-empty" data-tone="restricted"/);
  assert.match(SIMPLE_DETAIL, /className="app-empty" data-tone="danger"/);
  assert.match(SIMPLE_DETAIL, /className="app-skeleton case-detail-skel-bar"/);
  assert.match(PRIMITIVES_CSS, /\.app-empty\[data-tone="danger"\] strong/);
  assert.match(PRIMITIVES_CSS, /\.app-empty\[data-tone="restricted"\] strong/);
  // The loading state announces itself to assistive tech.
  assert.match(
    SIMPLE_DETAIL,
    /role="status"\s*\n?\s*aria-live="polite"\s*\n?\s*aria-label="Loading case"/,
  );
});

test("empty-evidence state keeps its attribute and points at the header CTA", () => {
  assert.match(SIMPLE_DETAIL, /data-simple-case-evidence-empty/);
  assert.match(
    SIMPLE_DETAIL,
    /Use <em>Add evidence<\/em> above to link files, photos,\s*\n?\s*videos, or documents to this case\./,
  );
  assert.match(SIMPLE_DETAIL, /data-simple-case-attention-empty/);
});

// ===========================================================================
// 7. Tokens — one definition per semantic value
// ===========================================================================

test("Case Details reads the canonical token authority only", () => {
  // Every custom property the page's CSS consumes must be declared in one of
  // the canonical sheets — never in a private token universe.
  const caseBlock = CASES_CSS.slice(CASES_CSS.indexOf("CASE DETAILS — page presentation"));
  const used = new Set(
    [...caseBlock.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]),
  );
  assert.ok(used.size > 0, "expected the page to consume tokens");
  // A property DECLARED inside the block itself is page-local scaffolding
  // (e.g. the rail width the responsive rules re-point); everything else must
  // come from a canonical sheet.
  const declared = `${TOKENS_CSS}\n${PRIMITIVES_CSS}\n${SHELL_CSS}`;
  for (const name of used) {
    if (caseBlock.includes(`  ${name}:`)) continue;
    assert.ok(
      declared.includes(`${name}:`),
      `${name} is consumed by Case Details but declared in no canonical sheet`,
    );
  }
});

test("the readable warning ink is a canonical token, declared exactly once", () => {
  assert.match(TOKENS_CSS, /--warning: #F59E0B;/);
  assert.match(TOKENS_CSS, /--warning-ink: #B45309;/);
  const declarations = [TOKENS_CSS, PRIMITIVES_CSS, CASES_CSS, SHELL_CSS]
    .join("\n")
    .match(/--warning-ink:\s*#/g);
  assert.equal(declarations?.length, 1, "--warning-ink must be declared once");
});

/** WCAG 2.x relative luminance + contrast ratio for two #rrggbb colours. */
function contrast(fg: string, bg: string): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex: string) => {
    const n = hex.replace("#", "");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

test("the attention panel keeps the accent for DECORATION and readable ink for TEXT", () => {
  const block = CASES_CSS.slice(
    CASES_CSS.indexOf(".case-detail-attention {"),
    CASES_CSS.indexOf(".case-detail-rail {"),
  );
  // A 4px accent on ONE logical edge of the canonical panel, so it mirrors in
  // Arabic — not a full outline and not a second card definition.
  assert.match(block, /border-inline-start: 4px solid var\(--warning, #F59E0B\);/);
  assert.doesNotMatch(block, /border:\s*1px solid/);
  assert.match(
    block,
    /\.case-detail-attention-bullet \{[\s\S]{0,240}?background: var\(--warning, #F59E0B\);/,
  );
  // The heading reads the semantic warning INK.
  assert.match(
    block,
    /\.case-detail-attention-title \{[\s\S]{0,320}?color: var\(--warning-ink, #B45309\);/,
  );
  // And that ink actually passes AA on the panel, while the decorative accent
  // deliberately does not — which is exactly why they are two tokens.
  assert.ok(
    contrast("#B45309", "#FFFFFF") >= 4.5,
    `warning ink = ${contrast("#B45309", "#FFFFFF").toFixed(2)}:1, need >= 4.5`,
  );
  assert.ok(contrast("#F59E0B", "#FFFFFF") < 4.5);
});

test("no raw hex leaks into the Case Details regions", () => {
  // The legacy `attachBadgeStyle` and the Add-evidence / Settings dialogs keep
  // their inline colours — those regions are untouched by this phase and are
  // pinned by cases-attach-picker.test.ts.
  for (const fn of REDESIGNED) {
    const leaked = [...code(fnBody(SIMPLE_DETAIL, fn)).matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(
      (m) => m[0],
    );
    assert.deepEqual(
      leaked,
      [],
      `raw hex must live in a canonical stylesheet, not ${fn}: ${leaked.join(", ")}`,
    );
  }
});

test("the Case Details regions carry no inline layout styles", () => {
  // Guards against the pattern of large inline style objects, which is what
  // made this surface impossible to restyle in the first place.
  for (const fn of REDESIGNED) {
    const body = code(fnBody(SIMPLE_DETAIL, fn));
    for (const [, decl] of body.matchAll(/style=\{\{([^}]*)\}\}/g)) {
      const props = [...decl.matchAll(/([a-zA-Z]+)\s*:/g)].map((m) => m[1]);
      for (const prop of props) {
        assert.ok(
          ["margin", "fontWeight"].includes(prop),
          `inline style in ${fn} must move to the stylesheet, got ${prop}`,
        );
      }
    }
  }
});

// ===========================================================================
// 7b. The shared sidebar is never reskinned
// ===========================================================================

test("no stylesheet outside app-shell-v2.css touches the shared rail", () => {
  // `tokens.css` is the canonical HOME of the sidebar geometry tokens; no
  // OTHER sheet may restyle the rail or re-point them.
  for (const [name, sheet] of [
    ["cases-experience.css", CASES_CSS],
    ["app-primitives.css", PRIMITIVES_CSS],
  ] as const) {
    assert.doesNotMatch(sheet, /\.app-sidebar-v2/, `${name} must not restyle the rail`);
    assert.doesNotMatch(
      sheet,
      /--sidebar-(collapsed|expanded|transition)\s*:/,
      `${name} must not reassign sidebar geometry`,
    );
  }
  assert.equal(
    (TOKENS_CSS.match(/--sidebar-collapsed\s*:/g) ?? []).length,
    1,
    "sidebar geometry must be declared once, in tokens.css",
  );
  // Sanity: the ORIGINAL rail definition is untouched, so this route inherits
  // exactly what /home, /cases and /evidence render.
  assert.match(
    SHELL_CSS,
    /\.app-sidebar-v2 \{[\s\S]*?background-image: url\("\/assets\/cards\/sidebar\.png"\)/,
  );
  assert.match(SHELL_CSS, /width: var\(--sidebar-collapsed\);/);
  assert.match(SHELL_CSS, /width: var\(--sidebar-expanded\);/);
});

test("the shell positions the rail LOGICALLY so RTL mirrors without duplicate rules", () => {
  assert.match(SHELL_CSS, /\.app-sidebar-v2 \{[\s\S]*?inset-inline-start: 0;/);
  assert.match(SHELL_CSS, /border-inline-end: 1px solid var\(--nav-divider\);/);
  assert.match(SHELL_CSS, /\.app-shell-v2-mobile-drawer \{[\s\S]*?inset-inline-start: 0;/);

  // NO physical inline-direction property may remain anywhere in the shell.
  const physical = SHELL_CSS.split("\n").filter((l) =>
    /^\s*(left|right|margin-left|margin-right|padding-left|padding-right|border-left|border-right)\s*:/.test(l),
  );
  assert.deepEqual(physical, [], `physical direction properties left in the shell: ${physical.join(" | ")}`);

  // `transform` and `box-shadow` have no logical form, so their SIGN is
  // carried by three variables flipped in ONE narrow rule.
  for (const v of ["--shell-reveal-offset", "--shell-drawer-closed", "--shell-rail-shadow-x"]) {
    assert.match(SHELL_CSS, new RegExp(`${v}:`), `${v} must be declared`);
  }
  assert.match(SHELL_CSS, /:root\[dir="rtl"\] \{[\s\S]{0,220}?--shell-reveal-offset: 4px;[\s\S]{0,120}?--shell-drawer-closed: 105%;/);
  const rtlBlocks = (SHELL_CSS.match(/\[dir="rtl"\]\s*[,{]/g) ?? []).length;
  assert.equal(rtlBlocks, 1, `expected exactly one [dir=rtl] rule in the shell, found ${rtlBlocks}`);
});

test("the mobile header declutter is scoped to the TOPBAR, not the class", () => {
  // `.app-header-primary-action` is the canonical primary SKIN and ~10 page
  // bodies reuse it. An unscoped `display: none` below 981px hid every one of
  // them — on Case Details that removed the ONLY Add-evidence entry point on
  // mobile, because the tab body and empty state render no duplicate.
  const mobile = SHELL_CSS.slice(SHELL_CSS.indexOf("@media (max-width: 980px)"));
  assert.match(mobile, /\.app-header-zone-right \.app-header-primary-action,/);
  const unscoped = mobile
    .split("\n")
    .filter((l) => /^\s*\.app-header-primary-action\s*[,{]/.test(l));
  assert.deepEqual(
    unscoped,
    [],
    `the header primary must never be hidden by class alone: ${unscoped.join(" | ")}`,
  );
});

// ===========================================================================
// 7c. One logo in the open mobile drawer
// ===========================================================================

test("the mobile drawer hides the brand MARK so only the wordmark shows", () => {
  const drawerBlock = SHELL_CSS.slice(
    SHELL_CSS.indexOf(".app-shell-v2-mobile-drawer .app-sidebar-v2-brand::before"),
    SHELL_CSS.indexOf(".app-shell-v2-mobile-drawer .app-sidebar-v2-storage-body"),
  );
  assert.match(
    drawerBlock,
    /\.app-shell-v2-mobile-drawer \.app-sidebar-v2-brand-mark \{\s*\n?\s*opacity: 0;/,
  );
  assert.match(drawerBlock, /\.app-shell-v2-mobile-drawer \.app-sidebar-v2-brand-logo/);
  // Never hide BOTH, and never reach for display:none (which would remove the
  // element from the desktop crossfade too).
  assert.doesNotMatch(drawerBlock, /brand-logo[^{]*\{[^}]*display:\s*none/);
  assert.doesNotMatch(drawerBlock, /brand-mark[^{]*\{[^}]*display:\s*none/);
  // The desktop crossfade pair is still intact.
  assert.match(
    SHELL_CSS,
    /\.app-sidebar-v2:hover \.app-sidebar-v2-brand-mark,[\s\S]{0,120}?opacity: 0;/,
  );
});

// ===========================================================================
// 7d. No italics anywhere in the Copilot
// ===========================================================================

test("no italic typography survives in the Copilot panel", () => {
  assert.doesNotMatch(CASES_CSS, /font-style:\s*italic/);
  assert.doesNotMatch(PRIMITIVES_CSS, /font-style:\s*italic/);
  // The chip primitive pins upright explicitly, so an inherited italic in a
  // future container cannot slant the disclosure line.
  assert.match(PRIMITIVES_CSS, /\.app-chip \{[\s\S]{0,420}?font-style: normal;/);
  // Disclosure + metadata labels must not be marked up as emphasis.
  assert.doesNotMatch(COPILOT, /<em[\s>]/);
  assert.doesNotMatch(COPILOT, /<i[\s>]/);
  assert.doesNotMatch(COPILOT, /fontStyle/);
});

test("disclosure + metadata labels are list items, so they never concatenate", () => {
  // As adjacent spans these produced "AI-generatedAdvisory onlyMetadata only"
  // and "DOCUMENTv2Reported" in the DOM and in the accessible name.
  assert.match(
    COPILOT,
    /<ul className="app-chip-row" aria-label="AI disclosures">\s*\n\s*<li className="app-chip app-chip--ai">AI-generated<\/li>\{" "\}\s*\n\s*<li className="app-chip">Advisory only<\/li>\{" "\}\s*\n\s*<li className="app-chip">Metadata only<\/li>/,
  );
  assert.match(
    COPILOT,
    /<ul className="app-chip-row" aria-label=\{`\$\{e\.title\} metadata`\}>\s*\n\s*<li className="app-chip">\{e\.type\}<\/li>\{" "\}\s*\n\s*<li className="app-chip">v\{e\.version\}<\/li>\{" "\}\s*\n\s*<li className="app-chip">\{e\.status\}<\/li>/,
  );
  // The whitespace nodes are what keep `textContent` from serialising as
  // "AI-generatedAdvisory onlyMetadata only" / "DOCUMENTv2Reported".
  assert.ok(
    (COPILOT.match(/<\/li>\{" "\}/g) ?? []).length >= 4,
    "separator text nodes between chips were removed",
  );
  // A real gap keeps them visually discrete too — once, canonically.
  assert.match(PRIMITIVES_CSS, /\.app-chip-row \{[\s\S]{0,260}?gap: 8px;/);
  // Selection behaviour is untouched.
  assert.match(COPILOT, /onChange=\{\(\) => toggle\(e\.id\)\}/);
  assert.match(COPILOT, /setSelected\(new Set\(selectableIds\)\)/);
  assert.match(COPILOT, /setSelected\(new Set\(\)\)/);
});

// ===========================================================================
// 7e. Hero Add evidence reuses the canonical primary
// ===========================================================================

test("the hero Add evidence button reuses the shared .app-header-primary-action", () => {
  assert.match(
    SIMPLE_DETAIL,
    /className="app-header-primary-action"\s*\n\s*onClick=\{onAddEvidence\}\s*\n\s*disabled=\{!canLinkEvidence\}/,
  );
  // Same class the /cases "Create case" button uses — one primary app-wide.
  assert.match(CASES_INDEX, /className="app-header-primary-action"\s*\n\s*data-create-case-trigger/);
  // Colours are NOT duplicated: no sheet outside the shell may redeclare it.
  for (const sheet of [CASES_CSS, PRIMITIVES_CSS]) {
    assert.doesNotMatch(sheet, /\.app-header-primary-action\s*[,{]/);
  }
});

// ===========================================================================
// 7f. Responsive + RTL
// ===========================================================================

test("responsive rules exist and never hide custody or governance content", () => {
  const caseBlock = CASES_CSS.slice(CASES_CSS.indexOf("CASE DETAILS — page presentation"));
  assert.match(caseBlock, /@media \(max-width: 1180px\)/);
  assert.match(caseBlock, /@media \(max-width: 720px\)/);
  const blocks = [...caseBlock.matchAll(/@media \(max-width: \d+px\) \{([\s\S]*?)\n\}/g)];
  assert.ok(blocks.length >= 2);
  for (const [, body] of blocks) {
    assert.doesNotMatch(
      body,
      /display:\s*none/,
      "responsive rules must reflow, never hide, evidence/custody content",
    );
  }
});

test("RTL is handled with logical properties + bidi isolation for identifiers", () => {
  const caseBlock = CASES_CSS.slice(CASES_CSS.indexOf("CASE DETAILS — page presentation"));
  // No physical inline-direction property anywhere in the Case Details block.
  const physical = caseBlock.split("\n").filter((l) =>
    /^\s*(left|right|margin-left|margin-right|padding-left|padding-right|border-left|border-right)\s*:/.test(l),
  );
  assert.deepEqual(physical, [], `physical direction properties in Case Details CSS: ${physical.join(" | ")}`);
  assert.match(caseBlock, /unicode-bidi: plaintext/);
  assert.match(
    caseBlock,
    /\.case-detail-row-meta-id \{[\s\S]{0,200}?direction: ltr;/,
  );
  assert.match(caseBlock, /border-inline-start: 4px solid/);
});

test("status labels stay display-only and cover every case status", () => {
  // ONE status pill app-wide: `.app-status-badge[data-tone]`. The per-domain
  // `.case-status-badge[data-status]` colour table was DELETED, and the
  // status -> tone mapping now lives in TypeScript so a single badge
  // definition can serve every surface.
  assert.doesNotMatch(CASES_CSS, /\.case-status-badge\b/);
  assert.match(PRIMITIVES_CSS, /^\.app-status-badge \{/m);
  assert.match(
    SIMPLE_DETAIL,
    /className="app-status-badge"\s*\n\s*data-tone=\{caseStatusTone\(caseDetail\.status\)\}/,
  );
  // Every status still resolves to a defined tone, and every tone the map can
  // return is actually painted by the canonical badge.
  const tones = new Set();
  const block = fnBody(HELPERS, "caseStatusTone");
  for (const s of ["OPEN", "INVESTIGATING", "ON_HOLD", "RESOLVED", "CLOSED", "ARCHIVED"]) {
    assert.ok(
      block.includes(`case "${s}"`) || block.includes("default:"),
      `status ${s} has no tone`,
    );
  }
  for (const m of block.matchAll(/return "([a-z]+)"/g)) tones.add(m[1]);
  assert.ok(tones.size >= 3, "expected a real tone spread");
  for (const t of tones) {
    assert.ok(
      PRIMITIVES_CSS.includes(`.app-status-badge[data-tone="${t}"]`),
      `tone ${t} is returned but the canonical badge does not define it`,
    );
  }
  // It must not participate in transition logic or any write path.
  assert.doesNotMatch(block, /apiFetch|ALLOWED_STATUS_TRANSITIONS/);
  // The canonical status list and transition mirror are untouched.
  assert.match(HELPERS, /export const CASE_STATUS_OPTIONS/);
  assert.match(HELPERS, /export const ALLOWED_STATUS_TRANSITIONS/);
});
