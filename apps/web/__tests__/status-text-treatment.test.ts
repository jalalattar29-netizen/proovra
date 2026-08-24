/**
 * TEXT-ONLY STATUS TREATMENT — the contract for Cases, Evidence and Search.
 *
 * A status on these five surfaces (`/cases`, `/cases/:id`, `/evidence`,
 * `/evidence/:id`, `/search`) is rendered as WORDS in a semantic ink, not as a
 * tinted capsule. This file is the guard for that, and for the two things that
 * make it a design-system change rather than twenty stylesheet edits:
 *
 *   1. ONE primitive (`.app-status-text[data-tone]`) and ONE lifecycle tone
 *      table, so Cases, Evidence and Search cannot drift into three palettes.
 *   2. The capsule primitives (`.app-status-badge`, `.app-chip`) are UNTOUCHED
 *      and still available. This was never "remove all badges from PROOVRA";
 *      surfaces where a state is the thing a dense row is scanned by still use
 *      one, and a global redefinition would have broken them silently.
 *
 * Everything below reads the SHIPPED source. A test that reproduces the mapping
 * it is checking proves only that it can copy.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const PRIM_CSS = read("apps/web/components/app-primitives/app-primitives.css");
const TOKENS = read("apps/web/lib/design-tokens/tokens.css");
const STATUS_TEXT = read("apps/web/components/app-primitives/AppStatusText.tsx");
const LIFECYCLE = read("apps/web/lib/status-tone/lifecycleTone.ts");

// Cases
const CASES_INDEX = read("apps/web/components/cases-experience/CasesIndex.tsx");
const CASES_CSS = read("apps/web/components/cases-experience/cases-experience.css");
const COPILOT = read("apps/web/components/ai-copilot/CaseCopilotPanel.tsx");

// Evidence
const EV_ROW = read("apps/web/app/(app)/evidence/components/EvidenceLibraryRow.tsx");
const EV_STATUS = read("apps/web/app/(app)/evidence/lib/evidence-library-status.ts");
const EV_DETAIL_PAGE = read("apps/web/app/(app)/evidence/[id]/page.tsx");
const EV_DETAIL_CSS = read("apps/web/app/(app)/evidence/[id]/evidence-detail.css");
const EV_INTEGRITY = read("apps/web/app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab.tsx");
const EV_RAIL = read("apps/web/app/(app)/evidence/[id]/_tabs/EvidenceRecordRail.tsx");
const EV_LIB = read("apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx");
const TA_ROW = read(
  "apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/MetadataRow.tsx",
);
const TA_TRUST = read(
  "apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/TrustDecisionSummary.tsx",
);
const MEDIA_INTEL = read("apps/web/components/media-intelligence/MediaIntelligencePanel.tsx");

// Search
const SEARCH_PAGE = read("apps/web/app/(app)/search/page.tsx");
const SEARCH_CSS = read("apps/web/app/(app)/search/search.css");

/** Relative luminance, per WCAG 2.x. */
function luminance(hex: string): number {
  const c = hex.replace("#", "");
  const channels = [0, 2, 4]
    .map((i) => parseInt(c.substr(i, 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Resolve a token to its declared hex, following one level of aliasing. */
function tokenHex(name: string): string {
  const m = TOKENS.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6});`));
  assert.ok(m, `token --${name} is not declared as a hex`);
  return m![1]!.toUpperCase();
}

/** The declared rule body for a selector, so a claim is read from the CSS. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no rule for ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

/** Every tone the text primitive declares. */
const TEXT_TONES = [
  "green",
  "amber",
  "red",
  "indigo",
  "blue",
  "orange",
  "slate",
  "ink",
] as const;

// ===========================================================================
// 1–4. The primitive
// ===========================================================================

test("1. the text-only primitive removes every part of the capsule, explicitly", () => {
  const base = rule(PRIM_CSS, ".app-status-text");
  // Each removal is STATED. These labels replaced capsules at their call sites,
  // and an implicit reset is how 8px of pill padding survives as a mysterious
  // gap after the background is gone.
  assert.match(base, /background: none;/);
  assert.match(base, /border: 0;/);
  assert.match(base, /box-shadow: none;/);
  assert.match(base, /padding: 0;/);
  assert.match(base, /border-radius: 0;/);
  // Text in the flow, not an inline-flex box with its own line box.
  assert.match(base, /display: inline;/);
  // Emphasis is WEIGHT, not a font size of its own.
  assert.match(base, /font-weight: 600;/);
  assert.match(base, /font: inherit;/);
  assert.doesNotMatch(base, /!important/);
});

test("2. every tone is an INK and nothing else", () => {
  for (const tone of TEXT_TONES) {
    const body = rule(PRIM_CSS, `.app-status-text[data-tone="${tone}"]`);
    // A tone may not paint a surface, and may not move a label — a row
    // carrying one state must not shift when the state changes.
    assert.doesNotMatch(
      body,
      /background|border|box-shadow|padding|font-size|line-height|inline-size/,
      `tone ${tone} does more than set an ink`,
    );
    assert.match(body, /--app-status-tone: var\(--[a-z0-9-]+\)/, `tone ${tone} is not a token`);
  }
  // No literal hex anywhere in the tone block: a private value here is a
  // colour that agrees with the app by coincidence.
  const block = PRIM_CSS.slice(
    PRIM_CSS.indexOf(".app-status-text {"),
    PRIM_CSS.indexOf(".app-status-text-row {"),
  );
  assert.doesNotMatch(block, /#[0-9A-Fa-f]{3,6}\b/);
});

test("3. every status ink clears WCAG AA on the card it now sits on", () => {
  // The capsule is gone, so each ink is measured against #FFFFFF rather than
  // against a tint. THE FILL EXEMPTION THIS PRODUCT RECORDS IS A *FILL*
  // EXEMPTION: `--orange-fill` is allowed to be sub-AA behind white text, and
  // a WORD carries meaning and does not get to spend it.
  const measured: Array<[string, string]> = [
    ["green", tokenHex("success-standard")],
    ["amber", tokenHex("warning-ink")],
    ["red", tokenHex("error")],
    ["indigo", tokenHex("accent-600")],
    ["blue", tokenHex("info")],
    ["orange", tokenHex("orange-ink")],
    ["slate", tokenHex("ink-secondary")],
    ["ink", tokenHex("ink-primary")],
  ];
  for (const [tone, hex] of measured) {
    const ratio = contrast(hex, "#FFFFFF");
    assert.ok(
      ratio >= 4.5,
      `${tone} (${hex}) measures ${ratio.toFixed(2)}:1 on white — below the 4.5:1 AA floor`,
    );
  }
  // The two sub-AA candidates that were considered and REJECTED for this job.
  // Named so the next person sees the decision instead of re-making it.
  assert.ok(contrast(tokenHex("success"), "#FFFFFF") < 4.5);
  assert.ok(contrast(tokenHex("orange-fill"), "#FFFFFF") < 4.5);
  assert.notEqual(tokenHex("success-standard"), tokenHex("success"));
});

test("4. several states side by side are separated by a GAP, never by a capsule", () => {
  const row = rule(PRIM_CSS, ".app-status-text-row");
  assert.match(row, /display: flex;/);
  assert.match(row, /flex-wrap: wrap;/);
  assert.match(row, /gap: /);
  // A capsule must not come back in order to push words apart.
  assert.doesNotMatch(row, /background|border-radius|padding/);
  // The component carries no dot: a colour-only cue is exactly what a state
  // must not lean on, and the word is already there.
  assert.doesNotMatch(STATUS_TEXT, /dot/);
});

test("4b. size is an OPT-IN tier that restores the original fixed sizes — the base never blanket-sizes", () => {
  // THE REGRESSION THIS GUARDS. `font: inherit` on the base made a status
  // follow its parent, so a 12px label in a 16px body rendered at 16px. The
  // fix restores the FIXED sizes the badges had — as opt-in tiers, because the
  // labels' original sizes DIFFER (10.5 / 11.5 / 12), so one blanket size would
  // shrink the badge-sized labels and enlarge the appendix ones.

  // The base still inherits by default: a label with no tier is not forced to a
  // size, so this is a capability and not a global rule. The FORBIDDEN fix — a
  // bare `.app-status-text { font-size }` — must not appear.
  const base = rule(PRIM_CSS, ".app-status-text");
  assert.match(base, /font: inherit;/);
  assert.doesNotMatch(base, /font-size/, "the base must not carry a blanket font-size");

  // The three tiers, at the exact original sizes the badges/labels had.
  assert.match(
    rule(PRIM_CSS, '.app-status-text[data-size="md"]'),
    /font-size: 12px;/,
    "md must be the 12px status-badge default",
  );
  assert.match(
    rule(PRIM_CSS, '.app-status-text[data-size="sm"]'),
    /font-size: 11\.5px;/,
    "sm must be the 11.5px readiness / media-type size",
  );
  assert.match(
    rule(PRIM_CSS, '.app-status-text[data-size="xs"]'),
    /font-size: 10\.5px;/,
    "xs must be the 10.5px Technical Appendix size",
  );
  // The tiers set SIZE only — a tier is not a place to smuggle a surface back.
  for (const t of ["md", "sm", "xs"]) {
    const body = rule(PRIM_CSS, `.app-status-text[data-size="${t}"]`);
    assert.doesNotMatch(body, /background|border|box-shadow|border-radius/, `${t} tier does more than size`);
  }

  // The component defaults to a compact size rather than inheriting: a status
  // is a compact label, and the whole defect was it ballooning to body size.
  assert.match(STATUS_TEXT, /size = "md"/);
  assert.match(STATUS_TEXT, /data-size=\{size === "inherit" \? undefined : size\}/);
});

test("4c. every regressed label asks for the size its badge had", () => {
  // The exact tier each surface must carry, so a future edit that drops a
  // `data-size`/`size` and lets a label inherit 16px again is caught here.

  // 12px (the status-badge default) — read from the shipped source.
  const simpleDetail = read(
    "apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx",
  );
  assert.match(
    simpleDetail,
    /className="app-status-text"\s*\n\s*data-tone=\{caseStatusTone\(caseDetail\.status\)\}\s*\n\s*data-size="md"/,
  ); // case status under the title
  assert.match(EV_DETAIL_PAGE, /className="app-status-text"\s*\n\s*data-tone=\{getRecordStatusBadgeTone[\s\S]{0,60}?data-size="md"/);
  assert.match(EV_ROW, /className="app-status-text" data-size="md" data-tone=\{getStatusBadgeTone/);
  assert.match(EV_ROW, /className="app-status-text"\s*\n\s*data-size="md"\s*\n\s*data-tone=\{getReviewPriorityTone/);
  assert.match(EV_INTEGRITY, /className="app-status-text evidence-detail-matrix-cell__state"\s*\n\s*data-size="md"/);

  // The AppStatusText component defaults to md, so the Cases-list status, the
  // Copilot row, the rail and all three Search states are 12px without an
  // explicit prop. Readiness overrides DOWN to its original 11.5px.
  assert.match(CASES_INDEX, /className="cases-readiness"\s*\n\s*tone=\{readiness\.tone\}\s*\n\s*size="sm"/);

  // 11.5px — the media-type label (was 0.72rem).
  assert.match(EV_LIB, /className="app-status-text"\s*\n\s*data-size="sm"\s*\n\s*data-tone=\{mediaKindTone/);

  // 10.5px — the Technical Appendix labels and the media-intelligence
  // confidence chip, which were the smaller `.ta-badge` / `.evd-badge`.
  assert.match(TA_TRUST, /className="app-status-text ta-signal-state"\s*\n\s*data-size="xs"/);
  assert.match(TA_ROW, /className="app-status-text"\s*\n\s*data-size="xs"/);
  assert.match(MEDIA_INTEL, /data-size="md" data-tone=\{severityTone/);
  assert.match(MEDIA_INTEL, /data-size="xs" data-tone="slate"/);
  assert.match(MEDIA_INTEL, /data-size="md" data-tone=\{statusTone/);
});

// ===========================================================================
// 5–6. The capsule primitives are STILL THERE
// ===========================================================================

test("5. `.app-status-badge` is untouched and still a capsule", () => {
  // THE MOST IMPORTANT ASSERTION IN THIS FILE. The brief for this change was
  // explicitly not "remove all badges"; a global redefinition of the badge
  // would have silently flattened every other surface in the product.
  const base = rule(PRIM_CSS, ".app-status-badge");
  assert.match(base, /border-radius: 999px;/);
  assert.match(base, /background: #F1F5F9;/);
  assert.match(base, /padding: 4px 11px;/);
  assert.doesNotMatch(base, /background: none|border: 0|box-shadow: none/);
  // Its soft tones still paint a tint, and its solid fill still paints a fill.
  assert.match(
    rule(PRIM_CSS, '.app-status-badge[data-tone="green"]'),
    /background: #EAF7F1;/,
  );
  assert.match(
    rule(PRIM_CSS, '.app-status-badge[data-fill="solid"][data-tone="orange"]'),
    /background: var\(--orange-fill\);/,
  );
  // And the badge understands every tone a shared mapping can hand it, so a
  // surface that keeps its capsule cannot receive a tone it cannot paint.
  for (const tone of TEXT_TONES) {
    assert.ok(
      PRIM_CSS.includes(`.app-status-badge[data-tone="${tone}"]`),
      `the badge cannot paint tone ${tone}`,
    );
  }
});

test("6. `.app-chip` is untouched, and the route-local badge it is not", () => {
  const chip = rule(PRIM_CSS, ".app-chip");
  assert.match(chip, /background/);
  assert.doesNotMatch(chip, /background: none/);
  // `.evd-badge` still carries "Required" and the intake-source label on
  // surfaces this change did not touch, so it keeps its surface too.
  assert.match(rule(EV_DETAIL_CSS, ".evd-badge"), /background/);
});

// ===========================================================================
// 7–9. ONE lifecycle mapping
// ===========================================================================

test("7. Cases and Search read the SAME lifecycle table", () => {
  const helpers = read(
    "apps/web/components/cases-experience/simple-case-detail/helpers.ts",
  );
  const tones = read("apps/web/app/(app)/search/searchTones.ts");
  for (const [label, src] of [
    ["cases detail", helpers],
    ["cases list", CASES_INDEX],
    ["search", tones],
  ] as Array<[string, string]>) {
    assert.match(
      src,
      /lib\/status-tone\/lifecycleTone|status-tone\/lifecycleTone/,
      `${label} does not read the shared lifecycle table`,
    );
  }
  // The Cases LIST used to own a third mapping onto the legacy Badge tones.
  // It is deleted, not merely unused.
  assert.doesNotMatch(CASES_INDEX, /function statusBadgeTone/);
  assert.match(CASES_INDEX, /statusBadgeTone` USED TO LIVE HERE/);
});

