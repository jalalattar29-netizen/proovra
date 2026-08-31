/**
 * Settings and Billing use the PRODUCT's action, not their own.
 *
 * `.app-primary-action` is the filled violet action the authenticated product
 * already paints — the Evidence header's "Upload / Capture Evidence", the
 * Notifications refresh, Cases. Settings and Billing had each grown a local
 * treatment instead, and Settings had grown TWO: a "PURPLE — the action a
 * section exists to perform" block and, further down, a white/violet block,
 * with several buttons named in both.
 *
 * That overlap is what broke "Set up two-factor authentication". The purple
 * block claimed `[data-cc-mfa-enroll-start]` AND its descendants; the white
 * block claimed the button alone and, being later, won on the element. Nothing
 * ever overrode the descendant half, so the `<span>` the shared Button
 * component wraps its label in kept `background: var(--set-accent)` — a solid
 * violet rectangle sitting inside a white button.
 *
 * These tests pin the resolution: one authority, named once, and no local
 * block still claiming a converted control.
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
const BILLING_CSS = read("app/(app)/billing/billing.css");
const PRIMITIVES = read("components/app-primitives/app-primitives.css");
const CONFIRM = read("components/ui/ConfirmActionModal.tsx");

/** The element carrying `hook` must also carry the canonical class. */
function assertCanonical(source: string, hook: string, label: string): void {
  const at = source.indexOf(hook);
  assert.ok(at >= 0, `${label}: ${hook} not found`);
  const open = source.lastIndexOf("<", at);
  const tag = source.slice(open, source.indexOf(">", at) + 1);
  assert.match(
    tag,
    /className="[^"]*\bapp-primary-action\b/,
    `${label} must carry the canonical .app-primary-action`,
  );
  assert.ok(
    tag.startsWith("<button") || tag.startsWith("<Link") || tag.startsWith("<a"),
    `${label} must stay a real button/link element (got ${tag.slice(0, 24)}…)`,
  );
}

// ---------------------------------------------------------------- SETTINGS

