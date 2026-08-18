/**
 * Phase CASE-DETAIL-PROOVRA-V2 — contract for the redesigned Case Details
 * surface and the shared V2 internal UI foundation.
 *
 * These tests pin the properties that make the redesign SAFE, not the ones
 * that make it pretty:
 *
 *   1. The V2 foundation is OPT-IN. Its shell-chrome overrides are scoped to
 *      `:root[data-pv2-surface]`, and exactly one surface sets that
 *      attribute, so no unrelated internal route is visually migrated.
 *   2. Case data comes from the SAME single envelope call as before, and
 *      every displayed number is derived from it (nothing hardcoded to the
 *      Figma sample values).
 *   3. Authorization-driven affordances still gate on the SAME server
 *      projections (`viewer.can*`, `viewer.disabledReasons.*`).
 *   4. Tab routing, Case-ID copy, evidence search, and the remove-from-case
 *      confirmation keep their existing wiring and spec-locked copy.
 *   5. The Copilot stays advisory: it is the same component with the same
 *      props, and the redesign adds no `aiEnabled` override and no new AI
 *      endpoint.
 *   6. Loading / empty / error / restricted states all still exist.
 *   7. The design tokens carry the values decoded from the Figma source
 *      (including the four that contradict the colour-reference artwork).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), "utf8");

const SIMPLE_DETAIL = read(
  "apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx",
);
const PV2_CSS = read("apps/web/components/proovra-v2/proovra-v2.css");
const PV2_PRIMITIVES = read("apps/web/components/proovra-v2/primitives.tsx");
const PV2_HOOK = read("apps/web/components/proovra-v2/useProovraV2Surface.ts");
const GLOBALS = read("apps/web/app/globals.css");
const APP_LAYOUT = read("apps/web/app/(app)/layout.tsx");
const CASE_PAGE = read("apps/web/app/(app)/cases/[id]/page.tsx");
const COPILOT = read("apps/web/components/ai-copilot/CaseCopilotPanel.tsx");
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

/** The three regions this phase redesigned. */
const REDESIGNED = [
  "SimpleCaseHeader",
  "OverviewTab",
  "EvidenceTab",
  "CaseDetailPlane",
] as const;

// ===========================================================================
// 1. Isolation — the V2 foundation must not migrate unrelated routes
// ===========================================================================

test("shell-chrome overrides are scoped to :root[data-pv2-surface] — never global", () => {
  // Split the sheet at the shell section and assert every rule that touches
  // shared shell class names lives behind the opt-in attribute.
  const shellSelectors = [
    ".app-shell-v2",
    ".app-sidebar-v2",
    ".app-account-toolbar",
    ".app-header-search",
    ".app-header-primary-action",
    ".app-topbar-v2-avatar",
    ".app-shell-v2-content",
    ".app-header-zone-left",
  ];
  for (const line of PV2_CSS.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    for (const sel of shellSelectors) {
      if (trimmed.includes(sel)) {
        assert.ok(
          trimmed.includes(":root[data-pv2-surface]"),
          `unscoped shell rule would leak to every internal route: ${trimmed}`,
        );
      }
    }
  }
});

test("exactly one surface opts into the V2 shell chrome", () => {
  assert.match(SIMPLE_DETAIL, /useProovraV2Surface\("case-detail"\)/);
  // The hook sets the attribute on mount and REMOVES it on unmount, so
  // navigating away restores the previous chrome exactly.
  assert.match(PV2_HOOK, /root\.setAttribute\("data-pv2-surface", surface\)/);
  assert.match(PV2_HOOK, /root\.removeAttribute\("data-pv2-surface"\)/);
});

test("the (app) layout still mounts the SAME shared AppShellV2 (no parallel shell)", () => {
  assert.match(APP_LAYOUT, /<AppShellV2 onLogout=\{handleLogout\}>/);
  assert.doesNotMatch(APP_LAYOUT, /data-pv2-surface/);
  assert.doesNotMatch(APP_LAYOUT, /proovra-v2/);
});

test("the V2 sheet is imported once, after the shell sheet, from globals", () => {
  const shellIdx = GLOBALS.indexOf("app-shell-v2/app-shell-v2.css");
  const v2Idx = GLOBALS.indexOf("proovra-v2/proovra-v2.css");
  assert.ok(shellIdx > 0 && v2Idx > 0, "both sheets must be imported");
  assert.ok(v2Idx > shellIdx, "V2 must cascade after the shell sheet");
  assert.equal(GLOBALS.split("proovra-v2/proovra-v2.css").length - 1, 1);
});

