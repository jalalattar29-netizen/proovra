/**
 * Phase 7 — Design foundation contract.
 *
 * Source-text guards (in the repo's node:test + tsx style) that pin the
 * refined tokens and the shared UI primitives so later page migrations
 * and future edits cannot silently regress the foundation:
 *
 *   1. --btn-primary-bg is the refined coral → pink gradient (not the
 *      retired teal), and the coral shadow token is present.
 *   2. Backward compatibility — every legacy CSS var NAME that consumers
 *      already reference still resolves in globals.css.
 *   3. The new PROOVRA design-language tokens exist (enterprise violet
 *      accent + the six semantic status tokens).
 *   4. Each core shared component exists and exports its documented API +
 *      variants, and the barrel re-exports the whole set.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const appRoot = resolve(__dirname, "..");

const read = (rel: string) => readFileSync(resolve(appRoot, rel), "utf8");

const GLOBALS = read("app/globals.css");
const UI = (name: string) => read(`components/ui/${name}`);

// ---------------------------------------------------------------------------
// 1. Coral CTA
// ---------------------------------------------------------------------------

test("--btn-primary-bg is the PROOVRA purple, not a gradient", () => {
  // BILLING SURFACE CORRECTION (2026-08-29) — this asserted the coral → pink
  // gradient. That gradient was the primary CTA for the whole product, so a
  // page could show a purple header action beside a coral one and mean the
  // same thing by both; and a warm coral sits close enough to the destructive
  // red that ordinary commercial actions read as risky.
  const match = GLOBALS.match(/--btn-primary-bg:\s*([^;]+);/);
  assert.ok(match, "--btn-primary-bg must be defined");
  const value = match![1].toLowerCase().trim();
  assert.equal(value, "#7c3aed", "the canonical primary is the brand violet");
  assert.ok(!value.includes("gradient"), "a solid colour, so focus and disabled states can be stated");
});

/**
 * The coral palette is not banned outright — it is CONFINED.
 *
 * The first version of this test banned the six coral stops from globals.css
 * entirely, and that was too wide: it also outlawed the two Auth buttons that
 * have always been coral on purpose, "Sign in with Email" and "Create account
 * with Email". They are the last step of the public funnel, they sit on the
 * marketing gradient, and flattening them into the application's purple was a
 * loss of a deliberate brand treatment rather than a cleanup.
 *
 * So the invariant is narrowed to what it was actually protecting: the
 * APPLICATION primary must not be coral, and coral may exist in exactly ONE
 * declared authority — the Auth CTA block. Every coral declaration is checked
 * to sit inside that block, so a third consumer cannot appear quietly.
 */
const AUTH_CTA_BLOCK = (() => {
  // From the START OF THE LINE that opens the block: slicing mid-line would
  // leave that first declaration outside the authority it defines.
  const declaredAt = GLOBALS.indexOf("--auth-cta-bg:");
  const start = GLOBALS.lastIndexOf("\n", declaredAt) + 1;
  const end = GLOBALS.indexOf("@media (prefers-reduced-motion: reduce)", start);
  assert.ok(start > 0, "the Auth CTA authority must exist in globals.css");
  assert.ok(end > start, "the Auth CTA authority must be a bounded block");
  // Include the rules that follow the token block, up to the end of the
  // reduced-motion guard that closes the authority.
  return GLOBALS.slice(start, GLOBALS.indexOf("}", end + 200));
})();

test("coral exists ONLY inside the declared Auth CTA authority", () => {
  const lines = GLOBALS.split("\n");
  const offenders: string[] = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    // Comments explain WHY the colour is confined; they are prose, not rules.
    if (lower.trim().startsWith("*") || lower.trim().startsWith("/*")) continue;
    const hasCoral =
      ["#e64880", "#ff6b6b", "#ff8a6a", "#d63e76", "#f75f5f", "#f97d5c"].some(
        (retired) => lower.includes(retired),
      ) || /rgba\(230,\s*72,\s*128/.test(lower);
    if (!hasCoral) continue;
    if (AUTH_CTA_BLOCK.includes(line)) continue;
    offenders.push(line.trim());
  }

  assert.deepEqual(
    offenders,
    [],
    "coral may only be declared by the Auth CTA authority",
  );
});