test("the seven Settings actions carry the canonical primary action", () => {
  assertCanonical(OVERVIEW_SECTION, "data-cc-profile-edit", "Edit profile");
  assertCanonical(
    PREFERENCES,
    "data-cc-preferences-detect-tz",
    "Use my current timezone",
  );
  assertCanonical(
    SETTINGS_OVERVIEW,
    'data-settings-open="security"',
    "Review security",
  );
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

test("no converted Settings action is still the legacy secondary Button", () => {
  for (const [src, hook, label] of [
    [OVERVIEW_SECTION, "data-cc-profile-edit", "Edit profile"],
    [PREFERENCES, "data-cc-preferences-detect-tz", "Use my current timezone"],
    [SECURITY, "data-cc-mfa-enroll-start", "Set up two-factor"],
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

test("settings.css no longer claims a converted action", () => {
  // Every hook below is now painted by the canonical class. A local block that
  // still names one is the second authority that produced the 2FA artifact.
  // Colour, specifically. One LAYOUT rule survives on purpose — the mobile
  // `width: 100%` that makes Edit profile fill its card — and a rule that only
  // sizes a button is not a second opinion about how it is painted.
  const painting = SETTINGS_CSS.split("}")
    .filter((block) => /background|color|border-color|box-shadow/.test(block))
    .join("}");
  for (const hook of [
    "[data-cc-mfa-enroll-start]",
    "[data-cc-preferences-detect-tz]",
    "[data-cc-export-request]",
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

test("the 2FA action has no inner surface to paint", () => {
  // The rectangle lived in the label wrapper the shared Button component adds.
  // A native button has no wrapper at all, and the containment reset stops any
  // descendant of a canonical action from drawing a second surface.
  const at = SECURITY.indexOf("data-cc-mfa-enroll-start");
  const open = SECURITY.lastIndexOf("<", at);
  const close = SECURITY.indexOf("</button>", at);
  assert.ok(close > open, "the 2FA action must be a native <button>");
  const markup = SECURITY.slice(open, close);
  assert.doesNotMatch(markup, /<span/, "the label must not be wrapped in a span");

  assert.match(
    SETTINGS_CSS,
    /\.settings-page-shell \.app-primary-action > \*[\s\S]{0,220}background: none !important/,
    "descendants of a canonical action must never redraw the surface",
  );
});

test("the canonical action keeps its own height in Settings and Billing", () => {
  // Two local rules used to force a different height onto whatever sat in
  // them — 42px in the Preferences row, 44px in a billing panel's actions.
  assert.match(
    SETTINGS_CSS,
    /\[data-settings-preferences\] button:not\(\[data-cc-preferences-save\]\):not\(\.app-primary-action\)/,
    "the Preferences height rule must exclude the canonical action",
  );
  assert.match(
    BILLING_CSS,
    /\.bill-panel__actions > \*:not\(\.app-primary-action\)/,
    "the billing panel height rule must exclude the canonical action",
  );
});

// ------------------------------------------------------- OVERVIEW STRUCTURE

test("the summary row is four cards, and sign-ins is not one of them", () => {
  const gridAt = SETTINGS_OVERVIEW.indexOf('className="set-grid set-grid--summary"');
  assert.ok(gridAt > 0, "the summary grid must exist");
  const gridEnd = SETTINGS_OVERVIEW.indexOf("      </div>", gridAt);
  const grid = SETTINGS_OVERVIEW.slice(gridAt, gridEnd);

  for (const id of ["workspace", "plan", "security", "timezone"]) {
    assert.ok(
      grid.includes(`testId="${id}"`),
      `${id} must be one of the four summary cards`,
    );
  }
  assert.ok(
    !grid.includes('data-settings-summary="activity"') &&
      !grid.includes('testId="activity"'),
    "Recent sign-ins must sit BELOW the summary row, not as a fourth column",
  );
  assert.ok(
    SETTINGS_OVERVIEW.includes('data-settings-summary="activity"'),
    "Recent sign-ins must still be rendered",
  );
  assert.ok(
    SETTINGS_OVERVIEW.includes("set-card--wide"),
    "Recent sign-ins must be the wide card",
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
    "cards must share a height rather than each taking its own",
  );
  // Tablet halves it; mobile stacks it.
  assert.match(
    SETTINGS_CSS,
    /@media \(max-width: 1100px\)[\s\S]{0,220}repeat\(2, minmax\(0, 1fr\)\)/,
    "tablet must be a 2 x 2 grid",
  );
  assert.match(
    SETTINGS_CSS,
    /@media \(max-width: 640px\)[\s\S]{0,240}grid-template-columns: minmax\(0, 1fr\)/,
    "mobile must stack to one column",
  );
});

test("Recent sign-ins names the device, never the raw User-Agent", () => {
  // `uaPreview` is the raw header truncated to 120 characters. It was the
  // card's headline, which is what made the column twice the height of its
  // neighbours. `describeUserAgent` is the parser the Security pane already
  // uses for this exact string — reused, not re-written.
  assert.match(
    SETTINGS_OVERVIEW,
    /import \{ describeUserAgent \} from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/security\/sessionPresentation"/,
    "the existing parser must be reused",
  );
  assert.match(
    SETTINGS_OVERVIEW,
    /describeUserAgent\(entry\.device\)/,
    "the device line must be the parsed description",
  );
  assert.doesNotMatch(
    SETTINGS_OVERVIEW,
    /\{entry\.device \?\? "Unrecognised device"\}/,
    "the raw agent must not be the headline any more",
  );
});

test("Timezone is a readout here and stays editable in Preferences", () => {
  assert.match(
    SETTINGS_OVERVIEW,
    /title="Timezone"/,
    "the fourth summary card is Timezone",
  );
  assert.match(
    SETTINGS_OVERVIEW,
    /accountTimezone \?\? "UTC"/,
    "the card shows the saved account timezone, falling back to UTC",
  );
  // Truthful state only: these are the same words Preferences uses.
  assert.ok(
    SETTINGS_OVERVIEW.includes("Account timezone") &&
      SETTINGS_OVERVIEW.includes("Not set — UTC fallback"),
    "the secondary state must be the truthful one",
  );
  // The summary must not become a second editor.
  assert.doesNotMatch(
    SETTINGS_OVERVIEW,
    /<Input[\s\S]{0,80}timezone/,
    "the summary card must not carry the timezone form",
  );
  // …and Preferences keeps the whole control.
  assert.ok(
    PREFERENCES.includes("data-cc-preferences-timezone") &&
      PREFERENCES.includes("data-cc-preferences-detect-tz") &&
      PREFERENCES.includes("Account timezone"),
    "Preferences remains the editing surface",
  );
});

// --------------------------------------------------------------- BILLING

test("the self-serve billing actions use the canonical primary action", () => {
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
  // Each action keeps the condition that decides whether it exists at all.
  assert.match(
    BILLING_OVERVIEW,
    /action === "BUY_CREDITS" && onBuyCredits/,
    "Buy credits stays conditional on the projected action",
  );
  assert.match(
    BILLING_OVERVIEW,
    /action === "SEE_PLANS" && onChoosePlan/,
    "Choose a plan stays conditional on the projected action",
  );
  assert.match(
    STORAGE,
    /providerBacked \?/,
    "Re-check stays conditional on a payment provider backing the account",
  );
  assert.match(
    STORAGE,
    /locked\.unlockedByPlan \?/,
    "View plans stays conditional on the plan lock",
  );
});

test("destructive and tertiary controls were NOT swept into purple", () => {
  // Semantic hierarchy survives a consistency pass.
  const closeAt = PRIVACY.indexOf("data-cc-close-account");
  if (closeAt > 0) {
    const open = PRIVACY.lastIndexOf("<", closeAt);
    const tag = PRIVACY.slice(open, PRIVACY.indexOf(">", closeAt) + 1);
    assert.doesNotMatch(
      tag,
      /app-primary-action/,
      "Close account must keep its destructive treatment",
    );
  }
  // Inline policy links stay links.
  assert.doesNotMatch(
    PRIVACY,
    /className="app-primary-action"[^>]*>\s*(Privacy Policy|Terms of Service|Cookie Policy)/,
    "policy links must not become buttons",
  );
});

// ----------------------------------------------------- FEEDBACK SEMANTICS

test("the warning confirm is canonical amber, not the old umber", () => {
  assert.match(
    CONFIRM,
    /case "warning":[\s\S]{0,900}bg: "var\(--warning-ink, #B45309\)"/,
    "warning must use the canonical --warning-ink token",
  );
  // The hexes may still be NAMED in the comments that explain why they left;
  // what must be gone is any rule or value still using one.
  const stripComments = (src: string): string =>
    src
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n");
  const liveConfirm = stripComments(CONFIRM);
  const livePrimitives = stripComments(PRIMITIVES);
  for (const brown of ["#B86B16", "#9F5910", "#874A0C"]) {
    assert.ok(
      !liveConfirm.includes(brown) && !livePrimitives.includes(brown),
      `${brown} is the stale umber and must no longer be used`,
    );
  }
  assert.match(
    PRIMITIVES,
    /\[data-confirm-action-tone="warning"\]:hover:not\(:disabled\) \{[\s\S]{0,160}var\(--warning-ink, #B45309\)/,
    "the hover state must be the same token, not a second palette",
  );
});

test("failure stays red and completion stays green", () => {
  // A sign-out that succeeded must not be reported as an error just because
  // the subject is security; one that failed must not be softened.
  assert.match(
    SECURITY,
    /const errorBox[\s\S]{0,200}rgba\(179,38,30/,
    "failure keeps the canonical red container",
  );
  assert.match(
    SECURITY,
    /const okBox[\s\S]{0,240}var\(--success-ink, #167A5B\)/,
    "completion uses the canonical success ink",
  );
  assert.ok(
    !SECURITY.includes('color: "#215e44"'),
    "the un-named green must be gone in favour of the token",
  );
});

test("the sign-out confirmation asks with a warning tone", () => {
  assert.match(
    SECURITY,
    /title: "Sign out other sessions\?"[\s\S]{0,400}tone: "warning"/,
    "the pre-sign-out confirmation is a warning, not a danger",
  );
});
