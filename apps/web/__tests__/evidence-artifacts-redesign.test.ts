/**
 * Evidence Detail — Artifacts tab redesign.
 *
 * Artifacts is the tab that hands material to the outside world, so the
 * failure modes that matter are offering a download that cannot succeed, and
 * reporting public activity the platform cannot actually see. Both were real
 * defects in the previous build and both are pinned here:
 *
 *   - "Download latest" used to enable on a NON-EMPTY HISTORY. A record can
 *     carry prior versions while the current artifact is pending, failed,
 *     unavailable or excluded by plan, so the control could offer a download
 *     that would fail. It now derives from `artifactStatus`.
 *
 *   - Public-verification counters were stringified unconditionally, so a
 *     workspace with no analytics read as "0 views" — indistinguishable from
 *     a record nobody had opened. They now honour `analyticsAvailable`.
 *
 * Reports and verification packages are different materials and must never be
 * merged into one list.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const WEB = resolve(REPO_ROOT, "apps/web");
const read = (p: string) => readFileSync(resolve(WEB, p), "utf8");

/** Prose is not code: "must not survive" checks run on comment-free source. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const TAB = read("app/(app)/evidence/[id]/_tabs/EvidenceArtifactsTab.tsx");
const TAB_CODE = code(TAB);
const HISTORY = read("app/(app)/evidence/[id]/components/ArtifactHistorySection.tsx");
const HISTORY_CODE = code(HISTORY);
const RAIL = read("app/(app)/evidence/[id]/_tabs/EvidenceRecordRail.tsx");
const PAGE = read("app/(app)/evidence/[id]/page.tsx");
const CSS = read("app/(app)/evidence/[id]/evidence-detail.css");

// ---------------------------------------------------------------------------
// A) Download gating is data-derived, not list-derived
// ---------------------------------------------------------------------------

test("availability comes from artifactStatus, never from history length", () => {
  assert.match(TAB, /const reportDownloadable = reportStatus\.available === true/);
  assert.match(TAB, /const packageDownloadable = packageStatus\.available === true/);
  // The old bug in one line: enabling on a non-empty array.
  assert.doesNotMatch(HISTORY_CODE, /disabled=\{[^}]*reports\.length === 0/);
  assert.doesNotMatch(HISTORY_CODE, /disabled=\{[^}]*packages\.length === 0/);
});

test("the download control disables and carries the reason", () => {
  assert.match(HISTORY, /const disabled = extraDisabled \|\| !downloadable/);
  assert.match(HISTORY, /disabled=\{disabled\}/);
  assert.match(HISTORY, /aria-disabled=\{disabled\}/);
  assert.match(HISTORY, /aria-describedby=\{disabled && disabledReason \? `\$\{testid\}-reason` : undefined\}/);
  // The reason is rendered as TEXT, not only as a title attribute.
  assert.match(HISTORY, /id=\{`\$\{testid\}-reason`\}/);
  assert.match(HISTORY, /data-evidence-artifact-reason=\{testid\}/);
});

test("every blocked artifact state produces its own reason", () => {
  for (const reason of [
    /The report is still being generated/,
    /Report PDFs are not included in the current plan/,
    /No report has been generated for this record yet/,
    /The verification package is still being generated/,
    /blocked by an export-governance gate/,
    /Verification packages are not included in the current plan/,
    /No verification package has been generated for this record yet/,
  ]) {
    assert.match(TAB, reason);
  }
  // Server-supplied reasons win over our fallbacks.
  assert.match(TAB, /packageStatus\.blockedReason \?\?/);
  assert.match(TAB, /packageStatus\.unavailableReason \?\?/);
});

test("the export-governance preflight still wraps both downloads", () => {
  assert.match(HISTORY, /<GovernedExportAction/);
  assert.match(HISTORY, /actionLabel="Download Report PDF"/);
  assert.match(HISTORY, /actionLabel="Download Verification Package ZIP"/);
  // A governance block composes WITH the availability gate, never replaces it.
  assert.match(HISTORY, /renderAction=\{\(\{ disabled, onClick \}\) => downloadButton\(disabled, onClick\)\}/);
});

// ---------------------------------------------------------------------------
// B) The two artifact families stay separate
// ---------------------------------------------------------------------------

test("reports and packages render as two independent families", () => {
  const families = HISTORY.match(/<ArtifactFamilyCard/g) ?? [];
  assert.equal(families.length, 2, `expected 2 families, got ${families.length}`);
  assert.match(HISTORY, /testid="report"/);
  assert.match(HISTORY, /testid="package"/);
  assert.match(HISTORY, /versions=\{reports\}/);
  assert.match(HISTORY, /versions=\{packages\}/);
});

test("the two histories are never concatenated", () => {
  assert.doesNotMatch(HISTORY_CODE, /reports\s*\.concat\(/);
  assert.doesNotMatch(HISTORY_CODE, /\[\s*\.\.\.reports\s*,\s*\.\.\.packages\s*\]/);
  assert.doesNotMatch(HISTORY_CODE, /\[\s*\.\.\.packages\s*,\s*\.\.\.reports\s*\]/);
});

test("each family gets its own accessible download name", () => {
  assert.match(HISTORY, /aria-label=\{`Download latest \$\{title\}`\}/);
});

// ---------------------------------------------------------------------------
// C) Version metadata is truthful
// ---------------------------------------------------------------------------

test("version rows render the real fields, from the real formatters", () => {
  assert.match(HISTORY, /v\{item\.version\}/);
  assert.match(HISTORY, /\{formatDateTime\(item\.generatedAtUtc\)\}/);
  assert.match(HISTORY, /\{formatBytes\(item\.sizeBytes\)\}/);
  assert.match(HISTORY, /\(item as PackageVersion\)\.packageType \|\| "Package type not recorded"/);
});

test("immutable-recorded renders ONLY when the backend recorded it", () => {
  assert.match(HISTORY, /\{item\.immutableRecorded \? \(/);
  // Never asserted by default, and never negated into a claim.
  assert.doesNotMatch(HISTORY_CODE, /immutableRecorded \?\?\s*true/);
  assert.doesNotMatch(HISTORY_CODE, /Not immutable/);
});

test("the latest marker comes from the record, not from list position", () => {
  assert.match(HISTORY, /\{item\.latest \? \(/);
  assert.match(HISTORY, /data-evidence-artifact-latest=\{item\.latest \? "true" : "false"\}/);
  assert.doesNotMatch(HISTORY_CODE, /index === 0 \? "Latest"/);
});

test("no version marker relies on colour alone", () => {
  // "Latest" and "Immutable recorded" are text on the meta line; if a future
  // change makes them chips, the text must still be present.
  assert.match(HISTORY, />\s*Latest\s*<\/span>/);
  assert.match(HISTORY, />\s*Immutable recorded\s*<\/span>/);
});

// ---------------------------------------------------------------------------
// D) Public-verification metrics: zero is not unavailable
// ---------------------------------------------------------------------------

test("counters honour analyticsAvailable", () => {
  assert.match(
    TAB,
    /const counter = \(value: number\): string =>\s*\n?\s*summary\.analyticsAvailable \? String\(value\) : "Not available"/,
  );
  for (const field of [
    "publicViewCount",
    "reportDownloadCount",
    "verificationPackageDownloadCount",
  ]) {
    assert.match(TAB, new RegExp(`counter\\(summary\\.${field}\\)`));
  }
  // The old unconditional stringification must not survive.
  assert.doesNotMatch(TAB_CODE, /String\(workspace\.publicVerificationSummary\.\w+Count\)/);
});

test("a real zero still renders as 0", () => {
  // String(0) === "0" — the branch is taken on analyticsAvailable, not on the
  // value, so a genuine zero can never be swallowed by a falsy check.
  assert.doesNotMatch(TAB_CODE, /summary\.publicViewCount \|\|/);
  assert.doesNotMatch(TAB_CODE, /summary\.reportDownloadCount \?\?\s*"/);
});

test("an absent last-view timestamp is 'Not recorded', not a fabricated date", () => {
  assert.match(TAB, /formatValue\(formatUserDateTime\(summary\.lastPublicViewAt\)\)/);
});

// ---------------------------------------------------------------------------
// E) The verification link is real, or absent
// ---------------------------------------------------------------------------

test("the link renders only from a real shareUrl", () => {
  assert.match(TAB, /\{shareUrl \? \(/);
  assert.match(TAB, /href=\{shareUrl\}/);
  // No synthesised path, no guessed origin.
  assert.doesNotMatch(TAB_CODE, /href="\/verify/);
  assert.doesNotMatch(TAB_CODE, /`\$\{.*\}\/verify\//);
});

test("an external link is opened safely", () => {
  assert.match(TAB, /target="_blank"/);
  assert.match(TAB, /rel="noreferrer noopener"/);
});

test("without a link the card shows the state and its reason", () => {
  assert.match(TAB, /data-evidence-verify-unavailable/);
  assert.match(TAB, /\{publicVerificationState\?\.label \?\? "Not available"\}/);
  assert.match(TAB, /\{!shareUrl && publicVerificationState\?\.detail \? \(/);
});

// ---------------------------------------------------------------------------
// F) Tab and rail cannot contradict each other
// ---------------------------------------------------------------------------

test("both surfaces read the same publication projection", () => {
  // The tab renders the label from describePublicVerificationState(summary);
  // the rail tones from the same summary.state. One source, two renderings.
  assert.match(PAGE, /describePublicVerificationState\(workspace\.publicVerificationSummary\)/);
  assert.match(TAB, /publicVerificationState\?\.label/);
  assert.match(RAIL, /getPublicVerificationTone\(\s*\n?\s*workspace\.publicVerificationSummary\.state,?\s*\n?\s*\)/);
  assert.match(PAGE, /publicVerificationLabel=\{\s*\n?\s*publicVerificationState\?\.label \?\? "State unavailable"\s*\n?\s*\}/);
  // Neither surface derives publication state from anything else.
  assert.doesNotMatch(TAB_CODE, /artifactStatus[\s\S]{0,40}published/i);
});

test("the rail is reused once and Artifacts does not fork it", () => {
  const mounts = PAGE.match(/<EvidenceRecordRail\b/g) ?? [];
  assert.equal(mounts.length, 1);
  assert.doesNotMatch(TAB, /evidence-detail-sidebar|EvidenceRecordRail/);
  const headings = [...RAIL.matchAll(/className="evidence-detail-rail-heading">([^<]+)</g)].map(
    (m) => m[1],
  );
  assert.deepEqual(headings, [
    "Risk Signals",
    "Review Workflow",
    "Attributes",
    "Public Verification",
  ]);
});

// ---------------------------------------------------------------------------
// G) One implementation, no leftovers
// ---------------------------------------------------------------------------

test("Personal and Enterprise render the same Artifacts component", () => {
  assert.doesNotMatch(TAB_CODE, /workspaceKind|isPersonal|orgKind/i);
  assert.match(PAGE, /activeTab === "artifacts" \? <EvidenceArtifactsTab ctx=\{ctx\} \/> : null/);
  // Plan differences are expressed as truthful reasons, not a second layout.
  assert.match(TAB, /workspaceCaps\?\.reportsIncluded !== false/);
  assert.match(TAB, /workspaceCaps\?\.verificationPackageIncluded !== false/);
});

test("no legacy primitive, inline palette or italic survives in the Artifacts surfaces", () => {
  for (const [label, src] of [
    ["Artifacts tab", TAB_CODE],
    ["Artifact history", HISTORY_CODE],
  ] as const) {
    assert.doesNotMatch(src, /from "[^"]*components\/ui"/, `${label}: legacy ui import`);
    assert.doesNotMatch(src, /<Button\b/, `${label}: legacy Button`);
    assert.doesNotMatch(src, /style=\{\{/, `${label}: inline style object`);
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b/, `${label}: inline hex`);
    assert.doesNotMatch(src, /teal/i, `${label}: legacy teal`);
    assert.doesNotMatch(src, /<em>|<i>|font-style:\s*italic/, `${label}: italic`);
  }
});

test("the superseded artifact markup is gone", () => {
  for (const legacy of [
    "evidence-detail-card-header",
    "evidence-detail-data-grid",
    "evidence-detail-data-cell",
    "evidence-detail-related-card",
    "evidence-detail-related-list",
    "evidence-detail-item-row",
    "KeyValueGrid",
    "SectionHeading",
  ]) {
    for (const [label, src] of [
      ["Artifacts tab", TAB_CODE],
      ["Artifact history", HISTORY_CODE],
    ] as const) {
      assert.doesNotMatch(
        src,
        new RegExp(legacy.replace(/-/g, "\\-")),
        `${legacy} must not survive in ${label}`,
      );
    }
  }
});

test("the artifact card anatomy is one definition shared by both families", () => {
  // Both cards come from the SAME component, so their anatomy cannot drift.
  assert.match(HISTORY, /function ArtifactFamilyCard\(/);
  const definitions = HISTORY.match(/className="evidence-detail-artifact-card__head"/g) ?? [];
  assert.equal(definitions.length, 1, "the head must be defined once");
});

test("the tab uses logical layout so it mirrors in RTL", () => {
  const artifactsCss = CSS.slice(CSS.indexOf(".evidence-detail-verify-card"));
  assert.doesNotMatch(artifactsCss, /margin-left:|margin-right:|float:/);
  assert.doesNotMatch(artifactsCss, /\btext-align:\s*(left|right)\b/);
  // The bidi scope sits on the VALUE, not on the box that also draws the
  // separator — otherwise the separator lands on the wrong side in Arabic.
  assert.match(
    CSS,
    /\.evidence-detail-artifact-version__text\s*\{[\s\S]{0,80}unicode-bidi:\s*plaintext/,
  );
});