test("the retired coral/pink CTA cannot come back through the PRIMARY token", () => {
  // The application primary is the thing that was wrong and the thing this
  // protects. It is checked by VALUE rather than by the word "coral", so
  // renaming a comment cannot smuggle the colour back in.
  const primaryDeclarations = GLOBALS.split("\n").filter((line) =>
    /--btn-primary-[a-z-]*:/.test(line),
  );
  assert.ok(primaryDeclarations.length > 0, "the primary tokens must exist");

  for (const line of primaryDeclarations) {
    const lower = line.toLowerCase();
    for (const retired of ["#e64880", "#ff6b6b", "#ff8a6a", "#d63e76", "#f75f5f", "#f97d5c"]) {
      assert.ok(
        !lower.includes(retired),
        `retired CTA colour ${retired} must not reach a primary token: ${line.trim()}`,
      );
    }
    assert.doesNotMatch(lower, /rgba\(230,\s*72,\s*128/);
  }
});

test("the Auth CTA authority carries the exact historical treatment", () => {
  // Recovered from git (20986430^), not re-picked by eye: these are the values
  // both buttons carried inline before the global cleanup.
  assert.match(
    GLOBALS,
    /--auth-cta-bg:\s*linear-gradient\(90deg,\s*#e64880 0%,\s*#ff6b6b 52%,\s*#ff8a6a 100%\)/i,
  );
  assert.match(GLOBALS, /--auth-cta-color:\s*#ffffff/i);
  assert.match(GLOBALS, /--auth-cta-border:\s*rgba\(230,\s*72,\s*128,\s*0\.45\)/i);
  assert.match(
    GLOBALS,
    /--auth-cta-shadow:\s*0 14px 28px rgba\(230,\s*72,\s*128,\s*0\.22\)/i,
  );

  // And the states the class must own, since the inline styles it replaces had
  // nowhere to put them.
  for (const state of [
    ".auth-email-cta:hover:not(:disabled)",
    ".auth-email-cta:active:not(:disabled)",
    ".auth-email-cta:focus-visible",
    ".auth-email-cta:disabled",
  ]) {
    assert.ok(GLOBALS.includes(state), `the Auth CTA must define ${state}`);
  }
});

test("exactly two buttons wear the Auth CTA, and they carry no colour of their own", () => {
  const LOGIN = read("app/login/page.tsx");
  const REGISTER = read("app/register/page.tsx");

  // The two intentional Auth actions name the authority.
  assert.match(LOGIN, /className="auth-social-btn auth-email-cta"/);
  assert.match(LOGIN, /data-auth-email-cta="SIGN_IN"/);
  assert.match(REGISTER, /className="auth-social-btn auth-email-cta"/);
  assert.match(REGISTER, /data-auth-email-cta="REGISTER"/);

  // And they hold no colour themselves: the values that used to be inline in
  // both files — which is how one could drift from the other — are gone.
  for (const [name, src] of [
    ["login", LOGIN],
    ["register", REGISTER],
  ] as const) {
    const authButton = src.slice(
      src.indexOf("auth-social-btn auth-email-cta"),
      src.indexOf("auth-social-btn auth-email-cta") + 400,
    );
    assert.doesNotMatch(
      authButton,
      /linear-gradient|#e64880|#ff6b6b|#ff8a6a|rgba\(230/i,
      `the ${name} Auth CTA must take its colour from the class, not inline`,
    );
  }

  // And NOTHING with higher specificity may repaint them. The dark-green
  //`.auth-premium .auth-social-btn[type="submit"]` rule was (0,3,0) against the
  // CTA class's (0,1,0): while the colours were inline they won anyway, and
  // the moment they became a class the buttons turned green. Its only two
  // consumers were these buttons, so it is gone rather than worked around.
  assert.ok(
    !GLOBALS.includes('.auth-premium .auth-social-btn[type="submit"]'),
    "a higher-specificity submit rule must not repaint the Auth CTA",
  );
  // The NON-submit sibling stays: it is what Apple and Google wear.
  assert.ok(
    GLOBALS.includes('.auth-premium .auth-social-btn:not([type="submit"])'),
    "the non-submit auth button treatment must survive",
  );

  // Nothing else in the app wears it.
  const consumers = [LOGIN, REGISTER].filter((src) =>
    src.includes("auth-email-cta"),
  );
  assert.equal(consumers.length, 2);
});

test("Billing never wears the Auth CTA", () => {
  // The Auth treatment is the public funnel's, not the application's. A
  // Billing surface that reached for it would be undoing the cleanup this
  // exception was carved out of.
  for (const rel of [
    "app/(app)/billing/page.tsx",
    "app/(app)/billing/billing.css",
    "app/(app)/billing/_sections/PlanAndUsage.tsx",
    "app/(app)/billing/_sections/StorageAndHistory.tsx",
    "app/(app)/billing/_sections/CheckoutDrawer.tsx",
  ]) {
    const src = read(rel);
    assert.doesNotMatch(src, /auth-email-cta|auth-cta-/, `${rel} must not use the Auth CTA`);
    assert.doesNotMatch(
      src,
      /#e64880|#ff6b6b|#ff8a6a|#d63e76|#f75f5f|#f97d5c/i,
      `${rel} must not carry a retired coral literal`,
    );
  }
});

test("primary CTA border and shadow are tinted with the brand violet", () => {
  assert.match(GLOBALS, /--btn-primary-shadow:\s*[^;]*rgba\(124,\s*58,\s*237/);
  assert.match(GLOBALS, /--btn-primary-border:\s*#6d28d9/i);
});

// ---------------------------------------------------------------------------
// 2. Backward compatibility — legacy var NAMES still resolve
// ---------------------------------------------------------------------------

test("all legacy CSS var names remain defined", () => {
  const legacyVars = [
    "--btn-primary-bg",
    "--btn-primary-color",
    "--btn-primary-border",
    "--btn-primary-hover-bg",
    "--btn-primary-hover-border",
    "--btn-primary-shadow",
    "--card",
    "--border",
    "--accent",
    "--destructive",
    "--primary",
    "--color-primary",
    "--app-nav-bg",
    "--surface",
    "--radius",
  ];
  for (const name of legacyVars) {
    assert.ok(
      new RegExp(`${name}:`).test(GLOBALS),
      `legacy var ${name} must still be defined (backward compatible)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. New PROOVRA design-language tokens
// ---------------------------------------------------------------------------

test("enterprise violet accent + semantic status tokens exist", () => {
  const required = [
    "--enterprise-accent",
    "--enterprise-gradient",
    "--status-verified-bg",
    "--status-verified-fg",
    "--status-pending-bg",
    "--status-risk-bg",
    "--status-neutral-bg",
    "--status-governance-bg",
    "--status-info-bg",
  ];
  for (const name of required) {
    assert.ok(new RegExp(`${name}:`).test(GLOBALS), `${name} must be defined`);
  }
});

// ---------------------------------------------------------------------------
// 4. Shared components + barrel
// ---------------------------------------------------------------------------

test("Button exposes its variants + states", () => {
  const src = UI("Button.tsx");
  assert.match(src, /export const Button/);
  for (const v of [
    "primary",
    "secondary",
    "enterprise",
    "destructive",
    "ghost",
  ]) {
    assert.ok(src.includes(`"${v}"`), `Button variant ${v} present`);
  }
  assert.match(src, /loading/, "Button has loading state");
  assert.match(src, /disabled/, "Button has disabled state");
  assert.match(src, /var\(--btn-primary-bg\)/, "primary uses the CTA token");
});

test("Card exposes its five variants", () => {
  const src = UI("Card.tsx");
  assert.match(src, /export function Card/);
  for (const v of ["summary", "status", "admin", "action", "empty"]) {
    assert.ok(src.includes(`"${v}"`), `Card variant ${v} present`);
  }
});

test("Badge covers the semantic tone set and reuses StatusBadge", () => {
  const src = UI("Badge.tsx");
  assert.match(src, /export function Badge/);
  for (const t of [
    "verified",
    "pending",
    "risk",
    "neutral",
    "governance",
    "info",
  ]) {
    assert.ok(src.includes(`"${t}"`), `Badge tone ${t} present`);
  }
  assert.match(src, /from "\.\/StatusBadge"/, "Badge reuses StatusBadge");
});

test("DataTable, EmptyState, FilterBar, PageShell exist with expected API", () => {
  const table = UI("DataTable.tsx");
  assert.match(table, /export function DataTable/);
  assert.match(table, /loading/);
  assert.match(table, /emptyState/);
  assert.match(table, /overflowX/, "horizontal-scroll container");

  const empty = UI("EmptyState.tsx");
  assert.match(empty, /export function EmptyState/);
  assert.match(empty, /purpose/);
  assert.match(empty, /note/, "supports permission/plan note");

  const filter = UI("FilterBar.tsx");
  assert.match(filter, /export const FilterBar/);
  assert.match(filter, /Search:/);
  assert.match(filter, /Select:/);

  const shell = UI("PageShell.tsx");
  assert.match(shell, /export function PageShell/);
  assert.match(shell, /export function PageHeader/);
  assert.match(shell, /primaryAction/);
  assert.match(shell, /secondaryActions/);
  assert.match(shell, /contextStrip/);
});

test("barrel re-exports the full foundation", () => {
  const barrel = UI("index.ts");
  for (const name of [
    "PageShell",
    "PageHeader",
    "Card",
    "Button",
    "Badge",
    "DataTable",
    "EmptyState",
    "FilterBar",
    "StatusBadge",
    "ConfirmActionProvider",
  ]) {
    assert.ok(barrel.includes(name), `barrel exports ${name}`);
  }
});
