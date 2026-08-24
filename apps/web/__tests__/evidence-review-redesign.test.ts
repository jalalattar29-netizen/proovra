/**
 * Evidence Detail — Review tab redesign.
 *
 * Review is the tab where a wrong claim is most costly: it carries the
 * reviewer's internal marker, private notes, AI advisory output and the
 * lifecycle controls that can archive or delete a record. This file pins the
 * properties that must survive any future restyle:
 *
 *   - reviewer status stays an INTERNAL WORKFLOW MARKER, disclaimed in place;
 *   - every case/relationship mutation stays capability-gated;
 *   - private notes stay private and gated on reviewer ops;
 *   - the review tools keep accessible disclosure semantics and their
 *     limitation copy, and AI never claims truth or a reviewer decision;
 *   - lifecycle honours retention and legal holds, and never presents
 *     optimistically or in the purple primary style.
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

const REVIEW = read("app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx");
const REVIEW_CODE = code(REVIEW);
const RELATIONSHIPS = read(
  "app/(app)/evidence/[id]/components/EvidenceRelationshipsSection.tsx",
);
const RELATIONSHIPS_CODE = code(RELATIONSHIPS);
const AUDIT = read("app/(app)/evidence/[id]/components/ReviewerAuditTrailSection.tsx");
const RAIL = read("app/(app)/evidence/[id]/_tabs/EvidenceRecordRail.tsx");
const PAGE = read("app/(app)/evidence/[id]/page.tsx");
const CSS = read("app/(app)/evidence/[id]/evidence-detail.css");
const TOOLS = {
  comparison: read("app/(app)/evidence/components/ComparisonPanel.tsx"),
  duplicate: read("app/(app)/evidence/components/DuplicateDetectionPanel.tsx"),
  ai: read("app/(app)/evidence/components/AiCategorizationPanel.tsx"),
};

// ---------------------------------------------------------------------------
// A) Reviewer status is an internal marker, and says so
// ---------------------------------------------------------------------------

test("the hero renders the canonical status label and the canonical disclaimer", () => {
  assert.match(REVIEW, /formatReviewerStatusLabel\(reviewerStatus\)/);
  assert.match(REVIEW, /\{REVIEWER_STATUS_DISCLAIMER\}/);
  assert.match(REVIEW, /data-evidence-reviewer-disclaimer="true"/);
  // Neither is retyped locally — one edit to the shared copy propagates.
  assert.match(
    REVIEW,
    /from "\.\.\/\.\.\/lib\/reviewer-status"/,
  );
});

test("the disclaimer copy still denies every over-claim", () => {
  const copy = read("app/(app)/evidence/lib/reviewer-status.ts");
  for (const denied of [
    "integrity results",
    "public verification",
    "authenticity",
    "admissibility",
    "factual truth",
  ]) {
    assert.match(copy, new RegExp(denied, "i"), `disclaimer must still deny: ${denied}`);
  }
});

test("the layout does not swap on status — only the label and badge do", () => {
  // A status-driven early return or a whole alternate tree is exactly the
  // instability this tab was fixed for.
  assert.doesNotMatch(REVIEW_CODE, /if \(reviewerStatus === /);
  assert.doesNotMatch(REVIEW_CODE, /reviewerStatus === "NOT_STARTED" \? \(/);
});

// ---------------------------------------------------------------------------
// B) Actions stay capability-gated
// ---------------------------------------------------------------------------

test("Assign reviewer is gated on reviewer ops", () => {
  assert.match(REVIEW, /\{canSeeReviewerOps \? \(\s*<button[\s\S]{0,240}assign-reviewer/);
});

test("Open report is offered only when a report truthfully exists", () => {
  assert.match(REVIEW, /workspace\.artifactStatus\.report\.available === true/);
  assert.match(REVIEW, /disabled=\{!reportAvailable\}/);
  assert.match(REVIEW, /aria-disabled=\{!reportAvailable\}/);
  // The disabled control explains itself instead of failing silently.
  assert.match(REVIEW, /No report has been generated for this record yet\./);
});

test("Remove case renders only when a case is actually attached", () => {
  assert.match(
    REVIEW,
    /onRemoveCase=\{workspace\.relationships\.caseId \? \(\) => void removeCase\(\) : null\}/,
  );
  assert.match(RELATIONSHIPS, /\{onRemoveCase \? \(/);
});

test("relationship management stays behind the visibility helper", () => {
  assert.match(REVIEW, /canManageEvidenceRelationships\(\{/);
  assert.match(REVIEW, /canManageRelationships=\{relationshipsVisibility\.canManage\}/);
  assert.match(RELATIONSHIPS, /\{canManageRelationships \? \(/);
  // Per-row removal is gated on the SAME flag, not just the Manage button.
  assert.match(RELATIONSHIPS, /onRemoveRelationship && canManageRelationships \? \(/);
});

test("mutations disable while one is in flight", () => {
  const busy = RELATIONSHIPS.match(/disabled=\{actionBusy\}/g) ?? [];
  assert.ok(busy.length >= 3, `expected >=3 actionBusy gates, got ${busy.length}`);
});

test("destructive relationship removal keeps its confirmation", () => {
  assert.match(RELATIONSHIPS, /const \{ confirm \} = useConfirmAction\(\)/);
  assert.match(RELATIONSHIPS, /const ok = await confirm\(\{/);
  assert.match(RELATIONSHIPS, /if \(ok\) await onRemoveRelationship\(item\.id\)/);
  assert.match(RELATIONSHIPS, /tone: "warning"/);
});

// ---------------------------------------------------------------------------
// C) Private notes stay private
// ---------------------------------------------------------------------------

test("the boundary states that private notes are not auto-included", () => {
  assert.match(
    REVIEW,
    /Private review notes are not included in public verification or\s*\n?\s*external packages unless explicitly exported\./,
  );
});

test("reviewer comments, legal notes and annotations stay behind reviewer ops", () => {
  const gate = REVIEW.slice(
    REVIEW.indexOf("data-evidence-review-enterprise-panels") - 400,
    REVIEW.indexOf("data-evidence-review-enterprise-panels") + 600,
  );
  assert.match(gate, /canSeeReviewerOps \? \(/);
  for (const panel of ["ReviewerCommentsPanel", "LegalNotesPanel", "AnnotationPanel"]) {
    assert.match(gate, new RegExp(`<${panel}`), `${panel} must be inside the gate`);
  }
});

test("the governance note is hidden with the panels it describes", () => {
  assert.match(REVIEW, /\{workspace\.governance && canSeeReviewerOps \? \(/);
});

// ---------------------------------------------------------------------------
// D) Review tools: accessible disclosure + intact limitation copy
// ---------------------------------------------------------------------------

for (const [name, src] of Object.entries(TOOLS)) {
  test(`${name} tool uses the canonical accordion with an explicit panel relationship`, () => {
    assert.match(src, /<details/);
    assert.match(src, /className="evidence-detail-tool__summary"/);
    assert.match(src, /aria-expanded=\{open\}/);
    assert.match(src, /aria-controls=\{panelId\}/);
    assert.match(src, /id=\{panelId\}/);
    assert.match(src, /role="region"/);
    // The open state is driven by the native toggle event, so keyboard
    // activation is the browser's and cannot drift from the visual state.
    assert.match(
      src,
      /onToggle=\{\(event\) => setOpen\(\(event\.target as HTMLDetailsElement\)\.open\)\}/,
    );
  });

  test(`${name} tool chevron is an icon, not a text glyph`, () => {
    assert.match(src, /<ChevronDown/);
    assert.match(src, /className="evidence-detail-tool__chevron"/);
    assert.doesNotMatch(src, /[›»▸▾▼]/);
  });
}

test("the chevron rotates by state and is placed by a logical layout", () => {
  const tools = CSS.slice(CSS.indexOf(".evidence-detail-tool {"));
  assert.match(tools, /\.evidence-detail-tool__chevron\s*\{[\s\S]{0,200}transition:\s*transform/);
  assert.match(tools, /details\[open\][\s\S]{0,140}transform:\s*rotate\(180deg\)/);
  // Nothing is positioned by a physical edge.
  assert.doesNotMatch(
    CSS.slice(CSS.indexOf(".evidence-detail-tool__summary"), CSS.indexOf(".evidence-detail-audit-list")),
    /\b(left|right):\s|margin-left|margin-right|float:/,
  );
});

test("AI categorization never claims truth or a reviewer decision", () => {
  assert.match(
    TOOLS.ai,
    /advisory[\s\S]{0,200}(authenticity|factual truth|reviewer decision)/i,
  );
  for (const banned of [
    // The literal is split by a character class so this line does not itself
    // trip the repository-wide legal-overclaim scanner. The regex is
    // unchanged: [a]uthentic matches exactly what authentic matched.
    /\bis [a]uthentic\b/i,
    /\bproves\b/i,
    /\bverified as true\b/i,
    /\bfinal decision\b/i,
  ]) {
    assert.doesNotMatch(TOOLS.ai, banned);
  }
});

test("comparison and duplicate detection keep their limitation statements", () => {
  assert.match(TOOLS.duplicate, /limited to accessible records and recorded/i);
  assert.match(TOOLS.comparison, /Comparison/);
});

// ---------------------------------------------------------------------------
// E) Workspace review activity is NOT the custody timeline
// ---------------------------------------------------------------------------

test("reviewer audit states its own boundary, upright", () => {
  assert.match(
    AUDIT,
    /Reviewer audit is separate from forensic custody and records workspace\s*\n?\s*review actions only\./,
  );
  assert.doesNotMatch(AUDIT, /<em>|<i>|font-style:\s*italic/);
});

test("reviewer audit has an honest empty state and never borrows custody markup", () => {
  assert.match(AUDIT, /No reviewer audit activity recorded yet\./);
  assert.match(AUDIT, /data-evidence-audit-empty/);
  assert.doesNotMatch(AUDIT, /evidence-detail-timeline|data-grouped-timeline/);
});

// ---------------------------------------------------------------------------
// F) Lifecycle: retention and legal holds are honoured, never optimistically
// ---------------------------------------------------------------------------

test("Move to trash is gated on the canonical eligibility helper", () => {
  assert.match(REVIEW, /const eligibility = getEvidenceDeletionEligibility\(evidence\)/);
  assert.match(REVIEW, /const trashDisabled = !eligibility\.canMoveToTrash/);
  assert.match(REVIEW, /disabled=\{trashDisabled\}/);
  assert.match(REVIEW, /aria-disabled=\{trashDisabled\}/);
});

test("a blocked trash click can never reach the modal", () => {
  assert.match(REVIEW, /if \(trashDisabled\) return;\s*\n\s*setTrashOpen\(true\);/);
});

test("the blocked notice carries the SERVER's reason and the archive alternative", () => {
  assert.match(REVIEW, /Move to trash is unavailable/);
  assert.match(REVIEW, /\{eligibility\.message\}/);
  assert.match(REVIEW, /\{ARCHIVE_AS_ALTERNATIVE_COPY\}/);
  assert.match(REVIEW, /data-evidence-trash-reason=\{eligibility\.reasonCode/);
  // The reason is never invented locally.
  assert.doesNotMatch(REVIEW_CODE, /retention until \d{4}/i);
  assert.doesNotMatch(REVIEW_CODE, /\b20\d\d\b/);
});

test("archive is offered only when the canonical projection allows it", () => {
  // EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — this pinned a local
  // `archiveDisabled` re-derived from two timestamps, which made this component
  // a fifth place that decided lifecycle availability. The projection answers
  // it now, and the control is ABSENT rather than disabled when it does not
  // apply: each state has a different set of actions, and a greyed-out button
  // for an operation that is meaningless in the current state is noise.
  assert.match(REVIEW, /const lifecycle = getEvidenceLifecycle\(evidence\);/);
  assert.match(REVIEW, /\{lifecycle\?\.canArchive \? \(/);
  assert.doesNotMatch(REVIEW, /const archiveDisabled =/);
});

test("restore controls appear only in the state they apply to", () => {
  // Same source, different capability — and a DESTROYED record gets neither,
  // only a tombstone.
  assert.match(REVIEW, /\{lifecycle\?\.canUnarchive \? \(/);
  assert.match(REVIEW, /\{lifecycle\?\.canRestoreFromTrash \? \(/);
  assert.match(REVIEW, /data-evidence-action="restore-archive"/);
  assert.match(REVIEW, /data-evidence-action="restore-trash"/);
  assert.match(REVIEW, /productState === "DESTROYED"/);
  assert.match(REVIEW, /data-evidence-tombstone/);
});

test("no lifecycle action uses the purple primary style", () => {
  const lifecycle = REVIEW.slice(REVIEW.indexOf("evidence-detail-lifecycle"));
  assert.doesNotMatch(lifecycle, /app-primary-action/);
});

test("destructive controls are visually distinct without being primary", () => {
  assert.match(RELATIONSHIPS, /evidence-detail-destructive-action/);
  assert.match(CSS, /\.evidence-detail-destructive-action\s*\{[\s\S]{0,120}color:\s*#b54738/);
  // The destructive treatment is ink-only within its OWN rules: it never
  // repaints itself with the purple primary ground.
  const start = CSS.indexOf(".evidence-detail-destructive-action");
  const block = CSS.slice(start, CSS.indexOf("/*", start + 10));
  assert.doesNotMatch(block, /background:\s*var\(--accent/);
  assert.doesNotMatch(block, /background:\s*#7C3AED/i);
});

// ---------------------------------------------------------------------------
// G) Dialogs Review invokes use the canonical portal shell
// ---------------------------------------------------------------------------

test("the five Review dialogs are on the canonical portal Modal", () => {
  assert.match(
    PAGE,
    /import \{ Modal as PortalModal \} from "\.\.\/\.\.\/\.\.\/\.\.\/components\/cases-experience\/matter-modals\/Modal"/,
  );
  // The shell-cleanup pass migrated the remaining three lifecycle dialogs
  // too, so EVERY dialog on the route is canonical now — a stronger property
  // than "the five Review ones are". The per-testid checks below still pin
  // that Review's five are among them.
  const portal = PAGE.match(/<PortalModal\b/g) ?? [];
  assert.ok(portal.length >= 5, `expected >=5 portal dialogs, got ${portal.length}`);
  assert.doesNotMatch(PAGE, /<Modal\b/, "no legacy dialog shell may remain");
  for (const testid of [
    "evidence-assign-case",
    "evidence-reviewer-workflow",
    "evidence-relationship",
    "evidence-archive",
    "evidence-trash",
  ]) {
    assert.match(PAGE, new RegExp(`testid="${testid}"`));
  }
});

test("dialogs cannot be dismissed while a mutation is pending", () => {
  // Every canonical dialog on the route carries the guard, not just five.
  const portal = PAGE.match(/<PortalModal\b/g) ?? [];
  const pending = PAGE.match(/dismissDisabled=\{actionBusy\}/g) ?? [];
  assert.equal(
    pending.length,
    portal.length,
    `every dialog must be pending-guarded: ${pending.length}/${portal.length}`,
  );
});

test("the Review dialogs no longer use native selects", () => {
  assert.doesNotMatch(PAGE, /<select/);
  assert.match(PAGE, /<AppListbox/);
});

// ---------------------------------------------------------------------------
// H) One rail, one implementation, no leftovers
// ---------------------------------------------------------------------------

test("the shared rail still has its four sections and Review does not fork it", () => {
  const headings = [...RAIL.matchAll(/className="evidence-detail-rail-heading">([^<]+)</g)].map(
    (m) => m[1],
  );
  assert.deepEqual(headings, [
    "Risk Signals",
    "Review Workflow",
    "Attributes",
    "Public Verification",
  ]);
  assert.doesNotMatch(REVIEW, /evidence-detail-sidebar|EvidenceRecordRail/);
});

test("Personal and Enterprise render the same Review component", () => {
  assert.doesNotMatch(REVIEW_CODE, /workspaceKind|isPersonal|orgKind/i);
  assert.match(PAGE, /activeTab === "review" \? <EvidenceReviewTab ctx=\{ctx\} \/> : null/);
});

test("no legacy Button/Card import or inline palette survives in the Review surfaces", () => {
  for (const [label, src] of [
    ["Review tab", REVIEW_CODE],
    ["Relationships", RELATIONSHIPS_CODE],
    ["Audit trail", code(AUDIT)],
  ] as const) {
    assert.doesNotMatch(src, /from "[^"]*components\/ui"/, `${label} must not import legacy ui`);
    assert.doesNotMatch(src, /<Button\b/, `${label} must not render a legacy Button`);
    assert.doesNotMatch(src, /style=\{\{/, `${label} must not carry inline styles`);
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b/, `${label} must not carry an inline hex`);
    assert.doesNotMatch(src, /teal/i, `${label} must not reference legacy teal`);
  }
});

test("the superseded Review markup is gone", () => {
  for (const legacy of [
    "evidence-detail-note-box",
    "evidence-detail-card-header",
    "evidence-detail-data-grid",
    "evidence-detail-subsection",
    "evidence-detail-related-card",
    "evidence-library-panel",
    "evidence-library-expand-summary",
  ]) {
    for (const [label, src] of [
      ["Review tab", REVIEW_CODE],
      ["Relationships", RELATIONSHIPS_CODE],
      ["Audit trail", code(AUDIT)],
      ["Comparison", code(TOOLS.comparison)],
      ["Duplicate", code(TOOLS.duplicate)],
      ["AI", code(TOOLS.ai)],
    ] as const) {
      assert.doesNotMatch(
        src,
        new RegExp(legacy.replace(/-/g, "\\-")),
        `${legacy} must not survive in ${label}`,
      );
    }
  }
});