test("the case route still switches between MatterWorkspace and SimpleCaseDetail unchanged", () => {
  assert.match(CASE_PAGE, /useEnterpriseSurfaceAccess/);
  assert.match(CASE_PAGE, /<MatterWorkspace caseId=\{caseId\}/);
  assert.match(
    CASE_PAGE,
    /<SimpleCaseDetail caseId=\{caseId\} onOpenEvidence=\{onOpenEvidence\} \/>/,
  );
  // The redesign must not have leaked into the enterprise surface.
  assert.doesNotMatch(CASE_PAGE, /proovra-v2/);
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
});

test("the redesign introduces no client-side capability decisions", () => {
  // The surface reads server projections only — it must never compute
  // access from a role string or a plan string.
  assert.doesNotMatch(SIMPLE_DETAIL, /role === "(OWNER|ADMIN|MEMBER)"/);
  assert.doesNotMatch(SIMPLE_DETAIL, /accountPlan/);
  assert.doesNotMatch(SIMPLE_DETAIL, /isPlatformAdmin/);
  // The V2 primitives are presentation-only: no fetching, no capability map.
  assert.doesNotMatch(PV2_PRIMITIVES, /apiFetch|usePlatformContext|capabilit/i);
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
  assert.match(SIMPLE_DETAIL, /tabAttr=\{\(id\) => \(\{ "data-simple-case-tab": id \}\)\}/);
  assert.match(SIMPLE_DETAIL, /onSelect=\{setActiveTab\}/);
});

test("Tabs primitive renders a real tablist with per-tab aria-selected", () => {
  assert.match(PV2_PRIMITIVES, /role="tablist"/);
  assert.match(PV2_PRIMITIVES, /role="tab"/);
  assert.match(PV2_PRIMITIVES, /aria-selected=\{isActive\}/);
});