test("8. the required lifecycle colours, read from the shipped table", () => {
  const table = LIFECYCLE.slice(
    LIFECYCLE.indexOf("const LIFECYCLE_TONE"),
    LIFECYCLE.indexOf("export function lifecycleToneOrNull"),
  );
  for (const [state, tone] of [
    ["open", "green"],
    ["investigating", "indigo"],
    ["on_hold", "indigo"],
    ["resolved", "orange"],
    ["archived", "red"],
    ["closed", "ink"],
  ] as Array<[string, string]>) {
    assert.match(table, new RegExp(`\\b${state}: "${tone}",`), `${state} must be ${tone}`);
  }
  // ON_HOLD is INDIGO, not amber. A hold is a decision a person made and still
  // owns, not a warning the system is raising.
  assert.doesNotMatch(table, /\bon_hold: "amber",/);
  // ABSENCE is not a state: an unmapped value must come back null, so a caller
  // with its own wider vocabulary can tell "not mine" from "mine and neutral".
  assert.match(LIFECYCLE, /if \(key === "" \|\| key === "—" \|\| key === "-"\) return null;/);
  assert.match(LIFECYCLE, /return LIFECYCLE_TONE\[key\] \?\? null;/);
});

test("9. the mapping is DISPLAY ONLY — it touches no lifecycle logic", () => {
  // The whole point of this change was presentation. If a tone table ever
  // learns to write, that is the regression.
  assert.doesNotMatch(LIFECYCLE, /apiFetch|fetch\(|ALLOWED_STATUS_TRANSITIONS|useState|POST/);
});

// ===========================================================================
// 10–13. Cases
// ===========================================================================

test("10. the Cases list renders status AND readiness as text", () => {
  assert.match(CASES_INDEX, /<AppStatusText\s*\n\s*tone=\{lifecycleTone\(row\.status\)\}/);
  assert.match(CASES_INDEX, /className="cases-readiness"\s*\n\s*tone=\{readiness\.tone\}/);
  // The readiness capsule and its leading dot are DELETED from the CSS, not
  // overridden — an override leaves the old rule one specificity bump away.
  assert.doesNotMatch(CASES_CSS, /\.cases-readiness--(ready|warning|muted)/);
  assert.doesNotMatch(CASES_CSS, /\.cases-readiness::before/);
  assert.doesNotMatch(rule(CASES_CSS, ".cases-readiness"), /background|border-radius|padding/);
});

test("11. readiness keeps its three derived states and its semantics", () => {
  // PRESENTATION ONLY. The same three states from the same evidence/gap facts;
  // only the tone words changed, and the probe keys are untouched.
  assert.match(CASES_INDEX, /label: "Not started", tone: "slate" as const, key: "not-started"/);
  assert.match(
    CASES_INDEX,
    /label: "Needs attention", tone: "amber" as const, key: "needs-attention"/,
  );
  assert.match(CASES_INDEX, /label: "Ready", tone: "green" as const, key: "ready"/);
  assert.match(CASES_INDEX, /const isEmptyCase = row\.linkedEvidenceCount === 0;/);
});

test("12. the Cases list keeps its badges for the things that are NOT states", () => {
  // Priority and the risk chip are still `Badge`. A classification and a state
  // must not look alike — that is the distinction this change draws.
  assert.match(CASES_INDEX, /data-matter-queue-row-chip="priority"/);
  assert.match(CASES_INDEX, /import \{ Badge \} from "\.\.\/ui\/Badge";/);
  assert.match(CASES_INDEX, /function RiskBadge\(/);
});

test("13. the Case Copilot row states its status as text and keeps the KIND chip", () => {
  assert.match(COPILOT, /<AppStatusText\s*\n\s*tone=\{statusTone\(e\.status\)\}/);
  assert.doesNotMatch(COPILOT, /<AppStatusBadge/);
  // The kind label, "Package v2" and the eligibility semantics are untouched.
  assert.match(COPILOT, /className="case-copilot__kind"/);
  assert.match(COPILOT, /evaluateCopilotEvidenceEligibility|verdict\.eligible/);
});

// ===========================================================================
// 14–19. Evidence
// ===========================================================================

test("14. Evidence Library rows state their status and review signal as text", () => {
  assert.match(EV_ROW, /className="app-status-text" data-size="md" data-tone=\{getStatusBadgeTone\(item\)\}/);
  assert.match(EV_ROW, /className="app-status-text"\s*\n\s*data-size="md"\s*\n\s*data-tone=\{getReviewPriorityTone/);
  assert.doesNotMatch(EV_ROW, /app-status-badge/);
  // The container was already a wrapping flex row with its own gap, so the two
  // phrases cannot run together.
  const badges = rule(read("apps/web/app/(app)/evidence/evidence-library.css"), ".evidence-library-row__badges");
  assert.match(badges, /display: flex;/);
  assert.match(badges, /gap: 8px;/);
});

test("15. `Stable review state` is blue and `Operational notes` is orange", () => {
  // The labels and the levels are unchanged; only the tones moved. Stable (the
  // settled majority) is the calm informational blue; Operational notes (a
  // record carrying a concrete note) is orange, the classification tone.
  assert.match(EV_STATUS, /stable: "blue",/);
  assert.match(EV_STATUS, /informational: "orange",/);
  // The previous swap — every settled record painted orange — must not return.
  assert.doesNotMatch(EV_STATUS, /stable: "orange",/);
  assert.doesNotMatch(EV_STATUS, /informational: "blue",/);
  assert.match(
    read("apps/web/app/(app)/evidence/lib/evidence-library-alerts.ts"),
    /return \{ level: "stable", label: "Stable review state", notes: \[\] \};/,
  );
  // Blue resolves to the AA-safe --info; orange to the AA-safe --orange-ink.
  assert.match(rule(PRIM_CSS, '.app-status-text[data-tone="blue"]'), /var\(--info\)/);
  assert.match(rule(PRIM_CSS, '.app-status-text[data-tone="orange"]'), /var\(--orange-ink\)/);
});

test("16. the Evidence Detail hero states the record's status as text", () => {
  assert.match(
    EV_DETAIL_PAGE,
    /className="app-status-text"\s*\n\s*data-tone=\{getRecordStatusBadgeTone\(evidence\.status\)\}/,
  );
});

test("17. every row of Verification & Preservation is text, from ONE render site", () => {
  // ONE site, so no row can keep the old capsule by being an uncommon state —
  // which is what an audit row by row would have missed.
  assert.match(
    EV_INTEGRITY,
    /className="app-status-text evidence-detail-matrix-cell__state"/,
  );
  assert.doesNotMatch(EV_INTEGRITY, /app-status-badge/);
  assert.equal([...EV_INTEGRITY.matchAll(/matrix-cell__state/g)].length, 1);
  // The required mapping, plus the states that keep what they had.
  assert.match(EV_INTEGRITY, /recorded: \{ label: "Recorded", tone: "blue" \}/);
  assert.match(EV_INTEGRITY, /available: \{ label: "Available", tone: "indigo" \}/);
  assert.match(EV_INTEGRITY, /verified: \{ label: "Verified", tone: "green" \}/);
  assert.match(EV_INTEGRITY, /unavailable: \{ label: "Unavailable", tone: "slate" \}/);
  // Recorded, Available and Verified stay three distinct tones — the card's job
  // is telling "a proof exists" / "an artifact can be fetched" / "confirmed"
  // apart. Recorded is the informational blue, not orange.
  assert.doesNotMatch(EV_INTEGRITY, /recorded: \{ label: "Recorded", tone: "orange" \}/);
  assert.match(rule(PRIM_CSS, '.app-status-text[data-tone="blue"]'), /var\(--info\)/);
  // The cell's containment survives; its capsule does not.
  assert.doesNotMatch(
    rule(EV_DETAIL_CSS, ".evidence-detail-matrix-cell__state"),
    /background|border-radius|padding/,
  );
});

test("18. the Technical Appendix states every signal and role as text", () => {
  // `.ta-badge` and its five private tinted pairs are DELETED. Both of its
  // consumers — the per-signal outcome and the part-role label — are in scope,
  // so the capsule had no remaining caller to serve.
  assert.doesNotMatch(EV_DETAIL_CSS, /^\.ta-badge[ ,{]/m);
  for (const tone of ["success", "info", "warning", "danger", "neutral"]) {
    assert.doesNotMatch(EV_DETAIL_CSS, new RegExp(`\\.ta-badge-${tone}\\s*\\{`));
  }
  // `Passed` (and every other signal outcome) is text.
  assert.match(TA_TRUST, /className="app-status-text ta-signal-state"/);
  assert.match(TA_TRUST, /data-tone=\{appendixAppTone\(state\.tone\)\}/);
  assert.doesNotMatch(TA_TRUST, /ta-badge/);
  // `Supporting` (and every other part role) is text, through ONE component.
  assert.match(TA_ROW, /className="app-status-text"\s*\n\s*data-size="xs"\s*\n\s*data-tone=\{appendixAppTone\(tone\)\}/);
  assert.doesNotMatch(TA_ROW, /ta-badge ta-badge-/);
  // The appendix keeps its own tone WORDS and translates once.
  assert.match(TA_ROW, /success: "green",[\s\S]{0,120}?neutral: "slate",/);
  // Scores, weighting and the signal vocabulary are untouched.
  assert.match(TA_TRUST, /\{signal\.points\} \/ \{signal\.maxPoints\}/);
  assert.match(TA_TRUST, /passed: \{ label: "Passed", tone: "success", icon: CircleCheck \}/);
  // The per-signal state still starts on one axis, without the pill geometry
  // that used to make every capsule the same height.
  const placement = rule(EV_DETAIL_CSS, ".ta-signals .ta-signal-state");
  assert.match(placement, /justify-self: start;/);
  assert.doesNotMatch(placement, /block-size|padding-inline|background/);
});

test("19. media-intelligence descriptors are three separate text statuses", () => {
  const header = MEDIA_INTEL.slice(
    MEDIA_INTEL.indexOf("data-media-intelligence-statuses"),
    MEDIA_INTEL.indexOf("evd-paragraph"),
  );
  assert.equal([...header.matchAll(/className="app-status-text"/g)].length, 3);
  assert.doesNotMatch(header, /app-status-badge|evd-badge/);
  // The ROW is what separates them. Without it the three run together as
  // "Review recommendedHigh confidenceAwaiting review".
  assert.match(MEDIA_INTEL, /className="app-status-text-row" data-media-intelligence-statuses/);
  // The workflow is untouched: the acknowledge/dismiss actions and the status
  // vocabulary are exactly as they were.
  assert.match(MEDIA_INTEL, /onAck\("ACKNOWLEDGED"\)/);
  assert.match(MEDIA_INTEL, /onAck\("DISMISSED"\)/);
  assert.match(MEDIA_INTEL, /severityLabel\(signal\.severity\)/);
  assert.match(MEDIA_INTEL, /statusLabel\(signal\.status\)/);
});

test("20. media TYPE labels take the required colours, from their own table", () => {
  // A KIND is a CLASSIFICATION. It used to be passed to `pillTone`, a
  // substring matcher for STATES — "IMAGE" matches none of its branches, so
  // every kind fell through to one neutral and a photo, a video and a PDF were
  // the same grey.
  assert.match(EV_LIB, /image: "indigo",/);
  assert.match(EV_LIB, /video: "orange",/);
  assert.match(EV_LIB, /pdf: "blue",/);
  assert.match(EV_LIB, /audio: "ink",/);
  assert.match(EV_LIB, /className="app-status-text"\s*\n\s*data-size="sm"\s*\n\s*data-tone=\{mediaKindTone\(item\.kind\)\}/);
  // DOCUMENT is deliberately NOT given a colour of its own: this product has
  // no documented type colour for a document, and inventing one would be a
  // fourth type palette rather than a reuse.
  const table = EV_LIB.slice(
    EV_LIB.indexOf("const MEDIA_KIND_TONE"),
    EV_LIB.indexOf("export function mediaKindTone"),
  );
  assert.doesNotMatch(table, /document|text|other/);
  assert.match(EV_LIB, /return MEDIA_KIND_TONE\[kind\.trim\(\)\.toLowerCase\(\)\] \?\? "slate";/);
  // `pillTone` still exists for the STATES that legitimately use it.
  assert.match(EV_LIB, /export function pillTone\(status: string\)/);
  // AND the classifier that decides what a record IS was not touched. The
  // library folds application/pdf into `document`; changing that would be a
  // change to categorisation, not to a label's colour.
  assert.match(
    read("apps/web/app/(app)/evidence/lib/evidence-library-status.ts"),
    /mime === "application\/pdf" \|\|[\s\S]{0,120}?return "document";/,
  );
});

test("21. the record rail states its workflow and publication as text", () => {
  assert.match(EV_RAIL, /<AppStatusText\s*\n\s*tone=\{getWorkflowStatusTone/);
  assert.match(EV_RAIL, /<AppStatusText\s*\n\s*tone=\{getPublicVerificationTone/);
  assert.doesNotMatch(EV_RAIL, /AppStatusBadge/);
  // "Not started" is still the derived fallback, and publication state is
  // still read from the projection — neither is re-derived here.
  assert.match(EV_RAIL, /: "Not started"/);
  assert.match(EV_RAIL, /workspace\.publicVerificationSummary\.state/);
});

// ===========================================================================
// 22–24. Search
// ===========================================================================

test("22. a search result's STATE is text and its TYPE stays a filled label", () => {
  // The type label is a CLASSIFICATION and keeps its fill deliberately: it is
  // what makes a state and a kind read as different claims on one card.
  assert.equal([...SEARCH_PAGE.matchAll(/className="search-type-badge"/g)].length, 2);
  assert.match(
    rule(SEARCH_CSS, '.search-type-badge[data-tone="blue"]'),
    /background: var\(--info\)/,
  );
  // Every state slot on the surface is `AppStatusText`.
  assert.match(SEARCH_PAGE, /<AppStatusText\s*\n\s*className="search-result__status"/);
  assert.match(SEARCH_PAGE, /<AppStatusText\s*\n\s*className="search-inspector__lifecycle"/);
  assert.match(SEARCH_PAGE, /<AppStatusText\s*\n\s*className="search-fact__badge"/);
  // No state slot kept a capsule.
  assert.doesNotMatch(SEARCH_PAGE, /<AppStatusBadge\s*\n\s*className="search-result__status"/);
  assert.doesNotMatch(
    SEARCH_PAGE,
    /<AppStatusBadge\s*\n\s*className="search-inspector__lifecycle"/,
  );
});

test("23. Archived is red and Closed is the darkest neutral, on THIS surface too", () => {
  // `archived` reaches Search as a BADGE CODE and Cases as a STATUS. Before the
  // delegation it was slate here and red there.
  const tones = read("apps/web/app/(app)/search/searchTones.ts");
  assert.match(
    tones,
    /export function searchBadgeTone\(badge: string\): AppTone \{[\s\S]{0,600}?const canonical = lifecycleToneOrNull\(badge\);\s*\n\s*if \(canonical\) return canonical;/,
  );
  assert.match(
    tones,
    /export function searchLifecycleTone\(value: string \| null \| undefined\): AppTone \{[\s\S]{0,700}?const canonical = lifecycleToneOrNull\(value\);\s*\n\s*if \(canonical\) return canonical;/,
  );
  // The shadowed local copies are gone, so the delegation cannot be bypassed.
  const local = tones.slice(
    tones.indexOf("const LIFECYCLE_KIND"),
    tones.indexOf("function searchLifecycleKind"),
  );
  assert.doesNotMatch(local, /\b(open|closed|resolved|archived|on_hold):/);
  // …but the vocabulary Search owns ALONE still answers for itself.
  assert.match(local, /in_review: "pending",/);
  assert.match(local, /pending_destruction: "destructive",/);
  // `isLifecycleValue` reads BOTH, or "Open" would have stopped counting as a
  // lifecycle value and the row subtitle would repeat the status beside it.
  assert.match(tones, /lifecycleToneOrNull\(value\) !== null \|\|\s*\n?\s*searchLifecycleKind\(value\) !== "neutral"/);
});

test("24. match reasons are plain text that does not compete with the title", () => {
  const base = rule(SEARCH_CSS, ".search-match-reason");
  assert.match(base, /background: none;/);
  assert.match(base, /border: 0;/);
  assert.match(base, /padding: 0;/);
  assert.match(base, /border-radius: 0;/);
  // EVERY reason gets the same treatment — leaving one match-source type with a
  // chip while the others are text is the specific inconsistency to avoid.
  assert.doesNotMatch(
    SEARCH_CSS.slice(SEARCH_CSS.indexOf(".search-match-reason {")),
    /\.search-match-reason\[data-match-tone="[a-z]+"\] \{[^}]*background/,
  );
  // One render site, deriving its tone rather than hard-coding one.
  assert.equal([...SEARCH_PAGE.matchAll(/className="search-match-reason"/g)].length, 1);
  assert.match(SEARCH_PAGE, /data-match-tone=\{searchMatchReasonTone\(reason\)\}/);
  // The reason is quieter than the title it explains: smaller, and never bold
  // enough to read as a heading.
  assert.match(base, /font-size: 11\.5px;/);
});

// ===========================================================================
// 25. Nothing was solved by scattering `background: transparent`
// ===========================================================================

test("25. no surface solved this with a one-off override", () => {
  const routeCss = [
    ["cases-experience.css", CASES_CSS],
    ["search.css", SEARCH_CSS],
    ["evidence-detail.css", EV_DETAIL_CSS],
    ["evidence-library.css", read("apps/web/app/(app)/evidence/evidence-library.css")],
  ] as Array<[string, string]>;
  for (const [name, css] of routeCss) {
    // The failure mode this guards is a route stylesheet reaching into the
    // shared primitives to flatten them for itself — which would flatten them
    // for every other surface that imports the same file.
    assert.doesNotMatch(
      css,
      /\.app-status-badge[^\n{]*\{[^}]*background:\s*(none|transparent)/,
      `${name} flattens the shared badge`,
    );
    assert.doesNotMatch(
      css,
      /\.app-chip[^\n{]*\{[^}]*background:\s*(none|transparent)/,
      `${name} flattens the shared chip`,
    );
  }
  // And the text primitive is declared in exactly one place.
  assert.equal(
    routeCss.filter(([, css]) => /^\.app-status-text \{/m.test(css)).length,
    0,
    "the text primitive must be declared only in app-primitives.css",
  );
  assert.equal([...PRIM_CSS.matchAll(/^\.app-status-text \{/gm)].length, 1);
});
