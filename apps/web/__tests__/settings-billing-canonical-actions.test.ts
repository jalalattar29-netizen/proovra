/**
 * Settings and Billing use the PRODUCT's action, not their own.
 *
 * The reference is the Evidence Library header: "New Case" and "Refresh" are
 * both `.app-secondary-action .app-secondary-action--lg`. Measured on that page
 * they REST at rgba(255,255,255,0.9) — white — with dark neutral ink and a
 * rgba(124,58,237,0.24) border, lift to #F2ECFE only on hover, and return to
 * white when the pointer leaves. The solid violet button beside them
 * ("Upload / Capture Evidence") is `.app-primary-action`, a different control.
 *
 * Settings and Billing had each grown a local treatment instead, and Settings
 * had grown TWO: a "PURPLE — the action a section exists to perform" block and,
 * 970 lines later, a white/violet block, with several buttons named in both.
 *
 * That overlap is what broke "Set up two-factor authentication". The purple
 * block claimed `[data-cc-mfa-enroll-start]` AND its descendants; the white
 * block claimed the button alone and, being later, won on the element. Nothing
 * ever overrode the descendant half, so the `<span>` the shared Button
 * component wraps its label in kept `background: var(--set-accent)` — a solid
 * violet rectangle inside a white button, measured live at 214x20.
 *
 * These tests pin the resolution: one authority, named once, and no local block
 * still claiming a converted control.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(APP, rel), "utf8");

const OVERVIEW_SECTION = read("app/(app)/settings/_sections/OverviewSection.tsx");
const SETTINGS_OVERVIEW = read("app/(app)/settings/_sections/SettingsOverview.tsx");
const PREFERENCES = read("app/(app)/settings/_sections/PreferencesSection.tsx");
const PRIVACY = read("app/(app)/settings/_sections/PrivacySection.tsx");
const SECURITY = read(
  "app/(app)/security-center/components/PersonalSecuritySections.tsx",
);
const SETTINGS_CSS = read("app/(app)/settings/settings.css");
const BILLING_OVERVIEW = read("app/(app)/billing/_sections/BillingOverview.tsx");
const STORAGE = read("app/(app)/billing/_sections/StorageAndHistory.tsx");
const PRIMITIVES = read("components/app-primitives/app-primitives.css");
const CONFIRM = read("components/ui/ConfirmActionModal.tsx");
const EVIDENCE_HEADER = read(
  "app/(app)/evidence/components/EvidenceLibraryHeader.tsx",
);

/** CSS with comments removed — prose explaining a retired rule is not a rule. */
const stripCss = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");

/** The element carrying `hook` must also carry the canonical class. */
function assertCanonical(source: string, hook: string, label: string): void {
  const at = source.indexOf(hook);
  assert.ok(at >= 0, `${label}: ${hook} not found`);
  const open = source.lastIndexOf("<", at);
  const tag = source.slice(open, source.indexOf(">", at) + 1);
  assert.match(
    tag,
    /className="[^"]*\bapp-secondary-action\b/,
    `${label} must carry the canonical outlined action`,
  );
  assert.match(
    tag,
    /className="[^"]*\bapp-secondary-action--lg\b/,
    `${label} must carry the same size modifier the Evidence header uses`,
  );
  assert.doesNotMatch(
    tag,
    /\bapp-primary-action\b/,
    `${label} must NOT use the solid violet CTA`,
  );
  assert.ok(
    tag.startsWith("<button") || tag.startsWith("<Link") || tag.startsWith("<a"),
    `${label} must stay a real button/link element (got ${tag.slice(0, 24)}…)`,
  );
}

// -------------------------------------------------------------- THE REFERENCE