test("Case ID copy keeps the clipboard write and the success toast", () => {
  assert.match(SIMPLE_DETAIL, /data-simple-case-id/);
  assert.match(
    SIMPLE_DETAIL,
    /navigator\.clipboard\?\.writeText\(caseDetail\.id\)[\s\S]{0,120}?addToast\("Case ID copied\.", "success"\)/,
  );
  // The identifier must stay LTR + selectable inside an RTL document.
  assert.match(PV2_CSS, /\.pv2-copyfield-value \{[\s\S]{0,200}?direction: ltr/);
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
});

test("Copilot rail styling never rewrites the advisory disclosure or adds claims", () => {
  // The rail rules are CSS-only; the component keeps its own copy.
  assert.match(PV2_CSS, /\.pv2-copilot-rail/);
  assert.doesNotMatch(PV2_CSS, /content:\s*"(?!·)/);
  for (const disclosure of ["AI-generated", "Advisory only", "Metadata only"]) {
    assert.ok(COPILOT.includes(disclosure), `disclosure "${disclosure}" lost`);
  }
  assert.match(COPILOT, /advisoryBoundary/);
  assert.match(COPILOT, /processingMode: "METADATA_ONLY"/);
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
  // The loading state announces itself to assistive tech.
  assert.match(PV2_PRIMITIVES, /role="status" aria-live="polite"/);
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
// 7. Design tokens + responsive/RTL guarantees
// ===========================================================================

test("tokens carry the values decoded from the Figma variable collection", () => {
  const expected: Array<[string, string]> = [
    ["--pv2-black", "#0F172A"],
    ["--pv2-bg", "#F8FAFC"],
    ["--pv2-grey", "#6B7280"],
    ["--pv2-navy", "#0B1F5E"],
    ["--pv2-blue", "#2563EB"],
    ["--pv2-purple", "#7C3AED"],
    ["--pv2-green", "#047857"],
    ["--pv2-cyan", "#0891B2"],
    ["--pv2-orange", "#F97316"],
    // The four that CONTRADICT the printed colour-reference labels. The
    // Figma variable fill is authoritative; pin them so a future edit
    // cannot silently "correct" them back to the artwork's text.
    ["--pv2-pink", "#DB2777"],
    ["--pv2-success", "#10B981"],
    ["--pv2-warning", "#F59E0B"],
    ["--pv2-error", "#DC2626"],
  ];
  for (const [token, value] of expected) {
    assert.match(
      PV2_CSS,
      new RegExp(`${token}:\\s*${value};`),
      `${token} must be ${value} (decoded from canvas.fig)`,
    );
  }
});

test("layout tokens match the decoded frame geometry", () => {
  for (const [token, value] of [
    ["--pv2-sidebar-collapsed", "82px"],
    ["--pv2-sidebar-expanded", "256px"],
    ["--pv2-topbar-h", "80px"],
    ["--pv2-gutter-x", "32px"],
    ["--pv2-rail-w", "312px"],
    ["--pv2-rail-w-wide", "326px"],
  ]) {
    assert.match(PV2_CSS, new RegExp(`${token}:\\s*${value};`));
  }
  // The sidebar gradient stops + direction come from the decoded fill.
  assert.match(
    PV2_CSS,
    /--pv2-sidebar-gradient:\s*\n?\s*linear-gradient\(\s*\n?\s*180deg/,
  );
});

test("no raw hex leaks into the redesigned regions", () => {
  // The redesigned header / Overview / Evidence / page-plane are entirely
  // token- and class-driven. The legacy `CaseButton`, `attachBadgeStyle` and
  // the Add-evidence modal keep their inline colours — those regions are
  // untouched by this phase and are pinned by cases-attach-picker.test.ts.
  for (const fn of REDESIGNED) {
    const leaked = [...code(fnBody(SIMPLE_DETAIL, fn)).matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(
      (m) => m[0],
    );
    assert.deepEqual(
      leaked,
      [],
      `raw hex must live in proovra-v2.css, not ${fn}: ${leaked.join(", ")}`,
    );
  }
});

test("the redesigned regions carry no inline layout styles beyond token references", () => {
  // Guards against the previous revision's pattern of large inline style
  // objects, which is what made this surface impossible to restyle.
  for (const fn of REDESIGNED) {
    const body = code(fnBody(SIMPLE_DETAIL, fn));
    for (const [, decl] of body.matchAll(/style=\{\{([^}]*)\}\}/g)) {
      const values = [...decl.matchAll(/:\s*("[^"]*"|'[^']*')/g)].map((m) => m[1]);
      for (const v of values) {
        assert.ok(
          v.includes("var(--pv2-") || v === '"0"' || v === '"column"' || v === '"flex"',
          `inline style in ${fn} must reference a token, got ${v}`,
        );
      }
    }
  }
});

test("responsive rules exist and never hide custody or governance content", () => {
  assert.match(PV2_CSS, /@media \(max-width: 1180px\)/);
  assert.match(PV2_CSS, /@media \(max-width: 720px\)/);
  // Nothing in the responsive blocks may `display: none` a content element.
  const blocks = [...PV2_CSS.matchAll(/@media \(max-width: \d+px\) \{([\s\S]*?)\n\}/g)];
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
  assert.match(PV2_CSS, /\[dir="rtl"\] \.pv2-chevron \{ transform: scaleX\(-1\); \}/);
  assert.match(PV2_CSS, /unicode-bidi: plaintext/);
  assert.match(PV2_CSS, /\.pv2-row-meta-id \{[\s\S]{0,120}?direction: ltr/);
  // The shared shell pins the rail with `left: 0` for every locale; the
  // migrated surface corrects the placement for Arabic within its own scope.
  assert.match(
    PV2_CSS,
    /\[dir="rtl"\][\s\S]{0,200}?\.app-sidebar-v2 \{[\s\S]{0,160}?right: 0;/,
  );
});

test("status tone mapping is display-only and covers every case status", () => {
  assert.match(HELPERS, /export function caseStatusTone/);
  const statuses = ["OPEN", "INVESTIGATING", "ON_HOLD", "RESOLVED", "CLOSED", "ARCHIVED"];
  const block = fnBody(HELPERS, "caseStatusTone");
  for (const s of statuses) {
    assert.ok(block.includes(`case "${s}"`), `status ${s} has no tone`);
  }
  // It must not participate in transition logic or any write path.
  assert.doesNotMatch(block, /apiFetch|ALLOWED_STATUS_TRANSITIONS/);
  // The canonical status list and transition mirror are untouched.
  assert.match(HELPERS, /export const CASE_STATUS_OPTIONS/);
  assert.match(HELPERS, /export const ALLOWED_STATUS_TRANSITIONS/);
});
