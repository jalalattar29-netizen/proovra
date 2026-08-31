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

test("the summary row is four cards, and sign-ins is not one of them", () => {
  const gridAt = SETTINGS_OVERVIEW.indexOf('className="set-grid set-grid--summary"');
  assert.ok(gridAt > 0, "the summary grid must exist");
  const grid = SETTINGS_OVERVIEW.slice(
    gridAt,
    SETTINGS_OVERVIEW.indexOf("      </div>", gridAt),
  );
  for (const id of ["workspace", "plan", "security", "timezone"]) {
    assert.ok(grid.includes(`testId="${id}"`), `${id} must be a summary card`);
  }
  assert.ok(
    !grid.includes('testId="activity"'),
    "Recent sign-ins must sit BELOW the summary row",
  );
  assert.ok(
    SETTINGS_OVERVIEW.includes('data-settings-summary="activity"') &&
      SETTINGS_OVERVIEW.includes("set-card--wide"),
    "Recent sign-ins must still render, as the wide card",
  );
});

test("the summary row is a real four-column grid that stretches", () => {
  assert.match(
    SETTINGS_CSS,
    /\.settings-page-shell \.set-grid--summary \{[\s\S]{0,200}grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/,
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

test("Timezone is a readout here and stays editable in Preferences", () => {
  assert.match(SETTINGS_OVERVIEW, /title="Timezone"/);
  assert.match(SETTINGS_OVERVIEW, /accountTimezone \?\? "UTC"/);
  assert.ok(
    SETTINGS_OVERVIEW.includes("Account timezone") &&
      SETTINGS_OVERVIEW.includes("Not set — UTC fallback"),
  );
  assert.doesNotMatch(SETTINGS_OVERVIEW, /<Input[\s\S]{0,80}timezone/);
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

test("the warning confirm is canonical amber, not the old umber", () => {
  assert.match(
    CONFIRM,
    /case "warning":[\s\S]{0,900}bg: "var\(--warning-ink, #B45309\)"/,
    "warning must use the canonical --warning-ink token",
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