test("the reference really is the outlined action, not the solid one", () => {
  // If Evidence ever changed, these conversions would be following a button
  // that no longer exists. New Case and Refresh are the two named in the brief.
  for (const hook of ["data-evidence-new-case", "data-evidence-refresh"]) {
    const at = EVIDENCE_HEADER.indexOf(hook);
    assert.ok(at > 0, `${hook} must exist on the Evidence header`);
    const open = EVIDENCE_HEADER.lastIndexOf("<", at);
    const tag = EVIDENCE_HEADER.slice(open, EVIDENCE_HEADER.indexOf(">", at) + 1);
    assert.match(
      tag,
      /app-secondary-action app-secondary-action--lg/,
      `${hook} is the resting-state reference and must be the outlined action`,
    );
  }
  // …and the solid CTA beside them is a DIFFERENT class, which is what makes
  // "it looked purple" a hover state rather than the resting appearance.
  assert.match(
    EVIDENCE_HEADER,
    /data-evidence-upload[\s\S]{0,120}|app-header-primary-action/,
    "the solid CTA must stay its own class",
  );
});

test("the canonical states are the ones the reference declares", () => {
  const css = stripCss(PRIMITIVES);
  // REST — white, dark neutral ink, lavender hairline.
  assert.match(
    css,
    /\.app-secondary-action \{[\s\S]{0,600}background: rgba\(255, 255, 255, 0\.9\)/,
    "rest must be white",
  );
  assert.match(
    css,
    /\.app-secondary-action \{[\s\S]{0,600}border: 1px solid rgba\(124, 58, 237, 0\.24\)/,
    "rest must carry the subtle lavender border",
  );
  // HOVER — the tint, and only on hover.
  assert.match(
    css,
    /\.app-secondary-action:hover:not\(:disabled\) \{[\s\S]{0,200}background: #F2ECFE/,
    "the lavender tint belongs to :hover",
  );
  // FOCUS and DISABLED.
  assert.match(
    css,
    /\.app-secondary-action:focus-visible \{[\s\S]{0,160}box-shadow: 0 0 0 3px rgba\(124, 58, 237, 0\.28\)/,
    "focus is the canonical ring",
  );
  assert.match(
    css,
    /\.app-secondary-action:disabled \{[\s\S]{0,120}opacity: 0\.55/,
    "disabled is the canonical dimming",
  );
});

// ---------------------------------------------------------------- SETTINGS

test("every listed Settings action carries the canonical outlined action", () => {
  assertCanonical(OVERVIEW_SECTION, "data-cc-profile-edit", "Edit profile");
  assertCanonical(
    SETTINGS_OVERVIEW,
    'data-settings-open="security"',
    "Review security",
  );
  assertCanonical(
    PREFERENCES,
    "data-cc-preferences-detect-tz",
    "Use my current timezone",
  );
  assertCanonical(SECURITY, "data-cc-add-password-toggle", "Add password");
  assertCanonical(SECURITY, "data-cc-add-password-submit", "Add password (submit)");
  assertCanonical(SECURITY, "data-cc-mfa-enroll-start", "Set up two-factor");
  assertCanonical(
    PRIVACY,
    "data-cc-privacy-manage-cookies",
    "Manage cookie preferences",
  );
  assertCanonical(
    PRIVACY,
    "data-cc-privacy-history-toggle",
    "View acceptance history",
  );
  assertCanonical(PRIVACY, "data-cc-export-request", "Request data export");
});

test("no converted Settings action is still a legacy Button variant", () => {
  for (const [src, hook, label] of [
    [OVERVIEW_SECTION, "data-cc-profile-edit", "Edit profile"],
    [PREFERENCES, "data-cc-preferences-detect-tz", "Use my current timezone"],
    [SECURITY, "data-cc-mfa-enroll-start", "Set up two-factor"],
    [SECURITY, "data-cc-add-password-toggle", "Add password"],
    [PRIVACY, "data-cc-export-request", "Request data export"],
  ] as const) {
    const at = src.indexOf(hook);
    const open = src.lastIndexOf("<", at);
    const tag = src.slice(open, src.indexOf(">", at) + 1);
    assert.doesNotMatch(
      tag,
      /variant="(secondary|primary)"/,
      `${label} must not carry a legacy Button variant`,
    );
  }
});

test("settings.css no longer PAINTS a converted action", () => {
  // A local block that still names one of these is the second authority that
  // produced the 2FA artifact. Comments are stripped: naming a retired rule in
  // prose is how the removal stays explained.
  const painting = stripCss(SETTINGS_CSS)
    .split("}")
    .filter((block) => /background|color|border-color|box-shadow/.test(block))
    .join("}");
  for (const hook of [
    "[data-cc-mfa-enroll-start]",
    "[data-cc-preferences-detect-tz]",
    "[data-cc-export-request]",
    "[data-cc-add-password-toggle]",
    "[data-cc-add-password-submit]",
    "[data-cc-profile-edit]",
    '[data-settings-open="security"]',
    ".set-privacy__disclose",
  ]) {
    assert.ok(
      !painting.includes(hook),
      `settings.css still PAINTS ${hook} — two blocks claiming one button is the defect this fixes`,
    );
  }
});

test("nothing leaves a converted action permanently tinted", () => {
  // The regression the correction is guarding: a rule that paints the lavender
  // at REST rather than on :hover would look identical in a screenshot taken
  // with the pointer over the button, and wrong every other moment.
  const css = stripCss(SETTINGS_CSS);
  for (const block of css.split("}")) {
    if (!block.includes(".app-secondary-action")) continue;
    if (/:hover/.test(block)) continue;
    assert.ok(
      !/#F2ECFE|#f2ecfe|242, 236, 254/.test(block),
      `a non-hover rule paints the hover tint: ${block.trim().slice(0, 90)}`,
    );
    assert.ok(
      !/linear-gradient/.test(block),
      `a non-hover rule fills the outlined action: ${block.trim().slice(0, 90)}`,
    );
  }
});

test("the 2FA action has no inner surface to paint", () => {
  const at = SECURITY.indexOf("data-cc-mfa-enroll-start");
  const open = SECURITY.lastIndexOf("<", at);
  const close = SECURITY.indexOf("</button>", at);
  assert.ok(close > open, "the 2FA action must be a native <button>");
  assert.doesNotMatch(
    SECURITY.slice(open, close),
    /<span/,
    "the label must not be wrapped in a span",
  );
  assert.match(
    SETTINGS_CSS,
    /\.app-secondary-action > \*[^{]*\{[\s\S]{0,260}background: none !important/,
    "descendants of a canonical action must never redraw the surface",
  );
});

test("the Preferences row no longer resizes the canonical action", () => {
  assert.match(
    SETTINGS_CSS,
    /\[data-settings-preferences\] button:not\(\[data-cc-preferences-save\]\):not\(\.app-secondary-action\)/,
    "the 42px Preferences height rule must exclude the canonical action",
  );
});

// ------------------------------------------------------- OVERVIEW STRUCTURE

test("the summary row is four cards, sign-ins among them", () => {
  const gridAt = SETTINGS_OVERVIEW.indexOf('className="set-grid set-grid--summary"');
  assert.ok(gridAt > 0, "the summary grid must exist");
  const grid = SETTINGS_OVERVIEW.slice(
    gridAt,
    SETTINGS_OVERVIEW.indexOf("      </div>", gridAt),
  );
  for (const id of ["workspace", "plan", "security", "activity"]) {
    assert.ok(grid.includes(`testId="${id}"`), `${id} must be a summary card`);
  }
  // Recent sign-ins is back IN the row. It moved out when its headline was a
  // 120-character User-Agent; the device line is a parsed name now, so the
  // card is three short rows and sits beside its neighbours.
  // `SummaryCard` renders `data-settings-summary` from its `testId`, so the
  // attribute is generated rather than written out.
  assert.ok(SETTINGS_OVERVIEW.includes('testId="activity"'));
  assert.match(SETTINGS_OVERVIEW, /describeUserAgent\(entry\.device\)/);
});

test("the summary row is a real equal-column grid that stretches", () => {
  // FOUR: Workspace, Plan, Security, Recent sign-ins. Timezone left (it
  // restated what Preferences owns) and sign-ins took the seat rather than a
  // filler being invented for it.
  assert.match(
    SETTINGS_CSS,
    /\.settings-page-shell \.set-grid--summary \{[\s\S]{0,300}grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/,
    "desktop must be four equal columns",
  );
  assert.match(
    SETTINGS_CSS,
    /\.settings-page-shell \.set-grid--summary \{[\s\S]{0,200}align-items: stretch/,
    "cards must share a height",
  );
  assert.match(
    SETTINGS_CSS,
    /@media \(max-width: 1100px\)[\s\S]{0,220}repeat\(2, minmax\(0, 1fr\)\)/,
    "tablet must be 2 x 2",
  );
  assert.match(
    SETTINGS_CSS,
    /@media \(max-width: 640px\)[\s\S]{0,260}grid-template-columns: minmax\(0, 1fr\)/,
    "mobile must stack",
  );
});

test("Recent sign-ins names the device, never the raw User-Agent", () => {
  assert.match(
    SETTINGS_OVERVIEW,
    /import \{ describeUserAgent \}/,
    "the existing parser must be reused",
  );
  assert.match(SETTINGS_OVERVIEW, /describeUserAgent\(entry\.device\)/);
  assert.doesNotMatch(SETTINGS_OVERVIEW, /\{entry\.device \?\? "Unrecognised device"\}/);
});

test("Timezone lives in Preferences alone", () => {
  // The Overview card was a third place showing the same value — after the
  // Preferences editor and the Notifications pane that inherits from it —
  // and it offered nothing to act on. Settings now states it once, where it
  // can be changed.
  assert.doesNotMatch(SETTINGS_OVERVIEW, /title="Timezone"/);
  assert.doesNotMatch(SETTINGS_OVERVIEW, /accountTimezone/);
  assert.ok(
    PREFERENCES.includes("data-cc-preferences-timezone") &&
      PREFERENCES.includes("data-cc-preferences-detect-tz"),
    "Preferences remains the editing surface",
  );
});

// --------------------------------------------------------------- BILLING

test("the self-serve billing actions carry the canonical outlined action", () => {
  assertCanonical(BILLING_OVERVIEW, "data-billing-buy-credits", "Buy credits");
  assertCanonical(
    BILLING_OVERVIEW,
    'data-billing-evidence-action="SEE_PLANS"',
    "Choose a plan",
  );
  assertCanonical(STORAGE, "data-billing-storage-upgrade", "View plans");
  assertCanonical(STORAGE, "data-billing-recheck", "Re-check purchases");
  // The two that were missed: both were still the shared Button, so they kept
  // matching the near-black `.ui-button` block in billing.css while "Buy
  // credits" beside them had already left it.
  assertCanonical(STORAGE, "data-billing-manage-storage", "Add storage");
  assertCanonical(
    BILLING_OVERVIEW,
    "data-billing-start-subscription",
    "Start Team subscription",
  );
});

test("no billing action is painted near-black any more", () => {
  const css = stripCss(read("app/(app)/billing/billing.css"));
  // The block set #172033 on the .ui-button form of these hooks. All three
  // are native canonical actions now, so the rules had nothing left to reach.
  for (const hook of [
    "[data-billing-start-subscription].ui-button",
    "[data-billing-manage-storage].ui-button",
    "[data-billing-buy-credits].ui-button",
  ]) {
    assert.ok(!css.includes(hook), `billing.css still paints ${hook}`);
  }
});

test("billing gating is untouched by the visual change", () => {
  assert.match(BILLING_OVERVIEW, /action === "BUY_CREDITS" && onBuyCredits/);
  assert.match(BILLING_OVERVIEW, /action === "SEE_PLANS" && onChoosePlan/);
  assert.match(STORAGE, /providerBacked \?/);
  assert.match(STORAGE, /locked\.unlockedByPlan \?/);
});

test("destructive and tertiary controls were NOT swept in", () => {
  const closeAt = PRIVACY.indexOf("data-cc-close-account");
  if (closeAt > 0) {
    const open = PRIVACY.lastIndexOf("<", closeAt);
    const tag = PRIVACY.slice(open, PRIVACY.indexOf(">", closeAt) + 1);
    assert.doesNotMatch(
      tag,
      /app-secondary-action/,
      "Close account must keep its destructive treatment",
    );
  }
  assert.doesNotMatch(
    PRIVACY,
    /className="app-secondary-action[^"]*"[^>]*>\s*(Privacy Policy|Terms of Service|Cookie Policy)/,
    "policy links must stay links",
  );
});

// ----------------------------------------------------- FEEDBACK SEMANTICS

test("the warning confirm is the canonical ORANGE, not umber or amber", () => {
  // It went umber (#B86B16) -> amber (--warning-ink #B45309) -> orange.
  // `--orange-500` is what `AppStatusText` resolves for tone `orange` now -
  // the value the Notifications High card paints - which
  // is what Operations paints a High incident, so the confirmation before
  // "Sign out other sessions" now speaks the product's one warning colour.
  assert.match(
    CONFIRM,
    /case "warning":[\s\S]{0,1100}bg: "var\(--orange-500, #EA580C\)"/,
    "warning must use the canonical --orange-500 token",
  );
  const liveConfirm = CONFIRM.split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  const livePrimitives = stripCss(PRIMITIVES);
  for (const brown of ["#B86B16", "#9F5910", "#874A0C"]) {
    assert.ok(
      !liveConfirm.includes(brown) && !livePrimitives.includes(brown),
      `${brown} is the stale umber and must no longer be used`,
    );
  }
});

test("failure stays red and completion stays green", () => {
  assert.match(SECURITY, /const errorBox[\s\S]{0,200}rgba\(179,38,30/);
  assert.match(SECURITY, /const okBox[\s\S]{0,240}var\(--success-ink, #167A5B\)/);
  assert.ok(!SECURITY.includes('color: "#215e44"'));
});

test("the sign-out confirmation asks with a warning tone", () => {
  assert.match(
    SECURITY,
    /title: "Sign out other sessions\?"[\s\S]{0,400}tone: "warning"/,
  );
});

// ===========================================================================
// POST-CLOSURE UI/UX RECOVERY (2026-09-10)
// ===========================================================================
//
// Four controls were wrong in four different ways, and each is pinned here so
// the correction cannot be undone silently:
//
//   * Billing "View plans" on a Free account rendered as the pale outline
//     secondary — the only call to action in the storage card, looking
//     disabled.
//   * The Settings Workspace card's CTA said "Open workspace settings" and
//     opened AI & assistance.
//   * "Save preferences" carried a second, differently-coloured surface behind
//     its label.
//   * Three billing hooks were still painted by a dead `.ui-button` block.

const SETTINGS_PAGE = read("app/(app)/settings/page.tsx");
const SETTINGS_NAV = read("lib/settings/settingsNavigation.ts");
const BILLING_CSS = read("app/(app)/billing/billing.css");

/**
 * TS/TSX with comments removed.
 *
 * Not cosmetic: these corrections are all DELETIONS of a wrong control, and the
 * deletion is explained in a comment at the site — which names the label, the
 * handler and the class that were removed. A test that searches raw source
 * therefore finds the retired thing in the prose recording its retirement, and
 * either fails on a fixed file or, worse, matches the comment and passes on a
 * broken one. Both happened on the first run of this block.
 *
 * `{/* … *\/}` collapses to `{}`, which no assertion here looks at.
 */
const stripTs = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const PREFERENCES_LIVE = stripTs(PREFERENCES);
const SETTINGS_OVERVIEW_LIVE = stripTs(SETTINGS_OVERVIEW);

// ------------------------------------------------------------ SAVE PREFERENCES

test("Save preferences is the canonical Settings primary, not the marketing button", () => {
  const at = PREFERENCES_LIVE.indexOf("data-cc-preferences-save");
  assert.ok(at > 0, "the save hook must exist");
  const open = PREFERENCES_LIVE.lastIndexOf("<", at);
  const tag = PREFERENCES_LIVE.slice(open, PREFERENCES_LIVE.indexOf(">", at) + 1);
  assert.ok(
    tag.startsWith("<button"),
    `save must be a native <button> (got ${tag.slice(0, 24)})`,
  );
  assert.match(
    tag,
    /className="set-action set-action--primary"/,
    "save must use the canonical Settings primary action",
  );
  assert.doesNotMatch(
    tag,
    /variant="(secondary|primary)"/,
    "save must not carry a legacy Button variant",
  );
  // The legacy component is no longer imported at all, so it cannot come back
  // by accident on the next edit to this section.
  assert.doesNotMatch(
    PREFERENCES_LIVE,
    /^import[\s\S]*?from "[^"]*components\/ui\/Button";$/m,
    "PreferencesSection must not import the legacy marketing Button",
  );
});

test("the save control has no inner surface for a rule to paint", () => {
  // THE ARTIFACT. `components/ui/Button` wraps its label in a
  // `<span style={{display:"inline-flex"}}>`, and settings.css reclaimed the
  // button with `[data-cc-preferences-save] *` — the span included. At rest
  // both fills agreed; the hover rule repaints only the BUTTON, so the span
  // kept the rest colour and showed as a square-cornered rectangle exactly the
  // width of "Save preferences", behind the text of a rounded button.
  const at = PREFERENCES_LIVE.indexOf("data-cc-preferences-save");
  const open = PREFERENCES_LIVE.lastIndexOf("<", at);
  const close = PREFERENCES_LIVE.indexOf("</button>", at);
  assert.ok(close > open, "save must be a native <button> with a text child");
  assert.doesNotMatch(
    PREFERENCES_LIVE.slice(open, close),
    /<span/,
    "the save label must not be wrapped in a span",
  );

  // And the stylesheet no longer hands a FILL to descendants of the purple
  // group. The descendant arm may carry ink; it may not carry a background.
  const css = stripCss(SETTINGS_CSS);
  const descendantBlocks = css
    .split("}")
    .filter((b) => /\[data-cc-preferences-save\] \*/.test(b));
  assert.ok(
    descendantBlocks.length > 0,
    "the descendant arm should still exist, carrying ink only",
  );
  for (const block of descendantBlocks) {
    assert.match(
      block,
      /background:\s*transparent/,
      `a descendant of the save button must not be given a fill: ${block
        .trim()
        .slice(0, 120)}`,
    );
    assert.ok(
      !/background:\s*var\(--set-accent\)/.test(block),
      "the accent fill must belong to the button alone",
    );
  }
});

// -------------------------------------------------------- BILLING "VIEW PLANS"

test("Free View plans is the canonical DARK action, not a coral CTA", () => {
  const at = STORAGE.indexOf("data-billing-storage-upgrade");
  assert.ok(at > 0, "the storage upgrade hook must exist");
  const open = STORAGE.lastIndexOf("<", at);
  const tag = STORAGE.slice(open, STORAGE.indexOf(">", at) + 1);
  assert.match(
    tag,
    /\bapp-secondary-action\b/,
    "it must be the canonical action, not a local control",
  );
  assert.match(
    tag,
    /\bapp-secondary-action--filled\b/,
    "high emphasis is the canonical FILLED modifier",
  );
  assert.match(
    tag,
    /\bapp-secondary-action--lg\b/,
    "it must keep the canonical height and typography",
  );
  // No one-off colour anywhere on it: a hex here would be a second definition
  // of a control the primitive layer already owns.
  assert.doesNotMatch(tag, /style=\{/, "no inline style on a canonical action");
  const label = STORAGE.slice(at, STORAGE.indexOf("</button>", at));
  assert.match(label, /View plans/, "the label must be unchanged");
});

test("the filled modifier is a real dark primitive with all four states", () => {
  const css = stripCss(PRIMITIVES);
  assert.match(
    css,
    /\.app-secondary-action--filled \{[\s\S]{0,400}background: var\(--app-ink-heading/,
    "filled must be the dark ground from the token layer",
  );
  assert.match(
    css,
    /\.app-secondary-action--filled \{[\s\S]{0,400}color: #f/i,
    "filled must carry a white label",
  );
  assert.match(
    css,
    /\.app-secondary-action--filled:hover:not\(:disabled\)/,
    "filled must define its own hover, or it would take the lavender tint",
  );
  // Focus and disabled are inherited from the base class rather than redefined
  // — which is the point of using the primitive.
  assert.match(css, /\.app-secondary-action:focus-visible/);
  assert.match(css, /\.app-secondary-action:disabled/);
});

test("View plans behaviour and destination are untouched", () => {
  // A VISUAL change only. Same handler, same gate, same entitlement question.
  assert.match(STORAGE, /data-billing-storage-upgrade[\s\S]{0,80}View plans/);
  assert.match(STORAGE, /onClick=\{onChoosePlan\}/);
  assert.match(STORAGE, /locked\.unlockedByPlan \?/);
});

test("billing.css no longer paints the three converted actions", () => {
  const css = stripCss(BILLING_CSS);
  for (const hook of [
    '[data-billing-evidence-action="SEE_PLANS"].ui-button',
    "[data-billing-storage-upgrade].ui-button",
    "[data-billing-recheck].ui-button",
  ]) {
    assert.ok(
      !css.includes(hook),
      `billing.css still declares ${hook}, a selector no element can match`,
    );
  }
});

// ---------------------------------------------- SETTINGS WORKSPACE CARD ROUTE

test("the Workspace card never routes to AI and assistance", () => {
  // THE BUG. `pane === "workspace"` renders `<AiSection />`; the rail label was
  // renamed to "AI & assistance" on 2026-09-03 because Settings hosts no
  // workspace-defaults domain, and this CTA was not renamed with it. So the one
  // control that promised workspace settings opened AI assistance.
  const gridAt = SETTINGS_OVERVIEW_LIVE.indexOf('testId="workspace"');
  assert.ok(gridAt > 0, "the workspace summary card must exist");
  const live = SETTINGS_OVERVIEW_LIVE.slice(
    gridAt,
    SETTINGS_OVERVIEW_LIVE.indexOf('testId="plan"'),
  );
  assert.ok(
    !/onOpen\("workspace"\)/.test(live),
    "the Workspace card must not open the AI pane",
  );
  assert.ok(
    !/Open workspace settings/.test(live),
    "the label that named a destination it did not reach must be gone",
  );
  // And it was NOT relabelled to justify the wrong route.
  assert.ok(
    !/AI settings|AI & assistance/.test(live),
    "renaming the control to match a wrong destination is not the fix",
  );
});

test("the Workspace card's action is resolved by the canonical navigation model", () => {
  // Decision rule (A): a canonical workspace-administration destination exists
  // — members, invitations, seats, roles, ownership — so the CTA goes there,
  // resolved through the route registry rather than hardcoded.
  assert.match(
    SETTINGS_NAV,
    /workspaceAdminHref/,
    "the model must expose the resolved destination",
  );
  assert.match(
    SETTINGS_NAV,
    /routeIsOffered\("workspace\.people"/,
    "the destination must be permission-resolved, not assumed",
  );
  // `routeIsOffered`, not `routeLoads`: a rendered CTA is navigation, and for a
  // nav-plan-gated route the resolver can answer `canLoad: true` while
  // `canSeeNav` is false. Reading only `canLoad` offered `/people` to an actor
  // with no capabilities at all — caught by the behavioural case in
  // settings-architecture.test.ts, not by review.
  assert.match(
    SETTINGS_NAV,
    /return access\.canLoad && access\.canSeeNav;/,
    "the offer predicate must require BOTH",
  );
  assert.match(
    SETTINGS_OVERVIEW,
    /model\.workspaceAdminHref \?/,
    "the card must render the action only when the route resolves",
  );
  // Rule (C)/(D): when it does not resolve — a Personal Space — there is no
  // action at all, rather than a control that opens the wrong thing.
  assert.match(
    SETTINGS_OVERVIEW,
    /model\.workspaceAdminHref \?[\s\S]{0,400}: null/,
    "an unresolvable destination must render NO action",
  );
});

test("AI and assistance is still reachable under its own name", () => {
  // Removing the mislabelled shortcut must not remove the destination. The rail
  // entry that names the pane correctly is what the shortcut was duplicating.
  assert.match(
    SETTINGS_NAV,
    /label: "AI & assistance"/,
    "the AI pane must keep its own correctly-named rail entry",
  );
  assert.match(
    SETTINGS_PAGE,
    /pane === "workspace" \?[\s\S]{0,120}<AiSection \/>/,
    "the AI pane itself is unchanged — only the label that lied about it",
  );
});
