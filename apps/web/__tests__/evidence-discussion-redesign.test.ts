/**
 * Evidence Detail — Discussion tab redesign.
 *
 * Discussion is the one tab where a user can WRITE, and where another user's
 * content is rendered back. The failure modes that matter are therefore:
 * offering a composer to someone who cannot post, letting a message inject
 * markup, and implying that a comment changes what was preserved about the
 * evidence. All three are pinned here.
 *
 * There was no Figma frame for this tab. It is system-derived, so these
 * assertions also pin that it uses the SAME shell, surfaces and state
 * language as the six tabs already accepted — not a private chat aesthetic.
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

const TAB = read("app/(app)/evidence/[id]/_tabs/EvidenceDiscussionTab.tsx");
const TAB_CODE = code(TAB);
const PANEL = read("app/(app)/evidence/[id]/components/EvidenceDiscussionPanel.tsx");
const PANEL_CODE = code(PANEL);
const RAIL = read("app/(app)/evidence/[id]/_tabs/EvidenceRecordRail.tsx");
const PAGE = read("app/(app)/evidence/[id]/page.tsx");
const CSS = read("app/(app)/evidence/[id]/evidence-detail.css");

// ---------------------------------------------------------------------------
// A) Capability gates fail closed
// ---------------------------------------------------------------------------

test("read-only is passed through from the capability snapshot, not inferred", () => {
  assert.match(TAB, /readOnly=\{workspaceCaps\?\.discussionReadOnly === true\}/);
  // `=== true` matters: an undefined capability must NOT become writable.
  assert.doesNotMatch(TAB_CODE, /discussionReadOnly \|\|/);
  assert.doesNotMatch(TAB_CODE, /!workspaceCaps\?\.discussionReadOnly/);
});

test("a read-only workspace gets NO composer at all — not a disabled one", () => {
  // The composer is replaced by an explanation, so the mode is unmistakable
  // and a submit can never be attempted.
  assert.match(PANEL, /\{readOnly \? \(/);
  assert.match(PANEL, /data-evidence-discussion-readonly-message-form-hidden/);
  const readOnlyBranch = PANEL.slice(
    PANEL.indexOf("data-evidence-discussion-readonly-message-form-hidden"),
    PANEL.indexOf("data-evidence-discussion-locked"),
  );
  assert.doesNotMatch(readOnlyBranch, /<textarea|<form/);
});

test("read-only is also stated at the top of the panel", () => {
  assert.match(PANEL, /data-evidence-discussion-readonly-banner/);
  assert.match(PANEL, /data-evidence-discussion-mode=\{readOnly \? "read-only" : "writable"\}/);
});

test("a resolved or closed thread cannot be posted to", () => {
  assert.match(
    PANEL,
    /selectedThread\.status === "RESOLVED" \|\|\s*\n?\s*selectedThread\.status === "CLOSED"/,
  );
  assert.match(PANEL, /data-evidence-discussion-locked/);
});

test("without a workspace context the panel renders nothing writable", () => {
  assert.match(PANEL, /if \(!teamId\) \{/);
  assert.match(PANEL, /data-evidence-discussion-empty="no-workspace"/);
  const noWorkspace = PANEL.slice(
    PANEL.indexOf('data-evidence-discussion-empty="no-workspace"'),
    PANEL.indexOf('data-evidence-discussion-panel'),
  );
  assert.doesNotMatch(noWorkspace, /<textarea|<form/);
});

test("every query stays workspace-scoped", () => {
  assert.match(PANEL, /teamId=\$\{encodeURIComponent\(/);
  assert.match(PANEL, /evidenceId=\$\{encodeURIComponent\(evidenceId\)\}/);
});

// ---------------------------------------------------------------------------
// B) The composer preserves its live behaviour
// ---------------------------------------------------------------------------

test("the composer is labelled, described and length-bounded", () => {
  assert.match(PANEL, /htmlFor="evidence-discussion-message"/);
  assert.match(PANEL, /id="evidence-discussion-message"/);
  assert.match(PANEL, /aria-describedby="evidence-discussion-composer-note"/);
  assert.match(PANEL, /maxLength=\{8192\}/);
});

test("submit is blocked while posting and while empty", () => {
  assert.match(PANEL, /const composerDisabled = posting \|\| draft\.trim\(\)\.length === 0/);
  assert.match(PANEL, /disabled=\{composerDisabled\}/);
  assert.match(PANEL, /aria-disabled=\{composerDisabled\}/);
  assert.match(PANEL, /\{posting \? "Posting…" : "Post message"\}/);
});

test("the send action is the canonical purple primary", () => {
  assert.match(PANEL, /className="app-primary-action"/);
});

test("nothing is rendered optimistically before the server confirms", () => {
  // The draft is only cleared, and messages only reloaded, after the POST
  // resolves — a failed request must not leave a phantom message behind.
  assert.doesNotMatch(PANEL_CODE, /setMessages\(\[\s*\.\.\.messages/);
  assert.doesNotMatch(PANEL_CODE, /optimistic/i);
});

// ---------------------------------------------------------------------------
// C) User content is rendered safely and not reinterpreted
// ---------------------------------------------------------------------------

test("message bodies are never injected as markup", () => {
  assert.doesNotMatch(PANEL_CODE, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(PANEL_CODE, /innerHTML/);
});

test("author line breaks survive", () => {
  assert.match(CSS, /\.evidence-discussion__body\s*\{[\s\S]{0,200}white-space:\s*pre-wrap/);
});

test("a long URL or token breaks instead of escaping the card", () => {
  assert.match(CSS, /\.evidence-discussion__body\s*\{[\s\S]{0,240}overflow-wrap:\s*anywhere/);
  // The composer must stay inside its region too — content-box + 100% width
  // overflowed it by its own padding.
  assert.match(
    CSS,
    /\.evidence-discussion__textarea\s*\{[\s\S]{0,240}box-sizing:\s*border-box/,
  );
});

test("mentions are highlighted but never resolved to an identity", () => {
  assert.match(PANEL, /data-discussion-mention-token=\{m\[0\]\}/);
  assert.match(PANEL, /className="evidence-discussion__mention"/);
  // The component renders the raw token; it must not invent a display name.
  assert.doesNotMatch(PANEL_CODE, /resolveMention|lookupUser|mentionDisplayName/);
});

// ---------------------------------------------------------------------------
// D) Thread list anatomy
// ---------------------------------------------------------------------------

test("thread selection is a real button and keyboard reachable", () => {
  assert.match(PANEL, /<button\s*\n?\s*type="button"\s*\n?\s*className="evidence-discussion__thread"/);
  assert.match(PANEL, /onClick=\{\(\) => setSelectedThreadId\(t\.id\)\}/);
  assert.match(PANEL, /aria-current=\{active \? "true" : undefined\}/);
  assert.match(CSS, /\.evidence-discussion__thread:focus-visible/);
});

test("selection changes surface and border only — geometry is identical", () => {
  const selected = CSS.slice(
    CSS.indexOf('.evidence-discussion__thread[data-thread-selected="true"]'),
  ).slice(0, 200);
  assert.match(selected, /border-color:/);
  assert.match(selected, /background:/);
  // No padding, size or font change that would shift the list on selection.
  assert.doesNotMatch(selected, /padding|font-size|inline-size|block-size/);
});

test("thread status keeps distinct tones — the list is not uniformly purple", () => {
  assert.match(PANEL, /function statusTone\(status: ThreadStatus\)/);
  for (const tone of ['"green"', '"blue"', '"amber"', '"slate"']) {
    assert.match(PANEL, new RegExp(`return ${tone}`));
  }
  assert.match(PANEL, /data-tone="red"/); // escalated
});

test("a long thread title clamps rather than widening the column", () => {
  assert.match(
    CSS,
    /\.evidence-discussion__thread-title\s*\{[\s\S]{0,400}line-clamp:\s*2/,
  );
  assert.match(
    CSS,
    /\.evidence-discussion__layout\s*\{[\s\S]{0,200}grid-template-columns:\s*minmax\(240px, 320px\)/,
  );
});

test("filters keep their live presets and are announced", () => {
  for (const preset of ["all", "unresolved", "escalated", "resolved"]) {
    assert.match(PANEL, new RegExp(`"${preset}"`));
  }
  assert.match(PANEL, /aria-pressed=\{filterPreset === preset\}/);
  assert.match(PANEL, /aria-label="Filter threads by title"/);
});

test("no thread row nests an interactive element", () => {
  const row = PANEL.slice(
    PANEL.indexOf('className="evidence-discussion__thread"'),
    PANEL.indexOf("</button>", PANEL.indexOf('className="evidence-discussion__thread"')),
  );
  assert.doesNotMatch(row, /<button|<a\s|<input|<textarea/);
});

// ---------------------------------------------------------------------------
// E) The boundary is stated and not overclaimed
// ---------------------------------------------------------------------------

test("the tab states that discussion is separate from the record's guarantees", () => {
  for (const claim of [
    /forensic custody chain/,
    /recorded integrity state/,
    /public verification/,
    /verification package/,
  ]) {
    assert.match(TAB, claim);
  }
  assert.match(
    TAB,
    /Posting a message does not\s*\n?\s*change what was preserved about this evidence\./,
  );
});

test("no copy claims a message becomes part of the immutable record", () => {
  for (const src of [TAB_CODE, PANEL_CODE]) {
    assert.doesNotMatch(src, /immutable record|part of the evidence|becomes evidence/i);
    assert.doesNotMatch(src, /authentic|admissib/i);
  }
});

// ---------------------------------------------------------------------------
// F) Every live state survives
// ---------------------------------------------------------------------------

test("all live empty/loading/error states are preserved", () => {
  for (const marker of [
    'data-evidence-discussion-empty="no-workspace"',
    'data-evidence-discussion-empty="no-threads"',
    'data-evidence-discussion-empty="no-messages"',
    'data-evidence-discussion-empty="no-selection"',
    "data-evidence-discussion-error",
  ]) {
    assert.match(PANEL, new RegExp(marker.replace(/[[\]"=]/g, (c) => `\\${c}`)));
  }
  assert.match(PANEL, /Loading threads…/);
  assert.match(PANEL, /Loading messages…/);
});

test("presence and mark-mentions-read are still wired", () => {
  assert.match(PANEL, /<PresenceIndicator/);
  assert.match(PANEL, /mark-mentions-read/);
});

// ---------------------------------------------------------------------------
// G) One implementation, one rail, no legacy
// ---------------------------------------------------------------------------

test("Personal and Enterprise render the same Discussion", () => {
  for (const src of [TAB_CODE, PANEL_CODE]) {
    assert.doesNotMatch(src, /workspaceKind|isPersonal|orgKind/i);
  }
  assert.match(PAGE, /activeTab === "discussion" \? <EvidenceDiscussionTab ctx=\{ctx\} \/> : null/);
});

test("the shared rail is reused once and Discussion does not fork it", () => {
  const mounts = PAGE.match(/<EvidenceRecordRail\b/g) ?? [];
  assert.equal(mounts.length, 1);
  assert.doesNotMatch(TAB + PANEL, /evidence-detail-sidebar|EvidenceRecordRail/);
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

test("no inline style object, inline hex or legacy primitive survives", () => {
  for (const [label, src] of [
    ["tab", TAB_CODE],
    ["panel", PANEL_CODE],
  ] as const) {
    assert.doesNotMatch(src, /style=\{\{/, `${label} still carries an inline style object`);
    assert.doesNotMatch(src, /#[0-9a-fA-F]{6}\b/, `${label} still carries an inline hex`);
    assert.doesNotMatch(src, /rgba?\(/, `${label} still carries an inline colour`);
    assert.doesNotMatch(src, /from "[^"]*components\/ui"/, `${label} imports the legacy ui barrel`);
    assert.doesNotMatch(src, /<Button\b/, `${label} renders a legacy Button`);
    assert.doesNotMatch(src, /teal/i, `${label} references legacy teal`);
    assert.doesNotMatch(src, /<em>|<i>|font-style:\s*italic/, `${label} uses italic`);
  }
});

test("the superseded shared primitives are gone from the tab", () => {
  for (const legacy of [
    "SectionHeading",
    "evidence-detail-section-header",
    "evidence-discussion-panel\"",
  ]) {
    assert.doesNotMatch(
      TAB_CODE,
      new RegExp(legacy.replace(/-/g, "\\-")),
      `${legacy} must not survive in the tab`,
    );
  }
});

test("the discussion layout uses logical properties so it mirrors in RTL", () => {
  const disc = CSS.slice(CSS.indexOf(".evidence-detail-discussion"));
  assert.doesNotMatch(disc, /margin-left:|margin-right:|float:/);
  assert.doesNotMatch(disc, /\btext-align:\s*(left|right)\b/);
  // Our own stamps stay LTR-readable inside an Arabic page.
  assert.match(CSS, /\.evidence-discussion__stamp\s*\{[\s\S]{0,120}unicode-bidi:\s*plaintext/);
});
